import { and, asc, eq } from 'drizzle-orm';
import { Tx } from '../db/tenant-db.service';
import { LocationKind, StoreLocation, storeLocations, stores } from '../db/schema';
import { defaultLocationName } from './location-names';

/**
 * Resolve the DEFAULT location of a required kind for a store.
 *
 * A store may now have SEVERAL active BACKROOM or ONFLOOR locations, so callers
 * that need "the store's backroom" (handoff landing, cycle-count defaults) need a
 * deterministic choice. The rule is the OLDEST ACTIVE one: lowest sort_order,
 * then created_at, then id as a final tiebreak. Inactive locations are never
 * chosen — they are excluded from landing and restock logic by design.
 *
 * Throws if the store has no active location of that kind; the locations service
 * guarantees at least one exists by refusing to deactivate or delete the last.
 */
export async function systemLocationId(
  tx: Tx,
  companyId: number,
  storeId: number,
  kind: Exclude<LocationKind, 'CUSTOM'>,
): Promise<number> {
  const [row] = await tx
    .select({ id: storeLocations.id })
    .from(storeLocations)
    .where(
      and(
        eq(storeLocations.companyId, companyId),
        eq(storeLocations.storeId, storeId),
        eq(storeLocations.kind, kind),
        eq(storeLocations.isActive, true),
      ),
    )
    .orderBy(
      asc(storeLocations.sortOrder),
      asc(storeLocations.createdAt),
      asc(storeLocations.id),
    )
    .limit(1);
  if (!row) {
    throw new Error(
      `Store ${storeId} has no active ${kind} location. Run the locations backfill.`,
    );
  }
  return row.id;
}

/** Load a location by id within a company (null if not found / other tenant). */
export async function loadLocation(
  tx: Tx,
  companyId: number,
  id: number,
): Promise<StoreLocation | undefined> {
  const [row] = await tx
    .select()
    .from(storeLocations)
    .where(and(eq(storeLocations.id, id), eq(storeLocations.companyId, companyId)))
    .limit(1);
  return row;
}

/**
 * Create the two required locations for a freshly-created store, satisfying the
 * "at least one active BACKROOM and ONFLOOR per store" invariant from birth. More
 * of either kind can be added later.
 */
export async function createSystemLocations(
  tx: Tx,
  companyId: number,
  storeId: number,
): Promise<void> {
  const [store] = await tx
    .select({ name: stores.name })
    .from(stores)
    .where(eq(stores.id, storeId))
    .limit(1);
  const label = store?.name ?? `Store ${storeId}`;
  await tx.insert(storeLocations).values([
    {
      companyId,
      storeId,
      name: await uniqueLocationName(tx, companyId, defaultLocationName('BACKROOM', label)),
      kind: 'BACKROOM',
      sortOrder: 0,
    },
    {
      companyId,
      storeId,
      name: await uniqueLocationName(tx, companyId, defaultLocationName('ONFLOOR', label)),
      kind: 'ONFLOOR',
      sortOrder: 1,
    },
  ]);
}

/**
 * First free variant of `base` among the company's ACTIVE locations: "Downtown
 * Backroom", then "Downtown Backroom 2", and so on. Needed because two stores may
 * share a name, which would otherwise collide on the company-wide unique index.
 */
export async function uniqueLocationName(
  tx: Tx,
  companyId: number,
  base: string,
): Promise<string> {
  const taken = new Set(
    (
      await tx
        .select({ name: storeLocations.name })
        .from(storeLocations)
        .where(
          and(
            eq(storeLocations.companyId, companyId),
            eq(storeLocations.isActive, true),
          ),
        )
    ).map((r) => r.name.trim().toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error(`Could not find a free location name based on "${base}".`);
}
