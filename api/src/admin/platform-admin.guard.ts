import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthUser } from '../auth/auth.types';
import { HostContext } from '../tenancy/tenant-context';

/**
 * Platform-admin gate. Must be on the admin host AND carry a PLATFORM_ADMIN
 * token. Use together with JwtAuthGuard (which verifies the token first).
 * Cross-tenant access is opt-in per endpoint (each handler uses withBypass).
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ tenant?: HostContext; user?: AuthUser }>();
    if (req.tenant?.kind !== 'admin') {
      throw new ForbiddenException('Admin host required.');
    }
    if (req.user?.role !== 'PLATFORM_ADMIN') {
      throw new ForbiddenException('Platform admin only.');
    }
    return true;
  }
}
