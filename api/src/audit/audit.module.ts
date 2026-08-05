import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditService } from './audit.service';
import { ActivityService } from './activity.service';
import { ActivityController } from './activity.controller';

/**
 * Global, like MailModule: every feature module writes audit events, and making each one
 * import this module would be ceremony that a forgotten import turns into a silent gap in
 * the trail.
 *
 * The read side lives here too — one module owns both halves of the trail, so the write
 * vocabulary and the query that renders it cannot drift apart unnoticed.
 */
@Global()
@Module({
  // For JwtAuthGuard/RolesGuard on the read controller. AuthModule pulls in nothing from
  // here, so the global registration stays acyclic.
  imports: [AuthModule],
  controllers: [ActivityController],
  providers: [AuditService, ActivityService],
  exports: [AuditService, ActivityService],
})
export class AuditModule {}
