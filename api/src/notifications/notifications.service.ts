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
import { DataContext, isStoreScoped } from '../auth/auth.types';
import { AuditService, diffFields } from '../audit/audit.service';
import { Paginated, resolvePaging } from '../common/pagination';
import {
  ListNotificationsQuery,
  NotificationSettingsDto,
  UpdateNotificationDto,
} from './dto/notifications.dto';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  private storeScope(ctx: DataContext, requested?: number): number | null {
    if (isStoreScoped(ctx.role)) return ctx.storeId ?? null;
    return requested ?? null;
  }

  /**
   * A notification is either broadcast (`user_id` null — everyone in store scope sees
   * it, which is how every notification behaved before targeting existed) or addressed
   * at one person. Every read and every write goes through this, so a reorder
   * acknowledgement cannot show up in a colleague's bell or be dismissed by them.
   */
  private audienceCond(ctx: DataContext): SQL {
    return sql`(${notifications.userId} IS NULL OR ${notifications.userId} = ${ctx.userId})`;
  }

  // ---- notifications -----------------------------------------------------

  async list(
    ctx: DataContext,
    query: ListNotificationsQuery,
  ): Promise<Paginated<Notification>> {
    const { limit, offset } = resolvePaging(query);
    const storeId = this.storeScope(ctx, query.storeId);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const conds: SQL[] = [
        eq(notifications.companyId, ctx.companyId),
        this.audienceCond(ctx),
      ];
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
        this.audienceCond(ctx),
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
            this.audienceCond(ctx),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundException('Notification not found.');
      if (isStoreScoped(ctx.role) && existing.storeId !== ctx.storeId) {
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
   * Apply one status to many notifications. Scoped exactly like remove(), so a
   * store user cannot reach another store's rows or the company-wide ones, and
   * unmatched ids are silently skipped rather than failing the whole batch.
   */
  async setStatus(
    ctx: DataContext,
    ids: number[],
    status: UpdateNotificationDto['status'],
  ): Promise<{ updated: number }> {
    const storeId = this.storeScope(ctx, undefined);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const conds: SQL[] = [
        eq(notifications.companyId, ctx.companyId),
        inArray(notifications.id, ids),
        this.audienceCond(ctx),
      ];
      if (storeId != null) conds.push(eq(notifications.storeId, storeId));
      const rows = await tx
        .update(notifications)
        .set({ status })
        .where(and(...conds))
        .returning({ id: notifications.id });
      return { updated: rows.length };
    });
  }

  /**
   * Permanently remove notifications from the history. Ids outside the caller's
   * company — or, for a store-scoped user, outside their own store — are simply not
   * matched, so nothing leaks and the count reflects what was actually removed.
   */
  async remove(ctx: DataContext, ids: number[]): Promise<{ deleted: number }> {
    const storeId = this.storeScope(ctx, undefined);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const conds: SQL[] = [
        eq(notifications.companyId, ctx.companyId),
        inArray(notifications.id, ids),
        this.audienceCond(ctx),
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
      // The settings ROW is the entity, so its own id is the entity id in both branches —
      // keyed on the scope instead, the company default and a store override would share a
      // history. store_id carries the scope for filtering.
      const scope = dto.storeId != null ? 'store' : 'company default';
      const target = {
        entityType: 'NOTIFICATION_SETTINGS' as const,
        entityId: existing?.id ?? 0,
        storeId: dto.storeId ?? null,
      };
      if (existing) {
        const [row] = await tx
          .update(notificationSettings)
          .set({
            expirationAlertDays: dto.expirationAlertDays,
            enabled: dto.enabled,
          })
          .where(eq(notificationSettings.id, existing.id))
          .returning();
        // Turning alerts off is the change worth noticing — nobody being told stock is
        // expiring looks exactly like nothing expiring.
        await this.audit.recordChanges(
          tx,
          ctx.companyId,
          AuditService.user(ctx),
          target,
          diffFields(existing as unknown as Record<string, unknown>, {
            expirationAlertDays: dto.expirationAlertDays,
            enabled: dto.enabled,
          } as Record<string, unknown>, {
            fields: ['expirationAlertDays', 'enabled'],
            columnFor: { expirationAlertDays: 'expiration_alert_days' },
          }),
          { scope },
        );
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
      await this.audit.record(
        tx,
        ctx.companyId,
        AuditService.user(ctx),
        { ...target, entityId: row.id },
        'CREATED',
        {
          details: {
            scope,
            expirationAlertDays: dto.expirationAlertDays,
            enabled: dto.enabled,
          },
        },
      );
      return row;
    });
  }
}
