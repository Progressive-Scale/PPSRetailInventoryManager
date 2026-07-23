import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, sql, SQL } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  CycleCount,
  CycleCountResolution,
  cycleCountLines,
  cycleCounts,
  InventoryItem,
  inventoryItems,
  inventoryTransactions,
} from '../db/schema';
import { DataContext } from '../auth/auth.types';
import { Paginated, resolvePaging } from '../common/pagination';
import {
  CloseCycleCountDto,
  ListCycleCountsQuery,
  OpenCycleCountDto,
} from './dto/cycle-counts.dto';

interface PendingLine {
  itemId: string;
  serial: string;
  resolution: CycleCountResolution;
}

@Injectable()
export class CycleCountsService {
  constructor(private readonly tenantDb: TenantDbService) {}

  private writeStoreId(ctx: DataContext, requested?: number): number {
    if (ctx.role === 'STORE_USER') {
      if (ctx.storeId == null) {
        throw new BadRequestException('User is not assigned to a store.');
      }
      if (requested !== undefined && requested !== ctx.storeId) {
        throw new BadRequestException('Cannot act on another store.');
      }
      return ctx.storeId;
    }
    if (requested === undefined) {
      throw new BadRequestException('storeId is required.');
    }
    return requested;
  }

  /** Load a cycle count scoped to the caller (company + store rules). */
  private async loadCount(
    tx: Tx,
    ctx: DataContext,
    id: number,
    forUpdate = false,
  ): Promise<CycleCount> {
    const q = tx
      .select()
      .from(cycleCounts)
      .where(and(eq(cycleCounts.id, id), eq(cycleCounts.companyId, ctx.companyId)))
      .limit(1);
    const [cc] = forUpdate ? await q.for('update') : await q;
    if (!cc) throw new NotFoundException('Cycle count not found.');
    if (ctx.role === 'STORE_USER' && cc.storeId !== ctx.storeId) {
      throw new NotFoundException('Cycle count not found.');
    }
    return cc;
  }

  // ---- open --------------------------------------------------------------

  async open(ctx: DataContext, dto: OpenCycleCountDto) {
    const storeId = this.writeStoreId(ctx, dto.storeId);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const snapshot = await tx
        .select({
          id: inventoryItems.id,
          serial: inventoryItems.serial,
          upc: inventoryItems.upc,
          sku: inventoryItems.sku,
          name: inventoryItems.name,
        })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.companyId, ctx.companyId),
            eq(inventoryItems.storeId, storeId),
            eq(inventoryItems.status, 'ON_HAND'),
          ),
        )
        .orderBy(inventoryItems.serial);

      const [cc] = await tx
        .insert(cycleCounts)
        .values({
          companyId: ctx.companyId,
          storeId,
          status: 'OPEN',
          openedByUserId: ctx.userId,
          expectedCount: snapshot.length,
        })
        .returning();

      return { id: cc.id, cycleCount: cc, snapshot };
    });
  }

  // ---- close (idempotent, one transaction) -------------------------------

  async close(ctx: DataContext, id: number, dto: CloseCycleCountDto) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const cc = await this.loadCount(tx, ctx, id, true);

      if (cc.status === 'CLOSED') return this.buildResult(tx, ctx, cc); // idempotent
      if (cc.status === 'CANCELLED') {
        throw new ConflictException('Cycle count was cancelled.');
      }

      const scannedSerials = dto.scannedSerials ?? [];
      const upcCounts = dto.upcCounts ?? [];
      const newItems = dto.newItems ?? [];

      // Current ON_HAND universe for the store.
      const universe = await tx
        .select()
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.companyId, ctx.companyId),
            eq(inventoryItems.storeId, cc.storeId),
            eq(inventoryItems.status, 'ON_HAND'),
          ),
        );
      const bySerial = new Map<string, InventoryItem>();
      for (const it of universe) bySerial.set(it.serial, it);

      const accounted = new Set<string>();
      const lines: PendingLine[] = [];

      // 1) scanned serials -> SCANNED
      for (const serial of scannedSerials) {
        const it = bySerial.get(serial);
        if (it && !accounted.has(it.id)) {
          accounted.add(it.id);
          lines.push({ itemId: it.id, serial: it.serial, resolution: 'SCANNED' });
        }
      }

      // 2) upcCounts -> keep NEWEST N of that upc as ON_HAND (COUNTED_BY_UPC);
      //    the remainder stays unaccounted and falls to the sold sweep.
      for (const { upc, quantity } of upcCounts) {
        const ofUpc = universe
          .filter((i) => i.upc === upc)
          .sort((a, b) => this.newestFirst(a, b));
        for (const it of ofUpc.slice(0, quantity)) {
          if (!accounted.has(it.id)) {
            accounted.add(it.id);
            lines.push({
              itemId: it.id,
              serial: it.serial,
              resolution: 'COUNTED_BY_UPC',
            });
          }
        }
      }

      // 3) newItems -> create ON_HAND needs_review + RECEIPT(CYCLE_COUNT) + NEW_ITEM.
      //    A provided serial that already exists in the universe is treated as
      //    a scan, not a new item.
      for (const ni of newItems) {
        if (!ni.isUpc) {
          const existing = bySerial.get(ni.serialOrUpc);
          if (existing) {
            if (!accounted.has(existing.id)) {
              accounted.add(existing.id);
              lines.push({
                itemId: existing.id,
                serial: existing.serial,
                resolution: 'SCANNED',
              });
            }
            continue;
          }
        }
        const serial = ni.isUpc
          ? `pps-cc-${randomBytes(8).toString('hex')}`
          : ni.serialOrUpc;
        const upc = ni.isUpc ? ni.serialOrUpc : null;
        const [item] = await tx
          .insert(inventoryItems)
          .values({
            companyId: ctx.companyId,
            storeId: cc.storeId,
            serial,
            upc,
            sku: 'REVIEW',
            name: ni.name,
            status: 'ON_HAND',
            needsReview: true,
            receivedAt: new Date(),
          })
          .returning();
        await tx.insert(inventoryTransactions).values({
          companyId: ctx.companyId,
          storeId: cc.storeId,
          itemId: item.id,
          type: 'RECEIPT',
          quantityDelta: 1,
          note: `Cycle count #${cc.id} new item`,
          source: 'CYCLE_COUNT',
          performedByUserId: ctx.userId,
        });
        lines.push({ itemId: item.id, serial: item.serial, resolution: 'NEW_ITEM' });
      }

      // 4) sold sweep — any ON_HAND universe item not accounted -> SOLD.
      let soldCount = 0;
      for (const it of universe) {
        if (accounted.has(it.id)) continue;
        await tx
          .update(inventoryItems)
          .set({ status: 'SOLD', updatedAt: new Date() })
          .where(eq(inventoryItems.id, it.id));
        await tx.insert(inventoryTransactions).values({
          companyId: ctx.companyId,
          storeId: cc.storeId,
          itemId: it.id,
          type: 'SALE',
          quantityDelta: -1,
          note: `Cycle count #${cc.id}`,
          source: 'CYCLE_COUNT',
          performedByUserId: ctx.userId,
        });
        lines.push({ itemId: it.id, serial: it.serial, resolution: 'MARKED_SOLD' });
        soldCount++;
      }

      if (lines.length > 0) {
        await tx.insert(cycleCountLines).values(
          lines.map((l) => ({
            companyId: ctx.companyId,
            cycleCountId: cc.id,
            itemId: l.itemId,
            serial: l.serial,
            resolution: l.resolution,
          })),
        );
      }

      const presentCount = lines.filter(
        (l) => l.resolution === 'SCANNED' || l.resolution === 'COUNTED_BY_UPC',
      ).length;

      const [updated] = await tx
        .update(cycleCounts)
        .set({
          status: 'CLOSED',
          closedByUserId: ctx.userId,
          closedAt: new Date(),
          scannedCount: presentCount,
          soldGeneratedCount: soldCount,
        })
        .where(eq(cycleCounts.id, cc.id))
        .returning();

      return this.buildResult(tx, ctx, updated);
    });
  }

  private newestFirst(a: InventoryItem, b: InventoryItem): number {
    const t = b.createdAt.getTime() - a.createdAt.getTime();
    return t !== 0 ? t : b.serial.localeCompare(a.serial);
  }

  // ---- cancel ------------------------------------------------------------

  async cancel(ctx: DataContext, id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const cc = await this.loadCount(tx, ctx, id, true);
      if (cc.status === 'CANCELLED') return cc; // idempotent
      if (cc.status === 'CLOSED') {
        throw new ConflictException('Cannot cancel a closed cycle count.');
      }
      const [updated] = await tx
        .update(cycleCounts)
        .set({ status: 'CANCELLED', closedAt: new Date() })
        .where(eq(cycleCounts.id, cc.id))
        .returning();
      return updated;
    });
  }

  // ---- reads -------------------------------------------------------------

  async list(
    ctx: DataContext,
    query: ListCycleCountsQuery,
  ): Promise<Paginated<CycleCount>> {
    const { limit, offset } = resolvePaging(query);
    const storeId =
      ctx.role === 'STORE_USER' ? ctx.storeId : (query.storeId ?? null);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const conds: SQL[] = [eq(cycleCounts.companyId, ctx.companyId)];
      if (storeId != null) conds.push(eq(cycleCounts.storeId, storeId));
      const where = and(...conds);
      const data = await tx
        .select()
        .from(cycleCounts)
        .where(where)
        .orderBy(desc(cycleCounts.id))
        .limit(limit)
        .offset(offset);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(cycleCounts)
        .where(where);
      return { data, total: Number(count), limit, offset };
    });
  }

  async get(ctx: DataContext, id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const cc = await this.loadCount(tx, ctx, id);
      return this.buildResult(tx, ctx, cc);
    });
  }

  /** Deterministic result view (used by close, re-close and GET /:id). */
  private async buildResult(tx: Tx, ctx: DataContext, cc: CycleCount) {
    const rows = await tx
      .select()
      .from(cycleCountLines)
      .where(
        and(
          eq(cycleCountLines.companyId, ctx.companyId),
          eq(cycleCountLines.cycleCountId, cc.id),
        ),
      )
      .orderBy(cycleCountLines.id);

    const byResolution: Record<CycleCountResolution, typeof rows> = {
      SCANNED: [],
      COUNTED_BY_UPC: [],
      MARKED_SOLD: [],
      NEW_ITEM: [],
    };
    for (const r of rows) byResolution[r.resolution].push(r);

    return {
      cycleCount: cc,
      lines: rows,
      linesByResolution: byResolution,
      markedSoldSerials: byResolution.MARKED_SOLD.map((l) => l.serial),
    };
  }
}
