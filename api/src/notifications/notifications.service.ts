import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql, SQL } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  Notification,
  notifications,
  notificationSettings,
  stores,
} from '../db/schema';
import { DataContext } from '../auth/auth.types';
import { Paginated, resolvePaging } from '../common/pagination';
import {
  ListNotificationsQuery,
  NotificationSettingsDto,
  UpdateNotificationDto,
} from './dto/notifications.dto';

@Injectable()
export class NotificationsService {
  constructor(private readonly tenantDb: TenantDbService) {}

  private storeScope(ctx: DataContext, requested?: number): number | null {
    if (ctx.role === 'STORE_USER') return ctx.storeId ?? null;
    return requested ?? null;
  }

  // ---- notifications -----------------------------------------------------

  async list(
    ctx: DataContext,
    query: ListNotificationsQuery,
  ): Promise<Paginated<Notification>> {
    const { limit, offset } = resolvePaging(query);
    const storeId = this.storeScope(ctx, query.storeId);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const conds: SQL[] = [eq(notifications.companyId, ctx.companyId)];
      if (storeId != null) conds.push(eq(notifications.storeId, storeId));
      if (query.status) conds.push(eq(notifications.status, query.status));
      if (query.type) conds.push(eq(notifications.type, query.type));
      const where = and(...conds);
      const data = await tx
        .select()
        .from(notifications)
        .where(where)
        .orderBy(desc(notifications.createdAt))
        .limit(limit)
        .offset(offset);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(notifications)
        .where(where);
      return { data, total: Number(count), limit, offset };
    });
  }

  /** Count of UNREAD notifications in scope (drives the header bell badge). */
  async unreadCount(ctx: DataContext, requestedStoreId?: number) {
    const storeId = this.storeScope(ctx, requestedStoreId);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const conds: SQL[] = [
        eq(notifications.companyId, ctx.companyId),
        eq(notifications.status, 'UNREAD'),
      ];
      if (storeId != null) conds.push(eq(notifications.storeId, storeId));
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(notifications)
        .where(and(...conds));
      return { unread: Number(count) };
    });
  }

  async updateStatus(ctx: DataContext, id: number, dto: UpdateNotificationDto) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.companyId, ctx.companyId),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundException('Notification not found.');
      if (ctx.role === 'STORE_USER' && existing.storeId !== ctx.storeId) {
        throw new NotFoundException('Notification not found.');
      }
      const [row] = await tx
        .update(notifications)
        .set({ status: dto.status })
        .where(eq(notifications.id, id))
        .returning();
      return row;
    });
  }

  /**
   * Permanently remove notifications from the history. Ids outside the caller's
   * company — or, for a STORE_USER, outside their own store — are simply not
   * matched, so nothing leaks and the count reflects what was actually removed.
   */
  async remove(ctx: DataContext, ids: number[]): Promise<{ deleted: number }> {
    const storeId = this.storeScope(ctx, undefined);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const conds: SQL[] = [
        eq(notifications.companyId, ctx.companyId),
        inArray(notifications.id, ids),
      ];
      // A store user may only clear their own store's alerts; company-wide rows
      // (store_id null) belong to admins.
      if (storeId != null) conds.push(eq(notifications.storeId, storeId));
      const removed = await tx
        .delete(notifications)
        .where(and(...conds))
        .returning({ id: notifications.id });
      return { deleted: removed.length };
    });
  }

  // ---- settings (COMPANY_ADMIN) ------------------------------------------

  async getSettings(ctx: DataContext) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const rows = await tx
        .select()
        .from(notificationSettings)
        .where(eq(notificationSettings.companyId, ctx.companyId));
      const companyDefault = rows.find((r) => r.storeId === null) ?? null;
      const overrides = rows.filter((r) => r.storeId !== null);
      return { companyDefault, overrides };
    });
  }

  async putSettings(ctx: DataContext, dto: NotificationSettingsDto) {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      if (dto.storeId != null) {
        const [store] = await tx
          .select({ id: stores.id })
          .from(stores)
          .where(
            and(
              eq(stores.id, dto.storeId),
              eq(stores.companyId, ctx.companyId),
            ),
          )
          .limit(1);
        if (!store) throw new BadRequestException('Unknown store.');
      }
      const match = and(
        eq(notificationSettings.companyId, ctx.companyId),
        dto.storeId != null
          ? eq(notificationSettings.storeId, dto.storeId)
          : isNull(notificationSettings.storeId),
      );
      const [existing] = await tx
        .select()
        .from(notificationSettings)
        .where(match)
        .limit(1);
      if (existing) {
        const [row] = await tx
          .update(notificationSettings)
          .set({
            expirationAlertDays: dto.expirationAlertDays,
            enabled: dto.enabled,
          })
          .where(eq(notificationSettings.id, existing.id))
          .returning();
        return row;
      }
      const [row] = await tx
        .insert(notificationSettings)
        .values({
          companyId: ctx.companyId,
          storeId: dto.storeId ?? null,
          expirationAlertDays: dto.expirationAlertDays,
          enabled: dto.enabled,
        })
        .returning();
      return row;
    });
  }
}
