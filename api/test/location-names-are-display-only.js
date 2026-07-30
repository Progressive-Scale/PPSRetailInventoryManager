// PRINCIPLE TEST: location names are display-only. Rename a store's required
// locations to names that share no substring with the defaults, then assert every
// behaviour that keys on kind is unchanged.
//
//   ONFLOOR  -> "Showroom"
//   BACKROOM -> "Stock Room West"
//
// Everything is done through the real API/db and restored at the end.
const http = require('http');
const fs = require('fs');
const API = 'C:/Users/PPS Mitch/Documents/Programs/PPS/PPSRetailInventoryManager/api';
const { Pool } = require(API + '/node_modules/pg');
const cs = fs.readFileSync(API + '/.env', 'utf8').match(/^DATABASE_URL=(.+)$/m)[1].trim();

function req(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Host: 'demo.localhost', 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: 'localhost', port: 3000, path: '/api' + path, method, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let p; try { p = JSON.parse(d); } catch { p = d; } resolve({ status: res.statusCode, body: p }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  \u2713', n); } else { fail++; console.log('  \u2717', n, x !== undefined ? JSON.stringify(x).slice(0, 240) : ''); } };
const msg = (b) => (b && b.message) ? String(b.message) : JSON.stringify(b).slice(0, 140);


// The seed now gives each store SEVERAL locations of each required kind, so a test
// that needs "this row is the last active one of its kind" must create that
// precondition instead of assuming it. Deactivates every OTHER active row of the
// kind (they are empty, so this always succeeds) and returns their ids so the
// caller can restore them.
async function soloOfKind(req, admin, storeId, kind, keepId) {
  const rows = (await req('GET', `/locations?storeId=${storeId}&includeInactive=1`, { token: admin })).body;
  const others = rows.filter((l) => l.kind === kind && l.isActive && l.id !== keepId);
  const parked = [];
  for (const o of others) {
    const r = await req('POST', `/locations/${o.id}/deactivate`, { token: admin });
    if (r.status === 200) parked.push(o.id);
  }
  return parked;
}

async function restoreParked(req, admin, ids) {
  for (const id of ids) await req('POST', `/locations/${id}/reactivate`, { token: admin });
}

const NEW_FLOOR = 'Showroom';
const NEW_BACK = 'Stock Room West';
const STORE = 1, COMPANY = 1;

(async () => {
  const p = new Pool({ connectionString: cs });
  const admin = (await req('POST', '/auth/login', { body: { email: 'admin@demo.test', password: 'admin123' } })).body.access_token;
  const T = { token: admin };
  const listAll = async () => (await req(`GET`, `/locations?storeId=${STORE}&includeInactive=1`, T)).body;

  const before = await listAll();
  const floor = before.find((l) => l.kind === 'ONFLOOR' && l.isActive);
  const back = before.find((l) => l.kind === 'BACKROOM' && l.isActive);
  const originalFloorName = floor.name, originalBackName = back.name;
  console.log(`renaming: "${originalFloorName}" -> "${NEW_FLOOR}", "${originalBackName}" -> "${NEW_BACK}"\n`);

  try {
    // ---- rename through the real endpoint ----
    const r1 = await req('PATCH', `/locations/${floor.id}`, { token: admin, body: { name: NEW_FLOOR } });
    const r2 = await req('PATCH', `/locations/${back.id}`, { token: admin, body: { name: NEW_BACK } });
    check('renamed both required locations', r1.status === 200 && r2.status === 200, { r1: r1.status, r2: r2.status });
    const renamed = await listAll();
    check('new names are what the API reports',
      renamed.find((l) => l.id === floor.id).name === NEW_FLOOR &&
      renamed.find((l) => l.id === back.id).name === NEW_BACK);
    check('kinds are untouched by the rename',
      renamed.find((l) => l.id === floor.id).kind === 'ONFLOOR' &&
      renamed.find((l) => l.id === back.id).kind === 'BACKROOM');

    // ---- 1. invariant guards still fire, by kind ----
    console.log('\n[invariant guards]');
    // Reduce each required kind to this single active row so it genuinely IS the
    // last of its kind — the seed creates more than one of each.
    const parkedFloors = await soloOfKind(req, admin, STORE, 'ONFLOOR', floor.id);
    const parkedBacks = await soloOfKind(req, admin, STORE, 'BACKROOM', back.id);
    const delFloor = await req('DELETE', `/locations/${floor.id}`, T);
    check('cannot delete the last active ONFLOOR after renaming',
      delFloor.status === 409, { status: delFloor.status, msg: msg(delFloor.body) });
    check('guard message uses the KIND label, not the custom name',
      /at least one active On Floor/i.test(msg(delFloor.body)) && !msg(delFloor.body).includes(NEW_FLOOR),
      msg(delFloor.body));
    const offBack = await req('POST', `/locations/${back.id}/deactivate`, T);
    check('cannot deactivate the last active BACKROOM after renaming',
      offBack.status === 409, { status: offBack.status, msg: msg(offBack.body) });
    const flagged = await listAll();
    check('isLastOfRequiredKind still true for both renamed rows',
      flagged.find((l) => l.id === floor.id).isLastOfRequiredKind === true &&
      flagged.find((l) => l.id === back.id).isLastOfRequiredKind === true);

    await restoreParked(req, admin, [...parkedFloors, ...parkedBacks]);

    // ---- 2. handoff / receipt landing resolves the renamed backroom ----
    console.log('\n[default landing resolves by kind]');
    const landing = (await p.query(
      `select id, name from store_locations
        where company_id=$1 and store_id=$2 and kind='BACKROOM' and is_active
        order by sort_order, created_at, id limit 1`, [COMPANY, STORE])).rows[0];
    check('landing location is the renamed backroom (by kind, not name)',
      landing.id === back.id && landing.name === NEW_BACK, landing);

    // ---- 3. expiration alerts cover the renamed floor ----
    console.log('\n[expiration alerts scope by kind]');
    const c = await p.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.company_id','1',true)");
      const product = (await c.query(
        "select id from products where company_id=$1 and tracking_type='SERIALIZED' limit 1", [COMPANY])).rows[0];
      const item = (await c.query(
        `insert into inventory_items (company_id, store_id, product_id, location_id, serial, status, expiration_date)
         values ($1,$2,$3,$4,$5,'ON_HAND',(current_date + make_interval(days => 3))::date) returning id`,
        [COMPANY, STORE, product.id, floor.id, `RENAME-${Date.now()}`])).rows[0];
      const due = await c.query(
        `select i.id from inventory_items i join store_locations l on l.id=i.location_id
          where i.company_id=$1 and l.kind='ONFLOOR' and l.is_active and i.status='ON_HAND'
            and i.expiration_date is not null
            and i.expiration_date <= (current_date + make_interval(days => 30))::date`, [COMPANY]);
      check('an item in the RENAMED floor location still alerts',
        due.rows.some((r) => r.id === item.id), due.rows.length);
      await c.query('rollback');
    } finally { c.release(); }

    // ---- 4. move targets / scanner list unaffected ----
    console.log('\n[move targets + scanner list]');
    const active = (await req('GET', `/locations?storeId=${STORE}`, T)).body;
    check('renamed locations still offered as move targets',
      active.some((l) => l.id === floor.id) && active.some((l) => l.id === back.id));
    check('every row still carries its kind for client-side logic',
      active.every((l) => ['BACKROOM', 'ONFLOOR', 'CUSTOM'].includes(l.kind)));
    const unit = (await p.query(
      "select id from inventory_items where company_id=$1 and store_id=$2 and status='ON_HAND' limit 1",
      [COMPANY, STORE])).rows[0];
    const mv = await req('POST', '/inventory/move', { token: admin, body: { itemIds: [unit.id], toLocationId: floor.id } });
    check('a move INTO the renamed floor works', mv.status === 200 || mv.status === 201, { status: mv.status, body: msg(mv.body) });
    const moved = (await p.query('select location_id from inventory_items where id=$1', [unit.id])).rows[0];
    check('the unit is now at the renamed floor', moved.location_id === floor.id, moved);
    const back2 = await req('POST', '/inventory/move', { token: admin, body: { itemIds: [unit.id], toLocationId: back.id } });
    check('and back into the renamed backroom', back2.status === 200 || back2.status === 201, back2.status);

    // ---- 5. a NEW store still gets the default names ----
    console.log('\n[new store still gets default display names]');
    const st = await req('POST', '/stores', { token: admin, body: { name: `Rename Probe ${Date.now()}` } });
    check('store created', st.status === 201, st.body);
    const fresh = (await req('GET', `/locations?storeId=${st.body.id}`, T)).body;
    // Names are unique per STORE, so every store owns a plain "Backroom".
    check('new store gets Backroom + On Floor by default name',
      fresh.some((l) => l.kind === 'BACKROOM' && l.name === 'Backroom') &&
      fresh.some((l) => l.kind === 'ONFLOOR' && l.name === 'On Floor'),
      fresh.map((l) => `${l.kind}:${l.name}`));
    check('names are unique within the store',
      new Set(fresh.map((l) => l.name.toLowerCase())).size === fresh.length,
      fresh.map((l) => l.name));
    // clean up the probe store
    for (const l of (await req('GET', `/locations?storeId=${st.body.id}&includeInactive=1`, T)).body) {
      await req('DELETE', `/locations/${l.id}`, T);
    }
    await req('DELETE', `/stores/${st.body.id}`, T);
  } finally {
    // ---- restore the original names ----
    await req('PATCH', `/locations/${floor.id}`, { token: admin, body: { name: originalFloorName } });
    await req('PATCH', `/locations/${back.id}`, { token: admin, body: { name: originalBackName } });
    const restored = await listAll();
    check('original names restored',
      restored.find((l) => l.id === floor.id).name === originalFloorName &&
      restored.find((l) => l.id === back.id).name === originalBackName);
  }

  await p.end();
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
