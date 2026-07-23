import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminController } from './admin.controller';
import { PlatformAdminGuard } from './platform-admin.guard';

@Module({
  imports: [AuthModule],
  controllers: [AdminController],
  providers: [PlatformAdminGuard],
})
export class AdminModule {}
