import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CompanyModule } from '../company/company.module';
import { AdminController } from './admin.controller';
import { AdminInvitationsController } from './admin-invitations.controller';
import { AdminUsersController } from './admin-users.controller';
import { PlatformAdminGuard } from './platform-admin.guard';

@Module({
  // CompanyModule for InvitationService, AuthModule for PasswordResetService: the
  // platform admin acts through the tenants' own code paths, not copies of them.
  imports: [AuthModule, CompanyModule],
  controllers: [AdminController, AdminUsersController, AdminInvitationsController],
  providers: [PlatformAdminGuard],
})
export class AdminModule {}
