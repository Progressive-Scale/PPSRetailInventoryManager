import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsController } from './notifications.controller';
import { NotificationSettingsController } from './notification-settings.controller';
import { NotificationsService } from './notifications.service';
import { ExpirationAlertsJob } from './expiration-alerts.job';

@Module({
  imports: [AuthModule],
  controllers: [NotificationsController, NotificationSettingsController],
  providers: [NotificationsService, ExpirationAlertsJob],
})
export class NotificationsModule {}
