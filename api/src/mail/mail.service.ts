import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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

/**
 * Resend's sandbox sender (onboarding@resend.dev) only delivers to the address
 * on the Resend account. Detecting that specific rejection lets the admin UI
 * explain the real cause instead of showing a generic failure.
 */
const SANDBOX_REASON =
  'sandbox sender: recipient not allowed — verify a domain to invite external addresses';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string | undefined {
    return this.config.get<string>('RESEND_API_KEY') || undefined;
  }

  /**
   * Resend's send endpoint. Overridable (RESEND_API_URL) purely as a test seam so
   * the sandbox-rejection path can be exercised against a stub; production never
   * sets it.
   */
  private get endpoint(): string {
    return (
      this.config.get<string>('RESEND_API_URL') || 'https://api.resend.com/emails'
    );
  }

  private get from(): string {
    return (
      this.config.get<string>('MAIL_FROM') ||
      `${PRODUCT_NAME} <onboarding@resend.dev>`
    );
  }

  /**
   * live  — actually POST to Resend.
   * console — log the email (including the accept URL) and report success.
   * Console is the default whenever MAIL_MODE is unset or no API key exists, so
   * local dev and tests need no key and send no mail.
   */
  private get mode(): 'live' | 'console' {
    const mode = (this.config.get<string>('MAIL_MODE') || '').toLowerCase();
    if (mode === 'live' && this.apiKey) return 'live';
    if (mode === 'live' && !this.apiKey) {
      this.logger.warn('MAIL_MODE=live but RESEND_API_KEY is unset — using console mode.');
    }
    return 'console';
  }

  async sendInvitationEmail(to: string, data: InvitationEmailData): Promise<MailResult> {
    const subject = `You're invited to ${data.companyName} on ${PRODUCT_NAME}`;
    const html = invitationHtml(data);
    const text = invitationText(data);

    if (this.mode === 'console') {
      this.logger.log(
        [
          '',
          '──────── invitation email (console mode) ────────',
          `To:      ${to}`,
          `From:    ${this.from}`,
          `Subject: ${subject}`,
          '',
          text,
          '─────────────────────────────────────────────────',
        ].join('\n'),
      );
      return { ok: true };
    }

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: this.from, to: [to], subject, html, text }),
      });
      if (res.ok) return { ok: true };

      const body = await res.text();
      const reason = this.isSandboxRecipientRejection(res.status, body)
        ? SANDBOX_REASON
        : `Resend responded ${res.status}: ${body.slice(0, 300)}`;
      this.logger.error(`Invitation email to ${to} failed — ${reason}`);
      return { ok: false, error: reason };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown mail error';
      this.logger.error(`Invitation email to ${to} failed — ${reason}`);
      return { ok: false, error: reason.slice(0, 300) };
    }
  }

  /**
   * Resend rejects sandbox sends to anyone but the account owner with a 403
   * ("You can only send testing emails to your own email address"). Match
   * loosely so wording changes don't break detection.
   */
  private isSandboxRecipientRejection(status: number, body: string): boolean {
    if (status !== 403 && status !== 422) return false;
    const b = body.toLowerCase();
    return (
      b.includes('own email address') ||
      b.includes('testing emails') ||
      (b.includes('verify a domain') && b.includes('resend.dev')) ||
      b.includes('domain is not verified')
    );
  }
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function roleLabel(role: string): string {
  return role === 'COMPANY_ADMIN' ? 'Company Admin' : 'Store User';
}

function invitationHtml(d: InvitationEmailData): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e3e6ea;border-radius:12px;padding:28px;">
      <h1 style="margin:0 0 12px;font-size:20px;color:#2563eb;">You're invited to ${escapeHtml(d.companyName)}</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">
        ${escapeHtml(d.inviterName)} invited you to join
        <strong>${escapeHtml(d.companyName)}</strong> on ${PRODUCT_NAME} as
        <strong>${escapeHtml(roleLabel(d.role))}</strong>.
      </p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.5;">
        Click below to set your password and activate your account.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${d.acceptUrl}"
           style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;font-size:15px;">
          Accept invitation
        </a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">
        This invitation expires on <strong>${fmtDate(d.expiresAt)}</strong>.
      </p>
      <p style="margin:0 0 20px;font-size:13px;color:#6b7280;">
        If the button doesn't work, paste this link into your browser:<br />
        <span style="word-break:break-all;">${escapeHtml(d.acceptUrl)}</span>
      </p>
      <p style="margin:0;font-size:13px;color:#6b7280;">
        If you weren't expecting this, you can ignore this email.
      </p>
      <hr style="border:none;border-top:1px solid #e3e6ea;margin:20px 0 12px;" />
      <p style="margin:0;font-size:12px;color:#9ca3af;">${PRODUCT_NAME}</p>
    </div>
  </body>
</html>`;
}

function invitationText(d: InvitationEmailData): string {
  return [
    `You're invited to ${d.companyName}`,
    '',
    `${d.inviterName} invited you to join ${d.companyName} on ${PRODUCT_NAME} as ${roleLabel(d.role)}.`,
    '',
    'Set your password and activate your account:',
    d.acceptUrl,
    '',
    `This invitation expires on ${fmtDate(d.expiresAt)}.`,
    '',
    "If you weren't expecting this, you can ignore this email.",
    '',
    `— ${PRODUCT_NAME}`,
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
