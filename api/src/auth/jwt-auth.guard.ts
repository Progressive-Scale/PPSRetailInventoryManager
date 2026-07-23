import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthUser, JwtPayload } from './auth.types';
import { HostContext } from '../tenancy/tenant-context';

/**
 * Verifies the JWT and enforces that the token's company matches the
 * host-resolved company (blocks cross-tenant token replay). On an admin host,
 * requires a PLATFORM_ADMIN token.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenant?: HostContext; user?: AuthUser }>();

    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedException('Missing bearer token');

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const tenant = req.tenant;
    if (tenant?.kind === 'company') {
      if (payload.companyId !== tenant.company.id) {
        throw new UnauthorizedException('Token does not match this tenant.');
      }
    } else if (tenant?.kind === 'admin') {
      if (payload.role !== 'PLATFORM_ADMIN') {
        throw new UnauthorizedException('Platform admin token required.');
      }
    }

    req.user = {
      userId: payload.sub,
      companyId: payload.companyId,
      storeId: payload.storeId,
      role: payload.role,
    };
    return true;
  }

  private extractToken(req: Request): string | undefined {
    const header = req.headers.authorization;
    if (!header) return undefined;
    const [type, value] = header.split(' ');
    return type === 'Bearer' ? value : undefined;
  }
}
