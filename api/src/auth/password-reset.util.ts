import { createHash, randomBytes } from 'node:crypto';
import { PasswordReset } from '../db/schema';

/**
 * Whether a reset request tells the caller that an address is not registered.
 *
 * TRUE (current behaviour, requested explicitly) gives a clear "no account with
 * that email" error, which is far friendlier when someone mistypes their own
 * address. The cost is account enumeration: anyone can probe this endpoint to
 * learn which addresses belong to users of a tenant. The endpoint is rate-limited
 * to blunt that, but it does not remove it.
 *
 * Set this to false for the standard privacy-preserving behaviour — identical
 * "check your email" response either way, and no email sent for an unknown
 * address. Nothing else has to change.
 */
export const REVEAL_UNKNOWN_EMAIL = true;

/**
 * Deliberately short. A reset link is a password equivalent sitting in an inbox,
 * so it should stop working long before an invitation would (7 days).
 */
export const RESET_TTL_MINUTES = 60;

/** 32 random bytes, URL-safe. Appears exactly once, in the emailed reset URL. */
export function generateResetToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is stored; lookups hash the presented token. */
export function hashResetToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function resetExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + RESET_TTL_MINUTES * 60_000);
}

export type ResetState = 'VALID' | 'INVALID' | 'USED' | 'SUPERSEDED' | 'EXPIRED';

/**
 * Order matters: used beats superseded beats expired, so the message always names
 * the most specific reason the link stopped working.
 */
export function resetState(
  row: Pick<PasswordReset, 'usedAt' | 'supersededAt' | 'expiresAt'> | undefined,
  now: Date = new Date(),
): ResetState {
  if (!row) return 'INVALID';
  if (row.usedAt) return 'USED';
  if (row.supersededAt) return 'SUPERSEDED';
  if (row.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'VALID';
}

export function resetStateMessage(state: ResetState): string {
  switch (state) {
    case 'USED':
      return 'This reset link has already been used. Request a new one if you still need to change your password.';
    case 'SUPERSEDED':
      return 'A newer reset link was requested, so this one no longer works. Use the most recent email.';
    case 'EXPIRED':
      return `This reset link has expired — they are only valid for ${RESET_TTL_MINUTES} minutes. Request a new one.`;
    case 'INVALID':
      return 'This reset link is not valid.';
    case 'VALID':
      return '';
  }
}

/**
 * Reset URL on the user's own host: their company subdomain, or the admin host for
 * a platform admin. APP_BASE_URL overrides the origin for localhost testing, where
 * subdomains are awkward.
 */
export function buildResetUrl(opts: {
  /** Company slug, or null for a platform admin (admin host). */
  slug: string | null;
  rootDomain: string;
  token: string;
  baseUrlOverride?: string;
}): string {
  const query = `/reset-password?token=${encodeURIComponent(opts.token)}`;
  if (opts.baseUrlOverride) {
    return `${opts.baseUrlOverride.replace(/\/+$/, '')}${query}`;
  }
  const host = opts.slug ?? 'admin';
  return `https://${host}.${opts.rootDomain}${query}`;
}
