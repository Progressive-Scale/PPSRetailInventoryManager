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
  'MOVE',
]);
// Areas within a store. BACKROOM (not customer-facing) and ONFLOOR
// (customer-purchasable) are REQUIRED kinds: one of each is auto-created with the
// store and a store must always keep at least one ACTIVE location of each, but it
// may have several of either. CUSTOM is the default for user-added locations.
// A location's kind is immutable after creation.
export const locationKind = pgEnum('location_kind', [
  'BACKROOM',
  'ONFLOOR',
  'CUSTOM',
]);
export const notificationType = pgEnum('notification_type', ['EXPIRATION_WARNING']);
export const invitationEmailStatus = pgEnum('invitation_email_status', [
  'PENDING',
  'SENT',
  'FAILED',
]);
export const itemAuditSource = pgEnum('item_audit_source', [
  'BULK_EDIT',
  'SINGLE_EDIT',
  'SYNC',
]);
export const notificationStatus = pgEnum('notification_status', [
  'UNREAD',
  'READ',
  'DISMISSED',
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
    address1: text('address1'),
    address2: text('address2'),
    city: text('city'),
    state: text('state'),
    zip: text('zip'),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('stores_company_idx').on(t.companyId)],
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

// Which stores a user MAY access. A store user can be permitted several stores
// but works in ONE at a time: users.store_id is the *active* store the JWT
// carries (chosen at login when more than one is permitted), while this table is
// the permitted set. Single-store users have exactly one row here.
export const userStores = pgTable(
  'user_stores',
  {
    id: serial('id').primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('user_stores_user_store_uniq').on(t.userId, t.storeId),
    index('user_stores_company_user_idx').on(t.companyId, t.userId),
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
    // Only the sha256 of the invite token is stored; the plaintext appears
    // exactly once, in the emailed accept URL.
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    // Revocation kills a link before it is used (idempotent).
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: integer('revoked_by_user_id').references(() => users.id),
    // Delivery outcome of the invitation email. A send failure never blocks
    // creation — the row is marked FAILED with the reason so the admin can
    // resend or copy the link.
    emailStatus: invitationEmailStatus('email_status').notNull().default('PENDING'),
    emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
    emailError: text('email_error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('invitations_company_idx').on(t.companyId),
    uniqueIndex('invitations_token_hash_uniq').on(t.tokenHash),
    // At most ONE live (neither accepted nor revoked) invitation per address, so a
    // person can never hold two redeemable links. Re-inviting revokes the old one
    // first. Note an expired-but-unrevoked row still occupies the slot; the
    // service revokes it as part of re-inviting.
    uniqueIndex('invitations_one_live_per_email_uniq')
      .on(t.companyId, sql`lower(${t.email})`)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
  ],
);

// Stores an invitee will be granted on accept — the pending equivalent of
// user_stores, so an invitation can cover several stores. On accept every row
// here becomes a user_stores row; users.store_id (the active store) is set only
// when there is exactly one, otherwise the user picks at login.
// invitations.store_id is retained for backwards compatibility and mirrors the
// single-store case; this table is the source of truth.
export const invitationStores = pgTable(
  'invitation_stores',
  {
    id: serial('id').primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    invitationId: integer('invitation_id')
      .notNull()
      .references(() => invitations.id, { onDelete: 'cascade' }),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('invitation_stores_invitation_store_uniq').on(
      t.invitationId,
      t.storeId,
    ),
    index('invitation_stores_company_invitation_idx').on(
      t.companyId,
      t.invitationId,
    ),
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

// ---------------------------------------------------------------------------
// store_locations — RULE: NAMES ARE DISPLAY ONLY.
//
//   `name` is user-editable at any time. NOTHING in business logic may depend on
//   it: no query filter, guard, default-selection, sort or comparison. The
//   `kind` column (BACKROOM | ONFLOOR | CUSTOM) is the ONLY key logic may use,
//   and it is immutable once a location is created — there is deliberately no
//   `kind` on the update DTO.
//
//   Combine `kind` with `is_active` for every rule: the required-kind invariant
//   counts active rows by kind; handoff landing picks the oldest ACTIVE row of
//   kind BACKROOM; expiration alerts scan every ACTIVE row of kind ONFLOOR.
//
//   The initial display names live in locations/location-names.ts and must be
//   imported only by the creation path and the seed script.
// ---------------------------------------------------------------------------
// Named areas within a store. Every store has exactly one BACKROOM and one
// ONFLOOR system location (auto-created; renamable, not deletable) plus any
// CUSTOM locations. System rows are identified by `kind`, not by name.
export const storeLocations = pgTable(
  'store_locations',
  {
    id: serial('id').primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id),
    name: text('name').notNull(),
    kind: locationKind('kind').notNull().default('CUSTOM'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('store_locations_company_store_idx').on(t.companyId, t.storeId),
    // Names are unique WITHIN A STORE among ACTIVE locations, case-insensitively.
    // Every store owns its own "Backroom" and "On Floor" — that is the model, and
    // the Store column disambiguates them in cross-store lists. Deactivated rows
    // are exempt, so a retired name can be reused; reactivating a clashing name is
    // rejected by this index.
    uniqueIndex('store_locations_company_store_name_uniq')
      .on(t.companyId, t.storeId, sql`lower(${t.name})`)
      .where(sql`${t.isActive}`),
    // NOTE: there is deliberately NO one-per-kind constraint. A store may have
    // several BACKROOM and several ONFLOOR locations. The invariant enforced in
    // the service layer instead is: every store must always keep at least one
    // ACTIVE location of each required kind (BACKROOM, ONFLOOR).
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
    // The area of the store this unit lives in (defaults to BACKROOM on intake).
    locationId: integer('location_id')
      .notNull()
      .references(() => storeLocations.id),
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
    index('inventory_items_company_location_idx').on(t.companyId, t.locationId),
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
    // One counter row per product per store per location.
    locationId: integer('location_id')
      .notNull()
      .references(() => storeLocations.id),
    quantityOnHand: integer('quantity_on_hand').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('inventory_stock_company_store_product_location_uniq').on(
      t.companyId,
      t.storeId,
      t.productId,
      t.locationId,
    ),
    index('inventory_stock_company_idx').on(t.companyId),
    check('inventory_stock_qty_nonneg', sql`${t.quantityOnHand} >= 0`),
  ],
);

// The ledger. Append-only: one row per inventory state change, written in the
// same transaction as the item/stock update. Covers both tracking types:
// item_id is set for serialized units only; quantity_delta is ±N.
//
// Location context: RECEIPT rows record location_to_id (where stock landed,
// BACKROOM on intake); SALE/ADJUSTMENT/RETURN record location_from_id (where it
// left). MOVE rows set BOTH location_from_id and location_to_id; for a MOVE,
// quantity_delta is 0 for serialized (item_id set) and the moved quantity as a
// POSITIVE number for quantity products (from/to express the direction).
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
    // Location context (see comment above). Nullable; set where known.
    locationFromId: integer('location_from_id').references(
      () => storeLocations.id,
    ),
    locationToId: integer('location_to_id').references(() => storeLocations.id),
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

// Per-company (or per-store override) expiration-alert configuration.
// A null store_id row is the company default.
export const notificationSettings = pgTable(
  'notification_settings',
  {
    id: serial('id').primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    storeId: integer('store_id').references(() => stores.id),
    expirationAlertDays: integer('expiration_alert_days').notNull().default(30),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [
    uniqueIndex('notification_settings_company_store_uniq').on(
      t.companyId,
      t.storeId,
    ),
  ],
);

// In-app notifications (currently expiration warnings; type is extensible).
// payload = { itemId, serial, productName, expirationDate, daysLeft, expired }.
export const notifications = pgTable(
  'notifications',
  {
    id: serial('id').primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id),
    type: notificationType('type').notNull(),
    payload: jsonb('payload').notNull(),
    status: notificationStatus('status').notNull().default('UNREAD'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('notifications_company_status_idx').on(t.companyId, t.status),
    index('notifications_company_store_idx').on(t.companyId, t.storeId),
  ],
);

// Audit trail for manual field changes on a serialized item (currently the
// expiration date). Expiration normally arrives from ERP sync, so manual
// overrides must be traceable: who changed it, from what to what, and how.
export const itemAudit = pgTable(
  'item_audit',
  {
    id: serial('id').primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    itemId: uuid('item_id')
      .notNull()
      .references(() => inventoryItems.id),
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    changedByUserId: integer('changed_by_user_id').references(() => users.id),
    source: itemAuditSource('source').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('item_audit_company_item_idx').on(t.companyId, t.itemId),
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
export type StoreLocation = typeof storeLocations.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type NotificationSetting = typeof notificationSettings.$inferSelect;
export type UserStore = typeof userStores.$inferSelect;
export type ItemAudit = typeof itemAudit.$inferSelect;

export type Role = (typeof userRole.enumValues)[number];
export type TrackingType = (typeof trackingType.enumValues)[number];
export type ItemStatus = (typeof itemStatus.enumValues)[number];
export type LocationKind = (typeof locationKind.enumValues)[number];
export type CycleCountResolution =
  (typeof cycleCountResolution.enumValues)[number];

// Every tenant-owned table, for the RLS migration + tenant-db assertions.
export const TENANT_TABLES = [
  'stores',
  'store_locations',
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
  'notification_settings',
  'notifications',
  'item_audit',
  'user_stores',
  'invitation_stores',
] as const;
