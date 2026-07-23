import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { CurrentCompany } from '../tenancy/current-tenant.decorator';
import { DataContext } from '../auth/auth.types';
import { TenantDbService } from '../db/tenant-db.service';
import { Company, invitations } from '../db/schema';
import { generateToken } from '../common/crypto.util';
import { CreateInvitationDto } from './company.dto';

const INVITE_TTL_DAYS = 7;

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN'])
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly tenantDb: TenantDbService) {}

  @Get()
  list(@Ctx() ctx: DataContext) {
    return this.tenantDb.withCompany(ctx.companyId, (tx) =>
      tx
        .select()
        .from(invitations)
        .where(eq(invitations.companyId, ctx.companyId))
        .orderBy(desc(invitations.id)),
    );
  }

  @Post()
  create(
    @Ctx() ctx: DataContext,
    @CurrentCompany() company: Company,
    @Body() dto: CreateInvitationDto,
  ) {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const [row] = await tx
        .insert(invitations)
        .values({
          companyId: ctx.companyId,
          email: dto.email.trim().toLowerCase(),
          role: dto.role,
          storeId: dto.storeId ?? null,
          token,
          expiresAt,
        })
        .returning();
      // The accept URL lives on the company's own subdomain.
      return { ...row, acceptPath: `/accept-invite?token=${token}` };
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  revoke(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const [row] = await tx
        .delete(invitations)
        .where(
          and(
            eq(invitations.id, id),
            eq(invitations.companyId, ctx.companyId),
          ),
        )
        .returning();
      if (!row) throw new NotFoundException('Invitation not found.');
      return { revoked: true, id };
    });
  }
}
