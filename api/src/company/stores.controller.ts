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
import {
  inventoryItems,
  inventoryStock,
  notifications,
  notificationSettings,
  stores,
  storeLocations,
} from '../db/schema';
import { CreateStoreDto, UpdateStoreDto } from './company.dto';
import { createSystemLocations } from '../locations/location-util';

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
      const [row] = await tx
        .insert(stores)
        .values({
          companyId: ctx.companyId,
          name: dto.name,
          address1: dto.address1 ?? null,
          address2: dto.address2 ?? null,
          city: dto.city ?? null,
          state: dto.state ?? null,
          zip: dto.zip ?? null,
          notes: dto.notes ?? null,
          isActive: dto.isActive ?? true,
        })
        .returning();
      // Every store starts with its two system locations (Backroom / On Floor).
      await createSystemLocations(tx, ctx.companyId, row.id);
      return row;
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
      if (dto.address1 !== undefined) patch.address1 = dto.address1;
      if (dto.address2 !== undefined) patch.address2 = dto.address2;
      if (dto.city !== undefined) patch.city = dto.city;
      if (dto.state !== undefined) patch.state = dto.state;
      if (dto.zip !== undefined) patch.zip = dto.zip;
      if (dto.notes !== undefined) patch.notes = dto.notes;
      if (dto.isActive !== undefined) patch.isActive = dto.isActive;
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
      const [store] = await tx
        .select({ id: stores.id })
        .from(stores)
        .where(and(eq(stores.id, id), eq(stores.companyId, ctx.companyId)))
        .limit(1);
      if (!store) throw new NotFoundException('Store not found.');

      // Block deletion while the store still holds inventory (serialized units
      // or quantity stock) — make it inactive instead.
      const [items] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(inventoryItems)
        .where(
          and(eq(inventoryItems.storeId, id), eq(inventoryItems.companyId, ctx.companyId)),
        );
      const [stock] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(inventoryStock)
        .where(
          and(eq(inventoryStock.storeId, id), eq(inventoryStock.companyId, ctx.companyId)),
        );
      if (Number(items.n) > 0 || Number(stock.n) > 0) {
        throw new ConflictException(
          'Cannot delete a store that still has inventory. Make it inactive instead.',
        );
      }

      // Remove the store's own auto-created dependents, then the store. Any
      // other reference (assigned users, cycle-count history) trips a FK error,
      // which we surface as a "make it inactive" conflict.
      try {
        await tx
          .delete(notifications)
          .where(
            and(eq(notifications.storeId, id), eq(notifications.companyId, ctx.companyId)),
          );
        await tx
          .delete(notificationSettings)
          .where(
            and(
              eq(notificationSettings.storeId, id),
              eq(notificationSettings.companyId, ctx.companyId),
            ),
          );
        await tx
          .delete(storeLocations)
          .where(
            and(eq(storeLocations.storeId, id), eq(storeLocations.companyId, ctx.companyId)),
          );
        await tx
          .delete(stores)
          .where(and(eq(stores.id, id), eq(stores.companyId, ctx.companyId)));
      } catch (err) {
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code?: string }).code === '23503'
        ) {
          throw new ConflictException(
            'This store has related records (users or cycle-count history). Make it inactive instead.',
          );
        }
        throw err;
      }
      return { deleted: true, id };
    });
  }
}
