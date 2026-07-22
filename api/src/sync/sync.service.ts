import { Inject, Injectable } from '@nestjs/common';
import { and, asc, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/drizzle.constants';
import { inventoryItems, outboxChanges } from '../db/schema';
import { SyncPushDto } from './dto/sync-push.dto';

@Injectable()
export class SyncService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Idempotent batch upsert of inventory coming FROM the local system.
   * Conflicts on (store_id, sku) are updated in place — never a blind insert.
   *
   * Note: push does NOT emit outbox rows. The outbox captures changes that
   * originate in the portal so the local agent can pull them; echoing pushed
   * changes back would create a sync loop.
   */
  async push(dto: SyncPushDto): Promise<{ received: number; upserted: number }> {
    const items = dto.items ?? [];
    if (items.length === 0) {
      return { received: 0, upserted: 0 };
    }

    await this.db.transaction(async (tx) => {
      for (const it of items) {
        const values = {
          ...(it.id ? { id: it.id } : {}),
          storeId: it.storeId,
          sku: it.sku,
          name: it.name,
          description: it.description ?? null,
          quantity: it.quantity ?? 0,
          price: it.price !== undefined ? String(it.price) : '0',
          updatedAt: new Date(),
          deletedAt: it.deletedAt ? new Date(it.deletedAt) : null,
        };

        await tx
          .insert(inventoryItems)
          .values(values)
          .onConflictDoUpdate({
            target: [inventoryItems.storeId, inventoryItems.sku],
            set: {
              name: values.name,
              description: values.description,
              quantity: values.quantity,
              price: values.price,
              updatedAt: values.updatedAt,
              deletedAt: values.deletedAt,
            },
          });
      }
    });

    return { received: items.length, upserted: items.length };
  }

  /** Undelivered outbox rows, oldest first. */
  async pending(limit?: number) {
    const rows = await this.db
      .select()
      .from(outboxChanges)
      .where(isNull(outboxChanges.deliveredAt))
      .orderBy(asc(outboxChanges.id))
      .limit(limit && limit > 0 ? limit : 500);
    return { count: rows.length, changes: rows };
  }

  /** Mark the given outbox rows delivered. Idempotent. */
  async ack(ids: number[]): Promise<{ acknowledged: number }> {
    if (ids.length === 0) return { acknowledged: 0 };

    const updated = await this.db
      .update(outboxChanges)
      .set({ deliveredAt: sql`now()` })
      .where(
        and(
          inArray(outboxChanges.id, ids),
          isNull(outboxChanges.deliveredAt),
        ),
      )
      .returning({ id: outboxChanges.id });

    return { acknowledged: updated.length };
  }
}
