import { Injectable, Logger } from '@nestjs/common';
import { MailService } from '../mail.service';
import {
  InvitationEmailData,
  MailAttachment,
  MailResult,
  MAX_ERROR_LEN,
  PasswordResetEmailData,
  ReportEmailData,
} from '../mail.types';
import {
  invitationHtml,
  invitationSubject,
  invitationText,
  passwordResetHtml,
  passwordResetSubject,
  passwordResetText,
  reportHtml,
  reportSubject,
  reportText,
} from '../mail.templates';

export interface PostmarkMailOptions {
  serverToken: string;
  from: string;
  /**
   * Transactional stream. Invitations are transactional, so this must never point
   * at a broadcast stream (those are for bulk/marketing and are throttled and
   * unsubscribe-tracked differently).
   */
  messageStream: string;
  /** Overridable purely as a test seam; production leaves this at the default. */
  endpoint: string;
}

export const POSTMARK_DEFAULT_ENDPOINT = 'https://api.postmarkapp.com/email';
export const POSTMARK_DEFAULT_STREAM = 'outbound';

/**
 * Postmark's documented ErrorCodes for the cases an admin can actually act on.
 * https://postmarkapp.com/developer/api/overview#error-codes
 */
const enum PostmarkError {
  /** Invalid email request — malformed/unusable To address. */
  InvalidEmailRequest = 300,
  /** Sender signature exists but has not been confirmed. */
  SenderSignatureNotConfirmed = 400,
  /** No sender signature at all for this From address. */
  SenderSignatureNotFound = 401,
  /** Recipient is suppressed after a hard bounce or spam complaint. */
  InactiveRecipient = 406,
}

/** Current production provider — see README. */
@Injectable()
export class PostmarkMailService extends MailService {
  private readonly logger = new Logger(PostmarkMailService.name);

  constructor(private readonly opts: PostmarkMailOptions) {
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
   * One transport for every message type, so the failure mapping below stays the
   * only copy of it. `label` appears in logs only.
   */
  async sendReportEmail(
    to: string[],
    data: ReportEmailData,
    attachments: MailAttachment[],
  ): Promise<MailResult> {
    const names = attachments.map((a) => a.filename);
    return this.send(
      'report',
      // Postmark takes a comma-separated list, capped at 50 recipients.
      to.join(','),
      {
        subject: reportSubject(data),
        html: reportHtml(data, names),
        text: reportText(data, names),
      },
      attachments,
    );
  }

  private async send(
    label: string,
    to: string,
    msg: { subject: string; html: string; text: string },
    attachments: MailAttachment[] = [],
  ): Promise<MailResult> {
    try {
      const res = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: {
          'X-Postmark-Server-Token': this.opts.serverToken,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          From: this.opts.from,
          To: to,
          Subject: msg.subject,
          HtmlBody: msg.html,
          TextBody: msg.text,
          MessageStream: this.opts.messageStream,
          ...(attachments.length
            ? {
                Attachments: attachments.map((a) => ({
                  Name: a.filename,
                  Content: a.content.toString('base64'),
                  ContentType: a.contentType,
                })),
              }
            : {}),
        }),
      });

      const raw = await res.text();
      const parsed = safeParse(raw);

      // Postmark signals per-message problems in the body, so a 2xx alone is not
      // proof of acceptance — ErrorCode 0 is.
      if (res.ok && (parsed?.ErrorCode ?? 0) === 0) return { ok: true };

      const reason = this.describeFailure(res.status, parsed, raw);
      this.logger.error(`${label} email to ${to} failed — ${reason}`);
      return { ok: false, error: reason.slice(0, MAX_ERROR_LEN) };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown mail error';
      this.logger.error(`${label} email to ${to} failed — ${reason}`);
      return { ok: false, error: reason.slice(0, MAX_ERROR_LEN) };
    }
  }

  /**
   * Turn a Postmark rejection into something a company admin can act on without
   * reading Postmark's docs. Anything unrecognised falls through to Postmark's own
   * Message text, which is already reasonably legible.
   */
  private describeFailure(
    status: number,
    parsed: PostmarkResponse | null,
    raw: string,
  ): string {
    if (status === 401) return 'Postmark token invalid';

    // Inactive recipients are documented as ErrorCode 406; some responses surface
    // it as the HTTP status instead, so accept either.
    if (status === 406 || parsed?.ErrorCode === PostmarkError.InactiveRecipient) {
      return 'recipient previously bounced — reactivate in Postmark or correct the address';
    }

    switch (parsed?.ErrorCode) {
      case PostmarkError.SenderSignatureNotConfirmed:
      case PostmarkError.SenderSignatureNotFound:
        return `sender address not verified in Postmark — verify ${this.opts.from} or use a verified sender signature`;
      case PostmarkError.InvalidEmailRequest:
        return 'recipient address invalid';
    }

    const detail = parsed?.Message || raw.slice(0, MAX_ERROR_LEN) || 'no response body';
    const code = parsed?.ErrorCode ? ` (ErrorCode ${parsed.ErrorCode})` : '';
    return `Postmark responded ${status}${code}: ${detail}`;
  }
}

interface PostmarkResponse {
  ErrorCode?: number;
  Message?: string;
  MessageID?: string;
}

/** Postmark returns plain text for some auth failures, so never assume JSON. */
function safeParse(raw: string): PostmarkResponse | null {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as PostmarkResponse) : null;
  } catch {
    return null;
  }
}
