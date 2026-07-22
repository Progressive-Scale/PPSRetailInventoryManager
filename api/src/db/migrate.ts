// Production migration runner. Compiled to dist/db/migrate.js and invoked as
// `npm run db:migrate:prod` (node dist/db/migrate.js) on deploy — needs no dev
// dependencies (drizzle-kit is not required at runtime).
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { join } from 'node:path';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set.');
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool);

  // dist/db/migrate.js -> ../../drizzle == api/drizzle
  const migrationsFolder = join(__dirname, '..', '..', 'drizzle');

  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  await pool.end();
  console.log('[migrate] done');
}

main().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
