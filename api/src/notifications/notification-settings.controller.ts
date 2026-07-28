import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { DataContext } from '../auth/auth.types';
import { NotificationsService } from './notifications.service';
import { NotificationSettingsDto } from './dto/notifications.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN'])
@Controller('notification-settings')
export class NotificationSettingsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  get(@Ctx() ctx: DataContext) {
    return this.svc.getSettings(ctx);
  }

  @Put()
  put(@Ctx() ctx: DataContext, @Body() dto: NotificationSettingsDto) {
    return this.svc.putSettings(ctx, dto);
  }
}
