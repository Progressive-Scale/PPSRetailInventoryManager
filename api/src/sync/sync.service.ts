import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TenantDbService, Tx } from '../db/tenant-db.service';
import {
  inventoryItems,
  inventoryStock,
  inventoryTransactions,
  outboxReturns,
  Product,
  products,
  stores,
  syncReceipts,
} from '../db/schema';
import { HandoffItemDto } from './dto/sync.dto';
import { resolveOrCreateProduct } from '../products/product-catalog';
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
  constructor(private readonly tenantDb: TenantDbService) {}

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
  ): Promise<{ results: HandoffAck[] }> {
    const results: HandoffAck[] = [];
    for (const it of items) {
      const kind = it.kind ?? 'unit';
      try {
        const ack = await this.tenantDb.withCompany(companyId, (tx) =>
          kind === 'stock'
            ? this.handleStock(tx, companyId, it)
            : this.handleUnit(tx, companyId, it),
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
    // The existing-serial lookup comes BEFORE resolving the product, and the collision
    // check compares SKUs rather than product ids. resolveProduct CREATES a catalog row
    // for an unknown sku, so doing it first left a phantom product behind every time a
    // line was then rejected — the reject is not rolled back, it is reported.
    const [existing] = await tx
      .select({
        id: inventoryItems.id,
        productId: inventoryItems.productId,
        barcode: inventoryItems.barcode,
        sku: products.sku,
      })
      .from(inventoryItems)
      .leftJoin(products, eq(products.id, inventoryItems.productId))
      .where(
        and(
          eq(inventoryItems.companyId, companyId),
          eq(inventoryItems.serial, it.serial),
        ),
      )
      .limit(1);

    // A serial already used by a DIFFERENT product is not a redelivery — it is two
    // physical units competing for one identity. ERP serials are not always globally
    // unique (in one real database 18 in-stock items share 5 serials across different
    // GTINs), and (company, serial) is unique here, so relinking would quietly collapse
    // two units into one row and move the first one's history onto the second's product.
    // Refusing puts it in front of a human with both skus named.
    //
    // A null product is the legitimate case and still adopts: that is an unidentified
    // scan being given its identity, which is the whole point of the review queue.
    // Comparing sku strings is exactly what resolveOrCreateProduct keys on, so this is
    // the same comparison one step earlier.
    if (existing?.productId != null && existing.sku !== it.sku) {
      return {
        kind: 'unit',
        serial: it.serial,
        status: 'error',
        reason:
          `serial '${it.serial}' already identifies a unit of sku '${existing.sku}' ` +
          `at this company; it cannot also be sku '${it.sku}'. Serials must be unique per company — ` +
          `check whether the ERP reuses this serial across products.`,
      };
    }

    const product = await this.resolveProduct(tx, companyId, it, 'SERIALIZED');
    if (!product) {
      return {
        kind: 'unit',
        serial: it.serial,
        status: 'error',
        reason: `sku '${it.sku}' is tracked by quantity, not serials`,
      };
    }

    if (existing) {
      // Idempotent: relink to the catalog product; refresh expiration if given.
      // The barcode is backfilled the same way — an agent upgraded to send it should
      // be able to fill in units it handed off before it knew how.
      await tx
        .update(inventoryItems)
        .set({
          productId: product.id,
          ...(it.expirationDate ? { expirationDate: it.expirationDate } : {}),
          ...(it.barcode ? { barcode: it.barcode } : {}),
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
    const product = await this.resolveProduct(tx, companyId, it, 'QUANTITY');
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
  ): Promise<Product | null> {
    const product = await resolveOrCreateProduct(tx, companyId, {
      sku: it.sku,
      name: it.name,
      price: it.price !== undefined ? String(it.price) : '0',
      upc: it.upc ?? null,
      trackingType: expected,
    });
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
          city: stores.city,
          state: stores.state,
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
