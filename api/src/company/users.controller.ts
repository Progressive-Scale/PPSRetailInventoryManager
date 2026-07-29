import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { DataContext } from '../auth/auth.types';
import { TenantDbService } from '../db/tenant-db.service';
import { stores, users, userStores } from '../db/schema';
import { UpdateUserDto } from './company.dto';

// Safe projection (never expose password_hash).
const publicUser = {
  id: users.id,
  companyId: users.companyId,
  storeId: users.storeId,
  email: users.email,
  role: users.role,
  status: users.status,
  createdAt: users.createdAt,
};

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN'])
@Controller('users')
export class UsersController {
  constructor(private readonly tenantDb: TenantDbService) {}

  /** Users with the set of stores each may access (storeIds). */
  @Get()
  list(@Ctx() ctx: DataContext) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const rows = await tx
        .select(publicUser)
        .from(users)
        .where(eq(users.companyId, ctx.companyId))
        .orderBy(asc(users.id));
      const links = await tx
        .select({ userId: userStores.userId, storeId: userStores.storeId })
        .from(userStores)
        .where(eq(userStores.companyId, ctx.companyId));
      const byUser = new Map<number, number[]>();
      for (const l of links) {
        const list = byUser.get(l.userId) ?? [];
        list.push(l.storeId);
        byUser.set(l.userId, list);
      }
      return rows.map((u) => ({ ...u, storeIds: byUser.get(u.id) ?? [] }));
    });
  }

  @Patch(':id')
  update(
    @Ctx() ctx: DataContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
  ) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const [existing] = await tx
        .select(publicUser)
        .from(users)
        .where(and(eq(users.id, id), eq(users.companyId, ctx.companyId)))
        .limit(1);
      if (!existing) throw new NotFoundException('User not found.');

      // Replace the permitted-store set, validating every id is in-company.
      let permitted: number[] | undefined;
      if (dto.storeIds !== undefined) {
        permitted = [...new Set(dto.storeIds)];
        if (permitted.length > 0) {
          const owned = await tx
            .select({ id: stores.id })
            .from(stores)
            .where(and(eq(stores.companyId, ctx.companyId), inArray(stores.id, permitted)));
          if (owned.length !== permitted.length) {
            throw new BadRequestException('One or more stores are not in your company.');
          }
        }
        await tx
          .delete(userStores)
          .where(and(eq(userStores.userId, id), eq(userStores.companyId, ctx.companyId)));
        if (permitted.length > 0) {
          await tx.insert(userStores).values(
            permitted.map((storeId) => ({ companyId: ctx.companyId, userId: id, storeId })),
          );
        }
      }

      const patch: Record<string, unknown> = {};
      if (dto.role !== undefined) patch.role = dto.role;
      if (dto.status !== undefined) patch.status = dto.status;
      if (dto.storeId !== undefined) patch.storeId = dto.storeId;

      // Keep the active store consistent with the permitted set: it must be one
      // of them (auto-pick when there's exactly one, clear when it's no longer allowed).
      if (permitted !== undefined) {
        const active = (dto.storeId !== undefined ? dto.storeId : existing.storeId) ?? null;
        if (permitted.length === 0) patch.storeId = null;
        else if (active == null || !permitted.includes(active)) {
          patch.storeId = permitted.length === 1 ? permitted[0] : null;
        }
      } else if (dto.storeId != null) {
        const [allowed] = await tx
          .select({ id: userStores.id })
          .from(userStores)
          .where(
            and(
              eq(userStores.userId, id),
              eq(userStores.storeId, dto.storeId),
              eq(userStores.companyId, ctx.companyId),
            ),
          )
          .limit(1);
        if (!allowed) {
          throw new BadRequestException(
            'That store is not one of the user’s assigned stores.',
          );
        }
      }

      let row = existing;
      if (Object.keys(patch).length > 0) {
        [row] = await tx
          .update(users)
          .set(patch)
          .where(and(eq(users.id, id), eq(users.companyId, ctx.companyId)))
          .returning(publicUser);
      }
      const links = await tx
        .select({ storeId: userStores.storeId })
        .from(userStores)
        .where(and(eq(userStores.userId, id), eq(userStores.companyId, ctx.companyId)));
      return { ...row, storeIds: links.map((l) => l.storeId) };
    });
  }
}
