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
import { ReordersService } from './reorders.service';
import { CreateReorderDto, ListReordersQuery } from './dto/reorders.dto';

/**
 * Store-facing reorder requests. STORE_USER throughout: flagging an empty shelf is
 * shop-floor work, and an admin-only button would be pressed by nobody who can see
 * the shelf. A store user is scoped to their own store in the service.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN', 'STORE_USER'])
@Controller('reorders')
export class ReordersController {
  constructor(private readonly svc: ReordersService) {}

  @Get()
  list(@Ctx() ctx: DataContext, @Query() query: ListReordersQuery) {
    return this.svc.list(ctx, query);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  create(@Ctx() ctx: DataContext, @Body() dto: CreateReorderDto) {
    return this.svc.create(ctx, dto);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.svc.cancel(ctx, id);
  }
}
