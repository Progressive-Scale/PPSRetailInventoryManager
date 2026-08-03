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
import { ImportChecksService } from './import-checks.service';
import { HandoffsDto, ReturnsAckDto } from './dto/sync.dto';
import { ImportChecksQuery, ImportCheckResultsDto } from './dto/import-check.dto';

@UseGuards(ApiKeyGuard)
@Controller('sync')
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly importChecks: ImportChecksService,
  ) {}

  @Post('handoffs')
  @HttpCode(HttpStatus.OK)
  handoffs(@ApiCompany() companyId: number, @Body() dto: HandoffsDto) {
    return this.sync.handoffs(companyId, dto.handoffs);
  }

  /**
   * The company's stores, so an agent can keep a local mirror of cloud store ids in
   * step. Read-only: the cloud mints these ids and the ERP links to them.
   */
  @Get('stores')
  stores(@ApiCompany() companyId: number) {
    return this.sync.listStores(companyId);
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

  /**
   * Serials scanned in a count that nobody could identify, waiting for PPS to say
   * what they are. Oldest first, so a backlog drains in scan order.
   */
  @Get('import-checks')
  listImportChecks(
    @ApiCompany() companyId: number,
    @Query() query: ImportChecksQuery,
  ) {
    return this.importChecks.list(companyId, query.limit, query.offset);
  }

  /** Answers from PPS. Per-item acks; a redelivered answer is already_resolved. */
  @Post('import-checks/results')
  @HttpCode(HttpStatus.OK)
  importCheckResults(
    @ApiCompany() companyId: number,
    @Body() dto: ImportCheckResultsDto,
  ) {
    return this.importChecks.applyResults(companyId, dto.results);
  }
}
