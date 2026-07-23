import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { DataContext } from '../auth/auth.types';
import { TenantDbService } from '../db/tenant-db.service';
import { users } from '../db/schema';
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

  @Get()
  list(@Ctx() ctx: DataContext) {
    return this.tenantDb.withCompany(ctx.companyId, (tx) =>
      tx
        .select(publicUser)
        .from(users)
        .where(eq(users.companyId, ctx.companyId))
        .orderBy(asc(users.id)),
    );
  }

  @Patch(':id')
  update(
    @Ctx() ctx: DataContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
  ) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const patch: Record<string, unknown> = {};
      if (dto.role !== undefined) patch.role = dto.role;
      if (dto.status !== undefined) patch.status = dto.status;
      if (dto.storeId !== undefined) patch.storeId = dto.storeId;
      const [row] = await tx
        .update(users)
        .set(patch)
        .where(and(eq(users.id, id), eq(users.companyId, ctx.companyId)))
        .returning(publicUser);
      if (!row) throw new NotFoundException('User not found.');
      return row;
    });
  }
}
