import { relations } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
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
    // The ERP's serial / GS1 id. Unique per company.
    serial: text('serial').notNull(),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    price: numeric('price', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    status: itemStatus('status').notNull().default('ON_HAND'),
    // UPC / barcode for counting by product code.
    upc: text('upc'),
    // Set when an item was created/altered by a cycle count and needs an
    // admin to review/complete it.
    needsReview: boolean('needs_review').notNull().default(false),
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
    index('inventory_items_company_upc_idx').on(t.companyId, t.upc),
  ],
);

// The ledger. Append-only: one row per inventory state change, written in the
// same transaction as the item update.
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
    itemId: uuid('item_id')
      .notNull()
      .references(() => inventoryItems.id),
    type: transactionType('type').notNull(),
    quantityDelta: integer('quantity_delta').notNull(),
    note: text('note'),
    performedByUserId: integer('performed_by_user_id').references(
      () => users.id,
    ),
    source: transactionSource('source').notNull(),
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
  ],
);

// Queue of returns for the customer's sync agent to pull and apply in the ERP.
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
    itemId: uuid('item_id')
      .notNull()
      .references(() => inventoryItems.id),
    serial: text('serial').notNull(),
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
// store's ON_HAND items (present vs sold) in one transaction.
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

// One line per item resolution within a cycle count (append-only in practice).
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
    itemId: uuid('item_id')
      .notNull()
      .references(() => inventoryItems.id),
    serial: text('serial').notNull(),
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
// Relations
// ---------------------------------------------------------------------------

export const companiesRelations = relations(companies, ({ many }) => ({
  stores: many(stores),
  users: many(users),
}));

export const storesRelations = relations(stores, ({ one, many }) => ({
  company: one(companies, {
    fields: [stores.companyId],
    references: [companies.id],
  }),
  items: many(inventoryItems),
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
    transactions: many(inventoryTransactions),
  }),
);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Company = typeof companies.$inferSelect;
export type Store = typeof stores.$inferSelect;
export type User = typeof users.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type InventoryItem = typeof inventoryItems.$inferSelect;
export type InventoryTransaction = typeof inventoryTransactions.$inferSelect;
export type OutboxReturn = typeof outboxReturns.$inferSelect;
export type CycleCount = typeof cycleCounts.$inferSelect;
export type CycleCountLine = typeof cycleCountLines.$inferSelect;

export type Role = (typeof userRole.enumValues)[number];
export type ItemStatus = (typeof itemStatus.enumValues)[number];
export type CycleCountResolution =
  (typeof cycleCountResolution.enumValues)[number];

// Every tenant-owned table, for the RLS migration + tenant-db assertions.
export const TENANT_TABLES = [
  'stores',
  'users',
  'invitations',
  'api_keys',
  'inventory_items',
  'inventory_transactions',
  'outbox_returns',
  'cycle_counts',
  'cycle_count_lines',
] as const;
