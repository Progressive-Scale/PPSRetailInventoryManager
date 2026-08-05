import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  inventoryItems,
  inventoryStock,
  inventoryTransactions,
  LocationKind,
  StoreLocation,
  storeLocations,
  stores,
} from '../db/schema';
import { DataContext } from '../auth/auth.types';
import { AuditService, diffFields } from '../audit/audit.service';
import {
  CreateLocationDto,
  ReorderLocationsDto,
  UpdateLocationDto,
} from './dto/locations.dto';

/** Kinds a store must always keep at least one ACTIVE location of. */
export const REQUIRED_KINDS = ['BACKROOM', 'ONFLOOR'] as const;
type RequiredKind = (typeof REQUIRED_KINDS)[number];

function isRequiredKind(kind: LocationKind): kind is RequiredKind {
  return (REQUIRED_KINDS as readonly string[]).includes(kind);
}

/**
 * Human label for a KIND, used in guard messages. Deliberately NOT
 * DEFAULT_LOCATION_NAMES: that constant is the initial *name* of a location and a
 * store may rename it, whereas this label describes the kind itself. A store that
 * renamed its backroom to "Stock Room West" should still be told "every store
 * needs at least one active Backroom location".
 */
export function kindLabel(kind: LocationKind): string {
  if (kind === 'BACKROOM') return 'Backroom';
  if (kind === 'ONFLOOR') return 'On Floor';
  return 'Custom';
}

/** Per-location facts the UI needs to pick the right affordance. */
export interface LocationFlags {
  /** LIVE stock: on-hand units + quantity on hand. Blocks deactivate AND delete. */
  hasStock: boolean;
  /** Anything referencing it at all (items of any status, or the ledger). */
  hasHistory: boolean;
  isLastOfRequiredKind: boolean;
  /** Units + quantity on hand, for the "move the N items out first" message. */
  stockCount: number;
  /** EVERY item row still pointing here, whatever its status. Blocks delete. */
  itemCount: number;
  /** How many of itemCount are sold — they cannot be moved, so they are called out. */
  soldCount: number;
  /** The append-only ledger records a movement in/out of here. Blocks delete. */
  hasLedger: boolean;
}

@Injectable()
export class LocationsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  /** Store a read/write must target, enforcing STORE_USER scope. */
  private storeId(ctx: DataContext, requested?: number): number {
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

  private async assertStore(tx: Tx, companyId: number, storeId: number) {
    const [row] = await tx
      .select({ id: stores.id })
      .from(stores)
      .where(and(eq(stores.id, storeId), eq(stores.companyId, companyId)))
      .limit(1);
    if (!row) throw new NotFoundException('Store not found.');
  }

  private async load(
    tx: Tx,
    ctx: DataContext,
    id: number,
  ): Promise<StoreLocation> {
    const [row] = await tx
      .select()
      .from(storeLocations)
      .where(
        and(
          eq(storeLocations.id, id),
          eq(storeLocations.companyId, ctx.companyId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Location not found.');
    if (ctx.role === 'STORE_USER' && row.storeId !== ctx.storeId) {
      throw new NotFoundException('Location not found.');
    }
    return row;
  }

  // ---- guards ------------------------------------------------------------
  // Every rule lives here and runs inside the mutation's own transaction, so the
  // API is authoritative no matter what the UI believes.

  /**
   * Live stock at a location: ON_HAND units plus quantity actually on hand. SOLD
   * units and zero-quantity rows do NOT count — they are history, not stock.
   */
  private async stockCount(
    tx: Tx,
    companyId: number,
    locationId: number,
  ): Promise<number> {
    const [units] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.companyId, companyId),
          eq(inventoryItems.locationId, locationId),
          eq(inventoryItems.status, 'ON_HAND'),
        ),
      );
    const [qty] = await tx
      .select({ n: sql<number>`coalesce(sum(${inventoryStock.quantityOnHand}), 0)::int` })
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.companyId, companyId),
          eq(inventoryStock.locationId, locationId),
          gt(inventoryStock.quantityOnHand, 0),
        ),
      );
    return (units?.n ?? 0) + (qty?.n ?? 0);
  }

  /**
   * Whether anything at all still references the location: ledger rows, or any
   * inventory row of ANY status (a SOLD unit is history but is still a foreign
   * key, so a hard delete would fail at the database).
   */
  /** Item rows still pointing at the location, by status. */
  private async itemCounts(
    tx: Tx,
    companyId: number,
    locationId: number,
  ): Promise<{ total: number; sold: number }> {
    const [units] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        sold: sql<number>`count(*) filter (where ${inventoryItems.status} = 'SOLD')::int`,
      })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.companyId, companyId),
          eq(inventoryItems.locationId, locationId),
        ),
      );
    const [stock] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.companyId, companyId),
          eq(inventoryStock.locationId, locationId),
        ),
      );
    return { total: (units?.total ?? 0) + (stock?.total ?? 0), sold: units?.sold ?? 0 };
  }

  /** The append-only ledger records a movement into or out of this location. */
  private async referencedByLedger(
    tx: Tx,
    companyId: number,
    locationId: number,
  ): Promise<boolean> {
    const [ledger] = await tx
      .select({ id: inventoryTransactions.id })
      .from(inventoryTransactions)
      .where(
        and(
          eq(inventoryTransactions.companyId, companyId),
          or(
            eq(inventoryTransactions.locationFromId, locationId),
            eq(inventoryTransactions.locationToId, locationId),
          ),
        ),
      )
      .limit(1);
    return !!ledger;
  }

  private async hasHistory(
    tx: Tx,
    companyId: number,
    locationId: number,
  ): Promise<boolean> {
    const [ledger] = await tx
      .select({ id: inventoryTransactions.id })
      .from(inventoryTransactions)
      .where(
        and(
          eq(inventoryTransactions.companyId, companyId),
          or(
            eq(inventoryTransactions.locationFromId, locationId),
            eq(inventoryTransactions.locationToId, locationId),
          ),
        ),
      )
      .limit(1);
    if (ledger) return true;
    const [item] = await tx
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.companyId, companyId),
          eq(inventoryItems.locationId, locationId),
        ),
      )
      .limit(1);
    if (item) return true;
    const [stock] = await tx
      .select({ id: inventoryStock.id })
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.companyId, companyId),
          eq(inventoryStock.locationId, locationId),
        ),
      )
      .limit(1);
    return !!stock;
  }

  /**
   * True when turning this location off would leave its store without an ACTIVE
   * location of a required kind.
   *
   * Takes a row lock on the store's rows of that kind (FOR UPDATE) — at READ
   * COMMITTED two concurrent deactivations would otherwise each see two active
   * rows and both commit, emptying the kind.
   */
  private async wouldBreakRequiredKind(
    tx: Tx,
    companyId: number,
    loc: StoreLocation,
  ): Promise<boolean> {
    if (!isRequiredKind(loc.kind) || !loc.isActive) return false;
    const rows = await tx
      .select({ id: storeLocations.id })
      .from(storeLocations)
      .where(
        and(
          eq(storeLocations.companyId, companyId),
          eq(storeLocations.storeId, loc.storeId),
          eq(storeLocations.kind, loc.kind),
          eq(storeLocations.isActive, true),
        ),
      )
      .for('update');
    return rows.length <= 1;
  }

  private lastOfKindMessage(kind: LocationKind): string {
    return `Every store needs at least one active ${kindLabel(kind)} location.`;
  }

  /** Shared by deactivate and delete: live stock blocks both. */
  private async assertNoStock(
    tx: Tx,
    companyId: number,
    locationId: number,
  ): Promise<void> {
    const n = await this.stockCount(tx, companyId, locationId);
    if (n > 0) {
      throw new ConflictException(
        `Move the ${n} item${n === 1 ? '' : 's'} out of this location first.`,
      );
    }
  }

  // ---- reads -------------------------------------------------------------

  /**
   * A STORE_USER always gets their own store. A COMPANY_ADMIN may pass storeId for
   * one store, or omit it to list every store's locations (which the admin UI uses
   * to show a Store column and filter across stores).
   *
   * Inactive locations are EXCLUDED unless includeInactive is set, so scanners,
   * move dialogs and every other consumer only ever see usable locations. The
   * admin screen opts in so it can offer Reactivate.
   */
  async list(
    ctx: DataContext,
    requestedStoreId?: number,
    includeInactive = false,
  ) {
    const allStores = ctx.role === 'COMPANY_ADMIN' && requestedStoreId === undefined;
    const storeId = allStores ? null : this.storeId(ctx, requestedStoreId);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      if (storeId != null) await this.assertStore(tx, ctx.companyId, storeId);
      const scope = [eq(storeLocations.companyId, ctx.companyId)];
      if (storeId != null) scope.push(eq(storeLocations.storeId, storeId));
      if (!includeInactive) scope.push(eq(storeLocations.isActive, true));

      const rows = await tx
        .select()
        .from(storeLocations)
        .where(and(...scope))
        .orderBy(
          asc(storeLocations.storeId),
          asc(storeLocations.sortOrder),
          asc(storeLocations.id),
        );
      if (rows.length === 0) return [];

      // Only the admin view needs the lifecycle flags, and they cost three
      // aggregate queries — skip them for the plain (active-only) reads.
      if (!includeInactive) return rows.map((r) => ({ ...r }));
      return this.decorate(tx, ctx.companyId, rows);
    });
  }

  /** Attach hasStock / hasHistory / isLastOfRequiredKind to each row. */
  private async decorate(
    tx: Tx,
    companyId: number,
    rows: StoreLocation[],
  ): Promise<Array<StoreLocation & LocationFlags>> {
    const ids = rows.map((r) => r.id);

    const unitRows = await tx
      .select({
        locationId: inventoryItems.locationId,
        onHand: sql<number>`count(*) filter (where ${inventoryItems.status} = 'ON_HAND')::int`,
        sold: sql<number>`count(*) filter (where ${inventoryItems.status} = 'SOLD')::int`,
        any: sql<number>`count(*)::int`,
      })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.companyId, companyId),
          inArray(inventoryItems.locationId, ids),
        ),
      )
      .groupBy(inventoryItems.locationId);

    const stockRows = await tx
      .select({
        locationId: inventoryStock.locationId,
        onHand: sql<number>`coalesce(sum(${inventoryStock.quantityOnHand}), 0)::int`,
        any: sql<number>`count(*)::int`,
      })
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.companyId, companyId),
          inArray(inventoryStock.locationId, ids),
        ),
      )
      .groupBy(inventoryStock.locationId);

    const ledgerRows = await tx
      .select({ locationId: inventoryTransactions.locationFromId })
      .from(inventoryTransactions)
      .where(
        and(
          eq(inventoryTransactions.companyId, companyId),
          or(
            inArray(inventoryTransactions.locationFromId, ids),
            inArray(inventoryTransactions.locationToId, ids),
          ),
        ),
      );
    const ledgerTo = await tx
      .select({ locationId: inventoryTransactions.locationToId })
      .from(inventoryTransactions)
      .where(
        and(
          eq(inventoryTransactions.companyId, companyId),
          inArray(inventoryTransactions.locationToId, ids),
        ),
      );
    const inLedger = new Set<number>();
    for (const r of [...ledgerRows, ...ledgerTo]) {
      if (r.locationId != null) inLedger.add(r.locationId);
    }

    const units = new Map(unitRows.map((r) => [r.locationId, r]));
    const stock = new Map(stockRows.map((r) => [r.locationId, r]));

    // Active count per (store, kind) so "last of required kind" needs no extra query.
    const activeByStoreKind = new Map<string, number>();
    for (const r of rows) {
      if (!r.isActive) continue;
      const key = `${r.storeId}:${r.kind}`;
      activeByStoreKind.set(key, (activeByStoreKind.get(key) ?? 0) + 1);
    }

    return rows.map((r) => {
      const u = units.get(r.id);
      const s = stock.get(r.id);
      const stockCount = (u?.onHand ?? 0) + (s?.onHand ?? 0);
      const itemCount = (u?.any ?? 0) + (s?.any ?? 0);
      return {
        ...r,
        stockCount,
        itemCount,
        soldCount: u?.sold ?? 0,
        hasLedger: inLedger.has(r.id),
        hasStock: stockCount > 0,
        hasHistory: inLedger.has(r.id) || itemCount > 0,
        isLastOfRequiredKind:
          r.isActive &&
          isRequiredKind(r.kind) &&
          (activeByStoreKind.get(`${r.storeId}:${r.kind}`) ?? 0) <= 1,
      };
    });
  }

  // ---- writes (COMPANY_ADMIN) --------------------------------------------

  async create(ctx: DataContext, dto: CreateLocationDto) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      await this.assertStore(tx, ctx.companyId, dto.storeId);
      // Place new locations after existing ones.
      const existing = await tx
        .select({ sortOrder: storeLocations.sortOrder })
        .from(storeLocations)
        .where(
          and(
            eq(storeLocations.companyId, ctx.companyId),
            eq(storeLocations.storeId, dto.storeId),
          ),
        );
      const nextSort =
        existing.reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1;
      try {
        const [row] = await tx
          .insert(storeLocations)
          .values({
            companyId: ctx.companyId,
            storeId: dto.storeId,
            name: dto.name.trim(),
            // Kind is chosen once, here, and is immutable afterwards.
            kind: dto.kind ?? 'CUSTOM',
            sortOrder: nextSort,
            isActive: dto.isActive ?? true,
          })
          .returning();
        await this.audit.record(
          tx,
          ctx.companyId,
          AuditService.user(ctx),
          { entityType: 'LOCATION', entityId: row.id, storeId: row.storeId },
          'CREATED',
          { details: { name: row.name, kind: row.kind } },
        );
        return row;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            `An active location named "${dto.name}" already exists in this store.`,
          );
        }
        throw err;
      }
    });
  }

  async update(ctx: DataContext, id: number, dto: UpdateLocationDto) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const loc = await this.load(tx, ctx, id); // scope + existence
      const patch: Record<string, unknown> = {};
      if (dto.name !== undefined) patch.name = dto.name.trim();
      if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder;
      if (dto.isActive !== undefined && dto.isActive !== loc.isActive) {
        // Same guards as the dedicated endpoints — PATCH is not a way around them.
        if (!dto.isActive) await this.assertCanDeactivate(tx, ctx, loc);
        patch.isActive = dto.isActive;
      }
      if (Object.keys(patch).length === 0) {
        throw new BadRequestException('Nothing to update.');
      }
      return this.applyPatch(tx, ctx, id, patch, dto.name);
    });
  }

  private async applyPatch(
    tx: Tx,
    ctx: DataContext,
    id: number,
    patch: Record<string, unknown>,
    name?: string,
  ) {
    // Before, so the diff is real and so a deactivate/reactivate can tell whether it
    // actually changed anything.
    const [before] = await tx
      .select()
      .from(storeLocations)
      .where(
        and(
          eq(storeLocations.id, id),
          eq(storeLocations.companyId, ctx.companyId),
        ),
      )
      .limit(1);
    try {
      const [row] = await tx
        .update(storeLocations)
        .set(patch)
        .where(
          and(
            eq(storeLocations.id, id),
            eq(storeLocations.companyId, ctx.companyId),
          ),
        )
        .returning();
      if (before) {
        const target = {
          entityType: 'LOCATION' as const,
          entityId: id,
          storeId: row.storeId,
        };
        // isActive is a lifecycle event, not a field edit: "Dana deactivated Aisle 2" is
        // what an admin is looking for, and UPDATED is_active=false says it less clearly.
        if ('isActive' in patch && patch.isActive !== before.isActive) {
          await this.audit.record(
            tx,
            ctx.companyId,
            AuditService.user(ctx),
            target,
            patch.isActive ? 'REACTIVATED' : 'DEACTIVATED',
            { details: { name: row.name } },
          );
        }
        // sortOrder is excluded on purpose: reordering the list is arranging a screen, not
        // changing the location, and one drag would otherwise write a row per location.
        const changes = diffFields(
          before as unknown as Record<string, unknown>,
          patch,
          { fields: ['name'] },
        );
        await this.audit.recordChanges(
          tx,
          ctx.companyId,
          AuditService.user(ctx),
          target,
          changes,
        );
      }
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          name
            ? `An active location named "${name}" already exists in this store.`
            : 'Another active location in this store already uses that name.',
        );
      }
      throw err;
    }
  }

  /** Live stock blocks it; so does being the last active row of a required kind. */
  private async assertCanDeactivate(
    tx: Tx,
    ctx: DataContext,
    loc: StoreLocation,
  ): Promise<void> {
    if (await this.wouldBreakRequiredKind(tx, ctx.companyId, loc)) {
      throw new ConflictException(this.lastOfKindMessage(loc.kind));
    }
    await this.assertNoStock(tx, ctx.companyId, loc.id);
  }

  async deactivate(ctx: DataContext, id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const loc = await this.load(tx, ctx, id);
      if (!loc.isActive) return loc; // idempotent
      await this.assertCanDeactivate(tx, ctx, loc);
      return this.applyPatch(tx, ctx, id, { isActive: false });
    });
  }

  /** Always allowed, subject to the active-name uniqueness index. */
  async reactivate(ctx: DataContext, id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const loc = await this.load(tx, ctx, id);
      if (loc.isActive) return loc; // idempotent
      return this.applyPatch(tx, ctx, id, { isActive: true }, loc.name);
    });
  }

  async reorder(ctx: DataContext, dto: ReorderLocationsDto) {
    const storeId = this.storeId(ctx, dto.storeId);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      await this.assertStore(tx, ctx.companyId, storeId);
      const rows = await tx
        .select({ id: storeLocations.id })
        .from(storeLocations)
        .where(
          and(
            eq(storeLocations.companyId, ctx.companyId),
            eq(storeLocations.storeId, storeId),
          ),
        );
      const known = new Set(rows.map((r) => r.id));
      if (
        dto.orderedIds.length !== known.size ||
        !dto.orderedIds.every((id) => known.has(id))
      ) {
        throw new BadRequestException(
          'orderedIds must list every location in the store exactly once.',
        );
      }
      let sort = 0;
      for (const id of dto.orderedIds) {
        await tx
          .update(storeLocations)
          .set({ sortOrder: sort++ })
          .where(
            and(
              eq(storeLocations.id, id),
              eq(storeLocations.companyId, ctx.companyId),
            ),
          );
      }
      return tx
        .select()
        .from(storeLocations)
        .where(
          and(
            eq(storeLocations.companyId, ctx.companyId),
            eq(storeLocations.storeId, storeId),
          ),
        )
        .orderBy(asc(storeLocations.sortOrder), asc(storeLocations.id));
    });
  }

  /**
   * Hard delete. Allowed only for a location that was created and never used:
   * no live stock, nothing referencing it in history, and not the last active
   * location of a required kind. Anything with history is deactivated instead.
   */
  async remove(ctx: DataContext, id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const loc = await this.load(tx, ctx, id);
      if (await this.wouldBreakRequiredKind(tx, ctx.companyId, loc)) {
        throw new ConflictException(this.lastOfKindMessage(loc.kind));
      }
      await this.assertNoStock(tx, ctx.companyId, id);
      // Every item must be gone, sold ones included — an item row is a foreign key,
      // so the delete would fail at the database anyway.
      const remaining = await this.itemCounts(tx, ctx.companyId, id);
      if (remaining.total > 0) {
        const sold = remaining.sold > 0 ? ` (${remaining.sold} of them sold)` : '';
        throw new ConflictException(
          `Remove the ${remaining.total} item${remaining.total === 1 ? '' : 's'} still ` +
            `at this location${sold} before deleting it, or make it inactive instead.`,
        );
      }
      if (await this.referencedByLedger(tx, ctx.companyId, id)) {
        throw new ConflictException(
          'Past movements still refer to this location, so deleting it would lose that ' +
            'history. Make it inactive instead.',
        );
      }
      const [gone] = await tx
        .delete(storeLocations)
        .where(
          and(
            eq(storeLocations.id, id),
            eq(storeLocations.companyId, ctx.companyId),
          ),
        )
        .returning();
      // The name lives in details because the row it described no longer exists.
      await this.audit.record(
        tx,
        ctx.companyId,
        AuditService.user(ctx),
        { entityType: 'LOCATION', entityId: id, storeId: gone?.storeId ?? null },
        'DELETED',
        { details: { name: gone?.name ?? null, kind: gone?.kind ?? null } },
      );
      return { deleted: true, id };
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}
