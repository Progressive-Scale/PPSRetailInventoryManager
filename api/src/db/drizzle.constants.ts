import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

/** DI token for the Drizzle database instance. */
export const DRIZZLE = 'DRIZZLE';

/** Typed Drizzle database, aware of the full schema. */
export type Database = NodePgDatabase<typeof schema>;
