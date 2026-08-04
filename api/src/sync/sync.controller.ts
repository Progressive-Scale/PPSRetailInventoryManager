import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { ApiCompany } from './api-company.decorator';
import { SyncService } from './sync.service';
import { ImportChecksService } from './import-checks.service';
import { ReorderContractService } from '../reorders/reorders.service';
import { HandoffsDto, ReturnsAckDto } from './dto/sync.dto';
import { ImportChecksQuery, ImportCheckResultsDto } from './dto/import-check.dto';
import { AckReorderDto, SyncReordersQuery } from './dto/reorder-sync.dto';

@UseGuards(ApiKeyGuard)
@Controller('sync')
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly importChecks: ImportChecksService,
    private readonly reorders: ReorderContractService,
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

  /**
   * Stores asking for more stock. Oldest first. Generic on purpose — no part of this
   * knows what an ERP is; see docs/SYNC.md §6.
   */
  @Get('reorders')
  listReorders(
    @ApiCompany() companyId: number,
    @Query() query: SyncReordersQuery,
  ) {
    return this.reorders.list(
      companyId,
      query.status ?? 'OPEN',
      query.limit,
      query.offset,
    );
  }

  /**
   * "I raised order X for this." Repeating the same reference is a no-op; a different
   * reference on an already-acknowledged request is a 409 for a human to sort out, and
   * a cancelled request answers 410 so a consumer can log it and skip.
   */
  @Post('reorders/:id/ack')
  @HttpCode(HttpStatus.OK)
  ackReorder(
    @ApiCompany() companyId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AckReorderDto,
  ) {
    return this.reorders.ack(companyId, id, dto.externalOrderRef);
  }
}
