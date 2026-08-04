import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../auth/auth.types';
import { PlatformAdminGuard } from './platform-admin.guard';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import { companies, invitations } from '../db/schema';
import { InvitationService } from '../company/invitation.service';
import { AdminCreateInvitationDto } from './admin.dto';

/** How an invitee is told who invited them when a platform admin does the inviting. */
const PLATFORM_INVITER = 'Platform admin';

/**
 * Invite users into ANY company, and manage those invitations — for when a tenant
 * cannot get an invitation out themselves.
 *
 * Every rule is InvitationService's, the same one the tenant's own screen uses: an
 * address that is already a user is refused, a new link supersedes the previous one,
 * and stores are proved to belong to the company. This controller only chooses the
 * company and records the platform admin as the actor.
 */
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('admin')
export class AdminInvitationsController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly invites: InvitationService,
  ) {}

  /** One company's invitations, newest first. */
  @Get('companies/:id/invitations')
  list(@Param('id', ParseIntPipe) id: number) {
    return this.tenantDb.withBypass(async (tx) => {
      await assertCompany(tx, id);
      return this.invites.list(tx, id);
    });
  }

  /**
   * Invite one user into this company. Called once per person — there is no batch
   * form on purpose, so a typo in one address cannot take the others down with it.
   */
  @Post('companies/:id/invitations')
  create(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AdminCreateInvitationDto,
  ) {
    return this.tenantDb.withBypass(async (tx) => {
      await assertCompany(tx, id);
      return this.invites.create(tx, {
        companyId: id,
        email: dto.email,
        role: dto.role,
        storeIds: dto.storeIds ?? [],
        actorUserId: actor.userId,
        inviterName: PLATFORM_INVITER,
      });
    });
  }

  /** New token, fresh expiry, new email. The previous link stops working. */
  @Post('invitations/:id/resend')
  @HttpCode(HttpStatus.OK)
  resend(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.tenantDb.withBypass(async (tx) => {
      const companyId = await companyOfInvitation(tx, id);
      return this.invites.resend(tx, {
        companyId,
        id,
        actorUserId: actor.userId,
        inviterName: PLATFORM_INVITER,
      });
    });
  }

  /** Kill an unused link. Idempotent. */
  @Post('invitations/:id/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(@CurrentUser() actor: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.tenantDb.withBypass(async (tx) => {
      const companyId = await companyOfInvitation(tx, id);
      return this.invites.revoke(tx, { companyId, id, actorUserId: actor.userId });
    });
  }
}

async function assertCompany(tx: Tx, id: number): Promise<void> {
  const [company] = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, id))
    .limit(1);
  if (!company) throw new NotFoundException('Company not found.');
}

/**
 * Resolve the invitation's own company, since the platform admin addresses these by
 * id alone. The service still re-checks the pair, so a wrong company here cannot
 * reach across tenants.
 */
async function companyOfInvitation(tx: Tx, id: number): Promise<number> {
  const [row] = await tx
    .select({ companyId: invitations.companyId })
    .from(invitations)
    .where(eq(invitations.id, id))
    .limit(1);
  if (!row) throw new NotFoundException('Invitation not found.');
  return row.companyId;
}
