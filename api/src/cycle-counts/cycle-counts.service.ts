import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, ne, or, sql, SQL } from 'drizzle-orm';
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
  notifications,
  Product,
  products,
  storeLocations,
  stores,
  users,
  userStores,
} from '../db/schema';
import { normalizeScannedSerial, scanMatches } from '../db/scan-match';
import { parseLeadingTwo } from '../db/price-code';
import { resolveScan, summariseCase } from '../db/scan-resolve';
import { DataContext, isStoreScoped } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { Paginated, resolvePaging } from '../common/pagination';
import {
  findCodeConflict,
  resolveOrCreateProduct,
} from '../products/product-catalog';
import { notifyReviewers } from '../notifications/review-notifications';
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
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  /**
   * One lifecycle event for a count. The stock effects of an approval are NOT recorded
   * here — every applied line writes its own inventory_transactions row, and duplicating
   * those as audit events would create two records of the same movement that can disagree.
   * What this adds is the human decision around them: who opened it, who handed it in with
   * what tallies, who approved or sent it back.
   */
  private async recordCountEvent(
    tx: Tx,
    ctx: DataContext,
    cc: { id: number; storeId: number },
    action: 'OPENED' | 'SUBMITTED' | 'CLOSED' | 'CANCELLED' | 'REJECTED',
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      tx,
      ctx.companyId,
      AuditService.user(ctx),
      { entityType: 'CYCLE_COUNT', entityId: cc.id, storeId: cc.storeId },
      action,
      { details },
    );
  }

  private writeStoreId(ctx: DataContext, requested?: number): number {
    if (isStoreScoped(ctx.role)) {
      if (ctx.storeId == null) {
        throw new BadRequestException(
          'Your account is not assigned to a store, so it cannot count one. ' +
            'Ask an administrator to assign you to a store.',
        );
      }
      if (requested !== undefined && requested !== ctx.storeId) {
        throw new BadRequestException('Cannot act on another store.');
      }
      return ctx.storeId;
    }
    // A company admin spans every store, so there is no store to infer from the
    // account and one has to be named. The old message said only "storeId is
    // required", which is true and useless from a handheld: it named a field the
    // person cannot see, on a screen where they HAD picked a store.
    if (requested === undefined) {
      throw new BadRequestException(
        'A company admin has to say which store this is for. Pick a store on the ' +
          'device (or send storeId) and try again.',
      );
    }
    return requested;
  }

  /**
   * The company's store, when it has exactly one. Null otherwise — including for a
   * store-scoped user, whose own store is authoritative and must not be second-guessed.
   */
  private async soleStoreIdFor(ctx: DataContext): Promise<number | undefined> {
    if (isStoreScoped(ctx.role)) return undefined;
    const rows = await this.tenantDb.withCompany(ctx.companyId, (tx) =>
      tx
        .select({ id: stores.id })
        .from(stores)
        .where(eq(stores.companyId, ctx.companyId))
        .limit(2),
    );
    return rows.length === 1 ? rows[0].id : undefined;
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
    if (isStoreScoped(ctx.role) && cc.storeId !== ctx.storeId) {
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

  /**
   * A store's name for a ledger note, falling back to its id.
   *
   * Notes are read by a person months later, so they name the store rather than quoting
   * an id they would then have to go and look up. The row's own store_id column still
   * carries the id, so nothing is lost by leaving it out of the prose.
   */
  private async storeLabel(tx: Tx, storeId: number): Promise<string> {
    const [row] = await tx
      .select({ name: stores.name })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    return row?.name ?? `store #${storeId}`;
  }

  /**
   * What a counter is expected to find: in-scope serialized units, the store's expected
   * arrivals, and quantity stock lines.
   *
   * Shared by open() and resume() deliberately. A resumed count has to describe the shelf
   * the same way a new one does, and computing it twice is how the two drift into
   * disagreeing about what is in scope.
   */
  private async buildSnapshot(
    tx: Tx,
    ctx: DataContext,
    storeId: number,
    locationId: number | null,
    productIds: number[],
  ) {
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
        /**
         * The two fields that let the handheld resolve a leading-2 scan OFFLINE.
         *
         * A `2…` barcode is ambiguous by construction — it may be a genuine catalog
         * UPC or an in-store price sticker — and only catalog data can say which.
         * Carrying both here means a count keeps deciding correctly with no signal,
         * which is the whole reason the snapshot exists.
         *
         * trackingType is what turns a price-sticker hit into the right response:
         * on a quantity product it opens the how-many prompt, on a serialized one it
         * is the wrong barcode and the counter is told to scan the R-serial instead.
         */
        priceEmbeddedCode: products.priceEmbeddedCode,
        trackingType: products.trackingType,
        // Per-unit weight, for a handheld that wants to show it while counting. Carried
        // in the snapshot rather than fetched per scan: the count is already offline-first
        // and this is one more fact about a unit it has already downloaded.
        weightLbs: inventoryItems.weightLbs,
      })
      .from(inventoryItems)
      .leftJoin(products, eq(products.id, inventoryItems.productId))
      .where(and(...this.inScope(ctx, storeId, locationId, productIds)))
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
        weightLbs: inventoryItems.weightLbs,
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
    if (locationId != null)
      stockConds.push(eq(inventoryStock.locationId, locationId));
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
        // Same reason as on the units above: a price sticker scanned against a
        // quantity shelf has to resolve without asking the server.
        priceEmbeddedCode: products.priceEmbeddedCode,
        trackingType: products.trackingType,
      })
      .from(inventoryStock)
      .innerJoin(products, eq(products.id, inventoryStock.productId))
      .where(and(...stockConds))
      .orderBy(products.sku);

    return { units, pending, stock };
  }

  /**
   * Pick an OPEN count back up on a handheld, with a freshly computed snapshot.
   *
   * Needed because an admin can send a submitted count back for a redo (see reject()),
   * which reopens it and deletes its proposals. The device that submitted it has marked
   * it finished locally, and any OTHER device never had it at all — so without this the
   * count is reachable only as read-only history, which is exactly the bug: it looked
   * closed on the handheld while the server had it open again.
   *
   * The snapshot is recomputed rather than replayed: stock moves between a submit and a
   * redo, and counting against a stale expectation would manufacture discrepancies.
   */
  async resume(ctx: DataContext, id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const cc = await this.loadCount(tx, ctx, id);
      if (cc.status !== 'OPEN') {
        throw new ConflictException(
          `Only an open count can be resumed (this one is ${cc.status}).`,
        );
      }

      const productIds = await this.scopeProductIds(tx, ctx, cc.id);
      let locationName: string | null = null;
      if (cc.locationId != null) {
        const [loc] = await tx
          .select({ name: storeLocations.name })
          .from(storeLocations)
          .where(eq(storeLocations.id, cc.locationId))
          .limit(1);
        locationName = loc?.name ?? null;
      }

      const snapshot = await this.buildSnapshot(
        tx,
        ctx,
        cc.storeId,
        cc.locationId,
        productIds,
      );

      // Keep expectedCount honest: the shelf may hold a different number now than when
      // the count was first opened.
      const [updated] = await tx
        .update(cycleCounts)
        .set({ expectedCount: snapshot.units.length })
        .where(eq(cycleCounts.id, cc.id))
        .returning();

      return {
        id: cc.id,
        cycleCount: updated,
        scope: {
          locationId: cc.locationId,
          locationName,
          productIds,
          wholeStore: cc.locationId == null,
        },
        snapshot,
      };
    });
  }

  async open(ctx: DataContext, dto: OpenCycleCountDto) {
    // A company admin normally must name the store. When the company HAS only one,
    // there is nothing to disambiguate and demanding it is pure friction — an older
    // scanner build, or one whose store was never picked, would be refused for a
    // question with a single possible answer.
    const only = dto.storeId ?? (await this.soleStoreIdFor(ctx));
    const storeId = this.writeStoreId(ctx, only);
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

      const { units, pending, stock } = await this.buildSnapshot(
        tx,
        ctx,
        storeId,
        dto.locationId ?? null,
        productIds,
      );

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

      await this.recordCountEvent(tx, ctx, cc, 'OPENED', {
        locationId: dto.locationId ?? null,
        locationName: location?.name ?? null,
        // A whole-store count and a one-aisle count are different jobs; the scope is the
        // first thing a reader wants to know about a count that turned up a surprise.
        wholeStore: location == null,
        productIds,
        expectedUnits: units.length,
      });

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

  /**
   * Turn any scanned CASE serials in a list into the serials of the pieces inside.
   *
   * Scanning the box has to mean scanning everything in it, and the honest way to get that
   * is to expand at the door: every branch below already knows how to receive a PENDING
   * unit, count an ON_HAND one, or offer a SOLD one for reinstatement, and each does it
   * per unit. Expanding here means a case scan inherits all of that behaviour — including
   * idempotency, since a piece already counted is already in the scanned set and dedupes
   * away — instead of a second implementation of the same rules that could disagree.
   *
   * A value that some unit owns as its own serial is left completely alone: units win over
   * cases (see resolveScan), so a piece scan can never fan out to its siblings.
   *
   * Store-scoped on purpose. Two stores can hold pieces of one original case, and sweeping
   * another store's pieces into this count would receive stock nobody was holding.
   */
  private async expandCaseScans(
    tx: Tx,
    ctx: DataContext,
    storeId: number,
    values: string[],
  ): Promise<{
    serials: string[];
    cases: Array<{ caseSerial: string; pieceSerials: string[] }>;
  }> {
    if (values.length === 0) return { serials: values, cases: [] };

    // Anything a unit owns is not a case reference, whichever column it matched.
    const owned = await tx
      .select({ serial: inventoryItems.serial, barcode: inventoryItems.barcode })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.companyId, ctx.companyId),
          or(
            inArray(inventoryItems.serial, values),
            inArray(inventoryItems.barcode, values),
          ),
        ),
      );
    const ownedValues = new Set<string>();
    for (const o of owned) {
      ownedValues.add(o.serial);
      if (o.barcode) ownedValues.add(o.barcode);
    }

    const maybeCases = values.filter((v) => !ownedValues.has(v));
    if (maybeCases.length === 0) return { serials: values, cases: [] };

    const pieces = await tx
      .select({
        caseSerial: inventoryItems.caseSerial,
        serial: inventoryItems.serial,
      })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.companyId, ctx.companyId),
          eq(inventoryItems.storeId, storeId),
          inArray(inventoryItems.caseSerial, maybeCases),
        ),
      );
    if (pieces.length === 0) return { serials: values, cases: [] };

    const byCase = new Map<string, string[]>();
    for (const p of pieces) {
      const key = p.caseSerial!;
      const list = byCase.get(key) ?? [];
      list.push(p.serial);
      byCase.set(key, list);
    }

    // The case serial itself drops out of the list: it names no unit, and leaving it in
    // would land in the unknown-serial path and raise a phantom review item for a box.
    const expanded = new Set(values.filter((v) => !byCase.has(v)));
    for (const list of byCase.values()) for (const serial of list) expanded.add(serial);

    return {
      serials: [...expanded],
      cases: [...byCase.entries()].map(([caseSerial, pieceSerials]) => ({
        caseSerial,
        pieceSerials,
      })),
    };
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
      // "I checked that shelf and it is empty." Normalised like every other serial list so
      // a 2D label payload lands on the same key the snapshot uses.
      const declaredGone = new Set(
        (dto.markSoldSerials ?? []).map(normalizeScannedSerial),
      );
      // A case serial in any of these lists means "all the pieces in that box". Expanded
      // before anything looks at them, so the rest of submit only ever sees unit serials.
      // importCheckSerials is deliberately NOT expanded: a case serial that resolves to
      // pieces is already known, and one that does not is exactly what the import check is
      // for — the agent answers it with the case's contents (MATCHED_CASE).
      const scannedExpansion = await this.expandCaseScans(
        tx,
        ctx,
        cc.storeId,
        scannedSerials,
      );
      const scannedSerialsExpanded = scannedExpansion.serials;
      const reinstateExpansion = await this.expandCaseScans(tx, ctx, cc.storeId, [
        ...reinstate,
      ]);
      const reinstateExpanded = new Set(reinstateExpansion.serials);
      const declaredGoneExpansion = await this.expandCaseScans(tx, ctx, cc.storeId, [
        ...declaredGone,
      ]);
      const declaredGoneExpanded = new Set(declaredGoneExpansion.serials);

      const quantityCounts = dto.quantityCounts ?? [];
      // A new item's value is a serial only when isUpc is false; a UPC must not be
      // touched. (The 2D pattern could not match one anyway, but saying so is cheaper
      // than making the next reader prove it.)
      const newItems = (dto.newItems ?? []).map((ni) => normalizeNewItem(ni));

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

      // Units the company owns at a DIFFERENT store. Almost always a delivery routed to
      // one store and physically dropped at another: the handoff said Downtown, the truck
      // went to Test. Without this the serial is invisible here and the scan is silently
      // discarded — the counter believes they received it and nothing anywhere changes.
      // Scanning it IS the evidence of where the unit is, so it comes to this store.
      //
      // Only PENDING and ON_HAND travel. A SOLD unit at another store is that store's
      // sale to reverse, and dragging it here would move the correction to the wrong
      // books.
      const otherStoreUnits = await tx
        .select({
          id: inventoryItems.id,
          serial: inventoryItems.serial,
          productId: inventoryItems.productId,
          storeId: inventoryItems.storeId,
          locationId: inventoryItems.locationId,
          status: inventoryItems.status,
        })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.companyId, ctx.companyId),
            ne(inventoryItems.storeId, cc.storeId),
            inArray(inventoryItems.status, ['PENDING', 'ON_HAND']),
          ),
        );

      const byInScope = new Map(inScopeUnits.map((u) => [u.serial, u]));
      const byElsewhere = new Map(elsewhere.map((u) => [u.serial, u]));
      const byPending = new Map(pendingUnits.map((u) => [u.serial, u]));
      const bySold = new Map(soldUnits.map((u) => [u.serial, u]));
      const byOtherStore = new Map(otherStoreUnits.map((u) => [u.serial, u]));

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

      for (const serial of scannedSerialsExpanded) {
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

        // Belongs to another store. Checked after this store's own buckets, so a serial
        // that exists here is never dragged away from where it already is.
        const away = byOtherStore.get(serial);
        if (away) {
          lines.push({
            productId: away.productId,
            itemId: away.id,
            serial,
            quantity: null,
            resolution: 'TRANSFERRED_IN',
            locationId: contextLocationId,
            // No location to move FROM: the unit is changing store, and its old store's
            // location means nothing here. The old store is recorded in the ledger row.
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
          if (reinstateExpanded.has(serial)) {
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
        if (ni.trackingType === 'SERIALIZED') {
          const serial = ni.serial!;
          if (handledSerials.has(serial)) continue;
          handledSerials.add(serial);

          const alreadyKnown =
            byInScope.has(serial) ||
            byElsewhere.has(serial) ||
            byPending.has(serial) ||
            bySold.has(serial);

          // The unit exists. Nothing is created — the scanned-serial pass counts it by
          // the ordinary rules (received if pending, reinstate prompt if sold). The one
          // thing worth keeping from this submission is the MAPPING: the sticker that
          // opened the flow now belongs to this unit's product, so the next scan of it
          // redirects instead of asking again.
          if (alreadyKnown) {
            if (ni.captured) {
              const [owner] = await tx
                .select()
                .from(products)
                .innerJoin(
                  inventoryItems,
                  eq(inventoryItems.productId, products.id),
                )
                .where(
                  and(
                    eq(inventoryItems.companyId, ctx.companyId),
                    eq(inventoryItems.serial, serial),
                  ),
                )
                .limit(1)
                .then((rows) => rows.map((r) => r.products));
              if (owner) await this.linkCapturedCode(tx, ctx, owner, ni.captured);
            }
            continue; // it exists; the scanned-serial pass owns it
          }

          // Unnamed: the long-standing "found a serial nobody can identify" case. Stays
          // product-less on purpose — a placeholder product per anonymous serial would
          // pollute the catalog, and the import agent is what resolves these.
          if (!ni.name) {
            proposeUnknownSerial(serial);
            continue;
          }

          // NAMED by the counter. A catalog row is created now — a needs-review product
          // is not an inventory change — and the UNIT is proposed against it, created
          // only if the count is approved. Works with or without a captured code: an
          // R-label carries no barcode, and the name alone is worth recording.
          const { product } = await this.resolveNewItemProduct(tx, ctx, ni);
          lines.push({
            productId: product.id,
            itemId: null,
            serial,
            quantity: 1,
            resolution: 'NEW_ITEM',
            locationId: contextLocationId,
            locationFromId: null,
            importCheckRequested: false,
          });
          continue;
        }

        // QUANTITY. The code identifies a PRODUCT even when its details are unknown, so
        // the catalog row is created now and only the STOCK waits for approval. Creating
        // a needs-review product is not an inventory change; it appears in the review
        // queue either way, and if the count is rejected it is a harmless empty row.
        const { product } = await this.resolveNewItemProduct(tx, ctx, ni);
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
        // The counter said this one is gone. Reached only for units nobody scanned — the
        // guard above means a scan always wins over a declaration, which is the right
        // precedence: one is evidence, the other is a recollection.
        //
        // Out-of-scope serials never appear in this loop, so a handheld that offered a
        // unit from another location cannot write it off here. That is deliberate: the
        // request fails safe rather than reaching past the count's own scope.
        const gone = u.serial != null && declaredGoneExpanded.has(u.serial);
        lines.push({
          productId: u.productId,
          itemId: u.id,
          serial: u.serial,
          quantity: null,
          resolution: worked || gone ? 'MARKED_SOLD' : 'NOT_COUNTED',
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

      // The two numbers every review screen leads with, derived the way the handheld
      // derives its own so the counter is not shown one figure at the shelf and a
      // different one after handing in.
      //
      // "Placed" units are the ones this count puts in the store that the opening
      // snapshot could not know about: created here (NEW_ITEM), received off a delivery,
      // moved in from another location or another store, or put back after the system had
      // sold them. Each is a unit that ends up here, and each was scanned to say so, so
      // each counts toward BOTH numbers. Counting them in both is also what keeps
      // scanned <= expected: a SCANNED line can only ever be an in-scope unit.
      //
      // A UPC new item is a QUANTITY, not a unit — entering 5 means five things are on
      // that shelf, so it contributes 5. A serialized new item is exactly one thing. An
      // explicit 0 contributes nothing, because that is what it says.
      const PLACED_RESOLUTIONS = ['RECEIVED', 'MOVED_IN', 'TRANSFERRED_IN', 'REINSTATED'];
      const newItemUnits = lines
        .filter((l) => l.resolution === 'NEW_ITEM')
        .reduce(
          (n, l) => n + (l.serial != null ? 1 : Math.max(0, l.quantity ?? 1)),
          0,
        );
      const placedUnits =
        newItemUnits +
        lines.filter((l) => PLACED_RESOLUTIONS.includes(l.resolution)).length;
      const scannedInScope = lines.filter((l) => l.resolution === 'SCANNED').length;

      // Quantity shelves are units too. The books say a shelf holds N; the counter says
      // it holds M. N is expected, M is accounted for — including the shelves nobody
      // counted, whose N is still expected and is exactly what the sweep would zero.
      //
      // This is the one place scanned CAN exceed expected: finding twenty where fifteen
      // were recorded is a real outcome, and a tally that hid it would be the wrong kind
      // of tidy. The handheld's progress bar clamps for that reason.
      const recordedStockUnits = inScopeStock.reduce((n, s) => n + s.quantityOnHand, 0);
      const countedStockUnits = lines
        .filter((l) => l.resolution === 'COUNTED_BY_UPC')
        .reduce((n, l) => n + Math.max(0, l.quantity ?? 0), 0);

      const scanned = scannedInScope + placedUnits + countedStockUnits;
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
          expectedCount: inScopeUnits.length + placedUnits + recordedStockUnits,
          scannedCount: scanned,
          soldGeneratedCount: lines.filter((l) => l.resolution === 'MARKED_SOLD')
            .length,
        })
        .where(eq(cycleCounts.id, cc.id))
        .returning();

      await this.recordCountEvent(tx, ctx, cc, 'SUBMITTED', {
        expectedCount: updated.expectedCount,
        scannedCount: updated.scannedCount,
        // The proposal mix is the shape of the count: a hand-in that is mostly MARKED_SOLD
        // reads very differently from one that is mostly SCANNED, and this is the record of
        // what was proposed even if a reviewer later rejects all of it.
        proposals: lines.reduce<Record<string, number>>((acc, l) => {
          acc[l.resolution] = (acc[l.resolution] ?? 0) + 1;
          return acc;
        }, {}),
        lineCount: lines.length,
      });

      // Somebody has to look at this now. Nothing else tells them: the count was handed
      // in from a scanner on the floor, and the reviewer may not open the web app for
      // days — which is how a count sits in AWAITING_REVIEW while the stock it describes
      // keeps moving underneath it.
      await notifyReviewers(tx, {
        companyId: ctx.companyId,
        storeId: cc.storeId,
        type: 'CYCLE_COUNT_REVIEW',
        excludeUserId: ctx.userId,
        payload: {
        cycleCountId: cc.id,
        expectedCount: updated.expectedCount,
        scannedCount: updated.scannedCount,
        lineCount: lines.length,
          submittedByUserId: ctx.userId,
        },
      });

      const result = await this.buildResult(tx, ctx, updated);
      // What each scanned case turned into, so a handheld can say "Case 108963047415 —
      // 10 pieces" rather than reporting ten scans the counter never made. Absent when no
      // case was scanned, which keeps the response identical for every existing client.
      const caseScans = scannedExpansion.cases.map((c) => ({
        caseSerial: c.caseSerial,
        pieceCount: c.pieceSerials.length,
        pieceSerials: c.pieceSerials,
        resolutions: lines
          .filter((l) => l.serial != null && c.pieceSerials.includes(l.serial))
          .reduce<Record<string, number>>((acc, l) => {
            acc[l.resolution] = (acc[l.resolution] ?? 0) + 1;
            return acc;
          }, {}),
      }));
      return caseScans.length > 0 ? { ...result, caseScans } : result;
    });
  }

  /** Deprecated alias — an older scanner build calls close() to hand a count in. */
  async close(ctx: DataContext, id: number, dto: SubmitCycleCountDto) {
    return this.submit(ctx, id, dto);
  }

  // ---- review notifications ----------------------------------------------

  /**
   * How big the Needs Review queue is right now, for one store.
   *
   * Items are per-store; a placeholder product is company-wide, because a SKU is not
   * something a single store owns.
   */
  private async countNeedsReview(
    tx: Tx,
    ctx: DataContext,
    storeId: number,
  ): Promise<{ items: number; products: number }> {
    const [items] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.companyId, ctx.companyId),
          eq(inventoryItems.storeId, storeId),
          eq(inventoryItems.needsReview, true),
        ),
      );
    const [prods] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(products)
      .where(
        and(eq(products.companyId, ctx.companyId), eq(products.needsReview, true)),
      );
    return { items: Number(items.n), products: Number(prods.n) };
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

      // Approving is what turns an unknown serial or UPC into a real row flagged for
      // review, so the size of that queue before and after this loop is exactly what
      // this approval added. Counted rather than collected: applyLine has a dozen
      // branches and threading a return value through all of them to learn a number
      // would be the more fragile way to get it.
      const reviewBefore = await this.countNeedsReview(tx, ctx, cc.storeId);

      const now = new Date();
      for (const line of pending) {
        await this.applyLine(tx, ctx, cc, line, now);
        await tx
          .update(cycleCountLines)
          .set({ appliedAt: now })
          .where(eq(cycleCountLines.id, line.id));
      }

      const reviewAfter = await this.countNeedsReview(tx, ctx, cc.storeId);
      const newItems = reviewAfter.items - reviewBefore.items;
      const newProducts = reviewAfter.products - reviewBefore.products;
      if (newItems > 0 || newProducts > 0) {
        await notifyReviewers(tx, {
          companyId: ctx.companyId,
          storeId: cc.storeId,
          type: 'ITEMS_NEED_REVIEW',
          excludeUserId: ctx.userId,
          payload: {
            cycleCountId: cc.id,
            itemCount: newItems,
            productCount: newProducts,
          },
        });
      }

      const [updated] = await tx
        .update(cycleCounts)
        .set({ status: 'CLOSED', closedAt: now, closedByUserId: ctx.userId })
        .where(eq(cycleCounts.id, cc.id))
        .returning();
      await this.recordCountEvent(tx, ctx, cc, 'CLOSED', {
        appliedLines: pending.length,
        expectedCount: updated.expectedCount,
        scannedCount: updated.scannedCount,
        submittedByUserId: cc.submittedByUserId,
      });
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
      // Recorded with the tallies as they STOOD, because the update above zeroes them: the
      // point of a rejection event is what was rejected, which the row no longer says.
      await this.recordCountEvent(tx, ctx, cc, 'REJECTED', {
        discardedLines: cc.scannedCount,
        expectedCount: cc.expectedCount,
        scannedCount: cc.scannedCount,
        submittedByUserId: cc.submittedByUserId,
      });
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

      // Scanned here, recorded at another store. The scan is the evidence, so the unit
      // moves — and it lands ON_HAND whether it was PENDING (an arrival delivered to the
      // wrong store, received here instead) or ON_HAND (physically relocated).
      case 'TRANSFERRED_IN': {
        if (!line.itemId || line.locationId == null) return;

        // Read the old store before overwriting it: the ledger needs to show the stock
        // leaving somewhere, and after the update that information is gone.
        const [before] = await tx
          .select({
            storeId: inventoryItems.storeId,
            locationId: inventoryItems.locationId,
            status: inventoryItems.status,
          })
          .from(inventoryItems)
          .where(eq(inventoryItems.id, line.itemId))
          .limit(1);
        if (!before) return;
        // Already moved by another route between submit and approval.
        if (before.storeId === cc.storeId) return;

        // Names for the notes. A ledger row is read by a person months later, and
        // "transferred out to store 3" makes them go and look up what store 3 is.
        const [fromStore, toStore] = await Promise.all([
          this.storeLabel(tx, before.storeId),
          this.storeLabel(tx, cc.storeId),
        ]);

        await tx
          .update(inventoryItems)
          .set({
            storeId: cc.storeId,
            locationId: line.locationId,
            status: 'ON_HAND',
            receivedAt: before.status === 'PENDING' ? now : undefined,
            updatedAt: now,
          })
          .where(eq(inventoryItems.id, line.itemId));

        // Two rows, one per store's books. A single row would leave the losing store's
        // history showing stock that silently evaporated.
        //
        // -1 / +1, NOT the 0 an intra-store MOVE uses. quantity_delta is the change in
        // units on hand for the store on that row: a shelf-to-shelf move changes nothing
        // (hence 0), but a transfer genuinely leaves one store and joins another. With 0
        // on both, summing a store's ledger put this unit at the store it left.
        await tx.insert(inventoryTransactions).values({
          ...base,
          storeId: before.storeId,
          productId: line.productId,
          itemId: line.itemId,
          type: 'MOVE',
          quantityDelta: -1,
          locationFromId: before.locationId,
          locationToId: null,
          note:
            `Cycle count #${cc.id} — scanned at ${toStore}; ` +
            `transferred out of ${fromStore} to ${toStore}`,
        });
        await tx.insert(inventoryTransactions).values({
          ...base,
          productId: line.productId,
          itemId: line.itemId,
          type: before.status === 'PENDING' ? 'RECEIVE' : 'MOVE',
          // +1 even for a PENDING arrival. The handoff RECEIPT counted +1 on the store it
          // was ROUTED to, and the -1 above takes it back off there, so this is the only
          // row that puts the unit on this store's books.
          quantityDelta: 1,
          locationFromId: null,
          locationToId: line.locationId,
          note:
            before.status === 'PENDING'
              ? `Cycle count #${cc.id} — arrival routed to ${fromStore}, received at ${toStore} instead`
              : `Cycle count #${cc.id} — transferred in to ${toStore} from ${fromStore}`,
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
          .set({
            status: 'ON_HAND',
            locationId: line.locationId,
            // Cleared: the unit is on the shelf again, so a sold date would misreport it
            // in any sold listing. The SALE row stays in the ledger as history.
            soldAt: null,
            updatedAt: now,
          })
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
          // Sold date is the approval, not the count: that is when the sale was accepted
          // as fact, and it is also when the SALE ledger row is written.
          .set({ status: 'SOLD', soldAt: now, updatedAt: now })
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
    const storeId = isStoreScoped(ctx.role) ? ctx.storeId : (query.storeId ?? null);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const conds: SQL[] = [eq(cycleCounts.companyId, ctx.companyId)];
      if (storeId != null) conds.push(eq(cycleCounts.storeId, storeId));
      if (query.status) conds.push(eq(cycleCounts.status, query.status));
      // Free text over the things a count is identified by out loud: its number, the
      // store, and whoever opened or handed it in. EXISTS rather than joins so the
      // row shape — and the count query beside it — stay exactly as they were.
      const term = query.search?.trim();
      if (term) {
        const like = `%${term}%`;
        const parts: SQL[] = [
          sql`EXISTS (SELECT 1 FROM stores s
                      WHERE s.id = ${cycleCounts.storeId} AND s.name ILIKE ${like})`,
          sql`EXISTS (SELECT 1 FROM users u
                      WHERE u.id IN (${cycleCounts.openedByUserId},
                                     ${cycleCounts.submittedByUserId},
                                     ${cycleCounts.closedByUserId})
                        AND u.username ILIKE ${like})`,
        ];
        // "42" should find count 42, but only when the whole term is the number —
        // otherwise every count matches a search for "4".
        if (/^\d+$/.test(term)) parts.push(eq(cycleCounts.id, Number(term)));
        conds.push(or(...parts) as SQL);
      }
      const where = and(...conds);

      // Whitelisted column, never the raw string: this reaches an ORDER BY. Newest-first
      // by id stays the default, and is also the tie-break for every other column so a
      // page boundary cannot show the same row twice or skip one.
      const sortable = {
        id: cycleCounts.id,
        status: cycleCounts.status,
        openedAt: cycleCounts.openedAt,
        expectedCount: cycleCounts.expectedCount,
        scannedCount: cycleCounts.scannedCount,
        soldGeneratedCount: cycleCounts.soldGeneratedCount,
      } as const;
      const column = sortable[query.sortBy ?? 'id'];
      const direction = query.sortDir === 'asc' ? asc : desc;
      const orderBy =
        query.sortBy && query.sortBy !== 'id'
          ? [direction(column), desc(cycleCounts.id)]
          : [direction(cycleCounts.id)];

      const data = await tx
        .select()
        .from(cycleCounts)
        .where(where)
        .orderBy(...orderBy)
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
  /**
   * "What is this?" — for any code a handheld's own snapshot cannot explain.
   *
   * Named for serials because that is what it started with, but a scanned code is not
   * always a unit: it can be a PRODUCT's barcode. A quantity product stocked in another
   * location has no unit rows and no stock row here, so it matched nothing and the handheld
   * offered to create it as a new product — a duplicate of a product the company already
   * had. The catalog fallback below is the answer to that scan.
   */
  async resolveSerial(ctx: DataContext, id: number, serialRaw: string) {
    // The handheld asks "what is this?" with whatever it read off the label, which may be
    // the 2D composite rather than the serial.
    const serial = normalizeScannedSerial(serialRaw);
    if (!serial) throw new BadRequestException('A serial is required.');

    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const cc = await this.loadCount(tx, ctx, id);
      const scopeProducts = await this.scopeProductIds(tx, ctx, cc.id);
      // Where a quantity count from this count lands, mirroring submit exactly: the
      // counted location, or the Backroom for a whole-store count.
      const contextLocationId =
        cc.locationId ??
        (await systemLocationId(tx, ctx.companyId, cc.storeId, 'BACKROOM'));

      // Before anything else: does this string name units, or a CASE of them? The shared
      // resolver answers that in one place so a count and a lookup cannot disagree about
      // what a scan means. A case hit is reported as its own classification rather than
      // resolved to one piece — acting on the box means acting on all of it, which is
      // submit's job, not a lookup's.
      const scan = await resolveScan(tx, ctx.companyId, serial, { storeId: cc.storeId });
      if (scan.kind === 'CASE') {
        return {
          serial,
          itemId: null,
          caseSerial: scan.caseSerial,
          pieceCount: scan.candidates.length,
          pieces: scan.candidates.map((c) => ({
            itemId: c.id,
            serial: c.serial,
            status: c.status,
            sku: c.sku,
            name: c.name,
            locationId: c.locationId,
            locationName: c.locationName,
          })),
          byStatus: summariseCase(scan.candidates),
          classification: 'CASE' as const,
        };
      }

      // Deliberately NOT limit(1). A serial is unique per product, not per company, so a
      // scan can legitimately match two units of different SKUs at the same store.
      //
      // Company-wide, not store-scoped: a unit recorded at ANOTHER store is exactly the
      // case worth answering — a delivery routed to one store and dropped at another.
      // Store-scoped, the serial looked unknown and the counter was sent down the
      // new-product path for a unit the company already owned.
      const allCandidates = await tx
        .select({
          id: inventoryItems.id,
          serial: inventoryItems.serial,
          status: inventoryItems.status,
          productId: inventoryItems.productId,
          storeId: inventoryItems.storeId,
          locationId: inventoryItems.locationId,
          locationName: storeLocations.name,
          storeName: stores.name,
          sku: products.sku,
          name: products.name,
        })
        .from(inventoryItems)
        .leftJoin(products, eq(products.id, inventoryItems.productId))
        .leftJoin(storeLocations, eq(storeLocations.id, inventoryItems.locationId))
        .leftJoin(stores, eq(stores.id, inventoryItems.storeId))
        .where(
          and(eq(inventoryItems.companyId, ctx.companyId), scanMatches(serial)),
        );

      // This store's own units win outright. Only when the serial is nowhere here do the
      // other stores' units get considered, so nothing is ever dragged away from the
      // store that already holds it.
      const here = allCandidates.filter((c) => c.storeId === cc.storeId);
      const candidates = here.length > 0 ? here : allCandidates;

      // Recorded at another store, and this count is where it actually turned up. Report
      // it as ELSEWHERE — the same answer as "found at another location", because it is
      // the same idea one level up, and submit does the moving either way. Reusing the
      // existing classification also means a handheld build that predates this still
      // records the scan correctly instead of falling through to the unknown dialog.
      if (here.length === 0 && candidates.length === 1) {
        const away = candidates[0];
        return {
          serial: away.serial,
          itemId: away.id,
          productId: away.productId,
          sku: away.sku,
          name: away.name,
          locationId: away.locationId,
          locationName: away.storeName ?? `store ${away.storeId}`,
          classification: 'ELSEWHERE' as const,
        };
      }

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
      if (!unit) {
        // No unit anywhere in the company matches. The code may still be a product's own
        // barcode — the common case being a quantity shelf stocked somewhere else, which
        // this count can still record a count for: submit resolves a quantityCount by UPC
        // against the whole catalog and files it at the count's location.
        const columns = {
          id: products.id,
          sku: products.sku,
          name: products.name,
          trackingType: products.trackingType,
        };
        let [product] = await tx
          .select(columns)
          .from(products)
          .where(
            and(eq(products.companyId, ctx.companyId), eq(products.upc, serial)),
          )
          .limit(1);

        // How the code was recognised, so the handheld can say the right sentence.
        // "That's the product barcode" and "that's the PRICE label" call for different
        // instructions, and only the server knows which column answered.
        let matchedBy: 'UPC' | 'PRICE_LABEL' = 'UPC';

        // Not a catalog barcode — but a leading-2 code may be an in-store price label,
        // whose only stable part is the 5-digit product code. Tried SECOND, and only on
        // an exact-UPC miss, because the prefix proves nothing: a genuine catalog UPC
        // may also start with 2, and if one does it must win.
        const priceLabel = product ? null : parseLeadingTwo(serial);
        if (priceLabel) {
          [product] = await tx
            .select(columns)
            .from(products)
            .where(
              and(
                eq(products.companyId, ctx.companyId),
                eq(products.priceEmbeddedCode, priceLabel.productCode5),
              ),
            )
            .limit(1);
          if (product) matchedBy = 'PRICE_LABEL';
        }

        if (!product) {
          return {
            ...base,
            classification: 'UNKNOWN' as const,
            // Carried so the new-product flow knows WHICH field to file the scanned
            // code under if this turns into a product: a price label's 5 digits are
            // not a UPC and storing them as one would make the collision guard lie.
            capturedCode: priceLabel
              ? { field: 'price_embedded_code' as const, value: priceLabel.productCode5 }
              : { field: 'upc' as const, value: serial },
          };
        }

        const shared = {
          ...base,
          productId: product.id,
          sku: product.sku,
          name: product.name,
          matchedBy,
        };
        if (product.trackingType !== 'QUANTITY') {
          // A serialized product, identified by one of its codes. NOT a count: units are
          // tracked individually, and neither a product barcode nor a price sticker
          // identifies WHICH one is in the counter's hand. Naming the product and asking
          // for the serial is the only correct answer — and for a price label it is the
          // whole point, since that label must never enter a serialized unit.
          return { ...shared, classification: 'SERIALIZED_PRODUCT' as const };
        }
        // What the books say is on this shelf HERE, which is what the handheld's quantity
        // dialog should open on. Zero when the product is not stocked at this location:
        // counting some anyway is a real outcome, and the count is where that gets said.
        const [stock] = await tx
          .select({ quantityOnHand: inventoryStock.quantityOnHand })
          .from(inventoryStock)
          .where(
            and(
              eq(inventoryStock.companyId, ctx.companyId),
              eq(inventoryStock.storeId, cc.storeId),
              eq(inventoryStock.productId, product.id),
              eq(inventoryStock.locationId, contextLocationId),
            ),
          )
          .limit(1);
        return {
          ...shared,
          classification: 'QUANTITY_PRODUCT' as const,
          locationId: contextLocationId,
          recordedQuantity: stock?.quantityOnHand ?? 0,
        };
      }

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
      await this.recordCountEvent(tx, ctx, cc, 'CANCELLED', {
        // Cancelling from the handheld abandons work: how far it had got is the useful part.
        statusWas: cc.status,
        expectedCount: cc.expectedCount,
        scannedCount: cc.scannedCount,
      });
      return { cancelled: true, id };
    });
  }

  // ---- internals ---------------------------------------------------------

  /**
   * The product a new-item submission refers to, created or found.
   *
   * THE RULE THIS ENFORCES: a scanned barcode names a PRODUCT, never a unit. So a
   * SERIALIZED new item cannot be created from the barcode that opened the flow —
   * the caller must also have scanned that piece's own R-serial. A price sticker in
   * particular must never enter a serialized unit, and this is where that is true
   * rather than merely intended.
   *
   * Returns the product plus whether the captured code was newly linked onto an
   * existing one, so the caller can tell the counter which of the two happened.
   */
  private async resolveNewItemProduct(
    tx: Tx,
    ctx: DataContext,
    ni: NormalizedNewItem,
  ): Promise<{ product: Product; linked: boolean }> {
    const captured = ni.captured;
    const trackingType = ni.trackingType;

    // A named SERIAL with no captured code. An `R…/…` label carries no product barcode,
    // so there is nothing to file in either code column — but the counter DID name it,
    // and that name is worth a catalog row. The product is created under a placeholder
    // sku and completed in Needs Review.
    //
    // Only serials get this. A quantity product with no code could never be found again.
    if (!captured) {
      if (trackingType !== 'SERIALIZED' || !ni.serial) {
        throw new BadRequestException(
          'A new quantity product needs the barcode that was scanned for it.',
        );
      }
      const product = await resolveOrCreateProduct(
        tx,
        ctx.companyId,
        {
          sku: `REVIEW-SER-${ni.serial}`,
          name: ni.name ?? `Unidentified serial ${ni.serial}`,
          price: '0',
          upc: null,
          trackingType: 'SERIALIZED',
          needsReview: true,
        },
        {
          service: this.audit,
          actor: AuditService.user(ctx),
          details: { via: 'cycle count new item', serial: ni.serial },
        },
      );
      return { product, linked: false };
    }

    const value = captured.value;
    const isPriceCode = captured.field === 'price_embedded_code';

    // Already known by whichever code was captured? Then nothing is created — this is
    // the "link" half, and it is also what stops a second scan of the same sticker
    // making a second product.
    const [byCode] = await tx
      .select()
      .from(products)
      .where(
        and(
          eq(products.companyId, ctx.companyId),
          isPriceCode
            ? eq(products.priceEmbeddedCode, value)
            : eq(products.upc, value),
        ),
      )
      .limit(1);
    if (byCode) return { product: byCode, linked: false };

    const codeColumns = isPriceCode
      ? { priceEmbeddedCode: value, upc: null }
      : { upc: value, priceEmbeddedCode: null };

    // Cross-field collision, checked before writing rather than after: a leading-2 UPC
    // and a five-digit price code are two spellings of one key.
    const conflict = await findCodeConflict(tx, ctx.companyId, codeColumns);
    if (conflict) throw new ConflictException(conflict.reason);

    // SKU is NOT NULL, and nobody types one at a shelf. A placeholder in the same
    // shape as the long-standing REVIEW-UPC- convention: distinctive enough to find
    // in the review queue, and stable enough that a resubmitted count is idempotent.
    const sku = isPriceCode
      ? `REVIEW-PLU-${value}`
      : `REVIEW-UPC-${value}`;

    const product = await resolveOrCreateProduct(
      tx,
      ctx.companyId,
      {
        sku,
        name: ni.name ?? `Unidentified ${isPriceCode ? 'price code' : 'UPC'} ${value}`,
        price: '0',
        upc: codeColumns.upc,
        trackingType,
        needsReview: true,
      },
      {
        service: this.audit,
        actor: AuditService.user(ctx),
        details: { via: 'cycle count new item', code: value, field: captured?.field ?? 'upc' },
      },
    );

    // resolveOrCreateProduct predates this column and does not carry it, so the price
    // code is applied straight after — and only to a row we just created, never over
    // whatever an existing product already had.
    if (isPriceCode) {
      await tx
        .update(products)
        .set({ priceEmbeddedCode: value })
        .where(eq(products.id, product.id));
      return { product: { ...product, priceEmbeddedCode: value }, linked: false };
    }

    return { product, linked: false };
  }

  /**
   * Attach a captured code to a product that already exists — the "link" case, which
   * happens when a price sticker turns out to belong to a unit the store already has.
   *
   * Nothing is created and nothing about the unit changes; the product simply learns
   * the code, so the NEXT scan of that sticker redirects instead of asking again.
   * A collision refuses the link and leaves everything as it was: a wrong mapping is
   * worse than no mapping, because it sends future scans to the wrong product.
   */
  private async linkCapturedCode(
    tx: Tx,
    ctx: DataContext,
    product: Product,
    captured: { field: string; value: string },
  ): Promise<boolean> {
    const isPriceCode = captured.field === 'price_embedded_code';
    const current = isPriceCode ? product.priceEmbeddedCode : product.upc;
    if (current === captured.value) return false;
    if (current) {
      throw new ConflictException(
        `${product.name} (${product.sku}) already has a ` +
          `${isPriceCode ? 'price-label code' : 'barcode'} of ${current}. ` +
          `Change it on the product if ${captured.value} is correct.`,
      );
    }

    const next = isPriceCode
      ? { priceEmbeddedCode: captured.value }
      : { upc: captured.value };
    const conflict = await findCodeConflict(tx, ctx.companyId, next, product.id);
    if (conflict) throw new ConflictException(conflict.reason);

    await tx.update(products).set(next).where(eq(products.id, product.id));
    await this.audit.record(
      tx,
      ctx.companyId,
      AuditService.user(ctx),
      { entityType: 'PRODUCT', entityId: product.id },
      'UPDATED',
      {
        field: isPriceCode ? 'price_embedded_code' : 'upc',
        oldValue: null,
        newValue: captured.value,
        details: { via: 'cycle count scan' },
      },
    );
    return true;
  }

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
      product = await resolveOrCreateProduct(
        tx,
        ctx.companyId,
        {
          sku: `REVIEW-UPC-${upc}`,
          name: ni.name ?? `Unidentified UPC ${upc}`,
          price: '0',
          upc,
          trackingType: 'QUANTITY',
          needsReview: true,
        },
        // A placeholder product entering the review queue: the count that scanned the
        // unknown UPC is why it exists, so the approver is the actor and the count is in
        // the details.
        {
          service: this.audit,
          actor: AuditService.user(ctx),
          details: { via: 'cycle count new item', upc },
        },
      );
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

    // What the books say is on each counted shelf, so a quantity line can carry its own
    // shortfall. A reviewer reading "counted 5" has no way to know whether that is the
    // whole shelf or a third of it, and the missing units are the ones being sold.
    const shelfLines = rows.filter(
      (l) => l.resolution === 'COUNTED_BY_UPC' && l.productId != null && l.locationId != null,
    );
    const onHand = new Map<string, number>();
    // Already-APPLIED lines cannot be measured against current stock: approval set the
    // shelf to the counted figure, so "recorded now" IS the count and the shortfall reads
    // as zero. For those the ledger is the record — approval wrote a SALE for exactly the
    // units removed — and reading it back is what keeps a closed count's history honest
    // rather than quietly reporting that nothing left the shelf.
    const applied = new Map<string, number>();
    if (shelfLines.length > 0) {
      const productIds = shelfLines.map((l) => l.productId!);
      const recorded = await tx
        .select({
          productId: inventoryStock.productId,
          locationId: inventoryStock.locationId,
          quantityOnHand: inventoryStock.quantityOnHand,
        })
        .from(inventoryStock)
        .where(
          and(
            eq(inventoryStock.companyId, ctx.companyId),
            eq(inventoryStock.storeId, cc.storeId),
            inArray(inventoryStock.productId, productIds),
          ),
        );
      for (const r of recorded) {
        onHand.set(`${r.productId}:${r.locationId}`, r.quantityOnHand);
      }

      const sales = await tx
        .select({
          productId: inventoryTransactions.productId,
          locationId: inventoryTransactions.locationFromId,
          quantityDelta: inventoryTransactions.quantityDelta,
        })
        .from(inventoryTransactions)
        .where(
          and(
            eq(inventoryTransactions.companyId, ctx.companyId),
            eq(inventoryTransactions.cycleCountId, cc.id),
            eq(inventoryTransactions.type, 'SALE'),
            isNull(inventoryTransactions.itemId),
          ),
        );
      for (const r of sales) {
        const key = `${r.productId}:${r.locationId}`;
        applied.set(key, (applied.get(key) ?? 0) + Math.max(0, -r.quantityDelta));
      }
    }

    const lines = rows.map((l) => {
      if (l.resolution !== 'COUNTED_BY_UPC' || l.productId == null || l.locationId == null) {
        return { ...l, recordedQuantity: null, shortfall: null };
      }
      const counted = l.quantity ?? 0;
      const key = `${l.productId}:${l.locationId}`;
      if (l.appliedAt != null) {
        const sold = applied.get(key) ?? 0;
        return {
          ...l,
          // What the shelf held BEFORE this count changed it.
          recordedQuantity: counted + sold,
          shortfall: sold,
        };
      }
      const was = onHand.get(key) ?? 0;
      return {
        ...l,
        recordedQuantity: was,
        /** Units this count removes from the shelf. Zero when it found at least as many. */
        shortfall: Math.max(0, was - counted),
      };
    });

    const byResolution: Record<CycleCountResolution, typeof lines> = {
      SCANNED: [],
      COUNTED_BY_UPC: [],
      MARKED_SOLD: [],
      NEW_ITEM: [],
      RECEIVED: [],
      PENDING_NOT_RECEIVED: [],
      REINSTATED: [],
      MOVED_IN: [],
      NOT_COUNTED: [],
      TRANSFERRED_IN: [],
    };
    for (const l of lines) byResolution[l.resolution].push(l);

    // What a reviewer must see first: the lines that REMOVE stock. A count is
    // destructive by omission, so these are counted out separately rather than left
    // to be spotted among the routine ones.
    const zeroing = byResolution.COUNTED_BY_UPC.filter(
      (l) => (l.quantity ?? 0) === 0,
    );

    // A shelf counted BELOW its recorded stock is a sale of the difference — applyLine
    // writes a SALE for the negative delta — and it was in neither headline figure. A count
    // of 5 against a recorded 15 is ten units sold, and the screen whose job is to stop a
    // mistake said nothing about them. Summed from the lines themselves, so the total and
    // the rows a reviewer reads cannot disagree.
    const shortfalls = byResolution.COUNTED_BY_UPC.filter((l) => (l.shortfall ?? 0) > 0);
    const shortfallUnits = shortfalls.reduce((n, l) => n + (l.shortfall ?? 0), 0);
    const shortfallLines = shortfalls.length;

    const destructive = {
      /**
       * Every unit this count would record as sold, both kinds together — serialized units
       * nobody accounted for, and the shortfall on counted shelves. One number because it
       * is one outcome, and because a reviewer reading "0 would be sold" over a count that
       * removes ten water bottles is being misinformed.
       */
      inferredSales: byResolution.MARKED_SOLD.length + shortfallUnits,
      /** Serialized units only, for a reader who wants the split. */
      markedSoldUnits: byResolution.MARKED_SOLD.length,
      /** Units missing off the counted quantity shelves. */
      shortfallUnits,
      /** How many shelves are short — a zeroed shelf is the extreme case of one. */
      shortfallLines,
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
      lines,
      linesByResolution: byResolution,
      markedSoldSerials: byResolution.MARKED_SOLD.map((l) => l.serial),
      pendingNotReceived: byResolution.PENDING_NOT_RECEIVED,
      /**
       * Units of products the count never touched. Applied as a no-op, surfaced so a
       * reviewer can see the count's real coverage rather than assuming a clean sweep.
       */
      notCounted: byResolution.NOT_COUNTED,
      /** Units taken over from another store because they were scanned here. */
      transferredIn: byResolution.TRANSFERRED_IN,
      destructive,
      /** True while the proposals are waiting on an admin. */
      awaitingReview: cc.status === 'AWAITING_REVIEW',
    };
  }
}

/** A new-item submission reduced to one shape, whichever the client sent. */
interface NormalizedNewItem {
  trackingType: 'SERIALIZED' | 'QUANTITY';
  /** The code that opened the flow, and the column it belongs in. */
  captured: { field: string; value: string } | null;
  /** The unit's own serial. Present for SERIALIZED, always normalized. */
  serial: string | null;
  name?: string;
  quantity?: number;
}

/**
 * Reconcile the two shapes a handheld may submit, and refuse the incoherent ones.
 *
 * NEW: { trackingType, capturedCode, serial? } — the counter answered one question,
 * "quantity or serialized?", and the server decided which column the code belongs in.
 *
 * LEGACY: { isUpc } — the counter was asked whether the barcode was a UPC or a
 * serial. Still accepted because scanners update on their own schedule and a count
 * in progress on an older build must still land.
 *
 * THE RULE, enforced here: a SERIALIZED new item needs a serial. The code that opened
 * the flow names a PRODUCT — a price sticker most of all — and no barcode identifies
 * WHICH piece is in somebody's hand. Refusing here means no later code path has to be
 * trusted to remember it.
 */
function normalizeNewItem(ni: NewItemDto): NormalizedNewItem {
  if (ni.trackingType) {
    const serial = ni.serial ? normalizeScannedSerial(ni.serial) : null;
    if (ni.trackingType === 'SERIALIZED' && !serial) {
      throw new BadRequestException(
        `New serialized item '${ni.serialOrUpc}' has no serial. A barcode names a ` +
          `product, not a unit — scan the item's own R-serial label as well.`,
      );
    }
    return {
      trackingType: ni.trackingType,
      captured: ni.capturedCode
        ? { field: ni.capturedCode.field, value: ni.capturedCode.value }
        : null,
      serial,
      name: ni.name,
      quantity: ni.quantity,
    };
  }

  // Legacy. isUpc=true meant "a quantity product's barcode"; false meant "a serial
  // nobody could identify", which stays product-less exactly as before.
  if (ni.isUpc === undefined) {
    throw new BadRequestException(
      'A new item needs either trackingType (with capturedCode) or the legacy isUpc flag.',
    );
  }
  return ni.isUpc
    ? {
        trackingType: 'QUANTITY',
        captured: { field: 'upc', value: ni.serialOrUpc },
        serial: null,
        name: ni.name,
        quantity: ni.quantity,
      }
    : {
        trackingType: 'SERIALIZED',
        captured: null,
        serial: normalizeScannedSerial(ni.serialOrUpc),
        name: ni.name,
        quantity: ni.quantity,
      };
}
