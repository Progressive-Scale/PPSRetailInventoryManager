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
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { and, eq } from 'drizzle-orm';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Ctx } from '../auth/current-user.decorator';
import { CurrentCompany } from '../tenancy/current-tenant.decorator';
import { DataContext } from '../auth/auth.types';
import { TenantDbService } from '../db/tenant-db.service';
import { Company, invitations } from '../db/schema';
import { CreateInvitationDto } from './company.dto';
import { InvitationService } from './invitation.service';
import {
  hashInviteToken,
  invitationState,
  invitationStateMessage,
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

/**
 * A company admin managing their own company's invitations. The rules live in
 * InvitationService, which the platform-admin endpoints share — this controller
 * only pins every call to the caller's own company.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['COMPANY_ADMIN'])
@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly invites: InvitationService,
  ) {}

  /** Invitations with the set of stores each grants on accept (storeIds). */
  @Get()
  list(@Ctx() ctx: DataContext) {
    return this.tenantDb.withCompany(ctx.companyId, (tx) =>
      this.invites.list(tx, ctx.companyId),
    );
  }

  /** Create an invitation and email the accept link. */
  @Post()
  create(@Ctx() ctx: DataContext, @Body() dto: CreateInvitationDto) {
    return this.tenantDb.withCompany(ctx.companyId, (tx) =>
      this.invites.create(tx, {
        companyId: ctx.companyId,
        email: dto.email,
        role: dto.role,
        // storeIds is the modern form; a lone storeId is folded in for compatibility.
        storeIds: dto.storeIds ?? (dto.storeId != null ? [dto.storeId] : []),
        actorUserId: ctx.userId,
      }),
    );
  }

  /**
   * New token + fresh expiry + new email. Invalidates the previous link. Only
   * for invitations that have not been accepted.
   */
  @Post(':id/resend')
  @HttpCode(HttpStatus.OK)
  resend(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.tenantDb.withCompany(ctx.companyId, (tx) =>
      this.invites.resend(tx, {
        companyId: ctx.companyId,
        id,
        actorUserId: ctx.userId,
      }),
    );
  }

  /** Kill an unused link. Idempotent. */
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.tenantDb.withCompany(ctx.companyId, (tx) =>
      this.invites.revoke(tx, {
        companyId: ctx.companyId,
        id,
        actorUserId: ctx.userId,
      }),
    );
  }

  /** Hard delete (kept for cleanup; revoke is preferred for an audit trail). */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Ctx() ctx: DataContext, @Param('id', ParseIntPipe) id: number) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const [row] = await tx
        .delete(invitations)
        .where(and(eq(invitations.id, id), eq(invitations.companyId, ctx.companyId)))
        .returning({ id: invitations.id });
      if (!row) throw new NotFoundException('Invitation not found.');
      return { revoked: true, id };
    });
  }
}
