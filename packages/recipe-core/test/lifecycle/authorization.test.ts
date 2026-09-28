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
      const admin = r.src.indexOf('iam.assert_not_administrator()');
      const perm = r.src.indexOf('iam.require_permission(');
      return admin < 0 || perm < 0 || admin > perm;
    });
    expect(missing.map((r) => r.fn)).toEqual([]);
    const known = new Set((await db.admin.query<{ code: string }>('select code from iam.permission')).rows.map((r) => r.code));
    const cited = writers.flatMap((r) => [...r.src.matchAll(/'([A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*)'/g)].map((m) => m[1] ?? ''));
    expect(cited.filter((p) => !known.has(p))).toEqual([]);
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
    expect(rows.filter((r) => !r.app_reads).map((r) => r.t)).toEqual([]);
    expect(rows.filter((r) => !r.audited).map((r) => r.t)).toEqual([]);
    // Only the rows that end or edit in place are not insert-only; each has its own guard.
    expect(rows.filter((r) => !r.insert_only).map((r) => r.t)).toEqual(['recipe.authorisation_cell', 'recipe.mbr_version', 'recipe.stub_batch']);
    const time = await db.app.query<{ table_name: string }>("select table_name from platform.time_model_violations() where table_name like 'recipe.%'");
    expect(time.rows).toEqual([]);
    const owner = await db.admin.query<{ n: string }>(
      "select count(*)::text as n from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner where n.nspname = 'recipe' and r.rolname <> 'ebmr_owner'",
    );
    expect(owner.rows[0]?.n).toBe('0');
  });

  it('[DI-37][INV-09] every table holding signed content of an MBR version or market authorisation is registered with the e-signature module', async () => {
    const { rows } = await db.admin.query<{ t: string; type: string }>("select table_name::text as t, aggregate_type as type from esig.signed_table where table_name::text like 'recipe.%' order by 1");
    expect(rows).toEqual([
      { t: 'recipe.market_authorisation', type: 'mbr_market_authorisation' },
      { t: 'recipe.mbr_content', type: 'mbr_version' },
      { t: 'recipe.mbr_draft_entry', type: 'mbr_version' },
      { t: 'recipe.mbr_evidence', type: 'mbr_version' },
      { t: 'recipe.mbr_evidence_void', type: 'mbr_version' },
      { t: 'recipe.mbr_risk_link', type: 'mbr_version' },
      { t: 'recipe.mbr_version', type: 'mbr_version' },
    ]);
    expect((await db.app.query<{ ok: boolean }>('select esig.change_triggers_ok() as ok')).rows[0]?.ok).toBe(true);
  });
});
