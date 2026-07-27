import { and, eq } from 'drizzle-orm';
import { Tx } from '../db/tenant-db.service';
import { Product, products, TrackingType } from '../db/schema';

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
): Promise<Product> {
  const existing = await tx
    .select()
    .from(products)
    .where(and(eq(products.companyId, companyId), eq(products.sku, input.sku)))
    .limit(1);
  if (existing[0]) return existing[0];

  await tx
    .insert(products)
    .values({
      companyId,
      sku: input.sku,
      name: input.name,
      price: input.price,
      upc: input.upc,
      trackingType: input.trackingType,
      needsReview: input.needsReview ?? false,
    })
    .onConflictDoNothing({ target: [products.companyId, products.sku] });

  const [row] = await tx
    .select()
    .from(products)
    .where(and(eq(products.companyId, companyId), eq(products.sku, input.sku)))
    .limit(1);
  return row;
}
