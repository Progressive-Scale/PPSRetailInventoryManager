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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { DataContext } from '../auth/auth.types';
import { CycleCountsService } from './cycle-counts.service';
import {
  ListCycleCountsQuery,
  OpenCycleCountDto,
  RejectCycleCountDto,
  SubmitCycleCountDto,
} from './dto/cycle-counts.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN', 'STORE_USER'])
@Controller('cycle-counts')
export class CycleCountsController {
  constructor(private readonly svc: CycleCountsService) {}

  @Post()
  open(@Ctx() ctx: DataContext, @Body() dto: OpenCycleCountDto) {
    return this.svc.open(ctx, dto);
  }

  @Get()
  list(@Ctx() ctx: DataContext, @Query() query: ListCycleCountsQuery) {
    return this.svc.list(ctx, query);
  }

  @Get(':id')
  get(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.svc.get(ctx, id);
  }

  /**
   * What this count makes of one serial. The scanner calls it for a serial its own
   * snapshot cannot explain, so it can offer the right choice — put a sold unit
   * back, note one found away from where it was recorded, or record an unknown.
   */
  @Get(':id/resolve')
  resolve(
    @Ctx() ctx: DataContext,
    @Param('id', ParseIntPipe) id: number,
    @Query('serial') serial?: string,
  ) {
    return this.svc.resolveSerial(ctx, id, serial ?? '');
  }

  /**
   * Hand the count in. Computes what it WOULD change and stores that; inventory is
   * untouched until an admin approves. Open to the store user doing the counting.
   */
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  submit(
    @Ctx() ctx: DataContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SubmitCycleCountDto,
  ) {
    return this.svc.submit(ctx, id, dto);
  }

  /**
   * DEPRECATED alias for submit, kept so a scanner build that has not been updated
   * keeps working. Note the changed meaning: this no longer applies the count, it
   * hands it in for review.
   */
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  close(
    @Ctx() ctx: DataContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SubmitCycleCountDto,
  ) {
    return this.svc.close(ctx, id, dto);
  }

  /**
   * Apply the proposals. COMPANY_ADMIN only: this is the step that sells unscanned
   * units and zeroes uncounted shelves, so it should not be the same role that did
   * the counting.
   */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(['COMPANY_ADMIN'])
  approve(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.svc.approve(ctx, id);
  }

  /** Send it back for a recount. Discards the proposals; nothing was applied. */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(['COMPANY_ADMIN'])
  reject(
    @Ctx() ctx: DataContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectCycleCountDto,
  ) {
    return this.svc.reject(ctx, id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.svc.cancel(ctx, id);
  }
}
