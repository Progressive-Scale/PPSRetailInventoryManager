import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  inventoryItems,
  inventoryStock,
  inventoryTransactions,
  outboxReturns,
  Product,
  stores,
  syncReceipts,
} from '../db/schema';
import { HandoffItemDto } from './dto/sync.dto';
import { resolveOrCreateProduct } from '../products/product-catalog';
import { normaliseUpc } from '../products/product-catalog';
import { AuditService } from '../audit/audit.service';
import { systemLocationId } from '../locations/location-util';

export interface HandoffAck {
  kind: 'unit' | 'stock';
  serial?: string;
  handoffId?: string;
  status: 'accepted' | 'already_processed' | 'error';
  reason?: string;
}

@Injectable()
export class SyncService {
  constructor(
    private readonly tenantDb: TenantDbService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Idempotent ingestion of a mixed handoff batch. Each line is processed in
   * its own transaction so one bad line does not roll back the batch.
   *   unit  (serialized) — upsert on (company, serial); redelivery = no-op.
   *   stock (quantity)   — increment guarded by sync_receipts(company, handoffId)
   *                        so redelivery cannot double-increment.
   */
  async handoffs(
    companyId: number,
    items: HandoffItemDto[],
    /** Which agent key delivered the batch, for attribution. */
    apiKeyId?: number | null,
  ): Promise<{ results: HandoffAck[] }> {
    const results: HandoffAck[] = [];
    for (const it of items) {
      const kind = it.kind ?? 'unit';
      try {
        const ack = await this.tenantDb.withCompany(companyId, (tx) =>
          kind === 'stock'
            ? this.handleStock(tx, companyId, it, apiKeyId ?? null)
            : this.handleUnit(tx, companyId, it, apiKeyId ?? null),
        );
        results.push(ack);
      } catch (err) {
        const reason =
          err instanceof Error ? err.message.slice(0, 200) : 'error';
        results.push({
          kind,
          serial: it.serial,
          handoffId: it.handoffId,
          status: 'error',
          reason,
        });
      }
    }
    return { results };
  }

  // ---- unit (serialized) -------------------------------------------------

  private async handleUnit(
    tx: Tx,
    companyId: number,
    it: HandoffItemDto,
    apiKeyId: number | null,
  ): Promise<HandoffAck> {
    if (!it.serial) {
      return { kind: 'unit', status: 'error', reason: 'unit handoff requires a serial' };
    }
    const store = await this.storeById(tx, companyId, it.storeId);
    if (!store) {
      return {
        kind: 'unit',
        serial: it.serial,
        status: 'error',
        reason: `unknown store id '${it.storeId}'`,
      };
    }
    const product = await this.resolveProduct(tx, companyId, it, 'SERIALIZED', apiKeyId);
    if (!product) {
      return {
        kind: 'unit',
        serial: it.serial,
        status: 'error',
        reason: `sku '${it.sku}' is tracked by quantity, not serials`,
      };
    }

    // Identity is (company, PRODUCT, serial) — the ERP's own rule, and (sku, serial) is
    // what joins a unit back to Ordersystem8. The same serial under a different sku is a
    // different physical unit, not a redelivery, so matching on serial alone would treat
    // one as a duplicate of the other.
    const [sameProduct] = await tx
      .select({ id: inventoryItems.id, barcode: inventoryItems.barcode })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.companyId, companyId),
          eq(inventoryItems.productId, product.id),
          eq(inventoryItems.serial, it.serial),
        ),
      )
      .limit(1);

    // Failing that, a unit with this serial and NO product yet: an unidentified scan
    // waiting to be named. The handoff names it, which is the same adoption the review
    // queue and the import agent perform.
    const [unidentified] = sameProduct
      ? []
      : await tx
          .select({ id: inventoryItems.id, barcode: inventoryItems.barcode })
          .from(inventoryItems)
          .where(
            and(
              eq(inventoryItems.companyId, companyId),
              isNull(inventoryItems.productId),
              eq(inventoryItems.serial, it.serial),
            ),
          )
          .limit(1);

    const existing = sameProduct ?? unidentified;

    if (existing) {
      // Either a redelivery of the same (product, serial) — a no-op beyond the refresh —
      // or an unidentified unit being adopted, which is where productId actually changes.
      // The barcode is backfilled the same way: an agent upgraded to send it should be
      // able to fill in units it handed off before it knew how.
      // weightLbs joins expirationDate and barcode in the same convention: a value
      // that arrives OVERWRITES (the ERP is authoritative, and a re-weigh is exactly
      // why a handoff would be re-delivered), while an omitted one leaves what is
      // there alone. A handoff therefore cannot blank a weight back to null — only a
      // manual edit can, which is audited.
      await tx
        .update(inventoryItems)
        .set({
          productId: product.id,
          ...(it.expirationDate ? { expirationDate: it.expirationDate } : {}),
          ...(it.barcode ? { barcode: it.barcode } : {}),
          ...(it.weightLbs != null ? { weightLbs: String(it.weightLbs) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(inventoryItems.id, existing.id));
      return { kind: 'unit', serial: it.serial, status: 'already_processed' };
    }

    // A handoff means the ERP SHIPPED the unit, not that it is in the store. It
    // lands PENDING with no location and is not stock until somebody physically
    // scans it in during a cycle count, which writes the RECEIVE row. receivedAt
    // stays null for the same reason — it records arrival, which has not happened.
    const [item] = await tx
      .insert(inventoryItems)
      .values({
        companyId,
        storeId: store.id,
        productId: product.id,
        locationId: null,
        serial: it.serial,
        barcode: it.barcode ?? null,
        status: 'PENDING',
        expirationDate: it.expirationDate ?? null,
        // numeric arrives as a string in drizzle; null when the ERP has not weighed it.
        weightLbs: it.weightLbs != null ? String(it.weightLbs) : null,
      })
      .returning();
    // The RECEIPT still belongs at handoff time: this is when the ERP handed the
    // unit over, and the ledger records when things were said, not just when they
    // were confirmed. locationToId is null because there is no location yet.
    await tx.insert(inventoryTransactions).values({
      companyId,
      storeId: store.id,
      productId: product.id,
      itemId: item.id,
      type: 'RECEIPT',
      quantityDelta: 1,
      note: 'Handoff from sync agent — awaiting receiving scan',
      source: 'SYNC',
    });
    return { kind: 'unit', serial: it.serial, status: 'accepted' };
  }

  // ---- stock (quantity) --------------------------------------------------

  private async handleStock(
    tx: Tx,
    companyId: number,
    it: HandoffItemDto,
    apiKeyId: number | null,
  ): Promise<HandoffAck> {
    if (!it.handoffId) {
      return { kind: 'stock', status: 'error', reason: 'stock handoff requires a handoffId' };
    }
    if (it.quantity === undefined || it.quantity <= 0) {
      return {
        kind: 'stock',
        handoffId: it.handoffId,
        status: 'error',
        reason: 'stock handoff requires a positive quantity',
      };
    }
    const store = await this.storeById(tx, companyId, it.storeId);
    if (!store) {
      return {
        kind: 'stock',
        handoffId: it.handoffId,
        status: 'error',
        reason: `unknown store id '${it.storeId}'`,
      };
    }
    const product = await this.resolveProduct(tx, companyId, it, 'QUANTITY', apiKeyId);
    if (!product) {
      return {
        kind: 'stock',
        handoffId: it.handoffId,
        status: 'error',
        reason: `sku '${it.sku}' is tracked by serials, not quantity`,
      };
    }

    // Idempotency: claim the handoffId. If it was already claimed, do nothing.
    const claimed = await tx
      .insert(syncReceipts)
      .values({ companyId, handoffId: it.handoffId })
      .onConflictDoNothing({
        target: [syncReceipts.companyId, syncReceipts.handoffId],
      })
      .returning({ id: syncReceipts.id });
    if (claimed.length === 0) {
      return { kind: 'stock', handoffId: it.handoffId, status: 'already_processed' };
    }

    // Stock handoffs land on the BACKROOM counter for the product at the store.
    const backroomId = await systemLocationId(tx, companyId, store.id, 'BACKROOM');
    const [stock] = await tx
      .select()
      .from(inventoryStock)
      .where(
        and(
          eq(inventoryStock.companyId, companyId),
          eq(inventoryStock.storeId, store.id),
          eq(inventoryStock.productId, product.id),
          eq(inventoryStock.locationId, backroomId),
        ),
      )
      .for('update');
    if (stock) {
      await tx
        .update(inventoryStock)
        .set({
          quantityOnHand: stock.quantityOnHand + it.quantity,
          updatedAt: new Date(),
        })
        .where(eq(inventoryStock.id, stock.id));
    } else {
      await tx.insert(inventoryStock).values({
        companyId,
        storeId: store.id,
        productId: product.id,
        locationId: backroomId,
        quantityOnHand: it.quantity,
      });
    }
    await tx.insert(inventoryTransactions).values({
      companyId,
      storeId: store.id,
      productId: product.id,
      type: 'RECEIPT',
      quantityDelta: it.quantity,
      locationToId: backroomId,
      note: 'Stock handoff from sync agent',
      source: 'SYNC',
    });
    return { kind: 'stock', handoffId: it.handoffId, status: 'accepted' };
  }

  // ---- helpers -----------------------------------------------------------

  /** Resolve/create the product, returning null if its tracking_type clashes. */
  private async resolveProduct(
    tx: Tx,
    companyId: number,
    it: HandoffItemDto,
    expected: 'SERIALIZED' | 'QUANTITY',
    apiKeyId: number | null,
  ): Promise<Product | null> {
    const product = await resolveOrCreateProduct(
      tx,
      companyId,
      {
        sku: it.sku,
        name: it.name,
        price: it.price !== undefined ? String(it.price) : '0',
        upc: normaliseUpc(it.upc),
        trackingType: expected,
      },
      {
        service: this.audit,
        actor: AuditService.agent(apiKeyId),
        details: { via: 'handoff', handoffId: it.handoffId ?? null },
      },
    );
    if (product.trackingType !== expected) return null;
    return product;
  }

  private async storeById(tx: Tx, companyId: number, storeId: number) {
    const [store] = await tx
      .select()
      .from(stores)
      .where(and(eq(stores.companyId, companyId), eq(stores.id, storeId)))
      .limit(1);
    return store;
  }

  /**
   * The company's stores, for an agent that needs to map cloud store ids to its own
   * records. Deliberately separate from the portal's `GET /stores`: that one is JWT +
   * COMPANY_ADMIN and returns the full row, while an agent authenticates with an API
   * key and needs only enough to keep a local mirror in step. Nothing here is
   * writable — the cloud mints store ids and the ERP links to them.
   */
  async listStores(companyId: number) {
    return this.tenantDb.withCompany(companyId, async (tx) => {
      const rows = await tx
        // No store "code": the cloud identifies a store by its integer id and has no
        // second identifier. An ERP mirroring these rows should leave its own code
        // column null rather than inventing one.
        .select({
          id: stores.id,
          companyId: stores.companyId,
          name: stores.name,
          // The full ship-to, not just city/state. A consuming ERP has to be able to
          // address a shipment to this store, and half an address cannot. Required at
          // creation as of this change; older rows may still be missing parts, so a
          // consumer should treat a null here as "not shippable yet" rather than blank.
          address1: stores.address1,
          address2: stores.address2,
          city: stores.city,
          state: stores.state,
          zip: stores.zip,
          isActive: stores.isActive,
        })
        .from(stores)
        .where(eq(stores.companyId, companyId))
        .orderBy(asc(stores.id));
      return { count: rows.length, stores: rows };
    });
  }

  /** Oldest-first undelivered returns for the agent to pull. */
  async pendingReturns(companyId: number, limit?: number) {
    const take = limit && limit > 0 ? Math.min(limit, 500) : 100;
    return this.tenantDb.withCompany(companyId, async (tx) => {
      const rows = await tx
        .select()
        .from(outboxReturns)
        .where(
          and(
            eq(outboxReturns.companyId, companyId),
            isNull(outboxReturns.deliveredAt),
          ),
        )
        .orderBy(asc(outboxReturns.id))
        .limit(take);
      return { count: rows.length, returns: rows };
    });
  }

  /** Mark returns delivered. Idempotent. */
  async ackReturns(companyId: number, ids: number[]) {
    if (ids.length === 0) return { acknowledged: 0 };
    return this.tenantDb.withCompany(companyId, async (tx) => {
      const updated = await tx
        .update(outboxReturns)
        .set({ deliveredAt: sql`now()` })
        .where(
          and(
            eq(outboxReturns.companyId, companyId),
            inArray(outboxReturns.id, ids),
            isNull(outboxReturns.deliveredAt),
          ),
        )
        .returning({ id: outboxReturns.id });
      return { acknowledged: updated.length };
    });
  }
}
