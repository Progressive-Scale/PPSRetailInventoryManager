import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { and, asc, eq, sql, SQL } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { DataContext } from '../auth/auth.types';
import { TenantDbService } from '../db/tenant-db.service';
import { inventoryItems, inventoryStock, products } from '../db/schema';
import {
  CreateProductDto,
  ListProductsQuery,
  UpdateProductDto,
} from './products.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN'])
@Controller('products')
export class ProductsController {
  constructor(private readonly tenantDb: TenantDbService) {}

  /**
   * Readable by a STORE_USER as well: the reorder picker needs the catalog to search,
   * and a store user can already see most of it through Inventory. Everything that
   * WRITES the catalog stays COMPANY_ADMIN via the class-level guard.
   */
  @Get()
  @Roles(['COMPANY_ADMIN', 'STORE_USER'])
  list(@Ctx() ctx: DataContext, @Query() query: ListProductsQuery) {
    return this.tenantDb.withCompany(ctx.companyId, (tx) => {
      const conds: SQL[] = [eq(products.companyId, ctx.companyId)];
      if (query.active !== undefined)
        conds.push(eq(products.active, query.active));
      if (query.needsReview !== undefined)
        conds.push(eq(products.needsReview, query.needsReview));
      return tx
        .select({
          id: products.id,
          companyId: products.companyId,
          sku: products.sku,
          name: products.name,
          description: products.description,
          price: products.price,
          upc: products.upc,
          trackingType: products.trackingType,
          needsReview: products.needsReview,
          reorderThreshold: products.reorderThreshold,
          active: products.active,
          createdAt: products.createdAt,
          updatedAt: products.updatedAt,
          /**
           * Company-wide units on hand: serialized units still ON_HAND plus every
           * quantity counter. This is a catalog screen, so the figure is deliberately
           * company-wide rather than per store — it is what the low-stock hint compares
           * against reorder_threshold, and a threshold is a catalog-level number.
           */
          // The outer column is written out in full on purpose: interpolating
          // `products.id` here emits a BARE "id", which each subquery's own FROM then
          // shadows (inventory_items.id is a uuid, so it fails outright rather than
          // returning a wrong number).
          onHand: sql<number>`(
            (SELECT count(*) FROM inventory_items i
              WHERE i.company_id = ${ctx.companyId}
                AND i.product_id = "products"."id"
                AND i.status = 'ON_HAND')
            + COALESCE((SELECT sum(s.quantity_on_hand) FROM inventory_stock s
              WHERE s.company_id = ${ctx.companyId}
                AND s.product_id = "products"."id"), 0)
          )::int`,
          /** Live reorder requests across all stores — drives the row badge. */
          openReorders: sql<number>`(SELECT count(*)::int FROM reorder_requests r
            WHERE r.company_id = ${ctx.companyId}
              AND r.product_id = "products"."id"
              AND r.status = 'OPEN')`,
        })
        .from(products)
        .where(and(...conds))
        .orderBy(asc(products.sku));
    });
  }

  @Post()
  create(@Ctx() ctx: DataContext, @Body() dto: CreateProductDto) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      try {
        const [row] = await tx
          .insert(products)
          .values({
            companyId: ctx.companyId,
            sku: dto.sku,
            name: dto.name,
            description: dto.description ?? null,
            price: dto.price !== undefined ? String(dto.price) : '0',
            upc: dto.upc ?? null,
            trackingType: dto.trackingType,
          })
          .returning();
        return row;
      } catch (err) {
        throw this.conflictOrRethrow(err);
      }
    });
  }

  @Patch(':id')
  update(
    @Ctx() ctx: DataContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProductDto,
  ) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, id), eq(products.companyId, ctx.companyId)))
        .limit(1);
      if (!existing) throw new NotFoundException('Product not found.');
      // tracking_type is immutable.
      if (
        dto.trackingType !== undefined &&
        dto.trackingType !== existing.trackingType
      ) {
        throw new BadRequestException(
          'tracking_type is immutable after creation.',
        );
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (dto.sku !== undefined) patch.sku = dto.sku;
      if (dto.name !== undefined) patch.name = dto.name;
      if (dto.description !== undefined) patch.description = dto.description;
      if (dto.price !== undefined) patch.price = String(dto.price);
      if (dto.upc !== undefined) patch.upc = dto.upc;
      if (dto.active !== undefined) patch.active = dto.active;
      if (dto.needsReview !== undefined) patch.needsReview = dto.needsReview;
      // null is meaningful here — it clears the threshold.
      if (dto.reorderThreshold !== undefined)
        patch.reorderThreshold = dto.reorderThreshold;
      try {
        const [row] = await tx
          .update(products)
          .set(patch)
          .where(and(eq(products.id, id), eq(products.companyId, ctx.companyId)))
          .returning();
        return row;
      } catch (err) {
        throw this.conflictOrRethrow(err);
      }
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      // FK-safe: block if any unit or stock row references this product.
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.productId, id),
            eq(inventoryItems.companyId, ctx.companyId),
          ),
        );
      const [{ scount }] = await tx
        .select({ scount: sql<number>`count(*)` })
        .from(inventoryStock)
        .where(
          and(
            eq(inventoryStock.productId, id),
            eq(inventoryStock.companyId, ctx.companyId),
          ),
        );
      if (Number(count) > 0 || Number(scount) > 0) {
        throw new ConflictException(
          'Cannot delete a product that has inventory. Deactivate it instead.',
        );
      }
      const [row] = await tx
        .delete(products)
        .where(and(eq(products.id, id), eq(products.companyId, ctx.companyId)))
        .returning();
      if (!row) throw new NotFoundException('Product not found.');
      return { deleted: true, id };
    });
  }

  private conflictOrRethrow(err: unknown): unknown {
    if (
      !!err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    ) {
      return new ConflictException(
        'A product with that SKU or UPC already exists.',
      );
    }
    return err;
  }
}
