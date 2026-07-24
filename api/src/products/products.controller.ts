import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { and, asc, eq, SQL } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { DataContext } from '../auth/auth.types';
import { TenantDbService } from '../db/tenant-db.service';
import { products } from '../db/schema';
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

  @Get()
  list(@Ctx() ctx: DataContext, @Query() query: ListProductsQuery) {
    return this.tenantDb.withCompany(ctx.companyId, (tx) => {
      const conds: SQL[] = [eq(products.companyId, ctx.companyId)];
      if (query.active !== undefined)
        conds.push(eq(products.active, query.active));
      return tx
        .select()
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
          })
          .returning();
        return row;
      } catch (err) {
        if (isUnique(err)) {
          throw new ConflictException('A product with that SKU already exists.');
        }
        throw err;
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
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (dto.sku !== undefined) patch.sku = dto.sku;
      if (dto.name !== undefined) patch.name = dto.name;
      if (dto.description !== undefined) patch.description = dto.description;
      if (dto.price !== undefined) patch.price = String(dto.price);
      if (dto.upc !== undefined) patch.upc = dto.upc;
      if (dto.active !== undefined) patch.active = dto.active;
      try {
        const [row] = await tx
          .update(products)
          .set(patch)
          .where(and(eq(products.id, id), eq(products.companyId, ctx.companyId)))
          .returning();
        if (!row) throw new NotFoundException('Product not found.');
        return row;
      } catch (err) {
        if (isUnique(err)) {
          throw new ConflictException('A product with that SKU already exists.');
        }
        throw err;
      }
    });
  }
}

function isUnique(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}
