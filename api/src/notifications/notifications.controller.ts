import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { DataContext } from '../auth/auth.types';
import { NotificationsService } from './notifications.service';
import { ExpirationAlertsJob } from './expiration-alerts.job';
import {
  BulkStatusDto,
  DeleteNotificationsDto,
  ListNotificationsQuery,
  UpdateNotificationDto,
} from './dto/notifications.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN', 'STORE_USER'])
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly svc: NotificationsService,
    private readonly expirationJob: ExpirationAlertsJob,
  ) {}

  @Get()
  list(@Ctx() ctx: DataContext, @Query() query: ListNotificationsQuery) {
    return this.svc.list(ctx, query);
  }

  // Manually trigger an expiration scan (admin). Runs the same job as the daily
  // cron; safe to call repeatedly (deduped). Returns how many were created.
  @Post('run-expiration-scan')
  @HttpCode(HttpStatus.OK)
  @Roles(['COMPANY_ADMIN'])
  runExpirationScan() {
    return this.expirationJob.run();
  }

  @Get('unread-count')
  unreadCount(
    @Ctx() ctx: DataContext,
    @Query() query: ListNotificationsQuery,
  ) {
    return this.svc.unreadCount(ctx, query.storeId);
  }

  /** Mark one or many notifications read / unread / dismissed. */
  @Post('status')
  @HttpCode(HttpStatus.OK)
  setStatus(@Ctx() ctx: DataContext, @Body() dto: BulkStatusDto) {
    return this.svc.setStatus(ctx, dto.ids, dto.status);
  }

  /** Remove one or many notifications from the history. */
  @Post('delete')
  @HttpCode(HttpStatus.OK)
  remove(@Ctx() ctx: DataContext, @Body() dto: DeleteNotificationsDto) {
    return this.svc.remove(ctx, dto.ids);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  removeOne(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.svc.remove(ctx, [id]);
  }

  @Patch(':id')
  update(
    @Ctx() ctx: DataContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateNotificationDto,
  ) {
    return this.svc.updateStatus(ctx, id, dto);
  }
}
