import { ConflictException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { Invitation, invitations, users } from '../db/schema';
import { Tx } from '../db/tenant-db.service';

/** Normalised form used for storage and for every uniqueness comparison. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * An address that already belongs to a user must not be invited: accept always
 * creates a NEW account, so such an invitation could never be redeemed.
 */
export async function assertEmailNotTaken(
  tx: Tx,
  companyId: number,
  email: string,
): Promise<void> {
  const [existing] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.companyId, companyId), eq(users.email, normaliseEmail(email))))
    .limit(1);
  if (existing) {
    throw new ConflictException(
      'That email already belongs to a user — edit the existing user instead of inviting them again.',
    );
  }
}

/**
 * Keeps at most ONE live invitation per address: revokes any earlier
 * not-yet-accepted invitation before a new one is issued, so re-inviting REPLACES
 * rather than adding a second working link. Without this an older link would
 * still be redeemable and would apply its own (stale) role and stores.
 * Returns how many invitations were superseded.
 */
export async function supersedeLiveInvitations(
  tx: Tx,
  companyId: number,
  email: string,
  revokedByUserId: number | null,
  /** Invitation to leave alone — used by resend, which revives its own row. */
  exceptId?: number,
): Promise<number> {
  const superseded = await tx
    .update(invitations)
    .set({ revokedAt: new Date(), revokedByUserId })
    .where(
      and(
        eq(invitations.companyId, companyId),
        sql`lower(${invitations.email}) = ${normaliseEmail(email)}`,
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        ...(exceptId != null ? [ne(invitations.id, exceptId)] : []),
      ),
    )
    .returning({ id: invitations.id });
  return superseded.length;
}

/** Lifecycle state of an invitation token, evaluated in a fixed order. */
export type InvitationState =
  | 'VALID'
  | 'INVALID'
  | 'REVOKED'
  | 'ALREADY_ACCEPTED'
  | 'EXPIRED';

export const INVITE_TTL_DAYS = 7;

/** 32 random bytes, URL-safe (base64url). Shown exactly once, in the accept URL. */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is stored; lookups hash the presented token. */
export function hashInviteToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function inviteExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + INVITE_TTL_DAYS * 86_400_000);
}

/**
 * Order matters: revoked beats accepted beats expired, so a revoked link always
 * reports REVOKED even if it is also past its expiry.
 */
export function invitationState(
  inv: Pick<Invitation, 'revokedAt' | 'acceptedAt' | 'expiresAt'> | undefined,
  now: Date = new Date(),
): InvitationState {
  if (!inv) return 'INVALID';
  if (inv.revokedAt) return 'REVOKED';
  if (inv.acceptedAt) return 'ALREADY_ACCEPTED';
  if (inv.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'VALID';
}

/** The message shown to an invitee for a non-acceptable state. */
export function invitationStateMessage(state: InvitationState): string {
  switch (state) {
    case 'EXPIRED':
      return 'This invitation has expired. Ask your administrator to send a new one.';
    case 'REVOKED':
      return 'This invitation was revoked. Contact your administrator if you believe this is a mistake.';
    case 'ALREADY_ACCEPTED':
      return 'This invitation was already used.';
    case 'INVALID':
      return 'This invitation link is not valid.';
    case 'VALID':
      return '';
  }
}

/**
 * Accept URL on the INVITEE company's own subdomain (not the requester's host):
 *   https://{slug}.{ROOT_DOMAIN}/accept-invite?token=…
 * APP_BASE_URL overrides the origin for localhost testing, where subdomains are
 * awkward (e.g. http://localhost:4200).
 */
export function buildAcceptUrl(opts: {
  slug: string;
  rootDomain: string;
  token: string;
  baseUrlOverride?: string;
}): string {
  const query = `/accept-invite?token=${encodeURIComponent(opts.token)}`;
  if (opts.baseUrlOverride) {
    return `${opts.baseUrlOverride.replace(/\/+$/, '')}${query}`;
  }
  return `https://${opts.slug}.${opts.rootDomain}${query}`;
}
