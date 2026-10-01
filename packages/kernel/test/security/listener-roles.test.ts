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
 *
 * Final verification of that item (listener-credential-bound; decisions X36, X39, X41): a holder of the listener's own
 * credentials had no connection limit at all, so it could take every slot of the cluster or load the database with as
 * many connections as it liked. Each listener role is now limited to the listener's share (8 for one listener; a cluster
 * running more declares more), the same share its application role leaves free (kernel.apply_listener_share).
 *
 * The limits as the cluster stands cannot show that migrating a database applies the share: the server tests' global
 * setup declares a share of its own before any test file runs (apps/tablets-server/test/support/global-setup.ts), and a
 * development cluster keeps what earlier runs set. So a database the previous kernel version left is migrated to 0980
 * here twice. First kernel 0980 as written runs on a cluster none of whose four roles has a limit, as on a fresh one, in
 * a transaction rolled back at the end: the exact values must come out, one listener's share (8) on each listener role
 * and the cluster's slots less 8 on each application role, whatever share the cluster holds and whatever any set-up
 * declared. Then the migration is applied with each listener role holding a share of its own and both application
 * roles unlimited: each share is kept and each application role levelled with it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { KERNEL_MIGRATIONS, migrate } from '../../src/db/migrate.ts';
import { provisionSandboxDatabase, segregationProblems, upgradeSandboxDatabase } from '../../src/sandbox/provision.ts';
import { endPool, openPool } from '../harness/pools.ts';
import { ADMIN_URL, createTestDatabase, urlFor } from '../support/db.ts';
import { asAdmin, attempt, dropDatabase, editionMigrationSources, onServer, sandboxTestName, uniqueSuffix } from '../sandbox/helpers.ts';

const LISTENER_LOGIN = { name: 'ebmr_listener', password: 'ebmr_listener' };
const SANDBOX_LISTENER_LOGIN = { name: 'ebmr_sandbox_listener', password: 'ebmr_sandbox_listener' };
/** One listener's share of the cluster's connections: what kernel 0980 sets where none was declared. */
const LISTENER_SHARE = 8;
/** Each application role and the listener role whose share it leaves free. */
const PAIRS = [['ebmr_app', 'ebmr_listener'], ['ebmr_sandbox', 'ebmr_sandbox_listener']] as const;
/** The kernel migrations before 0980 (every file is named NNNN_...): a database as the previous version left it. */
const BEFORE_0980 = /^0(?:[0-8]\d\d|9[0-7]\d)_/;
/** Kernel 0980 as the migration runner applies it (packages/kernel/src/db/migrate.ts runs a file's text as it is). */
const MIGRATION_0980 = '0980_listener_login_roles.sql';

/** The connection limits of the application and listener roles (by name, -1: none), and the cluster's slots for roles that are not superusers. */
interface Limits {
  slots: number;
  of: Record<string, number>;
}

async function limits(c: Pick<pg.Client, 'query'>): Promise<Limits> {
  const { rows } = await c.query<{ rolname: string; limit: number; slots: number }>(
    `select r.rolname, r.rolconnlimit as limit,
            current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int
              - coalesce(current_setting('reserved_connections', true), '0')::int as slots
       from pg_roles r where r.rolname in ('ebmr_app', 'ebmr_sandbox', 'ebmr_listener', 'ebmr_sandbox_listener') order by 1`,
  );
  return { slots: rows[0]?.slots ?? 0, of: Object.fromEntries(rows.map((r) => [r.rolname, r.limit])) };
}

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

  it('[DI-17][DI-30][PR-20] each listener role is limited to the listener\'s share and its application role (ebmr_app, ebmr_sandbox) to the cluster\'s slots less that share; where no share was declared it is one listener\'s (8), a declared one is kept, and a share below 8 or one that leaves the application role no slot is refused', async () => {
    // As the cluster stands: each pair levelled. Not the exact values kernel 0980 gives, since a test cluster declares a
    // larger share (apps/tablets-server/test/support/global-setup.ts) before any test file runs; those are required of
    // the migration itself in the next test.
    const now = await onServer((s) => limits(s));
    for (const [app, listener] of PAIRS) {
      const share = now.of[listener] ?? -1;
      expect(share, listener).toBeGreaterThanOrEqual(LISTENER_SHARE);
      expect(now.of[app], app).toBe(now.slots - share);
    }

    // What kernel 0980 does, in a transaction rolled back at the end (role attributes are cluster-wide).
    const db = await createTestDatabase();
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      const slots = (await limits(c)).slots;
      expect(slots).toBeGreaterThan(LISTENER_SHARE);
      // A cluster migrated before this round: no limit on either listener role (one even below a listener's need).
      await c.query('alter role ebmr_listener connection limit -1');
      await c.query('alter role ebmr_sandbox_listener connection limit 3');
      await c.query('select kernel.apply_listener_share()');
      expect((await limits(c)).of).toEqual({
        ebmr_app: slots - LISTENER_SHARE,
        ebmr_listener: LISTENER_SHARE,
        ebmr_sandbox: slots - LISTENER_SHARE,
        ebmr_sandbox_listener: LISTENER_SHARE,
      });
      // A share declared for a cluster running three GMP listeners is kept by the next migration.
      await c.query('select kernel.apply_listener_share(24)');
      await c.query('alter role ebmr_sandbox_listener connection limit 8');
      await c.query('select kernel.apply_listener_share()');
      expect((await limits(c)).of).toEqual({ ebmr_app: slots - 24, ebmr_listener: 24, ebmr_sandbox: slots - 8, ebmr_sandbox_listener: 8 });
      // Refused: fewer than one listener needs; more than leaves the application role a slot.
      await c.query('savepoint s');
      // The message says what the 8 are: the 5 connections the listener keeps and 3 spare (decision X41).
      await expect(c.query('select kernel.apply_listener_share(7)')).rejects.toThrow(
        /at least 8 \(the 5 connections it keeps open and 3 spare to replace lost ones\), so 7 is too few .*\[EBMR-SBX-037\]$/,
      );
      await c.query('rollback to savepoint s');
      await expect(c.query('select kernel.apply_listener_share($1)', [slots])).rejects.toThrow(/too few to keep \d+ free for the evidence listener.*\[EBMR-SBX-036\]$/);
      await c.query('rollback to savepoint s');
      // Only a superuser alters roles: the application role may not even call it.
      expect((await c.query<{ ok: boolean }>("select has_function_privilege('ebmr_app', 'kernel.apply_listener_share(integer)', 'EXECUTE') as ok")).rows).toEqual([{ ok: false }]);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
      await db.drop();
    }
    expect(await onServer((s) => limits(s))).toEqual(now);
  });

  it('[DI-17][DI-30][PR-20] migrating a database to kernel 0980 applies the listener\'s share itself: on a cluster none of whose four roles has a limit (a fresh one) it gives each listener role exactly one listener\'s share (8) and each application role exactly the cluster\'s slots less 8; with each listener role holding a share of its own and the application roles no limit, it keeps each share and limits each application role to the cluster\'s slots less its own listener role\'s share', async () => {
    const name = `ebmr_t_${uniqueSuffix()}`;
    await onServer((s) => s.query(`create database "${name}"`));
    try {
      // The database as the previous kernel version left it.
      await asAdmin(name, (c) => migrate(c, [{ ...KERNEL_MIGRATIONS, include: BEFORE_0980 }]));
      const before = await onServer((s) => limits(s));
      for (const [app, listener] of PAIRS) {
        expect(before.of[listener], listener).toBeGreaterThanOrEqual(LISTENER_SHARE);
        expect(before.of[app], app).toBe(before.slots - (before.of[listener] ?? 0));
      }

      // Kernel 0980 as written, on a cluster none of whose four roles has a limit, gives exact values: one listener's
      // share on each listener role and the cluster's slots less it on each application role, whatever share this
      // cluster holds now or a set-up declared. Twice, each from a savepoint: on a fresh cluster, where the listener roles
      // do not exist yet (the migration creates them; here they are renamed aside, since other databases of the cluster
      // hold privileges for them and they cannot be dropped), and on one whose four roles exist with no limit. In a
      // transaction rolled back at the end: role attributes are cluster-wide, and an uncommitted change reaches no other
      // session.
      const sql0980 = readFileSync(join(KERNEL_MIGRATIONS.directory, MIGRATION_0980), 'utf8');
      const aside = (role: string): string => `t_aside_${uniqueSuffix()}_${role === 'ebmr_listener' ? 'gmp' : 'sbx'}`;
      const runs = await asAdmin(name, async (c) => {
        const run0980 = async (setUp: string): Promise<{ unmigrated: Limits; migrated: Limits }> => {
          await c.query('savepoint before_0980');
          await c.query(setUp);
          const unmigrated = await limits(c);
          await c.query(sql0980);
          const migrated = await limits(c);
          await c.query('rollback to savepoint before_0980');
          return { unmigrated, migrated };
        };
        await c.query('begin');
        try {
          // pg_authid's lock first, as kernel 0980 takes it, so a test changing roles beside this one waits, not deadlocks.
          await c.query('lock table pg_catalog.pg_authid in share row exclusive mode');
          const pending = (await c.query('select 1 from public.schema_migration where namespace = $1 and name = $2', ['kernel', MIGRATION_0980])).rows.length;
          const fresh = await run0980(
            PAIRS.map(([app, listener]) => `alter role ${app} connection limit -1; alter role ${listener} rename to ${aside(listener)};`).join(' '),
          );
          const unlimited = await run0980(PAIRS.flat().map((role) => `alter role ${role} connection limit -1;`).join(' '));
          return { pending, fresh, unlimited };
        } finally {
          await c.query('rollback');
        }
      });
      const exact = { slots: before.slots, of: { ebmr_app: before.slots - LISTENER_SHARE, ebmr_listener: LISTENER_SHARE, ebmr_sandbox: before.slots - LISTENER_SHARE, ebmr_sandbox_listener: LISTENER_SHARE } };
      expect(runs.pending, 'kernel 0980 not yet applied to the database').toBe(0);
      expect(runs.fresh.unmigrated.of).toEqual({ ebmr_app: -1, ebmr_sandbox: -1 });
      expect(runs.fresh.migrated, 'a fresh cluster').toEqual(exact);
      expect(runs.unlimited.unmigrated.of).toEqual({ ebmr_app: -1, ebmr_listener: -1, ebmr_sandbox: -1, ebmr_sandbox_listener: -1 });
      expect(runs.unlimited.migrated, 'a cluster whose four roles have no limit').toEqual(exact);
      expect(await onServer((s) => limits(s)), 'the cluster after the rolled-back runs').toEqual(before);

      // Shares above what the cluster holds (the set-ups' own migrations may already have applied a share), different
      // for each kind, and both application roles unlimited, as on a cluster none of whose databases was migrated to 0980
      // yet. Only until the limits are put back, and harmless to the tests running beside this one: the listener roles
      // may open more connections than before, the application roles at most two fewer, and a migration of theirs in
      // the meantime keeps these shares and levels the application roles with them.
      const share = { ebmr_listener: (before.of['ebmr_listener'] ?? 0) + 1, ebmr_sandbox_listener: (before.of['ebmr_sandbox_listener'] ?? 0) + 2 };
      try {
        await onServer((s) =>
          s.query(
            `begin; alter role ebmr_listener connection limit ${String(share.ebmr_listener)};
                    alter role ebmr_sandbox_listener connection limit ${String(share.ebmr_sandbox_listener)};
                    alter role ebmr_app connection limit -1; alter role ebmr_sandbox connection limit -1; commit`,
          ),
        );
        const applied = await asAdmin(name, (c) => migrate(c, [KERNEL_MIGRATIONS]));
        expect(applied.map((m) => m.name)).toContain('0980_listener_login_roles.sql');
        expect((await onServer((s) => limits(s))).of).toEqual({
          ebmr_app: before.slots - share.ebmr_listener,
          ebmr_listener: share.ebmr_listener,
          ebmr_sandbox: before.slots - share.ebmr_sandbox_listener,
          ebmr_sandbox_listener: share.ebmr_sandbox_listener,
        });
      } finally {
        // The cluster is shared with every other test: its limits as they were, in one transaction.
        await onServer((s) =>
          s.query(`begin; ${Object.entries(before.of).map(([role, limit]) => `alter role ${role} connection limit ${String(limit)};`).join(' ')} commit`),
        );
      }
    } finally {
      await dropDatabase(name);
    }
  }, 120_000);

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
