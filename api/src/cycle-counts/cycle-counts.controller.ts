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
  CloseCycleCountDto,
  ListCycleCountsQuery,
  OpenCycleCountDto,
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

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  close(
    @Ctx() ctx: DataContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CloseCycleCountDto,
  ) {
    return this.svc.close(ctx, id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.svc.cancel(ctx, id);
  }
}
