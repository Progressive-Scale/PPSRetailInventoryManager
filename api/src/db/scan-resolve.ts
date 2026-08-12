import { and, eq, isNotNull, type SQL } from 'drizzle-orm';
import { inventoryItems, products, storeLocations, stores } from './schema';
import { normalizeScannedSerial, scanMatches } from './scan-match';
import type { Tx } from './tenant-db.service';

/**
 * What a scanned string turned out to be.
 *
 * - `ITEM` — a unit's own serial (or its full barcode). One or more candidates: a serial is
 *   unique per PRODUCT, not per company, so a scan can legitimately match two units.
 * - `CASE` — nothing owns that serial, but units share it as their `case_serial`. The store
 *   scanned the outside of a box, and the answer is every piece inside it.
 * - `NONE` — neither. The caller's existing unknown-scan path takes over.
 */
export type ScanHitKind = 'ITEM' | 'CASE' | 'NONE';

/**
 * One unit a scan resolved to, with enough context for any caller to decide what to do.
 *
 * Derived from the query rather than hand-declared: item ids are uuids and `status` is an
 * enum union, and a hand-written mirror of that drifts the moment the schema moves.
 */
export type ScanCandidate = Awaited<ReturnType<typeof candidateQuery>>[number];

export interface ScanResolution {
  /** The scan reduced to what inventory is keyed on — see {@link normalizeScannedSerial}. */
  value: string;
  kind: ScanHitKind;
  /** The shared case serial, when `kind` is `CASE`. */
  caseSerial: string | null;
  candidates: ScanCandidate[];
}

/**
 * Every column a caller could want about a matched unit, selected once.
 *
 * One shape for both branches so a case hit and an item hit are interchangeable to the
 * code above: the difference between them should be a decision, not a different row type.
 */
const CANDIDATE_COLUMNS = {
  id: inventoryItems.id,
  serial: inventoryItems.serial,
  caseSerial: inventoryItems.caseSerial,
  status: inventoryItems.status,
  productId: inventoryItems.productId,
  storeId: inventoryItems.storeId,
  locationId: inventoryItems.locationId,
  locationName: storeLocations.name,
  storeName: stores.name,
  sku: products.sku,
  name: products.name,
  expirationDate: inventoryItems.expirationDate,
  weightLbs: inventoryItems.weightLbs,
  price: inventoryItems.price,
} as const;

function candidateQuery(tx: Tx, where: SQL) {
  return tx
    .select(CANDIDATE_COLUMNS)
    .from(inventoryItems)
    .leftJoin(products, eq(products.id, inventoryItems.productId))
    .leftJoin(storeLocations, eq(storeLocations.id, inventoryItems.locationId))
    .leftJoin(stores, eq(stores.id, inventoryItems.storeId))
    .where(where);
}

/**
 * Resolve a scanned string to units — the one place that decides what a scan means.
 *
 * The order is the whole design, and it is not arbitrary:
 *
 *   1. **A unit's own serial wins outright.** A piece is a unit, so scanning a piece always
 *      acts on that piece and nothing else. Checking cases first would let a case serial
 *      that happens to equal some unit's serial hijack it.
 *   2. **Then `case_serial`.** Only when nothing owns the string is it read as a group. A
 *      pieced case has no row of its own — the case is a barcode, not inventory — so this
 *      is the only way scanning the box can do anything at all.
 *   3. **Otherwise nothing**, and the caller's existing unknown-scan handling applies
 *      (product barcode lookup, the review queue, "check pps for this serial", and so on).
 *
 * Step 1 is deliberately company-wide: a unit recorded at ANOTHER store is exactly the case
 * worth answering, and store-scoping it made a known serial look unknown. Step 2 honours
 * `storeId` when given, because a case only means "the box in front of me" — two stores can
 * hold pieces from one original case, and receiving another store's pieces on this scan
 * would move stock nobody touched.
 */
export async function resolveScan(
  tx: Tx,
  companyId: number,
  raw: string,
  opts: { storeId?: number | null } = {},
): Promise<ScanResolution> {
  const value = normalizeScannedSerial(raw);
  if (!value) return { value, kind: 'NONE', caseSerial: null, candidates: [] };

  const items = await candidateQuery(
    tx,
    and(eq(inventoryItems.companyId, companyId), scanMatches(value)!)!,
  );

  // "Units win over cases" means LIVE units win. One row can legitimately carry a case
  // serial as its own serial: the placeholder created when somebody scanned an unknown case
  // barcode, which import-check adoption retires as ADJUSTED_OUT with no product. Left in
  // the running it would shadow its own case forever — the box would resolve to the retired
  // stand-in for the box rather than to the pieces that replaced it.
  //
  // Narrow on purpose: only a productless ADJUSTED_OUT row steps aside, because that shape
  // is exactly the retired placeholder. A real unit that was adjusted out still answers, so
  // a counter scanning one is told what it is rather than being sent down the case path.
  const live = items.filter(
    (i) => !(i.productId === null && i.status === 'ADJUSTED_OUT'),
  );
  if (live.length > 0) {
    return { value, kind: 'ITEM', caseSerial: null, candidates: live };
  }

  const caseConds: SQL[] = [
    eq(inventoryItems.companyId, companyId),
    isNotNull(inventoryItems.caseSerial),
    eq(inventoryItems.caseSerial, value),
  ];
  if (opts.storeId != null) caseConds.push(eq(inventoryItems.storeId, opts.storeId));

  const pieces = await candidateQuery(tx, and(...caseConds)!);
  if (pieces.length > 0) {
    return { value, kind: 'CASE', caseSerial: value, candidates: pieces };
  }

  // A retired placeholder with no case behind it is still a known row, and saying so beats
  // reporting the code as never seen — that is what would raise a second phantom.
  if (items.length > 0) {
    return { value, kind: 'ITEM', caseSerial: null, candidates: items };
  }

  return { value, kind: 'NONE', caseSerial: null, candidates: [] };
}

/**
 * A one-line summary of what a case scan covers, for feedback a person reads on a handheld.
 * Counting by status rather than listing serials: "3 pieces, 1 already received" is what a
 * counter needs to hear, and a list of twelve serials on a small screen is noise.
 */
export function summariseCase(pieces: ScanCandidate[]): Record<string, number> {
  const byStatus: Record<string, number> = {};
  for (const p of pieces) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  return byStatus;
}
