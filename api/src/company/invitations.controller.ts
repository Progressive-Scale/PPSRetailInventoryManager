import {
  BadRequestException,
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
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { CurrentCompany } from '../tenancy/current-tenant.decorator';
import { DataContext } from '../auth/auth.types';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  Company,
  companies,
  invitationStores,
  invitations,
  stores,
  users,
} from '../db/schema';
import { MailService } from '../mail/mail.service';
import { CreateInvitationDto } from './company.dto';
import {
  assertEmailNotTaken,
  buildAcceptUrl,
  generateInviteToken,
  hashInviteToken,
  invitationState,
  invitationStateMessage,
  supersedeLiveInvitations,
  inviteExpiry,
} from './invitation.util';

class TokenQuery {
  @IsString() @MinLength(8) @MaxLength(256) token!: string;
}

/** Public, unauthenticated invitation lookup (per-tenant host). */
@Controller('invitations')
export class PublicInvitationsController {
  constructor(private readonly tenantDb: TenantDbService) {}

  /**
   * Powers the accept page. Reveals nothing beyond the state itself unless the
   * invitation is VALID. Rate-limited per IP (the global tracker falls back to
   * IP for unauthenticated calls).
   */
  @Get('status')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async status(
    @CurrentCompany() company: Company,
    @Query() query: TokenQuery,
  ): Promise<{
    state: string;
    message: string;
    email?: string;
    companyName?: string;
    role?: string;
  }> {
    return this.tenantDb.withCompany(company.id, async (tx) => {
      const [inv] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, hashInviteToken(query.token)))
        .limit(1);
      const state = invitationState(inv);
      if (state !== 'VALID') {
        return { state, message: invitationStateMessage(state) };
      }
      return {
        state,
        message: '',
        email: inv.email,
        companyName: company.name,
        role: inv.role,
      };
    });
  }
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN'])
@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /** Invitations with the set of stores each grants on accept (storeIds). */
  @Get()
  list(@Ctx() ctx: DataContext) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const rows = await tx
        .select({
          id: invitations.id,
          companyId: invitations.companyId,
          email: invitations.email,
          role: invitations.role,
          storeId: invitations.storeId,
          expiresAt: invitations.expiresAt,
          acceptedAt: invitations.acceptedAt,
          revokedAt: invitations.revokedAt,
          revokedByUserId: invitations.revokedByUserId,
          emailStatus: invitations.emailStatus,
          emailSentAt: invitations.emailSentAt,
          emailError: invitations.emailError,
          createdAt: invitations.createdAt,
        })
        .from(invitations)
        .where(eq(invitations.companyId, ctx.companyId))
        .orderBy(desc(invitations.id));

      const links = await tx
        .select({
          invitationId: invitationStores.invitationId,
          storeId: invitationStores.storeId,
        })
        .from(invitationStores)
        .where(eq(invitationStores.companyId, ctx.companyId));
      const byInvitation = new Map<number, number[]>();
      for (const l of links) {
        const list = byInvitation.get(l.invitationId) ?? [];
        list.push(l.storeId);
        byInvitation.set(l.invitationId, list);
      }
      return rows.map((r) => ({ ...r, storeIds: byInvitation.get(r.id) ?? [] }));
    });
  }

  /** Create an invitation and email the accept link. */
  @Post()
  create(
    @Ctx() ctx: DataContext,
    @CurrentCompany() company: Company,
    @Body() dto: CreateInvitationDto,
  ) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      // Never invite an address that is already a user, and keep only one live
      // invitation per address (this one supersedes any earlier link).
      await assertEmailNotTaken(tx, ctx.companyId, dto.email);
      await supersedeLiveInvitations(tx, ctx.companyId, dto.email, ctx.userId);

      // storeIds is the modern form; a lone storeId is folded in for compatibility.
      const requested = dto.storeIds ?? (dto.storeId != null ? [dto.storeId] : []);
      const permitted = [...new Set(requested)];
      if (permitted.length > 0) {
        const owned = await tx
          .select({ id: stores.id })
          .from(stores)
          .where(and(eq(stores.companyId, ctx.companyId), inArray(stores.id, permitted)));
        if (owned.length !== permitted.length) {
          throw new BadRequestException('One or more stores are not in your company.');
        }
      }

      const token = generateInviteToken();
      const [row] = await tx
        .insert(invitations)
        .values({
          companyId: ctx.companyId,
          email: dto.email.trim().toLowerCase(),
          role: dto.role,
          // Mirrors the single-store case so older readers keep working.
          storeId: permitted.length === 1 ? permitted[0] : null,
          tokenHash: hashInviteToken(token),
          expiresAt: inviteExpiry(),
        })
        .returning();

      if (permitted.length > 0) {
        await tx.insert(invitationStores).values(
          permitted.map((storeId) => ({
            companyId: ctx.companyId,
            invitationId: row.id,
            storeId,
          })),
        );
      }

      const res = await this.deliver(
        tx,
        ctx,
        row.id,
        row.email,
        row.role,
        row.expiresAt,
        token,
      );
      return { ...res, storeIds: permitted };
    });
  }

  /**
   * New token + fresh expiry + new email. Invalidates the previous link. Only
   * for invitations that have not been accepted.
   */
  @Post(':id/resend')
  @HttpCode(HttpStatus.OK)
  resend(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const inv = await this.load(tx, ctx, id);
      if (inv.acceptedAt) {
        throw new BadRequestException('This invitation was already accepted.');
      }
      // Resend revives this row, so any OTHER live invitation for the same address
      // has to give way — otherwise two links for one person would be redeemable.
      await assertEmailNotTaken(tx, ctx.companyId, inv.email);
      await supersedeLiveInvitations(tx, ctx.companyId, inv.email, ctx.userId, id);

      const token = generateInviteToken();
      const expiresAt = inviteExpiry();
      const [row] = await tx
        .update(invitations)
        .set({
          tokenHash: hashInviteToken(token),
          expiresAt,
          // Resending revives a revoked invite and clears the last send result.
          revokedAt: null,
          revokedByUserId: null,
          emailStatus: 'PENDING',
          emailSentAt: null,
          emailError: null,
        })
        .where(eq(invitations.id, id))
        .returning();
      return this.deliver(tx, ctx, row.id, row.email, row.role, expiresAt, token);
    });
  }

  /** Kill an unused link. Idempotent. */
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const inv = await this.load(tx, ctx, id);
      if (inv.revokedAt) return { revoked: true, id, alreadyRevoked: true };
      if (inv.acceptedAt) {
        throw new BadRequestException(
          'This invitation was already accepted and cannot be revoked.',
        );
      }
      await tx
        .update(invitations)
        .set({ revokedAt: new Date(), revokedByUserId: ctx.userId })
        .where(eq(invitations.id, id));
      return { revoked: true, id };
    });
  }

  /** Hard delete (kept for cleanup; revoke is preferred for an audit trail). */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const [row] = await tx
        .delete(invitations)
        .where(and(eq(invitations.id, id), eq(invitations.companyId, ctx.companyId)))
        .returning();
      if (!row) throw new NotFoundException('Invitation not found.');
      return { revoked: true, id };
    });
  }

  // ---- internals ---------------------------------------------------------

  private async load(tx: Tx, ctx: DataContext, id: number) {
    const [inv] = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, id), eq(invitations.companyId, ctx.companyId)))
      .limit(1);
    if (!inv) throw new NotFoundException('Invitation not found.');
    return inv;
  }

  /**
   * Send the invitation email and record the outcome. A failure never fails the
   * request: the row is marked FAILED with the reason and the response carries a
   * warning plus the accept URL so the admin can copy the link instead.
   */
  private async deliver(
    tx: Tx,
    ctx: DataContext,
    id: number,
    email: string,
    role: string,
    expiresAt: Date,
    token: string,
  ) {
    const [company] = await tx
      .select({ name: companies.name, slug: companies.slug })
      .from(companies)
      .where(eq(companies.id, ctx.companyId))
      .limit(1);
    const [inviter] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);

    const acceptUrl = buildAcceptUrl({
      slug: company.slug,
      rootDomain: this.config.get<string>('ROOT_DOMAIN') ?? 'yourapp.local',
      token,
      baseUrlOverride: this.config.get<string>('APP_BASE_URL') || undefined,
    });

    const result = await this.mail.sendInvitationEmail(email, {
      companyName: company.name,
      inviterName: inviter?.email ?? 'An administrator',
      role,
      acceptUrl,
      expiresAt,
    });

    const [row] = await tx
      .update(invitations)
      .set(
        result.ok
          ? { emailStatus: 'SENT', emailSentAt: new Date(), emailError: null }
          : { emailStatus: 'FAILED', emailError: result.error ?? 'send failed' },
      )
      .where(eq(invitations.id, id))
      .returning();

    return {
      ...row,
      // The plaintext token is returned ONLY here, to the admin who created or
      // resent it — never retrievable later.
      acceptUrl,
      acceptPath: `/accept-invite?token=${encodeURIComponent(token)}`,
      emailWarning: result.ok
        ? null
        : 'Invitation created but the email failed to send — resend or copy the link.',
    };
  }
}
