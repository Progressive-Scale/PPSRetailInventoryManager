import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, sql, SQL } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  InventoryItem,
  inventoryItems,
  inventoryTransactions,
  ItemStatus,
  outboxReturns,
  stores,
} from '../db/schema';
import { DataContext } from '../auth/auth.types';
import {
  CreateItemDto,
  ItemActionDto,
  ListItemsQuery,
  UpdateItemDto,
} from './dto/inventory.dto';
import { Paginated, resolvePaging } from '../common/pagination';

type TxType = 'RECEIPT' | 'SALE' | 'ADJUSTMENT' | 'RETURN';

@Injectable()
export class InventoryService {
  constructor(private readonly tenantDb: TenantDbService) {}

  // ---- helpers -----------------------------------------------------------

  /** Effective store filter for reads (STORE_USER pinned; COMPANY_ADMIN optional). */
  private readStoreId(ctx: DataContext, requested?: number): number | null {
    if (ctx.role === 'STORE_USER') {
      if (ctx.storeId == null) {
        throw new BadRequestException('User is not assigned to a store.');
      }
      return ctx.storeId;
    }
    return requested ?? null; // COMPANY_ADMIN: null = all stores
  }

  /** Store a write must target, enforcing scope. */
  private writeStoreId(ctx: DataContext, requested?: number): number {
    if (ctx.role === 'STORE_USER') {
      if (ctx.storeId == null) {
        throw new BadRequestException('User is not assigned to a store.');
      }
      if (requested !== undefined && requested !== ctx.storeId) {
        throw new BadRequestException('Cannot write to another store.');
      }
      return ctx.storeId;
    }
    if (requested === undefined) {
      throw new BadRequestException('storeId is required.');
    }
    return requested;
  }

  private async loadItem(
    tx: Tx,
    ctx: DataContext,
    id: string,
  ): Promise<InventoryItem> {
    const conds: SQL[] = [
      eq(inventoryItems.id, id),
      eq(inventoryItems.companyId, ctx.companyId),
    ];
    if (ctx.role === 'STORE_USER' && ctx.storeId != null) {
      conds.push(eq(inventoryItems.storeId, ctx.storeId));
    }
    const [item] = await tx
      .select()
      .from(inventoryItems)
      .where(and(...conds))
      .limit(1);
    if (!item) throw new NotFoundException('Item not found.');
    return item;
  }

  private async writeLedger(
    tx: Tx,
    ctx: DataContext,
    item: InventoryItem,
    type: TxType,
    quantityDelta: number,
    note?: string,
  ): Promise<void> {
    await tx.insert(inventoryTransactions).values({
      companyId: item.companyId,
      storeId: item.storeId,
      itemId: item.id,
      type,
      quantityDelta,
      note: note ?? null,
      performedByUserId: ctx.userId,
      source: 'PORTAL',
    });
  }

  // ---- reads -------------------------------------------------------------

  async list(
    ctx: DataContext,
    query: ListItemsQuery,
  ): Promise<Paginated<InventoryItem>> {
    const { limit, offset } = resolvePaging(query);
    const storeId = this.readStoreId(ctx, query.storeId);

    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const conds: SQL[] = [eq(inventoryItems.companyId, ctx.companyId)];
      if (storeId != null) conds.push(eq(inventoryItems.storeId, storeId));
      if (query.status)
        conds.push(eq(inventoryItems.status, query.status as ItemStatus));

      const where = and(...conds);
      const data = await tx
        .select()
        .from(inventoryItems)
        .where(where)
        .orderBy(desc(inventoryItems.updatedAt))
        .limit(limit)
        .offset(offset);

      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(inventoryItems)
        .where(where);

      return { data, total: Number(count), limit, offset };
    });
  }

  async findOne(ctx: DataContext, id: string): Promise<InventoryItem> {
    return this.tenantDb.withCompany(ctx.companyId, (tx) =>
      this.loadItem(tx, ctx, id),
    );
  }

  // ---- writes ------------------------------------------------------------

  async create(ctx: DataContext, dto: CreateItemDto): Promise<InventoryItem> {
    const storeId = this.writeStoreId(ctx, dto.storeId);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      let item: InventoryItem;
      try {
        [item] = await tx
          .insert(inventoryItems)
          .values({
            companyId: ctx.companyId,
            storeId,
            serial: dto.serial,
            sku: dto.sku,
            name: dto.name,
            description: dto.description ?? null,
            price: dto.price !== undefined ? String(dto.price) : '0',
            status: 'ON_HAND',
            receivedAt: new Date(),
          })
          .returning();
      } catch (err) {
        if (this.isUnique(err)) {
          throw new ConflictException(
            'An item with that serial already exists for this company.',
          );
        }
        throw err;
      }
      await this.writeLedger(tx, ctx, item, 'RECEIPT', 1, 'Created in portal');
      return item;
    });
  }

  async update(
    ctx: DataContext,
    id: string,
    dto: UpdateItemDto,
  ): Promise<InventoryItem> {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      await this.loadItem(tx, ctx, id); // scope + existence
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (dto.name !== undefined) patch.name = dto.name;
      if (dto.description !== undefined) patch.description = dto.description;
      if (dto.price !== undefined) patch.price = String(dto.price);
      const [item] = await tx
        .update(inventoryItems)
        .set(patch)
        .where(
          and(
            eq(inventoryItems.id, id),
            eq(inventoryItems.companyId, ctx.companyId),
          ),
        )
        .returning();
      return item;
      // Note: metadata edits are not inventory *state* changes, so no ledger row.
    });
  }

  async sell(
    ctx: DataContext,
    id: string,
    dto: ItemActionDto,
  ): Promise<InventoryItem> {
    return this.transition(ctx, id, {
      from: ['ON_HAND'],
      to: 'SOLD',
      type: 'SALE',
      delta: -1,
      note: dto.note,
    });
  }

  async adjustOut(
    ctx: DataContext,
    id: string,
    dto: ItemActionDto,
  ): Promise<InventoryItem> {
    return this.transition(ctx, id, {
      from: ['ON_HAND', 'SOLD'],
      to: 'ADJUSTED_OUT',
      type: 'ADJUSTMENT',
      delta: -1,
      note: dto.note,
    });
  }

  /** Return to warehouse: state change + ledger + outbox_returns row (one txn). */
  async returnToWarehouse(
    ctx: DataContext,
    id: string,
    dto: ItemActionDto,
  ): Promise<InventoryItem> {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const current = await this.loadItem(tx, ctx, id);
      if (!['ON_HAND', 'SOLD'].includes(current.status)) {
        throw new ConflictException(
          `Cannot return an item that is ${current.status}.`,
        );
      }
      const [item] = await tx
        .update(inventoryItems)
        .set({ status: 'RETURNED_TO_WAREHOUSE', updatedAt: new Date() })
        .where(eq(inventoryItems.id, id))
        .returning();

      await this.writeLedger(tx, ctx, item, 'RETURN', -1, dto.note);

      // Look up the store's ERP building id for the agent's payload.
      const [store] = await tx
        .select()
        .from(stores)
        .where(eq(stores.id, item.storeId))
        .limit(1);

      await tx.insert(outboxReturns).values({
        companyId: item.companyId,
        storeId: item.storeId,
        itemId: item.id,
        serial: item.serial,
        payload: {
          serial: item.serial,
          sku: item.sku,
          name: item.name,
          storeId: item.storeId,
          storeExternalBuildingId: store?.externalBuildingId ?? null,
          returnedAt: item.updatedAt,
          note: dto.note ?? null,
        },
      });
      return item;
    });
  }

  private async transition(
    ctx: DataContext,
    id: string,
    opts: {
      from: ItemStatus[];
      to: ItemStatus;
      type: TxType;
      delta: number;
      note?: string;
    },
  ): Promise<InventoryItem> {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const current = await this.loadItem(tx, ctx, id);
      if (!opts.from.includes(current.status)) {
        throw new ConflictException(
          `Cannot ${opts.type.toLowerCase()} an item that is ${current.status}.`,
        );
      }
      const [item] = await tx
        .update(inventoryItems)
        .set({ status: opts.to, updatedAt: new Date() })
        .where(eq(inventoryItems.id, id))
        .returning();
      await this.writeLedger(tx, ctx, item, opts.type, opts.delta, opts.note);
      return item;
    });
  }

  private isUnique(err: unknown): boolean {
    return (
      !!err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    );
  }
}
