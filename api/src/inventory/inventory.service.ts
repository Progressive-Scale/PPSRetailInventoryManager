import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, or, sql, SQL } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  InventoryItem,
  inventoryItems,
  inventoryStock,
  inventoryTransactions,
  ItemStatus,
  outboxReturns,
  Product,
  products,
  stores,
  storeInventory,
} from '../db/schema';
import { DataContext } from '../auth/auth.types';
import { InventoryActionDto, ListInventoryQuery } from './dto/inventory.dto';
import { Paginated, resolvePaging } from '../common/pagination';

type TxType = 'RECEIPT' | 'SALE' | 'ADJUSTMENT' | 'RETURN';

// The action target resolved from a request body.
type Target =
  | { mode: 'serial'; itemId: string }
  | { mode: 'quantity'; productId: number; quantity: number };

@Injectable()
export class InventoryService {
  constructor(private readonly tenantDb: TenantDbService) {}

  // ---- scope helpers -----------------------------------------------------

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

  private async loadUnit(
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
    if (!item) throw new NotFoundException('Unit not found.');
    return item;
  }

  private async loadProduct(
    tx: Tx,
    ctx: DataContext,
    id: number,
  ): Promise<Product> {
    const [product] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, id), eq(products.companyId, ctx.companyId)))
      .limit(1);
    if (!product) throw new NotFoundException('Product not found.');
    return product;
  }

  // ---- reads -------------------------------------------------------------

  /** Product-level on-hand rows (from the store_inventory view), searchable. */
  async list(ctx: DataContext, query: ListInventoryQuery): Promise<Paginated<unknown>> {
    const { limit, offset } = resolvePaging(query);
    const storeId = this.readStoreId(ctx, query.storeId);

    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const conds: SQL[] = [eq(storeInventory.companyId, ctx.companyId)];
      if (storeId != null) conds.push(eq(storeInventory.storeId, storeId));

      // Serial matches resolve to their product; remember which serial hit.
      const matched = new Map<number, string>();
      const term = query.search?.trim();
      if (term) {
        const like = `%${term}%`;
        const serialConds: SQL[] = [
          eq(inventoryItems.companyId, ctx.companyId),
          ilike(inventoryItems.serial, like),
        ];
        if (storeId != null)
          serialConds.push(eq(inventoryItems.storeId, storeId));
        const serialRows = await tx
          .select({
            productId: inventoryItems.productId,
            serial: inventoryItems.serial,
          })
          .from(inventoryItems)
          .where(and(...serialConds));
        for (const r of serialRows)
          if (!matched.has(r.productId)) matched.set(r.productId, r.serial);

        const ors: SQL[] = [
          ilike(storeInventory.name, like),
          ilike(storeInventory.sku, like),
          ilike(storeInventory.upc, like),
        ];
        if (matched.size > 0)
          ors.push(inArray(storeInventory.productId, [...matched.keys()]));
        conds.push(or(...ors)!);
      }

      const where = and(...conds);
      const rows = await tx
        .select()
        .from(storeInventory)
        .where(where)
        .orderBy(asc(storeInventory.sku))
        .limit(limit)
        .offset(offset);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(storeInventory)
        .where(where);

      const data = rows.map((r) =>
        matched.has(r.productId)
          ? { ...r, matchedSerial: matched.get(r.productId) }
          : r,
      );
      return { data, total: Number(count), limit, offset };
    });
  }

  /** Expansion for a single product: serialized units, or stock + recent ledger. */
  async getProduct(ctx: DataContext, productId: number) {
    const storeId = this.readStoreId(ctx);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const product = await this.loadProduct(tx, ctx, productId);

      if (product.trackingType === 'SERIALIZED') {
        const conds: SQL[] = [
          eq(inventoryItems.companyId, ctx.companyId),
          eq(inventoryItems.productId, productId),
        ];
        if (storeId != null) conds.push(eq(inventoryItems.storeId, storeId));
        const units = await tx
          .select({
            id: inventoryItems.id,
            storeId: inventoryItems.storeId,
            serial: inventoryItems.serial,
            status: inventoryItems.status,
            expirationDate: inventoryItems.expirationDate,
            receivedAt: inventoryItems.receivedAt,
            updatedAt: inventoryItems.updatedAt,
          })
          .from(inventoryItems)
          .where(and(...conds))
          .orderBy(asc(inventoryItems.serial));
        const statusCounts = units.reduce<Record<string, number>>((acc, u) => {
          acc[u.status] = (acc[u.status] ?? 0) + 1;
          return acc;
        }, {});
        return { product, trackingType: 'SERIALIZED' as const, units, statusCounts };
      }

      const stockConds: SQL[] = [
        eq(inventoryStock.companyId, ctx.companyId),
        eq(inventoryStock.productId, productId),
      ];
      if (storeId != null) stockConds.push(eq(inventoryStock.storeId, storeId));
      const stock = await tx
        .select()
        .from(inventoryStock)
        .where(and(...stockConds));

      const ledgerConds: SQL[] = [
        eq(inventoryTransactions.companyId, ctx.companyId),
        eq(inventoryTransactions.productId, productId),
      ];
      if (storeId != null)
        ledgerConds.push(eq(inventoryTransactions.storeId, storeId));
      const ledger = await tx
        .select()
        .from(inventoryTransactions)
        .where(and(...ledgerConds))
        .orderBy(desc(inventoryTransactions.createdAt))
        .limit(20);
      return { product, trackingType: 'QUANTITY' as const, stock, ledger };
    });
  }

  // ---- writes ------------------------------------------------------------

  async sell(ctx: DataContext, dto: InventoryActionDto) {
    const target = this.resolveTarget(dto);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      if (target.mode === 'serial') {
        const item = await this.serialTransition(
          tx,
          ctx,
          target.itemId,
          ['ON_HAND'],
          'SOLD',
          'SALE',
          dto.note,
        );
        return { kind: 'unit' as const, item };
      }
      const storeId = this.writeStoreId(ctx, dto.storeId);
      const res = await this.quantityMove(
        tx,
        ctx,
        target.productId,
        storeId,
        -target.quantity,
        'SALE',
        dto.note,
      );
      return { kind: 'stock' as const, ...res };
    });
  }

  async adjustOut(ctx: DataContext, dto: InventoryActionDto) {
    const target = this.resolveTarget(dto);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      if (target.mode === 'serial') {
        const item = await this.serialTransition(
          tx,
          ctx,
          target.itemId,
          ['ON_HAND', 'SOLD'],
          'ADJUSTED_OUT',
          'ADJUSTMENT',
          dto.note,
        );
        return { kind: 'unit' as const, item };
      }
      const storeId = this.writeStoreId(ctx, dto.storeId);
      const res = await this.quantityMove(
        tx,
        ctx,
        target.productId,
        storeId,
        -target.quantity,
        'ADJUSTMENT',
        dto.note,
      );
      return { kind: 'stock' as const, ...res };
    });
  }

  async returnToWarehouse(ctx: DataContext, dto: InventoryActionDto) {
    const target = this.resolveTarget(dto);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      if (target.mode === 'serial') {
        const item = await this.serialTransition(
          tx,
          ctx,
          target.itemId,
          ['ON_HAND', 'SOLD'],
          'RETURNED_TO_WAREHOUSE',
          'RETURN',
          dto.note,
        );
        const product = await this.loadProduct(tx, ctx, item.productId);
        const store = await this.storeOf(tx, item.storeId);
        await tx.insert(outboxReturns).values({
          companyId: item.companyId,
          storeId: item.storeId,
          productId: item.productId,
          itemId: item.id,
          serial: item.serial,
          payload: {
            kind: 'unit',
            serial: item.serial,
            sku: product.sku,
            name: product.name,
            upc: product.upc,
            storeId: store?.id ?? item.storeId,
            returnedAt: item.updatedAt,
            note: dto.note ?? null,
          },
        });
        return { kind: 'unit' as const, item };
      }

      const storeId = this.writeStoreId(ctx, dto.storeId);
      const res = await this.quantityMove(
        tx,
        ctx,
        target.productId,
        storeId,
        -target.quantity,
        'RETURN',
        dto.note,
      );
      const store = await this.storeOf(tx, storeId);
      await tx.insert(outboxReturns).values({
        companyId: ctx.companyId,
        storeId,
        productId: res.product.id,
        itemId: null,
        serial: null,
        payload: {
          kind: 'stock',
          sku: res.product.sku,
          name: res.product.name,
          upc: res.product.upc,
          quantity: target.quantity,
          storeId: store?.id ?? storeId,
          returnedAt: new Date(),
          note: dto.note ?? null,
        },
      });
      return { kind: 'stock' as const, ...res };
    });
  }

  // ---- internals ---------------------------------------------------------

  private resolveTarget(dto: InventoryActionDto): Target {
    if (dto.itemId) return { mode: 'serial', itemId: dto.itemId };
    if (dto.productId !== undefined && dto.quantity !== undefined) {
      return {
        mode: 'quantity',
        productId: dto.productId,
        quantity: dto.quantity,
      };
    }
    throw new BadRequestException(
      'Provide either itemId (serialized) or productId + quantity (quantity).',
    );
  }

  private async serialTransition(
    tx: Tx,
    ctx: DataContext,
    itemId: string,
    from: ItemStatus[],
    to: ItemStatus,
    type: TxType,
    note?: string,
  ): Promise<InventoryItem> {
    const current = await this.loadUnit(tx, ctx, itemId);
    if (!from.includes(current.status)) {
      throw new ConflictException(
        `Cannot ${type.toLowerCase()} a unit that is ${current.status}.`,
      );
    }
    const [item] = await tx
      .update(inventoryItems)
      .set({ status: to, updatedAt: new Date() })
      .where(eq(inventoryItems.id, itemId))
      .returning();
    await tx.insert(inventoryTransactions).values({
      companyId: item.companyId,
      storeId: item.storeId,
      productId: item.productId,
      itemId: item.id,
      type,
      quantityDelta: -1,
      note: note ?? null,
      performedByUserId: ctx.userId,
      source: 'PORTAL',
    });
    return item;
  }

  /** Apply a signed quantity delta to a stock counter + ledger row (one txn). */
  private async quantityMove(
    tx: Tx,
    ctx: DataContext,
    productId: number,
    storeId: number,
    delta: number,
    type: TxType,
    note?: string,
  ): Promise<{ product: Product; storeId: number; quantityOnHand: number }> {
    const product = await this.loadProduct(tx, ctx, productId);
    if (product.trackingType !== 'QUANTITY') {
      throw new BadRequestException(
        'Product is serialized; act on a unit (itemId) instead.',
      );
    }
    const [stock] = await tx
      .select()
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.companyId, ctx.companyId),
          eq(inventoryStock.storeId, storeId),
          eq(inventoryStock.productId, productId),
        ),
      )
      .for('update');
    const current = stock?.quantityOnHand ?? 0;
    const next = current + delta;
    if (next < 0) {
      throw new ConflictException(
        `Insufficient stock: ${current} on hand, cannot remove ${-delta}.`,
      );
    }
    if (stock) {
      await tx
        .update(inventoryStock)
        .set({ quantityOnHand: next, updatedAt: new Date() })
        .where(eq(inventoryStock.id, stock.id));
    } else {
      await tx.insert(inventoryStock).values({
        companyId: ctx.companyId,
        storeId,
        productId,
        quantityOnHand: next,
      });
    }
    await tx.insert(inventoryTransactions).values({
      companyId: ctx.companyId,
      storeId,
      productId,
      itemId: null,
      type,
      quantityDelta: delta,
      note: note ?? null,
      performedByUserId: ctx.userId,
      source: 'PORTAL',
    });
    return { product, storeId, quantityOnHand: next };
  }

  private async storeOf(tx: Tx, storeId: number) {
    const [store] = await tx
      .select()
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    return store;
  }
}
