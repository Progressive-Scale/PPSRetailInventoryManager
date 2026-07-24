import {
  Body,
  Controller,
  NotFoundException,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { DataContext } from '../auth/auth.types';
import { TenantDbService } from '../db/tenant-db.service';
import { companies } from '../db/schema';
import { UpdateBrandingDto } from './company-settings.dto';

/** Company self-service settings (a COMPANY_ADMIN editing their own company). */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN'])
@Controller('company')
export class CompanySettingsController {
  constructor(private readonly tenantDb: TenantDbService) {}

  @Patch('branding')
  updateBranding(@Ctx() ctx: DataContext, @Body() dto: UpdateBrandingDto) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const [company] = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, ctx.companyId))
        .limit(1);
      if (!company) throw new NotFoundException('Company not found.');

      const branding: Record<string, unknown> = {
        ...((company.branding as Record<string, unknown>) ?? {}),
      };
      if (dto.logoUrl !== undefined) {
        branding.logoUrl = dto.logoUrl === '' ? null : dto.logoUrl;
      }
      if (dto.primaryColor !== undefined) {
        branding.primaryColor = dto.primaryColor;
      }

      const [row] = await tx
        .update(companies)
        .set({ branding })
        .where(eq(companies.id, ctx.companyId))
        .returning();
      return { name: row.name, slug: row.slug, branding: row.branding };
    });
  }
}
