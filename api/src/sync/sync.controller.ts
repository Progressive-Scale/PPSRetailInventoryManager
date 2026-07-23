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
import { ApiKeyGuard } from './api-key.guard';
import { ApiCompany } from './api-company.decorator';
import { SyncService } from './sync.service';
import { HandoffsDto, ReturnsAckDto } from './dto/sync.dto';

@UseGuards(ApiKeyGuard)
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('handoffs')
  @HttpCode(HttpStatus.OK)
  handoffs(@ApiCompany() companyId: number, @Body() dto: HandoffsDto) {
    return this.sync.handoffs(companyId, dto.handoffs);
  }

  @Get('returns')
  returns(@ApiCompany() companyId: number, @Query('limit') limit?: string) {
    const n = limit ? Number(limit) : undefined;
    return this.sync.pendingReturns(companyId, Number.isFinite(n) ? n : undefined);
  }

  @Post('returns/ack')
  @HttpCode(HttpStatus.OK)
  ackReturns(@ApiCompany() companyId: number, @Body() dto: ReturnsAckDto) {
    return this.sync.ackReturns(companyId, dto.ids);
  }
}
