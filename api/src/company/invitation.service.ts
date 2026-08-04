import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { Tx } from '../db/tenant-db.service';
import {
  Invitation,
  companies,
  invitationStores,
  invitations,
  stores,
  users,
} from '../db/schema';
import { Role } from '../auth/auth.types';
import { MailService } from '../mail/mail.service';
import {
  assertEmailNotTaken,
  buildAcceptUrl,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  supersedeLiveInvitations,
} from './invitation.util';

/** Safe projection: never hand out token_hash, which is the lookup key itself. */
const invitationPublic = {
  id: invitations.id,
  companyId: invitations.companyId,
  email: invitations.email,
  role: invitations.role,
  storeId: invitations.storeId,
  expiresAt: invitations.expiresAt,
  acceptedAt: invitations.acceptedAt,
  revokedAt: invitations.revokedAt,
  revokedByUserId: invitations.revokedByUserId,
  emailStatus: invitations.emailStatus,
  emailSentAt: invitations.emailSentAt,
  emailError: invitations.emailError,
  createdAt: invitations.createdAt,
};

export type PublicInvitation = Omit<Invitation, 'tokenHash'>;

/** What create/resend hand back: the row plus the one-time link. */
export interface InvitationResult extends PublicInvitation {
  /** The plaintext token appears ONLY here, and only to the admin who acted. */
  acceptUrl: string;
  acceptPath: string;
  emailWarning: string | null;
}

/** Role an invitation may grant. Never PLATFORM_ADMIN — that is not a tenant role. */
export type InvitableRole = Extract<Role, 'COMPANY_ADMIN' | 'STORE_USER'>;

export interface CreateInvitationInput {
  companyId: number;
  email: string;
  role: InvitableRole;
  /** Stores granted on accept. Empty = none (a company admin needs none). */
  storeIds?: number[];
  /** Who is acting. Null for a system actor with no user row. */
  actorUserId: number | null;
  /**
   * Shown in the email as the sender. Defaults to the actor's own address, which
   * is what a tenant admin wants; the platform admin passes its own label so an
   * invitee is not told a stranger's email invited them.
   */
  inviterName?: string;
}

/**
 * The one place invitations are issued, resent and revoked.
 *
 * Every caller passes its own `Tx`, so the SAME rules apply whether the work runs
 * company-scoped (a tenant admin, RLS on) or under bypass (a platform admin acting
 * on a tenant's behalf). Nothing here decides who may call it — that is the
 * controllers' guards — but every rule about invitations lives here, so no caller
 * can accidentally skip one: no inviting an existing user, at most one live link
 * per address, stores must belong to the company, and a failed send never loses
 * the invitation.
 */
@Injectable()
export class InvitationService {
  constructor(
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async create(
    tx: Tx,
    input: CreateInvitationInput,
  ): Promise<InvitationResult & { storeIds: number[] }> {
    const { companyId, email, role, actorUserId } = input;

    // Never invite an address that is already a user, and keep only one live
    // invitation per address (this one supersedes any earlier link).
    await assertEmailNotTaken(tx, companyId, email);
    await supersedeLiveInvitations(tx, companyId, email, actorUserId);

    const permitted = await this.assertStoresInCompany(
      tx,
      companyId,
      input.storeIds ?? [],
    );

    const token = generateInviteToken();
    const [row] = await tx
      .insert(invitations)
      .values({
        companyId,
        email: email.trim().toLowerCase(),
        role,
        // Mirrors the single-store case so older readers keep working.
        storeId: permitted.length === 1 ? permitted[0] : null,
        tokenHash: hashInviteToken(token),
        expiresAt: inviteExpiry(),
      })
      .returning(invitationPublic);

    if (permitted.length > 0) {
      await tx
        .insert(invitationStores)
        .values(
          permitted.map((storeId) => ({ companyId, invitationId: row.id, storeId })),
        );
    }

    const res = await this.deliver(tx, {
      companyId,
      id: row.id,
      email: row.email,
      role: row.role,
      expiresAt: row.expiresAt,
      token,
      actorUserId,
      inviterName: input.inviterName,
    });
    return { ...res, storeIds: permitted };
  }

  /**
   * New token + fresh expiry + new email; the previous link stops working. Revives
   * a revoked invitation, which is why any OTHER live link for the address has to
   * give way first — two redeemable links for one person is the bug this prevents.
   */
  async resend(
    tx: Tx,
    opts: {
      companyId: number;
      id: number;
      actorUserId: number | null;
      inviterName?: string;
    },
  ): Promise<InvitationResult> {
    const inv = await this.load(tx, opts.companyId, opts.id);
    if (inv.acceptedAt) {
      throw new BadRequestException('This invitation was already accepted.');
    }
    await assertEmailNotTaken(tx, opts.companyId, inv.email);
    await supersedeLiveInvitations(
      tx,
      opts.companyId,
      inv.email,
      opts.actorUserId,
      opts.id,
    );

    const token = generateInviteToken();
    const expiresAt = inviteExpiry();
    const [row] = await tx
      .update(invitations)
      .set({
        tokenHash: hashInviteToken(token),
        expiresAt,
        // Resending revives a revoked invite and clears the last send result.
        revokedAt: null,
        revokedByUserId: null,
        emailStatus: 'PENDING',
        emailSentAt: null,
        emailError: null,
      })
      .where(eq(invitations.id, opts.id))
      .returning(invitationPublic);

    return this.deliver(tx, {
      companyId: opts.companyId,
      id: row.id,
      email: row.email,
      role: row.role,
      expiresAt,
      token,
      actorUserId: opts.actorUserId,
      inviterName: opts.inviterName,
    });
  }

  /** Kill an unused link. Idempotent. */
  async revoke(
    tx: Tx,
    opts: { companyId: number; id: number; actorUserId: number | null },
  ): Promise<{ revoked: true; id: number; alreadyRevoked?: true }> {
    const inv = await this.load(tx, opts.companyId, opts.id);
    if (inv.revokedAt) return { revoked: true, id: opts.id, alreadyRevoked: true };
    if (inv.acceptedAt) {
      throw new BadRequestException(
        'This invitation was already accepted and cannot be revoked.',
      );
    }
    await tx
      .update(invitations)
      .set({ revokedAt: new Date(), revokedByUserId: opts.actorUserId })
      .where(eq(invitations.id, opts.id));
    return { revoked: true, id: opts.id };
  }

  /** Invitations of one company, newest first, each with the stores it grants. */
  async list(
    tx: Tx,
    companyId: number,
  ): Promise<(PublicInvitation & { storeIds: number[] })[]> {
    const rows = await tx
      .select(invitationPublic)
      .from(invitations)
      .where(eq(invitations.companyId, companyId))
      .orderBy(desc(invitations.id));

    const links = await tx
      .select({
        invitationId: invitationStores.invitationId,
        storeId: invitationStores.storeId,
      })
      .from(invitationStores)
      .where(eq(invitationStores.companyId, companyId));
    const byInvitation = new Map<number, number[]>();
    for (const l of links) {
      const list = byInvitation.get(l.invitationId) ?? [];
      list.push(l.storeId);
      byInvitation.set(l.invitationId, list);
    }
    return rows.map((r) => ({ ...r, storeIds: byInvitation.get(r.id) ?? [] }));
  }

  /** An invitation of THIS company, or 404. Never reaches another tenant's row. */
  async load(tx: Tx, companyId: number, id: number): Promise<PublicInvitation> {
    const [inv] = await tx
      .select(invitationPublic)
      .from(invitations)
      .where(and(eq(invitations.id, id), eq(invitations.companyId, companyId)))
      .limit(1);
    if (!inv) throw new NotFoundException('Invitation not found.');
    return inv;
  }

  /** Deduplicated, and every id proven to belong to the company. */
  private async assertStoresInCompany(
    tx: Tx,
    companyId: number,
    requested: number[],
  ): Promise<number[]> {
    const permitted = [...new Set(requested)];
    if (permitted.length === 0) return permitted;
    const owned = await tx
      .select({ id: stores.id })
      .from(stores)
      .where(and(eq(stores.companyId, companyId), inArray(stores.id, permitted)));
    if (owned.length !== permitted.length) {
      throw new BadRequestException('One or more stores are not in that company.');
    }
    return permitted;
  }

  /**
   * Send the invitation email and record the outcome. A failure never fails the
   * request: the row is marked FAILED with the reason and the response carries a
   * warning plus the accept URL so the admin can copy the link instead.
   */
  private async deliver(
    tx: Tx,
    opts: {
      companyId: number;
      id: number;
      email: string;
      role: string;
      expiresAt: Date;
      token: string;
      actorUserId: number | null;
      inviterName?: string;
    },
  ): Promise<InvitationResult> {
    const [company] = await tx
      .select({ name: companies.name, slug: companies.slug })
      .from(companies)
      .where(eq(companies.id, opts.companyId))
      .limit(1);
    if (!company) throw new NotFoundException('Company not found.');

    const inviterName =
      opts.inviterName ?? (await this.actorLabel(tx, opts.actorUserId));

    const acceptUrl = buildAcceptUrl({
      slug: company.slug,
      rootDomain: this.config.get<string>('ROOT_DOMAIN') ?? 'yourapp.local',
      token: opts.token,
      baseUrlOverride: this.config.get<string>('APP_BASE_URL') || undefined,
    });

    const result = await this.mail.sendInvitationEmail(opts.email, {
      companyName: company.name,
      inviterName,
      role: opts.role,
      acceptUrl,
      expiresAt: opts.expiresAt,
    });

    const [row] = await tx
      .update(invitations)
      .set(
        result.ok
          ? { emailStatus: 'SENT', emailSentAt: new Date(), emailError: null }
          : { emailStatus: 'FAILED', emailError: result.error ?? 'send failed' },
      )
      .where(eq(invitations.id, opts.id))
      .returning(invitationPublic);

    return {
      ...row,
      acceptUrl,
      acceptPath: `/accept-invite?token=${encodeURIComponent(opts.token)}`,
      emailWarning: result.ok
        ? null
        : 'Invitation created but the email failed to send — resend or copy the link.',
    };
  }

  private async actorLabel(tx: Tx, actorUserId: number | null): Promise<string> {
    if (actorUserId == null) return 'An administrator';
    const [actor] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, actorUserId))
      .limit(1);
    return actor?.email ?? 'An administrator';
  }
}
