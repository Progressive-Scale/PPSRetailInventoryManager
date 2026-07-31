import { Injectable, Logger } from '@nestjs/common';
import { MailService } from '../mail.service';
import {
  InvitationEmailData,
  MailResult,
  MAX_ERROR_LEN,
  PasswordResetEmailData,
} from '../mail.types';
import {
  invitationHtml,
  invitationSubject,
  invitationText,
  passwordResetHtml,
  passwordResetSubject,
  passwordResetText,
} from '../mail.templates';

export interface ResendMailOptions {
  apiKey: string;
  from: string;
  /** Overridable purely as a test seam; production leaves this at the default. */
  endpoint: string;
}

export const RESEND_DEFAULT_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend's sandbox sender (onboarding@resend.dev) only delivers to the address on
 * the Resend account. Detecting that specific rejection lets the admin UI explain
 * the real cause instead of showing a generic failure.
 */
const SANDBOX_REASON =
  'sandbox sender: recipient not allowed — verify a domain to invite external addresses';

/** Retained as an alternative provider — see README. Postmark is production. */
@Injectable()
export class ResendMailService extends MailService {
  private readonly logger = new Logger(ResendMailService.name);

  constructor(private readonly opts: ResendMailOptions) {
    super();
  }

  async sendInvitationEmail(
    to: string,
    data: InvitationEmailData,
  ): Promise<MailResult> {
    return this.send('Invitation', to, {
      subject: invitationSubject(data),
      html: invitationHtml(data),
      text: invitationText(data),
    });
  }

  async sendPasswordResetEmail(
    to: string,
    data: PasswordResetEmailData,
  ): Promise<MailResult> {
    return this.send('Password reset', to, {
      subject: passwordResetSubject(data),
      html: passwordResetHtml(data),
      text: passwordResetText(data),
    });
  }

  /**
   * One transport for every message type, so the sandbox detection below stays the
   * only copy of it. `label` appears in logs only.
   */
  private async send(
    label: string,
    to: string,
    msg: { subject: string; html: string; text: string },
  ): Promise<MailResult> {
    try {
      const res = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.opts.from,
          to: [to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        }),
      });
      if (res.ok) return { ok: true };

      const body = await res.text();
      const reason = this.isSandboxRecipientRejection(res.status, body)
        ? SANDBOX_REASON
        : `Resend responded ${res.status}: ${body.slice(0, MAX_ERROR_LEN)}`;
      this.logger.error(`${label} email to ${to} failed — ${reason}`);
      return { ok: false, error: reason };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown mail error';
      this.logger.error(`${label} email to ${to} failed — ${reason}`);
      return { ok: false, error: reason.slice(0, MAX_ERROR_LEN) };
    }
  }

  /**
   * The sandbox sender can only reach the Resend account's own address. Resend
   * expresses that rejection a few different ways (observed live):
   *   403 "You can only send testing emails to your own email address (…)"
   *   422 "Invalid `to` field. Please use our testing email address instead of
   *        domains like `example.com`. …"
   * plus the unverified-domain wording. Match loosely on the distinctive phrases
   * so a copy tweak on their side doesn't silently degrade to a generic error.
   */
  private isSandboxRecipientRejection(status: number, body: string): boolean {
    if (status !== 403 && status !== 422) return false;
    const b = body.toLowerCase();
    return (
      b.includes('own email address') ||
      b.includes('testing email') || // covers "testing email address" + "testing emails"
      b.includes('invalid `to` field') ||
      b.includes('verify a domain') ||
      b.includes('domain is not verified')
    );
  }
}
