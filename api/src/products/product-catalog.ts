import { and, eq } from 'drizzle-orm';
import { Tx } from '../db/tenant-db.service';
import { Product, products, TrackingType } from '../db/schema';
import { AuditActor, AuditService } from '../audit/audit.service';

/**
 * An empty text box means "nothing here", and only NULL says that.
 *
 * A form sends '' for a field the user left blank, and storing that verbatim causes two
 * distinct faults:
 *   - `upc` is unique per company WHERE upc IS NOT NULL, so '' is not exempt: two products
 *     whose barcode was cleared collide, and the error blames a duplicate the user cannot
 *     see anywhere.
 *   - a NULL-to-'' transition is a change to the database and no change to anybody reading
 *     it, so the audit trail reports "changed description: — → " and means nothing by it.
 *
 * Every write path funnels through here so no caller has to remember.
 */
export function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** A leading-2, 12-digit barcode — the shape an in-store price label takes. */
const IN_STORE_SHAPE = /^2\d{11}$/;

/**
 * Whether a barcode is shaped like an in-store price label rather than a retail UPC.
 *
 * A SOFT signal, for warning the user — never grounds to refuse a save. GS1 reserves
 * prefix 2 for in-store use, but nothing enforces it, so a supplier's genuine catalog
 * UPC starting with 2 is unusual rather than impossible.
 */
export function looksLikeInStoreCode(upc: string | null | undefined): boolean {
  return !!upc && IN_STORE_SHAPE.test(upc);
}

/**
 * A leading-2 barcode and a price-label code are two spellings of the same key, so they
 * must not collide ACROSS the two columns — not merely within each one.
 *
 * The collision is invisible until it bites. Give product A the catalog UPC
 * `207318011968` and product B the price code `07318`: neither column holds a
 * duplicate, both rows save happily, and every scan of that sticker is now answerable
 * two ways. The resolver takes the exact-UPC match, so B silently stops resolving and
 * nobody finds out until someone counts it.
 *
 * Enforced in code rather than by a constraint because the comparison is between a
 * SLICE of one column and the whole of another, which no unique index can express.
 *
 * @param excludeProductId the row being edited, so a product never conflicts with itself.
 * @returns the offending product plus a sentence naming it, or null when the pair is clean.
 */
export async function findCodeConflict(
  tx: Tx,
  companyId: number,
  next: { upc?: string | null; priceEmbeddedCode?: string | null },
  excludeProductId?: number,
): Promise<{ id: number; sku: string; name: string; reason: string } | null> {
  const upcCode5 = looksLikeInStoreCode(next.upc)
    ? next.upc!.slice(1, 6)
    : null;
  // Nothing about this write can collide across the two fields.
  if (!upcCode5 && !next.priceEmbeddedCode) return null;

  const rows = await tx
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      upc: products.upc,
      priceEmbeddedCode: products.priceEmbeddedCode,
    })
    .from(products)
    .where(eq(products.companyId, companyId));
  const others = rows.filter((r) => r.id !== excludeProductId);

  if (upcCode5) {
    const clash = others.find((r) => r.priceEmbeddedCode === upcCode5);
    if (clash) {
      return {
        id: clash.id,
        sku: clash.sku,
        name: clash.name,
        reason:
          `barcode ${next.upc} carries the in-store product code ${upcCode5}, which is ` +
          `already the price-label code for ${clash.name} (${clash.sku}).`,
      };
    }
  }

  if (next.priceEmbeddedCode) {
    const clash = others.find(
      (r) =>
        looksLikeInStoreCode(r.upc) && r.upc!.slice(1, 6) === next.priceEmbeddedCode,
    );
    if (clash) {
      return {
        id: clash.id,
        sku: clash.sku,
        name: clash.name,
        reason:
          `price-label code ${next.priceEmbeddedCode} is already carried inside the ` +
          `barcode ${clash.upc} on ${clash.name} (${clash.sku}).`,
      };
    }
  }

  return null;
}

export interface ResolveProductInput {
  sku: string;
  name: string;
  price: string;
  upc: string | null;
  trackingType: TrackingType;
  // Only applied when the product is created (existing products are untouched).
  needsReview?: boolean;
}

/**
 * The catalog is the source of truth for a SKU's name/price/UPC/tracking. When
 * new inventory arrives (sync handoff, cycle-count new item), we resolve the
 * product by (company, sku), creating it from the incoming data if it doesn't
 * exist yet. Idempotent + concurrency-safe via ON CONFLICT. tracking_type is
 * set only at creation and never changed here (it is immutable).
 */
export async function resolveOrCreateProduct(
  tx: Tx,
  companyId: number,
  input: ResolveProductInput,
  /**
   * Records the creation when this call is what created the product. Optional, but every
   * caller passes it: a catalog row appearing on its own is one of the more confusing
   * things an admin can find, and "the agent's handoff created it" is the answer.
   */
  audit?: { service: AuditService; actor: AuditActor; details?: Record<string, unknown> },
): Promise<Product> {
  const existing = await tx
    .select()
    .from(products)
    .where(and(eq(products.companyId, companyId), eq(products.sku, input.sku)))
    .limit(1);
  if (existing[0]) return existing[0];

  // RETURNING says whether THIS statement inserted the row: under a concurrent create,
  // ON CONFLICT DO NOTHING yields nothing, and the other transaction is the one that
  // should own the audit event.
  const inserted = await tx
    .insert(products)
    .values({
      companyId,
      sku: input.sku,
      name: input.name,
      price: input.price,
      upc: blankToNull(input.upc),
      trackingType: input.trackingType,
      needsReview: input.needsReview ?? false,
    })
    .onConflictDoNothing({ target: [products.companyId, products.sku] })
    .returning();

  if (inserted[0]) {
    if (audit) {
      await audit.service.record(
        tx,
        companyId,
        audit.actor,
        { entityType: 'PRODUCT', entityId: inserted[0].id },
        'CREATED',
        {
          details: {
            sku: inserted[0].sku,
            name: inserted[0].name,
            trackingType: inserted[0].trackingType,
            needsReview: inserted[0].needsReview,
            // Distinguishes this from a product a person typed into the catalog screen.
            autoCreated: true,
            ...(audit.details ?? {}),
          },
        },
      );
    }
    return inserted[0];
  }

  const [row] = await tx
    .select()
    .from(products)
    .where(and(eq(products.companyId, companyId), eq(products.sku, input.sku)))
    .limit(1);
  return row;
}
