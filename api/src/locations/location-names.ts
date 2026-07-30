import { LocationKind } from '../db/schema';

/**
 * Display names given to a store's required locations when they are first
 * created. They are labels only — the user may rename them to anything.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DO NOT IMPORT THIS OUTSIDE A CREATION / SEED PATH.
 *
 * Legitimate importers are exactly:
 *   - locations/location-util.ts  (createSystemLocations, run with a new store)
 *   - scripts/seed.ts             (demo data)
 *
 * Anything else — a query filter, a guard, a default-selection, a comparison —
 * must key on the immutable `kind` column instead. A location's NAME is
 * user-editable, so logic that depends on it silently breaks the moment a store
 * renames "Backroom" to "Stock Room West". See the note on `storeLocations` in
 * db/schema.ts.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const DEFAULT_LOCATION_NAMES: Record<
  Exclude<LocationKind, 'CUSTOM'>,
  string
> = {
  BACKROOM: 'Backroom',
  ONFLOOR: 'On Floor',
};

/**
 * Location names are unique per company, so the initial names are qualified with
 * the store: "Downtown Backroom", not "Backroom". Callers must still de-duplicate
 * (two stores may share a name) — see uniqueLocationName in location-util.ts.
 */
export function defaultLocationName(
  kind: Exclude<LocationKind, 'CUSTOM'>,
  storeName: string,
): string {
  return `${storeName.trim()} ${DEFAULT_LOCATION_NAMES[kind]}`;
}
