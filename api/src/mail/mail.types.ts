/** Everything the invitation email needs to render. */
export interface InvitationEmailData {
  companyName: string;
  inviterName: string;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
}

/** Everything the password-reset email needs to render. */
export interface PasswordResetEmailData {
  /** Company name, or the product name for a platform admin (who has no company). */
  companyName: string;
  /** Whose account the link belongs to, so a misdirected email is obvious. */
  username: string;
  resetUrl: string;
  expiresAt: Date;
  /** How long the link stays valid, stated plainly in the email. */
  ttlMinutes: number;
}

/** Outcome of a send attempt. Never throws — callers record the result. */
export interface MailResult {
  ok: boolean;
  /** Human-readable failure reason, stored on the invitation when !ok. */
  error?: string;
}

export const PRODUCT_NAME = 'PPS Retail Inventory';

/** Failure reasons are shown verbatim to company admins, so keep them actionable. */
export const MAX_ERROR_LEN = 300;
