/**
 * The installation marker in a GMP database (DI-05, INV-18): set once at provisioning, never changed,
 * checked by every GMP-issuing path; a GMP database refuses reserved sandbox identifiers and is closed
 * to the sandbox login role.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { assertInstallationKind, readInstallationKind, readInstallationStamp } from '../../src/sandbox/installation.ts';
import { applyConnectPolicy, segregationProblems, upgradeSandboxDatabase } from '../../src/sandbox/provision.ts';
import { ADMIN_URL, createTestDatabase, type TestDatabase } from '../support/db.ts';
import { APP_LOGIN, AUTHN_LOGIN, SANDBOX_LOGIN, asAdmin, attempt, dropDatabase, editionMigrationSources, onServer, uniqueSuffix } from './helpers.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

const kindNow = async (): Promise<string | undefined> => (await db.admin.query<{ kind: string }>('select kind from sandbox.installation')).rows[0]?.kind;

describe('installation marker in a GMP database', () => {
  it('[DI-05][INV-18] a GMP database is marked GMP; GMP-issuing paths pass, sandbox-only paths are refused, and nothing is watermarked', async () => {
    expect(await readInstallationKind(db.app)).toBe('GMP');
    expect(await readInstallationStamp(db.app)).toEqual({ installationKind: 'GMP', watermark: null });
    await expect(assertInstallationKind(db.app, 'GMP')).resolves.toBeUndefined();
    await expect(assertInstallationKind(db.app, 'SANDBOX')).rejects.toThrow(/expects a SANDBOX database but is connected to a GMP database.*EBMR-SBX-007/);
    await expect(db.app.query("select sandbox.assert_gmp_installation('Batch release')")).resolves.toBeDefined();
    await expect(db.app.query("select sandbox.assert_sandbox_installation('Seeding a review-by-exception challenge')")).rejects.toThrow(
      'Seeding a review-by-exception challenge is allowed only in the sandbox (the test, training and simulation store); this is a GMP database (DI-05, INV-18). [EBMR-SBX-011]',
    );
    const { rows } = await db.app.query<{ kind: string; marked_by: string; marked_at: Date }>('select kind, marked_by, marked_at from sandbox.installation');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('GMP');
    expect(rows[0]?.marked_by).not.toBe('');
  });

  it('[INV-18] a GMP batch is issued only from CURRENT or BRIDGING versions (the last check at issue)', async () => {
    await expect(db.app.query("select sandbox.assert_batch_issue_allowed(array['CURRENT', 'BRIDGING'])")).resolves.toBeDefined();
    await expect(db.app.query("select sandbox.assert_batch_issue_allowed(array['CURRENT', 'IN_VERIFICATION'])")).rejects.toThrow(
      /only from an MBR version that is CURRENT or BRIDGING for every market of the batch; found IN_VERIFICATION\..*\[EBMR-SBX-012\]/,
    );
  });

  it('[INV-18] the GMP marker can never become SANDBOX: update, delete, truncate and a second row are refused for a superuser and the table owner', async () => {
    await expect(db.admin.query("update sandbox.installation set kind = 'SANDBOX'")).rejects.toThrow(
      'The installation kind is permanent (update refused): a sandbox never becomes a GMP database and a GMP database never becomes a sandbox (DI-05, INV-18). [EBMR-SBX-002]',
    );
    await expect(db.admin.query('delete from sandbox.installation')).rejects.toThrow(/delete refused.*EBMR-SBX-002/);
    await expect(db.admin.query('truncate sandbox.installation')).rejects.toThrow(/truncate refused.*EBMR-SBX-002/);
    await expect(db.admin.query("insert into sandbox.installation (singleton, kind, database_name) values (true, 'SANDBOX', 'x')")).rejects.toThrow(/EBMR-SBX-003/);
    const owner = await db.admin.connect();
    try {
      await owner.query('begin');
      await owner.query('set local role ebmr_owner');
      await expect(owner.query("update sandbox.installation set kind = 'SANDBOX'")).rejects.toThrow(/EBMR-SBX-002/);
    } finally {
      await owner.query('rollback');
      owner.release();
    }
    await expect(db.app.query("update sandbox.installation set kind = 'SANDBOX'")).rejects.toThrow(/permission denied/);
    await expect(db.app.query("insert into sandbox.installation (kind, database_name) values ('SANDBOX', 'x')")).rejects.toThrow(/permission denied/);
    expect(await kindNow()).toBe('GMP');
  });

  it('[DI-05][INV-18] a GMP database refuses reserved sandbox identifiers, through the check function and on a table guarded by sandbox.guard_identifier', async () => {
    await db.admin.query(`
      create schema a4_probe;
      create table a4_probe.lot (id uuid primary key default gen_random_uuid(), lot_number text not null, supplier_lot text);
      create trigger zz_reserved_identifiers before insert or update on a4_probe.lot
        for each row execute function sandbox.guard_identifier('LOT_NUMBER', 'lot_number', 'supplier_lot');
      grant usage on schema a4_probe to ebmr_app;
      grant select, insert, update on a4_probe.lot to ebmr_app;`);
    await expect(db.app.query("insert into a4_probe.lot (lot_number, supplier_lot) values ('L2409-0017', 'SUP-88')")).resolves.toBeDefined();
    await expect(db.app.query("insert into a4_probe.lot (lot_number) values ('TEST-L24-0001')")).rejects.toThrow(
      '"TEST-L24-0001" is a reserved test lot number (prefix TEST-): a GMP database never accepts sandbox, training or simulation identifiers (DI-05, INV-18). [EBMR-SBX-021]',
    );
    await expect(db.app.query("insert into a4_probe.lot (lot_number, supplier_lot) values ('L2409-0018', ' test-sup')")).rejects.toThrow(/EBMR-SBX-021/);
    await expect(db.app.query("update a4_probe.lot set lot_number = 'ＴＥＳＴ－L1' where lot_number = 'L2409-0017'")).rejects.toThrow(/EBMR-SBX-021/);
    expect((await db.app.query('select lot_number from a4_probe.lot')).rows).toEqual([{ lot_number: 'L2409-0017' }]);

    await expect(db.app.query("select sandbox.assert_identifier_allowed('BATCH_NUMBER', 'TEST-B24-0001')")).rejects.toThrow(/reserved test batch number.*EBMR-SBX-021/);
    await expect(db.app.query("select sandbox.assert_identifier_allowed('PERSON_LABEL', 'test-asha.rao')")).rejects.toThrow(/reserved test person label/);
    await expect(db.app.query("select sandbox.assert_identifier_allowed('DEVICE_LABEL', 'TEST-SCALE-01')")).rejects.toThrow(/reserved test device label/);
    const { rows } = await db.app.query<{ p: string | null }>("select sandbox.identifier_problem('BATCH_NUMBER', 'B24-0001') as p");
    expect(rows[0]?.p).toBeNull();
  });

  it('[DI-05] a misconfigured identifier guard (no column, a missing column, an unknown kind) refuses every write: it fails closed', async () => {
    await db.admin.query('create table a4_probe.device (code text)');
    await db.admin.query("create trigger t1 before insert on a4_probe.device for each row execute function sandbox.guard_identifier('DEVICE_LABEL')");
    await expect(db.admin.query("insert into a4_probe.device values ('SCALE-01')")).rejects.toThrow(/must name an identifier kind and at least one column.*EBMR-SBX-023/);
    await db.admin.query('drop trigger t1 on a4_probe.device');
    await db.admin.query("create trigger t2 before insert on a4_probe.device for each row execute function sandbox.guard_identifier('DEVICE_LABEL', 'device_code')");
    await expect(db.admin.query("insert into a4_probe.device values ('SCALE-01')")).rejects.toThrow(/names column device_code.*EBMR-SBX-023/);
    await db.admin.query('drop trigger t2 on a4_probe.device');
    await db.admin.query("create trigger t3 before insert on a4_probe.device for each row execute function sandbox.guard_identifier('SERIAL_NUMBER', 'code')");
    await expect(db.admin.query("insert into a4_probe.device values ('SCALE-01')")).rejects.toThrow(/Unknown identifier kind SERIAL_NUMBER.*EBMR-SBX-020/);
  });

  it('[INV-18] the migrated database is closed to the sandbox role; a template copy loses database privileges until the connect policy is re-applied', async () => {
    // The template was built by the migrations themselves (kernel 0800 applies the policy).
    const template = inject('templateDb');
    const onTemplate = await onServer(async (s) =>
      (
        await s.query<{ r: string; c: boolean }>(
          "select r, has_database_privilege(r, $1, 'CONNECT') as c from unnest(array['ebmr_sandbox', 'ebmr_app', 'ebmr_authn', 'ebmr_listener', 'ebmr_sandbox_listener']) r order by r",
          [template],
        )
      ).rows,
    );
    // Kernel 0980: the listener role of the database's kind may connect, the sandbox's may not.
    expect(onTemplate).toEqual([
      { r: 'ebmr_app', c: true },
      { r: 'ebmr_authn', c: true },
      { r: 'ebmr_listener', c: true },
      { r: 'ebmr_sandbox', c: false },
      { r: 'ebmr_sandbox_listener', c: false },
    ]);
    // CREATE DATABASE ... TEMPLATE does not copy database privileges, so a copy starts open to PUBLIC (the test
    // harness re-applies the policy for every test database; undo that here to show the invariant query reports it).
    await db.admin.query(`grant connect on database ${db.name} to public`);
    expect(await segregationProblems(db.app)).toEqual([
      `ebmr_sandbox can connect to the GMP database ${db.name}`,
      `ebmr_sandbox_listener can connect to the GMP database ${db.name}`,
    ]);
    await applyConnectPolicy(db.admin);
    expect(await segregationProblems(db.app)).toEqual([]);
    expect(await attempt(db.name, SANDBOX_LOGIN)).toMatch(/permission denied for database/);
    expect(await attempt(db.name, APP_LOGIN)).toBeNull();
    expect(await attempt(db.name, AUTHN_LOGIN)).toBeNull();
  });

  it('[DI-05][INV-18] a copy of a GMP database under a sandbox name reports no installation kind, so it serves as neither GMP nor sandbox', async () => {
    const copy = `ebmr_sandbox_cp${uniqueSuffix()}`;
    await onServer((s) => s.query(`create database ${copy} template ${inject('templateDb')}`));
    try {
      await asAdmin(copy, async (c) => {
        await expect(c.query('select kernel.installation_kind()')).rejects.toThrow(
          `Database ${copy} is marked GMP but its name says otherwise (a copy or restore under the wrong name); it is refused as both GMP and sandbox (DI-05, INV-18). [EBMR-SBX-004]`,
        );
        await expect(c.query("select sandbox.assert_gmp_installation('Batch release')")).rejects.toThrow(/EBMR-SBX-004/);
        const problems = await segregationProblems(c);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/^installation marker: .*EBMR-SBX-004/);
      });
      // The sandbox tooling will not adopt it either.
      await expect(upgradeSandboxDatabase({ adminUrl: ADMIN_URL, database: copy, sources: editionMigrationSources() })).rejects.toThrow(/EBMR-SBX-004/);
    } finally {
      await dropDatabase(copy);
    }
  });
});
