/**
 * The Kysely read database (plan section 3): typed read models only (audit viewer filters, lists, cockpit).
 * Modules declare their tables with `readDb.withTables<...>()`; writes never go through Kysely.
 */
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import type pg from 'pg';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- modules add their tables with withTables<>().
export interface ReadDatabase {}

export function createReadDb(pool: pg.Pool): Kysely<ReadDatabase> {
  // Kysely ends its pool on destroy(); the application pool belongs to Pools, so Kysely gets a view that cannot end it.
  const shared: PostgresPool = { connect: () => pool.connect(), end: () => Promise.resolve(), options: pool.options };
  return new Kysely<ReadDatabase>({ dialect: new PostgresDialect({ pool: shared }) });
}
