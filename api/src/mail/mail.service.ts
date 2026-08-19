import {
  InvitationEmailData,
  MailAttachment,
  MailResult,
  PasswordResetEmailData,
  ReportEmailData,
} from './mail.types';

/**
 * Transport-agnostic mail contract, and the DI token feature modules inject.
 * The concrete implementation is chosen once, in MailModule, from MAIL_PROVIDER.
 *
 * Implementations must NEVER throw: a send failure has to leave the invitation
 * intact (recorded as email_status = FAILED) so the admin can copy the link
 * instead. Return { ok: false, error } for every failure mode.
 */
export abstract class MailService {
  abstract sendInvitationEmail(
    to: string,
    data: InvitationEmailData,
  ): Promise<MailResult>;

  abstract sendPasswordResetEmail(
    to: string,
    data: PasswordResetEmailData,
  ): Promise<MailResult>;

  /**
   * A report, as attachments.
   *
   * Takes a LIST of recipients: sending one report to a manager and an accountant
   * is the ordinary case, and looping per address would deliver several copies of
   * the same 200 KB file and report several independent successes and failures for
   * what the user did once.
   *
   * A provider that cannot carry attachments must FAIL, not deliver the covering
   * note alone — an email that says "your report is attached" with nothing attached
   * is worse than an error.
   */
  abstract sendReportEmail(
    to: string[],
    data: ReportEmailData,
    attachments: MailAttachment[],
  ): Promise<MailResult>;
}

// Re-exported so existing importers of '../mail/mail.service' keep working.
export {
  InvitationEmailData,
  MailAttachment,
  MailResult,
  PasswordResetEmailData,
  ReportEmailData,
  PRODUCT_NAME,
} from './mail.types';
