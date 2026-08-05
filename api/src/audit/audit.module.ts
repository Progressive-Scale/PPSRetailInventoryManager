import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Global, like MailModule: every feature module writes audit events, and making each one
 * import this module would be ceremony that a forgotten import turns into a silent gap in
 * the trail.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
