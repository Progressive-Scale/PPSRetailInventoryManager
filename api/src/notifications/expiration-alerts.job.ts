import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  inventoryItems,
  notifications,
  notificationSettings,
  products,
  storeLocations,
} from '../db/schema';

const DEFAULT_ALERT_DAYS = 30;

interface EffectiveSetting {
  days: number;
  enabled: boolean;
}

interface CompanySettings {
  def?: EffectiveSetting;
  byStore: Map<number, EffectiveSetting>;
}

/**
 * Scans ON_FLOOR serialized inventory for units at/near expiration and raises
 * EXPIRATION_WARNING notifications so staff rotate stock. Runs daily and once at
 * boot. Dedupes: skips an item that already has an UNREAD warning. Quantity
 * products have no expiration and are ignored (serialized-only, by design).
 */
@Injectable()
export class ExpirationAlertsJob implements OnModuleInit {
  private readonly logger = new Logger(ExpirationAlertsJob.name);

  constructor(private readonly tenantDb: TenantDbService) {}

  async onModuleInit(): Promise<void> {
    // Run once at startup (best-effort; never block boot on a failure).
    try {
      await this.run();
    } catch (err) {
      this.logger.error('Startup expiration scan failed', err as Error);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async scheduled(): Promise<void> {
    await this.run();
  }

  /** Exposed so an admin endpoint / test can trigger a scan on demand. */
  async run(): Promise<{ created: number }> {
    return this.tenantDb.withBypass(async (tx) => {
      const settings = await this.loadSettings(tx);
      const floors = await tx
        .select({
          companyId: storeLocations.companyId,
          storeId: storeLocations.storeId,
          locationId: storeLocations.id,
        })
        .from(storeLocations)
        // ALL active on-floor locations, not just one — a store may have several.
        // Deactivated floors are excluded from alerting.
        .where(
          and(eq(storeLocations.kind, 'ONFLOOR'), eq(storeLocations.isActive, true)),
        );

      const today = new Date();
      let created = 0;
      for (const floor of floors) {
        const eff = this.effectiveSetting(settings, floor.companyId, floor.storeId);
        if (!eff.enabled) continue;
        const cutoff = new Date(today);
        cutoff.setDate(cutoff.getDate() + eff.days);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        const due = await tx
          .select({
            id: inventoryItems.id,
            serial: inventoryItems.serial,
            productName: products.name,
            expirationDate: inventoryItems.expirationDate,
          })
          .from(inventoryItems)
          .innerJoin(products, eq(products.id, inventoryItems.productId))
          .where(
            and(
              eq(inventoryItems.companyId, floor.companyId),
              eq(inventoryItems.storeId, floor.storeId),
              eq(inventoryItems.locationId, floor.locationId),
              eq(inventoryItems.status, 'ON_HAND'),
              isNotNull(inventoryItems.expirationDate),
              lte(inventoryItems.expirationDate, cutoffStr),
            ),
          );
        if (due.length === 0) continue;

        // Existing UNREAD warnings for this store -> dedupe set of item ids.
        const openRows = await tx
          .select({ itemId: sql<string>`${notifications.payload}->>'itemId'` })
          .from(notifications)
          .where(
            and(
              eq(notifications.companyId, floor.companyId),
              eq(notifications.storeId, floor.storeId),
              eq(notifications.type, 'EXPIRATION_WARNING'),
              eq(notifications.status, 'UNREAD'),
            ),
          );
        const alreadyOpen = new Set(openRows.map((r) => r.itemId));

        const toInsert = [];
        for (const item of due) {
          if (alreadyOpen.has(item.id)) continue;
          const daysLeft = this.daysBetween(today, item.expirationDate!);
          toInsert.push({
            companyId: floor.companyId,
            storeId: floor.storeId,
            type: 'EXPIRATION_WARNING' as const,
            payload: {
              itemId: item.id,
              serial: item.serial,
              productName: item.productName,
              expirationDate: item.expirationDate,
              daysLeft,
              expired: daysLeft <= 0,
            },
            status: 'UNREAD' as const,
          });
        }
        if (toInsert.length > 0) {
          await tx.insert(notifications).values(toInsert);
          created += toInsert.length;
        }
      }
      if (created > 0) {
        this.logger.log(`Created ${created} expiration notification(s).`);
      }
      return { created };
    });
  }

  private async loadSettings(tx: Tx): Promise<Map<number, CompanySettings>> {
    const rows = await tx.select().from(notificationSettings);
    // companyId -> { default, byStore }
    const map = new Map<number, CompanySettings>();
    for (const r of rows) {
      const entry: CompanySettings = map.get(r.companyId) ?? {
        byStore: new Map(),
      };
      const eff: EffectiveSetting = {
        days: r.expirationAlertDays,
        enabled: r.enabled,
      };
      if (r.storeId === null) entry.def = eff;
      else entry.byStore.set(r.storeId, eff);
      map.set(r.companyId, entry);
    }
    return map;
  }

  private effectiveSetting(
    map: Map<number, CompanySettings>,
    companyId: number,
    storeId: number,
  ): EffectiveSetting {
    const entry = map.get(companyId);
    return (
      entry?.byStore.get(storeId) ??
      entry?.def ?? { days: DEFAULT_ALERT_DAYS, enabled: true }
    );
  }

  private daysBetween(from: Date, isoDate: string): number {
    const to = new Date(`${isoDate}T00:00:00Z`);
    const fromUtc = Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
    );
    return Math.round((to.getTime() - fromUtc) / 86_400_000);
  }
}
