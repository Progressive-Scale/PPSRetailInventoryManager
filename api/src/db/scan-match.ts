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

/**
 * The retail shelf label's 2D code: `R<serial>/<YYYYMMDD>`, e.g.
 * `R1205058450/20260722` for serial `1205058450` packed 2026-07-22.
 *
 * The pack date is the second half. Requiring it — and requiring it to be a plausible
 * date — is what keeps this from mangling a real serial that merely contains a slash.
 */
const RETAIL_2D = /^([A-Z])(\d{4,20})\/(\d{4})(\d{2})(\d{2})$/;

export interface NormalizedScan {
  /** What to match on: the serial alone. */
  serial: string;
  /** Pack date from the label, when the scan carried one. */
  packDate: string | null;
  /** True when the raw scan was a recognised composite rather than a bare serial. */
  wasComposite: boolean;
}

/**
 * Reduce whatever a scanner produced to the value inventory is keyed on.
 *
 * A physical unit can present its identity in three different encodings, and the store
 * may scan any of them:
 *
 *   1. the retail label's 2D code   `R1205058450/20260722`   -> serial + pack date
 *   2. the serial alone             `1205058450`
 *   3. the ERP's GS1-128            `(01) 9009… (21) 1000…`  -> matched via `barcode`
 *
 * Only the first needs reducing. Cases 2 and 3 pass through untouched and are handled
 * by {@link scanMatches}, which checks the serial and the stored barcode. Normalising
 * here rather than in each client means the handheld needs no change to benefit, and
 * every entry point agrees on what a scan means.
 *
 * Anything unrecognised is returned as-is: this function narrows a scan when it can
 * prove the shape, and never guesses.
 */
export function normalizeScan(raw: string): NormalizedScan {
  const value = raw.trim();
  const m = RETAIL_2D.exec(value);
  if (!m) return { serial: value, packDate: null, wasComposite: false };

  const [, , serial, year, month, day] = m;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);

  // A tail that is not a real date means this is some other format that happens to have
  // a slash in it. Leave it alone rather than shortening it to a guess.
  if (y < 2000 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > 31) {
    return { serial: value, packDate: null, wasComposite: false };
  }

  return { serial, packDate: `${year}-${month}-${day}`, wasComposite: true };
}

/** Just the serial, for the many callers that do not care about the pack date. */
export function normalizeScannedSerial(raw: string): string {
  return normalizeScan(raw).serial;
}
