import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

/**
 * Guards the /api/sync/* endpoints. The local sync agent must send the shared
 * secret in the `x-api-key` header, matching the SYNC_API_KEY env var.
 */
@Injectable()
export class SyncApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('SYNC_API_KEY');
    if (!expected) {
      throw new UnauthorizedException('Sync API key is not configured.');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.header('x-api-key') ?? '';

    if (!this.safeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid sync API key.');
    }
    return true;
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
