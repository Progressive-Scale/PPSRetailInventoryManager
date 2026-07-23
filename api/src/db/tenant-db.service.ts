import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, Database } from './drizzle.constants';

/** A transaction handle already scoped by RLS (via set_config). */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The ONLY sanctioned way to touch tenant data. Every call opens a transaction
 * and sets the Postgres session vars the RLS policies read, so queries are
 * physically scoped even if a repository forgets an explicit filter.
 */
@Injectable()
export class TenantDbService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Run scoped to a single company (RLS restricts rows to that company). */
  async withCompany<T>(
    companyId: number,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.company_id', ${String(companyId)}, true), set_config('app.is_platform_admin', 'off', true)`,
      );
      return fn(tx);
    });
  }

  /**
   * Platform-admin / system bypass (RLS allows all rows). Used only by the
   * admin module and by system lookups that run before a tenant is known
   * (resolving an API key to its company, platform-admin login).
   */
  async withBypass<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.is_platform_admin', 'on', true)`,
      );
      return fn(tx);
    });
  }
}
