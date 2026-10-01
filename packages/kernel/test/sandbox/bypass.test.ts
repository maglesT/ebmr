/**
 * INV-18 bypass tests (ADR 0012 item 8, prevented class): test, simulation and training data live in
 * a separate database whose login role cannot reach any GMP database, and a sandbox never becomes a
 * GMP database. Also the DI-05 catalog test: from the training store, posting to a production batch
 * or reusing a real lot number is blocked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.ts';
import { assertGmpOrigin, assertInstallationKind, readInstallationKind, readInstallationStamp } from '../../src/sandbox/installation.ts';
import { applyConnectPolicy, provisionSandboxDatabase, segregationProblems } from '../../src/sandbox/provision.ts';
import { WATERMARK_TEXT } from '../../src/sandbox/watermark.ts';
import { ADMIN_URL, createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import { APP_LOGIN, AUTHN_LOGIN, SANDBOX_LOGIN, asAdmin, attempt, editionMigrationSources, provisionTestSandbox, type TestSandbox } from './helpers.ts';
import pg from 'pg';

/** A GMP database as production has it: the connect policy of kernel 0800 in force. */
let gmp: TestDatabase;
/** A GMP database whose CONNECT was left open to PUBLIC (template copies lose database privileges). */
let open: TestDatabase;
let sbx: TestSandbox;

beforeAll(async () => {
  [gmp, open, sbx] = await Promise.all([createTestDatabase(), createTestDatabase(), provisionTestSandbox()]);
  await applyConnectPolicy(gmp.admin);
  // The harness applies the connect policy to every test database; re-open this one to PUBLIC on purpose.
  await open.admin.query(`grant connect on database ${open.name} to public`);
}, 300_000);

afterAll(async () => {
  await Promise.all([gmp?.drop(), open?.drop(), sbx?.drop()]);
});

const GMP_SCHEMAS = ['kernel', 'iam', 'esig', 'market', 'records', 'platform', 'continuity', 'site', 'sandbox', 'recipe', 'testgmp'];

/** Runs each statement on its own under the sandbox role in the open GMP database; returns the error of each. */
async function asSandboxInOpenGmp(statements: string[]): Promise<Record<string, string | null>> {
  const client = new pg.Client({ connectionString: urlFor(open.name, SANDBOX_LOGIN) });
  await client.connect();
  const out: Record<string, string | null> = {};
  try {
    for (const s of statements) {
      try {
        await client.query(s);
        out[s] = null;
      } catch (error) {
        out[s] = (error as Error).message;
      }
    }
  } finally {
    await client.end();
  }
  return out;
}

describe('INV-18: the sandbox cannot reach GMP data (prevented)', () => {
  it('[INV-18][DI-05] from the sandbox role, connecting to a GMP database is refused', async () => {
    expect(await attempt(gmp.name, SANDBOX_LOGIN)).toBe(`permission denied for database "${gmp.name}"`);
    // The GMP roles still connect: the policy closes the database to the sandbox only.
    expect(await attempt(gmp.name, APP_LOGIN)).toBeNull();
  });

  it('[INV-18][DI-05] with the only credential the sandbox holds, no GMP table, sequence or privileged function can be used, even where CONNECT was left open', async () => {
    // Enumeration: nothing in the GMP database grants the sandbox role anything beyond PUBLIC.
    const { rows: writable } = await open.admin.query<{ obj: string }>(`
      select c.oid::regclass::text as obj from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%' and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and (has_table_privilege('ebmr_sandbox', c.oid, 'SELECT') or has_table_privilege('ebmr_sandbox', c.oid, 'INSERT')
          or has_table_privilege('ebmr_sandbox', c.oid, 'UPDATE') or has_table_privilege('ebmr_sandbox', c.oid, 'DELETE')
          or has_table_privilege('ebmr_sandbox', c.oid, 'TRUNCATE') or has_table_privilege('ebmr_sandbox', c.oid, 'TRIGGER'))
      union all
      select c.oid::regclass::text from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'S' and n.nspname not in ('pg_catalog', 'information_schema')
        and (has_sequence_privilege('ebmr_sandbox', c.oid, 'USAGE') or has_sequence_privilege('ebmr_sandbox', c.oid, 'UPDATE'))`);
    expect(writable).toEqual([]);
    const { rows: schemas } = await open.admin.query<{ nspname: string; usage: boolean; create: boolean }>(
      `select n.nspname, has_schema_privilege('ebmr_sandbox', n.oid, 'USAGE') as usage, has_schema_privilege('ebmr_sandbox', n.oid, 'CREATE') as create
         from pg_catalog.pg_namespace n where n.nspname = any($1) or n.nspname = 'public' order by 1`,
      [GMP_SCHEMAS],
    );
    expect(schemas.length).toBeGreaterThanOrEqual(10);
    expect(schemas.filter((s) => s.create || (s.usage && s.nspname !== 'public')).map((s) => s.nspname)).toEqual([]);
    const { rows: definers } = await open.admin.query<{ fn: string }>(`
      select p.oid::regprocedure::text as fn from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
        and has_function_privilege('ebmr_sandbox', p.oid, 'EXECUTE') and has_schema_privilege('ebmr_sandbox', n.oid, 'USAGE')`);
    expect(definers).toEqual([]);

    // Attempts: every write path is refused by a privilege, before any trigger or function runs.
    const results = await asSandboxInOpenGmp([
      'insert into testgmp.sample (batch_id, value) values (gen_random_uuid(), 1)',
      "select kernel.begin_command('{}'::jsonb)",
      "update sandbox.installation set kind = 'SANDBOX'",
      "select site.register_external_batch_number('{}'::jsonb)",
      "select sandbox.assert_identifier_allowed('LOT_NUMBER', 'TEST-L1')",
      'delete from kernel.audit_event',
      'select * from iam.person',
      'create table public.probe (a int)',
      'create temporary table probe (a int)',
      'set role ebmr_app',
      'set role ebmr_owner',
    ]);
    for (const [statement, error] of Object.entries(results)) {
      expect(error, statement).toMatch(/permission denied/);
    }
    // The invariant query sees only the open CONNECT, which the connect policy closes.
    expect(await segregationProblems(open.app)).toEqual([
      `ebmr_sandbox can connect to the GMP database ${open.name}`,
      `ebmr_sandbox_listener can connect to the GMP database ${open.name}`,
    ]);
  });

  it('[INV-18] the sandbox role is a member of no role and has no elevated attribute, so it cannot borrow GMP privileges', async () => {
    const { rows } = await gmp.admin.query<Record<string, unknown>>(`
      select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit,
             (select count(*)::int from pg_catalog.pg_auth_members m where m.member = r.oid) as memberships,
             (select count(*)::int from pg_catalog.pg_auth_members m where m.roleid = r.oid) as members
        from pg_catalog.pg_roles r where rolname = 'ebmr_sandbox'`);
    expect(rows).toEqual([
      { rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolinherit: false, memberships: 0, members: 0 },
    ]);
  });

  it('[DI-05] catalog: from the training store, posting to a production batch is blocked', async () => {
    const batchId = (await gmp.admin.query<{ id: string }>('select gen_random_uuid()::text as id')).rows[0]?.id as string;
    const post = `insert into testgmp.sample (batch_id, value, note) values ('${batchId}', 1, 'posted from training')`;
    // Straight at the GMP database: no session.
    expect(await attempt(gmp.name, SANDBOX_LOGIN, post)).toMatch(/permission denied for database/);
    // Where CONNECT was left open: no privilege.
    expect((await asSandboxInOpenGmp([post]))[post]).toMatch(/permission denied for schema testgmp/);
    // Inside the training store: a GMP posting path refuses, and a real batch number is not accepted.
    await expect(sbx.sandbox.query("select sandbox.assert_gmp_installation('Posting to production batch B24-0001')")).rejects.toThrow(
      'Posting to production batch B24-0001 is refused: this is a sandbox installation (TEST, NOT GMP), and test, training and simulation work never creates GMP records (DI-05, INV-18). [EBMR-SBX-010]',
    );
    await expect(sbx.sandbox.query("select sandbox.assert_identifier_allowed('BATCH_NUMBER', 'B24-0001')")).rejects.toThrow(/not a test batch number.*EBMR-SBX-022/);
    expect((await gmp.admin.query('select count(*)::int as n from testgmp.sample where batch_id = $1', [batchId])).rows[0]).toEqual({ n: 0 });
  });

  it('[DI-05] catalog: reusing a real lot number in the training store is blocked', async () => {
    const lotTable = `
      create schema a4_lots;
      create table a4_lots.lot (id uuid primary key default gen_random_uuid(), lot_number text not null unique);
      create trigger zz_reserved_identifiers before insert or update on a4_lots.lot
        for each row execute function sandbox.guard_identifier('LOT_NUMBER', 'lot_number');
      grant usage on schema a4_lots to ebmr_app;
      grant select, insert on a4_lots.lot to ebmr_app;`;
    // The real lot exists in the GMP database.
    await gmp.admin.query(lotTable);
    await gmp.app.query("insert into a4_lots.lot (lot_number) values ('L2409-0017')");
    // The same table in the sandbox (the sandbox role gets the application's grant through the mirror, as after an upgrade).
    await sbx.admin.query(lotTable);
    await sbx.admin.query('select sandbox.mirror_application_privileges()');
    await expect(sbx.sandbox.query("insert into a4_lots.lot (lot_number) values ('L2409-0017')")).rejects.toThrow(
      '"L2409-0017" is not a test lot number: in the sandbox every lot number starts with TEST- (for example TEST-L24-0001), so a real GMP identifier is never reused (DI-05). [EBMR-SBX-022]',
    );
    await expect(sbx.sandbox.query("insert into a4_lots.lot (lot_number) values ('TEST-L2409-0017')")).resolves.toBeDefined();
    // ...and the test lot can never come back into GMP.
    await expect(gmp.app.query("insert into a4_lots.lot (lot_number) values ('TEST-L2409-0017')")).rejects.toThrow(/EBMR-SBX-021/);
    expect(await segregationProblems(sbx.sandbox)).toEqual([]);
  });
});

describe('INV-18: a sandbox never becomes a GMP database (prevented)', () => {
  it('[INV-18] a sandbox-provisioned database refuses to be marked GMP later, by any role and by re-provisioning', async () => {
    expect(await readInstallationKind(sbx.sandbox)).toBe('SANDBOX');
    await expect(sbx.admin.query("update sandbox.installation set kind = 'GMP'")).rejects.toThrow(/permanent \(update refused\).*EBMR-SBX-002/);
    await expect(sbx.admin.query('delete from sandbox.installation')).rejects.toThrow(/EBMR-SBX-002/);
    await expect(sbx.admin.query('truncate sandbox.installation')).rejects.toThrow(/EBMR-SBX-002/);
    await expect(sbx.admin.query("insert into sandbox.installation (kind, database_name) values ('GMP', 'x')")).rejects.toThrow(/EBMR-SBX-003/);
    const owner = await sbx.admin.connect();
    try {
      await owner.query('begin');
      await owner.query('set local role ebmr_owner');
      await expect(owner.query("update sandbox.installation set kind = 'GMP'")).rejects.toThrow(/EBMR-SBX-002/);
    } finally {
      await owner.query('rollback');
      owner.release();
    }
    await expect(sbx.sandbox.query("update sandbox.installation set kind = 'GMP'")).rejects.toThrow(/permission denied/);
    // Running the migrations again with a GMP intent changes nothing: the marker is written once.
    const applied = await asAdmin(sbx.name, async (c) => {
      await c.query("select set_config('ebmr.installation_kind', 'GMP', false)");
      return migrate(c, editionMigrationSources());
    });
    expect(applied).toEqual([]);
    await expect(provisionSandboxDatabase({ adminUrl: ADMIN_URL, database: sbx.name, sources: editionMigrationSources() })).rejects.toThrow(/already exists.*EBMR-SBX-031/);
    expect(await readInstallationKind(sbx.sandbox)).toBe('SANDBOX');
  });

  it('[INV-18] the GMP roles cannot connect to the sandbox, and a GMP process pointed at the sandbox refuses to run', async () => {
    expect(await attempt(sbx.name, APP_LOGIN)).toBe(`permission denied for database "${sbx.name}"`);
    expect(await attempt(sbx.name, AUTHN_LOGIN)).toBe(`permission denied for database "${sbx.name}"`);
    await expect(assertInstallationKind(sbx.sandbox, 'GMP')).rejects.toThrow(/expects a GMP database but is connected to a SANDBOX database.*EBMR-SBX-007/);
    await expect(assertInstallationKind(sbx.sandbox, 'SANDBOX')).resolves.toBeUndefined();
  });
});

describe('the sandbox store', () => {
  it('[DI-05][INV-18] the invariant query returns no rows in the GMP database and in the sandbox, and reports a grant to the sandbox role in a GMP database', async () => {
    expect(await segregationProblems(gmp.app)).toEqual([]);
    expect(await segregationProblems(sbx.sandbox)).toEqual([]);
    await gmp.admin.query('grant select on testgmp.sample to ebmr_sandbox');
    try {
      expect(await segregationProblems(gmp.app)).toEqual(['ebmr_sandbox holds SELECT on table testgmp.sample in a GMP database']);
    } finally {
      await gmp.admin.query('revoke select on testgmp.sample from ebmr_sandbox');
    }
  });

  it('[DI-05] inside the sandbox, the sandbox role holds exactly the object privileges of the GMP application roles', async () => {
    expect((await sbx.admin.query('select * from sandbox.mirror_differences()')).rows).toEqual([]);
    const { rows } = await sbx.admin.query<{ n: number }>(`select count(*)::int as n from sandbox.direct_privileges('ebmr_sandbox')`);
    expect(rows[0]?.n).toBeGreaterThan(300);
    // A few of them in use.
    const { rows: used } = await sbx.sandbox.query<{ kind: string; perms: number; watermark: string }>(
      'select kernel.installation_kind() as kind, (select count(*)::int from iam.permission) as perms, sandbox.watermark() as watermark',
    );
    expect(used[0]?.kind).toBe('SANDBOX');
    expect(used[0]?.perms).toBeGreaterThan(10);
  });

  it('[DI-05] sandbox output is stamped TEST, NOT GMP and is refused as GMP input', async () => {
    const stamp = await readInstallationStamp(sbx.sandbox);
    expect(stamp).toEqual({ installationKind: 'SANDBOX', watermark: WATERMARK_TEXT });
    expect(() => assertGmpOrigin(stamp, 'True-copy bundle')).toThrow(/EBMR-SBX-013/);
    expect(await readInstallationStamp(gmp.app)).toEqual({ installationKind: 'GMP', watermark: null });
  });

  it('[INV-18] the sandbox may test-run a version of any state, with test batch numbers; GMP issue paths stay closed', async () => {
    await expect(sbx.sandbox.query("select sandbox.assert_batch_issue_allowed(array['IN_VERIFICATION'])")).resolves.toBeDefined();
    await expect(gmp.app.query("select sandbox.assert_batch_issue_allowed(array['IN_VERIFICATION'])")).rejects.toThrow(/EBMR-SBX-012/);
    await expect(sbx.sandbox.query("select sandbox.assert_identifier_allowed('BATCH_NUMBER', 'TEST-B24-0001')")).resolves.toBeDefined();
    await expect(sbx.sandbox.query("select sandbox.assert_sandbox_installation('Test run of MBR version 3')")).resolves.toBeDefined();
    await expect(sbx.sandbox.query("select sandbox.assert_gmp_installation('Batch release')")).rejects.toThrow(/EBMR-SBX-010/);
  });
});
