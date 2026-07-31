import {
  Body,
  Controller,
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
import { InventoryService } from './inventory.service';
import { ImportChecksService } from '../sync/import-checks.service';
import {
  BulkExpirationDto,
  BulkSellDto,
  InventoryActionDto,
  ListInventoryQuery,
  ListItemsQuery,
  ListStockQuery,
  LookupQuery,
  MarkLostDto,
  MoveInventoryDto,
  SetQuantityDto,
  UpdateItemDto,
} from './dto/inventory.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN', 'STORE_USER'])
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly svc: InventoryService,
    private readonly importChecks: ImportChecksService,
  ) {}

  // Product-level on-hand rows (serialized unit counts + quantity stock).
  @Get()
  list(@Ctx() ctx: DataContext, @Query() query: ListInventoryQuery) {
    return this.svc.list(ctx, query);
  }

  // Combined flat stock grid: one row per unit / per quantity stock-location.
  @Get('stock')
  listStock(@Ctx() ctx: DataContext, @Query() query: ListStockQuery) {
    return this.svc.listStock(ctx, query);
  }

  // Serialized units with location + expiration (in-stock by expiration).
  // Declared before :productId so the literal path wins over the int param.
  @Get('items')
  listItems(@Ctx() ctx: DataContext, @Query() query: ListItemsQuery) {
    return this.svc.listItems(ctx, query);
  }

  // Resolve a scanned serial/UPC for the Move-Items flow.
  @Get('lookup')
  lookup(@Ctx() ctx: DataContext, @Query() query: LookupQuery) {
    return this.svc.lookup(ctx, query);
  }

  /**
   * Ask PPS to identify an unidentified unit — the "check for imported inventory"
   * button. Also used to RE-ask after NOT_FOUND or DISCREPANCY, because the ERP may
   * have caught up since it last answered.
   */
  @Post('items/:itemId/import-check')
  @HttpCode(HttpStatus.OK)
  @Roles(['COMPANY_ADMIN'])
  requestImportCheck(@Ctx() ctx: DataContext, @Param('itemId') itemId: string) {
    return this.importChecks.request(ctx.companyId, itemId);
  }

  /**
   * Write a unit off as lost — a pending arrival that is never coming, or a unit
   * missing off a shelf. Company admin only: it is a write-off, not a correction.
   */
  @Post('items/:itemId/lost')
  @HttpCode(HttpStatus.OK)
  @Roles(['COMPANY_ADMIN'])
  markLost(
    @Ctx() ctx: DataContext,
    @Param('itemId') itemId: string,
    @Body() dto: MarkLostDto,
  ) {
    return this.svc.markLost(ctx, itemId, dto?.note);
  }

  // Audit trail (expiration changes) for a serialized item — shown in history.
  @Get('items/:itemId/audit')
  itemAudit(@Ctx() ctx: DataContext, @Param('itemId') itemId: string) {
    return this.svc.itemAuditTrail(ctx, itemId);
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

  // Bulk mark serialized items sold (partial success).
  @Post('bulk-sell')
  @HttpCode(HttpStatus.OK)
  bulkSell(@Ctx() ctx: DataContext, @Body() dto: BulkSellDto) {
    return this.svc.bulkSell(ctx, dto);
  }

  // Admin: set a quantity product's on-hand at a location to an exact value.
  @Post('set-quantity')
  @HttpCode(HttpStatus.OK)
  @Roles(['COMPANY_ADMIN'])
  setQuantity(@Ctx() ctx: DataContext, @Body() dto: SetQuantityDto) {
    return this.svc.setQuantity(ctx, dto);
  }

  // Admin: bulk-set expiration on serialized items (partial success + audit).
  @Patch('bulk-expiration')
  @Roles(['COMPANY_ADMIN'])
  bulkExpiration(@Ctx() ctx: DataContext, @Body() dto: BulkExpirationDto) {
    return this.svc.bulkExpiration(ctx, dto);
  }

  // Admin: edit a serialized unit's expiration date (data correction).
  @Patch('items/:itemId')
  @Roles(['COMPANY_ADMIN'])
  updateItem(
    @Ctx() ctx: DataContext,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateItemDto,
  ) {
    return this.svc.updateItem(ctx, itemId, dto);
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
