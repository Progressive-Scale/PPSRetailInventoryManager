import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SQL, and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PasswordResetService } from '../auth/password-reset.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import { companies, stores, users, userStores } from '../db/schema';
import { Paginated, resolvePaging } from '../common/pagination';
import { publicUser, updateCompanyUser } from '../company/user-update.util';
import { AuditService } from '../audit/audit.service';
import { AdminUpdateUserDto, AdminUserQuery } from './admin.dto';

/** A user row as the platform panel shows it: whose tenant, and which stores. */
interface AdminUserRow {
  id: number;
  companyId: number | null;
  companyName: string | null;
  companySlug: string | null;
  storeId: number | null;
  storeIds: number[];
  storeNames: string[];
  email: string;
  username: string;
  role: string;
  status: string;
  createdAt: Date;
}

/**
 * Every user in the system, and the few things a platform admin may change about
 * one — for when a tenant cannot do it themselves.
 *
 * Two gates, both required (see PlatformAdminGuard): the admin host AND a
 * PLATFORM_ADMIN token. That matters more here than elsewhere because every handler
 * runs under `withBypass`, which turns RLS off — the isolation that would otherwise
 * still contain a guard mistake is not there to catch one.
 */
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('admin')
export class AdminUsersController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly resets: PasswordResetService,
    private readonly audit: AuditService,
  ) {}

  /** Cross-tenant user list. Filter by company, role, status, or name/email. */
  @Get('users')
  list(@Query() query: AdminUserQuery): Promise<Paginated<AdminUserRow>> {
    const { limit, offset } = resolvePaging(query);
    const conds: SQL[] = [];
    if (query.companyId != null) conds.push(eq(users.companyId, query.companyId));
    if (query.role) conds.push(eq(users.role, query.role));
    if (query.status) conds.push(eq(users.status, query.status));
    if (query.q?.trim()) {
      const term = `%${likeEscape(query.q.trim())}%`;
      conds.push(or(ilike(users.username, term), ilike(users.email, term)) as SQL);
    }
    const where = conds.length > 0 ? and(...conds) : undefined;

    return this.tenantDb.withBypass(async (tx) => {
      const [counted] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(users)
        .where(where);

      const rows = await tx
        .select({
          ...publicUser,
          companyName: companies.name,
          companySlug: companies.slug,
        })
        .from(users)
        .leftJoin(companies, eq(companies.id, users.companyId))
        .where(where)
        // Grouped by tenant, then by the name you would search for. Platform
        // admins have no company, so they land at the end (NULLs sort last).
        .orderBy(asc(companies.name), asc(users.username))
        .limit(limit)
        .offset(offset);

      const byUser = await this.storesOf(
        tx,
        rows.map((r) => r.id),
      );
      return {
        data: rows.map((r) => ({
          ...r,
          storeIds: (byUser.get(r.id) ?? []).map((s) => s.id),
          storeNames: (byUser.get(r.id) ?? []).map((s) => s.name),
        })),
        total: counted?.total ?? 0,
        limit,
        offset,
      };
    });
  }

  /**
   * Role, status and permitted stores of a tenant user — the same three things
   * their own company admin can change, applied through the same shared function.
   */
  @Patch('users/:id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AdminUpdateUserDto,
  ) {
    return this.tenantDb.withBypass(async (tx) => {
      const companyId = await this.tenantCompanyOf(tx, id);
      // A platform admin is not one of the tenant's users, so the event is a system actor
      // flagged as such rather than a name their company cannot look up.
      return updateCompanyUser(tx, companyId, id, dto, {
        service: this.audit,
        actor: AuditService.job(),
        details: { byPlatformAdmin: true },
      });
    });
  }

  /**
   * Issue a password-reset link for a tenant user and return it. The email is sent
   * as well; the link comes back so it can be handed over when the mailbox is the
   * problem — which is the whole reason a platform admin is doing this.
   */
  @Post('users/:id/password-reset')
  @HttpCode(HttpStatus.OK)
  async passwordReset(@Param('id', ParseIntPipe) id: number) {
    return this.resets.issueForUser(id);
  }

  /** Stores of one company — the picker behind user store assignment and invites. */
  @Get('companies/:id/stores')
  companyStores(@Param('id', ParseIntPipe) id: number) {
    return this.tenantDb.withBypass(async (tx) => {
      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, id))
        .limit(1);
      if (!company) throw new NotFoundException('Company not found.');
      return tx
        .select()
        .from(stores)
        .where(eq(stores.companyId, id))
        .orderBy(asc(stores.name));
    });
  }

  // ---- internals ---------------------------------------------------------

  /**
   * The company of a user this screen is allowed to touch.
   *
   * Platform-admin accounts are refused: they have no company to scope the update
   * to, and letting one platform admin demote or suspend another from a list of
   * every user in the system is how you lock everybody out of the panel.
   */
  private async tenantCompanyOf(tx: Tx, id: number): Promise<number> {
    const [target] = await tx
      .select({ companyId: users.companyId, role: users.role })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!target) throw new NotFoundException('User not found.');
    if (target.role === 'PLATFORM_ADMIN' || target.companyId == null) {
      throw new BadRequestException(
        'Platform-admin accounts are not managed from this screen.',
      );
    }
    return target.companyId;
  }

  /** Permitted stores (id + name) for a page of users, in one query. */
  private async storesOf(
    tx: Tx,
    userIds: number[],
  ): Promise<Map<number, { id: number; name: string }[]>> {
    const byUser = new Map<number, { id: number; name: string }[]>();
    if (userIds.length === 0) return byUser;
    const links = await tx
      .select({
        userId: userStores.userId,
        storeId: userStores.storeId,
        storeName: stores.name,
      })
      .from(userStores)
      .innerJoin(stores, eq(stores.id, userStores.storeId))
      .where(inArray(userStores.userId, userIds))
      .orderBy(asc(stores.name));
    for (const l of links) {
      const list = byUser.get(l.userId) ?? [];
      list.push({ id: l.storeId, name: l.storeName });
      byUser.set(l.userId, list);
    }
    return byUser;
  }
}

/** Neutralise LIKE wildcards in a user-typed search term. */
function likeEscape(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
