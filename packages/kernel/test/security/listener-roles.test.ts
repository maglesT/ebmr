/**
 * The evidence listener's own login roles, and a share of the database's connections the application roles cannot
 * take (kernel 0980; review finding P50, follow-up item p50-gate-vs-app-role; ADR 0012; controls DI-17, DI-30, PR-20).
 *
 * The tablets gateway listener puts on record what the site gateway sends, and the manual-weighing gate counts a scale
 * silent only on the listener's own record that everything it received is on record (tablets 0350). That record is
 * worth something only if no other login can write it, and the listener must be able to open its connections while a
 * holder of an application role's credentials takes every one it is allowed. So: ebmr_listener (GMP) and
 * ebmr_sandbox_listener (sandbox) are login roles of their own, members of nothing and with no members, each able to
 * connect only to databases of its kind, the sandbox one holding exactly the GMP one's privileges inside a sandbox; and
 * the application roles ebmr_app and ebmr_sandbox are limited to the cluster's slots less the listener's share.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { provisionSandboxDatabase, segregationProblems, upgradeSandboxDatabase } from '../../src/sandbox/provision.ts';
import { endPool, openPool } from '../harness/pools.ts';
import { ADMIN_URL, createTestDatabase, urlFor } from '../support/db.ts';
import { asAdmin, attempt, dropDatabase, editionMigrationSources, onServer, sandboxTestName } from '../sandbox/helpers.ts';

const LISTENER_LOGIN = { name: 'ebmr_listener', password: 'ebmr_listener' };
const SANDBOX_LISTENER_LOGIN = { name: 'ebmr_sandbox_listener', password: 'ebmr_sandbox_listener' };
/** The connections kernel 0980 keeps free of each application role for the listener. */
const LISTENER_SHARE = 8;

const created: string[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const name of created) await dropDatabase(name);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('the evidence listener\'s login roles (kernel 0980)', () => {
  it('[DI-17][DI-30] ebmr_listener and ebmr_sandbox_listener are login roles of their own (NOINHERIT, no elevated attribute, members of nothing, with no members); in a GMP database only ebmr_listener may connect', async () => {
    const roles = await onServer(
      async (s) =>
        (
          await s.query<{ rolname: string; login: boolean; inherit: boolean; elevated: boolean; memberOf: number; members: number }>(
            `select r.rolname, r.rolcanlogin as login, r.rolinherit as inherit,
                    (r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls) as elevated,
                    (select count(*)::int from pg_auth_members m where m.member = r.oid) as "memberOf",
                    (select count(*)::int from pg_auth_members m where m.roleid = r.oid) as members
               from pg_roles r where r.rolname in ('ebmr_listener', 'ebmr_sandbox_listener') order by 1`,
          )
        ).rows,
    );
    expect(roles).toEqual([
      { rolname: 'ebmr_listener', login: true, inherit: false, elevated: false, memberOf: 0, members: 0 },
      { rolname: 'ebmr_sandbox_listener', login: true, inherit: false, elevated: false, memberOf: 0, members: 0 },
    ]);
    const db = await createTestDatabase();
    try {
      expect(await attempt(db.name, LISTENER_LOGIN)).toBeNull();
      expect(await attempt(db.name, SANDBOX_LISTENER_LOGIN)).toMatch(/permission denied for database/);
      expect(await segregationProblems(db.app)).toEqual([]);
      // A role made a member of a listener role could act as the listener; a listener role made a member of the
      // application role would hold its privileges. Both are reported (cluster-wide, so only in a rolled-back
      // transaction).
      const c = await db.admin.connect();
      try {
        await c.query('begin');
        await c.query('grant ebmr_listener to ebmr_app');
        await c.query('grant ebmr_app to ebmr_sandbox_listener');
        expect((await c.query<{ p: string }>('select p from sandbox.segregation_problems() p')).rows.map((r) => r.p)).toEqual([
          'ebmr_app is a member of role ebmr_listener',
          'ebmr_sandbox_listener is a member of role ebmr_app',
        ]);
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
      expect(await segregationProblems(db.app)).toEqual([]);
    } finally {
      await db.drop();
    }
  });

  it('[DI-17][DI-30][PR-20] the application roles ebmr_app and ebmr_sandbox may hold every connection slot of the cluster but the listener\'s share; the listener roles are not limited', async () => {
    const { rows } = await onServer((s) =>
      s.query<{ rolname: string; limit: number; slots: number }>(
        `select r.rolname, r.rolconnlimit as limit,
                current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int
                  - coalesce(current_setting('reserved_connections', true), '0')::int as slots
           from pg_roles r where r.rolname in ('ebmr_app', 'ebmr_sandbox', 'ebmr_listener', 'ebmr_sandbox_listener') order by 1`,
      ),
    );
    const slots = rows[0]?.slots ?? 0;
    expect(slots).toBeGreaterThan(LISTENER_SHARE);
    expect(rows.map((r) => [r.rolname, r.limit])).toEqual([
      ['ebmr_app', slots - LISTENER_SHARE],
      ['ebmr_listener', -1],
      ['ebmr_sandbox', slots - LISTENER_SHARE],
      ['ebmr_sandbox_listener', -1],
    ]);
  });

  it('[DI-05][INV-18][DI-17] in a sandbox the GMP listener cannot connect, and an upgrade gives ebmr_sandbox_listener exactly the privileges a migration grants ebmr_listener, and takes back any extra one', async () => {
    const name = sandboxTestName();
    created.push(name);
    await provisionSandboxDatabase({ adminUrl: ADMIN_URL, database: name, sources: editionMigrationSources() });
    expect(await attempt(name, LISTENER_LOGIN)).toMatch(/permission denied for database/);
    expect(await attempt(name, SANDBOX_LISTENER_LOGIN)).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-0980-'));
    dirs.push(dir);
    writeFileSync(
      join(dir, '0001_listener_probe.sql'),
      `create schema k0980 authorization ebmr_owner;
       set local role ebmr_owner;
       create table k0980.t (a int);
       create function k0980.f() returns int language sql as 'select 7';
       grant usage on schema k0980 to ebmr_listener, ebmr_app;
       grant execute on function k0980.f() to ebmr_listener;
       grant select on k0980.t to ebmr_app;
       reset role;`,
    );
    const sources = [...editionMigrationSources(), { namespace: 'k0980-probe', directory: dir }];
    const listener = openPool({ connectionString: urlFor(name, SANDBOX_LISTENER_LOGIN), max: 1 });
    try {
      const report = await upgradeSandboxDatabase({ adminUrl: ADMIN_URL, database: name, sources });
      // ebmr_sandbox: schema USAGE and table SELECT; ebmr_sandbox_listener: schema USAGE and routine EXECUTE.
      expect(report.privilegeChanges).toBe(4);
      expect((await listener.query<{ f: number }>('select k0980.f() as f')).rows).toEqual([{ f: 7 }]);
      await expect(listener.query('select * from k0980.t')).rejects.toThrow(/permission denied/);
      expect(await asAdmin(name, segregationProblems)).toEqual([]);
      // Given by hand, reported; the next upgrade takes it back.
      await asAdmin(name, (c) => c.query('grant select on k0980.t to ebmr_sandbox_listener'));
      expect(await asAdmin(name, segregationProblems)).toEqual(['ebmr_sandbox_listener holds beyond the listener role SELECT on table k0980.t']);
      expect(await upgradeSandboxDatabase({ adminUrl: ADMIN_URL, database: name, sources })).toMatchObject({ applied: [], privilegeChanges: 1 });
      await expect(listener.query('select * from k0980.t')).rejects.toThrow(/permission denied/);
      expect(await asAdmin(name, segregationProblems)).toEqual([]);
    } finally {
      await endPool(listener);
    }
  }, 240_000);
});
