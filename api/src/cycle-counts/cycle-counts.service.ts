import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne, sql, SQL } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  CycleCount,
  CycleCountResolution,
  cycleCountLines,
  cycleCountProducts,
  cycleCounts,
  inventoryItems,
  inventoryStock,
  inventoryTransactions,
  Product,
  products,
  storeLocations,
} from '../db/schema';
import { normalizeScannedSerial, scanMatches } from '../db/scan-match';
import { DataContext } from '../auth/auth.types';
import { Paginated, resolvePaging } from '../common/pagination';
import { resolveOrCreateProduct } from '../products/product-catalog';
import { systemLocationId } from '../locations/location-util';
import {
  ListCycleCountsQuery,
  NewItemDto,
  OpenCycleCountDto,
  QuantityCountDto,
  RejectCycleCountDto,
  SubmitCycleCountDto,
} from './dto/cycle-counts.dto';

/**
 * One proposed change. Written to cycle_count_lines on submit, applied — or
 * discarded — on review. Nothing here has touched inventory yet.
 */
interface ProposedLine {
  /** Null for a unit created from an unknown serial: no catalog row yet. */
  productId: number | null;
  itemId: string | null;
  serial: string | null;
  quantity: number | null;
  resolution: CycleCountResolution;
  /** Where the line puts the unit / which stock counter it sets. */
  locationId: number | null;
  /** MOVED_IN only: where the system thought the unit was. */
  locationFromId: number | null;
  /** Ask the PPS import agent to identify this serial once the unit exists. */
  importCheckRequested: boolean;
}

/**
 * Cycle counts, in two phases.
 *
 *   open    the scope is fixed: one location (or the whole store) and optionally a
 *           subset of products. This is what bounds the missing-stock sweep.
 *   submit  everything the counter did becomes PROPOSED lines. Inventory untouched.
 *   approve an admin applies the proposals, in one transaction.
 *   reject  the proposals are discarded and the count reopens for a recount.
 *
 * The gate exists because a count is destructive BY OMISSION: a serial nobody
 * scanned is proposed sold, and a UPC nobody scanned zeroes that shelf. A serialized
 * unit can be reinstated afterwards, but quantity stock has no per-unit rows to put
 * back — so the only safe place to catch a missed scan is before it is applied.
 */
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

  /** The product ids a count is narrowed to. Empty = every product. */
  private async scopeProductIds(tx: Tx, ctx: DataContext, ccId: number) {
    const rows = await tx
      .select({ productId: cycleCountProducts.productId })
      .from(cycleCountProducts)
      .where(
        and(
          eq(cycleCountProducts.companyId, ctx.companyId),
          eq(cycleCountProducts.cycleCountId, ccId),
        ),
      );
    return rows.map((r) => r.productId);
  }

  /**
   * The serialized units a count is responsible for. ONE definition, used for both
   * the snapshot and the sweep — they must not be able to disagree, or a count could
   * sweep something it never showed the counter.
   */
  private inScope(
    ctx: DataContext,
    storeId: number,
    locationId: number | null,
    productIds: number[],
  ): SQL[] {
    const conds: SQL[] = [
      eq(inventoryItems.companyId, ctx.companyId),
      eq(inventoryItems.storeId, storeId),
      eq(inventoryItems.status, 'ON_HAND'),
    ];
    if (locationId != null) conds.push(eq(inventoryItems.locationId, locationId));
    if (productIds.length > 0)
      conds.push(inArray(inventoryItems.productId, productIds));
    return conds;
  }

  // ---- open --------------------------------------------------------------

  async open(ctx: DataContext, dto: OpenCycleCountDto) {
    const storeId = this.writeStoreId(ctx, dto.storeId);
    const productIds = [...new Set(dto.productIds ?? [])];

    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      let location: { id: number; name: string } | null = null;
      if (dto.locationId != null) {
        const [loc] = await tx
          .select({ id: storeLocations.id, name: storeLocations.name })
          .from(storeLocations)
          .where(
            and(
              eq(storeLocations.id, dto.locationId),
              eq(storeLocations.companyId, ctx.companyId),
              eq(storeLocations.storeId, storeId),
            ),
          )
          .limit(1);
        if (!loc) {
          throw new BadRequestException(
            'That location does not belong to this store.',
          );
        }
        location = loc;
      }

      if (productIds.length > 0) {
        const found = await tx
          .select({ id: products.id })
          .from(products)
          .where(
            and(eq(products.companyId, ctx.companyId), inArray(products.id, productIds)),
          );
        if (found.length !== productIds.length) {
          throw new BadRequestException('One or more products are not in the catalog.');
        }
      }

      // In-scope serialized units — what the counter is expected to find.
      const units = await tx
        .select({
          id: inventoryItems.id,
          serial: inventoryItems.serial,
          productId: inventoryItems.productId,
          locationId: inventoryItems.locationId,
          sku: products.sku,
          name: products.name,
          // So a scanner can tell a serialized product's barcode from a quantity
          // one and say "scan each serial" instead of asking for a count that the
          // submit endpoint would reject.
          upc: products.upc,
        })
        .from(inventoryItems)
        .leftJoin(products, eq(products.id, inventoryItems.productId))
        .where(and(...this.inScope(ctx, storeId, dto.locationId ?? null, productIds)))
        .orderBy(inventoryItems.serial);

      // Expected arrivals. PENDING units have no location, so they belong to the
      // STORE rather than to any location's scope: they ride along in every count at
      // this store, and scanning one receives it into whatever is being counted.
      const pendingConds: SQL[] = [
        eq(inventoryItems.companyId, ctx.companyId),
        eq(inventoryItems.storeId, storeId),
        eq(inventoryItems.status, 'PENDING'),
      ];
      if (productIds.length > 0)
        pendingConds.push(inArray(inventoryItems.productId, productIds));
      const pending = await tx
        .select({
          id: inventoryItems.id,
          serial: inventoryItems.serial,
          productId: inventoryItems.productId,
          sku: products.sku,
          name: products.name,
          handedOffAt: inventoryItems.createdAt,
        })
        .from(inventoryItems)
        .leftJoin(products, eq(products.id, inventoryItems.productId))
        .where(and(...pendingConds))
        .orderBy(inventoryItems.createdAt);

      const stockConds: SQL[] = [
        eq(inventoryStock.companyId, ctx.companyId),
        eq(inventoryStock.storeId, storeId),
      ];
      if (dto.locationId != null)
        stockConds.push(eq(inventoryStock.locationId, dto.locationId));
      if (productIds.length > 0)
        stockConds.push(inArray(inventoryStock.productId, productIds));
      const stock = await tx
        .select({
          productId: inventoryStock.productId,
          locationId: inventoryStock.locationId,
          quantityOnHand: inventoryStock.quantityOnHand,
          sku: products.sku,
          name: products.name,
          upc: products.upc,
        })
        .from(inventoryStock)
        .innerJoin(products, eq(products.id, inventoryStock.productId))
        .where(and(...stockConds))
        .orderBy(products.sku);

      const [cc] = await tx
        .insert(cycleCounts)
        .values({
          companyId: ctx.companyId,
          storeId,
          locationId: dto.locationId ?? null,
          status: 'OPEN',
          openedByUserId: ctx.userId,
          expectedCount: units.length,
        })
        .returning();

      if (productIds.length > 0) {
        await tx.insert(cycleCountProducts).values(
          productIds.map((productId) => ({
            companyId: ctx.companyId,
            cycleCountId: cc.id,
            productId,
          })),
        );
      }

      return {
        id: cc.id,
        cycleCount: cc,
        scope: {
          locationId: location?.id ?? null,
          locationName: location?.name ?? null,
          productIds,
          wholeStore: location == null,
        },
        snapshot: { units, pending, stock },
      };
    });
  }

  // ---- submit (compute proposals; change nothing) ------------------------

  async submit(ctx: DataContext, id: number, dto: SubmitCycleCountDto) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const cc = await this.loadCount(tx, ctx, id, true);
      // Idempotent: submitting twice returns the same proposals.
      if (cc.status === 'AWAITING_REVIEW' || cc.status === 'CLOSED') {
        return this.buildResult(tx, ctx, cc);
      }
      if (cc.status === 'CANCELLED') {
        throw new ConflictException('Cycle count was cancelled.');
      }

      // Normalised at the door, once. A handheld may send the retail label's 2D payload
      // (`R1205058450/20260722`) rather than the bare serial, and every map, set and
      // stored line below is keyed on the serial — so reducing here is what keeps a
      // scanned unit from being filed under a string that matches nothing.
      // Deduped AFTER normalising: the same unit scanned twice, once from the 2D code and
      // once from the serial, is one scan.
      const scannedSerials = [
        ...new Set((dto.scannedSerials ?? []).map(normalizeScannedSerial)),
      ];
      const reinstate = new Set(
        (dto.reinstateSerials ?? []).map(normalizeScannedSerial),
      );
      const wantImportCheck = new Set(
        (dto.importCheckSerials ?? []).map(normalizeScannedSerial),
      );
      const quantityCounts = dto.quantityCounts ?? [];
      // A new item's value is a serial only when isUpc is false; a UPC must not be
      // touched. (The 2D pattern could not match one anyway, but saying so is cheaper
      // than making the next reader prove it.)
      const newItems = (dto.newItems ?? []).map((ni) =>
        ni.isUpc
          ? ni
          : { ...ni, serialOrUpc: normalizeScannedSerial(ni.serialOrUpc) },
      );

      const scopeProducts = await this.scopeProductIds(tx, ctx, cc.id);
      // Where things the counter is holding get put. A whole-store count has no
      // location of its own, so found/received units go to the Backroom.
      const contextLocationId =
        cc.locationId ??
        (await systemLocationId(tx, ctx.companyId, cc.storeId, 'BACKROOM'));

      const inScopeUnits = await tx
        .select({
          id: inventoryItems.id,
          serial: inventoryItems.serial,
          productId: inventoryItems.productId,
          locationId: inventoryItems.locationId,
        })
        .from(inventoryItems)
        .where(and(...this.inScope(ctx, cc.storeId, cc.locationId, scopeProducts)));

      // ON_HAND at this store but NOT in scope — a unit the system thinks is
      // somewhere else. Finding it here is the count doing its job, so it gets moved
      // rather than ignored; otherwise it would sit wrongly recorded until a count of
      // its supposed location swept it as missing.
      const elsewhereConds: SQL[] = [
        eq(inventoryItems.companyId, ctx.companyId),
        eq(inventoryItems.storeId, cc.storeId),
        eq(inventoryItems.status, 'ON_HAND'),
      ];
      if (cc.locationId != null)
        elsewhereConds.push(ne(inventoryItems.locationId, cc.locationId));
      const elsewhere =
        cc.locationId == null && scopeProducts.length === 0
          ? [] // whole store, every product: nothing is "elsewhere"
          : await tx
              .select({
                id: inventoryItems.id,
                serial: inventoryItems.serial,
                productId: inventoryItems.productId,
                locationId: inventoryItems.locationId,
              })
              .from(inventoryItems)
              .where(and(...elsewhereConds));

      const pendingUnits = await tx
        .select({
          id: inventoryItems.id,
          serial: inventoryItems.serial,
          productId: inventoryItems.productId,
        })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.companyId, ctx.companyId),
            eq(inventoryItems.storeId, cc.storeId),
            eq(inventoryItems.status, 'PENDING'),
          ),
        );

      const soldUnits = await tx
        .select({
          id: inventoryItems.id,
          serial: inventoryItems.serial,
          productId: inventoryItems.productId,
        })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.companyId, ctx.companyId),
            eq(inventoryItems.storeId, cc.storeId),
            eq(inventoryItems.status, 'SOLD'),
          ),
        );

      const byInScope = new Map(inScopeUnits.map((u) => [u.serial, u]));
      const byElsewhere = new Map(elsewhere.map((u) => [u.serial, u]));
      const byPending = new Map(pendingUnits.map((u) => [u.serial, u]));
      const bySold = new Map(soldUnits.map((u) => [u.serial, u]));

      const lines: ProposedLine[] = [];
      const accountedInScope = new Set<string>();
      const receivedPending = new Set<string>();
      const handledSerials = new Set<string>();

      const proposeUnknownSerial = (serial: string) => {
        lines.push({
          productId: null,
          itemId: null,
          serial,
          quantity: null,
          resolution: 'NEW_ITEM',
          locationId: contextLocationId,
          locationFromId: null,
          importCheckRequested: wantImportCheck.has(serial),
        });
      };

      for (const serial of scannedSerials) {
        if (handledSerials.has(serial)) continue;
        handledSerials.add(serial);

        const here = byInScope.get(serial);
        if (here) {
          accountedInScope.add(here.id);
          lines.push({
            productId: here.productId,
            itemId: here.id,
            serial,
            quantity: null,
            resolution: 'SCANNED',
            locationId: here.locationId,
            locationFromId: null,
            importCheckRequested: false,
          });
          continue;
        }

        const other = byElsewhere.get(serial);
        if (other) {
          lines.push({
            productId: other.productId,
            itemId: other.id,
            serial,
            quantity: null,
            resolution: 'MOVED_IN',
            locationId: contextLocationId,
            locationFromId: other.locationId,
            importCheckRequested: false,
          });
          continue;
        }

        const pend = byPending.get(serial);
        if (pend) {
          receivedPending.add(pend.id);
          lines.push({
            productId: pend.productId,
            itemId: pend.id,
            serial,
            quantity: null,
            resolution: 'RECEIVED',
            locationId: contextLocationId,
            locationFromId: null,
            importCheckRequested: false,
          });
          continue;
        }

        const sold = bySold.get(serial);
        if (sold) {
          // Only on an explicit decision. A sold unit reappearing could be a return,
          // a mis-scan or a duplicated barcode, so the person holding it decides; an
          // unconfirmed scan of a sold serial is ignored rather than guessed at.
          if (reinstate.has(serial)) {
            lines.push({
              productId: sold.productId,
              itemId: sold.id,
              serial,
              quantity: null,
              resolution: 'REINSTATED',
              locationId: contextLocationId,
              locationFromId: null,
              importCheckRequested: false,
            });
          }
          continue;
        }

        proposeUnknownSerial(serial);
      }

      // Explicit new items. A serial one is the same unknown-serial proposal; name
      // and expiration are ignored, because an unidentified unit has no product to
      // name and whoever resolves it supplies those.
      for (const ni of newItems) {
        if (!ni.isUpc) {
          if (handledSerials.has(ni.serialOrUpc)) continue;
          handledSerials.add(ni.serialOrUpc);
          if (
            byInScope.has(ni.serialOrUpc) ||
            byElsewhere.has(ni.serialOrUpc) ||
            byPending.has(ni.serialOrUpc) ||
            bySold.has(ni.serialOrUpc)
          ) {
            continue; // it exists; the scanned-serial pass owns it
          }
          proposeUnknownSerial(ni.serialOrUpc);
          continue;
        }
        // A UPC identifies a PRODUCT even when its details are unknown, so the
        // catalog row is created now and only the STOCK waits for approval. Creating
        // a needs-review product is not an inventory change; it appears in the review
        // queue either way, and if the count is rejected it is a harmless empty row.
        const product = await this.resolveUpcProduct(tx, ctx, ni);
        lines.push({
          productId: product.id,
          itemId: null,
          serial: null,
          quantity: ni.quantity ?? 0,
          resolution: 'NEW_ITEM',
          locationId: contextLocationId,
          locationFromId: null,
          importCheckRequested: false,
        });
      }

      // Quantity counts: the counted number wins.
      const countedStockKeys = new Set<string>();
      for (const qc of quantityCounts) {
        const product = await this.resolveQuantityProduct(tx, ctx, qc);
        const locationId = qc.locationId ?? contextLocationId;
        countedStockKeys.add(`${product.id}:${locationId}`);
        lines.push({
          productId: product.id,
          itemId: null,
          serial: null,
          quantity: qc.countedQuantity,
          resolution: 'COUNTED_BY_UPC',
          locationId,
          locationFromId: null,
          importCheckRequested: false,
        });
      }

      // Quantity stock IN SCOPE that nobody counted. Same rule as the serialized sweep
      // below, and for the same reason: a product the counter never entered a number for
      // is not evidence that its shelf is empty. Zeroing on that basis is the worse half
      // of the two — a zeroed stock line has no per-unit row to reinstate afterwards.
      const stockConds: SQL[] = [
        eq(inventoryStock.companyId, ctx.companyId),
        eq(inventoryStock.storeId, cc.storeId),
      ];
      if (cc.locationId != null)
        stockConds.push(eq(inventoryStock.locationId, cc.locationId));
      if (scopeProducts.length > 0)
        stockConds.push(inArray(inventoryStock.productId, scopeProducts));
      const inScopeStock = await tx
        .select({
          productId: inventoryStock.productId,
          locationId: inventoryStock.locationId,
          quantityOnHand: inventoryStock.quantityOnHand,
        })
        .from(inventoryStock)
        .where(and(...stockConds));
      // Products that got a quantity this count — the evidence the counter worked them.
      const countedProducts = new Set(quantityCounts.map((qc) => qc.productId));
      for (const s of inScopeStock) {
        if (countedStockKeys.has(`${s.productId}:${s.locationId}`)) continue;
        if (s.quantityOnHand === 0) continue; // nothing to zero
        // Counted this product at another location but not this one -> the shelf really
        // was checked and found empty. Never touched the product at all -> not counted.
        const worked = countedProducts.has(s.productId);
        lines.push({
          productId: s.productId,
          itemId: null,
          serial: null,
          quantity: worked ? 0 : null,
          resolution: worked ? 'COUNTED_BY_UPC' : 'NOT_COUNTED',
          locationId: s.locationId,
          locationFromId: null,
          importCheckRequested: false,
        });
      }

      // Products the counter demonstrably worked: at least one unit of them was
      // physically scanned in this count, by any route — counted in scope, found here
      // while recorded elsewhere, received off a delivery, or put back after being sold.
      const workedProducts = new Set<number>();
      for (const l of lines) {
        if (l.productId == null) continue;
        if (
          l.resolution === 'SCANNED' ||
          l.resolution === 'MOVED_IN' ||
          l.resolution === 'RECEIVED' ||
          l.resolution === 'REINSTATED'
        ) {
          workedProducts.add(l.productId);
        }
      }

      // In-scope serialized units nobody scanned.
      //
      // Whether that means "sold" depends entirely on whether the counter went near the
      // product. If they scanned some units of it, the rest are genuinely unaccounted
      // for and MARKED_SOLD is the honest reading. If they scanned NONE of it, the only
      // thing established is that they did not reach that shelf — and writing off stock
      // on that basis is how a half-finished count destroys inventory. Those are
      // reported as NOT_COUNTED instead, and the review screen offers them to be added.
      for (const u of inScopeUnits) {
        if (accountedInScope.has(u.id)) continue;
        const worked = u.productId != null && workedProducts.has(u.productId);
        lines.push({
          productId: u.productId,
          itemId: u.id,
          serial: u.serial,
          quantity: null,
          resolution: worked ? 'MARKED_SOLD' : 'NOT_COUNTED',
          locationId: u.locationId,
          locationFromId: null,
          importCheckRequested: false,
        });
      }

      // PENDING units nobody scanned stay PENDING. Recorded so the report can say
      // "shipped, not yet received" — never inferred sold, because they were never in
      // the store to sell.
      for (const p of pendingUnits) {
        if (receivedPending.has(p.id)) continue;
        lines.push({
          productId: p.productId,
          itemId: p.id,
          serial: p.serial,
          quantity: null,
          resolution: 'PENDING_NOT_RECEIVED',
          locationId: null,
          locationFromId: null,
          importCheckRequested: false,
        });
      }

      // Replace any earlier proposal set (a rejected count can be resubmitted).
      await tx
        .delete(cycleCountLines)
        .where(
          and(
            eq(cycleCountLines.companyId, ctx.companyId),
            eq(cycleCountLines.cycleCountId, cc.id),
          ),
        );
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
            locationId: l.locationId,
            locationFromId: l.locationFromId,
            importCheckRequested: l.importCheckRequested,
          })),
        );
      }

      const scanned = lines.filter((l) =>
        ['SCANNED', 'MOVED_IN', 'RECEIVED', 'REINSTATED'].includes(l.resolution),
      ).length;
      const [updated] = await tx
        .update(cycleCounts)
        .set({
          status: 'AWAITING_REVIEW',
          submittedAt: new Date(),
          submittedByUserId: ctx.userId,
          // Re-derived here, not left at its open() value. A rejected count reopens
          // and can be resubmitted later, by which time stock may have changed; the
          // sweep is computed live, so a frozen expectedCount would contradict the
          // proposals sitting next to it on the review screen.
          expectedCount: inScopeUnits.length,
          scannedCount: scanned,
          soldGeneratedCount: lines.filter((l) => l.resolution === 'MARKED_SOLD')
            .length,
        })
        .where(eq(cycleCounts.id, cc.id))
        .returning();

      return this.buildResult(tx, ctx, updated);
    });
  }

  /** Deprecated alias — an older scanner build calls close() to hand a count in. */
  async close(ctx: DataContext, id: number, dto: SubmitCycleCountDto) {
    return this.submit(ctx, id, dto);
  }

  // ---- approve (apply the proposals) -------------------------------------

  async approve(ctx: DataContext, id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const cc = await this.loadCount(tx, ctx, id, true);
      if (cc.status === 'CLOSED') return this.buildResult(tx, ctx, cc); // idempotent
      if (cc.status !== 'AWAITING_REVIEW') {
        throw new ConflictException(
          `Only a submitted count can be approved (this one is ${cc.status}).`,
        );
      }

      const pending = await tx
        .select()
        .from(cycleCountLines)
        .where(
          and(
            eq(cycleCountLines.companyId, ctx.companyId),
            eq(cycleCountLines.cycleCountId, cc.id),
            isNull(cycleCountLines.appliedAt),
          ),
        )
        .orderBy(cycleCountLines.id);

      const now = new Date();
      for (const line of pending) {
        await this.applyLine(tx, ctx, cc, line, now);
        await tx
          .update(cycleCountLines)
          .set({ appliedAt: now })
          .where(eq(cycleCountLines.id, line.id));
      }

      const [updated] = await tx
        .update(cycleCounts)
        .set({ status: 'CLOSED', closedAt: now, closedByUserId: ctx.userId })
        .where(eq(cycleCounts.id, cc.id))
        .returning();
      return this.buildResult(tx, ctx, updated);
    });
  }

  // ---- reject (discard the proposals, reopen) ----------------------------

  async reject(ctx: DataContext, id: number, _dto: RejectCycleCountDto) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const cc = await this.loadCount(tx, ctx, id, true);
      if (cc.status === 'OPEN') return this.buildResult(tx, ctx, cc); // idempotent
      if (cc.status !== 'AWAITING_REVIEW') {
        throw new ConflictException(
          `Only a submitted count can be sent back (this one is ${cc.status}).`,
        );
      }
      await tx
        .delete(cycleCountLines)
        .where(
          and(
            eq(cycleCountLines.companyId, ctx.companyId),
            eq(cycleCountLines.cycleCountId, cc.id),
          ),
        );
      const [updated] = await tx
        .update(cycleCounts)
        .set({
          status: 'OPEN',
          submittedAt: null,
          submittedByUserId: null,
          scannedCount: 0,
          soldGeneratedCount: 0,
        })
        .where(eq(cycleCounts.id, cc.id))
        .returning();
      return this.buildResult(tx, ctx, updated);
    });
  }

  /** Applies exactly one proposed line: state change and ledger row, together. */
  private async applyLine(
    tx: Tx,
    ctx: DataContext,
    cc: CycleCount,
    line: typeof cycleCountLines.$inferSelect,
    now: Date,
  ): Promise<void> {
    const base = {
      companyId: ctx.companyId,
      storeId: cc.storeId,
      source: 'CYCLE_COUNT' as const,
      cycleCountId: cc.id,
      performedByUserId: ctx.userId,
    };

    switch (line.resolution) {
      // Present where expected, and shipped-but-absent: nothing to do.
      case 'SCANNED':
      case 'PENDING_NOT_RECEIVED':
        return;

      case 'MOVED_IN': {
        if (!line.itemId || line.locationId == null) return;
        await tx
          .update(inventoryItems)
          .set({ locationId: line.locationId, updatedAt: now })
          .where(eq(inventoryItems.id, line.itemId));
        await tx.insert(inventoryTransactions).values({
          ...base,
          productId: line.productId,
          itemId: line.itemId,
          type: 'MOVE',
          quantityDelta: 0,
          locationFromId: line.locationFromId,
          locationToId: line.locationId,
          note: `Cycle count #${cc.id} — found here, moved`,
        });
        return;
      }

      case 'RECEIVED': {
        if (!line.itemId || line.locationId == null) return;
        // Status and location in one statement: the CHECK constraint forbids a
        // PENDING unit with a location and an ON_HAND unit without one, so receiving
        // cannot be done by halves.
        await tx
          .update(inventoryItems)
          .set({
            status: 'ON_HAND',
            locationId: line.locationId,
            receivedAt: now,
            updatedAt: now,
          })
          .where(eq(inventoryItems.id, line.itemId));
        await tx.insert(inventoryTransactions).values({
          ...base,
          productId: line.productId,
          itemId: line.itemId,
          type: 'RECEIVE',
          quantityDelta: 0, // the RECEIPT at handoff already counted it inbound
          locationToId: line.locationId,
          note: `Cycle count #${cc.id} — received into stock`,
        });
        return;
      }

      case 'REINSTATED': {
        if (!line.itemId || line.locationId == null) return;
        await tx
          .update(inventoryItems)
          .set({ status: 'ON_HAND', locationId: line.locationId, updatedAt: now })
          .where(eq(inventoryItems.id, line.itemId));
        // A compensating entry. The original SALE row is never touched — the ledger is
        // append-only — so the history reads sold, then found, then reinstated.
        await tx.insert(inventoryTransactions).values({
          ...base,
          productId: line.productId,
          itemId: line.itemId,
          type: 'REINSTATE',
          quantityDelta: 1,
          locationToId: line.locationId,
          note: `Cycle count #${cc.id} — found on shelf after being marked sold; reinstated`,
        });
        return;
      }

      case 'MARKED_SOLD': {
        if (!line.itemId) return;
        await tx
          .update(inventoryItems)
          .set({ status: 'SOLD', updatedAt: now })
          .where(eq(inventoryItems.id, line.itemId));
        await tx.insert(inventoryTransactions).values({
          ...base,
          productId: line.productId,
          itemId: line.itemId,
          type: 'SALE',
          quantityDelta: -1,
          locationFromId: line.locationId,
          note: `Cycle count #${cc.id} — not found in count`,
        });
        return;
      }

      // Deliberately a no-op. The unit stays exactly as it was: in stock, where it was,
      // untouched. The line exists so the count can report what it did not reach, not so
      // something can be done about it — nothing was learned about this unit.
      case 'NOT_COUNTED':
        return;

      case 'COUNTED_BY_UPC': {
        if (line.productId == null || line.locationId == null) return;
        const counted = line.quantity ?? 0;
        const current = await this.currentStock(
          tx,
          ctx,
          cc.storeId,
          line.productId,
          line.locationId,
        );
        const delta = counted - current;
        if (delta !== 0) {
          await tx.insert(inventoryTransactions).values({
            ...base,
            productId: line.productId,
            type: delta < 0 ? 'SALE' : 'ADJUSTMENT',
            quantityDelta: delta,
            locationFromId: delta < 0 ? line.locationId : null,
            locationToId: delta > 0 ? line.locationId : null,
            note:
              delta < 0
                ? `Cycle count #${cc.id} — counted ${counted}, was ${current}`
                : `Cycle count #${cc.id} — found in count (counted ${counted}, was ${current})`,
          });
        }
        await this.setStock(
          tx,
          ctx,
          cc.storeId,
          line.productId,
          line.locationId,
          counted,
        );
        return;
      }

      case 'NEW_ITEM': {
        if (line.locationId == null) return;

        // Quantity: the product exists already (created at submit); add the stock.
        if (line.productId != null && line.serial == null) {
          const qty = line.quantity ?? 0;
          if (qty <= 0) return;
          await this.addStock(tx, ctx, cc.storeId, line.productId, line.locationId, qty);
          await tx.insert(inventoryTransactions).values({
            ...base,
            productId: line.productId,
            type: 'RECEIPT',
            quantityDelta: qty,
            locationToId: line.locationId,
            note: `Cycle count #${cc.id} — new stock found in count`,
          });
          return;
        }

        // Serialized and unidentified: a real unit with no catalog row. needs_review
        // is what the CHECK constraint requires for a null product_id, and is also
        // what puts it in the review queue.
        if (!line.serial) return;
        const [existing] = await tx
          .select({ id: inventoryItems.id })
          .from(inventoryItems)
          .where(
            and(
              eq(inventoryItems.companyId, ctx.companyId),
              scanMatches(line.serial),
            ),
          )
          .limit(1);
        if (existing) return; // arrived by another route since submit

        const [item] = await tx
          .insert(inventoryItems)
          .values({
            companyId: ctx.companyId,
            storeId: cc.storeId,
            productId: null,
            locationId: line.locationId,
            serial: line.serial,
            status: 'ON_HAND',
            needsReview: true,
            importCheckStatus: line.importCheckRequested ? 'REQUESTED' : null,
            importCheckRequestedAt: line.importCheckRequested ? now : null,
            receivedAt: now,
          })
          .returning();
        await tx
          .update(cycleCountLines)
          .set({ itemId: item.id })
          .where(eq(cycleCountLines.id, line.id));
        await tx.insert(inventoryTransactions).values({
          ...base,
          productId: null,
          itemId: item.id,
          type: 'RECEIPT',
          quantityDelta: 1,
          locationToId: line.locationId,
          note: `Cycle count #${cc.id} — unidentified serial found in count`,
        });
        return;
      }
    }
  }

  // ---- list / get / cancel ----------------------------------------------

  async list(
    ctx: DataContext,
    query: ListCycleCountsQuery,
  ): Promise<Paginated<CycleCount>> {
    const { limit, offset } = resolvePaging(query);
    const storeId = ctx.role === 'STORE_USER' ? ctx.storeId : (query.storeId ?? null);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const conds: SQL[] = [eq(cycleCounts.companyId, ctx.companyId)];
      if (storeId != null) conds.push(eq(cycleCounts.storeId, storeId));
      if (query.status) conds.push(eq(cycleCounts.status, query.status));
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

  /**
   * How this count would classify one serial, right now.
   *
   * The scanner can answer IN_SCOPE and PENDING from its own snapshot, but not the
   * other two: a unit held at another location is not in the snapshot, and a SOLD
   * unit is deliberately absent from every snapshot (the store's whole sales history
   * would be a pointless download). Both need a decision from the person holding the
   * item — "this was sold, put it back?" — so the scanner asks the server what it is
   * looking at.
   *
   * Deliberately reuses inScope() and the same status order as submit(), so an
   * answer here cannot contradict what submitting will actually do.
   */
  async resolveSerial(ctx: DataContext, id: number, serialRaw: string) {
    // The handheld asks "what is this?" with whatever it read off the label, which may be
    // the 2D composite rather than the serial.
    const serial = normalizeScannedSerial(serialRaw);
    if (!serial) throw new BadRequestException('A serial is required.');

    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const cc = await this.loadCount(tx, ctx, id);
      const scopeProducts = await this.scopeProductIds(tx, ctx, cc.id);

      // Deliberately NOT limit(1). A serial is unique per product, not per company, so a
      // scan can legitimately match two units of different SKUs at the same store.
      const candidates = await tx
        .select({
          id: inventoryItems.id,
          serial: inventoryItems.serial,
          status: inventoryItems.status,
          productId: inventoryItems.productId,
          locationId: inventoryItems.locationId,
          locationName: storeLocations.name,
          sku: products.sku,
          name: products.name,
        })
        .from(inventoryItems)
        .leftJoin(products, eq(products.id, inventoryItems.productId))
        .leftJoin(storeLocations, eq(storeLocations.id, inventoryItems.locationId))
        .where(
          and(
            eq(inventoryItems.companyId, ctx.companyId),
            eq(inventoryItems.storeId, cc.storeId),
            scanMatches(serial),
          ),
        );

      // The count's own scope is the tie-breaker, and usually a decisive one: a count
      // covers specific products, so only one candidate is normally countable here.
      const countable = candidates.filter(
        (c) =>
          c.status === 'ON_HAND' &&
          (cc.locationId == null || c.locationId === cc.locationId) &&
          (scopeProducts.length === 0 ||
            (c.productId != null && scopeProducts.includes(c.productId))),
      );

      // Still more than one and nothing to choose between them. Picking arbitrarily would
      // count the wrong unit and leave the other looking missing, so say so instead.
      const pool = countable.length > 0 ? countable : candidates;
      if (pool.length > 1) {
        const skus = pool.map((c) => c.sku ?? 'unidentified').join(', ');
        throw new ConflictException(
          `Serial '${serial}' matches ${pool.length} units at this store (${skus}). ` +
            `Serials are unique per product, so this one cannot be resolved from the ` +
            `serial alone — scan the full barcode, or count these by product.`,
        );
      }

      const unit = pool[0];

      // Report the unit's OWN serial back, not the scanned string: a full-barcode scan
      // resolves here, and the caller should learn the canonical serial from it.
      const base = { serial: unit?.serial ?? serial, itemId: unit?.id ?? null };
      if (!unit) return { ...base, classification: 'UNKNOWN' as const };

      const shared = {
        ...base,
        productId: unit.productId,
        sku: unit.sku,
        name: unit.name,
        locationId: unit.locationId,
        locationName: unit.locationName,
      };

      if (unit.status === 'PENDING') {
        return { ...shared, classification: 'PENDING' as const };
      }
      if (unit.status === 'SOLD') {
        return { ...shared, classification: 'SOLD' as const };
      }
      if (unit.status !== 'ON_HAND') {
        // RETURNED etc. — a real unit, but not something this count can account for.
        return { ...shared, classification: 'OTHER' as const, status: unit.status };
      }

      const inScopeHere =
        (cc.locationId == null || unit.locationId === cc.locationId) &&
        (scopeProducts.length === 0 ||
          (unit.productId != null && scopeProducts.includes(unit.productId)));

      return {
        ...shared,
        classification: inScopeHere
          ? ('IN_SCOPE' as const)
          : ('ELSEWHERE' as const),
      };
    });
  }

  async cancel(ctx: DataContext, id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const cc = await this.loadCount(tx, ctx, id, true);
      if (cc.status === 'CANCELLED') return { cancelled: true, id, already: true };
      if (cc.status === 'CLOSED') {
        throw new ConflictException('Cannot cancel a closed cycle count.');
      }
      await tx
        .delete(cycleCountLines)
        .where(
          and(
            eq(cycleCountLines.companyId, ctx.companyId),
            eq(cycleCountLines.cycleCountId, cc.id),
          ),
        );
      await tx
        .update(cycleCounts)
        .set({
          status: 'CANCELLED',
          closedAt: new Date(),
          closedByUserId: ctx.userId,
        })
        .where(eq(cycleCounts.id, cc.id));
      return { cancelled: true, id };
    });
  }

  // ---- internals ---------------------------------------------------------

  private async resolveUpcProduct(
    tx: Tx,
    ctx: DataContext,
    ni: NewItemDto,
  ): Promise<Product> {
    const upc = ni.serialOrUpc;
    let [product] = await tx
      .select()
      .from(products)
      .where(and(eq(products.companyId, ctx.companyId), eq(products.upc, upc)))
      .limit(1);
    if (!product) {
      product = await resolveOrCreateProduct(tx, ctx.companyId, {
        sku: `REVIEW-UPC-${upc}`,
        name: ni.name ?? `Unidentified UPC ${upc}`,
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
    return product;
  }

  private async resolveQuantityProduct(
    tx: Tx,
    ctx: DataContext,
    qc: QuantityCountDto,
  ): Promise<Product> {
    let product: Product | undefined;
    if (qc.productId != null) {
      [product] = await tx
        .select()
        .from(products)
        .where(
          and(eq(products.companyId, ctx.companyId), eq(products.id, qc.productId)),
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
      throw new BadRequestException('A quantity count needs a known productId or upc.');
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
      .limit(1);
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
    const [existing] = await tx
      .select({ id: inventoryStock.id })
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.companyId, ctx.companyId),
          eq(inventoryStock.storeId, storeId),
          eq(inventoryStock.productId, productId),
          eq(inventoryStock.locationId, locationId),
        ),
      )
      .limit(1);
    if (existing) {
      await tx
        .update(inventoryStock)
        .set({ quantityOnHand: quantity, updatedAt: new Date() })
        .where(eq(inventoryStock.id, existing.id));
      return;
    }
    await tx.insert(inventoryStock).values({
      companyId: ctx.companyId,
      storeId,
      productId,
      locationId,
      quantityOnHand: quantity,
    });
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

  /** Deterministic result view — used by submit, approve, reject and GET /:id. */
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
        locationId: cycleCountLines.locationId,
        locationFromId: cycleCountLines.locationFromId,
        appliedAt: cycleCountLines.appliedAt,
        importCheckRequested: cycleCountLines.importCheckRequested,
        createdAt: cycleCountLines.createdAt,
        sku: products.sku,
        name: products.name,
        locationName: storeLocations.name,
      })
      .from(cycleCountLines)
      // LEFT joins: an unidentified unit has no product, and a
      // PENDING_NOT_RECEIVED line has no location.
      .leftJoin(products, eq(products.id, cycleCountLines.productId))
      .leftJoin(storeLocations, eq(storeLocations.id, cycleCountLines.locationId))
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
      RECEIVED: [],
      PENDING_NOT_RECEIVED: [],
      REINSTATED: [],
      MOVED_IN: [],
      NOT_COUNTED: [],
    };
    for (const r of rows) byResolution[r.resolution].push(r);

    // What a reviewer must see first: the lines that REMOVE stock. A count is
    // destructive by omission, so these are counted out separately rather than left
    // to be spotted among the routine ones.
    const zeroing = byResolution.COUNTED_BY_UPC.filter(
      (l) => (l.quantity ?? 0) === 0,
    );
    const destructive = {
      inferredSales: byResolution.MARKED_SOLD.length,
      zeroedStockLines: zeroing.length,
    };

    let scopeLocationName: string | null = null;
    if (cc.locationId != null) {
      const [loc] = await tx
        .select({ name: storeLocations.name })
        .from(storeLocations)
        .where(eq(storeLocations.id, cc.locationId))
        .limit(1);
      scopeLocationName = loc?.name ?? null;
    }
    const scopeProducts = await this.scopeProductIds(tx, ctx, cc.id);

    return {
      cycleCount: cc,
      scope: {
        locationId: cc.locationId,
        locationName: scopeLocationName,
        productIds: scopeProducts,
        wholeStore: cc.locationId == null,
      },
      lines: rows,
      linesByResolution: byResolution,
      markedSoldSerials: byResolution.MARKED_SOLD.map((l) => l.serial),
      pendingNotReceived: byResolution.PENDING_NOT_RECEIVED,
      /**
       * Units of products the count never touched. Applied as a no-op, surfaced so a
       * reviewer can see the count's real coverage rather than assuming a clean sweep.
       */
      notCounted: byResolution.NOT_COUNTED,
      destructive,
      /** True while the proposals are waiting on an admin. */
      awaitingReview: cc.status === 'AWAITING_REVIEW',
    };
  }
}
