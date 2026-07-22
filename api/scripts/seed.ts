// Seed script — run with: npm run db:seed  (tsx scripts/seed.ts)
// Idempotent: safe to run multiple times.
import 'dotenv/config';
import { hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';

const { stores, users, inventoryItems } = schema;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy api/.env.example to api/.env.');
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  // --- Demo store ---
  await db
    .insert(stores)
    .values({ name: 'Demo Store', code: 'DEMO' })
    .onConflictDoNothing({ target: stores.code });

  const [demoStore] = await db
    .select()
    .from(stores)
    .where(eq(stores.code, 'DEMO'))
    .limit(1);

  if (!demoStore) throw new Error('Failed to create/find demo store.');

  // --- Store user ---
  await db
    .insert(users)
    .values({
      email: 'demo@store.test',
      passwordHash: await hash('password123', 10),
      storeId: demoStore.id,
      role: 'STORE_USER',
    })
    .onConflictDoNothing({ target: users.email });

  // --- Admin user (not tied to a store; sees all) ---
  await db
    .insert(users)
    .values({
      email: 'admin@pps.test',
      passwordHash: await hash('admin123', 10),
      storeId: null,
      role: 'ADMIN',
    })
    .onConflictDoNothing({ target: users.email });

  // --- A couple of demo items so the inventory page isn't empty ---
  await db
    .insert(inventoryItems)
    .values([
      {
        storeId: demoStore.id,
        sku: 'SKU-001',
        name: 'Widget',
        description: 'A sample widget.',
        quantity: 25,
        price: '9.99',
      },
      {
        storeId: demoStore.id,
        sku: 'SKU-002',
        name: 'Gadget',
        description: 'A sample gadget.',
        quantity: 10,
        price: '19.50',
      },
    ])
    .onConflictDoNothing({
      target: [inventoryItems.storeId, inventoryItems.sku],
    });

  console.log('Seed complete.');
  console.log('  Store user: demo@store.test / password123  (store DEMO)');
  console.log('  Admin:      admin@pps.test  / admin123');

  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
