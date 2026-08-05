import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  inventoryItems,
  inventoryTransactions,
  products,
  stores,
} from '../db/schema';
import { resolveOrCreateProduct } from '../products/product-catalog';
import { ImportCheckResultDto } from './dto/import-check.dto';

export interface ImportCheckAck {
  itemId: string;
  status: 'resolved' | 'already_resolved' | 'error';
  outcome?: string;
  reason?: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * The PPS import-check loop: a unit was scanned whose serial nobody recognised, and
 * the ERP is asked whether it knows it.
 *
 *   REQUESTED    -> waiting for the agent (what GET returns)
 *   MATCHED      -> the ERP knew it; the unit is adopted into the catalog and leaves
 *                   the review queue on its own
 *   NOT_FOUND    -> the ERP has never seen this serial; stays for a human
 *   DISCREPANCY  -> the ERP knows it but something disagrees; stays, with the payload
 *
 * MATCHED is the only outcome that resolves a unit. The other two are answers, not
 * fixes — they keep the unit in the queue precisely because somebody still has to act.
 */
@Injectable()
export class ImportChecksService {
  private readonly logger = new Logger(ImportChecksService.name);

  constructor(private readonly tenantDb: TenantDbService) {}

  /**
   * Oldest first: the agent should drain the backlog in the order things were
   * scanned, so a unit cannot be starved by a steady trickle of newer ones.
   */
  async list(companyId: number, limit?: number, offset?: number) {
    const take = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const skip = Math.max(offset ?? 0, 0);

    return this.tenantDb.withCompany(companyId, async (tx) => {
      const where = and(
        eq(inventoryItems.companyId, companyId),
        eq(inventoryItems.importCheckStatus, 'REQUESTED'),
      );
      const rows = await tx
        .select({
          itemId: inventoryItems.id,
          serial: inventoryItems.serial,
          storeId: inventoryItems.storeId,
          storeName: stores.name,
          scannedAt: inventoryItems.createdAt,
          requestedAt: inventoryItems.importCheckRequestedAt,
        })
        .from(inventoryItems)
        .innerJoin(stores, eq(stores.id, inventoryItems.storeId))
        .where(where)
        .orderBy(asc(inventoryItems.importCheckRequestedAt), asc(inventoryItems.id))
        .limit(take)
        .offset(skip);

      const all = await tx
        .select({ id: inventoryItems.id })
        .from(inventoryItems)
        .where(where);

      return { data: rows, total: all.length, limit: take, offset: skip };
    });
  }

  /**
   * Apply a batch of results. Each item gets its OWN transaction so one bad result
   * cannot roll back the rest of the batch — the same shape as handoffs, and the
   * reason the agent gets a per-item ack instead of all-or-nothing.
   */
  async applyResults(
    companyId: number,
    results: ImportCheckResultDto[],
  ): Promise<{ results: ImportCheckAck[] }> {
    const acks: ImportCheckAck[] = [];
    for (const r of results) {
      try {
        acks.push(
          await this.tenantDb.withCompany(companyId, (tx) =>
            this.applyOne(tx, companyId, r),
          ),
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message.slice(0, 200) : 'error';
        this.logger.error(`import check ${r.itemId} failed — ${reason}`);
        acks.push({ itemId: r.itemId, status: 'error', reason });
      }
    }
    return { results: acks };
  }

  private async applyOne(
    tx: Tx,
    companyId: number,
    r: ImportCheckResultDto,
  ): Promise<ImportCheckAck> {
    const [item] = await tx
      .select()
      .from(inventoryItems)
      .where(
        and(eq(inventoryItems.id, r.itemId), eq(inventoryItems.companyId, companyId)),
      )
      .limit(1)
      .for('update');

    if (!item) {
      return { itemId: r.itemId, status: 'error', reason: 'unknown itemId' };
    }
    // Idempotent: a redelivered result for a unit that has already been answered is
    // acknowledged, not reapplied. MATCHED is terminal; the other two can be
    // re-requested, which is what puts the unit back into REQUESTED.
    if (item.importCheckStatus !== 'REQUESTED') {
      return {
        itemId: r.itemId,
        status: 'already_resolved',
        outcome: item.importCheckStatus ?? undefined,
      };
    }

    const now = new Date();

    if (r.outcome === 'NOT_FOUND') {
      await tx
        .update(inventoryItems)
        .set({
          importCheckStatus: 'NOT_FOUND',
          importCheckResolvedAt: now,
          importCheckResult: { outcome: 'NOT_FOUND' },
          updatedAt: now,
        })
        .where(eq(inventoryItems.id, item.id));
      // needs_review stays true: nobody has identified it, so it must not leave the
      // queue just because the ERP shrugged.
      return { itemId: r.itemId, status: 'resolved', outcome: 'NOT_FOUND' };
    }

    if (r.outcome === 'DISCREPANCY') {
      if (!r.discrepancy?.reason) {
        return {
          itemId: r.itemId,
          status: 'error',
          reason: 'DISCREPANCY requires discrepancy.reason',
        };
      }
      await tx
        .update(inventoryItems)
        .set({
          importCheckStatus: 'DISCREPANCY',
          importCheckResolvedAt: now,
          importCheckResult: {
            outcome: 'DISCREPANCY',
            reason: r.discrepancy.reason,
            ppsState: r.discrepancy.ppsState ?? null,
          },
          updatedAt: now,
        })
        .where(eq(inventoryItems.id, item.id));
      return { itemId: r.itemId, status: 'resolved', outcome: 'DISCREPANCY' };
    }

    // MATCHED — adopt the unit into the catalog.
    const m = r.match;
    if (!m?.sku || !m?.name) {
      return {
        itemId: r.itemId,
        status: 'error',
        reason: 'MATCHED requires match.sku and match.name',
      };
    }

    // Link to the existing product for this SKU, or create it. needsReview is FALSE:
    // the ERP is authoritative for catalog data, so a product it described does not
    // need a human to check it.
    const [existing] = await tx
      .select()
      .from(products)
      .where(and(eq(products.companyId, companyId), eq(products.sku, m.sku)))
      .limit(1);

    const product =
      existing ??
      (await resolveOrCreateProduct(tx, companyId, {
        sku: m.sku,
        name: m.name,
        price: m.price != null ? String(m.price) : '0',
        upc: null,
        trackingType: 'SERIALIZED',
        needsReview: false,
      }));

    // resolveOrCreateProduct does not carry a description, so apply the ERP's
    // separately — but only onto a row we just created, never over a curated one.
    if (!existing && m.description) {
      await tx
        .update(products)
        .set({ description: m.description })
        .where(eq(products.id, product.id));
    }

    if (product.trackingType !== 'SERIALIZED') {
      return {
        itemId: r.itemId,
        status: 'error',
        reason: `sku '${m.sku}' is tracked by quantity, not serials`,
      };
    }

    await tx
      .update(inventoryItems)
      .set({
        productId: product.id,
        needsReview: false,
        expirationDate: m.expirationDate ?? item.expirationDate,
        // Same rule as the expiration beside it: what PPS says wins, and saying nothing
        // leaves the existing value alone. This unit came from a bare serial scan, so
        // there is usually nothing to overwrite.
        weightLbs: m.weightLbs != null ? String(m.weightLbs) : item.weightLbs,
        // Only ever fills a gap. This unit was created from a bare serial scan, so it has
        // no barcode; if it somehow does, that one was recorded closer to the label than
        // this answer is.
        ...(m.barcode && !item.barcode ? { barcode: m.barcode } : {}),
        importCheckStatus: 'MATCHED',
        importCheckResolvedAt: now,
        importCheckResult: {
          outcome: 'MATCHED',
          sku: m.sku,
          name: m.name,
          ppsProductRef: m.ppsProductRef ?? null,
        },
        updatedAt: now,
      })
      .where(eq(inventoryItems.id, item.id));

    // The adoption is a ledger event: until now the unit's history had no product at
    // all, and this is what explains where its identity came from.
    await tx.insert(inventoryTransactions).values({
      companyId,
      storeId: item.storeId,
      productId: product.id,
      itemId: item.id,
      type: 'ADJUSTMENT',
      quantityDelta: 0,
      locationToId: item.locationId,
      note: `adopted via PPS import match (${m.sku}${
        m.ppsProductRef ? `, ref ${m.ppsProductRef}` : ''
      })`,
      source: 'SYNC',
    });

    return { itemId: r.itemId, status: 'resolved', outcome: 'MATCHED' };
  }

  /**
   * Ask (or re-ask) the agent about a unit. Used by the website button and, at count
   * approval, by the count itself. Re-requesting from NOT_FOUND or DISCREPANCY is the
   * point: the ERP may have caught up since.
   */
  async request(
    companyId: number,
    itemId: string,
  ): Promise<{ itemId: string; importCheckStatus: string }> {
    return this.tenantDb.withCompany(companyId, async (tx) => {
      const [item] = await tx
        .select()
        .from(inventoryItems)
        .where(
          and(eq(inventoryItems.id, itemId), eq(inventoryItems.companyId, companyId)),
        )
        .limit(1);
      if (!item) throw new Error('Item not found.');
      const now = new Date();
      await tx
        .update(inventoryItems)
        .set({
          importCheckStatus: 'REQUESTED',
          importCheckRequestedAt: now,
          importCheckResolvedAt: null,
          updatedAt: now,
        })
        .where(eq(inventoryItems.id, item.id));
      return { itemId, importCheckStatus: 'REQUESTED' };
    });
  }
}
