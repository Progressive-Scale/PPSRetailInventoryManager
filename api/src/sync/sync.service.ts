import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TenantDbService } from '../db/tenant-db.service';
import { inventoryItems, inventoryTransactions, outboxReturns, stores } from '../db/schema';
import { HandoffItemDto } from './dto/sync.dto';
import { resolveOrCreateProduct } from '../products/product-catalog';

export type HandoffAck =
  | { serial: string; status: 'accepted' }
  | { serial: string; status: 'already_exists' }
  | { serial: string; status: 'error'; reason: string };

@Injectable()
export class SyncService {
  constructor(private readonly tenantDb: TenantDbService) {}

  /**
   * Idempotent ingestion of items shipped to a store. Each serial is processed
   * in its own transaction so one bad item does not roll back the batch.
   * Redelivery of the same serial does NOT create a duplicate item or ledger
   * row (returns already_exists, refreshing mutable fields).
   */
  async handoffs(
    companyId: number,
    items: HandoffItemDto[],
  ): Promise<{ results: HandoffAck[] }> {
    const results: HandoffAck[] = [];
    for (const it of items) {
      try {
        const ack = await this.tenantDb.withCompany(companyId, async (tx) => {
          const [store] = await tx
            .select()
            .from(stores)
            .where(
              and(
                eq(stores.companyId, companyId),
                eq(stores.externalBuildingId, it.storeExternalBuildingId),
              ),
            )
            .limit(1);
          if (!store) {
            return {
              serial: it.serial,
              status: 'error',
              reason: `unknown store building '${it.storeExternalBuildingId}'`,
            } as HandoffAck;
          }

          const [existing] = await tx
            .select()
            .from(inventoryItems)
            .where(
              and(
                eq(inventoryItems.companyId, companyId),
                eq(inventoryItems.serial, it.serial),
              ),
            )
            .limit(1);

          const price = it.price !== undefined ? String(it.price) : '0';

          // Catalog drives new items: resolve (or create) the product for this
          // SKU; the item inherits its name / price / upc.
          const product = await resolveOrCreateProduct(
            tx,
            companyId,
            it.sku,
            it.name,
            price,
            null,
          );

          if (existing) {
            // Idempotent: relink + refresh from the catalog, no new item/ledger.
            await tx
              .update(inventoryItems)
              .set({
                productId: product.id,
                sku: product.sku,
                name: product.name,
                description: it.description ?? null,
                price: product.price,
                upc: product.upc,
                updatedAt: new Date(),
              })
              .where(eq(inventoryItems.id, existing.id));
            return { serial: it.serial, status: 'already_exists' } as HandoffAck;
          }

          const [item] = await tx
            .insert(inventoryItems)
            .values({
              companyId,
              storeId: store.id,
              productId: product.id,
              serial: it.serial,
              sku: product.sku,
              name: product.name,
              description: it.description ?? null,
              price: product.price,
              upc: product.upc,
              status: 'ON_HAND',
              receivedAt: new Date(),
            })
            .returning();

          await tx.insert(inventoryTransactions).values({
            companyId,
            storeId: store.id,
            itemId: item.id,
            type: 'RECEIPT',
            quantityDelta: 1,
            note: 'Handoff from sync agent',
            source: 'SYNC',
          });

          return { serial: it.serial, status: 'accepted' } as HandoffAck;
        });
        results.push(ack);
      } catch (err) {
        const reason =
          err instanceof Error ? err.message.slice(0, 200) : 'error';
        results.push({ serial: it.serial, status: 'error', reason });
      }
    }
    return { results };
  }

  /** Oldest-first undelivered returns for the agent to pull. */
  async pendingReturns(companyId: number, limit?: number) {
    const take = limit && limit > 0 ? Math.min(limit, 500) : 100;
    return this.tenantDb.withCompany(companyId, async (tx) => {
      const rows = await tx
        .select()
        .from(outboxReturns)
        .where(
          and(
            eq(outboxReturns.companyId, companyId),
            isNull(outboxReturns.deliveredAt),
          ),
        )
        .orderBy(asc(outboxReturns.id))
        .limit(take);
      return { count: rows.length, returns: rows };
    });
  }

  /** Mark returns delivered. Idempotent. */
  async ackReturns(companyId: number, ids: number[]) {
    if (ids.length === 0) return { acknowledged: 0 };
    return this.tenantDb.withCompany(companyId, async (tx) => {
      const updated = await tx
        .update(outboxReturns)
        .set({ deliveredAt: sql`now()` })
        .where(
          and(
            eq(outboxReturns.companyId, companyId),
            inArray(outboxReturns.id, ids),
            isNull(outboxReturns.deliveredAt),
          ),
        )
        .returning({ id: outboxReturns.id });
      return { acknowledged: updated.length };
    });
  }
}
