import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StoresController } from './stores.controller';
import { UsersController } from './users.controller';
import { InvitationsController, PublicInvitationsController } from './invitations.controller';
import { CompanySettingsController } from './company-settings.controller';
import { InvitationService } from './invitation.service';

@Module({
  imports: [AuthModule],
  controllers: [
    StoresController,
    UsersController,
    InvitationsController,
    PublicInvitationsController,
    CompanySettingsController,
  ],
  providers: [InvitationService],
  // The platform-admin module invites on a tenant's behalf through the very same
  // service, so the rules cannot drift between the two entry points.
  exports: [InvitationService],
})
export class CompanyModule {}
