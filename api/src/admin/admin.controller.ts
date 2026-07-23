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
import { asc, eq, sql } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from './platform-admin.guard';
import { TenantDbService } from '../db/tenant-db.service';
import { apiKeys, companies, invitations } from '../db/schema';
import { generateApiKey, generateToken, hashApiKey } from '../common/crypto.util';
import {
  AdminInviteDto,
  CreateApiKeyDto,
  CreateCompanyDto,
  UpdateCompanyDto,
} from './admin.dto';

const apiKeyPublic = {
  id: apiKeys.id,
  companyId: apiKeys.companyId,
  name: apiKeys.name,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
  createdAt: apiKeys.createdAt,
};

@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly tenantDb: TenantDbService) {}

  // ---- companies ---------------------------------------------------------

  @Get('companies')
  listCompanies() {
    return this.tenantDb.withBypass((tx) =>
      tx.select().from(companies).orderBy(asc(companies.id)),
    );
  }

  @Post('companies')
  createCompany(@Body() dto: CreateCompanyDto) {
    return this.tenantDb.withBypass(async (tx) => {
      try {
        const [row] = await tx
          .insert(companies)
          .values({
            name: dto.name,
            slug: dto.slug,
            customDomain: dto.customDomain ?? null,
            branding: {
              logoUrl: dto.logoUrl ?? null,
              primaryColor: dto.primaryColor ?? '#2563eb',
            },
            status: 'ACTIVE',
          })
          .returning();
        return row;
      } catch (err) {
        if (isUnique(err)) {
          throw new ConflictException('slug or custom domain already in use.');
        }
        throw err;
      }
    });
  }

  @Patch('companies/:id')
  updateCompany(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCompanyDto,
  ) {
    return this.tenantDb.withBypass(async (tx) => {
      const [current] = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, id))
        .limit(1);
      if (!current) throw new NotFoundException('Company not found.');

      const branding = {
        ...(current.branding as Record<string, unknown>),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
        ...(dto.primaryColor !== undefined
          ? { primaryColor: dto.primaryColor }
          : {}),
      };
      const patch: Record<string, unknown> = { branding };
      if (dto.name !== undefined) patch.name = dto.name;
      if (dto.status !== undefined) patch.status = dto.status;
      if (dto.customDomain !== undefined) patch.customDomain = dto.customDomain;

      const [row] = await tx
        .update(companies)
        .set(patch)
        .where(eq(companies.id, id))
        .returning();
      return row;
    });
  }

  // ---- api keys ----------------------------------------------------------

  @Get('companies/:id/api-keys')
  listKeys(@Param('id', ParseIntPipe) id: number) {
    return this.tenantDb.withBypass((tx) =>
      tx
        .select(apiKeyPublic)
        .from(apiKeys)
        .where(eq(apiKeys.companyId, id))
        .orderBy(asc(apiKeys.id)),
    );
  }

  @Post('companies/:id/api-keys')
  createKey(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateApiKeyDto,
  ) {
    const plaintext = generateApiKey();
    return this.tenantDb.withBypass(async (tx) => {
      const [company] = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, id))
        .limit(1);
      if (!company) throw new NotFoundException('Company not found.');
      const [row] = await tx
        .insert(apiKeys)
        .values({ companyId: id, name: dto.name, keyHash: hashApiKey(plaintext) })
        .returning(apiKeyPublic);
      // Plaintext shown exactly once.
      return { ...row, key: plaintext };
    });
  }

  @Delete('api-keys/:id')
  @HttpCode(HttpStatus.OK)
  revokeKey(@Param('id', ParseIntPipe) id: number) {
    return this.tenantDb.withBypass(async (tx) => {
      const [row] = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.id, id))
        .returning(apiKeyPublic);
      if (!row) throw new NotFoundException('API key not found.');
      return row;
    });
  }

  // ---- first company admin invitation ------------------------------------

  @Post('companies/:id/admin-invite')
  adminInvite(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AdminInviteDto,
  ) {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 86400_000);
    return this.tenantDb.withBypass(async (tx) => {
      const [company] = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, id))
        .limit(1);
      if (!company) throw new NotFoundException('Company not found.');
      const [row] = await tx
        .insert(invitations)
        .values({
          companyId: id,
          email: dto.email.trim().toLowerCase(),
          role: 'COMPANY_ADMIN',
          token,
          expiresAt,
        })
        .returning();
      return { ...row, acceptPath: `/accept-invite?token=${token}` };
    });
  }

  // ---- health dashboard --------------------------------------------------

  @Get('health')
  async health() {
    return this.tenantDb.withBypass(async (tx) => {
      const result = await tx.execute(sql`
        select c.id, c.slug, c.name, c.status,
          (select max(last_used_at) from api_keys k where k.company_id = c.id) as last_agent_sync,
          (select count(*) from outbox_returns o where o.company_id = c.id and o.delivered_at is null) as undelivered_returns,
          (select count(*) from inventory_items i where i.company_id = c.id) as items,
          (select count(*) from inventory_transactions t where t.company_id = c.id) as transactions
        from companies c order by c.id
      `);
      return { companies: result.rows };
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
