import { Injectable, Logger } from '@nestjs/common';
import { MailService } from '../mail.service';
import { InvitationEmailData, MailResult } from '../mail.types';
import { invitationSubject, invitationText } from '../mail.templates';

/**
 * Default provider: logs the email — including a working accept URL — and sends
 * nothing. Local dev and automated tests need no credentials and never deliver
 * real mail.
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
    this.logger.log(
      [
        '',
        '──────── invitation email (console mode) ────────',
        `To:      ${to}`,
        `From:    ${this.from}`,
        `Subject: ${invitationSubject(data)}`,
        '',
        invitationText(data),
        '─────────────────────────────────────────────────',
      ].join('\n'),
    );
    return { ok: true };
  }
}
