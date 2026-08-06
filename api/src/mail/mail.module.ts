import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import { PRODUCT_NAME } from './mail.types';
import { ConsoleMailService } from './providers/console-mail.service';
import {
  RESEND_DEFAULT_ENDPOINT,
  ResendMailService,
} from './providers/resend-mail.service';
import {
  POSTMARK_DEFAULT_ENDPOINT,
  POSTMARK_DEFAULT_STREAM,
  PostmarkMailService,
} from './providers/postmark-mail.service';

export type MailProvider = 'postmark' | 'resend' | 'console';

/**
 * The one place a mail provider is chosen. Precedence:
 *
 *   1. MAIL_MODE=console            → console (explicit kill switch, any provider)
 *   2. MAIL_PROVIDER set            → that provider; console if its token is missing
 *   3. MAIL_MODE=live (legacy)      → resend, as before MAIL_PROVIDER existed
 *   4. otherwise                    → console
 *
 * Console is therefore always reachable and remains the default, so dev and tests
 * need no credentials and never deliver real mail.
 */
export function resolveMailService(config: ConfigService): MailService {
  const logger = new Logger('MailModule');

  const mode = (config.get<string>('MAIL_MODE') || '').trim().toLowerCase();
  const provider = (config.get<string>('MAIL_PROVIDER') || '').trim().toLowerCase();
  const from =
    config.get<string>('MAIL_FROM') || `${PRODUCT_NAME} <onboarding@resend.dev>`;

  const useConsole = (why: string): MailService => {
    // Every route to console passes through here — the kill switch, a missing
    // token, an unrecognised provider name — which is why the production check
    // lives in this function rather than beside the other boot guards. There is
    // no way to reach console in production without tripping it, and no
    // precedence rules to keep in sync anywhere else.
    //
    // Fatal because console mail in production has NO symptom. Invitations and
    // password resets are written to the log and never delivered; the API answers
    // 200, the admin sees "invitation sent", and the person waits forever.
    if (config.get<string>('NODE_ENV') === 'production') {
      throw new Error(
        `Mail would fall back to the console in production (${why}). Invitations ` +
          'and password resets would be logged and never delivered, with no error ' +
          'anywhere. Set MAIL_PROVIDER (postmark) and its token, and do not set ' +
          'MAIL_MODE=console. Refusing to start.',
      );
    }
    logger.log(`Mail provider: console — ${why}. No mail will be sent.`);
    return new ConsoleMailService(from);
  };

  if (mode === 'console') {
    return useConsole('MAIL_MODE=console');
  }

  const postmarkToken = config.get<string>('POSTMARK_SERVER_TOKEN')?.trim();
  const resendKey = config.get<string>('RESEND_API_KEY')?.trim();

  const postmark = (): MailService => {
    if (!postmarkToken) {
      return useConsole('MAIL_PROVIDER=postmark but POSTMARK_SERVER_TOKEN is unset');
    }
    const messageStream =
      config.get<string>('POSTMARK_MESSAGE_STREAM')?.trim() || POSTMARK_DEFAULT_STREAM;
    logger.log(`Mail provider: postmark (stream "${messageStream}", from ${from}).`);
    return new PostmarkMailService({
      serverToken: postmarkToken,
      from,
      messageStream,
      endpoint:
        config.get<string>('POSTMARK_API_URL')?.trim() || POSTMARK_DEFAULT_ENDPOINT,
    });
  };

  const resend = (): MailService => {
    if (!resendKey) {
      return useConsole('MAIL_PROVIDER=resend but RESEND_API_KEY is unset');
    }
    logger.log(`Mail provider: resend (from ${from}).`);
    return new ResendMailService({
      apiKey: resendKey,
      from,
      endpoint: config.get<string>('RESEND_API_URL')?.trim() || RESEND_DEFAULT_ENDPOINT,
    });
  };

  switch (provider) {
    case 'postmark':
      return postmark();
    case 'resend':
      return resend();
    case 'console':
      return useConsole('MAIL_PROVIDER=console');
    case '':
      break;
    default:
      return useConsole(`MAIL_PROVIDER="${provider}" is not recognised`);
  }

  // No MAIL_PROVIDER: honour the legacy MAIL_MODE=live contract.
  if (mode === 'live') {
    return resendKey
      ? resend()
      : useConsole('MAIL_MODE=live but RESEND_API_KEY is unset');
  }
  return useConsole('no MAIL_PROVIDER set');
}

/** Global so any feature module can send mail without re-importing. */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: MailService,
      inject: [ConfigService],
      useFactory: resolveMailService,
    },
  ],
  exports: [MailService],
})
export class MailModule {}
