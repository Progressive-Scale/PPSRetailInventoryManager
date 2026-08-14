import { and, eq, ne, or, SQL } from 'drizzle-orm';
import { Tx } from '../db/tenant-db.service';
import { notifications, stores, users, userStores } from '../db/schema';

/** The types addressed at the people who work a review queue. */
export type ReviewNotificationType =
  | 'CYCLE_COUNT_REVIEW'
  | 'ITEMS_NEED_REVIEW'
  | 'ITEMS_IDENTIFIED';

/**
 * Raise one notification per person who can act on a store's review queue: every company
 * admin, plus the managers assigned to that store.
 *
 * Addressed rather than broadcast, deliberately. A store-scoped notification with no user
 * is visible to everyone at that store — including the counter who handed the count in,
 * who cannot approve it and would be told about their own submission.
 *
 * Lives here rather than on either service because two very different callers need the
 * same audience: cycle counts (a person did something) and the import-check sweep (the
 * sync agent did, with no user at all).
 *
 * @param excludeUserId the actor, when there is one — nobody needs their own bell to tell
 *                      them about what they just did. Omit for machine-driven events.
 * @returns how many notifications were written.
 */
export async function notifyReviewers(
  tx: Tx,
  opts: {
    companyId: number;
    storeId: number;
    type: ReviewNotificationType;
    payload: Record<string, unknown>;
    excludeUserId?: number | null;
  },
): Promise<number> {
  const { companyId, storeId, type, payload, excludeUserId } = opts;

  const [store] = await tx
    .select({ name: stores.name })
    .from(stores)
    .where(eq(stores.id, storeId))
    .limit(1);

  const conds: SQL[] = [
    eq(users.companyId, companyId),
    eq(users.status, 'ACTIVE'),
    or(
      eq(users.role, 'COMPANY_ADMIN'),
      and(eq(users.role, 'STORE_MANAGER'), eq(userStores.storeId, storeId)),
    ) as SQL,
  ];
  if (excludeUserId != null) conds.push(ne(users.id, excludeUserId));

  const recipients = await tx
    .selectDistinct({ id: users.id })
    .from(users)
    .leftJoin(userStores, eq(userStores.userId, users.id))
    .where(and(...conds));
  if (recipients.length === 0) return 0;

  await tx.insert(notifications).values(
    recipients.map((r) => ({
      companyId,
      storeId,
      userId: r.id,
      type,
      payload: { ...payload, storeId, storeName: store?.name ?? null },
      status: 'UNREAD' as const,
    })),
  );
  return recipients.length;
}
