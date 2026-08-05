/**
 * A known-good starting point for testing cycle counts by hand.
 *
 *   Backroom : 10 × Water Bottle          (quantity, counted by UPC)
 *   On Floor : 10 × Water Bottle + 2 × Chuck Roll Bone In  = 12 items
 *
 * Run: `npm run db:fixture` (optionally `-- "Store name"`).
 *
 * Uses the products that already exist, by the identifiers a scanner reads — the water
 * bottle's real UPC and the chuck roll's real SKU — so a scan of a physical label matches
 * what this created. It never invents a second "Water Bottle".
 *
 * IDEMPOTENT: run it as often as you like; it converges on the numbers above rather than
 * adding to them.
 *
 * It will NOT delete anything it did not create. If the two locations hold other stock, it
 * says so and leaves it alone — the counts a test expects (12 on floor, 10 in the backroom)
 * would be wrong, and quietly deleting a colleague's data to make an expectation true is
 * not a trade this script gets to make.
 */
import 'dotenv/config';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  companies,
  cycleCounts,
  inventoryItems,
  inventoryStock,
  inventoryTransactions,
  products,
  storeLocations,
  stores,
} from '../src/db/schema';

// ---- what the fixture is -------------------------------------------------------------

const COMPANY_SLUG = 'demo';
/** Overridable: `npm run db:fixture -- "Downtown"`. */
const STORE_NAME = process.argv[2] ?? 'Teset';

/** The water bottle's real barcode — the one a handheld actually reads off the bottle. */
const WATER_UPC = '075720000814';
const WATER_PER_LOCATION = 10;

/** The chuck roll's real SKU, and serials continuing its ERP sequence (…462 exists). */
const CHUCK_SKU = '11101';
const CHUCK_SERIALS = ['100000000463', '100000000464'];

const NOTE = 'Test fixture';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (run from api/ with its .env).');
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  try {
    const [company] = await db
      .select()
      .from(companies)
      .where(eq(companies.slug, COMPANY_SLUG))
      .limit(1);
    if (!company) throw new Error(`No company with slug '${COMPANY_SLUG}'.`);

    const [store] = await db
      .select()
      .from(stores)
      .where(and(eq(stores.companyId, company.id), eq(stores.name, STORE_NAME)))
      .limit(1);
    if (!store) {
      const all = await db
        .select({ name: stores.name })
        .from(stores)
        .where(eq(stores.companyId, company.id));
      throw new Error(
        `No store named '${STORE_NAME}' in ${company.name}. Stores: ${all
          .map((s) => s.name)
          .join(', ')}`,
      );
    }

    // Every location, active or not: an inactive one still names itself in the report below,
    // and a count scoped to a retired bay reading as "whole store" is worse than no label.
    const locs = await db
      .select()
      .from(storeLocations)
      .where(eq(storeLocations.storeId, store.id));
    const backroom = locs.find((l) => l.kind === 'BACKROOM' && l.isActive);
    const onfloor = locs.find((l) => l.kind === 'ONFLOOR' && l.isActive);
    if (!backroom || !onfloor) {
      throw new Error(
        `${store.name} needs one active BACKROOM and one active ONFLOOR location.`,
      );
    }

    const [water] = await db
      .select()
      .from(products)
      .where(and(eq(products.companyId, company.id), eq(products.upc, WATER_UPC)))
      .limit(1);
    if (!water) throw new Error(`No product with UPC ${WATER_UPC}.`);
    if (water.trackingType !== 'QUANTITY') {
      throw new Error(`${water.sku} is ${water.trackingType}; the fixture counts it by UPC.`);
    }

    const [chuck] = await db
      .select()
      .from(products)
      .where(and(eq(products.companyId, company.id), eq(products.sku, CHUCK_SKU)))
      .limit(1);
    if (!chuck) throw new Error(`No product with SKU ${CHUCK_SKU}.`);
    if (chuck.trackingType !== 'SERIALIZED') {
      throw new Error(`${chuck.sku} is ${chuck.trackingType}; the fixture counts it by serial.`);
    }

    console.log(`Store    : ${store.name} (#${store.id}) in ${company.name}`);
    console.log(`Locations: ${backroom.name} (#${backroom.id}) / ${onfloor.name} (#${onfloor.id})`);
    console.log(`Products : ${water.sku} "${water.name}" upc ${water.upc}`);
    console.log(`           ${chuck.sku} "${chuck.name}" serialized`);

    // A product nobody can scan is no use in a test.
    for (const p of [water, chuck]) {
      if (!p.active) {
        await db.update(products).set({ active: true }).where(eq(products.id, p.id));
        console.log(`  reactivated ${p.sku} (it was inactive)`);
      }
    }

    // ---- what else is in the way -----------------------------------------------------
    const otherStock = await db
      .select({ sku: products.sku, qty: inventoryStock.quantityOnHand, loc: storeLocations.name })
      .from(inventoryStock)
      .innerJoin(products, eq(products.id, inventoryStock.productId))
      .innerJoin(storeLocations, eq(storeLocations.id, inventoryStock.locationId))
      .where(
        and(
          eq(inventoryStock.storeId, store.id),
          ne(inventoryStock.productId, water.id),
          ne(inventoryStock.quantityOnHand, 0),
        ),
      );
    const otherUnits = await db
      .select({ serial: inventoryItems.serial, sku: products.sku, loc: storeLocations.name })
      .from(inventoryItems)
      .leftJoin(products, eq(products.id, inventoryItems.productId))
      .leftJoin(storeLocations, eq(storeLocations.id, inventoryItems.locationId))
      .where(
        and(
          eq(inventoryItems.storeId, store.id),
          eq(inventoryItems.status, 'ON_HAND'),
          ne(inventoryItems.productId, chuck.id),
        ),
      );
    if (otherStock.length > 0 || otherUnits.length > 0) {
      console.log('\n! This store already holds other stock, left untouched:');
      for (const r of otherStock) console.log(`    ${r.qty} × ${r.sku} at ${r.loc}`);
      for (const r of otherUnits) {
        console.log(`    ${r.serial} (${r.sku ?? 'unidentified'}) at ${r.loc ?? '—'}`);
      }
      console.log('  A whole-store count will include it. Count one location at a time,');
      console.log('  or move it out first.');
    }

    // ---- water bottle: exactly WATER_PER_LOCATION in each location --------------------
    for (const loc of [backroom, onfloor]) {
      const [existing] = await db
        .select()
        .from(inventoryStock)
        .where(
          and(
            eq(inventoryStock.companyId, company.id),
            eq(inventoryStock.storeId, store.id),
            eq(inventoryStock.productId, water.id),
            eq(inventoryStock.locationId, loc.id),
          ),
        )
        .limit(1);

      const was = existing?.quantityOnHand ?? 0;
      const delta = WATER_PER_LOCATION - was;
      if (existing) {
        if (delta !== 0) {
          await db
            .update(inventoryStock)
            .set({ quantityOnHand: WATER_PER_LOCATION })
            .where(eq(inventoryStock.id, existing.id));
        }
      } else {
        await db.insert(inventoryStock).values({
          companyId: company.id,
          storeId: store.id,
          productId: water.id,
          locationId: loc.id,
          quantityOnHand: WATER_PER_LOCATION,
        });
      }

      // Every stock change gets a ledger row, fixture or not — the ledger is the record of
      // how stock came to be what it is, and a silent adjustment is exactly the hole cycle
      // counts exist to find. ADJUSTMENT, not RECEIPT or SALE: nothing arrived and nothing
      // was bought.
      if (delta !== 0) {
        await db.insert(inventoryTransactions).values({
          companyId: company.id,
          storeId: store.id,
          productId: water.id,
          type: 'ADJUSTMENT',
          quantityDelta: delta,
          locationToId: delta > 0 ? loc.id : null,
          locationFromId: delta < 0 ? loc.id : null,
          note: `${NOTE} — set ${water.sku} at ${loc.name} to ${WATER_PER_LOCATION} (was ${was})`,
          source: 'PORTAL',
        });
        console.log(`\n${loc.name}: ${water.sku} ${was} -> ${WATER_PER_LOCATION}`);
      } else {
        console.log(`\n${loc.name}: ${water.sku} already ${WATER_PER_LOCATION}`);
      }
    }

    // ---- chuck roll: two units on the floor -------------------------------------------
    for (const serial of CHUCK_SERIALS) {
      const [unit] = await db
        .select()
        .from(inventoryItems)
        .where(
          and(eq(inventoryItems.companyId, company.id), eq(inventoryItems.serial, serial)),
        )
        .limit(1);

      if (!unit) {
        const [created] = await db
          .insert(inventoryItems)
          .values({
            companyId: company.id,
            storeId: store.id,
            productId: chuck.id,
            locationId: onfloor.id,
            serial,
            status: 'ON_HAND',
            receivedAt: new Date(),
          })
          .returning();
        await db.insert(inventoryTransactions).values({
          companyId: company.id,
          storeId: store.id,
          productId: chuck.id,
          itemId: created.id,
          type: 'RECEIPT',
          quantityDelta: 1,
          locationToId: onfloor.id,
          note: `${NOTE} — ${chuck.sku} ${serial}`,
          source: 'PORTAL',
        });
        console.log(`${onfloor.name}: created ${chuck.sku} ${serial}`);
        continue;
      }

      // It exists. Put it where the fixture wants it, and say what changed — a unit that
      // was sold and is now on the shelf again is worth reading about.
      const moved = unit.locationId !== onfloor.id || unit.storeId !== store.id;
      const revived = unit.status !== 'ON_HAND';
      if (moved || revived) {
        await db
          .update(inventoryItems)
          .set({
            storeId: store.id,
            locationId: onfloor.id,
            status: 'ON_HAND',
            soldAt: null,
            updatedAt: new Date(),
          })
          .where(eq(inventoryItems.id, unit.id));
        await db.insert(inventoryTransactions).values({
          companyId: company.id,
          storeId: store.id,
          productId: chuck.id,
          itemId: unit.id,
          type: moved ? 'MOVE' : 'ADJUSTMENT',
          quantityDelta: 0,
          locationFromId: unit.locationId,
          locationToId: onfloor.id,
          note: `${NOTE} — ${serial} put back on the floor${revived ? ` (was ${unit.status})` : ''}`,
          source: 'PORTAL',
        });
        console.log(
          `${onfloor.name}: ${serial} ${moved ? 'moved here' : 'kept'}${revived ? `, status ${unit.status} -> ON_HAND` : ''}`,
        );
      } else {
        console.log(`${onfloor.name}: ${serial} already here`);
      }
    }

    // ---- what a count should now see -------------------------------------------------
    const stockNow = await db
      .select({ sku: products.sku, qty: inventoryStock.quantityOnHand, loc: storeLocations.name })
      .from(inventoryStock)
      .innerJoin(products, eq(products.id, inventoryStock.productId))
      .innerJoin(storeLocations, eq(storeLocations.id, inventoryStock.locationId))
      .where(and(eq(inventoryStock.storeId, store.id), ne(inventoryStock.quantityOnHand, 0)));
    const unitsNow = await db
      .select({ serial: inventoryItems.serial, sku: products.sku, loc: storeLocations.name })
      .from(inventoryItems)
      .leftJoin(products, eq(products.id, inventoryItems.productId))
      .leftJoin(storeLocations, eq(storeLocations.id, inventoryItems.locationId))
      .where(and(eq(inventoryItems.storeId, store.id), eq(inventoryItems.status, 'ON_HAND')));

    const per = (locName: string) => {
      const q = stockNow.filter((r) => r.loc === locName).reduce((n, r) => n + r.qty, 0);
      const u = unitsNow.filter((r) => r.loc === locName).length;
      return { q, u, total: q + u };
    };
    const b = per(backroom.name);
    const f = per(onfloor.name);
    console.log(`\n--- ${store.name} now holds`);
    console.log(`${backroom.name}: ${b.total} item(s) — ${b.q} by quantity, ${b.u} serialized`);
    console.log(`${onfloor.name}: ${f.total} item(s) — ${f.q} by quantity, ${f.u} serialized`);
    for (const r of stockNow) console.log(`    ${r.qty} × ${r.sku} at ${r.loc}`);
    for (const r of unitsNow) console.log(`    ${r.serial} (${r.sku ?? 'unidentified'}) at ${r.loc ?? '—'}`);

    // A count already open on this store shows up on the handheld as work in progress and
    // will confuse a test. Reported, not cancelled: abandoning somebody's count is their
    // call, from the review screen.
    const live = await db
      .select({
        id: cycleCounts.id,
        status: cycleCounts.status,
        locationId: cycleCounts.locationId,
      })
      .from(cycleCounts)
      .where(
        and(
          eq(cycleCounts.storeId, store.id),
          inArray(cycleCounts.status, ['OPEN', 'AWAITING_REVIEW']),
        ),
      );
    if (live.length > 0) {
      console.log('\n! Counts already in progress on this store:');
      for (const cc of live) {
        const where =
          cc.locationId == null
            ? 'whole store'
            : (locs.find((l) => l.id === cc.locationId)?.name ?? `location #${cc.locationId}`);
        console.log(`    #${cc.id} ${cc.status} (${where}) — abandon it if it is in the way`);
      }
    }

    console.log('\nScan the water bottle by UPC and the chuck rolls by serial:');
    console.log(`    UPC    ${water.upc}`);
    for (const s of CHUCK_SERIALS) console.log(`    serial ${s}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
