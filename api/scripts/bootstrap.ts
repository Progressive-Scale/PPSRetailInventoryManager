// Production first-run — run with: npm run db:bootstrap
//
// Creates the minimum a live deployment needs and nothing else: one platform
// admin, one company, one store, that store's two system locations, and one
// company admin for the customer. No demo companies, no sample products, no
// passwords that appear anywhere in this repository.
//
// This exists because `db:seed` must never be run against production. The seed
// builds a full demo world — Demo Retail Co, Acme Supply, sample inventory, and
// accounts whose passwords are written in the README. Excellent for a laptop,
// a data breach on a customer's database.
//
// Everything comes from the environment, so no value passes through a shell
// history or a chat window:
//
//   PLATFORM_ADMIN_EMAIL      admin@yourcompany.com
//   PLATFORM_ADMIN_PASSWORD   (>= 12 chars)
//   PLATFORM_ADMIN_USERNAME   optional, defaults to the email local part
//   COMPANY_NAME              "Acme Grocery"
//   COMPANY_SLUG              acme      -> acme.<ROOT_DOMAIN>
//   STORE_NAME                "Main Street"
//   COMPANY_ADMIN_EMAIL       owner@acmegrocery.com
//   COMPANY_ADMIN_PASSWORD    (>= 12 chars)
//   COMPANY_ADMIN_USERNAME    optional, defaults to the email local part
//
// Idempotent, and refuses by default to touch a database that already holds
// companies — a second run against a live tenant is far more likely to be a
// mistake than an intention. BOOTSTRAP_ALLOW_EXISTING=1 overrides that once you
// have decided otherwise (adding a second company to a running platform).
import 'dotenv/config';
import { hash } from 'bcryptjs';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { DEFAULT_LOCATION_NAMES } from '../src/locations/location-names';
import * as schema from '../src/db/schema';

const { companies, stores, storeLocations, users, userStores } = schema;

type Db = ReturnType<typeof drizzle<typeof schema>>;

const MIN_PASSWORD = 12;
/** Slugs become subdomains, so the rules are DNS's, not ours. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Reserved by the platform itself — a company named this could not be reached. */
const RESERVED_SLUGS = new Set(['admin', 'www', 'api', 'app', 'mail', 'static']);

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set. See the header of this script.`);
  return v;
}

function requiredPassword(name: string): string {
  const v = required(name);
  if (v.length < MIN_PASSWORD) {
    throw new Error(`${name} must be at least ${MIN_PASSWORD} characters.`);
  }
  return v;
}

function localPart(email: string): string {
  return email.split('@')[0].toLowerCase();
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Bootstrap connects as the OWNER role (it writes ' +
        'across tenants); APP_DATABASE_URL is the restricted runtime role and ' +
        'cannot do this.',
    );
  }

  // Read and validate everything before writing anything, so a missing variable
  // cannot leave a half-created platform behind.
  const platformEmail = required('PLATFORM_ADMIN_EMAIL');
  const platformPassword = requiredPassword('PLATFORM_ADMIN_PASSWORD');
  const platformUsername =
    process.env.PLATFORM_ADMIN_USERNAME?.trim().toLowerCase() ||
    localPart(platformEmail);

  const companyName = required('COMPANY_NAME');
  const companySlug = required('COMPANY_SLUG').toLowerCase();
  const storeName = required('STORE_NAME');
  const companyEmail = required('COMPANY_ADMIN_EMAIL');
  const companyPassword = requiredPassword('COMPANY_ADMIN_PASSWORD');
  const companyUsername =
    process.env.COMPANY_ADMIN_USERNAME?.trim().toLowerCase() ||
    localPart(companyEmail);

  if (!SLUG_RE.test(companySlug)) {
    throw new Error(
      `COMPANY_SLUG "${companySlug}" is not a valid subdomain label: lowercase ` +
        'letters, digits and hyphens, not starting or ending with a hyphen.',
    );
  }
  if (RESERVED_SLUGS.has(companySlug)) {
    throw new Error(
      `COMPANY_SLUG "${companySlug}" is reserved by the platform — ` +
        `${companySlug}.<ROOT_DOMAIN> would not reach this company.`,
    );
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  try {
    const existing = await db.select({ slug: companies.slug }).from(companies);
    const allowExisting = process.env.BOOTSTRAP_ALLOW_EXISTING === '1';
    if (existing.length > 0 && !allowExisting) {
      const names = existing.map((c) => c.slug).join(', ');
      throw new Error(
        `This database already has ${existing.length} company/companies (${names}). ` +
          'Bootstrap is for a fresh platform. If you really mean to add another ' +
          'company to a running one, re-run with BOOTSTRAP_ALLOW_EXISTING=1.',
      );
    }

    // ---- platform admin (no company) ------------------------------------
    // Conflict target is (company_id, email), and company_id is NULL here, which
    // no unique index can match — so an existing row has to be found first
    // rather than relied on to conflict.
    const [priorPlatform] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, platformEmail))
      .limit(1);

    if (priorPlatform) {
      console.log(`Platform admin ${platformEmail} already exists — left alone.`);
    } else {
      await db.insert(users).values({
        companyId: null,
        storeId: null,
        email: platformEmail,
        username: platformUsername,
        passwordHash: await hash(platformPassword, 10),
        role: 'PLATFORM_ADMIN',
        status: 'ACTIVE',
      });
      console.log(`Platform admin created: ${platformEmail} (${platformUsername})`);
    }

    // ---- company --------------------------------------------------------
    await db
      .insert(companies)
      .values({
        name: companyName,
        slug: companySlug,
        branding: { logoUrl: null, primaryColor: '#2563eb' },
        status: 'ACTIVE',
      })
      .onConflictDoNothing({ target: companies.slug });
    const [company] = await db
      .select()
      .from(companies)
      .where(eq(companies.slug, companySlug))
      .limit(1);
    if (!company) throw new Error(`Failed to create company '${companySlug}'.`);
    console.log(`Company: ${company.name} (#${company.id}, slug ${company.slug})`);

    // ---- store ----------------------------------------------------------
    // Look first rather than lean on onConflictDoNothing: stores has no unique
    // constraint on (company_id, name) — two branches may legitimately share a
    // name — so there is no conflict for Postgres to catch, and a second run
    // would quietly create a duplicate store.
    let [store] = await db
      .select()
      .from(stores)
      .where(and(eq(stores.companyId, company.id), eq(stores.name, storeName)))
      .limit(1);
    if (!store) {
      [store] = await db
        .insert(stores)
        .values({ companyId: company.id, name: storeName })
        .returning();
      console.log(`Store created: ${store.name} (#${store.id})`);
    } else {
      console.log(`Store: ${store.name} (#${store.id}) — already existed`);
    }
    if (!store) throw new Error(`Failed to create store '${storeName}'.`);

    // ---- the store's two system locations -------------------------------
    // One Backroom and one On Floor: the minimum the app's invariants require.
    // Extra locations are something the customer adds when they need them.
    const locs = await db
      .select()
      .from(storeLocations)
      .where(
        and(
          eq(storeLocations.companyId, company.id),
          eq(storeLocations.storeId, store.id),
        ),
      );
    for (const d of [
      { name: DEFAULT_LOCATION_NAMES.BACKROOM, kind: 'BACKROOM' as const, sortOrder: 0 },
      { name: DEFAULT_LOCATION_NAMES.ONFLOOR, kind: 'ONFLOOR' as const, sortOrder: 1 },
    ]) {
      if (locs.some((l) => l.kind === d.kind)) continue;
      await db.insert(storeLocations).values({
        companyId: company.id,
        storeId: store.id,
        name: d.name,
        kind: d.kind,
        sortOrder: d.sortOrder,
      });
      console.log(`Location created: ${d.name} (${d.kind})`);
    }
    const after = await db
      .select()
      .from(storeLocations)
      .where(
        and(
          eq(storeLocations.companyId, company.id),
          eq(storeLocations.storeId, store.id),
        ),
      )
      .orderBy(asc(storeLocations.sortOrder), asc(storeLocations.id));
    if (
      !after.some((l) => l.kind === 'BACKROOM' && l.isActive) ||
      !after.some((l) => l.kind === 'ONFLOOR' && l.isActive)
    ) {
      throw new Error('Store is missing an active BACKROOM or ONFLOOR location.');
    }

    // ---- the customer's own admin ---------------------------------------
    await db
      .insert(users)
      .values({
        companyId: company.id,
        storeId: store.id,
        email: companyEmail,
        username: companyUsername,
        passwordHash: await hash(companyPassword, 10),
        role: 'COMPANY_ADMIN',
        status: 'ACTIVE',
      })
      .onConflictDoNothing({ target: [users.companyId, users.email] });
    const [admin] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(and(eq(users.companyId, company.id), eq(users.email, companyEmail)))
      .limit(1);
    if (!admin) throw new Error(`Failed to create company admin '${companyEmail}'.`);
    await db
      .insert(userStores)
      .values({ companyId: company.id, userId: admin.id, storeId: store.id })
      .onConflictDoNothing({ target: [userStores.userId, userStores.storeId] });
    console.log(`Company admin: ${companyEmail} (${admin.username})`);

    const domain = process.env.ROOT_DOMAIN?.trim();
    console.log('\nDone. Sign in at:');
    console.log(
      `  company : https://${company.slug}.${domain ?? '<ROOT_DOMAIN>'}`,
    );
    console.log(`  platform: https://admin.${domain ?? '<ROOT_DOMAIN>'}`);
    console.log(
      '\nPasswords are not printed. Both accounts should change theirs on first ' +
        'sign-in (Profile), and every further user should arrive by invitation.',
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`\nBootstrap failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
