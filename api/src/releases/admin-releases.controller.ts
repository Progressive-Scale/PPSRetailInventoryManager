import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlatformAdminGuard } from '../admin/platform-admin.guard';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import { AppRelease, appReleases, releaseChannels } from '../db/schema';
import { CreateReleaseDto, UpdateChannelDto } from './dto/releases.dto';

/** The result of the reachability probe done when a release is created. */
interface UrlCheck {
  ok: boolean;
  status: number | null;
  /** Set when the request never completed — DNS, TLS, timeout. */
  error: string | null;
  /** Content-Length, when the server gave one. */
  sizeBytes: number | null;
}

/**
 * Publishing an APK is an out-of-band act (upload the file, then record it here).
 * These endpoints manage the record and the pointers, never the file.
 */
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('admin')
export class AdminReleasesController {
  constructor(private readonly tenantDb: TenantDbService) {}

  // ---- releases ------------------------------------------------------------

  @Get('releases')
  listReleases() {
    return this.tenantDb.withBypass((tx) =>
      tx.select().from(appReleases).orderBy(desc(appReleases.versionCode)),
    );
  }

  /**
   * Record a published APK.
   *
   * The URL is probed, and a failure is REPORTED, NOT ENFORCED. Static hosting is
   * somebody else's box: it can be briefly down, refuse HEAD, or sit behind a
   * certificate that expired — none of which means the admin typed the URL wrong,
   * and none of which should stop them recording a release they can see is there.
   * The check exists to catch the typo, so it is worth doing and not worth obeying.
   */
  @Post('releases')
  async createRelease(@Body() dto: CreateReleaseDto) {
    const urlCheck = await probeUrl(dto.apkUrl);

    const row = await this.tenantDb.withBypass(async (tx) => {
      try {
        const [created] = await tx
          .insert(appReleases)
          .values({
            versionCode: dto.versionCode,
            versionName: dto.versionName,
            apkUrl: dto.apkUrl,
            apkSha256: dto.apkSha256,
            releaseNotes: dto.releaseNotes ?? null,
            // Fall back to what the server reported, so the size is filled in
            // without anyone having to look it up.
            fileSizeBytes: dto.fileSizeBytes ?? urlCheck.sizeBytes ?? null,
          })
          .returning();
        return created;
      } catch (err) {
        if (isUnique(err)) {
          throw new ConflictException(
            `Version code ${dto.versionCode} already exists. Every build needs its own.`,
          );
        }
        throw err;
      }
    });

    return { ...row, urlCheck };
  }

  // ---- channels ------------------------------------------------------------

  /** Channels with their current and minimum releases resolved for display. */
  @Get('channels')
  async listChannels() {
    return this.tenantDb.withBypass(async (tx) => {
      const channels = await tx
        .select()
        .from(releaseChannels)
        .orderBy(asc(releaseChannels.id));
      const releases = await tx.select().from(appReleases);
      const byId = new Map(releases.map((r) => [r.id, r]));

      // How many companies each channel currently carries — the number that makes
      // "point beta at it first" a considered decision rather than a guess.
      const counts = await tx.execute(sql`
        select release_channel_id as channel_id, count(*)::int as n
        from companies group by release_channel_id
      `);
      const byChannel = new Map(
        (counts.rows as { channel_id: number; n: number }[]).map((r) => [
          r.channel_id,
          r.n,
        ]),
      );

      return channels.map((c) => ({
        ...c,
        release: describe(byId.get(c.releaseId ?? -1)),
        minSupportedRelease: describe(byId.get(c.minSupportedReleaseId ?? -1)),
        companyCount: byChannel.get(c.id) ?? 0,
      }));
    });
  }

  /**
   * Repoint a channel — this IS the rollout mechanism, and also the rollback:
   * moving `release_id` back to the previous row un-offers the bad build, and the
   * old APK is still hosted, so devices that already took it can be moved back.
   */
  @Patch('channels/:id')
  async updateChannel(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateChannelDto,
  ) {
    const setRelease = 'releaseId' in dto;
    const setFloor = 'minSupportedReleaseId' in dto;
    if (!setRelease && !setFloor) {
      throw new BadRequestException('Nothing to change.');
    }

    return this.tenantDb.withBypass(async (tx) => {
      const [current] = await tx
        .select()
        .from(releaseChannels)
        .where(eq(releaseChannels.id, id))
        .limit(1);
      if (!current) throw new NotFoundException('Channel not found.');

      const nextReleaseId = setRelease ? dto.releaseId ?? null : current.releaseId;
      const nextFloorId = setFloor
        ? dto.minSupportedReleaseId ?? null
        : current.minSupportedReleaseId;

      const release = await loadRelease(tx, nextReleaseId);
      const floor = await loadRelease(tx, nextFloorId);
      if (nextReleaseId != null && !release) {
        throw new NotFoundException('That release does not exist.');
      }
      if (nextFloorId != null && !floor) {
        throw new NotFoundException('That minimum release does not exist.');
      }

      // The guard that keeps a channel coherent: offering a build the same channel
      // would then refuse to run is an instruction to update INTO a blocking
      // screen. Checked on version_code, not on id — ids are insertion order, and
      // releases are not always recorded in the order they were built.
      if (release && floor && release.versionCode < floor.versionCode) {
        throw new BadRequestException(
          `Cannot offer ${release.versionName} (${release.versionCode}) on a channel whose ` +
            `minimum supported version is ${floor.versionName} (${floor.versionCode}). ` +
            `Devices would update straight into "no longer supported".`,
        );
      }

      const [row] = await tx
        .update(releaseChannels)
        .set({ releaseId: nextReleaseId, minSupportedReleaseId: nextFloorId })
        .where(eq(releaseChannels.id, id))
        .returning();
      return row;
    });
  }

  // ---- fleet health --------------------------------------------------------

  /**
   * Per company: its channel, and every device that has told us what it runs.
   *
   * Grouped server-side so the panel renders it directly. Companies with no
   * devices are kept — "nothing has reported in" is itself the answer to whether
   * a rollout reached anybody.
   */
  @Get('device-versions')
  async deviceVersions() {
    const result = await this.tenantDb.withBypass((tx) => tx.execute(healthSql()));
    const rows = result.rows as unknown as HealthRow[];

    const companies = new Map<number, ReturnType<typeof emptyCompany>>();
    for (const r of rows) {
      let entry = companies.get(r.company_id);
      if (!entry) {
        entry = emptyCompany(r);
        companies.set(r.company_id, entry);
      }
      if (r.device_identifier) {
        entry.devices.push({
          deviceIdentifier: r.device_identifier,
          versionCode: r.device_version_code,
          versionName: r.device_version_name,
          lastSeenAt: r.last_seen_at,
          username: r.username,
          // The whole point of the view: is this gun on the build its company
          // is supposed to be on?
          current:
            r.channel_version_code != null &&
            r.device_version_code != null &&
            r.device_version_code >= r.channel_version_code,
        });
      }
    }
    return { companies: [...companies.values()] };
  }
}

function emptyCompany(r: HealthRow) {
  return {
    companyId: r.company_id,
    companyName: r.company_name,
    companySlug: r.company_slug,
    channel: r.channel,
    channelVersionCode: r.channel_version_code,
    channelVersionName: r.channel_version_name,
    devices: [] as {
      deviceIdentifier: string;
      versionCode: number | null;
      versionName: string | null;
      lastSeenAt: string | null;
      username: string | null;
      current: boolean;
    }[],
  };
}

/**
 * Fleet health: every company, its channel, and every device that has reported in.
 *
 * This is the half of a staged rollout that tells you whether it worked. Pointing
 * beta at a build is a guess until the guns on beta are seen running it — and a
 * device that stops reporting is the signal that an update broke something.
 *
 * `versionName` is joined from app_releases when the reported code is one we
 * published, and null when it is not. A device on an unrecognised version is worth
 * seeing rather than hiding: it means a sideloaded build.
 */
function healthSql() {
  return sql`
    select c.id            as company_id,
           c.name          as company_name,
           c.slug          as company_slug,
           ch.name         as channel,
           ch_rel.version_code as channel_version_code,
           ch_rel.version_name as channel_version_name,
           d.device_identifier,
           d.version_code  as device_version_code,
           rel.version_name as device_version_name,
           d.last_seen_at,
           u.username
    from companies c
    join release_channels ch on ch.id = c.release_channel_id
    left join app_releases ch_rel on ch_rel.id = ch.release_id
    left join device_app_versions d on d.company_id = c.id
    left join app_releases rel on rel.version_code = d.version_code
    left join users u on u.id = d.user_id
    order by c.id, d.last_seen_at desc nulls last
  `;
}

interface HealthRow {
  company_id: number;
  company_name: string;
  company_slug: string;
  channel: string;
  channel_version_code: number | null;
  channel_version_name: string | null;
  device_identifier: string | null;
  device_version_code: number | null;
  device_version_name: string | null;
  last_seen_at: string | null;
  username: string | null;
}

/** Trimmed release shape for embedding in a channel row. */
function describe(r: AppRelease | undefined) {
  if (!r) return null;
  return {
    id: r.id,
    versionCode: r.versionCode,
    versionName: r.versionName,
    apkUrl: r.apkUrl,
  };
}

async function loadRelease(
  tx: Tx,
  id: number | null,
): Promise<AppRelease | undefined> {
  if (id == null) return undefined;
  const [row] = await tx
    .select()
    .from(appReleases)
    .where(eq(appReleases.id, id))
    .limit(1);
  return row;
}

/**
 * Is anything actually at that URL?
 *
 * HEAD first, then a ranged GET: some static hosts answer HEAD with 403 or 405
 * while serving the file perfectly, and reporting "unreachable" for a file that
 * downloads fine would train people to ignore this warning.
 */
async function probeUrl(url: string): Promise<UrlCheck> {
  const attempt = async (init: RequestInit): Promise<UrlCheck> => {
    const res = await fetch(url, {
      ...init,
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    const len = res.headers.get('content-length');
    return {
      ok: res.ok,
      status: res.status,
      error: null,
      sizeBytes: len ? Number(len) : null,
    };
  };

  try {
    const head = await attempt({ method: 'HEAD' });
    if (head.ok) return head;
    const ranged = await attempt({ method: 'GET', headers: { Range: 'bytes=0-0' } });
    // 206 Partial Content is the good answer to a ranged GET.
    return ranged.status === 206 ? { ...ranged, ok: true } : head;
  } catch (err) {
    return { ok: false, status: null, error: describeFetchError(err), sizeBytes: null };
  }
}

/**
 * Turn a fetch rejection into something an admin can act on. Node buries the
 * useful part in `cause`, and "fetch failed" on its own has sent people looking
 * for a typo in a URL that was fine and hosted behind an expired certificate.
 */
function describeFetchError(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code;
  switch (code) {
    case 'CERT_HAS_EXPIRED':
      return "The host's HTTPS certificate has EXPIRED. Android will refuse this download — renew the certificate before publishing here.";
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return "The HTTPS certificate does not cover this hostname. Android will refuse this download.";
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'The HTTPS certificate is not trusted (self-signed or incomplete chain). Android will refuse this download.';
    case 'ENOTFOUND':
      return 'Host not found — check the domain.';
    case 'ECONNREFUSED':
      return 'Connection refused by the host.';
    default:
      if (err instanceof Error && err.name === 'TimeoutError') {
        return 'The host did not respond within 8 seconds.';
      }
      return cause?.message ?? (err instanceof Error ? err.message : String(err));
  }
}

function isUnique(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}
