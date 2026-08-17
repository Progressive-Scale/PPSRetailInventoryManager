import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';
import { AuthUser } from '../auth/auth.types';
import { TenantDbService } from '../db/tenant-db.service';
import { deviceAppVersions } from '../db/schema';

/** Longest device identifier we will store. ANDROID_ID is 16; a UUID is 36. */
const MAX_DEVICE_ID = 128;

/**
 * How long to trust a previous report for the same device on the same version.
 *
 * Without this, every API call a scanner makes writes a row — hundreds during one
 * cycle count, all saying the same thing. The value of this data is "which build,
 * roughly when", and five minutes is far finer than that question needs.
 */
const WINDOW_MS = 5 * 60_000;

/** Cap on the dedupe map, so a stream of novel device ids cannot grow it forever. */
const MAX_TRACKED = 5000;

/**
 * Records what each device says it is running, from the X-App-Version and
 * X-Device-Id headers the scanner attaches to every call.
 *
 * Runs on AUTHENTICATED requests only — an interceptor executes after the guards,
 * so req.user is populated and the company is known. Anonymous callers (including
 * the version check itself) are ignored: there would be no tenant to file them
 * under.
 *
 * Nothing here may affect the response. The write is fired without being awaited
 * and its failures are logged and swallowed: telemetry must never be the reason a
 * store cannot count its stock.
 */
@Injectable()
export class DeviceVersionInterceptor implements NestInterceptor {
  private readonly logger = new Logger(DeviceVersionInterceptor.name);
  private readonly recent = new Map<string, number>();

  constructor(private readonly tenantDb: TenantDbService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      this.capture(context.switchToHttp().getRequest<Request & { user?: AuthUser }>());
    }
    return next.handle();
  }

  private capture(req: Request & { user?: AuthUser }): void {
    const companyId = req.user?.companyId;
    if (companyId == null) return;

    const deviceId = header(req, 'x-device-id')?.slice(0, MAX_DEVICE_ID);
    if (!deviceId) return;

    const raw = header(req, 'x-app-version');
    const versionCode = raw != null && /^\d+$/.test(raw) ? Number(raw) : null;
    if (versionCode == null || versionCode < 1) return;

    // Keyed on the version too, so an update is recorded the moment it lands
    // rather than waiting out the window on the old build's entry.
    const key = `${companyId}:${deviceId}:${versionCode}`;
    const now = Date.now();
    const last = this.recent.get(key);
    if (last != null && now - last < WINDOW_MS) return;
    this.remember(key, now);

    const userId = req.user?.userId ?? null;
    void this.tenantDb
      .withCompany(companyId, async (tx) => {
        await tx
          .insert(deviceAppVersions)
          .values({
            companyId,
            userId,
            deviceIdentifier: deviceId,
            versionCode,
            lastSeenAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              deviceAppVersions.companyId,
              deviceAppVersions.deviceIdentifier,
            ],
            set: { versionCode, userId, lastSeenAt: new Date() },
          });
      })
      .catch((err) => {
        // Drop the memo so the next request retries rather than waiting out the
        // window on a write that never happened.
        this.recent.delete(key);
        this.logger.warn(
          `Could not record device version for company ${companyId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }

  private remember(key: string, now: number): void {
    if (this.recent.size >= MAX_TRACKED) {
      // Evict everything already stale; if that frees nothing (all entries are
      // fresh), drop the oldest insertion, which Map iteration gives us first.
      for (const [k, t] of this.recent) {
        if (now - t >= WINDOW_MS) this.recent.delete(k);
      }
      if (this.recent.size >= MAX_TRACKED) {
        const oldest = this.recent.keys().next();
        if (!oldest.done) this.recent.delete(oldest.value);
      }
    }
    this.recent.set(key, now);
  }
}

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() ? s.trim() : undefined;
}
