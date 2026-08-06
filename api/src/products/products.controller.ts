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
import {
  DataContext,
  INVENTORY_ADMIN_ROLES,
  TENANT_USER_ROLES,
} from '../auth/auth.types';
import { AuditService, diffFields } from '../audit/audit.service';
import { blankToNull } from './product-catalog';
import { TenantDbService } from '../db/tenant-db.service';
import { inventoryItems, inventoryStock, products } from '../db/schema';
import {
  CreateProductDto,
  ListProductsQuery,
  UpdateProductDto,
} from './products.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(INVENTORY_ADMIN_ROLES)
@Controller('products')
export class ProductsController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Readable by a STORE_USER as well: the reorder picker needs the catalog to search,
   * and a store user can already see most of it through Inventory. Everything that
   * WRITES the catalog needs COMPANY_ADMIN or STORE_MANAGER, via the class guard.
   */
  @Get()
  @Roles(TENANT_USER_ROLES)
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
            description: blankToNull(dto.description),
            price: dto.price !== undefined ? String(dto.price) : '0',
            upc: blankToNull(dto.upc),
            trackingType: dto.trackingType,
          })
          .returning();
        // A catalog row is company-wide, so no store: the event belongs to the company.
        await this.audit.record(
          tx,
          ctx.companyId,
          AuditService.user(ctx),
          { entityType: 'PRODUCT', entityId: row.id },
          'CREATED',
          { details: { sku: row.sku, name: row.name, trackingType: row.trackingType } },
        );
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
      // Blank means "no description". Without this, saving a product that never had one
      // stores '' and the trail records a change from nothing to nothing.
      if (dto.description !== undefined)
        patch.description = blankToNull(dto.description);
      if (dto.price !== undefined) patch.price = String(dto.price);
      // Clearing the field is a real edit — it removes the barcode — so an empty string
      // is stored as NULL rather than rejected or ignored.
      if (dto.upc !== undefined) patch.upc = blankToNull(dto.upc);
      if (dto.active !== undefined) patch.active = dto.active;
      if (dto.needsReview !== undefined) patch.needsReview = dto.needsReview;
      // null is meaningful here — it clears the threshold.
      if (dto.reorderThreshold !== undefined)
        patch.reorderThreshold = dto.reorderThreshold;
      // Read the row BEFORE writing, so the diff is what actually changed rather than
      // what the request happened to mention.
      const [before] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, id), eq(products.companyId, ctx.companyId)))
        .limit(1);
      if (!before) throw new NotFoundException('Product not found.');
      try {
        const [row] = await tx
          .update(products)
          .set(patch)
          .where(and(eq(products.id, id), eq(products.companyId, ctx.companyId)))
          .returning();
        const changes = diffFields(
          before as unknown as Record<string, unknown>,
          patch,
          {
            fields: [
              'name',
              'description',
              'price',
              'upc',
              'trackingType',
              'reorderThreshold',
              'active',
              'needsReview',
            ],
            columnFor: {
              trackingType: 'tracking_type',
              reorderThreshold: 'reorder_threshold',
              needsReview: 'needs_review',
            },
            // '12.00' and '12.0' are the same price; logging that as an edit is noise.
            normalise: { price: (v) => Number(v) },
          },
        );
        await this.audit.recordChanges(
          tx,
          ctx.companyId,
          AuditService.user(ctx),
          { entityType: 'PRODUCT', entityId: id },
          changes,
          { sku: before.sku },
        );
        // Clearing needs_review by hand is a resolution, not just a field flip: it is how a
        // human answers the question the review queue asked.
        if (before.needsReview && patch.needsReview === false) {
          await this.audit.record(
            tx,
            ctx.companyId,
            AuditService.user(ctx),
            { entityType: 'PRODUCT', entityId: id },
            'RESOLVED',
            { details: { sku: before.sku, resolvedBy: 'manual edit' } },
          );
        }
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
      // Details carry what the row WAS: after this, the entity it points at is gone, and an
      // id on its own would make the event unreadable.
      await this.audit.record(
        tx,
        ctx.companyId,
        AuditService.user(ctx),
        { entityType: 'PRODUCT', entityId: id },
        'DELETED',
        { details: { sku: row.sku, name: row.name } },
      );
      return { deleted: true, id };
    });
  }

  /**
   * Name the field that actually collided.
   *
   * "That SKU or UPC already exists" made a blank-UPC collision unexplainable: the user
   * was looking at an empty box being told it was a duplicate. The constraint knows which
   * one it was, so say it.
   */
  private conflictOrRethrow(err: unknown): unknown {
    if (
      !!err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    ) {
      const constraint = (err as { constraint?: string }).constraint ?? '';
      if (constraint.includes('upc')) {
        return new ConflictException(
          'Another product in your catalog already uses that barcode.',
        );
      }
      if (constraint.includes('sku')) {
        return new ConflictException(
          'Another product in your catalog already uses that SKU.',
        );
      }
      return new ConflictException(
        'A product with that SKU or UPC already exists.',
      );
    }
    return err;
  }
}
