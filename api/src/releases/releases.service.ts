import { Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  AppRelease,
  ReleaseChannel,
  appReleases,
  companies,
  releaseChannels,
} from '../db/schema';

/**
 * The channel every unresolved caller gets. Named once, because "when in doubt,
 * stable" is a rule and not a coincidence — see resolveChannel().
 */
export const DEFAULT_CHANNEL = 'stable';

/** What GET /api/app/version answers. */
export interface VersionAnswer {
  /** Which channel this answer came from — useful in support and in logs. */
  channel: string;
  /**
   * True when the caller told us what it is running and it is at or ahead of the
   * channel's release (or the channel offers nothing at all).
   */
  upToDate: boolean;
  latestVersionCode: number | null;
  latestVersionName: string | null;
  apkUrl: string | null;
  sha256: string | null;
  releaseNotes: string | null;
  fileSizeBytes: number | null;
  /** Below this, the app must refuse to run until updated. Null = no floor. */
  minSupportedVersionCode: number | null;
}

@Injectable()
export class ReleasesService {
  constructor(private readonly tenantDb: TenantDbService) {}

  /**
   * Answer the version question for a company (or for nobody in particular).
   *
   * `companyId` null — an unresolvable host, or a caller with no token — is not an
   * error. It gets the stable channel: a device that cannot say who it belongs to
   * should still be able to learn that it is running something unsupported, and
   * the conservative channel is the safe thing to hand a stranger.
   */
  async resolveVersion(
    companyId: number | null,
    current?: number,
  ): Promise<VersionAnswer> {
    return this.tenantDb.withBypass(async (tx) => {
      const channel = await this.resolveChannel(tx, companyId);

      // No channel row at all should be impossible (both are seeded by migration
      // 0039), but answering "up to date, nothing on offer" beats throwing on a
      // path whose whole job is to be reachable.
      if (!channel) {
        return {
          channel: DEFAULT_CHANNEL,
          upToDate: true,
          latestVersionCode: null,
          latestVersionName: null,
          apkUrl: null,
          sha256: null,
          releaseNotes: null,
          fileSizeBytes: null,
          minSupportedVersionCode: null,
        };
      }

      const ids = [channel.releaseId, channel.minSupportedReleaseId].filter(
        (id): id is number => id != null,
      );
      const rows: AppRelease[] = ids.length
        ? await tx.select().from(appReleases).where(inArray(appReleases.id, ids))
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));

      const latest = channel.releaseId ? byId.get(channel.releaseId) : undefined;
      const floor = channel.minSupportedReleaseId
        ? byId.get(channel.minSupportedReleaseId)
        : undefined;

      // A channel pointing at nothing offers nothing, and a caller already at or
      // ahead of the pointer is done. That second case is the one that matters:
      // a company moved from beta back to stable is running a HIGHER version code
      // than stable offers, and must never be walked backwards into an install
      // that Android would refuse anyway.
      const upToDate =
        !latest || (current != null && current >= latest.versionCode);

      return {
        channel: channel.name,
        upToDate,
        latestVersionCode: latest?.versionCode ?? null,
        latestVersionName: latest?.versionName ?? null,
        apkUrl: latest?.apkUrl ?? null,
        sha256: latest?.apkSha256 ?? null,
        releaseNotes: latest?.releaseNotes ?? null,
        fileSizeBytes: latest?.fileSizeBytes ?? null,
        minSupportedVersionCode: floor?.versionCode ?? null,
      };
    });
  }

  /**
   * The company's channel, falling back to stable — including when the company id
   * names a row that no longer exists.
   */
  private async resolveChannel(
    tx: Tx,
    companyId: number | null,
  ): Promise<ReleaseChannel | undefined> {
    if (companyId != null) {
      const [company] = await tx
        .select({ channelId: companies.releaseChannelId })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (company) {
        const [row] = await tx
          .select()
          .from(releaseChannels)
          .where(eq(releaseChannels.id, company.channelId))
          .limit(1);
        if (row) return row;
      }
    }

    const [fallback] = await tx
      .select()
      .from(releaseChannels)
      .where(eq(releaseChannels.name, DEFAULT_CHANNEL))
      .limit(1);
    return fallback;
  }
}
