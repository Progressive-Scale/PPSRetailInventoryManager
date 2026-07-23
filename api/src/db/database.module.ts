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
      useFactory: (config: ConfigService) => {
        const logger = new Logger('Database');
        // Runtime connection MUST be a non-superuser role for RLS to apply.
        const appUrl = config.get<string>('APP_DATABASE_URL');
        const ownerUrl = config.get<string>('DATABASE_URL');
        const connectionString = appUrl ?? ownerUrl;
        if (!connectionString) {
          throw new Error('APP_DATABASE_URL/DATABASE_URL is not set.');
        }
        if (!appUrl) {
          logger.warn(
            'APP_DATABASE_URL not set — using DATABASE_URL. If that role is a ' +
              'superuser/owner, Postgres RLS will NOT be enforced.',
          );
        }
        const pool = new Pool({ connectionString });
        pool.on('error', (err) =>
          logger.error('Unexpected PG pool error', err.stack),
        );
        return drizzle(pool, { schema });
      },
    },
    TenantDbService,
  ],
  exports: [DRIZZLE, TenantDbService],
})
export class DatabaseModule {}
