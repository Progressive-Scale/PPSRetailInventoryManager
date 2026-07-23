import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Deterministic hash for API keys (so we can look up by hash). */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Generate a new plaintext API key (shown to the user exactly once). */
export function generateApiKey(): string {
  return `pps_${randomBytes(24).toString('hex')}`;
}

/** Opaque invitation / token generator. */
export function generateToken(): string {
  return randomBytes(24).toString('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
