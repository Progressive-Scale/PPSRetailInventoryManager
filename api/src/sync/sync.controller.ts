import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SyncApiKeyGuard } from './sync-api-key.guard';
import { SyncService } from './sync.service';
import { SyncPushDto } from './dto/sync-push.dto';
import { SyncAckDto } from './dto/sync-ack.dto';

@UseGuards(SyncApiKeyGuard)
@Controller('sync')
export class SyncController {
  constructor(private readonly service: SyncService) {}

  @Post('push')
  @HttpCode(HttpStatus.OK)
  push(@Body() dto: SyncPushDto) {
    return this.service.push(dto);
  }

  @Get('pending')
  pending(@Query('limit') limit?: string) {
    const parsed = limit ? Number(limit) : undefined;
    return this.service.pending(Number.isFinite(parsed) ? parsed : undefined);
  }

  @Post('ack')
  @HttpCode(HttpStatus.OK)
  ack(@Body() dto: SyncAckDto) {
    return this.service.ack(dto.ids);
  }
}
