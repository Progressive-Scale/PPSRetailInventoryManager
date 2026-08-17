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
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from './platform-admin.guard';
import { TenantDbService } from '../db/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { apiKeys, companies, releaseChannels } from '../db/schema';
import { generateApiKey, hashApiKey } from '../common/crypto.util';
import { CreateApiKeyDto, CreateCompanyDto, UpdateCompanyDto } from './admin.dto';

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
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  // ---- companies ---------------------------------------------------------

  // The channel NAME rides along so the panel's dropdown can show the current
  // value without a second request and a client-side join.
  @Get('companies')
  listCompanies() {
    return this.tenantDb.withBypass((tx) =>
      tx
        .select({
          id: companies.id,
          name: companies.name,
          slug: companies.slug,
          customDomain: companies.customDomain,
          branding: companies.branding,
          status: companies.status,
          createdAt: companies.createdAt,
          releaseChannelId: companies.releaseChannelId,
          releaseChannel: releaseChannels.name,
        })
        .from(companies)
        .innerJoin(
          releaseChannels,
          eq(releaseChannels.id, companies.releaseChannelId),
        )
        .orderBy(asc(companies.id)),
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

      // Moving a company between release channels changes what software its staff
      // run, so it is recorded in THEIR history — by channel name, because an id
      // means nothing to the person reading it back months later.
      const movingChannel =
        dto.releaseChannelId !== undefined &&
        dto.releaseChannelId !== current.releaseChannelId;
      let channelNames: { from: string | null; to: string | null } | null = null;

      if (movingChannel) {
        const rows = await tx
          .select({ id: releaseChannels.id, name: releaseChannels.name })
          .from(releaseChannels)
          .where(
            inArray(releaseChannels.id, [
              current.releaseChannelId,
              dto.releaseChannelId!,
            ]),
          );
        const byId = new Map(rows.map((r) => [r.id, r.name]));
        if (!byId.has(dto.releaseChannelId!)) {
          throw new NotFoundException('That release channel does not exist.');
        }
        channelNames = {
          from: byId.get(current.releaseChannelId) ?? null,
          to: byId.get(dto.releaseChannelId!) ?? null,
        };
        patch.releaseChannelId = dto.releaseChannelId;
      }

      const [row] = await tx
        .update(companies)
        .set(patch)
        .where(eq(companies.id, id))
        .returning();

      if (channelNames) {
        // A platform admin is not one of this tenant's users, so the actor is a
        // system one flagged as such — the same treatment as admin user edits.
        await this.audit.record(
          tx,
          id,
          AuditService.job(),
          { entityType: 'COMPANY', entityId: id },
          'UPDATED',
          {
            field: 'release_channel',
            oldValue: channelNames.from,
            newValue: channelNames.to,
            details: { byPlatformAdmin: true },
          },
        );
      }

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

  // Inviting into a company (including its first admin) lives in
  // AdminInvitationsController, which shares the tenant invitation service.

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
