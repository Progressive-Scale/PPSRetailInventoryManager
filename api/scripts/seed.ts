// Seed script — run with: npm run db:seed  (tsx scripts/seed.ts)
// Connects via DATABASE_URL (owner/superuser) so it can write across tenants.
// Idempotent: safe to run multiple times.
//
// Produces a full dual-tracking demo set:
//   - SERIALIZED products with per-unit inventory_items (mixed statuses)
//   - QUANTITY products with inventory_stock counter rows
//   - a needs_review product (as if created by an unknown scan)
//   - a CLOSED cycle count exercising a serialized sold-sweep, a quantity
//     count delta, and a "not counted" quantity product
//   - a second company (acme) for cross-tenant / RLS isolation checks
import 'dotenv/config';
import { hash } from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { DEFAULT_LOCATION_NAMES } from '../src/locations/location-names';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';

const {
  companies,
  stores,
  users,
  apiKeys,
  products,
  inventoryItems,
  inventoryStock,
  inventoryTransactions,
  cycleCounts,
  cycleCountLines,
  storeLocations,
  notificationSettings,
  userStores,
} = schema;

/** YYYY-MM-DD, `n` days from `base` (negative = past). */
function addDays(base: Date, n: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

type Db = ReturnType<typeof drizzle<typeof schema>>;
type TrackingType = schema.TrackingType;
type ItemStatus = schema.ItemStatus;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface ProductSeed {
  sku: string;
  name: string;
  price: string;
  upc: string | null;
  trackingType: TrackingType;
  needsReview?: boolean;
}
type LocationSlot = 'BACKROOM' | 'ONFLOOR';
interface UnitSeed {
  sku: string;
  serial: string;
  status: ItemStatus;
  location: LocationSlot;
  expirationDate?: string | null;
}
interface StockSeed {
  sku: string;
  quantity: number;
  location: LocationSlot;
}

async function ensureCompany(db: Db, name: string, slug: string) {
  await db
    .insert(companies)
    .values({
      name,
      slug,
      branding: { logoUrl: null, primaryColor: '#2563eb' },
      status: 'ACTIVE',
    })
    .onConflictDoNothing({ target: companies.slug });
  const [row] = await db
    .select()
    .from(companies)
    .where(eq(companies.slug, slug))
    .limit(1);
  if (!row) throw new Error(`Failed to create/find company '${slug}'.`);
  return row;
}

interface StoreAddress {
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  notes?: string;
}

async function ensureStore(
  db: Db,
  companyId: number,
  name: string,
  addr: StoreAddress = {},
) {
  const [existing] = await db
    .select()
    .from(stores)
    .where(and(eq(stores.companyId, companyId), eq(stores.name, name)))
    .limit(1);
  if (existing) return existing;
  const [row] = await db
    .insert(stores)
    .values({
      companyId,
      name,
      address1: addr.address1 ?? null,
      address2: addr.address2 ?? null,
      city: addr.city ?? null,
      state: addr.state ?? null,
      zip: addr.zip ?? null,
      notes: addr.notes ?? null,
    })
    .returning();
  if (!row) throw new Error(`Failed to create/find store '${name}'.`);
  return row;
}

/**
 * Ensure a store has its two REQUIRED locations and return the ids the seed uses.
 * A store may have several BACKROOM/ONFLOOR locations; the invariant is that at
 * least one of each stays ACTIVE. When several exist this picks the same one the
 * API treats as the default landing location: the oldest ACTIVE by
 * (sort_order, created_at, id). Custom locations are not created here.
 */
async function ensureSystemLocations(
  db: Db,
  companyId: number,
  storeId: number,
): Promise<{ backroom: number; onfloor: number }> {
  // Initial display names only — every lookup below keys on `kind`. One of each
  // required kind, matching a fresh real-world store; extra Backroom/On Floor
  // locations are something an operator adds when they need them.
  const defaults: Array<{ name: string; kind: 'BACKROOM' | 'ONFLOOR'; sortOrder: number }> = [
    { name: DEFAULT_LOCATION_NAMES.BACKROOM, kind: 'BACKROOM', sortOrder: 0 },
    { name: DEFAULT_LOCATION_NAMES.ONFLOOR, kind: 'ONFLOOR', sortOrder: 1 },
  ];
  const existing = await db
    .select()
    .from(storeLocations)
    .where(and(eq(storeLocations.companyId, companyId), eq(storeLocations.storeId, storeId)));
  for (const d of defaults) {
    if (existing.some((r) => r.kind === d.kind)) continue;
    await db
      .insert(storeLocations)
      .values({ companyId, storeId, name: d.name, kind: d.kind, sortOrder: d.sortOrder });
  }
  const rows = await db
    .select()
    .from(storeLocations)
    .where(and(eq(storeLocations.companyId, companyId), eq(storeLocations.storeId, storeId)))
    .orderBy(
      asc(storeLocations.sortOrder),
      asc(storeLocations.createdAt),
      asc(storeLocations.id),
    );
  // Mirrors systemLocationId(): oldest ACTIVE row of the kind.
  const backroom = rows.find((r) => r.kind === 'BACKROOM' && r.isActive);
  const onfloor = rows.find((r) => r.kind === 'ONFLOOR' && r.isActive);
  if (!backroom || !onfloor)
    throw new Error(`Store ${storeId} has no active BACKROOM / ONFLOOR location.`);
  return { backroom: backroom.id, onfloor: onfloor.id };
}

async function ensureUser(
  db: Db,
  companyId: number | null,
  storeId: number | null,
  email: string,
  password: string,
  role: schema.Role,
) {
  await db
    .insert(users)
    .values({
      companyId,
      storeId,
      email,
      passwordHash: await hash(password, 10),
      role,
      status: 'ACTIVE',
    })
    .onConflictDoNothing({ target: [users.companyId, users.email] });

  // Grant access to the pinned store via the permitted-stores junction.
  if (companyId != null && storeId != null) {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.companyId, companyId), eq(users.email, email)))
      .limit(1);
    if (row) {
      await db
        .insert(userStores)
        .values({ companyId, userId: row.id, storeId })
        .onConflictDoNothing({ target: [userStores.userId, userStores.storeId] });
    }
  }
}

async function ensureProducts(db: Db, companyId: number, list: ProductSeed[]) {
  for (const p of list) {
    await db
      .insert(products)
      .values({
        companyId,
        sku: p.sku,
        name: p.name,
        price: p.price,
        upc: p.upc,
        trackingType: p.trackingType,
        needsReview: p.needsReview ?? false,
        active: true,
      })
      .onConflictDoNothing({ target: [products.companyId, products.sku] });
  }
  const rows = await db
    .select()
    .from(products)
    .where(eq(products.companyId, companyId));
  const bySku = new Map<string, (typeof rows)[number]>();
  for (const r of rows) bySku.set(r.sku, r);
  return bySku;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy api/.env.example to api/.env.');
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  const now = new Date();

  // --- Platform admin (no company) ---
  await ensureUser(
    db,
    null,
    null,
    'admin@platform.test',
    'platform123',
    'PLATFORM_ADMIN',
  );

  // =========================================================================
  // Demo company — the full dual-tracking demo set.
  // =========================================================================
  const demo = await ensureCompany(db, 'Demo Retail Co', 'demo');
  const store = await ensureStore(db, demo.id, 'Downtown', {
    address1: '100 Main St',
    address2: 'Suite 200',
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
    notes: 'Flagship demo store.',
  });
  const demoLoc = await ensureSystemLocations(db, demo.id, store.id);
  await ensureUser(db, demo.id, null, 'admin@demo.test', 'admin123', 'COMPANY_ADMIN');
  await ensureUser(db, demo.id, store.id, 'user@demo.test', 'store123', 'STORE_USER');
  const [storeUser] = await db
    .select()
    .from(users)
    .where(and(eq(users.companyId, demo.id), eq(users.email, 'user@demo.test')))
    .limit(1);

  const demoProducts: ProductSeed[] = [
    { sku: 'TS-BLK-M', name: 'T-Shirt Black M', price: '19.99', upc: '0001110001', trackingType: 'SERIALIZED' },
    { sku: 'HD-GRY-L', name: 'Hoodie Grey L', price: '49.00', upc: '0001110003', trackingType: 'SERIALIZED' },
    { sku: 'CAP-RED', name: 'Cap Red', price: '14.50', upc: '0001110004', trackingType: 'SERIALIZED' },
    { sku: 'SOCK-WHT', name: 'Socks White 6-pack', price: '9.99', upc: '0002220001', trackingType: 'QUANTITY' },
    { sku: 'GLOVE-BLK', name: 'Work Gloves Black', price: '12.00', upc: '0002220002', trackingType: 'QUANTITY' },
    { sku: 'REVIEW-SN-UNKNOWN', name: 'Unknown scan (needs review)', price: '0', upc: null, trackingType: 'SERIALIZED', needsReview: true },
  ];
  const demoBySku = await ensureProducts(db, demo.id, demoProducts);

  // Serialized units (mixed statuses + locations). SN-1005 starts ON_HAND and
  // is swept to SOLD by the demo cycle count below. Expirations are staggered
  // relative to "today" so the ExpirationAlertsJob has data to alert on:
  //   - ON_FLOOR + within/past the alert window  -> should raise a notification
  //   - BACKROOM near-expiry                      -> should NOT alert (floor-only)
  const demoUnits: UnitSeed[] = [
    // On floor, far-out expiry — no alert.
    { sku: 'TS-BLK-M', serial: 'SN-1001', status: 'ON_HAND', location: 'ONFLOOR', expirationDate: addDays(now, 200) },
    // Backroom, swept SOLD by the cycle count below.
    { sku: 'TS-BLK-M', serial: 'SN-1005', status: 'ON_HAND', location: 'BACKROOM' },
    // Backroom near-expiry — must NOT alert (not customer-facing).
    { sku: 'TS-BLK-M', serial: 'SN-1009', status: 'ON_HAND', location: 'BACKROOM', expirationDate: addDays(now, 5) },
    { sku: 'HD-GRY-L', serial: 'SN-1003', status: 'SOLD', location: 'BACKROOM' },
    // On floor, already expired — alert (expired flag).
    { sku: 'HD-GRY-L', serial: 'SN-1007', status: 'ON_HAND', location: 'ONFLOOR', expirationDate: addDays(now, -8) },
    // On floor, 5 days out — alert (within 7/30).
    { sku: 'CAP-RED', serial: 'SN-1004', status: 'ON_HAND', location: 'ONFLOOR', expirationDate: addDays(now, 5) },
    // On floor, 23 days out — alert (within 30).
    { sku: 'CAP-RED', serial: 'SN-1008', status: 'ON_HAND', location: 'ONFLOOR', expirationDate: addDays(now, 23) },
    { sku: 'CAP-RED', serial: 'SN-1006', status: 'SOLD', location: 'BACKROOM' },
    { sku: 'REVIEW-SN-UNKNOWN', serial: 'SN-REV-1', status: 'ON_HAND', location: 'BACKROOM' },
  ];
  for (const u of demoUnits) {
    const product = demoBySku.get(u.sku)!;
    const locationId = u.location === 'ONFLOOR' ? demoLoc.onfloor : demoLoc.backroom;
    const [item] = await db
      .insert(inventoryItems)
      .values({
        companyId: demo.id,
        storeId: store.id,
        productId: product.id,
        locationId,
        serial: u.serial,
        status: u.status,
        expirationDate: u.expirationDate ?? null,
        receivedAt: now,
      })
      .onConflictDoNothing({
        target: [inventoryItems.companyId, inventoryItems.serial],
      })
      .returning();
    if (!item) continue; // already seeded

    await db.insert(inventoryTransactions).values({
      companyId: demo.id,
      storeId: store.id,
      productId: product.id,
      itemId: item.id,
      type: 'RECEIPT',
      quantityDelta: 1,
      note: 'Seeded handoff',
      source: 'SYNC',
      locationToId: locationId,
    });
    if (u.status === 'SOLD') {
      await db.insert(inventoryTransactions).values({
        companyId: demo.id,
        storeId: store.id,
        productId: product.id,
        itemId: item.id,
        type: 'SALE',
        quantityDelta: -1,
        note: 'Seeded sale',
        source: 'PORTAL',
        locationFromId: locationId,
      });
    }
  }

  // Quantity stock, now per-location. SOCK-WHT sits in the BACKROOM (40, later
  // adjusted to 38 by the demo cycle count) AND on the floor (10) to show a
  // product split across two locations; GLOVE-BLK is backroom-only (12,
  // uncounted).
  const demoStock: StockSeed[] = [
    { sku: 'SOCK-WHT', quantity: 40, location: 'BACKROOM' },
    { sku: 'SOCK-WHT', quantity: 10, location: 'ONFLOOR' },
    { sku: 'GLOVE-BLK', quantity: 12, location: 'BACKROOM' },
  ];
  for (const s of demoStock) {
    const product = demoBySku.get(s.sku)!;
    const locationId = s.location === 'ONFLOOR' ? demoLoc.onfloor : demoLoc.backroom;
    const [row] = await db
      .insert(inventoryStock)
      .values({
        companyId: demo.id,
        storeId: store.id,
        productId: product.id,
        locationId,
        quantityOnHand: s.quantity,
      })
      .onConflictDoNothing({
        target: [
          inventoryStock.companyId,
          inventoryStock.storeId,
          inventoryStock.productId,
          inventoryStock.locationId,
        ],
      })
      .returning();
    if (!row) continue;
    await db.insert(inventoryTransactions).values({
      companyId: demo.id,
      storeId: store.id,
      productId: product.id,
      type: 'RECEIPT',
      quantityDelta: s.quantity,
      note: 'Seeded stock handoff',
      source: 'SYNC',
      locationToId: locationId,
    });
  }

  // --- Demo CLOSED cycle count (once) ---
  //   SN-1001 scanned (SCANNED); SN-1005 not scanned -> MARKED_SOLD;
  //   SOCK-WHT counted 38 (was 40) -> SALE -2, stock set to 38 (COUNTED_BY_UPC);
  //   GLOVE-BLK not counted -> left at 12 (surfaced as "not counted" at runtime).
  const [ccExisting] = await db
    .select()
    .from(cycleCounts)
    .where(eq(cycleCounts.companyId, demo.id))
    .limit(1);

  if (!ccExisting && storeUser) {
    const unitBySerial = async (serial: string) =>
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
    const sn1001 = await unitBySerial('SN-1001');
    const sn1005 = await unitBySerial('SN-1005');
    const sock = demoBySku.get('SOCK-WHT')!;
    const ts = demoBySku.get('TS-BLK-M')!;

    if (sn1001 && sn1005) {
      const [cc] = await db
        .insert(cycleCounts)
        .values({
          companyId: demo.id,
          storeId: store.id,
          status: 'CLOSED',
          openedByUserId: storeUser.id,
          closedByUserId: storeUser.id,
          closedAt: now,
          expectedCount: 4,
          scannedCount: 2,
          soldGeneratedCount: 1,
        })
        .returning();

      // Scanned serialized unit.
      await db.insert(cycleCountLines).values({
        companyId: demo.id,
        cycleCountId: cc.id,
        productId: ts.id,
        itemId: sn1001.id,
        serial: sn1001.serial,
        resolution: 'SCANNED',
      });

      // Unscanned serialized unit -> swept SOLD.
      await db
        .update(inventoryItems)
        .set({ status: 'SOLD', updatedAt: now })
        .where(eq(inventoryItems.id, sn1005.id));
      await db.insert(inventoryTransactions).values({
        companyId: demo.id,
        storeId: store.id,
        productId: ts.id,
        itemId: sn1005.id,
        type: 'SALE',
        quantityDelta: -1,
        note: `Cycle count #${cc.id}`,
        source: 'CYCLE_COUNT',
        cycleCountId: cc.id,
        locationFromId: demoLoc.backroom,
      });
      await db.insert(cycleCountLines).values({
        companyId: demo.id,
        cycleCountId: cc.id,
        productId: ts.id,
        itemId: sn1005.id,
        serial: sn1005.serial,
        resolution: 'MARKED_SOLD',
      });

      // Quantity product counted 38 (was 40) in the BACKROOM -> SALE -2, that
      // location's stock row set to 38 (the on-floor row is untouched).
      await db
        .update(inventoryStock)
        .set({ quantityOnHand: 38, updatedAt: now })
        .where(
          and(
            eq(inventoryStock.companyId, demo.id),
            eq(inventoryStock.storeId, store.id),
            eq(inventoryStock.productId, sock.id),
            eq(inventoryStock.locationId, demoLoc.backroom),
          ),
        );
      await db.insert(inventoryTransactions).values({
        companyId: demo.id,
        storeId: store.id,
        productId: sock.id,
        type: 'SALE',
        quantityDelta: -2,
        note: `Cycle count #${cc.id} (counted 38)`,
        source: 'CYCLE_COUNT',
        cycleCountId: cc.id,
        locationFromId: demoLoc.backroom,
      });
      await db.insert(cycleCountLines).values({
        companyId: demo.id,
        cycleCountId: cc.id,
        productId: sock.id,
        quantity: 38,
        resolution: 'COUNTED_BY_UPC',
      });
    }
  }

  // --- Company-default notification settings (30-day expiration window) ---
  const [existingSettings] = await db
    .select()
    .from(notificationSettings)
    .where(
      and(
        eq(notificationSettings.companyId, demo.id),
        isNull(notificationSettings.storeId),
      ),
    )
    .limit(1);
  if (!existingSettings) {
    await db.insert(notificationSettings).values({
      companyId: demo.id,
      storeId: null,
      expirationAlertDays: 30,
      enabled: true,
    });
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

  // =========================================================================
  // Acme company — minimal second tenant, for cross-tenant / RLS checks.
  // =========================================================================
  const acme = await ensureCompany(db, 'Acme Supply', 'acme');
  const acmeStore = await ensureStore(db, acme.id, 'Warehouse', {
    address1: '500 Industrial Pkwy',
    city: 'Aurora',
    state: 'IL',
    zip: '60504',
    notes: 'Central distribution warehouse.',
  });
  const acmeLoc = await ensureSystemLocations(db, acme.id, acmeStore.id);
  await ensureUser(db, acme.id, null, 'admin@acme.test', 'admin123', 'COMPANY_ADMIN');
  const acmeBySku = await ensureProducts(db, acme.id, [
    { sku: 'ACME-WIDGET', name: 'Acme Widget', price: '5.00', upc: '0009990001', trackingType: 'SERIALIZED' },
    { sku: 'ACME-BOLT', name: 'Acme Bolt (box)', price: '2.50', upc: '0009990002', trackingType: 'QUANTITY' },
  ]);
  {
    const widget = acmeBySku.get('ACME-WIDGET')!;
    const [wUnit] = await db
      .insert(inventoryItems)
      .values({
        companyId: acme.id,
        storeId: acmeStore.id,
        productId: widget.id,
        locationId: acmeLoc.backroom,
        serial: 'SN-A1',
        status: 'ON_HAND',
        receivedAt: now,
      })
      .onConflictDoNothing({
        target: [inventoryItems.companyId, inventoryItems.serial],
      })
      .returning();
    if (wUnit) {
      await db.insert(inventoryTransactions).values({
        companyId: acme.id,
        storeId: acmeStore.id,
        productId: widget.id,
        itemId: wUnit.id,
        type: 'RECEIPT',
        quantityDelta: 1,
        note: 'Seeded handoff',
        source: 'SYNC',
        locationToId: acmeLoc.backroom,
      });
    }
    const bolt = acmeBySku.get('ACME-BOLT')!;
    const [bStock] = await db
      .insert(inventoryStock)
      .values({
        companyId: acme.id,
        storeId: acmeStore.id,
        productId: bolt.id,
        locationId: acmeLoc.backroom,
        quantityOnHand: 100,
      })
      .onConflictDoNothing({
        target: [
          inventoryStock.companyId,
          inventoryStock.storeId,
          inventoryStock.productId,
          inventoryStock.locationId,
        ],
      })
      .returning();
    if (bStock) {
      await db.insert(inventoryTransactions).values({
        companyId: acme.id,
        storeId: acmeStore.id,
        productId: bolt.id,
        type: 'RECEIPT',
        quantityDelta: 100,
        note: 'Seeded stock handoff',
        source: 'SYNC',
        locationToId: acmeLoc.backroom,
      });
    }
  }

  console.log('Seed complete.\n');
  console.log('Platform admin (admin host):');
  console.log('  admin@platform.test / platform123\n');
  console.log('Demo company (slug "demo"):');
  console.log('  Company admin: admin@demo.test / admin123');
  console.log('  Store user:    user@demo.test  / store123\n');
  console.log('Acme company (slug "acme"):');
  console.log('  Company admin: admin@acme.test / admin123\n');
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
