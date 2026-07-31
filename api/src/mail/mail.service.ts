import {
  InvitationEmailData,
  MailResult,
  PasswordResetEmailData,
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
}

// Re-exported so existing importers of '../mail/mail.service' keep working.
export {
  InvitationEmailData,
  MailResult,
  PasswordResetEmailData,
  PRODUCT_NAME,
} from './mail.types';
