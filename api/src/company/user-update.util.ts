import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { Tx } from '../db/tenant-db.service';
import { User, stores, users, userStores } from '../db/schema';
import { UpdateUserDto } from './company.dto';

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
): Promise<PublicUser & { storeIds: number[] }> {
  const [existing] = await tx
    .select(publicUser)
    .from(users)
    .where(and(eq(users.id, id), eq(users.companyId, companyId)))
    .limit(1);
  if (!existing) throw new NotFoundException('User not found.');

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
  return { ...row, storeIds: links.map((l) => l.storeId) };
}
