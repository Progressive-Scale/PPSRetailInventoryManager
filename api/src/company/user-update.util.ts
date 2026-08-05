import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { Tx } from '../db/tenant-db.service';
import { User, stores, users, userStores } from '../db/schema';
import { UpdateUserDto } from './company.dto';
import { AuditActor, AuditService, diffFields } from '../audit/audit.service';

/** Safe projection (never expose password_hash). */
export const publicUser = {
  id: users.id,
  companyId: users.companyId,
  storeId: users.storeId,
  email: users.email,
  username: users.username,
  role: users.role,
  status: users.status,
  createdAt: users.createdAt,
};

/** Exactly what `publicUser` selects — the user row minus its password hash. */
export type PublicUser = Omit<User, 'passwordHash'>;

/**
 * Apply a user patch within one company. Shared by the company-admin endpoint and
 * the platform-admin one so both enforce the same invariants — most importantly
 * that a user's ACTIVE store stays inside their permitted set, which is easy to
 * break from a second code path and only shows up later as a session scoped to a
 * store the user is no longer allowed in.
 *
 * The caller supplies the transaction and the company, and is responsible for
 * deciding who may act (guards) — this function trusts `companyId` completely and
 * scopes every statement to it.
 */
export async function updateCompanyUser(
  tx: Tx,
  companyId: number,
  id: number,
  dto: UpdateUserDto,
  /**
   * Who is doing this, so the change is attributable. Optional only so the function stays
   * callable from a context with no actor; both real callers pass it, because a role change
   * nobody is recorded as making is exactly the gap the audit trail exists to close.
   */
  audit?: {
    service: AuditService;
    actor: AuditActor;
    /** Extra context for the event (e.g. that a platform admin acted). */
    details?: Record<string, unknown>;
  },
): Promise<PublicUser & { storeIds: number[] }> {
  const [existing] = await tx
    .select(publicUser)
    .from(users)
    .where(and(eq(users.id, id), eq(users.companyId, companyId)))
    .limit(1);
  if (!existing) throw new NotFoundException('User not found.');

  // The permitted set as it stood, so a reassignment can be reported as a change from
  // something rather than as a bare new list.
  const beforeStoreIds = (
    await tx
      .select({ storeId: userStores.storeId })
      .from(userStores)
      .where(and(eq(userStores.userId, id), eq(userStores.companyId, companyId)))
  ).map((l) => l.storeId);

  // Replace the permitted-store set, validating every id is in-company.
  let permitted: number[] | undefined;
  if (dto.storeIds !== undefined) {
    permitted = [...new Set(dto.storeIds)];
    if (permitted.length > 0) {
      const owned = await tx
        .select({ id: stores.id })
        .from(stores)
        .where(and(eq(stores.companyId, companyId), inArray(stores.id, permitted)));
      if (owned.length !== permitted.length) {
        throw new BadRequestException('One or more stores are not in your company.');
      }
    }
    await tx
      .delete(userStores)
      .where(and(eq(userStores.userId, id), eq(userStores.companyId, companyId)));
    if (permitted.length > 0) {
      await tx
        .insert(userStores)
        .values(permitted.map((storeId) => ({ companyId, userId: id, storeId })));
    }
  }

  const patch: Record<string, unknown> = {};
  if (dto.role !== undefined) patch.role = dto.role;
  if (dto.status !== undefined) patch.status = dto.status;
  if (dto.storeId !== undefined) patch.storeId = dto.storeId;

  // Keep the active store consistent with the permitted set: it must be one
  // of them (auto-pick when there's exactly one, clear when it's no longer allowed).
  if (permitted !== undefined) {
    const active = (dto.storeId !== undefined ? dto.storeId : existing.storeId) ?? null;
    if (permitted.length === 0) patch.storeId = null;
    else if (active == null || !permitted.includes(active)) {
      patch.storeId = permitted.length === 1 ? permitted[0] : null;
    }
  } else if (dto.storeId != null) {
    const [allowed] = await tx
      .select({ id: userStores.id })
      .from(userStores)
      .where(
        and(
          eq(userStores.userId, id),
          eq(userStores.storeId, dto.storeId),
          eq(userStores.companyId, companyId),
        ),
      )
      .limit(1);
    if (!allowed) {
      throw new BadRequestException(
        'That store is not one of the user’s assigned stores.',
      );
    }
  }

  let row = existing;
  if (Object.keys(patch).length > 0) {
    [row] = await tx
      .update(users)
      .set(patch)
      .where(and(eq(users.id, id), eq(users.companyId, companyId)))
      .returning(publicUser);
  }
  const links = await tx
    .select({ storeId: userStores.storeId })
    .from(userStores)
    .where(and(eq(userStores.userId, id), eq(userStores.companyId, companyId)));
  const after = links.map((l) => l.storeId);

  if (audit) {
    const target = { entityType: 'USER' as const, entityId: id };
    const details = { email: existing.email, ...(audit.details ?? {}) };

    // Suspending someone is a lifecycle event, not a field edit: "Dana suspended Ravi" is
    // what an admin scans the log for, and `UPDATED status=SUSPENDED` says it less clearly.
    if (patch.status !== undefined && patch.status !== existing.status) {
      await audit.service.record(
        tx,
        companyId,
        audit.actor,
        target,
        patch.status === 'ACTIVE' ? 'REACTIVATED' : 'DEACTIVATED',
        { details },
      );
    }
    // role and the ACTIVE store as ordinary per-field rows. store_id may be adjusted by the
    // consistency rules above rather than requested outright, and the diff is against the
    // applied patch, so the log records what actually happened to the row.
    await audit.service.recordChanges(
      tx,
      companyId,
      audit.actor,
      target,
      diffFields(existing as unknown as Record<string, unknown>, patch, {
        fields: ['role', 'storeId'],
        columnFor: { storeId: 'store_id' },
      }),
      details,
    );
    // The permitted set is a junction table, not a column, so it is diffed by hand — and
    // only reported when the membership really moved (order is not a change).
    const sameSet =
      [...beforeStoreIds].sort((a, b) => a - b).join(',') ===
      [...after].sort((a, b) => a - b).join(',');
    if (permitted !== undefined && !sameSet) {
      await audit.service.record(tx, companyId, audit.actor, target, 'UPDATED', {
        field: 'store_ids',
        oldValue: beforeStoreIds.join(',') || null,
        newValue: after.join(',') || null,
        details,
      });
    }
  }

  return { ...row, storeIds: after };
}
