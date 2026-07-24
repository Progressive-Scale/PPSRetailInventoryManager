// Seed script — run with: npm run db:seed  (tsx scripts/seed.ts)
// Connects via DATABASE_URL (owner/superuser) so it can write across tenants.
// Idempotent: safe to run multiple times.
import 'dotenv/config';
import { hash } from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';

const {
  companies,
  stores,
  users,
  apiKeys,
  products,
  inventoryItems,
  inventoryTransactions,
  cycleCounts,
  cycleCountLines,
} = schema;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy api/.env.example to api/.env.');
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  // --- Platform admin (no company) ---
  await db
    .insert(users)
    .values({
      companyId: null,
      storeId: null,
      email: 'admin@platform.test',
      passwordHash: await hash('platform123', 10),
      role: 'PLATFORM_ADMIN',
      status: 'ACTIVE',
    })
    .onConflictDoNothing({ target: [users.companyId, users.email] });

  // --- Demo company ---
  await db
    .insert(companies)
    .values({
      name: 'Demo Retail Co',
      slug: 'demo',
      branding: { logoUrl: null, primaryColor: '#2563eb' },
      status: 'ACTIVE',
    })
    .onConflictDoNothing({ target: companies.slug });

  const [demo] = await db
    .select()
    .from(companies)
    .where(eq(companies.slug, 'demo'))
    .limit(1);
  if (!demo) throw new Error('Failed to create/find demo company.');

  // --- Store ---
  await db
    .insert(stores)
    .values({
      companyId: demo.id,
      name: 'Downtown',
      code: 'DT',
      externalBuildingId: 'BLDG-001',
    })
    .onConflictDoNothing({ target: [stores.companyId, stores.code] });

  const [store] = await db
    .select()
    .from(stores)
    .where(and(eq(stores.companyId, demo.id), eq(stores.code, 'DT')))
    .limit(1);
  if (!store) throw new Error('Failed to create/find demo store.');

  // --- Company admin + store user ---
  await db
    .insert(users)
    .values({
      companyId: demo.id,
      storeId: null,
      email: 'admin@demo.test',
      passwordHash: await hash('admin123', 10),
      role: 'COMPANY_ADMIN',
      status: 'ACTIVE',
    })
    .onConflictDoNothing({ target: [users.companyId, users.email] });

  await db
    .insert(users)
    .values({
      companyId: demo.id,
      storeId: store.id,
      email: 'user@demo.test',
      passwordHash: await hash('store123', 10),
      role: 'STORE_USER',
      status: 'ACTIVE',
    })
    .onConflictDoNothing({ target: [users.companyId, users.email] });

  // --- Inventory items + ledger history ---
  const now = new Date();
  const itemSeeds = [
    { serial: 'SN-1001', sku: 'TS-BLK-M', name: 'T-Shirt Black M', price: '19.99', upc: '0001110001', sell: false },
    { serial: 'SN-1002', sku: 'TS-BLK-L', name: 'T-Shirt Black L', price: '19.99', upc: '0001110002', sell: false },
    { serial: 'SN-1003', sku: 'HD-GRY-L', name: 'Hoodie Grey L', price: '49.00', upc: '0001110003', sell: true },
    { serial: 'SN-1004', sku: 'CAP-RED', name: 'Cap Red', price: '14.50', upc: '0001110004', sell: false },
  ];

  // Product catalog (source of truth for each SKU).
  for (const s of itemSeeds) {
    await db
      .insert(products)
      .values({
        companyId: demo.id,
        sku: s.sku,
        name: s.name,
        price: s.price,
        upc: s.upc,
        active: true,
      })
      .onConflictDoNothing({ target: [products.companyId, products.sku] });
  }

  const seededItems = new Map<string, typeof inventoryItems.$inferSelect>();
  for (const s of itemSeeds) {
    const [product] = await db
      .select()
      .from(products)
      .where(and(eq(products.companyId, demo.id), eq(products.sku, s.sku)))
      .limit(1);
    const [item] = await db
      .insert(inventoryItems)
      .values({
        companyId: demo.id,
        storeId: store.id,
        productId: product?.id ?? null,
        serial: s.serial,
        sku: s.sku,
        name: s.name,
        price: s.price,
        upc: s.upc,
        status: s.sell ? 'SOLD' : 'ON_HAND',
        receivedAt: now,
      })
      .onConflictDoNothing({
        target: [inventoryItems.companyId, inventoryItems.serial],
      })
      .returning();

    if (!item) continue; // already seeded
    seededItems.set(s.serial, item);

    // RECEIPT ledger row (as if delivered by the sync agent).
    await db.insert(inventoryTransactions).values({
      companyId: demo.id,
      storeId: store.id,
      itemId: item.id,
      type: 'RECEIPT',
      quantityDelta: 1,
      note: 'Seeded handoff',
      source: 'SYNC',
    });

    // Optional SALE for history.
    if (s.sell) {
      await db.insert(inventoryTransactions).values({
        companyId: demo.id,
        storeId: store.id,
        itemId: item.id,
        type: 'SALE',
        quantityDelta: -1,
        note: 'Seeded sale',
        source: 'PORTAL',
      });
    }
  }

  // --- Demo CLOSED cycle count (once): scanned 2, marked 1 sold ---
  const [ccExisting] = await db
    .select()
    .from(cycleCounts)
    .where(eq(cycleCounts.companyId, demo.id))
    .limit(1);
  const [storeUser] = await db
    .select()
    .from(users)
    .where(and(eq(users.companyId, demo.id), eq(users.email, 'user@demo.test')))
    .limit(1);

  if (!ccExisting && storeUser) {
    const bySerial = async (serial: string) =>
      (
        await db
          .select()
          .from(inventoryItems)
          .where(
            and(
              eq(inventoryItems.companyId, demo.id),
              eq(inventoryItems.serial, serial),
            ),
          )
          .limit(1)
      )[0];
    const i1 = await bySerial('SN-1001');
    const i2 = await bySerial('SN-1002');
    const i4 = await bySerial('SN-1004');

    if (i1 && i2 && i4) {
      const [cc] = await db
        .insert(cycleCounts)
        .values({
          companyId: demo.id,
          storeId: store.id,
          status: 'CLOSED',
          openedByUserId: storeUser.id,
          closedByUserId: storeUser.id,
          closedAt: now,
          expectedCount: 3,
          scannedCount: 2,
          soldGeneratedCount: 1,
        })
        .returning();

      await db.insert(cycleCountLines).values([
        { companyId: demo.id, cycleCountId: cc.id, itemId: i1.id, serial: i1.serial, resolution: 'SCANNED' },
        { companyId: demo.id, cycleCountId: cc.id, itemId: i2.id, serial: i2.serial, resolution: 'SCANNED' },
      ]);

      // Item not accounted for -> sold by the cycle count.
      await db
        .update(inventoryItems)
        .set({ status: 'SOLD', updatedAt: now })
        .where(eq(inventoryItems.id, i4.id));
      await db.insert(inventoryTransactions).values({
        companyId: demo.id,
        storeId: store.id,
        itemId: i4.id,
        type: 'SALE',
        quantityDelta: -1,
        note: `Cycle count #${cc.id}`,
        source: 'CYCLE_COUNT',
      });
      await db.insert(cycleCountLines).values({
        companyId: demo.id,
        cycleCountId: cc.id,
        itemId: i4.id,
        serial: i4.serial,
        resolution: 'MARKED_SOLD',
      });
    }
  }

  // --- API key for the demo company's sync agent (plaintext shown once) ---
  const [existingKey] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.companyId, demo.id), isNull(apiKeys.revokedAt)))
    .limit(1);

  let plaintextKey: string | null = null;
  if (!existingKey) {
    plaintextKey = `pps_${randomBytes(24).toString('hex')}`;
    await db.insert(apiKeys).values({
      companyId: demo.id,
      name: 'Demo sync agent',
      keyHash: sha256(plaintextKey),
    });
  }

  console.log('Seed complete.\n');
  console.log('Platform admin (admin host):');
  console.log('  admin@platform.test / platform123\n');
  console.log('Demo company (slug "demo"):');
  console.log('  Company admin: admin@demo.test / admin123');
  console.log('  Store user:    user@demo.test  / store123\n');
  if (plaintextKey) {
    console.log('Demo sync API key (shown ONCE — copy it now):');
    console.log(`  ${plaintextKey}\n`);
  } else {
    console.log('Demo sync API key already exists (plaintext not recoverable).\n');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
