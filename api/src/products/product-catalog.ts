import { and, eq } from 'drizzle-orm';
import { Tx } from '../db/tenant-db.service';
import { Product, products, TrackingType } from '../db/schema';
import { AuditActor, AuditService } from '../audit/audit.service';

/**
 * A blank barcode means "no barcode", and only NULL says that.
 *
 * products.upc is unique per company WHERE upc IS NOT NULL, so an empty string is not
 * exempt: two products whose UPC was cleared to '' collide, and the error blames a
 * duplicate SKU/UPC that the user cannot see anywhere. Every write path funnels through
 * here so no caller has to remember.
 */
export function normaliseUpc(upc: string | null | undefined): string | null {
  if (upc == null) return null;
  const trimmed = upc.trim();
  return trimmed === '' ? null : trimmed;
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
      upc: normaliseUpc(input.upc),
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
