import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { TenantDbService } from '../db/tenant-db.service';
import { apiKeys } from '../db/schema';
import { hashApiKey } from '../common/crypto.util';

/**
 * Resolves the X-Api-Key header to a company (by hash). No JWT, no host tenancy.
 * Attaches req.apiCompanyId and bumps last_used_at.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly tenantDb: TenantDbService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { apiCompanyId?: number }>();

    const provided = req.header('x-api-key');
    if (!provided) throw new UnauthorizedException('Missing X-Api-Key header.');

    const keyHash = hashApiKey(provided);

    const companyId = await this.tenantDb.withBypass(async (tx) => {
      const [row] = await tx
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
        .limit(1);
      if (!row) return null;
      await tx
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, row.id));
      return row.companyId;
    });

    if (companyId == null) throw new UnauthorizedException('Invalid API key.');
    req.apiCompanyId = companyId;
    return true;
  }
}
