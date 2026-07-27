import { relations, sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  pgView,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const companyStatus = pgEnum('company_status', ['ACTIVE', 'SUSPENDED']);
export const userRole = pgEnum('user_role', [
  'PLATFORM_ADMIN',
  'COMPANY_ADMIN',
  'STORE_USER',
]);
export const userStatus = pgEnum('user_status', ['ACTIVE', 'SUSPENDED']);
// How a product's inventory is tracked. Immutable once a product exists.
//  - SERIALIZED: one inventory_items row per physical unit (serial-tracked).
//  - QUANTITY:   one inventory_stock counter row per store (quantity-tracked).
export const trackingType = pgEnum('tracking_type', ['SERIALIZED', 'QUANTITY']);
export const itemStatus = pgEnum('item_status', [
  'ON_HAND',
  'SOLD',
  'RETURNED_TO_WAREHOUSE',
  'ADJUSTED_OUT',
]);
export const transactionType = pgEnum('transaction_type', [
  'RECEIPT',
  'SALE',
  'ADJUSTMENT',
  'RETURN',
]);
export const transactionSource = pgEnum('transaction_source', [
  'PORTAL',
  'SYNC',
  'CYCLE_COUNT',
]);
export const cycleCountStatus = pgEnum('cycle_count_status', [
  'OPEN',
  'CLOSED',
  'CANCELLED',
]);
export const cycleCountResolution = pgEnum('cycle_count_resolution', [
  'SCANNED',
  'COUNTED_BY_UPC',
  'MARKED_SOLD',
  'NEW_ITEM',
]);

// ---------------------------------------------------------------------------
// companies — the tenant registry. NOT itself a tenant-scoped table (it has no
// company_id), so it is NOT under RLS; tenant resolution reads it freely.
// ---------------------------------------------------------------------------

export const companies = pgTable(
  'companies',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    customDomain: text('custom_domain'),
    // { logoUrl, primaryColor }
    branding: jsonb('branding').notNull().default({}),
    status: companyStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('companies_slug_uniq').on(t.slug),
    uniqueIndex('companies_custom_domain_uniq').on(t.customDomain),
  ],
);

// ---------------------------------------------------------------------------
// Tenant-owned tables — every one carries company_id (denormalized on purpose;
// indexes lead with it) and is protected by RLS (see the enable_rls migration).
// ---------------------------------------------------------------------------

export const stores = pgTable(
  'stores',
  {
    id: serial('id').primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    name: text('name').notNull(),
    code: text('code').notNull(),
    // Maps to the customer ERP's building/location id.
    externalBuildingId: text('external_building_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('stores_company_idx').on(t.companyId),
    uniqueIndex('stores_company_code_uniq').on(t.companyId, t.code),
    uniqueIndex('stores_company_building_uniq').on(
      t.companyId,
      t.externalBuildingId,
    ),
  ],
);

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    // Null for PLATFORM_ADMIN (not tied to a company).
    companyId: integer('company_id').references(() => companies.id),
    storeId: integer('store_id').references(() => stores.id),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull(),
    status: userStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('users_company_idx').on(t.companyId),
    // Email unique within a company.
    uniqueIndex('users_company_email_uniq').on(t.companyId, t.email),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: serial('id').primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    email: text('email').notNull(),
    role: userRole('role').notNull(),
    storeId: integer('store_id').references(() => stores.id),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('invitations_company_idx').on(t.companyId),
    uniqueIndex('invitations_token_uniq').on(t.token),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: serial('id').primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    name: text('name').notNull(),
    // Only the hash of the key is stored; the plaintext is shown once.
    keyHash: text('key_hash').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('api_keys_company_idx').on(t.companyId),
    uniqueIndex('api_keys_hash_uniq').on(t.keyHash),
  ],
);

// Product catalog. Source of truth for a SKU's name/price/UPC/tracking within a
// company. Both serialized units and quantity stock reference a product.
export const products = pgTable(
  'products',
  {
    id: serial('id').primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    price: numeric('price', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    upc: text('upc'),
    // Immutable after creation (enforced in the update endpoint).
    trackingType: trackingType('tracking_type').notNull().default('SERIALIZED'),
    // Set when an unknown scan/handoff created this product and an admin must
    // review/complete it (rename, price, etc.). Moved here from inventory_items.
    needsReview: boolean('needs_review').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('products_company_idx').on(t.companyId),
    uniqueIndex('products_company_sku_uniq').on(t.companyId, t.sku),
    // UPC unique within a company where present (nullable UPCs don't collide).
    uniqueIndex('products_company_upc_uniq')
      .on(t.companyId, t.upc)
      .where(sql`${t.upc} is not null`),
  ],
);

// SERIALIZED units only. One row per physical unit. Catalog fields (sku, name,
// price, upc, description) live on products; expiration is per-unit.
export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id),
    // Catalog link — always set (the product carries sku/name/price/upc).
    productId: integer('product_id')
      .notNull()
      .references(() => products.id),
    // The ERP's serial / GS1 id. Unique per company.
    serial: text('serial').notNull(),
    status: itemStatus('status').notNull().default('ON_HAND'),
    // Expiration date (calendar date, nullable). Per physical unit.
    expirationDate: date('expiration_date'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('inventory_items_company_serial_uniq').on(
      t.companyId,
      t.serial,
    ),
    index('inventory_items_company_store_status_idx').on(
      t.companyId,
      t.storeId,
      t.status,
    ),
    index('inventory_items_company_product_idx').on(t.companyId, t.productId),
  ],
);

// QUANTITY products only. One counter row per product per store.
export const inventoryStock = pgTable(
  'inventory_stock',
  {
    id: serial('id').primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id),
    quantityOnHand: integer('quantity_on_hand').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('inventory_stock_company_store_product_uniq').on(
      t.companyId,
      t.storeId,
      t.productId,
    ),
    index('inventory_stock_company_idx').on(t.companyId),
    check('inventory_stock_qty_nonneg', sql`${t.quantityOnHand} >= 0`),
  ],
);

// The ledger. Append-only: one row per inventory state change, written in the
// same transaction as the item/stock update. Covers both tracking types:
// item_id is set for serialized units only; quantity_delta is ±N.
export const inventoryTransactions = pgTable(
  'inventory_transactions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id),
    // Serialized units only; null for quantity movements.
    itemId: uuid('item_id').references(() => inventoryItems.id),
    type: transactionType('type').notNull(),
    quantityDelta: integer('quantity_delta').notNull(),
    note: text('note'),
    performedByUserId: integer('performed_by_user_id').references(
      () => users.id,
    ),
    source: transactionSource('source').notNull(),
    // Set when the movement was generated by a cycle count.
    cycleCountId: integer('cycle_count_id').references(() => cycleCounts.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('inv_tx_company_store_created_idx').on(
      t.companyId,
      t.storeId,
      t.createdAt,
    ),
    index('inv_tx_company_item_idx').on(t.companyId, t.itemId),
    index('inv_tx_company_product_idx').on(t.companyId, t.productId),
  ],
);

// Idempotency ledger for quantity handoffs. A client-generated handoff_id is
// recorded once per shipment line so redelivery cannot double-increment stock.
export const syncReceipts = pgTable(
  'sync_receipts',
  {
    id: serial('id').primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    handoffId: text('handoff_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('sync_receipts_company_handoff_uniq').on(
      t.companyId,
      t.handoffId,
    ),
  ],
);

// Queue of returns for the customer's sync agent to pull and apply in the ERP.
// Serialized returns carry item_id/serial; quantity returns carry only the
// product (payload holds upc + quantity).
export const outboxReturns = pgTable(
  'outbox_returns',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id),
    // Serialized returns only.
    itemId: uuid('item_id').references(() => inventoryItems.id),
    serial: text('serial'),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    index('outbox_returns_company_idx').on(t.companyId),
    index('outbox_returns_pending_idx').on(t.deliveredAt, t.id),
  ],
);

// Cycle counts — a store-wide physical count session. Closing resolves the
// store's ON_HAND serialized units (present vs sold) and applies submitted
// quantity counts, all in one transaction.
export const cycleCounts = pgTable(
  'cycle_counts',
  {
    id: serial('id').primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id),
    status: cycleCountStatus('status').notNull().default('OPEN'),
    openedByUserId: integer('opened_by_user_id')
      .notNull()
      .references(() => users.id),
    closedByUserId: integer('closed_by_user_id').references(() => users.id),
    openedAt: timestamp('opened_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    expectedCount: integer('expected_count').notNull().default(0),
    scannedCount: integer('scanned_count').notNull().default(0),
    soldGeneratedCount: integer('sold_generated_count').notNull().default(0),
  },
  (t) => [
    index('cycle_counts_company_store_idx').on(t.companyId, t.storeId),
    index('cycle_counts_company_status_idx').on(t.companyId, t.status),
  ],
);

// One line per resolution within a cycle count (append-only in practice).
// product_id is always set; item_id/serial only for serialized resolutions;
// quantity only for COUNTED_BY_UPC (quantity) lines.
export const cycleCountLines = pgTable(
  'cycle_count_lines',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    cycleCountId: integer('cycle_count_id')
      .notNull()
      .references(() => cycleCounts.id),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id),
    itemId: uuid('item_id').references(() => inventoryItems.id),
    serial: text('serial'),
    quantity: integer('quantity'),
    resolution: cycleCountResolution('resolution').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('cc_lines_company_count_idx').on(t.companyId, t.cycleCountId),
    index('cc_lines_company_resolution_idx').on(t.companyId, t.resolution),
  ],
);

// ---------------------------------------------------------------------------
// Read view — product-level on-hand per store, unifying both tracking types.
// Created by a hand-written migration WITH (security_invoker = true) so RLS
// on the underlying tables still applies. Declared here as `.existing()` for
// typing only (Drizzle does not manage its DDL).
// ---------------------------------------------------------------------------

export const storeInventory = pgView('store_inventory', {
  companyId: integer('company_id').notNull(),
  storeId: integer('store_id').notNull(),
  productId: integer('product_id').notNull(),
  sku: text('sku').notNull(),
  upc: text('upc'),
  name: text('name').notNull(),
  trackingType: trackingType('tracking_type').notNull(),
  onHand: integer('on_hand').notNull(),
}).existing();

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const companiesRelations = relations(companies, ({ many }) => ({
  stores: many(stores),
  users: many(users),
}));

export const usersRelations = relations(users, ({ one }) => ({
  company: one(companies, {
    fields: [users.companyId],
    references: [companies.id],
  }),
  store: one(stores, {
    fields: [users.storeId],
    references: [stores.id],
  }),
}));

export const storesRelations = relations(stores, ({ one, many }) => ({
  company: one(companies, {
    fields: [stores.companyId],
    references: [companies.id],
  }),
  items: many(inventoryItems),
  stock: many(inventoryStock),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  company: one(companies, {
    fields: [products.companyId],
    references: [companies.id],
  }),
  items: many(inventoryItems),
  stock: many(inventoryStock),
  transactions: many(inventoryTransactions),
}));

export const inventoryItemsRelations = relations(
  inventoryItems,
  ({ one, many }) => ({
    company: one(companies, {
      fields: [inventoryItems.companyId],
      references: [companies.id],
    }),
    store: one(stores, {
      fields: [inventoryItems.storeId],
      references: [stores.id],
    }),
    product: one(products, {
      fields: [inventoryItems.productId],
      references: [products.id],
    }),
    transactions: many(inventoryTransactions),
  }),
);

export const inventoryStockRelations = relations(inventoryStock, ({ one }) => ({
  company: one(companies, {
    fields: [inventoryStock.companyId],
    references: [companies.id],
  }),
  store: one(stores, {
    fields: [inventoryStock.storeId],
    references: [stores.id],
  }),
  product: one(products, {
    fields: [inventoryStock.productId],
    references: [products.id],
  }),
}));

export const inventoryTransactionsRelations = relations(
  inventoryTransactions,
  ({ one }) => ({
    company: one(companies, {
      fields: [inventoryTransactions.companyId],
      references: [companies.id],
    }),
    store: one(stores, {
      fields: [inventoryTransactions.storeId],
      references: [stores.id],
    }),
    product: one(products, {
      fields: [inventoryTransactions.productId],
      references: [products.id],
    }),
    item: one(inventoryItems, {
      fields: [inventoryTransactions.itemId],
      references: [inventoryItems.id],
    }),
  }),
);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Company = typeof companies.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Store = typeof stores.$inferSelect;
export type User = typeof users.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type InventoryItem = typeof inventoryItems.$inferSelect;
export type InventoryStock = typeof inventoryStock.$inferSelect;
export type InventoryTransaction = typeof inventoryTransactions.$inferSelect;
export type SyncReceipt = typeof syncReceipts.$inferSelect;
export type OutboxReturn = typeof outboxReturns.$inferSelect;
export type CycleCount = typeof cycleCounts.$inferSelect;
export type CycleCountLine = typeof cycleCountLines.$inferSelect;
export type StoreInventoryRow = typeof storeInventory.$inferSelect;

export type Role = (typeof userRole.enumValues)[number];
export type TrackingType = (typeof trackingType.enumValues)[number];
export type ItemStatus = (typeof itemStatus.enumValues)[number];
export type CycleCountResolution =
  (typeof cycleCountResolution.enumValues)[number];

// Every tenant-owned table, for the RLS migration + tenant-db assertions.
export const TENANT_TABLES = [
  'stores',
  'users',
  'invitations',
  'api_keys',
  'products',
  'inventory_items',
  'inventory_stock',
  'inventory_transactions',
  'sync_receipts',
  'outbox_returns',
  'cycle_counts',
  'cycle_count_lines',
] as const;
