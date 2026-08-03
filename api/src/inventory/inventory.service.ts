import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
  SQL,
} from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import { scanMatches } from '../db/scan-match';
import {
  InventoryItem,
  inventoryItems,
  inventoryStock,
  inventoryTransactions,
  itemAudit,
  ItemStatus,
  outboxReturns,
  Product,
  products,
  users,
  stores,
  storeInventory,
  storeLocations,
} from '../db/schema';
import { DataContext } from '../auth/auth.types';
import {
  InventoryActionDto,
  ListInventoryQuery,
  ListItemsQuery,
  ListStockQuery,
  MoveInventoryDto,
} from './dto/inventory.dto';
import { loadLocation } from '../locations/location-util';
import { Paginated, resolvePaging } from '../common/pagination';

type TxType = 'RECEIPT' | 'SALE' | 'ADJUSTMENT' | 'RETURN' | 'MOVE';

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
          // Searching the barcode too, so pasting a scanned label into the box finds
          // the unit rather than nothing.
          or(
            ilike(inventoryItems.serial, like),
            ilike(inventoryItems.barcode, like),
          )!,
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
        // A product-less unit (unknown serial awaiting review) cannot contribute a
        // product-level search hit; it is found through the review queue instead.
        for (const r of serialRows)
          if (r.productId != null && !matched.has(r.productId))
            matched.set(r.productId, r.serial);

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
            locationId: inventoryItems.locationId,
            locationName: storeLocations.name,
            locationKind: storeLocations.kind,
            serial: inventoryItems.serial,
            status: inventoryItems.status,
            expirationDate: inventoryItems.expirationDate,
            receivedAt: inventoryItems.receivedAt,
            updatedAt: inventoryItems.updatedAt,
          })
          .from(inventoryItems)
          .innerJoin(
            storeLocations,
            eq(storeLocations.id, inventoryItems.locationId),
          )
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
        .select({
          id: inventoryStock.id,
          storeId: inventoryStock.storeId,
          productId: inventoryStock.productId,
          locationId: inventoryStock.locationId,
          locationName: storeLocations.name,
          locationKind: storeLocations.kind,
          quantityOnHand: inventoryStock.quantityOnHand,
          updatedAt: inventoryStock.updatedAt,
        })
        .from(inventoryStock)
        .innerJoin(
          storeLocations,
          eq(storeLocations.id, inventoryStock.locationId),
        )
        .where(and(...stockConds))
        .orderBy(asc(storeLocations.sortOrder));

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
        this.requireLocationId(dto),
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
        this.requireLocationId(dto),
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
        // An unidentified unit cannot be returned: the ERP receives against a SKU,
        // and this unit has no catalog row yet. Identify it first (review queue or
        // an import check), then return it.
        if (item.productId == null) {
          throw new BadRequestException(
            'This unit has no product yet — resolve it in Needs Review before returning it to the warehouse.',
          );
        }
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
        this.requireLocationId(dto),
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

  // ---- lost ----------------------------------------------------------------

  /**
   * Write a unit off as lost.
   *
   * The case this exists for is a handoff that never physically arrived: it sat in
   * Pending arrival long enough that somebody decided it is not coming. That unit was
   * never stock, so the ledger delta is 0 — writing -1 would claim a unit left the
   * shelf, and no unit ever reached one. A unit lost off a shelf DID leave stock, so
   * it gets -1 and keeps its last known location as the only clue about where it went.
   *
   * Not reachable from a cycle count on purpose. A count only ever proposes, and
   * declaring something gone for good is a decision someone should make deliberately
   * while looking at how long it has been missing.
   */
  async markLost(ctx: DataContext, itemId: string, note?: string) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const current = await this.loadUnit(tx, ctx, itemId);
      if (current.status === 'LOST') return current; // idempotent
      if (current.status !== 'PENDING' && current.status !== 'ON_HAND') {
        throw new ConflictException(
          `Only pending or on-hand units can be marked lost; this one is ${current.status}.`,
        );
      }

      const wasStock = current.status === 'ON_HAND';
      const [item] = await tx
        .update(inventoryItems)
        .set({ status: 'LOST', updatedAt: new Date() })
        .where(eq(inventoryItems.id, itemId))
        .returning();

      await tx.insert(inventoryTransactions).values({
        companyId: item.companyId,
        storeId: item.storeId,
        productId: item.productId,
        itemId: item.id,
        type: 'ADJUSTMENT',
        quantityDelta: wasStock ? -1 : 0,
        locationFromId: current.locationId,
        note:
          note?.trim() ||
          (wasStock ? 'marked lost' : 'marked lost — never arrived'),
        performedByUserId: ctx.userId,
        source: 'PORTAL',
      });
      return item;
    });
  }

  // ---- move (between locations) ------------------------------------------

  /**
   * Move inventory between locations in one transaction. Serialized mode moves
   * each unit in `itemIds` to `toLocationId` (per-unit result, partial success
   * allowed). Quantity mode moves `quantity` of `productId` from `fromLocationId`
   * to `toLocationId`. A MOVE ledger row records from/to for each move.
   */
  async move(ctx: DataContext, dto: MoveInventoryDto) {
    const isSerial = dto.itemIds !== undefined && dto.itemIds.length > 0;
    const isQuantity =
      dto.productId !== undefined &&
      dto.fromLocationId !== undefined &&
      dto.quantity !== undefined;
    if (isSerial === isQuantity) {
      throw new BadRequestException(
        'Provide either itemIds (serialized) or productId + fromLocationId + quantity.',
      );
    }

    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const toLoc = await loadLocation(tx, ctx.companyId, dto.toLocationId);
      if (!toLoc) throw new BadRequestException('Unknown destination location.');
      if (!toLoc.isActive) {
        throw new BadRequestException('Destination location is not active.');
      }
      this.assertStoreScope(ctx, toLoc.storeId);

      if (isSerial) {
        return this.moveSerial(tx, ctx, dto.itemIds!, toLoc, dto.note);
      }
      return this.moveQuantity(
        tx,
        ctx,
        dto.productId!,
        dto.fromLocationId!,
        toLoc,
        dto.quantity!,
        dto.note,
      );
    });
  }

  private assertStoreScope(ctx: DataContext, storeId: number): void {
    if (ctx.role === 'STORE_USER' && ctx.storeId !== storeId) {
      throw new BadRequestException('Cannot act on another store.');
    }
  }

  private async moveSerial(
    tx: Tx,
    ctx: DataContext,
    itemIds: string[],
    toLoc: { id: number; storeId: number },
    note?: string,
  ) {
    const results: Array<{
      itemId: string;
      status: 'moved' | 'unchanged' | 'error';
      reason?: string;
    }> = [];
    let moved = 0;
    for (const itemId of itemIds) {
      try {
        const unit = await this.loadUnit(tx, ctx, itemId);
        if (unit.status !== 'ON_HAND') {
          results.push({
            itemId,
            status: 'error',
            reason: `unit is ${unit.status}, only ON_HAND units can move`,
          });
          continue;
        }
        if (unit.storeId !== toLoc.storeId) {
          results.push({
            itemId,
            status: 'error',
            reason: 'unit is in a different store',
          });
          continue;
        }
        if (unit.locationId === toLoc.id) {
          results.push({ itemId, status: 'unchanged' });
          continue;
        }
        const fromLocationId = unit.locationId;
        await tx
          .update(inventoryItems)
          .set({ locationId: toLoc.id, updatedAt: new Date() })
          .where(eq(inventoryItems.id, itemId));
        await tx.insert(inventoryTransactions).values({
          companyId: ctx.companyId,
          storeId: unit.storeId,
          productId: unit.productId,
          itemId: unit.id,
          type: 'MOVE',
          quantityDelta: 0,
          locationFromId: fromLocationId,
          locationToId: toLoc.id,
          note: note ?? null,
          performedByUserId: ctx.userId,
          source: 'PORTAL',
        });
        results.push({ itemId, status: 'moved' });
        moved++;
      } catch (err) {
        results.push({
          itemId,
          status: 'error',
          reason: err instanceof Error ? err.message.slice(0, 200) : 'error',
        });
      }
    }
    return { mode: 'serial' as const, toLocationId: toLoc.id, moved, results };
  }

  private async moveQuantity(
    tx: Tx,
    ctx: DataContext,
    productId: number,
    fromLocationId: number,
    toLoc: { id: number; storeId: number },
    quantity: number,
    note?: string,
  ) {
    if (fromLocationId === toLoc.id) {
      throw new BadRequestException('Source and destination are the same.');
    }
    const product = await this.loadProduct(tx, ctx, productId);
    if (product.trackingType !== 'QUANTITY') {
      throw new BadRequestException(
        'Product is serialized; move it by itemIds.',
      );
    }
    const fromLoc = await loadLocation(tx, ctx.companyId, fromLocationId);
    if (!fromLoc || fromLoc.storeId !== toLoc.storeId) {
      throw new BadRequestException(
        'Source location does not belong to the destination store.',
      );
    }
    const storeId = toLoc.storeId;

    // Lock + decrement source.
    const [src] = await tx
      .select()
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.companyId, ctx.companyId),
          eq(inventoryStock.storeId, storeId),
          eq(inventoryStock.productId, productId),
          eq(inventoryStock.locationId, fromLocationId),
        ),
      )
      .for('update');
    const available = src?.quantityOnHand ?? 0;
    if (available < quantity) {
      throw new ConflictException(
        `Insufficient stock: ${available} at source, cannot move ${quantity}.`,
      );
    }
    const fromRemaining = available - quantity;
    await tx
      .update(inventoryStock)
      .set({ quantityOnHand: fromRemaining, updatedAt: new Date() })
      .where(eq(inventoryStock.id, src!.id));

    // Increment destination (create the row if it doesn't exist yet).
    const [dst] = await tx
      .select()
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.companyId, ctx.companyId),
          eq(inventoryStock.storeId, storeId),
          eq(inventoryStock.productId, productId),
          eq(inventoryStock.locationId, toLoc.id),
        ),
      )
      .for('update');
    let toOnHand: number;
    if (dst) {
      toOnHand = dst.quantityOnHand + quantity;
      await tx
        .update(inventoryStock)
        .set({ quantityOnHand: toOnHand, updatedAt: new Date() })
        .where(eq(inventoryStock.id, dst.id));
    } else {
      toOnHand = quantity;
      await tx.insert(inventoryStock).values({
        companyId: ctx.companyId,
        storeId,
        productId,
        locationId: toLoc.id,
        quantityOnHand: toOnHand,
      });
    }

    // One MOVE ledger row: positive delta, from/to express the direction.
    await tx.insert(inventoryTransactions).values({
      companyId: ctx.companyId,
      storeId,
      productId,
      itemId: null,
      type: 'MOVE',
      quantityDelta: quantity,
      locationFromId: fromLocationId,
      locationToId: toLoc.id,
      note: note ?? null,
      performedByUserId: ctx.userId,
      source: 'PORTAL',
    });

    return {
      mode: 'quantity' as const,
      productId,
      fromLocationId,
      toLocationId: toLoc.id,
      quantity,
      fromRemaining,
      toOnHand,
    };
  }

  // ---- items (serialized, by expiration) ---------------------------------

  /** Serialized units with location + expiration, sorted by expiration date. */
  async listItems(ctx: DataContext, query: ListItemsQuery) {
    const { limit, offset } = resolvePaging(query);
    const storeId = this.readStoreId(ctx, query.storeId);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      // Defaults to ON_HAND so the stock grid is unaffected; ?status=PENDING is
      // the shipped-not-yet-received queue.
      const status = query.status ?? 'ON_HAND';
      const conds: SQL[] = [
        eq(inventoryItems.companyId, ctx.companyId),
        eq(inventoryItems.status, status),
      ];
      if (storeId != null) conds.push(eq(inventoryItems.storeId, storeId));
      if (query.locationId != null)
        conds.push(eq(inventoryItems.locationId, query.locationId));
      if (query.productId != null)
        conds.push(eq(inventoryItems.productId, query.productId));
      if (query.needsReview === 'true')
        conds.push(eq(inventoryItems.needsReview, true));

      // Expiration filters. expiringWithinDays wins over an explicit date if both.
      let cutoff: string | undefined = query.expiresBefore;
      if (query.expiringWithinDays != null) {
        const d = new Date();
        d.setDate(d.getDate() + query.expiringWithinDays);
        cutoff = d.toISOString().slice(0, 10);
      }
      if (cutoff) {
        // A date comparison already excludes NULL expirations.
        conds.push(lte(inventoryItems.expirationDate, cutoff));
      } else if (query.hasExpiration === 'true') {
        conds.push(isNotNull(inventoryItems.expirationDate));
      }

      const where = and(...conds);
      const rows = await tx
        .select({
          id: inventoryItems.id,
          storeId: inventoryItems.storeId,
          productId: inventoryItems.productId,
          sku: products.sku,
          name: products.name,
          locationId: inventoryItems.locationId,
          locationName: storeLocations.name,
          locationKind: storeLocations.kind,
          serial: inventoryItems.serial,
          barcode: inventoryItems.barcode,
          status: inventoryItems.status,
          expirationDate: inventoryItems.expirationDate,
          receivedAt: inventoryItems.receivedAt,
          needsReview: inventoryItems.needsReview,
          importCheckStatus: inventoryItems.importCheckStatus,
          // The stored answer, not just the state name: the review queue expands it so
          // a human can read what PPS actually said before deciding what to do.
          importCheckResult: inventoryItems.importCheckResult,
          importCheckRequestedAt: inventoryItems.importCheckRequestedAt,
          importCheckResolvedAt: inventoryItems.importCheckResolvedAt,
          // For PENDING units this is the handoff moment: the row is created when
          // the ERP hands the unit over.
          createdAt: inventoryItems.createdAt,
          daysPending: sql<number>`
            case when ${inventoryItems.status} = 'PENDING'
              then (current_date - ${inventoryItems.createdAt}::date)
            end`.as('days_pending'),
        })
        .from(inventoryItems)
        // LEFT joins, not inner: a PENDING unit has no location and an unidentified
        // unit has no product. Inner joins would silently hide exactly the rows
        // these queues exist to show. For ON_HAND rows the result is identical,
        // since those always have both.
        .leftJoin(products, eq(products.id, inventoryItems.productId))
        .leftJoin(
          storeLocations,
          eq(storeLocations.id, inventoryItems.locationId),
        )
        .where(where)
        // Pending arrivals are most useful oldest-first (what has been waiting
        // longest); everything else stays sorted by expiry as before.
        .orderBy(
          ...(status === 'PENDING'
            ? [asc(inventoryItems.createdAt), asc(inventoryItems.serial)]
            : [asc(inventoryItems.expirationDate), asc(inventoryItems.serial)]),
        )
        .limit(limit)
        .offset(offset);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(inventoryItems)
        .where(where);
      return { data: rows, total: Number(count), limit, offset };
    });
  }

  // ---- combined flat stock listing ---------------------------------------

  /**
   * One row per serialized ON_HAND unit + one row per quantity stock-location,
   * unified. Filters: store, free-text (name/sku/upc/serial), location, tracking
   * type, and a created-date range. A raw UNION keeps pagination + totals exact
   * across both kinds (RLS still applies — these are the base tables).
   */
  async listStock(ctx: DataContext, query: ListStockQuery): Promise<Paginated<unknown>> {
    const { limit, offset } = resolvePaging(query);
    const storeId = this.readStoreId(ctx, query.storeId);
    const term = query.search?.trim();
    const like = term ? `%${term}%` : null;

    const statusScope = query.status ?? 'ON_HAND';
    const includeStock = statusScope !== 'SOLD';
    const unitStatusCond =
      statusScope === 'SOLD'
        ? sql`i.status = 'SOLD'`
        : statusScope === 'ALL'
          ? sql`TRUE`
          : sql`i.status = 'ON_HAND'`;

    // Whitelisted sort column (never interpolate user input into SQL directly).
    const sortCols: Record<string, SQL> = {
      sku: sql`c.sku`,
      barcode: sql`c.upc`,
      name: sql`c.name`,
      type: sql`c.tracking_type`,
      store: sql`c.store_id`,
      onHand: sql`c.on_hand`,
      location: sql`c.location_name`,
      expiration: sql`c.expiration_date`,
      created: sql`c.created_at`,
    };
    const sortCol = sortCols[query.sortBy ?? 'name'] ?? sortCols['name'];
    const sortDir = query.sortDir === 'desc' ? sql`DESC` : sql`ASC`;

    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const stockBranch = includeStock
        ? sql`
          UNION ALL
          SELECT 'stock'::text, 'stock:' || s.id::text, NULL::uuid,
                 p.id, p.sku, p.upc, p.name, p.tracking_type::text, s.store_id, s.quantity_on_hand,
                 l.id, l.name, l.kind::text,
                 NULL::text, NULL::date, s.created_at, NULL::text
          FROM inventory_stock s
          JOIN products p ON p.id = s.product_id
          JOIN store_locations l ON l.id = s.location_id
          WHERE s.company_id = ${ctx.companyId} AND s.quantity_on_hand > 0`
        : sql``;

      const cte = sql`
        WITH combined AS (
          SELECT 'unit'::text AS row_kind, i.id::text AS row_id, i.id AS item_id,
                 p.id AS product_id, p.sku, p.upc, p.name,
                 p.tracking_type::text AS tracking_type, i.store_id,
                 (CASE WHEN i.status = 'ON_HAND' THEN 1 ELSE 0 END) AS on_hand,
                 l.id AS location_id, l.name AS location_name, l.kind::text AS location_kind,
                 i.serial, i.expiration_date, i.created_at, i.status::text AS status
          FROM inventory_items i
          JOIN products p ON p.id = i.product_id
          JOIN store_locations l ON l.id = i.location_id
          WHERE i.company_id = ${ctx.companyId} AND ${unitStatusCond}
          ${stockBranch}
        )`;

      const conds: SQL[] = [];
      if (storeId != null) conds.push(sql`c.store_id = ${storeId}`);
      if (query.locationId != null) conds.push(sql`c.location_id = ${query.locationId}`);
      if (query.type) conds.push(sql`c.tracking_type = ${query.type}`);
      if (query.createdFrom) conds.push(sql`c.created_at >= ${query.createdFrom}::date`);
      if (query.createdTo)
        conds.push(sql`c.created_at < (${query.createdTo}::date + interval '1 day')`);
      if (like)
        conds.push(
          sql`(c.name ILIKE ${like} OR c.sku ILIKE ${like} OR c.upc ILIKE ${like} OR c.serial ILIKE ${like})`,
        );
      const where = conds.length ? sql` WHERE ${sql.join(conds, sql` AND `)}` : sql``;

      const pageRes = await tx.execute(sql`
        ${cte}
        SELECT c.* FROM combined c${where}
        ORDER BY ${sortCol} ${sortDir} NULLS LAST, c.name ASC, c.serial ASC NULLS FIRST
        LIMIT ${limit} OFFSET ${offset}`);
      const countRes = await tx.execute(sql`
        ${cte}
        SELECT count(*)::int AS n FROM combined c${where}`);

      const rows = (pageRes as unknown as { rows: Record<string, unknown>[] }).rows;
      const total = Number(
        (countRes as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0,
      );
      const data = rows.map((r) => ({
        rowKind: r.row_kind,
        rowId: r.row_id,
        itemId: r.item_id,
        productId: r.product_id,
        sku: r.sku,
        upc: r.upc,
        name: r.name,
        trackingType: r.tracking_type,
        storeId: r.store_id,
        onHand: r.on_hand,
        locationId: r.location_id,
        locationName: r.location_name,
        locationKind: r.location_kind,
        serial: r.serial,
        expirationDate: r.expiration_date,
        createdAt: r.created_at,
        status: r.status,
      }));
      return { data, total, limit, offset };
    });
  }

  // ---- admin edits (data corrections) ------------------------------------

  /** Edit a serialized unit's expiration date (COMPANY_ADMIN data correction). */
  async updateItem(
    ctx: DataContext,
    itemId: string,
    dto: { expirationDate?: string | null; productId?: number },
  ) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const item = await this.loadUnit(tx, ctx, itemId);
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (dto.expirationDate !== undefined) {
        patch.expirationDate = dto.expirationDate; // string 'YYYY-MM-DD' or null
      }

      // Manual identification: attach a catalog product to an unidentified unit.
      if (dto.productId !== undefined) {
        const product = await this.loadProduct(tx, ctx, dto.productId);
        if (product.trackingType !== 'SERIALIZED') {
          throw new BadRequestException(
            `Product ${product.sku} is tracked by quantity; a serialized unit cannot belong to it.`,
          );
        }
        patch.productId = product.id;
        // Identified by a human is still identified — it leaves the queue.
        patch.needsReview = false;
        // Explains in the unit's own history where its identity came from, the same
        // way an import match does.
        await tx.insert(inventoryTransactions).values({
          companyId: ctx.companyId,
          storeId: item.storeId,
          productId: product.id,
          itemId: item.id,
          type: 'ADJUSTMENT',
          quantityDelta: 0,
          locationToId: item.locationId,
          note: `identified manually as ${product.sku}`,
          source: 'PORTAL',
          performedByUserId: ctx.userId,
        });
      }
      const [row] = await tx
        .update(inventoryItems)
        .set(patch)
        .where(eq(inventoryItems.id, item.id))
        .returning();
      // Audit the expiration change (traceable manual override of ERP sync).
      if (
        dto.expirationDate !== undefined &&
        (item.expirationDate ?? null) !== (dto.expirationDate ?? null)
      ) {
        await this.writeExpirationAudit(
          tx,
          ctx,
          item.id,
          item.expirationDate ?? null,
          dto.expirationDate ?? null,
          'SINGLE_EDIT',
        );
      }
      return row;
    });
  }

  /** One expiration-change audit row. Note reads "src: old → new". */
  private async writeExpirationAudit(
    tx: Tx,
    ctx: DataContext,
    itemId: string,
    oldValue: string | null,
    newValue: string | null,
    source: 'BULK_EDIT' | 'SINGLE_EDIT' | 'SYNC',
    label = source === 'BULK_EDIT' ? 'bulk edit' : 'edit',
  ): Promise<void> {
    await tx.insert(itemAudit).values({
      companyId: ctx.companyId,
      itemId,
      field: 'expiration_date',
      oldValue,
      newValue,
      changedByUserId: ctx.userId,
      source,
      note: `${label}: ${oldValue ?? '—'} → ${newValue ?? '—'}`,
    });
  }

  /**
   * Bulk-set the expiration date on serialized items (COMPANY_ADMIN). Every id
   * must be a serialized item in tenant scope — any unknown / non-serialized id
   * fails the WHOLE request (client bug). Editable (ON_HAND) items succeed even
   * when others are rejected per-item (partial success). One transaction; each
   * change writes an audit row.
   */
  async bulkExpiration(
    ctx: DataContext,
    dto: { itemIds: string[]; expirationDate: string | null },
  ): Promise<{ results: Array<{ itemId: string; ok: boolean; reason?: string }> }> {
    const ids = [...new Set(dto.itemIds)];
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const items = await tx
        .select({
          id: inventoryItems.id,
          status: inventoryItems.status,
          expirationDate: inventoryItems.expirationDate,
        })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.companyId, ctx.companyId),
            inArray(inventoryItems.id, ids),
          ),
        );
      // inventory_items only holds serialized units, so any id not found here is
      // either unknown, cross-tenant, or a quantity product — all client bugs.
      const found = new Map(items.map((i) => [i.id, i]));
      const offending = ids.filter((id) => !found.has(id));
      if (offending.length > 0) {
        throw new BadRequestException({
          message:
            'Every id must be a serialized item in your company. Offending ids indicate a client bug.',
          offendingIds: offending,
        });
      }

      const newValue = dto.expirationDate ?? null;
      const results: Array<{ itemId: string; ok: boolean; reason?: string }> = [];
      for (const it of items) {
        if (it.status !== 'ON_HAND') {
          results.push({
            itemId: it.id,
            ok: false,
            reason: `item is ${it.status}, only ON_HAND items can be edited`,
          });
          continue;
        }
        const oldValue = it.expirationDate ?? null;
        if (oldValue !== newValue) {
          await tx
            .update(inventoryItems)
            .set({ expirationDate: newValue, updatedAt: new Date() })
            .where(eq(inventoryItems.id, it.id));
          await this.writeExpirationAudit(tx, ctx, it.id, oldValue, newValue, 'BULK_EDIT');
        }
        results.push({ itemId: it.id, ok: true });
      }
      return { results };
    });
  }

  /**
   * Bulk mark serialized items as SOLD (partial success). Same tenant-scope /
   * serialized validation as bulk-expiration (unknown ids fail the whole
   * request); non-ON_HAND items are rejected per-item. One transaction; each
   * sale writes a SALE ledger row from the unit's current location.
   */
  async bulkSell(
    ctx: DataContext,
    dto: { itemIds: string[]; note?: string },
  ): Promise<{ results: Array<{ itemId: string; ok: boolean; reason?: string }> }> {
    const ids = [...new Set(dto.itemIds)];
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const items = await tx
        .select({
          id: inventoryItems.id,
          storeId: inventoryItems.storeId,
          productId: inventoryItems.productId,
          status: inventoryItems.status,
          locationId: inventoryItems.locationId,
        })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.companyId, ctx.companyId),
            inArray(inventoryItems.id, ids),
          ),
        );
      const found = new Map(items.map((i) => [i.id, i]));
      const offending = ids.filter((id) => !found.has(id));
      if (offending.length > 0) {
        throw new BadRequestException({
          message:
            'Every id must be a serialized item in your company. Offending ids indicate a client bug.',
          offendingIds: offending,
        });
      }

      const results: Array<{ itemId: string; ok: boolean; reason?: string }> = [];
      for (const it of items) {
        if (it.status !== 'ON_HAND') {
          results.push({
            itemId: it.id,
            ok: false,
            reason: `item is ${it.status}, only ON_HAND items can be sold`,
          });
          continue;
        }
        await tx
          .update(inventoryItems)
          .set({ status: 'SOLD', updatedAt: new Date() })
          .where(eq(inventoryItems.id, it.id));
        await tx.insert(inventoryTransactions).values({
          companyId: ctx.companyId,
          storeId: it.storeId,
          productId: it.productId,
          itemId: it.id,
          type: 'SALE',
          quantityDelta: -1,
          locationFromId: it.locationId,
          note: dto.note ?? 'Bulk sold',
          performedByUserId: ctx.userId,
          source: 'PORTAL',
        });
        results.push({ itemId: it.id, ok: true });
      }
      return { results };
    });
  }

  /** Audit records for one serialized item (expiration changes), newest first. */
  async itemAuditTrail(ctx: DataContext, itemId: string) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      await this.loadUnit(tx, ctx, itemId); // scope + existence
      return tx
        .select({
          id: itemAudit.id,
          field: itemAudit.field,
          oldValue: itemAudit.oldValue,
          newValue: itemAudit.newValue,
          source: itemAudit.source,
          note: itemAudit.note,
          createdAt: itemAudit.createdAt,
          changedByUserId: itemAudit.changedByUserId,
          changedByEmail: users.email,
        })
        .from(itemAudit)
        .leftJoin(users, eq(users.id, itemAudit.changedByUserId))
        .where(
          and(
            eq(itemAudit.companyId, ctx.companyId),
            eq(itemAudit.itemId, itemId),
          ),
        )
        .orderBy(desc(itemAudit.createdAt));
    });
  }

  /**
   * Set a quantity product's on-hand at a location to an exact value
   * (COMPANY_ADMIN). Records the difference as an ADJUSTMENT ledger row.
   */
  async setQuantity(
    ctx: DataContext,
    dto: {
      productId: number;
      locationId: number;
      storeId?: number;
      quantity: number;
      note?: string;
    },
  ) {
    const storeId = this.writeStoreId(ctx, dto.storeId);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const product = await this.loadProduct(tx, ctx, dto.productId);
      if (product.trackingType !== 'QUANTITY') {
        throw new BadRequestException('On-hand can only be set for quantity products.');
      }
      await this.assertLocationInStore(tx, ctx, dto.locationId, storeId);
      const [stock] = await tx
        .select()
        .from(inventoryStock)
        .where(
          and(
            eq(inventoryStock.companyId, ctx.companyId),
            eq(inventoryStock.storeId, storeId),
            eq(inventoryStock.productId, dto.productId),
            eq(inventoryStock.locationId, dto.locationId),
          ),
        )
        .for('update');
      const current = stock?.quantityOnHand ?? 0;
      const delta = dto.quantity - current;
      if (stock) {
        await tx
          .update(inventoryStock)
          .set({ quantityOnHand: dto.quantity, updatedAt: new Date() })
          .where(eq(inventoryStock.id, stock.id));
      } else {
        await tx.insert(inventoryStock).values({
          companyId: ctx.companyId,
          storeId,
          productId: dto.productId,
          locationId: dto.locationId,
          quantityOnHand: dto.quantity,
        });
      }
      if (delta !== 0) {
        await tx.insert(inventoryTransactions).values({
          companyId: ctx.companyId,
          storeId,
          productId: dto.productId,
          itemId: null,
          type: 'ADJUSTMENT',
          quantityDelta: delta,
          locationFromId: delta < 0 ? dto.locationId : null,
          locationToId: delta > 0 ? dto.locationId : null,
          note: dto.note ?? `Set on-hand to ${dto.quantity}`,
          performedByUserId: ctx.userId,
          source: 'PORTAL',
        });
      }
      return { productId: dto.productId, locationId: dto.locationId, quantityOnHand: dto.quantity };
    });
  }

  // ---- lookup (scanner resolve) ------------------------------------------

  /**
   * Resolve a scanned barcode for the Move-Items flow. `serial` -> the ON_HAND
   * unit at the store (with its current location). `upc` -> the product, plus
   * per-location stock for quantity products so the scanner can offer a source.
   */
  async lookup(
    ctx: DataContext,
    query: { serial?: string; upc?: string; storeId?: number },
  ) {
    const storeId = this.readStoreId(ctx, query.storeId);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      if (query.serial) {
        const conds: SQL[] = [
          eq(inventoryItems.companyId, ctx.companyId),
          scanMatches(query.serial)!,
          eq(inventoryItems.status, 'ON_HAND'),
        ];
        if (storeId != null) conds.push(eq(inventoryItems.storeId, storeId));
        // Two rows, not one: a serial is unique per product, so a scan can match units of
        // two different SKUs. Moving the wrong one is worse than asking.
        const units = await tx
          .select({
            id: inventoryItems.id,
            storeId: inventoryItems.storeId,
            productId: inventoryItems.productId,
            productName: products.name,
            sku: products.sku,
            serial: inventoryItems.serial,
            locationId: inventoryItems.locationId,
            locationName: storeLocations.name,
            locationKind: storeLocations.kind,
            expirationDate: inventoryItems.expirationDate,
          })
          .from(inventoryItems)
          .innerJoin(products, eq(products.id, inventoryItems.productId))
          .innerJoin(storeLocations, eq(storeLocations.id, inventoryItems.locationId))
          .where(and(...conds))
          .limit(2);
        if (units.length === 0) {
          throw new NotFoundException('No on-hand unit for that serial.');
        }
        if (units.length > 1) {
          throw new ConflictException(
            `Serial '${query.serial}' matches on-hand units of more than one product ` +
              `(${units.map((u) => u.sku).join(', ')}). Scan the full barcode to pick one.`,
          );
        }
        return { kind: 'serial' as const, item: units[0] };
      }

      if (query.upc) {
        const [product] = await tx
          .select()
          .from(products)
          .where(and(eq(products.companyId, ctx.companyId), eq(products.upc, query.upc)))
          .limit(1);
        if (!product) throw new NotFoundException('No product for that barcode.');
        let stockByLocation: Array<{
          locationId: number;
          locationName: string;
          locationKind: string;
          quantityOnHand: number;
        }> = [];
        if (product.trackingType === 'QUANTITY' && storeId != null) {
          stockByLocation = await tx
            .select({
              locationId: inventoryStock.locationId,
              locationName: storeLocations.name,
              locationKind: storeLocations.kind,
              quantityOnHand: inventoryStock.quantityOnHand,
            })
            .from(inventoryStock)
            .innerJoin(storeLocations, eq(storeLocations.id, inventoryStock.locationId))
            .where(
              and(
                eq(inventoryStock.companyId, ctx.companyId),
                eq(inventoryStock.storeId, storeId),
                eq(inventoryStock.productId, product.id),
              ),
            )
            .orderBy(asc(storeLocations.sortOrder));
        }
        return {
          kind: product.trackingType === 'QUANTITY' ? ('quantity' as const) : ('serialized' as const),
          product,
          stockByLocation,
        };
      }

      throw new BadRequestException('Provide a serial or a upc.');
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
      // The unit left its current location.
      locationFromId: item.locationId,
      note: note ?? null,
      performedByUserId: ctx.userId,
      source: 'PORTAL',
    });
    return item;
  }

  /**
   * Apply a signed quantity delta to a stock counter at a specific location +
   * write one ledger row (one txn). A negative delta removes from that location
   * (records location_from_id); a positive delta adds to it (location_to_id).
   */
  private async quantityMove(
    tx: Tx,
    ctx: DataContext,
    productId: number,
    storeId: number,
    locationId: number,
    delta: number,
    type: TxType,
    note?: string,
  ): Promise<{
    product: Product;
    storeId: number;
    locationId: number;
    quantityOnHand: number;
  }> {
    const product = await this.loadProduct(tx, ctx, productId);
    if (product.trackingType !== 'QUANTITY') {
      throw new BadRequestException(
        'Product is serialized; act on a unit (itemId) instead.',
      );
    }
    await this.assertLocationInStore(tx, ctx, locationId, storeId);
    const [stock] = await tx
      .select()
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
    const current = stock?.quantityOnHand ?? 0;
    const next = current + delta;
    if (next < 0) {
      throw new ConflictException(
        `Insufficient stock: ${current} on hand at that location, cannot remove ${-delta}.`,
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
        locationId,
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
      locationFromId: delta < 0 ? locationId : null,
      locationToId: delta > 0 ? locationId : null,
      note: note ?? null,
      performedByUserId: ctx.userId,
      source: 'PORTAL',
    });
    return { product, storeId, locationId, quantityOnHand: next };
  }

  /** A location must exist, be in the given store, and be active. */
  private async assertLocationInStore(
    tx: Tx,
    ctx: DataContext,
    locationId: number,
    storeId: number,
  ): Promise<void> {
    const loc = await loadLocation(tx, ctx.companyId, locationId);
    if (!loc || loc.storeId !== storeId) {
      throw new BadRequestException('Location does not belong to that store.');
    }
    if (!loc.isActive) {
      throw new BadRequestException('Location is not active.');
    }
  }

  private requireLocationId(dto: InventoryActionDto): number {
    if (dto.locationId === undefined) {
      throw new BadRequestException(
        'locationId is required for quantity products.',
      );
    }
    return dto.locationId;
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
