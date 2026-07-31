import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import { User, users } from '../db/schema';
import { AuthUser } from './auth.types';
import { normaliseUsername } from './username.util';

/** Never leak the password hash to a caller. */
export interface PublicProfile {
  id: number;
  email: string;
  username: string;
  companyId: number | null;
  storeId: number | null;
  role: string;
  createdAt: Date;
}

const toPublic = (u: User): PublicProfile => ({
  id: u.id,
  email: u.email,
  username: u.username,
  companyId: u.companyId,
  storeId: u.storeId,
  role: u.role,
  createdAt: u.createdAt,
});

/**
 * A user acting on their own account: read it, rename themselves, change their
 * password. Everything here is scoped to `user.userId` from the token — there is
 * no id parameter to tamper with, so one user can never reach another's record.
 */
@Injectable()
export class ProfileService {
  constructor(private readonly tenantDb: TenantDbService) {}

  /**
   * PLATFORM_ADMIN rows have no company, so they cannot be read under a tenant
   * policy; those go through withBypass. Everyone else stays inside their company.
   */
  private run<T>(user: AuthUser, work: (tx: Tx) => Promise<T>): Promise<T> {
    return user.companyId == null
      ? this.tenantDb.withBypass(work)
      : this.tenantDb.withCompany(user.companyId, work);
  }

  private async load(tx: Tx, userId: number): Promise<User> {
    const [row] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!row) throw new NotFoundException('Account not found.');
    return row;
  }

  async me(user: AuthUser): Promise<PublicProfile> {
    return this.run(user, async (tx) => toPublic(await this.load(tx, user.userId)));
  }

  async changeUsername(user: AuthUser, input: string): Promise<PublicProfile> {
    const username = normaliseUsername(input);
    return this.run(user, async (tx) => {
      const current = await this.load(tx, user.userId);
      // Re-saving the same name is a no-op rather than a conflict: the row it would
      // collide with is the caller's own.
      if (current.username === username) return toPublic(current);
      try {
        const [updated] = await tx
          .update(users)
          .set({ username })
          .where(eq(users.id, user.userId))
          .returning();
        return toPublic(updated);
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw new ConflictException(
            'That username is already taken. Please choose another.',
          );
        }
        throw err;
      }
    });
  }

  /**
   * Note: this cannot sign other devices out. Tokens are stateless and there is no
   * revocation list, so a session opened before the change keeps working until its
   * 7-day expiry. Worth knowing before treating a password change as a way to lock
   * somebody out.
   */
  async changePassword(
    user: AuthUser,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ changed: true }> {
    return this.run(user, async (tx) => {
      const current = await this.load(tx, user.userId);
      if (!(await compare(currentPassword, current.passwordHash))) {
        // Deliberately 400, not 401. The request's own credentials — the bearer
        // token — are perfectly valid; it is a value in the body that is wrong. A
        // 401 here is indistinguishable from an expired session to any generic
        // client, and ours logs you out on one, which would mean a single typo
        // ejected you from the app.
        throw new BadRequestException('Current password is incorrect.');
      }
      await tx
        .update(users)
        .set({ passwordHash: await hash(newPassword, 10) })
        .where(eq(users.id, user.userId));
      return { changed: true as const };
    });
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      !!err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    );
  }
}
