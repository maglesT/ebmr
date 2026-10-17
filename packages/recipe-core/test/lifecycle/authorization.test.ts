/**
 * Authority on every writer and privilege separation of the recipe schema (DI-17, DI-18; ADR 0012):
 * every function the application can call that can write refuses administrators first and checks a
 * known permission; the application role reads the tables and writes none; every table is audited,
 * insert-only where it holds content, evidence or decisions, and takes its time from the database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedAdministration } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 300_000);

afterAll(async () => {
  await db.drop();
});

/** Volatile, app-callable functions that only read (they call volatile readers such as esig.signature_problem). */
const READ_ONLY: Record<string, string> = {
  'recipe.inv17_violations()': 'invariant query; reads signatures through esig.signature_problem',
  'recipe.invariant_violations()': 'invariant query (union of the INV-01, INV-02, INV-04, INV-17 and PR-06 queries)',
  'recipe.site_today()': 'reads the site zone policy and the clock',
};

/**
 * Execution writers (module C3) gate through two helpers, each proven below to contain the kernel check itself:
 * recipe.execution_actor refuses administrators (each writer checks its installation itself, recipe-core 0501), recipe.require_command_permission
 * requires the command's catalogued permission (recipe.execution_command_permission).
 */
const ADMIN_GATES = ['iam.assert_not_administrator()', 'recipe.execution_actor('];
const PERMISSION_GATES = ['iam.require_permission(', 'recipe.require_command_permission(', 'recipe.require_issue_permission('];
const firstOf = (src: string, gates: readonly string[]): number => Math.min(...gates.map((g) => src.indexOf(g)).filter((i) => i >= 0), Number.MAX_SAFE_INTEGER);

/** App-callable writers with no permission of their own, and why. */
const NO_PERMISSION: Record<string, string> = {
  'recipe.lock_execution(uuid,boolean)':
    'locks the run row and records the transaction clock marker (INV-16) for the command that follows; it writes no business data, refuses administrators, and every command then appends through recipe.append_execution, which checks the command permission',
};

describe('authority on every writer (DI-17, DI-18)', () => {
  it('[DI-17][DI-18] every app-callable recipe function that can write refuses administrators, then checks a catalogued permission', async () => {
    const { rows } = await db.admin.query<{ fn: string; src: string }>(`
      select p.oid::regprocedure::text as fn, p.prosrc as src
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'recipe' and p.provolatile = 'v' and p.prokind = 'f' and has_function_privilege('ebmr_app', p.oid, 'EXECUTE')
      order by 1`);
    const writers = rows.filter((r) => !(r.fn in READ_ONLY));
    expect(writers.length).toBeGreaterThanOrEqual(20);
    const missing = writers.filter((r) => {
      const admin = firstOf(r.src, ADMIN_GATES);
      if (r.fn in NO_PERMISSION) return admin === Number.MAX_SAFE_INTEGER;
      const perm = firstOf(r.src, PERMISSION_GATES);
      return admin === Number.MAX_SAFE_INTEGER || perm === Number.MAX_SAFE_INTEGER || admin > perm;
    });
    expect(missing.map((r) => r.fn)).toEqual([]);
    // The helper gates hold the kernel checks themselves.
    // Every overload of each (recipe-core 1100 adds the batch forms of 6jc-R16), so a new one cannot drop the check.
    const helper = async (name: string) => (await db.admin.query<{ src: string }>(
      "select p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname || '.' || p.proname = $1",
      [name])).rows.map((r) => r.src);
    const executionActor = await helper('recipe.execution_actor');
    const commandPermission = await helper('recipe.require_command_permission');
    expect(executionActor.length).toBeGreaterThan(0);
    expect(commandPermission.length).toBe(2);
    for (const src of executionActor) expect(src).toContain('iam.assert_not_administrator()');
    for (const src of commandPermission) expect(src).toContain('iam.require_permission(');
    // The GMP batch issue's form with the order's product (recipe-core 1218, 6jc-R16).
    const issuePermission = await helper('recipe.require_issue_permission');
    expect(issuePermission.length).toBe(1);
    for (const src of issuePermission) expect(src).toContain('iam.require_permission(');
    const known = new Set((await db.admin.query<{ code: string }>('select code from iam.permission')).rows.map((r) => r.code));
    const cited = writers.flatMap((r) => [...r.src.matchAll(/'([A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*)'/g)].map((m) => m[1] ?? ''));
    const commandPermissions = (await db.admin.query<{ p: string }>('select distinct unnest(permissions) as p from recipe.execution_command_permission')).rows.map((r) => r.p);
    expect(commandPermissions.length).toBeGreaterThan(0);
    expect([...cited, ...commandPermissions, 'STEP.VERIFY', 'STEP.WITNESS'].filter((p) => !known.has(p))).toEqual([]);
  });

  it('[DI-18] an administrator never creates or changes MBR data; a person without the permission is refused', async () => {
    const { admin } = await seedAdministration(db);
    const content = uniqueContent();
    await expect(w.run(admin, (c) => lc.defineFamily(c, lc.familyOf(content)))).rejects.toThrow(/EBMR-IAM-042/);
    await expect(w.run(w.cast.checker, (c) => lc.defineFamily(c, lc.familyOf(content)))).rejects.toThrow(/EBMR-IAM-040/);
    await expect(w.run(w.cast.author, (c) => lc.recordChangeRecord(c, { number: 'CC-X', title: 'x', changeClass: 'MINOR', processImpacting: false }))).rejects.toThrow(/EBMR-IAM-040/);
    await expect(w.run(w.cast.author, (c) => lc.createStubBatch(c, { batchNumber: 'B-X', familyId: '00000000-0000-0000-0000-000000000000', markets: ['IN'], site: 'S', line: 'L', batchSize: 'X' }))).rejects.toThrow(/EBMR-RCP-010/);
  });

  it('[DI-17] the new permission MBR.CHANGE_RECORD is a GMP write permission held by the QA approver and the regulatory signer only, attributed to the software release', async () => {
    const { rows } = await db.admin.query<{ domain: string; effect: string; roles: string[] }>(
      `select p.domain, p.effect, array_agg(rp.role_code order by rp.role_code) as roles
         from iam.permission p join iam.role_permission rp on rp.permission_code = p.code and rp.removed_at is null
        where p.code = 'MBR.CHANGE_RECORD' group by p.domain, p.effect`,
    );
    expect(rows).toEqual([{ domain: 'GMP', effect: 'WRITE', roles: ['QA_MBR_APPROVER', 'REGULATORY_SIGNER'] }]);
    const audit = await db.admin.query<{ role: string }>("select payload -> 'actor' ->> 'role_code' as role from kernel.audit_event where chain_key = 'iam_permission:MBR.CHANGE_RECORD'");
    expect(audit.rows).toEqual([{ role: 'SOFTWARE_RELEASE' }]);
  });
});

describe('privilege separation of the recipe schema (ADR 0012)', () => {
  it('[DI-17][INV-01][INV-02][INV-04][INV-17] the application role reads every recipe table and writes none; every table is audited and on database time', async () => {
    const { rows } = await db.admin.query<{ t: string; audited: boolean; insert_only: boolean | null; app_writes: boolean; app_reads: boolean }>(`
      select c.oid::regclass::text as t, a.table_name is not null as audited, a.insert_only,
             has_table_privilege('ebmr_app', c.oid, 'INSERT') or has_table_privilege('ebmr_app', c.oid, 'UPDATE')
             or has_table_privilege('ebmr_app', c.oid, 'DELETE') or has_table_privilege('ebmr_app', c.oid, 'TRUNCATE') as app_writes,
             has_table_privilege('ebmr_app', c.oid, 'SELECT') as app_reads
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        left join kernel.audited_table a on a.table_name = c.oid
       where n.nspname = 'recipe' and c.relkind = 'r' order by 1`);
    expect(rows.length).toBeGreaterThanOrEqual(21);
    expect(rows.filter((r) => r.app_writes).map((r) => r.t)).toEqual([]);
    // The transaction clock marker (INV-16) is owner-only and unlogged, like kernel.command_marker: no record, no audit.
    const MARKERS = ['recipe.execution_clock'];
    // The controlled-substance records (draft IN-53, 6jc-R2) are read only through the edition's gated definers, which
    // need CONTROLLED.READ in the record's scope (recipe-core 1214, tablets 1413): the application role reads none.
    const CONTROLLED = ['recipe.controlled_checkpoint', 'recipe.controlled_checkpoint_signature', 'recipe.controlled_custody', 'recipe.controlled_custody_signature',
      'recipe.controlled_custody_use', 'recipe.controlled_register_extract'];
    expect(rows.filter((r) => !r.app_reads).map((r) => r.t)).toEqual([...CONTROLLED, ...MARKERS].sort());
    // The run-state projection is rebuilt from the audited, hash-chained command rows and checked against them
    // (recipe.execution_violations); it holds no fact of its own.
    const PROJECTIONS = ['recipe.execution_state'];
    expect(rows.filter((r) => !r.audited).map((r) => r.t)).toEqual([...MARKERS, ...PROJECTIONS].sort());
    const unlogged = await db.admin.query<{ t: string }>("select c.oid::regclass::text as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'recipe' and c.relkind = 'r' and c.relpersistence = 'u' order by 1");
    expect(unlogged.rows.map((r) => r.t)).toEqual(MARKERS);
    // Only the rows that end or edit in place are not insert-only; each has its own guard.
    expect(rows.filter((r) => !r.insert_only && !MARKERS.includes(r.t) && !PROJECTIONS.includes(r.t)).map((r) => r.t)).toEqual(['recipe.authorisation_cell', 'recipe.mbr_version', 'recipe.stub_batch']);
    const time = await db.app.query<{ table_name: string }>("select table_name from platform.time_model_violations() where table_name like 'recipe.%'");
    expect(time.rows).toEqual([]);
    const owner = await db.admin.query<{ n: string }>(
      "select count(*)::text as n from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner where n.nspname = 'recipe' and r.rolname <> 'ebmr_owner'",
    );
    expect(owner.rows[0]?.n).toBe('0');
  });

  it('[DI-37][INV-09] every table holding signed content of an MBR version, market authorisation, GMP batch issue or test-run aggregate is registered with the e-signature module', async () => {
    const { rows } = await db.admin.query<{ t: string; type: string }>("select table_name::text as t, aggregate_type as type from esig.signed_table where table_name::text like 'recipe.%' order by 1");
    expect(rows).toEqual([
      // The issue content of a GMP batch (meaning ISSUED; recipe-core 0500): its number's link, pin and control recipe.
      { t: 'recipe.batch_allocation_link', type: 'batch_issue' },
      { t: 'recipe.batch_mbr_pin', type: 'batch_issue' },
      { t: 'recipe.control_recipe', type: 'batch_issue' },
      { t: 'recipe.execution_exception_content', type: 'batch_exception' },
      { t: 'recipe.execution_point_content', type: 'batch_point' },
      { t: 'recipe.execution_stage_content', type: 'batch_stage' },
      { t: 'recipe.execution_step_content', type: 'batch_step' },
      { t: 'recipe.market_authorisation', type: 'mbr_market_authorisation' },
      { t: 'recipe.mbr_content', type: 'mbr_version' },
      { t: 'recipe.mbr_draft_entry', type: 'mbr_version' },
      { t: 'recipe.mbr_evidence', type: 'mbr_version' },
      { t: 'recipe.mbr_evidence_void', type: 'mbr_version' },
      { t: 'recipe.mbr_risk_link', type: 'mbr_version' },
      { t: 'recipe.mbr_version', type: 'mbr_version' },
      // The quality unit's authorisations of a reprocessing (REPROCESSING_AUTHORISED; recipe-core 0621, 0624).
      { t: 'recipe.reprocessing_authorisation', type: 'reprocessing_authorisation' },
      { t: 'recipe.reprocessing_request', type: 'reprocessing_request' },
    ]);
    expect((await db.app.query<{ ok: boolean }>('select esig.change_triggers_ok() as ok')).rows[0]?.ok).toBe(true);
  });
});
