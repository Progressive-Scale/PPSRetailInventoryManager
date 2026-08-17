import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, sql, SQL } from 'drizzle-orm';
import { DataContext, isStoreScoped } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  notifications,
  products,
  reorderRequests,
  ReorderStatus,
  stores,
  users,
} from '../db/schema';
import { Paginated, resolvePaging } from '../common/pagination';
import { CreateReorderDto, ListReordersQuery } from './dto/reorders.dto';

/** A reorder plus the names needed to display it. */
export interface ReorderRow {
  id: number;
  storeId: number;
  storeName: string;
  productId: number;
  sku: string;
  productName: string;
  upc: string | null;
  trackingType: string;
  status: ReorderStatus;
  quantityRequested: number | null;
  note: string | null;
  requestedByUserId: number | null;
  requestedBy: string | null;
  externalOrderRef: string | null;
  createdAt: Date;
  acknowledgedAt: Date | null;
  cancelledAt: Date | null;
}

@Injectable()
export class ReordersService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Which store this request is for.
   *
   * A store-scoped user is pinned: their own store wins over anything in the body, so a
   * crafted `storeId` cannot raise a request against a store they cannot see. A
   * COMPANY_ADMIN spans stores and therefore has to say which one — there is no
   * sensible default, and guessing "the first one" would silently reorder for the
   * wrong shop.
   */
  private resolveStoreId(ctx: DataContext, requested?: number): number {
    if (isStoreScoped(ctx.role)) {
      if (ctx.storeId == null) {
        throw new BadRequestException(
          'Your account is not assigned to a store, so it cannot raise a reorder.',
        );
      }
      return ctx.storeId;
    }
    if (requested == null) {
      throw new BadRequestException('storeId is required when you manage several stores.');
    }
    return requested;
  }

  private baseSelect() {
    return {
      id: reorderRequests.id,
      storeId: reorderRequests.storeId,
      storeName: stores.name,
      productId: reorderRequests.productId,
      sku: products.sku,
      productName: products.name,
      upc: products.upc,
      trackingType: products.trackingType,
      status: reorderRequests.status,
      quantityRequested: reorderRequests.quantityRequested,
      note: reorderRequests.note,
      requestedByUserId: reorderRequests.requestedByUserId,
      requestedBy: users.username,
      externalOrderRef: reorderRequests.externalOrderRef,
      createdAt: reorderRequests.createdAt,
      acknowledgedAt: reorderRequests.acknowledgedAt,
      cancelledAt: reorderRequests.cancelledAt,
    };
  }

  private rowsQuery(tx: Tx, where: SQL, order: 'oldest' | 'newest') {
    return tx
      .select(this.baseSelect())
      .from(reorderRequests)
      .innerJoin(products, eq(products.id, reorderRequests.productId))
      .innerJoin(stores, eq(stores.id, reorderRequests.storeId))
      // LEFT: the requester may since have been removed, and losing the request with
      // them would be worse than showing it with no name.
      .leftJoin(users, eq(users.id, reorderRequests.requestedByUserId))
      .where(where)
      .orderBy(
        order === 'oldest'
          ? asc(reorderRequests.createdAt)
          : desc(reorderRequests.createdAt),
      );
  }

  private async loadRow(tx: Tx, companyId: number, id: number) {
    const [row] = await this.rowsQuery(
      tx,
      and(
        eq(reorderRequests.companyId, companyId),
        eq(reorderRequests.id, id),
      ) as SQL,
      'newest',
    ).limit(1);
    return row as ReorderRow | undefined;
  }

  /**
   * Raise a reorder, or hand back the one that is already open.
   *
   * Pressing the button twice is one impatient user, not two requests — so the
   * duplicate guard is not an error path. `created` tells the caller which happened
   * so the dialog can say "already requested by X" instead of claiming success.
   */
  async create(
    ctx: DataContext,
    dto: CreateReorderDto,
  ): Promise<{ created: boolean; request: ReorderRow }> {
    const storeId = this.resolveStoreId(ctx, dto.storeId);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const [store] = await tx
        .select({ id: stores.id })
        .from(stores)
        .where(and(eq(stores.id, storeId), eq(stores.companyId, ctx.companyId)))
        .limit(1);
      if (!store) throw new NotFoundException('Store not found.');

      const [product] = await tx
        .select({ id: products.id, active: products.active })
        .from(products)
        .where(
          and(
            eq(products.id, dto.productId),
            eq(products.companyId, ctx.companyId),
          ),
        )
        .limit(1);
      if (!product) throw new NotFoundException('Product not found.');
      if (!product.active) {
        throw new BadRequestException(
          'That product is inactive. Reactivate it before reordering.',
        );
      }

      const existingOpen = await this.findOpen(tx, ctx.companyId, storeId, dto.productId);
      if (existingOpen) return { created: false, request: existingOpen };

      try {
        const [inserted] = await tx
          .insert(reorderRequests)
          .values({
            companyId: ctx.companyId,
            storeId,
            productId: dto.productId,
            quantityRequested: dto.quantity ?? null,
            note: dto.note?.trim() || null,
            requestedByUserId: ctx.userId,
          })
          .returning({ id: reorderRequests.id });
        // Only the real creation is audited. The duplicate-guard path above returns the
        // existing request without writing anything, and an event there would read as a
        // second request that never happened.
        // Loaded first so the event can name the product: "reordered CAP-RED" is readable
        // in the activity stream, "reorder #13" sends the reader off to look it up.
        const request = (await this.loadRow(tx, ctx.companyId, inserted.id))!;
        await this.audit.record(
          tx,
          ctx.companyId,
          AuditService.user(ctx),
          { entityType: 'REORDER', entityId: inserted.id, storeId },
          'CREATED',
          {
            details: {
              productId: dto.productId,
              sku: request.sku ?? null,
              quantityRequested: dto.quantity ?? null,
              note: dto.note?.trim() || null,
            },
          },
        );
        return { created: true, request };
      } catch (err) {
        // Two people pressing Reorder at the same moment lose the race here rather
        // than in the read above. Same answer either way: return the live request.
        if (isUniqueViolation(err)) {
          const raced = await this.findOpen(tx, ctx.companyId, storeId, dto.productId);
          if (raced) return { created: false, request: raced };
        }
        throw err;
      }
    });
  }

  private async findOpen(
    tx: Tx,
    companyId: number,
    storeId: number,
    productId: number,
  ): Promise<ReorderRow | undefined> {
    const [row] = await this.rowsQuery(
      tx,
      and(
        eq(reorderRequests.companyId, companyId),
        eq(reorderRequests.storeId, storeId),
        eq(reorderRequests.productId, productId),
        eq(reorderRequests.status, 'OPEN'),
      ) as SQL,
      'newest',
    ).limit(1);
    return row as ReorderRow | undefined;
  }

  /** Cancel an OPEN request. Anything else is already finished. */
  async cancel(ctx: DataContext, id: number): Promise<ReorderRow> {
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const existing = await this.loadRow(tx, ctx.companyId, id);
      if (!existing) throw new NotFoundException('Reorder request not found.');
      // A store user may only touch their own store's requests.
      if (isStoreScoped(ctx.role) && existing.storeId !== ctx.storeId) {
        throw new NotFoundException('Reorder request not found.');
      }
      if (existing.status !== 'OPEN') {
        throw new ConflictException(
          existing.status === 'ACKNOWLEDGED'
            ? `Already acknowledged${existing.externalOrderRef ? ` as order ${existing.externalOrderRef}` : ''} — it cannot be cancelled here.`
            : 'That request is already cancelled.',
        );
      }
      await tx
        .update(reorderRequests)
        .set({ status: 'CANCELLED', cancelledAt: new Date() })
        .where(
          and(
            eq(reorderRequests.id, id),
            eq(reorderRequests.companyId, ctx.companyId),
            // Guard in the predicate too: between the read and the write another
            // request could have acked it, and cancelling an acked request would
            // hide an order that has already been raised in the ERP.
            eq(reorderRequests.status, 'OPEN'),
          ),
        );
      const row = (await this.loadRow(tx, ctx.companyId, id))!;
      await this.audit.record(
        tx,
        ctx.companyId,
        AuditService.user(ctx),
        { entityType: 'REORDER', entityId: id, storeId: row.storeId },
        'CANCELLED',
        { details: { productId: row.productId, sku: row.sku ?? null } },
      );
      return row;
    });
  }

  async list(
    ctx: DataContext,
    query: ListReordersQuery,
  ): Promise<Paginated<ReorderRow>> {
    const { limit, offset } = resolvePaging(query);
    // A store user sees their own store, whatever they ask for.
    const storeId = isStoreScoped(ctx.role) ? ctx.storeId : (query.storeId ?? null);
    return this.tenantDb.withCompany(ctx.companyId, async (tx) => {
      const conds: SQL[] = [eq(reorderRequests.companyId, ctx.companyId)];
      if (storeId != null) conds.push(eq(reorderRequests.storeId, storeId));
      if (query.status) conds.push(eq(reorderRequests.status, query.status));
      if (query.productId != null)
        conds.push(eq(reorderRequests.productId, query.productId));
      const where = and(...conds) as SQL;
      const data = (await this.rowsQuery(tx, where, 'newest')
        .limit(limit)
        .offset(offset)) as ReorderRow[];
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(reorderRequests)
        .where(where);
      return { data, total: Number(count), limit, offset };
    });
  }
}

/**
 * Consumer-facing (X-Api-Key) half of the reorder feature.
 *
 * Deliberately knows nothing about pps or any other ERP: it lists open requests with
 * enough product identity to match against a foreign catalog, and takes back an opaque
 * order reference. See docs/SYNC.md §6 — the contract is written so any ERP can
 * consume it, and the sync agent is only the first consumer.
 */
@Injectable()
export class ReorderContractService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  /** Oldest first, so a backlog is worked in the order the shops asked. */
  async list(
    companyId: number,
    status: ReorderStatus,
    limit = 100,
    offset = 0,
  ): Promise<Paginated<ConsumerReorder>> {
    const take = Math.min(Math.max(limit, 1), 500);
    const skip = Math.max(offset, 0);
    return this.tenantDb.withCompany(companyId, async (tx) => {
      const where = and(
        eq(reorderRequests.companyId, companyId),
        eq(reorderRequests.status, status),
      ) as SQL;
      const rows = await tx
        .select({
          reorderId: reorderRequests.id,
          retailStoreId: reorderRequests.storeId,
          sku: products.sku,
          upc: products.upc,
          name: products.name,
          trackingType: products.trackingType,
          quantityRequested: reorderRequests.quantityRequested,
          note: reorderRequests.note,
          createdAt: reorderRequests.createdAt,
          // Who asked. The consumer shows this to whoever is deciding, and "the produce
          // manager asked for this" is most of what makes a request decidable.
          requestedBy: users.username,
        })
        .from(reorderRequests)
        .innerJoin(products, eq(products.id, reorderRequests.productId))
        .leftJoin(users, eq(users.id, reorderRequests.requestedByUserId))
        .where(where)
        .orderBy(asc(reorderRequests.createdAt), asc(reorderRequests.id))
        .limit(take)
        .offset(skip);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(reorderRequests)
        .where(where);
      return {
        data: rows.map((r) => ({
          reorderId: r.reorderId,
          retailStoreId: r.retailStoreId,
          product: {
            sku: r.sku,
            upc: r.upc,
            name: r.name,
            trackingType: r.trackingType,
          },
          quantityRequested: r.quantityRequested,
          note: r.note,
          createdAt: r.createdAt,
          requestedBy: r.requestedBy ?? null,
        })),
        total: Number(count),
        limit: take,
        offset: skip,
      };
    });
  }

  /**
   * "I raised order X for this request."
   *
   * Idempotent for the SAME reference, because a consumer that created its order and
   * then failed to record the ack must be able to repeat it — that is the whole basis
   * of the apply-locally-then-acknowledge rule in docs/SYNC.md.
   *
   * A DIFFERENT reference is a conflict, never an overwrite: two orders now exist for
   * one request, and only a human can decide which is real. Overwriting would quietly
   * lose the first order number.
   */
  async ack(
    companyId: number,
    id: number,
    externalOrderRef: string,
    /** Which API key acted, for attribution. Null when a caller cannot say. */
    apiKeyId?: number | null,
  ): Promise<{ status: 'acknowledged' | 'already_acknowledged'; reorderId: number; externalOrderRef: string }> {
    const ref = externalOrderRef.trim();
    return this.tenantDb.withCompany(companyId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(reorderRequests)
        .where(
          and(
            eq(reorderRequests.id, id),
            eq(reorderRequests.companyId, companyId),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFoundException('Reorder request not found.');

      if (existing.status === 'CANCELLED') {
        // 410 rather than 409: the request is gone for good, so the right consumer
        // behaviour is to log it and move on, not to retry or escalate.
        throw new GoneException(
          `Reorder ${id} was cancelled by the store and cannot be acknowledged.`,
        );
      }

      if (existing.status === 'ACKNOWLEDGED') {
        if (existing.externalOrderRef === ref) {
          return {
            status: 'already_acknowledged' as const,
            reorderId: id,
            externalOrderRef: ref,
          };
        }
        throw new ConflictException(
          `Reorder ${id} is already acknowledged as order ${existing.externalOrderRef}. ` +
            `Refusing to replace that with ${ref} — one of the two orders is a duplicate and needs a human.`,
        );
      }

      const now = new Date();
      // SYNC_AGENT, not a person: the external reference is the whole point of the event,
      // so it goes in details where the global stream can show it.
      await this.audit.record(
        tx,
        companyId,
        AuditService.agent(apiKeyId ?? null),
        { entityType: 'REORDER', entityId: id, storeId: existing.storeId },
        'ACKNOWLEDGED',
        { details: { externalOrderRef: ref, productId: existing.productId } },
      );
      await tx
        .update(reorderRequests)
        .set({ status: 'ACKNOWLEDGED', acknowledgedAt: now, externalOrderRef: ref })
        .where(
          and(
            eq(reorderRequests.id, id),
            eq(reorderRequests.companyId, companyId),
            // Only from OPEN: if a concurrent ack won the race, this update matches
            // nothing rather than rewriting its reference.
            eq(reorderRequests.status, 'OPEN'),
          ),
        );

      await this.notifyRequester(tx, companyId, existing, ref);
      return { status: 'acknowledged' as const, reorderId: id, externalOrderRef: ref };
    });
  }

  /**
   * The ERP looked at the request and said no.
   *
   * The counterpart of ack(), and the reason it exists: a reorder declined in pps used to
   * have nowhere to go, so the request sat OPEN forever and the agent re-offered it every
   * sweep. Cancelling is what stops that and what tells the store.
   *
   * Same guards as ack in the other direction — an ACKNOWLEDGED request cannot be
   * declined, because an order for it already exists in the ERP and hiding the request
   * would hide the order.
   */
  async decline(
    companyId: number,
    id: number,
    reason: string | undefined,
    apiKeyId?: number | null,
  ): Promise<{ status: 'declined' | 'already_declined'; reorderId: number }> {
    const why = reason?.trim() || null;
    return this.tenantDb.withCompany(companyId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(reorderRequests)
        .where(
          and(eq(reorderRequests.id, id), eq(reorderRequests.companyId, companyId)),
        )
        .limit(1);
      if (!existing) throw new NotFoundException('Reorder request not found.');

      // Idempotent: a redelivered decline is the same decision arriving twice.
      if (existing.status === 'CANCELLED') {
        return { status: 'already_declined' as const, reorderId: id };
      }

      if (existing.status === 'ACKNOWLEDGED') {
        throw new ConflictException(
          `Reorder ${id} is already acknowledged as order ${existing.externalOrderRef}. ` +
            'Declining it now would hide an order that has already been raised.',
        );
      }

      await this.audit.record(
        tx,
        companyId,
        AuditService.agent(apiKeyId ?? null),
        { entityType: 'REORDER', entityId: id, storeId: existing.storeId },
        'DECLINED',
        { details: { productId: existing.productId, reason: why } },
      );
      await tx
        .update(reorderRequests)
        .set({ status: 'CANCELLED', cancelledAt: new Date() })
        .where(
          and(
            eq(reorderRequests.id, id),
            eq(reorderRequests.companyId, companyId),
            // Only from OPEN, so an ack that won the race is not overwritten.
            eq(reorderRequests.status, 'OPEN'),
          ),
        );

      await this.notifyRequesterDeclined(tx, companyId, existing, why);
      return { status: 'declined' as const, reorderId: id };
    });
  }

  /**
   * Tell whoever asked that their request turned into an order. Addressed at that one
   * user — a colleague's bell should not fill up with other people's answers — and
   * skipped entirely when the request has no requester (seeded or imported rows).
   */
  private async notifyRequester(
    tx: Tx,
    companyId: number,
    request: { id: number; storeId: number; productId: number; requestedByUserId: number | null; quantityRequested: number | null },
    externalOrderRef: string,
  ): Promise<void> {
    if (request.requestedByUserId == null) return;
    const [product] = await tx
      .select({ sku: products.sku, name: products.name })
      .from(products)
      .where(eq(products.id, request.productId))
      .limit(1);
    const [store] = await tx
      .select({ name: stores.name })
      .from(stores)
      .where(eq(stores.id, request.storeId))
      .limit(1);
    await tx.insert(notifications).values({
      companyId,
      storeId: request.storeId,
      userId: request.requestedByUserId,
      type: 'REORDER_ACKNOWLEDGED',
      payload: {
        reorderId: request.id,
        productId: request.productId,
        sku: product?.sku ?? null,
        productName: product?.name ?? null,
        storeId: request.storeId,
        storeName: store?.name ?? null,
        quantityRequested: request.quantityRequested,
        externalOrderRef,
      },
      status: 'UNREAD',
    });
  }

  /** Same audience and shape as the acknowledgement, carrying the reason instead. */
  private async notifyRequesterDeclined(
    tx: Tx,
    companyId: number,
    request: {
      id: number;
      storeId: number;
      productId: number;
      requestedByUserId: number | null;
      quantityRequested: number | null;
    },
    reason: string | null,
  ): Promise<void> {
    if (request.requestedByUserId == null) return;
    const [product] = await tx
      .select({ sku: products.sku, name: products.name })
      .from(products)
      .where(eq(products.id, request.productId))
      .limit(1);
    const [store] = await tx
      .select({ name: stores.name })
      .from(stores)
      .where(eq(stores.id, request.storeId))
      .limit(1);
    await tx.insert(notifications).values({
      companyId,
      storeId: request.storeId,
      userId: request.requestedByUserId,
      type: 'REORDER_DECLINED',
      payload: {
        reorderId: request.id,
        productId: request.productId,
        sku: product?.sku ?? null,
        productName: product?.name ?? null,
        storeId: request.storeId,
        storeName: store?.name ?? null,
        quantityRequested: request.quantityRequested,
        reason,
      },
      status: 'UNREAD',
    });
  }
}

export interface ConsumerReorder {
  reorderId: number;
  retailStoreId: number;
  /** Username of whoever asked, or null on a seeded/imported request. */
  requestedBy?: string | null;
  product: {
    sku: string;
    upc: string | null;
    name: string;
    trackingType: string;
  };
  quantityRequested: number | null;
  note: string | null;
  createdAt: Date;
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}
