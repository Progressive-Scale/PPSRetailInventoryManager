import { and, eq } from 'drizzle-orm';
import { Tx } from '../db/tenant-db.service';
import { Product, products } from '../db/schema';

/**
 * The catalog is the source of truth for a SKU's name/price/UPC. When new
 * inventory arrives (portal create, sync handoff), we resolve the product by
 * (company, sku), creating it from the incoming data if it doesn't exist yet.
 * Idempotent + concurrency-safe via ON CONFLICT.
 */
export async function resolveOrCreateProduct(
  tx: Tx,
  companyId: number,
  sku: string,
  name: string,
  price: string,
  upc: string | null,
): Promise<Product> {
  const existing = await tx
    .select()
    .from(products)
    .where(and(eq(products.companyId, companyId), eq(products.sku, sku)))
    .limit(1);
  if (existing[0]) return existing[0];

  await tx
    .insert(products)
    .values({ companyId, sku, name, price, upc })
    .onConflictDoNothing({ target: [products.companyId, products.sku] });

  const [row] = await tx
    .select()
    .from(products)
    .where(and(eq(products.companyId, companyId), eq(products.sku, sku)))
    .limit(1);
  return row;
}
