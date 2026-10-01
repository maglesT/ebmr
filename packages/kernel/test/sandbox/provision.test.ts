/**
 * Provisioning and upgrading the sandbox database (DI-05, INV-18; ADR 0001 item 2): a separate
 * database, built from the same migrations as the GMP database, marked SANDBOX at creation, closed to
 * the GMP roles, never left half-built, and never adopted when it is not a sandbox.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { KERNEL_MIGRATIONS, migrate } from '../../src/db/migrate.ts';
import { sandboxDatabaseName } from '../../src/sandbox/installation.ts';
import { provisionSandboxDatabase, segregationProblems, upgradeSandboxDatabase } from '../../src/sandbox/provision.ts';
import { endPool, openPool } from '../harness/pools.ts';
import { ADMIN_URL, createTestDatabase, urlFor } from '../support/db.ts';
import { SANDBOX_LOGIN, asAdmin, databaseExists, dropDatabase, editionMigrationSources, onServer, sandboxTestName, uniqueSuffix } from './helpers.ts';

const created: string[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const name of created) await dropDatabase(name);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function migrationDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ebmr-a4-'));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

const LONG = 240_000;

describe('provisioning the sandbox database', () => {
  it('[DI-05] a sandbox is named ebmr_sandbox_<edition>; any other name is refused before anything is created', async () => {
    expect(sandboxDatabaseName('tablets')).toBe('ebmr_sandbox_tablets');
    expect(() => sandboxDatabaseName('Tablets')).toThrow(/EBMR-SBX-006/);
    expect(() => sandboxDatabaseName('tablets;drop')).toThrow(/EBMR-SBX-006/);
    for (const database of ['ebmr_tablets', 'sandbox_tablets', 'ebmr_sandbox_Tablets', 'ebmr_sandbox_', 'ebmr_sandbox_1x']) {
      await expect(provisionSandboxDatabase({ adminUrl: ADMIN_URL, database, sources: editionMigrationSources() }), database).rejects.toThrow(/EBMR-SBX-006/);
      await expect(upgradeSandboxDatabase({ adminUrl: ADMIN_URL, database, sources: editionMigrationSources() }), database).rejects.toThrow(/EBMR-SBX-006/);
    }
  });

  it(
    '[DI-05][INV-18] provisioning builds a separate database from the same migrations as the GMP database, marks it SANDBOX and closes it to the GMP roles',
    async () => {
      const name = sandboxTestName();
      created.push(name);
      const report = await provisionSandboxDatabase({ adminUrl: ADMIN_URL, database: name, sources: editionMigrationSources() });
      expect(report).toMatchObject({ database: name, installationKind: 'SANDBOX', created: true });
      expect(report.privilegeChanges).toBeGreaterThan(300);

      // Same migrations, same order, as the GMP database (the test template, minus its test fixtures).
      const gmp = await createTestDatabase();
      try {
        const { rows } = await gmp.admin.query<{ id: string }>(
          "select namespace || '/' || name as id from public.schema_migration where namespace <> 'test-fixtures' order by applied_at, namespace, name",
        );
        expect(report.applied.map((m) => `${m.namespace}/${m.name}`)).toEqual(rows.map((r) => r.id));
      } finally {
        await gmp.drop();
      }

      const access = await onServer(async (s) =>
        (
          await s.query<{ r: string; c: boolean }>(
            "select r, has_database_privilege(r, $1, 'CONNECT') as c from unnest(array['ebmr_app', 'ebmr_authn', 'ebmr_sandbox']) r order by r",
            [name],
          )
        ).rows,
      );
      expect(access).toEqual([
        { r: 'ebmr_app', c: false },
        { r: 'ebmr_authn', c: false },
        { r: 'ebmr_sandbox', c: true },
      ]);
      const marker = await asAdmin(name, async (c) => (await c.query<{ kind: string; database_name: string }>('select kind, database_name from sandbox.installation')).rows);
      expect(marker).toEqual([{ kind: 'SANDBOX', database_name: name }]);

      // A copy or restore of the sandbox under any other name reports no kind (used as neither).
      const copy = `ebmr_t_sbxcp${uniqueSuffix()}`;
      await onServer((s) => s.query(`create database ${copy} template ${name}`));
      created.push(copy);
      await asAdmin(copy, async (c) => {
        await expect(c.query('select kernel.installation_kind()')).rejects.toThrow(
          `Database ${copy} is marked SANDBOX but its name says otherwise (a copy or restore under the wrong name); it is refused as both GMP and sandbox (DI-05, INV-18). [EBMR-SBX-004]`,
        );
        await expect(c.query("select sandbox.assert_gmp_installation('Batch release')")).rejects.toThrow(/EBMR-SBX-004/);
      });

      // Provisioning happens once; afterwards only upgrades.
      await expect(provisionSandboxDatabase({ adminUrl: ADMIN_URL, database: name, sources: editionMigrationSources() })).rejects.toThrow(/EBMR-SBX-031/);
      await expect(
        upgradeSandboxDatabase({ adminUrl: ADMIN_URL, database: `ebmr_sandbox_n${uniqueSuffix()}`, sources: editionMigrationSources() }),
      ).rejects.toThrow(/does not exist.*EBMR-SBX-032/);
    },
    LONG,
  );

  it(
    '[INV-18] a failing migration never leaves a half-provisioned sandbox behind',
    async () => {
      const name = sandboxTestName();
      created.push(name);
      const failing = migrationDir({ '0001_fails.sql': 'select 1 / 0;' });
      await expect(
        provisionSandboxDatabase({ adminUrl: ADMIN_URL, database: name, sources: [...editionMigrationSources(), { namespace: 'a4-failing', directory: failing }] }),
      ).rejects.toThrow(/a4-failing\/0001_fails.sql failed: division by zero/);
      expect(await databaseExists(name)).toBe(false);
    },
    LONG,
  );

  it(
    '[INV-18] an upgrade re-levels the sandbox role with the privileges a new migration grants the GMP roles, and takes back any extra one',
    async () => {
      const name = sandboxTestName();
      created.push(name);
      await provisionSandboxDatabase({ adminUrl: ADMIN_URL, database: name, sources: editionMigrationSources() });
      const probe = migrationDir({
        '0001_probe.sql': `
          create schema a4_upgrade authorization ebmr_owner;
          set local role ebmr_owner;
          create table a4_upgrade.t (a int);
          create function a4_upgrade.f() returns int language sql as 'select 42';
          grant usage on schema a4_upgrade to ebmr_app, ebmr_authn;
          grant select, insert on a4_upgrade.t to ebmr_app;
          grant execute on function a4_upgrade.f() to ebmr_authn;
          reset role;`,
      });
      const sources = [...editionMigrationSources(), { namespace: 'a4-probe', directory: probe }];
      const sandbox = openPool({ connectionString: urlFor(name, SANDBOX_LOGIN), max: 1 });
      try {
        const report = await upgradeSandboxDatabase({ adminUrl: ADMIN_URL, database: name, sources });
        expect(report.created).toBe(false);
        expect(report.applied.map((m) => `${m.namespace}/${m.name}`)).toEqual(['a4-probe/0001_probe.sql']);
        expect(report.privilegeChanges).toBe(4); // schema USAGE, table SELECT and INSERT, routine EXECUTE
        await sandbox.query('insert into a4_upgrade.t values (1)');
        expect((await sandbox.query('select a4_upgrade.f() as f, (select count(*)::int from a4_upgrade.t) as n')).rows).toEqual([{ f: 42, n: 1 }]);
        expect(await segregationProblems(sandbox)).toEqual([]);

        // A privilege given to the sandbox role by hand is reported, and the next upgrade takes it back.
        await asAdmin(name, (c) => c.query('grant delete on a4_upgrade.t to ebmr_sandbox'));
        expect(await segregationProblems(sandbox)).toEqual(['ebmr_sandbox holds beyond the application roles DELETE on table a4_upgrade.t']);
        const again = await upgradeSandboxDatabase({ adminUrl: ADMIN_URL, database: name, sources });
        expect(again).toMatchObject({ applied: [], privilegeChanges: 1 });
        await expect(sandbox.query('delete from a4_upgrade.t')).rejects.toThrow(/permission denied/);
        expect(await segregationProblems(sandbox)).toEqual([]);
      } finally {
        await endPool(sandbox);
      }
    },
    LONG,
  );

  it(
    '[INV-18] a migration run whose kind contradicts the database name fails at the marker, so no database is marked against its name',
    async () => {
      const upToSandbox = [{ ...KERNEL_MIGRATIONS, include: /^0[0-8]/ }];
      const cases: { name: string; intent: string | null; expect: RegExp | 'GMP' | 'SANDBOX' }[] = [
        { name: `ebmr_t_a4${uniqueSuffix()}`, intent: 'SANDBOX', expect: /cannot be marked SANDBOX: a sandbox database must be named ebmr_sandbox_<edition>.*EBMR-SBX-004/ },
        { name: `ebmr_sandbox_t${uniqueSuffix()}`, intent: 'GMP', expect: /cannot be marked GMP.*EBMR-SBX-004/ },
        { name: `ebmr_t_a4${uniqueSuffix()}`, intent: 'gmp', expect: /must be GMP or SANDBOX, not gmp.*EBMR-SBX-005/ },
        { name: `ebmr_sandbox_t${uniqueSuffix()}`, intent: null, expect: 'SANDBOX' },
        { name: `ebmr_t_a4${uniqueSuffix()}`, intent: null, expect: 'GMP' },
      ];
      for (const c of cases) {
        created.push(c.name);
        await onServer((s) => s.query(`create database ${c.name}`));
        await asAdmin(c.name, async (client) => {
          if (c.intent !== null) await client.query("select set_config('ebmr.installation_kind', $1, false)", [c.intent]);
          const run = migrate(client, upToSandbox);
          if (c.expect instanceof RegExp) {
            await expect(run, c.name).rejects.toThrow(c.expect);
          } else {
            await run;
            expect((await client.query<{ k: string }>('select kernel.installation_kind() as k')).rows[0]?.k, c.name).toBe(c.expect);
          }
        });
      }
    },
    LONG,
  );
});
