import { Controller, Get, Query, Req } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtPayload } from '../auth/auth.types';
import { TenantService } from '../tenancy/tenant.service';
import { AppVersionQuery } from './dto/releases.dto';
import { ReleasesService, VersionAnswer } from './releases.service';

/**
 * What build should this device be running?
 *
 * PUBLIC on purpose, and exempted from TenantGuard in tenant.guard.ts. The two
 * reasons are the same reason: a device that cannot authenticate is exactly the
 * device most likely to need an update. Gating this behind a login would mean an
 * app broken badly enough to fail login could never be told to update itself, and
 * a host we cannot resolve would 404 instead of answering.
 *
 * Nothing here is sensitive — a version number, a public URL, and the hash of a
 * file anyone can download from it.
 */
@Controller('app')
export class AppVersionController {
  constructor(
    private readonly releases: ReleasesService,
    private readonly tenants: TenantService,
    private readonly jwt: JwtService,
  ) {}

  // Devices check on every launch and on demand — the app used to throttle this to
  // once per six hours and no longer does. The ceiling is per-IP for anonymous
  // callers, and a store's guns share one NAT address, so it is set well above what
  // a shopful of scanners can produce even when they all restart at shift change.
  @Get('version')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async version(
    @Req() req: Request,
    @Query() query: AppVersionQuery,
  ): Promise<VersionAnswer> {
    const companyId = await this.resolveCompanyId(req);
    return this.releases.resolveVersion(companyId, query.current);
  }

  /**
   * Who is asking: the token first, then the host, then nobody.
   *
   * The token wins because it is the precise answer — the host may be a bare
   * domain shared by several tenants' bookmarks, while a token names one company.
   */
  private async resolveCompanyId(req: Request): Promise<number | null> {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      try {
        const payload = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
        if (payload.companyId != null) return payload.companyId;
      } catch {
        // Deliberately swallowed. An expired or malformed token must not break
        // the update path: the most common reason a device is carrying a bad
        // token is that its build is old, which is what this endpoint is for.
        // Fall through to the host.
      }
    }

    const ctx = await this.tenants.resolve(req.headers.host);
    return ctx.kind === 'company' ? ctx.company.id : null;
  }
}
