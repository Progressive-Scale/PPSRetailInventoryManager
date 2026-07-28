import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, sql, SQL } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  CycleCount,
  CycleCountResolution,
  cycleCountLines,
  cycleCounts,
  inventoryItems,
  inventoryStock,
  inventoryTransactions,
  Product,
  products,
} from '../db/schema';
import { DataContext } from '../auth/auth.types';
import { Paginated, resolvePaging } from '../common/pagination';
import { resolveOrCreateProduct } from '../products/product-catalog';
import { systemLocationId } from '../locations/location-util';
import {
  CloseCycleCountDto,
  ListCycleCountsQuery,
  NewItemDto,
  OpenCycleCountDto,
  QuantityCountDto,
} from './dto/cycle-counts.dto';

interface PendingLine {
  productId: number;
  itemId: string | null;
  serial: string | null;
  quantity: number | null;
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
      // Serialized ON_HAND units at the store.
      const units = await tx
        .select({
          id: inventoryItems.id,
          serial: inventoryItems.serial,
          productId: inventoryItems.productId,
          sku: products.sku,
          name: products.name,
        })
        .from(inventoryItems)
        .innerJoin(products, eq(products.id, inventoryItems.productId))
        .where(
          and(
            eq(inventoryItems.companyId, ctx.companyId),
            eq(inventoryItems.storeId, storeId),
            eq(inventoryItems.status, 'ON_HAND'),
          ),
        )
        .orderBy(inventoryItems.serial);

      // Quantity stock at the store, summed across locations (the scanner's
      // cycle-count snapshot is product-level and location-agnostic).
      const stock = await tx
        .select({
          productId: inventoryStock.productId,
          quantityOnHand: sql<number>`coalesce(sum(${inventoryStock.quantityOnHand}), 0)::int`,
          sku: products.sku,
          name: products.name,
          upc: products.upc,
        })
        .from(inventoryStock)
        .innerJoin(products, eq(products.id, inventoryStock.productId))
        .where(
          and(
            eq(inventoryStock.companyId, ctx.companyId),
            eq(inventoryStock.storeId, storeId),
          ),
        )
        .groupBy(inventoryStock.productId, products.sku, products.name, products.upc)
        .orderBy(products.sku);

      const [cc] = await tx
        .insert(cycleCounts)
        .values({
          companyId: ctx.companyId,
          storeId,
          status: 'OPEN',
          openedByUserId: ctx.userId,
          expectedCount: units.length,
        })
        .returning();

      return { id: cc.id, cycleCount: cc, snapshot: { units, stock } };
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
      const quantityCounts = dto.quantityCounts ?? [];
      const newItems = dto.newItems ?? [];
      const backroomId = await systemLocationId(
        tx,
        ctx.companyId,
        cc.storeId,
        'BACKROOM',
      );

      // Serialized ON_HAND universe for the store (snapshot before mutations).
      const universe = await tx
        .select({
          id: inventoryItems.id,
          serial: inventoryItems.serial,
          productId: inventoryItems.productId,
          locationId: inventoryItems.locationId,
        })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.companyId, ctx.companyId),
            eq(inventoryItems.storeId, cc.storeId),
            eq(inventoryItems.status, 'ON_HAND'),
          ),
        );
      const bySerial = new Map(universe.map((u) => [u.serial, u]));
      const accounted = new Set<string>();
      const lines: PendingLine[] = [];

      // 1) scanned serials -> SCANNED
      for (const serial of scannedSerials) {
        const it = bySerial.get(serial);
        if (it && !accounted.has(it.id)) {
          accounted.add(it.id);
          lines.push({
            productId: it.productId,
            itemId: it.id,
            serial: it.serial,
            quantity: null,
            resolution: 'SCANNED',
          });
        }
      }

      // 2) quantity counts -> set that location's stock to counted, post ONE
      //    delta ledger row. Location defaults to BACKROOM (scanner omits it).
      for (const qc of quantityCounts) {
        const product = await this.resolveQuantityProduct(tx, ctx, qc);
        const locationId = qc.locationId ?? backroomId;
        const current = await this.currentStock(
          tx,
          ctx,
          cc.storeId,
          product.id,
          locationId,
        );
        const delta = qc.countedQuantity - current;
        if (delta !== 0) {
          await tx.insert(inventoryTransactions).values({
            companyId: ctx.companyId,
            storeId: cc.storeId,
            productId: product.id,
            type: delta < 0 ? 'SALE' : 'ADJUSTMENT',
            quantityDelta: delta,
            locationFromId: delta < 0 ? locationId : null,
            locationToId: delta > 0 ? locationId : null,
            note:
              delta < 0
                ? `Cycle count #${cc.id}`
                : `Cycle count #${cc.id} (found in count)`,
            source: 'CYCLE_COUNT',
            cycleCountId: cc.id,
            performedByUserId: ctx.userId,
          });
        }
        await this.setStock(
          tx,
          ctx,
          cc.storeId,
          product.id,
          locationId,
          qc.countedQuantity,
        );
        lines.push({
          productId: product.id,
          itemId: null,
          serial: null,
          quantity: qc.countedQuantity,
          resolution: 'COUNTED_BY_UPC',
        });
      }

      // 3) newItems -> create needs_review products + unit/stock (in BACKROOM)
      //    + RECEIPT.
      for (const ni of newItems) {
        const line = await this.applyNewItem(
          tx,
          ctx,
          cc.id,
          cc.storeId,
          backroomId,
          ni,
          { bySerial, accounted },
        );
        if (line) lines.push(line);
      }

      // 4) sold sweep — any serialized ON_HAND universe item not accounted.
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
          productId: it.productId,
          itemId: it.id,
          type: 'SALE',
          quantityDelta: -1,
          locationFromId: it.locationId,
          note: `Cycle count #${cc.id}`,
          source: 'CYCLE_COUNT',
          cycleCountId: cc.id,
          performedByUserId: ctx.userId,
        });
        lines.push({
          productId: it.productId,
          itemId: it.id,
          serial: it.serial,
          quantity: null,
          resolution: 'MARKED_SOLD',
        });
        soldCount++;
      }

      if (lines.length > 0) {
        await tx.insert(cycleCountLines).values(
          lines.map((l) => ({
            companyId: ctx.companyId,
            cycleCountId: cc.id,
            productId: l.productId,
            itemId: l.itemId,
            serial: l.serial,
            quantity: l.quantity,
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

  // ---- internals ---------------------------------------------------------

  private async resolveQuantityProduct(
    tx: Tx,
    ctx: DataContext,
    qc: QuantityCountDto,
  ): Promise<Product> {
    let product: Product | undefined;
    if (qc.productId !== undefined) {
      [product] = await tx
        .select()
        .from(products)
        .where(
          and(eq(products.id, qc.productId), eq(products.companyId, ctx.companyId)),
        )
        .limit(1);
    } else if (qc.upc) {
      [product] = await tx
        .select()
        .from(products)
        .where(and(eq(products.companyId, ctx.companyId), eq(products.upc, qc.upc)))
        .limit(1);
    }
    if (!product) {
      throw new BadRequestException(
        `Unknown product for count (${qc.productId ?? qc.upc}).`,
      );
    }
    if (product.trackingType !== 'QUANTITY') {
      throw new BadRequestException(
        `Product ${product.sku} is serialized; count it by serial.`,
      );
    }
    return product;
  }

  private async currentStock(
    tx: Tx,
    ctx: DataContext,
    storeId: number,
    productId: number,
    locationId: number,
  ): Promise<number> {
    const [row] = await tx
      .select({ q: inventoryStock.quantityOnHand })
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.companyId, ctx.companyId),
          eq(inventoryStock.storeId, storeId),
          eq(inventoryStock.productId, productId),
          eq(inventoryStock.locationId, locationId),
        ),
      )
      .for('update');
    return row?.q ?? 0;
  }

  private async setStock(
    tx: Tx,
    ctx: DataContext,
    storeId: number,
    productId: number,
    locationId: number,
    quantity: number,
  ): Promise<void> {
    const updated = await tx
      .update(inventoryStock)
      .set({ quantityOnHand: quantity, updatedAt: new Date() })
      .where(
        and(
          eq(inventoryStock.companyId, ctx.companyId),
          eq(inventoryStock.storeId, storeId),
          eq(inventoryStock.productId, productId),
          eq(inventoryStock.locationId, locationId),
        ),
      )
      .returning({ id: inventoryStock.id });
    if (updated.length === 0) {
      await tx.insert(inventoryStock).values({
        companyId: ctx.companyId,
        storeId,
        productId,
        locationId,
        quantityOnHand: quantity,
      });
    }
  }

  private async addStock(
    tx: Tx,
    ctx: DataContext,
    storeId: number,
    productId: number,
    locationId: number,
    delta: number,
  ): Promise<void> {
    const current = await this.currentStock(tx, ctx, storeId, productId, locationId);
    await this.setStock(tx, ctx, storeId, productId, locationId, current + delta);
  }

  /** Create/attach a needs-review product for an unknown scan. Returns the line. */
  private async applyNewItem(
    tx: Tx,
    ctx: DataContext,
    cycleCountId: number,
    storeId: number,
    locationId: number,
    ni: NewItemDto,
    scan: { bySerial: Map<string, { id: string; productId: number; serial: string }>; accounted: Set<string> },
  ): Promise<PendingLine | null> {
    if (!ni.isUpc) {
      // Serialized. If the serial already exists, treat as a scan.
      const serial = ni.serialOrUpc;
      const existing = scan.bySerial.get(serial);
      if (existing) {
        if (!scan.accounted.has(existing.id)) {
          scan.accounted.add(existing.id);
          return {
            productId: existing.productId,
            itemId: existing.id,
            serial,
            quantity: null,
            resolution: 'SCANNED',
          };
        }
        return null;
      }
      const [dup] = await tx
        .select({ id: inventoryItems.id })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.companyId, ctx.companyId),
            eq(inventoryItems.serial, serial),
          ),
        )
        .limit(1);
      if (dup) return null; // exists but not ON_HAND at this store; skip

      const product = await resolveOrCreateProduct(tx, ctx.companyId, {
        sku: `REVIEW-${serial}`,
        name: ni.name,
        price: '0',
        upc: null,
        trackingType: 'SERIALIZED',
        needsReview: true,
      });
      const [item] = await tx
        .insert(inventoryItems)
        .values({
          companyId: ctx.companyId,
          storeId,
          productId: product.id,
          locationId,
          serial,
          status: 'ON_HAND',
          expirationDate: ni.expirationDate ?? null,
          receivedAt: new Date(),
        })
        .returning();
      await tx.insert(inventoryTransactions).values({
        companyId: ctx.companyId,
        storeId,
        productId: product.id,
        itemId: item.id,
        type: 'RECEIPT',
        quantityDelta: 1,
        locationToId: locationId,
        note: `Cycle count #${cycleCountId} new item`,
        source: 'CYCLE_COUNT',
        cycleCountId,
        performedByUserId: ctx.userId,
      });
      return {
        productId: product.id,
        itemId: item.id,
        serial,
        quantity: null,
        resolution: 'NEW_ITEM',
      };
    }

    // Quantity. Attach to an existing product by UPC, else create a review one.
    const upc = ni.serialOrUpc;
    const qty = ni.quantity ?? 0;
    if (qty <= 0) {
      throw new BadRequestException('A quantity new item requires a quantity.');
    }
    let [product] = await tx
      .select()
      .from(products)
      .where(and(eq(products.companyId, ctx.companyId), eq(products.upc, upc)))
      .limit(1);
    if (!product) {
      product = await resolveOrCreateProduct(tx, ctx.companyId, {
        sku: `REVIEW-UPC-${upc}`,
        name: ni.name,
        price: '0',
        upc,
        trackingType: 'QUANTITY',
        needsReview: true,
      });
    }
    if (product.trackingType !== 'QUANTITY') {
      throw new BadRequestException(
        `UPC ${upc} belongs to serialized product ${product.sku}.`,
      );
    }
    await this.addStock(tx, ctx, storeId, product.id, locationId, qty);
    await tx.insert(inventoryTransactions).values({
      companyId: ctx.companyId,
      storeId,
      productId: product.id,
      type: 'RECEIPT',
      quantityDelta: qty,
      locationToId: locationId,
      note: `Cycle count #${cycleCountId} new item`,
      source: 'CYCLE_COUNT',
      cycleCountId,
      performedByUserId: ctx.userId,
    });
    return {
      productId: product.id,
      itemId: null,
      serial: null,
      quantity: qty,
      resolution: 'NEW_ITEM',
    };
  }

  /** Deterministic result view (used by close, re-close and GET /:id). */
  private async buildResult(tx: Tx, ctx: DataContext, cc: CycleCount) {
    const rows = await tx
      .select({
        id: cycleCountLines.id,
        companyId: cycleCountLines.companyId,
        cycleCountId: cycleCountLines.cycleCountId,
        productId: cycleCountLines.productId,
        itemId: cycleCountLines.itemId,
        serial: cycleCountLines.serial,
        quantity: cycleCountLines.quantity,
        resolution: cycleCountLines.resolution,
        createdAt: cycleCountLines.createdAt,
        sku: products.sku,
        name: products.name,
      })
      .from(cycleCountLines)
      .innerJoin(products, eq(products.id, cycleCountLines.productId))
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

    // Quantity products with stock at the store that this count never touched
    // (no line references them) — surfaced so the review UI can warn.
    const touchedProductIds = new Set(rows.map((l) => l.productId));
    const stockRows = await tx
      .select({
        productId: inventoryStock.productId,
        quantityOnHand: sql<number>`coalesce(sum(${inventoryStock.quantityOnHand}), 0)::int`,
        sku: products.sku,
        name: products.name,
      })
      .from(inventoryStock)
      .innerJoin(products, eq(products.id, inventoryStock.productId))
      .where(
        and(
          eq(inventoryStock.companyId, ctx.companyId),
          eq(inventoryStock.storeId, cc.storeId),
        ),
      )
      .groupBy(inventoryStock.productId, products.sku, products.name);
    const notCounted = stockRows.filter((s) => !touchedProductIds.has(s.productId));

    return {
      cycleCount: cc,
      lines: rows,
      linesByResolution: byResolution,
      markedSoldSerials: byResolution.MARKED_SOLD.map((l) => l.serial),
      notCounted,
    };
  }
}
