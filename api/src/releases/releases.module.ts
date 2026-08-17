import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { PlatformAdminGuard } from '../admin/platform-admin.guard';
import { AdminReleasesController } from './admin-releases.controller';
import { AppVersionController } from './app-version.controller';
import { DeviceVersionInterceptor } from './device-version.interceptor';
import { ReleasesService } from './releases.service';

/**
 * Scanner releases: the public version check, the platform-admin management of
 * releases and channels, and the passive capture of what each device runs.
 *
 * AuthModule for JwtService (the version check reads a token when one is there)
 * and for the guards the admin endpoints use.
 */
@Module({
  imports: [AuthModule],
  controllers: [AppVersionController, AdminReleasesController],
  providers: [
    ReleasesService,
    // Provided here too: the guard is stateless, and a controller's guards are
    // resolved from its own module's injector.
    PlatformAdminGuard,
    // Global: every authenticated request is a chance to learn what a device is
    // running, and there is no single endpoint the scanner reliably calls.
    { provide: APP_INTERCEPTOR, useClass: DeviceVersionInterceptor },
  ],
  exports: [ReleasesService],
})
export class ReleasesModule {}
