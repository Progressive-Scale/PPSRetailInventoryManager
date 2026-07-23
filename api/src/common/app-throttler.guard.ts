import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { hashApiKey } from './crypto.util';

/**
 * Rate-limit tracker: per API key (sync agents), else per JWT (≈ per user),
 * else per IP. Reads headers directly so it works as a global guard (before
 * the auth guards populate req.user / req.apiCompanyId).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const apiKey = req.headers?.['x-api-key'];
    if (typeof apiKey === 'string' && apiKey)
      return `key:${hashApiKey(apiKey).slice(0, 16)}`;
    const auth = req.headers?.['authorization'];
    if (typeof auth === 'string' && auth)
      return `jwt:${hashApiKey(auth).slice(0, 16)}`;
    return `ip:${req.ip ?? 'unknown'}`;
  }
}
