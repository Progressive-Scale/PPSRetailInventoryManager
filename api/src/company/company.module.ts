import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StoresController } from './stores.controller';
import { UsersController } from './users.controller';
import { InvitationsController, PublicInvitationsController } from './invitations.controller';
import { CompanySettingsController } from './company-settings.controller';

@Module({
  imports: [AuthModule],
  controllers: [
    StoresController,
    UsersController,
    InvitationsController,
    PublicInvitationsController,
    CompanySettingsController,
  ],
})
export class CompanyModule {}
