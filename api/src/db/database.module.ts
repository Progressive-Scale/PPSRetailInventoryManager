import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { DRIZZLE } from './drizzle.constants';
import { TenantDbService } from './tenant-db.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const logger = new Logger('Database');
        const isProd = config.get<string>('NODE_ENV') === 'production';
        // Runtime connection MUST be a non-superuser role for RLS to apply.
        const appUrl = config.get<string>('APP_DATABASE_URL');
        const ownerUrl = config.get<string>('DATABASE_URL');
        const connectionString = appUrl ?? ownerUrl;
        if (!connectionString) {
          throw new Error('APP_DATABASE_URL/DATABASE_URL is not set.');
        }
        if (!appUrl) {
          // In production this is not a warning-level problem. DATABASE_URL is the
          // owner role, owners bypass RLS, and RLS is the ONLY thing keeping one
          // company's inventory out of another company's requests. A deploy that
          // forgot this variable would serve every tenant everyone else's data and
          // look completely healthy doing it, so it refuses to start instead.
          if (isProd) {
            throw new Error(
              'APP_DATABASE_URL is not set. In production the runtime connection ' +
                'MUST be the restricted (non-owner) role, or Postgres RLS is not ' +
                'enforced and tenants can read each other. Refusing to start.',
            );
          }
          logger.warn(
            'APP_DATABASE_URL not set — using DATABASE_URL. If that role is a ' +
              'superuser/owner, Postgres RLS will NOT be enforced.',
          );
        }
        const pool = new Pool({ connectionString });
        pool.on('error', (err) =>
          logger.error('Unexpected PG pool error', err.stack),
        );

        // Ask Postgres what this role can actually do, rather than trusting that
        // the variable was pointed somewhere sensible. Setting APP_DATABASE_URL to
        // the owner satisfies the check above and still bypasses nothing visible —
        // the app looks fine and every tenant sees every other tenant.
        //
        // Tables are FORCE ROW LEVEL SECURITY, so plain ownership still obeys the
        // policies; SUPERUSER and BYPASSRLS do not, and those are fatal.
        const { rows } = await pool.query<{
          role: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
        }>(
          `SELECT current_user AS role, rolsuper, rolbypassrls
             FROM pg_roles WHERE rolname = current_user`,
        );
        const me = rows[0];
        if (me && (me.rolsuper || me.rolbypassrls)) {
          const why = me.rolsuper ? 'a SUPERUSER' : 'BYPASSRLS';
          const msg =
            `The runtime database role "${me.role}" is ${why}, so Postgres ` +
            'row-level security does not apply to it and tenant isolation is off. ' +
            'Point APP_DATABASE_URL at the restricted role.';
          if (isProd) throw new Error(`${msg} Refusing to start.`);
          logger.warn(msg);
        } else if (me) {
          logger.log(`Runtime role "${me.role}" is subject to RLS.`);
        }

        return drizzle(pool, { schema });
      },
    },
    TenantDbService,
  ],
  exports: [DRIZZLE, TenantDbService],
})
export class DatabaseModule {}
