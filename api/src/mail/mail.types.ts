/** Everything the invitation email needs to render. */
export interface InvitationEmailData {
  companyName: string;
  inviterName: string;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
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
