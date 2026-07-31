import { Injectable, Logger } from '@nestjs/common';
import { MailService } from '../mail.service';
import {
  InvitationEmailData,
  MailResult,
  PasswordResetEmailData,
} from '../mail.types';
import {
  invitationSubject,
  invitationText,
  passwordResetSubject,
  passwordResetText,
} from '../mail.templates';

/**
 * Default provider: logs the email — including a working link — and sends nothing.
 * Local dev and automated tests need no credentials and never deliver real mail.
 */
@Injectable()
export class ConsoleMailService extends MailService {
  private readonly logger = new Logger(ConsoleMailService.name);

  constructor(private readonly from: string) {
    super();
  }

  async sendInvitationEmail(
    to: string,
    data: InvitationEmailData,
  ): Promise<MailResult> {
    return this.log('invitation', to, invitationSubject(data), invitationText(data));
  }

  async sendPasswordResetEmail(
    to: string,
    data: PasswordResetEmailData,
  ): Promise<MailResult> {
    return this.log(
      'password reset',
      to,
      passwordResetSubject(data),
      passwordResetText(data),
    );
  }

  private log(label: string, to: string, subject: string, body: string): MailResult {
    this.logger.log(
      [
        '',
        `──────── ${label} email (console mode) ────────`,
        `To:      ${to}`,
        `From:    ${this.from}`,
        `Subject: ${subject}`,
        '',
        body,
        '─────────────────────────────────────────────────',
      ].join('\n'),
    );
    return { ok: true };
  }
}
