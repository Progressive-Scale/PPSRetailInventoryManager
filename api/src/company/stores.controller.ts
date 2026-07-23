import {
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
  UseGuards,
} from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { DataContext } from '../auth/auth.types';
import { TenantDbService } from '../db/tenant-db.service';
import { inventoryItems, stores } from '../db/schema';
import { CreateStoreDto, UpdateStoreDto } from './company.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN'])
@Controller('stores')
export class StoresController {
  constructor(private readonly tenantDb: TenantDbService) {}

  @Get()
  list(@Ctx() ctx: DataContext) {
    return this.tenantDb.withCompany(ctx.companyId, (tx) =>
      tx
        .select()
        .from(stores)
        .where(eq(stores.companyId, ctx.companyId))
        .orderBy(asc(stores.id)),
    );
  }

  @Post()
  create(@Ctx() ctx: DataContext, @Body() dto: CreateStoreDto) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      try {
        const [row] = await tx
          .insert(stores)
          .values({
            companyId: ctx.companyId,
            name: dto.name,
            code: dto.code,
            externalBuildingId: dto.externalBuildingId ?? null,
          })
          .returning();
        return row;
      } catch (err) {
        if (isUnique(err)) {
          throw new ConflictException('A store with that code already exists.');
        }
        throw err;
      }
    });
  }

  @Patch(':id')
  update(
    @Ctx() ctx: DataContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStoreDto,
  ) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const patch: Record<string, unknown> = {};
      if (dto.name !== undefined) patch.name = dto.name;
      if (dto.code !== undefined) patch.code = dto.code;
      if (dto.externalBuildingId !== undefined)
        patch.externalBuildingId = dto.externalBuildingId;
      const [row] = await tx
        .update(stores)
        .set(patch)
        .where(and(eq(stores.id, id), eq(stores.companyId, ctx.companyId)))
        .returning();
      if (!row) throw new NotFoundException('Store not found.');
      return row;
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.storeId, id),
            eq(inventoryItems.companyId, ctx.companyId),
          ),
        );
      if (Number(count) > 0) {
        throw new ConflictException(
          'Cannot delete a store that still has inventory.',
        );
      }
      const [row] = await tx
        .delete(stores)
        .where(and(eq(stores.id, id), eq(stores.companyId, ctx.companyId)))
        .returning();
      if (!row) throw new NotFoundException('Store not found.');
      return { deleted: true, id };
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
