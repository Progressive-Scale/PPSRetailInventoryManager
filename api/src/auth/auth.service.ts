import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  Company,
  invitationStores,
  invitations,
  notifications,
  stores,
  User,
  users,
  userStores,
} from '../db/schema';
import { HostContext } from '../tenancy/tenant-context';
import {
  hashInviteToken,
  invitationState,
  invitationStateMessage,
} from '../company/invitation.util';
import { AuthUser, JwtPayload, isStoreScoped } from './auth.types';
import { looksLikeEmail, normaliseUsername } from './username.util';

@Injectable()
export class AuthService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Sign in with a username or an email address. Which one it is comes from the
   * value itself — a username can never contain '@' — so nothing has to be told
   * apart by a flag or a second field. Both are compared lowercase.
   */
  async login(host: HostContext, identifier: string, password: string) {
    const normalized = identifier.trim().toLowerCase();
    const match = looksLikeEmail(normalized)
      ? eq(users.email, normalized)
      : sql`lower(${users.username}) = ${normalized}`;

    if (host.kind === 'admin') {
      return this.tenantDb.withBypass(async (tx) => {
        const [u] = await tx
          .select()
          .from(users)
          .where(
            and(match, eq(users.role, 'PLATFORM_ADMIN'), isNull(users.companyId)),
          )
          .limit(1);
        return this.finishLogin(u, password);
      });
    }

    if (host.kind === 'company') {
      return this.tenantDb.withCompany(host.company.id, async (tx) => {
        const [u] = await tx.select().from(users).where(match).limit(1);
        return this.finishLogin(u, password, tx);
      });
    }

    throw new UnauthorizedException('Invalid host for login.');
  }

  async acceptInvite(
    company: Company,
    token: string,
    username: string,
    password: string,
  ) {
    return this.tenantDb.withCompany(company.id, async (tx) => {
      const [inv] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, hashInviteToken(token)))
        .limit(1);

      // Re-validated at SUBMIT time: an invitation revoked (or expired) between
      // page load and submit must fail here with the same message the page shows.
      const state = invitationState(inv);
      if (state !== 'VALID') {
        const message = invitationStateMessage(state);
        if (state === 'INVALID') throw new NotFoundException(message);
        throw new BadRequestException(message);
      }

      // Stores the invitation grants. invitation_stores is the source of truth;
      // fall back to the legacy single store_id for rows predating it.
      const granted = await tx
        .select({ storeId: invitationStores.storeId })
        .from(invitationStores)
        .where(eq(invitationStores.invitationId, inv.id));
      let storeIds = [...new Set(granted.map((g) => g.storeId))];
      if (storeIds.length === 0 && inv.storeId != null) storeIds = [inv.storeId];

      const wantedUsername = normaliseUsername(username);
      const email = inv.email.trim().toLowerCase();

      let created: User | undefined;
      try {
        [created] = await tx
          .insert(users)
          .values({
            companyId: company.id,
            // The active store is only implied when a single store was granted;
            // multi-store users choose theirs at login.
            storeId: storeIds.length === 1 ? storeIds[0] : null,
            email,
            username: wantedUsername,
            passwordHash: await hash(password, 10),
            role: inv.role,
            status: 'ACTIVE',
          })
          .returning();
      } catch (err) {
        // Two different unique indexes can fire here, and the caller needs to know
        // which: the email one means the invitation is moot, the username one means
        // retry with a different name. Checking the DB beforehand would still race,
        // so the constraint stays the arbiter and we only translate its complaint.
        if (this.isUniqueViolation(err)) {
          if (this.violatedConstraint(err) === 'users_company_username_uniq') {
            throw new ConflictException(
              'That username is already taken. Please choose another.',
            );
          }
          throw new BadRequestException('A user with that email already exists.');
        }
        throw err;
      }

      // Every granted store becomes a permitted store for the new user.
      if (storeIds.length > 0) {
        await tx
          .insert(userStores)
          .values(
            storeIds.map((storeId) => ({
              companyId: company.id,
              userId: created!.id,
              storeId,
            })),
          )
          .onConflictDoNothing();
      }

      await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(eq(invitations.id, inv.id));

      // Tell the company's admins somebody joined. Company-wide (no store), so it
      // reaches admins regardless of which store they are working in.
      await tx.insert(notifications).values({
        companyId: company.id,
        storeId: null,
        type: 'INVITE_ACCEPTED',
        payload: {
          userId: created!.id,
          email: created!.email,
          username: created!.username,
          role: created!.role,
          storeIds,
        },
        status: 'UNREAD',
      });

      return this.buildResponse(created!, tx);
    });
  }

  /** Stores the signed-in user may access, for a store switcher. */
  async myStores(user: AuthUser) {
    const companyId = user.companyId;
    if (companyId == null) return [];
    return this.tenantDb.withCompany(companyId, (tx) =>
      tx
        .select({ id: stores.id, name: stores.name })
        .from(userStores)
        .innerJoin(stores, eq(stores.id, userStores.storeId))
        .where(
          and(eq(userStores.companyId, companyId), eq(userStores.userId, user.userId)),
        )
        .orderBy(asc(stores.name)),
    );
  }

  /**
   * Switch the active store — a user permitted several stores picks one at login.
   * Validates membership and issues a fresh token carrying that store.
   */
  async selectStore(user: AuthUser, storeId: number) {
    const companyId = user.companyId;
    if (companyId == null) throw new BadRequestException('Not a company user.');
    return this.tenantDb.withCompany(companyId, async (tx) => {
      const [allowed] = await tx
        .select({ id: userStores.id })
        .from(userStores)
        .where(
          and(
            eq(userStores.companyId, companyId),
            eq(userStores.userId, user.userId),
            eq(userStores.storeId, storeId),
          ),
        )
        .limit(1);
      if (!allowed) throw new BadRequestException('That store is not assigned to you.');
      const [updated] = await tx
        .update(users)
        .set({ storeId })
        .where(eq(users.id, user.userId))
        .returning();
      return this.buildResponse(updated, tx);
    });
  }

  /**
   * Sign a user in without a password, for a flow that has already proven identity
   * another way — currently redeeming a password-reset link. Pass the transaction
   * that flow is running in so the permitted-store list reflects uncommitted work.
   */
  issueSessionFor(user: User, tx?: Tx) {
    return this.buildResponse(user, tx);
  }

  private async finishLogin(user: User | undefined, password: string, tx?: Tx) {
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      !(await compare(password, user.passwordHash))
    ) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.buildResponse(user, tx);
  }

  private async buildResponse(user: User, tx?: Tx) {
    // Stores this user may access. When several are permitted and none is active
    // yet, the client must call POST /auth/select-store before working.
    let availableStores: Array<{ id: number; name: string }> = [];
    if (tx && user.companyId != null) {
      availableStores = await tx
        .select({ id: stores.id, name: stores.name })
        .from(userStores)
        .innerJoin(stores, eq(stores.id, userStores.storeId))
        .where(
          and(
            eq(userStores.companyId, user.companyId),
            eq(userStores.userId, user.id),
          ),
        )
        .orderBy(asc(stores.name));
    }
    // Single permitted store: activate it implicitly so nothing needs to prompt.
    let activeStoreId = user.storeId;
    if (activeStoreId == null && availableStores.length === 1 && tx) {
      activeStoreId = availableStores[0].id;
      await tx.update(users).set({ storeId: activeStoreId }).where(eq(users.id, user.id));
    }
    const payload: JwtPayload = {
      sub: user.id,
      companyId: user.companyId,
      storeId: activeStoreId,
      role: user.role,
    };
    return {
      access_token: await this.jwt.signAsync(payload),
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        companyId: user.companyId,
        storeId: activeStoreId,
        role: user.role,
      },
      availableStores,
      // True when the user must choose before the app can scope their work.
      storeSelectionRequired:
        isStoreScoped(user.role) && activeStoreId == null && availableStores.length > 1,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      !!err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    );
  }

  /** Which unique index a 23505 came from, so the message can name the real clash. */
  private violatedConstraint(err: unknown): string | undefined {
    if (!err || typeof err !== 'object') return undefined;
    return (err as { constraint?: string }).constraint;
  }
}
