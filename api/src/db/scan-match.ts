import { eq, or, type SQL } from 'drizzle-orm';
import { inventoryItems } from './schema';

/**
 * Match a scanned string against a serialized unit.
 *
 * A store scans the **serial** — the GS1 AI (21) value, e.g. `100000000462` — and that
 * is the identity key: unique per company, and what the ERP hands off.
 *
 * The same label also carries the full GS1-128 barcode
 * (`(01) 90097586111018 (3202) 000082 (13) 240911 (21) 100000000462`). A scanner aimed
 * at the whole symbol, or configured to send the raw string, would otherwise report a
 * unit that is physically in front of the user as an unknown serial — creating a
 * phantom review item and, in a cycle count, marking the real unit missing. Matching
 * the barcode as a fallback turns that whole class of mis-scan into a correct read.
 *
 * Serial is listed first because it is the unique column: if a value could match both,
 * the serial is the one that decides.
 */
export function scanMatches(value: string): SQL | undefined {
  return or(eq(inventoryItems.serial, value), eq(inventoryItems.barcode, value));
}
