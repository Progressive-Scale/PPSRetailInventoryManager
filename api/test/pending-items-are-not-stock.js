/**
 * PENDING means "the ERP shipped it", not "it is in the store".
 *
 * Every one of these exclusions currently holds for free — the queries already
 * filter on ON_HAND, and a PENDING unit has no location so it cannot join to one.
 * That is exactly why this test exists: nothing in the code says "and remember to
 * keep PENDING out", so a later change that widens an allowed-status list or turns
 * a join around would break the model silently. This fails loudly instead.
 *
 * Run: node api/test/pending-items-are-not-stock.js
 */
const path = require('path');
const fs = require('fs');

const API = path.resolve(__dirname, '..');
const { Pool } = require(path.join(API, 'node_modules/pg'));

const cs = fs
  .readFileSync(path.join(API, '.env'), 'utf8')
  .match(/^DATABASE_URL=(.+)$/m)[1]
  .trim();

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass++;
    console.log('  ✓', name);
  } else {
    fail++;
    console.log('  ✗', name, detail !== undefined ? JSON.stringify(detail) : '');
  }
};

async function main() {
  const p = new Pool({ connectionString: cs });
  const COMPANY = 1;
  const SERIAL = `TESTPEND-${Date.now()}`;
  let itemId;

  try {
    const [store] = (
      await p.query('select id from stores where company_id=$1 order by id limit 1', [
        COMPANY,
      ])
    ).rows;
    const [product] = (
      await p.query(
        "select id from products where company_id=$1 and tracking_type='SERIALIZED' order by id limit 1",
        [COMPANY],
      )
    ).rows;
    const [onfloor] = (
      await p.query(
        "select id from store_locations where store_id=$1 and kind='ONFLOOR' and is_active order by id limit 1",
        [store.id],
      )
    ).rows;

    // A PENDING unit that WOULD trip every check if it were treated as stock: it
    // has an expiration inside any sane alert window.
    const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    itemId = (
      await p.query(
        `insert into inventory_items
           (company_id, store_id, product_id, location_id, serial, status, expiration_date)
         values ($1,$2,$3,null,$4,'PENDING',$5) returning id`,
        [COMPANY, store.id, product.id, SERIAL, soon],
      )
    ).rows[0].id;

    console.log('PENDING is not on-hand stock:');

    const onHand = (
      await p.query(
        `select coalesce(sum(on_hand),0)::int n from store_inventory
          where company_id=$1 and store_id=$2 and product_id=$3`,
        [COMPANY, store.id, product.id],
      )
    ).rows[0].n;
    const onHandItems = (
      await p.query(
        `select count(*)::int n from inventory_items
          where company_id=$1 and store_id=$2 and product_id=$3 and status='ON_HAND'`,
        [COMPANY, store.id, product.id],
      )
    ).rows[0].n;
    check(
      'store_inventory.on_hand counts only ON_HAND units',
      onHand === onHandItems,
      { view: onHand, onHandRows: onHandItems },
    );

    console.log('PENDING cannot be picked up by the expiration-alert scan:');
    // Mirrors ExpirationAlertsJob: ON_HAND, at an ACTIVE ONFLOOR location, due soon.
    const alertable = (
      await p.query(
        `select count(*)::int n
           from inventory_items i
           join store_locations l on l.id = i.location_id
          where i.company_id=$1 and i.serial=$2
            and i.status='ON_HAND' and l.kind='ONFLOOR' and l.is_active
            and i.expiration_date is not null
            and i.expiration_date <= current_date + 30`,
        [COMPANY, SERIAL],
      )
    ).rows[0].n;
    check('a due-soon PENDING unit is not alertable', alertable === 0, alertable);
    check(
      'and it has no location to be on a floor at all',
      (await p.query('select location_id from inventory_items where id=$1', [itemId]))
        .rows[0].location_id === null,
    );

    console.log('PENDING is invisible to location accounting:');
    const atLocation = (
      await p.query(
        `select count(*)::int n from inventory_items
          where company_id=$1 and location_id=$2 and serial=$3`,
        [COMPANY, onfloor.id, SERIAL],
      )
    ).rows[0].n;
    check('not attributed to any location', atLocation === 0, atLocation);

    console.log('the CHECK constraints hold:');
    let rejected = false;
    try {
      await p.query('update inventory_items set location_id=$1 where id=$2', [
        onfloor.id,
        itemId,
      ]);
    } catch (e) {
      rejected = e.constraint === 'inventory_items_pending_has_no_location';
    }
    check('giving a PENDING unit a location is rejected', rejected);

    rejected = false;
    try {
      await p.query("update inventory_items set status='ON_HAND' where id=$1", [itemId]);
    } catch (e) {
      rejected = e.constraint === 'inventory_items_pending_has_no_location';
    }
    check(
      'promoting to ON_HAND without a location is rejected (receiving must set both)',
      rejected,
    );

    // Receiving does both at once, which is the only legal transition.
    await p.query(
      "update inventory_items set status='ON_HAND', location_id=$1 where id=$2",
      [onfloor.id, itemId],
    );
    const after = (
      await p.query('select status, location_id from inventory_items where id=$1', [
        itemId,
      ])
    ).rows[0];
    check(
      'receiving (status + location in one statement) is allowed',
      after.status === 'ON_HAND' && after.location_id === onfloor.id,
      after,
    );
  } finally {
    if (itemId) {
      await p.query('delete from inventory_transactions where item_id=$1', [itemId]);
      await p.query('delete from inventory_items where id=$1', [itemId]);
    }
    await p.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
