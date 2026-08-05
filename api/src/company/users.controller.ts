import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { DataContext } from '../auth/auth.types';
import { TenantDbService } from '../db/tenant-db.service';
import { users, userStores } from '../db/schema';
import { UpdateUserDto } from './company.dto';
import { publicUser, updateCompanyUser } from './user-update.util';
import { AuditService } from '../audit/audit.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN'])
@Controller('users')
export class UsersController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

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
    return this.tenantDb.withCompany(ctx.companyId, (tx) =>
      updateCompanyUser(tx, ctx.companyId, id, dto, {
        service: this.audit,
        actor: AuditService.user(ctx),
      }),
    );
  }
}
