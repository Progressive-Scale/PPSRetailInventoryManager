/**
 * In-store PRICE-EMBEDDED labels, and the ambiguity they create.
 *
 * A price label is a 12-digit UPC-A of the form:
 *
 *     2 {code5} {price5} {check}
 *     │  │       │        └─ ordinary UPC-A check digit
 *     │  │       └────────── price in cents, e.g. 01196 = $11.96
 *     │  └────────────────── the product code — the only stable part
 *     └───────────────────── prefix 2
 *
 * Verified against physical samples on 2026-08-14, all with VALID check digits:
 *
 *     207318011968 -> code 07318, $11.96, check 8
 *     217183044787 -> code 17183, $44.78, check 7
 *     216317065520 -> code 16317, $65.52, check 0
 *
 * An earlier note in this project claimed these labels "always end in 8". They do
 * not — that was one sample whose COMPUTED check digit happened to be 8. The last
 * digit is validated as a normal check digit and never special-cased.
 *
 * THE PREFIX PROVES NOTHING. GS1 reserves prefix 2 for in-store use, but nothing
 * enforces it and a supplier's genuine catalog UPC may start with 2 — and the two
 * mean opposite things: one identifies a product to sell, the other is a sticker
 * whose digits change with every piece. So this module only ever says "this COULD
 * be a price label"; which it actually is, is decided by looking in the catalog.
 * See resolveScannedUpc().
 */

/** Digits 2-6 and 7-11 of a leading-2 label, once the shape is proven. */
export interface LeadingTwoCode {
  /** The full 12 digits, as scanned. */
  fullDigits: string;
  /** Digits 2-6 — what products.price_embedded_code stores. Leading zeros kept. */
  productCode5: string;
  /** Digits 7-11 read as cents. Display only; nothing keys on the price. */
  priceCents: number;
}

/** Standard UPC-A / EAN check digit over the leading digits. */
export function checkDigit(body: string): number {
  // UPC-A weights the digits 3,1,3,1… from the LEFT over an 11-digit body. EAN-13
  // weights 1,3,1,3… over 12. Same algorithm, opposite phase — which is why this
  // takes the parity from the body length instead of hard-coding it.
  const oddWeight = body.length % 2 === 1 ? 3 : 1;
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const weight = i % 2 === 0 ? oddWeight : 4 - oddWeight;
    sum += Number(body[i]) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

/** Whether an all-digit code carries a valid trailing check digit. */
export function hasValidCheckDigit(digits: string): boolean {
  if (digits.length < 2 || !/^\d+$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  return checkDigit(body) === Number(digits[digits.length - 1]);
}

/**
 * Read a scan as a possible price label.
 *
 * Returns null unless it is 12 digits, starts with 2, AND checks out. The check
 * digit matters: without it a mistyped or misread code would be treated as a
 * product code and quietly resolve to the wrong item, or create a new one.
 */
export function parseLeadingTwo(raw: string): LeadingTwoCode | null {
  const digits = raw.trim();
  if (!/^2\d{11}$/.test(digits)) return null;
  if (!hasValidCheckDigit(digits)) return null;
  return {
    fullDigits: digits,
    productCode5: digits.slice(1, 6),
    priceCents: Number(digits.slice(6, 11)),
  };
}

/** Canonical UPC/EAN lengths. */
const UPC_LENGTHS = new Set([8, 12, 13, 14]);

/** Whether a scan is shaped like a product barcode at all. */
export function looksLikeUpc(raw: string): boolean {
  const digits = raw.trim();
  return (
    /^\d+$/.test(digits) && UPC_LENGTHS.has(digits.length) && hasValidCheckDigit(digits)
  );
}
