/**
 * Repository-wide hardening of SECURITY DEFINER functions (ADR 0012).
 *
 * When pg_temp is not named in a function's search_path, PostgreSQL searches the session's temporary
 * schema first for tables, so a session could shadow a catalog or module table and make a privileged
 * function read attacker data. Every definer function owned by ebmr_owner must therefore pin its
 * search_path with pg_temp last, and the application role may not create temporary objects at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

describe('SECURITY DEFINER hardening', () => {
  it('[DI-13][DI-23] every definer function owned by ebmr_owner pins search_path with pg_temp last', async () => {
    const { rows } = await db.admin.query<{ fn: string; config: string[] | null }>(`
      select p.oid::regprocedure::text as fn, p.proconfig as config
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
      where p.prosecdef and r.rolname = 'ebmr_owner'
      order by 1`);
    expect(rows.length).toBeGreaterThan(0);
    const offenders = rows
      .filter((r) => {
        const setting = (r.config ?? []).find((c) => c.startsWith('search_path='));
        if (!setting) return true;
        const parts = setting.slice('search_path='.length).split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
        return parts[0] !== 'pg_catalog' || parts[parts.length - 1] !== 'pg_temp';
      })
      .map((r) => r.fn);
    expect(offenders).toEqual([]);
  });

  it('[DI-13][DI-23] the application role cannot create temporary tables to shadow catalog tables', async () => {
    const { rows } = await db.app.query<{ temp: boolean }>(
      `select has_database_privilege(current_user, current_database(), 'TEMP') as temp`,
    );
    expect(rows[0]?.temp).toBe(false);
    await expect(db.app.query('create temp table pg_trigger (tgrelid oid, tgname name, tgenabled "char")')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('[DI-13] the application role owns no objects and cannot create objects in any ebmr schema', async () => {
    const owned = await db.admin.query<{ n: string }>(`
      select count(*)::text as n from pg_catalog.pg_class c join pg_catalog.pg_roles r on r.oid = c.relowner
      where r.rolname = 'ebmr_app'`);
    expect(owned.rows[0]?.n).toBe('0');
    const creatable = await db.admin.query<{ nspname: string }>(`
      select n.nspname from pg_catalog.pg_namespace n
      where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
        and has_schema_privilege('ebmr_app', n.oid, 'CREATE')`);
    expect(creatable.rows.map((r) => r.nspname)).toEqual([]);
  });
});
