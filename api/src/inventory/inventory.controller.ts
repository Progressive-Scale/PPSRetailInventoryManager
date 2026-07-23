import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { InventoryService } from './inventory.service';
import {
  CreateItemDto,
  ItemActionDto,
  ListItemsQuery,
  UpdateItemDto,
} from './dto/inventory.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN', 'STORE_USER'])
@Controller('inventory')
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  @Get()
  list(@Ctx() ctx: DataContext, @Query() query: ListItemsQuery) {
    return this.svc.list(ctx, query);
  }

  @Get(':id')
  findOne(@Ctx() ctx: DataContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.findOne(ctx, id);
  }

  @Post()
  create(@Ctx() ctx: DataContext, @Body() dto: CreateItemDto) {
    return this.svc.create(ctx, dto);
  }

  @Patch(':id')
  update(
    @Ctx() ctx: DataContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateItemDto,
  ) {
    return this.svc.update(ctx, id, dto);
  }

  @Post(':id/sell')
  @HttpCode(HttpStatus.OK)
  sell(
    @Ctx() ctx: DataContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ItemActionDto,
  ) {
    return this.svc.sell(ctx, id, dto);
  }

  @Post(':id/return')
  @HttpCode(HttpStatus.OK)
  returnItem(
    @Ctx() ctx: DataContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ItemActionDto,
  ) {
    return this.svc.returnToWarehouse(ctx, id, dto);
  }

  @Post(':id/adjust')
  @HttpCode(HttpStatus.OK)
  adjust(
    @Ctx() ctx: DataContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ItemActionDto,
  ) {
    return this.svc.adjustOut(ctx, id, dto);
  }
}
