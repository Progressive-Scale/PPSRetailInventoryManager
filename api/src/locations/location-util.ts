import { and, eq } from 'drizzle-orm';
import { Tx } from '../db/tenant-db.service';
import { LocationKind, StoreLocation, storeLocations } from '../db/schema';

/**
 * Resolve a store's system location by kind (BACKROOM / ONFLOOR). Every store
 * has exactly one of each (created with the store; backfilled for older stores).
 * Throws if missing — a store should never be without its system locations.
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
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error(
      `Store ${storeId} is missing its ${kind} location. Run the locations backfill.`,
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
 * Create the two SYSTEM locations for a freshly-created store. Called from store
 * creation so every store starts with a Backroom + On Floor.
 */
export async function createSystemLocations(
  tx: Tx,
  companyId: number,
  storeId: number,
): Promise<void> {
  await tx.insert(storeLocations).values([
    { companyId, storeId, name: 'Backroom', kind: 'BACKROOM', sortOrder: 0 },
    { companyId, storeId, name: 'On Floor', kind: 'ONFLOOR', sortOrder: 1 },
  ]);
}
