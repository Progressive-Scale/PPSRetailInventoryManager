import { createHash, randomBytes } from 'node:crypto';
import { Invitation } from '../db/schema';

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
