import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { TenantService } from './tenant.service';
import { HostContext } from './tenant-context';

/**
 * Global guard (runs before controller/route guards). Resolves the Host header
 * to a tenant and attaches it to the request. Unknown host -> 404, suspended
 * company -> 403. Skipped for /api/sync/* (API-key auth) and /api/health.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly tenantService: TenantService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenant?: HostContext }>();

    const path = req.path || req.url || '';
    if (path.startsWith('/api/sync') || path.startsWith('/api/health')) {
      return true;
    }
    // The scanner's update check answers on ANY host, resolvable or not, and
    // falls back to the stable channel when it cannot tell who is asking. A 404
    // here would mean a device on a mistyped or retired host could never be told
    // it is running an unsupported build — the one message it most needs.
    if (path.startsWith('/api/app/version')) return true;

    const ctx = await this.tenantService.resolve(req.headers.host);
    if (ctx.kind === 'unknown') {
      throw new NotFoundException('Unknown host / tenant.');
    }
    if (ctx.kind === 'company' && ctx.company.status === 'SUSPENDED') {
      throw new ForbiddenException('This company is suspended.');
    }

    req.tenant = ctx;
    return true;
  }
}
