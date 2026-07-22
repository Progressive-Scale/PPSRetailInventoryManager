import { relations, sql } from 'drizzle-orm';
import {
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

// ---- Enums ----

export const userRole = pgEnum('user_role', ['ADMIN', 'STORE_USER']);
export const outboxOperation = pgEnum('outbox_operation', [
  'CREATE',
  'UPDATE',
  'DELETE',
]);

// ---- Tables ----

export const stores = pgTable('stores', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  code: text('code').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  // Nullable: ADMIN users are not tied to a single store.
  storeId: integer('store_id').references(() => stores.id),
  role: userRole('role').notNull().default('STORE_USER'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: integer('store_id')
      .notNull()
      .references(() => stores.id),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    quantity: integer('quantity').notNull().default(0),
    price: numeric('price', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    // Auto-set on every update (ORM-level via $onUpdate; also set explicitly in
    // the service layer so raw upserts stay accurate). Drives sync change detection.
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Soft delete.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // SKU is unique per store. This is also the ON CONFLICT target used by
    // the idempotent sync push endpoint.
    uniqueIndex('inventory_items_store_sku_uniq').on(t.storeId, t.sku),
  ],
);

export const outboxChanges = pgTable('outbox_changes', {
  id: serial('id').primaryKey(),
  storeId: integer('store_id').references(() => stores.id),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  operation: outboxOperation('operation').notNull(),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Null until the sync agent acknowledges delivery.
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
});

// ---- Relations (optional, handy for typed queries) ----

export const storesRelations = relations(stores, ({ many }) => ({
  users: many(users),
  inventoryItems: many(inventoryItems),
}));

export const usersRelations = relations(users, ({ one }) => ({
  store: one(stores, { fields: [users.storeId], references: [stores.id] }),
}));

export const inventoryItemsRelations = relations(inventoryItems, ({ one }) => ({
  store: one(stores, {
    fields: [inventoryItems.storeId],
    references: [stores.id],
  }),
}));

// ---- Inferred types ----

export type Store = typeof stores.$inferSelect;
export type User = typeof users.$inferSelect;
export type InventoryItem = typeof inventoryItems.$inferSelect;
export type NewInventoryItem = typeof inventoryItems.$inferInsert;
export type OutboxChange = typeof outboxChanges.$inferSelect;

// Kept exported so it is obvious the raw sql helper is available to migrations.
export const _sql = sql;
