/**
 * A US-market GMP batch is issued only when the licence holder's 21 CFR 11.100(c) certification letter is on file
 * (DI-15 proposed_modify, outline 5.5 R-20; finding 7g-5: iam.assert_us_esig_certification was called on no issue
 * path; recipe-core 1260). The policy esig.us_certification_mode is BLOCK by default; FLAG only reports. A batch with
 * no US market is never asked. Tested as the application role through the issue functions, and at the trigger every
 * writer of a GMP batch row goes through.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, seedAdministration, seedServiceActor, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { ensureFixtureChangeRecord, underChange } from '../../../kernel/test/support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { approveTestRelease } from '../../../kernel/test/support/validation.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as execution from '../../src/execution/index.ts';
import type * as lc from '../../src/lifecycle/index.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS } from '../engine/support.ts';
import { familyOrder } from './gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let erp: SeededActor;
const dir = tempDir('us-esig-cert');
const ledger = tempLedger('us-esig-cert', dir.path);

const SITE = 'SITE-1';
const BS = 'BS-200K';
const FIXTURE = 'tablet-granulation-compression';
const HOLDER = 'Test Pharma Ltd'; // the holder of the manufacturing licence licenceFor() records
const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, params)).rows as T[];

beforeAll(async () => {
  db = await createTestDatabase();
  await approveTestRelease(db);
  await ensureFixtureChangeRecord(db);
  w = new World(db, await seedCast(db));
  // The licence and export permissions are recorded, the certification letter is not.
  w.autoUsCertification = false;
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
}, 300_000);

afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const m = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e));
    return m?.[1] ?? (e instanceof Error ? e.message : String(e));
  }
}

function without(content: unknown, types: readonly string[]): unknown {
  if (Array.isArray(content)) {
    return content.filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Record<string, unknown>)['block'] as Record<string, unknown> | undefined)?.['type'])))).map((x) => without(x, types));
  }
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
  return content;
}

const current = (versionId: string, market: string): lc.MarketAuthorisationDefinition => ({
  versionId, market, kind: 'CURRENT', cells: [cell(SITE, 'L1', BS)], regulatoryBasis: `${market}: registration on file`,
});

async function effectiveMaster(markets: string[]): Promise<{ familyId: string }> {
  const m = uniqueContent(FIXTURE);
  m.header.product = { ...m.header.product, code: m.header.product.code.toUpperCase() };
  const content = without(m, ['G-09', 'G-10']) as MbrContent;
  const v = await w.approvedVersion(content);
  for (const mk of markets) await w.authorise(current(v.versionId, mk));
  const rule = `G-${randomUUID().slice(0, 8).toUpperCase()}`;
  await w.run(steward, (c) => c.query('select site.define_batch_number_rule($1::jsonb)', [
    JSON.stringify({ rule_code: rule, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'G{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
  ]));
  return { familyId: v.familyId };
}

/** Planned and signed by the issuer; not issued. */
async function planned(familyId: string, markets: string[]): Promise<{ batchId: string; signatureId: string }> {
  const batchId = randomUUID();
  const erpOrder = await familyOrder(db, erp, familyId, BS);
  await withProtectedNumbers(db.app, await cmd(db, w.cast.issuer), ledger, (c) =>
    execution.prepareGmpIssue(c, batchId, { markets, site: SITE, line: 'L1', batchSize: BS, familyId, erpOrder }));
  const signatureId = await w.sign(w.cast.issuer, 'batch_issue', batchId, 'ISSUED', 'PLANNED');
  return { batchId, signatureId };
}

const begin = (batchId: string) => w.run(w.cast.issuer, (c) => c.query('select recipe.begin_gmp_issue($1)', [batchId]), reason('batch issued for the test'));
const issue = (batchId: string, signatureId: string) => w.run(w.cast.issuer, (c) => execution.issueGmpBatch(c, {
  batchId,
  signatureId,
  define: (content) => define(content, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }),
  request: { inputs: FIXTURE_INPUTS[FIXTURE], issuedBy: { id: w.cast.issuer.personId, kind: 'PERSON', roles: [] } },
}), reason('batch issued for the test'));
const statusOf = async (batchId: string) => (await q<{ status: string }>('select status from recipe.stub_batch where id = $1', [batchId]))[0]?.status;
const setMode = async (mode: 'BLOCK' | 'FLAG') => {
  const { admin } = await seedAdministration(db);
  await withCommand(db.app, underChange(withReason(admin, 'POLICY_CHANGE')), (c) => c.query("select iam.set_policy('esig.us_certification_mode', $1, 'test of the issue gate')", [mode]));
};

describe('the US e-signature certification at GMP issue (DI-15, recipe-core 1260)', () => {
  it('[DI-15] a US-market GMP batch is refused while the licence holder has no 11.100(c) certification on file, at the issue, at the step before it and at every writer of the batch row; once recorded, the same batch is issued', async () => {
    const m = await effectiveMaster(['IN', 'US']);
    const us = await planned(m.familyId, ['IN', 'US']);
    expect((await q<{ b: boolean }>("select (iam.us_esig_certification_status($1) ->> 'blocking')::boolean as b", [HOLDER]))[0]?.b).toBe(true);
    await expect(begin(us.batchId)).rejects.toThrow(new RegExp(`no 21 CFR 11.100\\(c\\) certification is on file for ${HOLDER}.*EBMR-IAM-170`));
    expect(await codeOf(issue(us.batchId, us.signatureId))).toBe('EBMR-IAM-170');
    // Every writer: even the superuser's direct write of the batch row is refused by the trigger.
    expect(await codeOf(db.admin.query("insert into recipe.batch_execution (id, installation) values ($1, 'GMP')", [us.batchId]))).toBe('EBMR-IAM-170');
    expect(await q('select 1 from recipe.batch_execution where id = $1', [us.batchId])).toEqual([]);
    expect(await statusOf(us.batchId)).toBe('PLANNED');
    // The process owner records the letter of the licence holder: the same planned batch, under the same signature, is issued.
    const { owner } = await seedAdministration(db);
    await withCommand(db.app, withReason(owner), (c) => c.query("select iam.record_us_esig_certification($1, 'LTR-2026-07', date '2026-03-01')", [HOLDER]));
    await issue(us.batchId, us.signatureId);
    expect(await statusOf(us.batchId)).toBe('ISSUED');
  });

  it('[DI-15] a GMP batch with no US market is issued without the certification; in FLAG mode a US-market batch is only flagged', async () => {
    const m = await effectiveMaster(['IN', 'US']);
    // A licence holder with no letter: the licence of a new holder takes over for this product (latest valid_from).
    const holder2 = `Second Pharma ${randomUUID().slice(0, 6)}`;
    const product = (await q<{ product_code: string; strength: string }>('select product_code, strength from recipe.mbr_family where id = $1', [m.familyId]))[0]!;
    const id = await w.run(w.cast.regulatory, async (c) => (await c.query<{ r: string }>('select site.record_manufacturing_licence($1::jsonb) as r', [JSON.stringify({
      licenceKind: 'MANUFACTURING', form: '25', licenceNumber: `MFG-25-${randomUUID().slice(0, 8).toUpperCase()}`, holderName: holder2,
      holderAddress: 'Plot 2, Test Industrial Area, Pune 411019', validFrom: '2021-01-01T00:00:00Z', products: [{ productCode: product.product_code, strength: product.strength }],
    })])).rows[0]!.r);
    const sig = await w.sign(w.cast.qa, 'manufacturing_licence', id, 'LICENCE_APPROVED', 'DRAFT');
    await w.run(w.cast.qa, (c) => c.query('select site.approve_manufacturing_licence($1, $2)', [id, sig]));
    expect((await q<{ h: string }>("select site.licence_basis($1, $2, $3, clock_timestamp()) ->> 'holderName' as h", [SITE, product.product_code, product.strength]))[0]?.h).toBe(holder2);

    const india = await planned(m.familyId, ['IN']);
    await issue(india.batchId, india.signatureId);
    expect(await statusOf(india.batchId)).toBe('ISSUED');

    const us = await planned(m.familyId, ['IN', 'US']);
    expect(await codeOf(issue(us.batchId, us.signatureId))).toBe('EBMR-IAM-170');
    await setMode('FLAG');
    try {
      await issue(us.batchId, us.signatureId);
      expect(await statusOf(us.batchId)).toBe('ISSUED');
    } finally {
      await setMode('BLOCK');
    }
  });

  it('[DI-15] P7G-3: a US-market GMP batch whose licence holder cannot be determined is refused (fail closed), at the gate and at every writer of the batch row; a batch with no US market is not asked', async () => {
    const m = await effectiveMaster(['IN', 'US']);
    const us = await planned(m.familyId, ['IN', 'US']);
    const india = await planned(m.familyId, ['IN']);
    // Every licence that covers the product is suspended: no licence holder is resolvable now.
    const product = (await q<{ product_code: string; strength: string }>('select product_code, strength from recipe.mbr_family where id = $1', [m.familyId]))[0]!;
    const licences = await q<{ id: string }>('select l.id from site.manufacturing_licence l join site.licence_product p on p.licence_id = l.id where l.site_code = $1 and p.product_code = $2 and p.strength = $3',
      [SITE, product.product_code, product.strength]);
    expect(licences.length).toBeGreaterThan(0);
    for (const l of licences) {
      if ((await q<{ s: string }>('select site.licence_state($1) as s', [l.id]))[0]?.s === 'APPROVED') {
        await w.run(w.cast.qa, (c) => c.query("select site.suspend_manufacturing_licence($1, 'Suspended by order of the licensing authority')", [l.id]));
      }
    }
    expect((await q<{ b: unknown }>("select site.licence_basis($1, $2, $3, clock_timestamp()) as b", [SITE, product.product_code, product.strength]))[0]?.b).toBeNull();
    expect((await q<{ e: string | null }>('select recipe.us_esig_issue_entity($1) as e', [us.batchId]))[0]?.e).toBe('');
    expect((await q<{ e: string | null }>('select recipe.us_esig_issue_entity($1) as e', [india.batchId]))[0]?.e).toBeNull();
    // Even in FLAG mode (which only reports a missing letter of a known holder) the unknown holder is refused.
    await setMode('FLAG');
    try {
      expect(await codeOf(db.admin.query("insert into recipe.batch_execution (id, installation) values ($1, 'GMP')", [us.batchId]))).toBe('EBMR-IAM-170');
      const gate = await q<{ p: string | null }>(
        'select recipe.gmp_issue_problem(b, p, l) as p from recipe.stub_batch b join recipe.batch_mbr_pin p on p.batch_id = b.id left join recipe.batch_allocation_link l on l.batch_id = b.id where b.id = $1',
        [us.batchId]);
      // The India gate (0891) speaks first for a batch with no current licence; either way the batch is refused.
      expect(gate[0]?.p ?? 'issued').toMatch(/EBMR-(IAM-170|IND-\d{3}|EXE-\d{3})/);
    } finally {
      await setMode('BLOCK');
    }
    expect(await q('select 1 from recipe.batch_execution where id = $1', [us.batchId])).toEqual([]);
  });
});
