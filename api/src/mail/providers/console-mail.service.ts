import { Injectable, Logger } from '@nestjs/common';
import { MailService } from '../mail.service';
import {
  InvitationEmailData,
  MailAttachment,
  MailResult,
  PasswordResetEmailData,
  ReportEmailData,
} from '../mail.types';
import {
  invitationSubject,
  invitationText,
  passwordResetSubject,
  passwordResetText,
  reportSubject,
  reportText,
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

  async sendReportEmail(
    to: string[],
    data: ReportEmailData,
    attachments: MailAttachment[],
  ): Promise<MailResult> {
    const names = attachments.map((a) => a.filename);
    // The attachments are NAMED and SIZED in the log rather than passed over in
    // silence. Console mode is where this feature gets developed, and "did it
    // actually attach anything?" is the only question that matters here.
    return this.log(
      'report',
      to.join(', '),
      reportSubject(data),
      [
        reportText(data, names),
        '',
        'Attachments:',
        ...attachments.map(
          (a) => `  ${a.filename}  ${a.content.length} bytes  ${a.contentType}`,
        ),
      ].join('\n'),
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
