/**
 * No connection but a superuser's may cancel or end another connection's work (kernel 0970; review finding P50, round
 * 4; ADR 0012).
 *
 * PostgreSQL lets a role cancel (pg_cancel_backend) or end (pg_terminate_backend) the backends of its own role, and
 * both functions are executable by PUBLIC out of the box. The tablets gateway listener logs in with the application
 * role, so anyone holding that role's credentials could cancel its heartbeats and make a working scale read OFFLINE.
 * The database-level policy sandbox.apply_connect_policy() now takes both functions away from every role but
 * superusers, the kernel migration applies it, a copy of the database keeps it, and kernel.backend_signals_restricted()
 * reports whether an installation still holds it (the tablets gate refuses hand-keyed weights while it does not).
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { ADMIN_URL, createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.drop();
});

const restricted = async (c: { query: pg.Pool['query'] } = db.admin): Promise<boolean> =>
  (await c.query<{ r: boolean }>('select kernel.backend_signals_restricted() as r')).rows[0]?.r ?? false;

/** Runs `sql` with the backend pid of another connection of role `role`, answering the error message or 'ok'. */
async function signal(role: { name: string; password: string }, sql: string): Promise<string> {
  const victim = new pg.Client({ connectionString: urlFor(db.name, role) });
  const attacker = new pg.Client({ connectionString: urlFor(db.name, role) });
  await victim.connect();
  await attacker.connect();
  try {
    const pid = (await victim.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
    const outcome = await attacker.query(sql, [pid]).then(
      () => 'ok',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    // The victim's connection still works when the signal was refused.
    if (outcome !== 'ok') expect((await victim.query<{ one: number }>('select 1 as one')).rows).toEqual([{ one: 1 }]);
    return outcome;
  } finally {
    await attacker.end();
    await victim.end().catch(() => undefined);
  }
}

const APP = { name: 'ebmr_app', password: 'ebmr_app' };
const AUTHN = { name: 'ebmr_authn', password: 'ebmr_authn' };

describe('backend signals (kernel 0970)', () => {
  it('[DI-17][DI-30] neither the application role nor the authentication service can cancel or end a connection of its own role; a superuser still can', async () => {
    expect(await restricted()).toBe(true);
    for (const role of [APP, AUTHN]) {
      expect(await signal(role, 'select pg_cancel_backend($1)')).toMatch(/permission denied for function pg_cancel_backend/);
      expect(await signal(role, 'select pg_terminate_backend($1)')).toMatch(/permission denied for function pg_terminate_backend/);
    }
    // The database's operator keeps the right.
    const victim = await db.app.connect();
    try {
      const pid = (await victim.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
      expect((await db.admin.query<{ ok: boolean }>('select pg_cancel_backend($1) as ok', [pid])).rows).toEqual([{ ok: true }]);
    } finally {
      victim.release();
    }
  });

  it('[DI-17][DI-30] the policy is in the migrated database itself, so a plain copy keeps it; a grant to PUBLIC or to the application role, or a login role in pg_signal_backend, is reported, and sandbox.apply_connect_policy() takes the grants away again', async () => {
    // A copy made as a restore or CREATE DATABASE ... TEMPLATE makes it, without the connect policy applied after.
    const copy = `ebmr_t_${randomBytes(6).toString('hex')}`;
    const server = new pg.Client({ connectionString: ADMIN_URL });
    await server.connect();
    try {
      await server.query(`create database ${copy} template ${inject('templateDb')}`);
      const plain = new pg.Client({ connectionString: urlFor(copy) });
      await plain.connect();
      try {
        expect(await restricted(plain)).toBe(true);
        const acl = await plain.query<{ fn: string; acl: string[] | null }>(
          "select p.oid::regprocedure::text as fn, p.proacl::text[] as acl from pg_proc p where p.pronamespace = 'pg_catalog'::regnamespace and p.proname in ('pg_cancel_backend', 'pg_terminate_backend') order by 1",
        );
        expect(acl.rows.length).toBeGreaterThanOrEqual(2);
        for (const r of acl.rows) expect(r.acl?.every((a) => !a.startsWith('=') && !a.startsWith('ebmr_'))).toBe(true);
      } finally {
        await plain.end();
      }
    } finally {
      await server.query(`drop database if exists ${copy} with (force)`);
      await server.end();
    }

    // Lost in this database (a grant made by hand, a restore of another installation): reported, and repaired.
    await db.admin.query('grant execute on function pg_catalog.pg_cancel_backend(integer) to public');
    expect(await restricted()).toBe(false);
    expect(await signal(APP, 'select pg_cancel_backend($1)')).toBe('ok');
    await db.admin.query('select sandbox.apply_connect_policy()');
    expect(await restricted()).toBe(true);
    expect(await signal(APP, 'select pg_cancel_backend($1)')).toMatch(/permission denied/);

    await db.admin.query('grant execute on function pg_catalog.pg_terminate_backend(integer, bigint) to ebmr_app');
    expect(await restricted()).toBe(false);
    await db.admin.query('select sandbox.apply_connect_policy()');
    expect(await restricted()).toBe(true);
    expect(await signal(APP, 'select pg_terminate_backend($1)')).toMatch(/permission denied/);

    // A login role that is a member of pg_signal_backend may signal any backend that is not a superuser's. The role
    // and its membership are cluster-wide, so they live only in this transaction, which is rolled back.
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      const role = `ebmr_t_signal_${randomBytes(4).toString('hex')}`;
      await c.query(`create role ${role} login`);
      await c.query(`grant pg_signal_backend to ${role}`);
      expect(await restricted(c)).toBe(false);
      await c.query(`create role ${role}_nologin nologin`);
      await c.query(`revoke pg_signal_backend from ${role}`);
      await c.query(`grant pg_signal_backend to ${role}_nologin`);
      expect(await restricted(c)).toBe(true);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  /**
   * Defect D15 of the Phase 2 exit (SQL mutation kill work, group connection-roles): an EXECUTE entry on a backend-signal
   * function that names a role oid the cluster does not know (only a direct write into pg_proc by a superuser makes one)
   * gave a grantee of NULL, so the policy built 'revoke execute on function ... from ' and failed with a syntax error.
   * It failed closed, but said nothing of why. Kernel 1111 refuses it with a coded reason before it applies anything.
   * Everything happens in a transaction that is rolled back (the catalogue entry included).
   */
  it('[DI-17][DI-30] a backend-signal grant to a role the cluster does not know is refused by the policy with EBMR-SBX-038, naming the function and the unknown role oid; nothing is applied, and the installation is reported as not holding the policy', async () => {
    const c = await db.admin.connect();
    const unknown = 4_294_967_000;
    const acls = async () =>
      (
        await c.query<{ fn: string; acl: string[] | null }>(
          "select p.oid::regprocedure::text as fn, p.proacl::text[] as acl from pg_proc p where p.pronamespace = 'pg_catalog'::regnamespace and p.proname in ('pg_cancel_backend', 'pg_terminate_backend') order by 1",
        )
      ).rows;
    const connectApp = async () =>
      (await c.query<{ ok: boolean }>("select has_database_privilege('ebmr_app', current_database(), 'CONNECT') as ok")).rows[0]?.ok;
    try {
      await c.query('begin');
      expect((await c.query('select 1 from pg_catalog.pg_authid where oid = $1', [unknown])).rows).toEqual([]);
      await c.query(
        `update pg_catalog.pg_proc set proacl = array_append(coalesce(proacl, acldefault('f', proowner)), makeaclitem($1::oid, proowner, 'EXECUTE', false))
          where oid in ('pg_catalog.pg_cancel_backend(integer)'::regprocedure, 'pg_catalog.pg_terminate_backend(integer, bigint)'::regprocedure)`,
        [unknown],
      );
      // Beside it, what the policy would change if it ran: a grant to PUBLIC, and the application role's CONNECT taken.
      await c.query('grant execute on function pg_catalog.pg_terminate_backend(integer, bigint) to public');
      await c.query(`revoke connect on database ${db.name} from ebmr_app`);
      const before = await acls();
      expect(await restricted(c)).toBe(false);
      await c.query('savepoint policy');
      const outcome = await c.query('select sandbox.apply_connect_policy()').then(
        () => ({ code: 'ok', message: '' }),
        (error: unknown) => ({ code: (error as { code?: string }).code, message: (error as Error).message }),
      );
      await c.query('rollback to savepoint policy');
      expect(outcome).toEqual({
        code: 'P0001',
        message:
          'Backend signals cannot be taken away from a role the cluster does not know: EXECUTE on pg_cancel_backend(integer) is granted to role oid 4294967000, ' +
          'EXECUTE on pg_terminate_backend(integer,bigint) is granted to role oid 4294967000 (an entry written into the catalogue directly, which no REVOKE can name). ' +
          "Nothing was applied: a superuser removes those entries from the functions' privileges and applies the policy again (DI-17, DI-30). [EBMR-SBX-038]",
      });
      expect(await acls()).toEqual(before);
      expect(await connectApp()).toBe(false);
      expect(await restricted(c)).toBe(false);
    } finally {
      await c.query('rollback');
      c.release();
    }
    // Rolled back: the database holds the policy as before.
    expect(await restricted()).toBe(true);
  });
});
