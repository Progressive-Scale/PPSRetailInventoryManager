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
import { InventoryService } from './inventory.service';
import {
  InventoryActionDto,
  ListInventoryQuery,
  ListItemsQuery,
  MoveInventoryDto,
} from './dto/inventory.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN', 'STORE_USER'])
@Controller('inventory')
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  // Product-level on-hand rows (serialized unit counts + quantity stock).
  @Get()
  list(@Ctx() ctx: DataContext, @Query() query: ListInventoryQuery) {
    return this.svc.list(ctx, query);
  }

  // Serialized units with location + expiration (in-stock by expiration).
  // Declared before :productId so the literal path wins over the int param.
  @Get('items')
  listItems(@Ctx() ctx: DataContext, @Query() query: ListItemsQuery) {
    return this.svc.listItems(ctx, query);
  }

  // Expansion for a single product: units (serialized) or stock + ledger.
  @Get(':productId')
  getProduct(
    @Ctx() ctx: DataContext,
    @Param('productId', ParseIntPipe) productId: number,
  ) {
    return this.svc.getProduct(ctx, productId);
  }

  // Move inventory between locations (serialized batch or one quantity line).
  @Post('move')
  @HttpCode(HttpStatus.OK)
  move(@Ctx() ctx: DataContext, @Body() dto: MoveInventoryDto) {
    return this.svc.move(ctx, dto);
  }

  @Post('sell')
  @HttpCode(HttpStatus.OK)
  sell(@Ctx() ctx: DataContext, @Body() dto: InventoryActionDto) {
    return this.svc.sell(ctx, dto);
  }

  @Post('return')
  @HttpCode(HttpStatus.OK)
  returnItem(@Ctx() ctx: DataContext, @Body() dto: InventoryActionDto) {
    return this.svc.returnToWarehouse(ctx, dto);
  }

  @Post('adjust')
  @HttpCode(HttpStatus.OK)
  adjust(@Ctx() ctx: DataContext, @Body() dto: InventoryActionDto) {
    return this.svc.adjustOut(ctx, dto);
  }
}
