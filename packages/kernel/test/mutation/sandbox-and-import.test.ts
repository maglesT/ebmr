/**
 * The installation marker, the reserved-identifier and batch-issue checks and the installation bootstrap, guard by
 * guard (SQL mutation group "sandbox-and-import": sandbox.guard_installation, kernel.installation_kind,
 * sandbox.identifier_problem_for, sandbox.batch_issue_problem_for in kernel 0800 and 0810, iam.bootstrap_installation
 * in kernel 1000). The scenario tests in sandbox/*.test.ts provision their sandboxes from the migration files and test
 * the marker only where one is present; these tests run in a copy of the migrated template and reach each refusal
 * where the database enforces it:
 *  - a database whose marker is missing (a data-only restore without it) is neither GMP nor sandbox: every check that
 *    reads the kind refuses (EBMR-SBX-001), and the marker written again must agree with the database name
 *    (EBMR-SBX-004);
 *  - the identifier and batch-issue checks know only the installation kinds GMP and SANDBOX (EBMR-SBX-020);
 *  - an installation is bootstrapped once (EBMR-IAM-190), and a second bootstrap writes nothing.
 * The sandbox side (a sandbox refusing a GMP-issuing path) is tested in the server project's file of the same name,
 * where a provisioned sandbox carries the mutant.
 *
 * Controls: DI-05 (segregation of non-GMP functions), INV-18 (a GMP record only from a GMP installation), DI-16 and
 * DI-17 (accounts and grants only through the recorded grant life cycle).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../../src/identity/secrets.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

/** The message a promise is rejected with, or 'ACCEPTED'. */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ACCEPTED';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const markers = async (): Promise<{ kind: string; database_name: string }[]> =>
  (await db.admin.query<{ kind: string; database_name: string }>('select kind, database_name from sandbox.installation')).rows;

describe('the reserved-identifier and batch-issue checks know two installation kinds only (kernel 0810)', () => {
  it('[DI-05][INV-18] sandbox.identifier_problem_for refuses an installation kind other than GMP or SANDBOX, and a missing one (EBMR-SBX-020)', async () => {
    for (const kind of ['TRAINING', 'gmp', 'SANDBOX ', '']) {
      expect([kind, await refusal(db.app.query('select sandbox.identifier_problem_for($1, $2, $3)', [kind, 'BATCH_NUMBER', 'B24-0001']))]).toEqual([
        kind,
        `Unknown installation kind ${kind}: expected GMP or SANDBOX (DI-05). [EBMR-SBX-020]`,
      ]);
    }
    expect(await refusal(db.app.query('select sandbox.identifier_problem_for(null, $1, $2)', ['LOT_NUMBER', 'TEST-L24-0001']))).toBe(
      'Unknown installation kind null: expected GMP or SANDBOX (DI-05). [EBMR-SBX-020]',
    );
    // The two kinds the check knows give their own answers for the same value.
    const { rows } = await db.app.query<{ gmp: string | null; sandbox: string | null }>(
      "select sandbox.identifier_problem_for('GMP', 'BATCH_NUMBER', 'B24-0001') as gmp, sandbox.identifier_problem_for('SANDBOX', 'BATCH_NUMBER', 'B24-0001') as sandbox",
    );
    expect(rows[0]?.gmp).toBeNull();
    expect(rows[0]?.sandbox).toMatch(/^"B24-0001" is not a test batch number: .*\[EBMR-SBX-022\]$/);
  });

  it('[DI-05][INV-18] sandbox.batch_issue_problem_for refuses an installation kind other than GMP or SANDBOX, and a missing one (EBMR-SBX-020)', async () => {
    for (const kind of ['TRAINING', 'sandbox', '']) {
      expect([kind, await refusal(db.app.query("select sandbox.batch_issue_problem_for($1, array['CURRENT'])", [kind]))]).toEqual([
        kind,
        `Unknown installation kind ${kind}: expected GMP or SANDBOX (DI-05). [EBMR-SBX-020]`,
      ]);
    }
    expect(await refusal(db.app.query("select sandbox.batch_issue_problem_for(null, array['IN_VERIFICATION'])"))).toBe(
      'Unknown installation kind null: expected GMP or SANDBOX (DI-05). [EBMR-SBX-020]',
    );
    const { rows } = await db.app.query<{ gmp: string | null; sandbox: string | null }>(
      "select sandbox.batch_issue_problem_for('GMP', array['CURRENT']) as gmp, sandbox.batch_issue_problem_for('SANDBOX', array['IN_VERIFICATION']) as sandbox",
    );
    expect(rows[0]).toEqual({ gmp: null, sandbox: null });
  });
});

describe('the installation is bootstrapped once (kernel 1000)', () => {
  const fingerprint = (): string => randomBytes(32).toString('hex');
  const suffix = (): string => randomBytes(4).toString('hex');
  const bootstrap = async (admin: [string, string], owner: [string, string]) =>
    db.admin.query('select iam.bootstrap_installation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [
      admin[0], admin[1], await hashSecret(`Initial-${suffix()}-a`), fingerprint(),
      owner[0], owner[1], await hashSecret(`Initial-${suffix()}-o`), fingerprint(),
      'SITE-1', 'IQ-MUT-001', null,
    ]);
  const written = async () =>
    (
      await db.admin.query<{ persons: string; accounts: string; devices: string; grants: string; logins: string }>(
        `select (select count(*) from iam.person)::text as persons, (select count(*) from iam.account)::text as accounts,
                (select count(*) from iam.device)::text as devices, (select count(*) from iam.role_grant)::text as grants,
                (select string_agg(identifier, ',' order by identifier) from iam.issued_identifier) as logins`,
      )
    ).rows[0];

  it('[DI-16][DI-17] once the first administrator and process owner hold their grants, a second bootstrap is refused (EBMR-IAM-190) and writes nothing', async () => {
    const first = [`admin-${suffix()}`, `owner-${suffix()}`] as const;
    await bootstrap(['Seed Administrator', first[0]], ['Seed Process Owner', first[1]]);
    const after = await written();
    expect(after).toEqual({ persons: '3', accounts: '2', devices: '2', grants: '2', logins: [...first].sort().join(',') });
    // New names and new consoles, so nothing but the bootstrap's own rule could refuse it.
    expect(await refusal(bootstrap(['Second Administrator', `admin-${suffix()}`], ['Second Process Owner', `owner-${suffix()}`]))).toBe(
      'EBMR-IAM-190 the installation is already bootstrapped',
    );
    expect(await written()).toEqual(after);
  });
});

describe('a database without its installation marker (kernel 0800)', () => {
  it('[DI-05][INV-18] is neither GMP nor sandbox: reading the kind, a GMP-issuing path, a sandbox-only path and the watermark all refuse (EBMR-SBX-001)', async () => {
    // A data-only restore that left the marker out: the guard trigger refuses a delete, so the restore's own
    // replication mode stands in for it here.
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query('delete from sandbox.installation');
      await c.query('commit');
    } finally {
      c.release();
    }
    expect(await markers()).toEqual([]);
    const noMarker =
      'This database has no installation marker, so it is neither a GMP nor a sandbox installation; provision it before use (DI-05, INV-18). [EBMR-SBX-001]';
    expect(await refusal(db.app.query('select kernel.installation_kind()'))).toBe(noMarker);
    expect(await refusal(db.app.query("select sandbox.assert_gmp_installation('Batch release')"))).toBe(noMarker);
    expect(await refusal(db.app.query("select sandbox.assert_sandbox_installation('Seeding a review-by-exception challenge')"))).toBe(noMarker);
    expect(await refusal(db.app.query('select sandbox.watermark()'))).toBe(noMarker);
    expect(await refusal(db.app.query("select sandbox.assert_batch_issue_allowed(array['CURRENT'])"))).toBe(noMarker);
  });

  it('[DI-05][INV-18] the marker written again must agree with the database name: SANDBOX under a GMP name is refused (EBMR-SBX-004) and nothing is written; GMP is written with this database name', async () => {
    expect(await markers()).toEqual([]);
    expect(await refusal(db.admin.query("insert into sandbox.installation (kind, database_name) values ('SANDBOX', 'ebmr_sandbox_tablets')"))).toBe(
      `Database ${db.name} cannot be marked SANDBOX: a sandbox database must be named ebmr_sandbox_<edition>, and no GMP database may use that name (DI-05, INV-18). [EBMR-SBX-004]`,
    );
    expect(await markers()).toEqual([]);
    // The kind that agrees with the name is accepted, and the row names this database whatever the writer said.
    await db.admin.query("insert into sandbox.installation (kind, database_name) values ('GMP', 'another_database')");
    expect(await markers()).toEqual([{ kind: 'GMP', database_name: db.name }]);
    expect((await db.app.query<{ kind: string }>('select kernel.installation_kind() as kind')).rows[0]?.kind).toBe('GMP');
    await expect(db.app.query("select sandbox.assert_gmp_installation('Batch release')")).resolves.toBeDefined();
    expect(await refusal(db.admin.query("insert into sandbox.installation (kind, database_name) values ('GMP', 'x')"))).toMatch(/EBMR-SBX-003\]$/);
  });
});
