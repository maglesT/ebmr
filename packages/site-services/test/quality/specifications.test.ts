/**
 * Phase 4 slice 2b in the database (site services 0840 to 0843): approved specifications with the pharmacopoeia and
 * edition of every limit, limits from the specification, required tests, the OOS record a RELEASE revision cites, the QC
 * extra-testing decision against the tests run, finished lots in quarantine, returned goods and reserve and retention
 * samples. Proven as the application role, with its bypass attempts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, signFor, type TestDatabase } from '../helpers.ts';
import { QualityWorld, refusal, seedQualityCast, SPEC_TESTS, unique } from './support.ts';
import { investigateDeviation } from './deviation-path.ts';

let db: TestDatabase;
let w: QualityWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new QualityWorld(db, await seedQualityCast(db));
}, 300_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

const test = (testCode: string, extra: Json = {}): Json => ({
  testCode, methodReference: `STP-${testCode}`, unit: '%', lowerLimit: '98.0', upperLimit: '102.0', required: true, pharmacopoeia: 'IP', edition: '2022',
  sampleQuantity: '0.010', sampleUnit: 'kg', ...extra,
});
const draft = (materialCode: string, tests: Json[], by: SeededActor = w.cast.analyst) =>
  w.sql<{ specificationId: string; version: number }>(by, 'select site.draft_specification($1::jsonb) as r', [
    JSON.stringify({ materialCode, title: `Specification of ${materialCode}`, monographReference: 'IP 2022 monograph', tests }),
  ]);
async function approveSpec(id: string, by: SeededActor = w.cast.qcHead): Promise<void> {
  const sig = await signFor(db, by, { type: 'specification', id }, 'SPECIFICATION_APPROVED', 'DRAFT');
  await w.sql(by, 'select site.approve_specification($1, $2)', [id, sig]);
}
const result = (lotId: string, p: Json, by: SeededActor = w.cast.analyst) =>
  w.sql<{ resultId: string; verdict: string }>(by, 'select site.record_lot_test_result($1, $2::jsonb) as r', [lotId, JSON.stringify(p)]);
async function approveResult(resultId: string): Promise<void> {
  const sig = await signFor(db, w.cast.qcHead, { type: 'lot_test_result', id: resultId }, 'QC_RESULT_APPROVED', 'RECORDED');
  await w.sql(w.cast.qcHead, 'select site.approve_lot_test_result($1, $2)', [resultId, sig]);
}
const limsProblem = async (lotId: string): Promise<string | null> =>
  (await db.app.query<{ p: string | null }>('select site.lot_lims_release_problem($1) as p', [lotId])).rows[0]?.p ?? null;
async function release(lotId: string): Promise<void> {
  await w.sql(w.cast.analyst, "select site.record_identity_result($1, 'PASS', 'IR-01', $2)", [lotId, unique('T')]);
  const sig = await signFor(db, w.cast.qcHead2, { type: 'material_lot', id: lotId }, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
  await w.sql(w.cast.qcHead2, "select site.change_lot_status($1, 'RELEASE', $2::bigint, $3, 'IDENTITY_TESTED')", [lotId, await version(lotId), sig]);
}
const version = async (lotId: string): Promise<string> =>
  (await db.app.query<{ v: string }>("select version::text as v from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lotId])).rows[0]?.v ?? '';
const lotState = async (lotId: string): Promise<string> =>
  (await db.app.query<{ s: string }>("select state as s from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lotId])).rows[0]?.s ?? '';

/** A material known to the ERP with no specification yet, and a lot of it in quarantine. */
async function bareLot(kind = 'API'): Promise<{ lotId: string; materialCode: string }> {
  const materialCode = unique('MS');
  await w.material(materialCode, kind);
  const r = await w.sql<{ lot_id: string }>(w.cast.warehouse, 'select site.receive_lot($1::jsonb) as r', [
    JSON.stringify({ lotCode: unique('L'), materialCode, quantity: '5', expiresAt: '2030-01-01T00:00:00Z' }),
  ]);
  return { lotId: r.lot_id, materialCode };
}

/** An OOS record linked to the lot; concluded by QA as `category` when given. */
async function oos(lotId: string, category?: string): Promise<string> {
  const d = await w.sql<{ deviationId: string }>(w.cast.analyst, 'select site.raise_deviation($1::jsonb) as r', [
    JSON.stringify({ kind: 'OOS', title: 'Release result in doubt', classification: 'MAJOR', riskRationale: 'A release result is investigated before use' }),
  ]);
  await w.sql(w.cast.analyst, "select site.link_deviation($1, 'LOT', $2)", [d.deviationId, lotId]);
  if (category) {
    // The full deviation path (site services 0820 to 0822): classified, impact on the lot signed, concluded.
    await investigateDeviation({ run: (a, work) => w.run(a, work), sign: (a, agg, m, st) => signFor(db, a, agg, m, st) }, d.deviationId,
      { classifier: w.cast.qa, owner: w.cast.qa, assessor: w.cast.qa2, concluder: w.cast.qa2 },
      { finding: { assignableCause: true, cause: 'Cause found by the investigation', rootCauseCategory: category } });
  }
  return d.deviationId;
}

/** A finished lot as the edition's definer posts it (tablets 1150 calls site.create_finished_lot; not granted to the app). */
async function finishedLot(markets: string[], productCode = unique('FP'), quantity = '1000'): Promise<{ lotId: string; productCode: string }> {
  const lotId = await withCommand(db.admin, { ...w.cast.warehouse, correlationId: randomUUID() }, async (c) =>
    (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId: randomUUID(), batchNumber: unique('B'), edition: 'TABLETS', siteCode: 'SITE-1', productCode, productName: `Product ${productCode}`, strength: '500 mg',
                       markets, quantity, unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
    ])).rows[0]?.id ?? '',
  );
  return { lotId, productCode };
}

describe('specifications (IN-33)', () => {
  it('[IN-33] a specification cites the pharmacopoeia and edition of every limit, is approved by another person than its drafter, and the highest approved version is in effect', async () => {
    const { materialCode } = await bareLot();
    expect(await refusal(draft(materialCode, [test('ASSAY', { pharmacopoeia: '' })]))).toMatch(/EBMR-SITE-402 .* cites the source of its limit/);
    expect(await refusal(draft(materialCode, [test('ASSAY', { edition: ' ' })]))).toMatch(/EBMR-SITE-402/);
    expect(await refusal(draft(materialCode, [test('ASSAY', { lowerLimit: 98 })]))).toMatch(/EBMR-SITE-401 .* exact decimal/);
    expect(await refusal(draft(materialCode, []))).toMatch(/EBMR-SITE-400/);
    expect(await refusal(draft(unique('NOPE'), [test('ASSAY')]))).toMatch(/EBMR-SITE-400 .* neither a material/);
    expect(await refusal(draft(materialCode, [test('ASSAY')], w.cast.operator))).toMatch(/EBMR-IAM/);
    const v1 = await draft(materialCode, [test('ASSAY')]);
    expect(v1.version).toBe(1);
    // The drafter never approves it: the signature service and the command both refuse.
    expect(await refusal(approveSpec(v1.specificationId, w.cast.analyst))).not.toBe('');
    const qcHeadDraft = await draft(materialCode, [test('ASSAY', { upperLimit: '101.0' })], w.cast.qcHead);
    expect(await refusal(approveSpec(qcHeadDraft.specificationId, w.cast.qcHead))).not.toBe('');
    await approveSpec(v1.specificationId);
    const inEffect = async () => (await db.app.query<{ id: string }>("select site.specification_in_effect('SITE-1', $1) as id", [materialCode])).rows[0]?.id;
    expect(await inEffect()).toBe(v1.specificationId);
    await approveSpec(qcHeadDraft.specificationId, w.cast.qa);
    expect(await inEffect()).toBe(qcHeadDraft.specificationId);
    expect((await db.app.query<{ s: string }>('select site.specification_state($1) as s', [v1.specificationId])).rows[0]?.s).toBe('SUPERSEDED');
    // A version below the one in effect is never approved; nothing is written directly.
    const v3 = await draft(materialCode, [test('ASSAY')]);
    await approveSpec(v3.specificationId);
    expect(await refusal(approveSpec(v1.specificationId, w.cast.qa2))).toMatch(/EBMR-ESIG-039|EBMR-SITE-403/);
    const v4 = await draft(materialCode, [test('ASSAY')]);
    await approveSpec((await draft(materialCode, [test('ASSAY')])).specificationId);
    expect(await refusal(approveSpec(v4.specificationId))).toMatch(/EBMR-SITE-404 version 4 .* below the version in effect/);
    for (const sql of [
      "insert into site.specification_approval (specification_id, signature_id, approved_by_person, approved_by_account) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
      "update site.specification_test set lower_limit = 90 where specification_id = $1",
      "delete from site.specification_test where specification_id = $1",
    ]) {
      expect(await refusal(db.app.query(sql, [v3.specificationId]))).toMatch(/permission denied/);
    }
  });

  it('[IN-33] marking a new edition effective lists every specification in effect whose limits cite the previous one', async () => {
    const a = await bareLot();
    const b = await bareLot();
    await approveSpec((await draft(a.materialCode, [test('ASSAY'), test('WATER', { lowerLimit: undefined, upperLimit: '0.5', pharmacopoeia: 'IN_HOUSE', edition: 'STP-KF v3' })])).specificationId);
    await approveSpec((await draft(b.materialCode, [test('ASSAY', { edition: '2026' })])).specificationId);
    const review = async () =>
      (await db.app.query<{ r: Json[] }>('select site.specification_edition_review() as r')).rows[0]?.r.filter((x) => [a.materialCode, b.materialCode].includes(String(x['materialCode'])));
    await w.sql(w.cast.qa, "select site.mark_edition_effective('IP', '2022', '2022-12-01T00:00:00Z')", []);
    expect(await review()).toEqual([]);
    expect(await refusal(w.sql(w.cast.analyst, "select site.mark_edition_effective('IP', '2026', '2026-07-01T00:00:00Z')", []))).toMatch(/EBMR-IAM/);
    await w.sql(w.cast.qa, "select site.mark_edition_effective('IP', '2026', '2026-07-01T00:00:00Z')", []);
    expect(await refusal(w.sql(w.cast.qa, "select site.mark_edition_effective('IP', '2026', '2026-08-01T00:00:00Z')", []))).toMatch(/EBMR-SITE-406 .* already recorded/);
    expect(await review()).toEqual([expect.objectContaining({ materialCode: a.materialCode, testCode: 'ASSAY', pharmacopoeia: 'IP', cited: '2022', effective: '2026' })]);
  });
});

describe('results against the specification (IN-33, IN-20, PR-45)', () => {
  it('[IN-33] the limits, unit and method of a result are the specification\'s, never typed; a test outside the specification in effect is refused; the stored row cannot carry other limits', async () => {
    const { lotId, materialCode } = await bareLot();
    expect(await refusal(result(lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '99.0' }))).toMatch(/EBMR-SITE-411 .* no test of an approved specification/);
    await approveSpec((await draft(materialCode, [test('ASSAY')])).specificationId);
    expect(await refusal(result(lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '99.0', lowerLimit: '90.0' }))).toMatch(/EBMR-SITE-410 .* never typed/);
    expect(await refusal(result(lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '99.0', upperLimit: '120.0' }))).toMatch(/EBMR-SITE-410/);
    expect(await refusal(result(lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '99.0', unit: 'mg' }))).toMatch(/EBMR-SITE-412/);
    expect(await refusal(result(lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '99.0', methodReference: 'STP-OTHER' }))).toMatch(/EBMR-SITE-412/);
    expect(await refusal(result(lotId, { testCode: 'DISSOLUTION', purpose: 'RELEASE', value: '85' }))).toMatch(/EBMR-SITE-411/);
    const r = await result(lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '97.5' });
    expect(r.verdict).toBe('FAIL');
    const { rows } = await db.app.query('select lower_limit::text as lo, upper_limit::text as hi, unit, method_reference from site.lot_test_result where id = $1', [r.resultId]);
    expect(rows).toEqual([{ lo: '98.0', hi: '102.0', unit: '%', method_reference: 'STP-ASSAY' }]);
    // Bypass: the application role writes no result; owner-level code cannot store other limits under a specification test.
    expect(await refusal(db.app.query("insert into site.lot_test_result (lot_id, test_code, method_reference, purpose, result_value, unit, lower_limit, recorded_by_person, recorded_by_account, correlation_id) values ($1, 'ASSAY', 'X', 'RELEASE', 99, '%', 1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [lotId]))).toMatch(/permission denied/);
    expect(
      await refusal(db.admin.query(
        `insert into site.lot_test_result (lot_id, test_code, method_reference, purpose, result_value, unit, lower_limit, upper_limit, spec_test_id, recorded_by_person, recorded_by_account, correlation_id)
         select $1, 'ASSAY', 'STP-ASSAY', 'RELEASE', 95, '%', 90.0, 102.0, t.id, gen_random_uuid(), gen_random_uuid(), gen_random_uuid()
           from site.specification_test t where t.specification_id = site.specification_in_effect('SITE-1', $2)`,
        [lotId, materialCode],
      )),
    ).toMatch(/EBMR-SITE-414/);
  });

  it('[PR-45][IN-33] a lot is released only against an approved specification and with a current, approved result of every required test: a lot with no results no longer passes', async () => {
    const { lotId, materialCode } = await bareLot();
    expect(await refusal(release(lotId))).toMatch(/no approved specification is in effect/);
    await approveSpec((await draft(materialCode, [test('ASSAY'), test('WATER', { lowerLimit: undefined, upperLimit: '0.5' }), test('PSD', { required: false, lowerLimit: '10', upperLimit: '90' })])).specificationId);
    expect(await limsProblem(lotId)).toMatch(/required test ASSAY .* has no current RELEASE result/);
    expect(await refusal(release(lotId))).toMatch(/required test ASSAY/);
    await approveResult((await result(lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '99.1' })).resultId);
    expect(await limsProblem(lotId)).toMatch(/required test WATER/);
    // A RETEST result does not stand for a RELEASE one.
    await approveResult((await result(lotId, { testCode: 'WATER', purpose: 'RETEST', value: '0.2' })).resultId);
    expect(await limsProblem(lotId)).toMatch(/required test WATER/);
    const water = await result(lotId, { testCode: 'WATER', purpose: 'RELEASE', value: '0.2' });
    expect(await limsProblem(lotId)).toMatch(/WATER result .* not approved/);
    await approveResult(water.resultId);
    expect(await limsProblem(lotId)).toBeNull();
    await release(lotId);
    expect(await lotState(lotId)).toBe('RELEASED');
  });

  it('[IN-20][DI-33] a revision of a RELEASE result cites the lot\'s OOS record, and a revised failure stands until that record concludes a confirmed laboratory error', async () => {
    const { lotId, materialCode } = await bareLot();
    await approveSpec((await draft(materialCode, [test('ASSAY')])).specificationId);
    const fail = await result(lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '96.0' });
    const revise = (oosId?: string) =>
      result(lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '99.0', revises: fail.resultId, revisionReason: 'Dilution factor entered wrongly', ...(oosId ? { oosDeviationId: oosId } : {}) });
    expect(await refusal(revise())).toMatch(/EBMR-SITE-413 a revision of a RELEASE result cites the OOS record/);
    expect(await refusal(revise(randomUUID()))).toMatch(/EBMR-SITE-413/);
    // An OOS record not linked to the lot, or a deviation of another kind, is refused.
    const unlinked = await w.sql<{ deviationId: string }>(w.cast.analyst, 'select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind: 'OOS', title: 'Unlinked', classification: 'MAJOR', riskRationale: 'Raised for another lot of the site' }),
    ]);
    expect(await refusal(revise(unlinked.deviationId))).toMatch(/EBMR-SITE-413/);
    expect(await refusal(result(lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '99.0', oosDeviationId: unlinked.deviationId }))).toMatch(/EBMR-SITE-202 only a revision/);
    const record = await oos(lotId);
    const rev = await revise(record);
    expect(rev.verdict).toBe('PASS');
    await approveResult(rev.resultId);
    expect(await limsProblem(lotId)).toMatch(/failed its limits and was revised; the failure stands/);
    // Any other conclusion than a laboratory error leaves the failure standing.
    const other = await bareLot();
    await approveSpec((await draft(other.materialCode, [test('ASSAY')])).specificationId);
    const f2 = await result(other.lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '96.0' });
    const r2 = await result(other.lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '99.0', revises: f2.resultId, revisionReason: 'Re-integrated', oosDeviationId: await oos(other.lotId, 'METHOD') });
    await approveResult(r2.resultId);
    expect(await limsProblem(other.lotId)).toMatch(/the failure stands/);
    // The OOS record of the first lot concluded a confirmed laboratory error: the lot passes and is released.
    const third = await bareLot();
    await approveSpec((await draft(third.materialCode, [test('ASSAY')])).specificationId);
    const f3 = await result(third.lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '96.0' });
    const r3 = await result(third.lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '99.0', revises: f3.resultId, revisionReason: 'Standard weighed wrongly', oosDeviationId: await oos(third.lotId, 'LABORATORY_ERROR') });
    await approveResult(r3.resultId);
    expect(await limsProblem(third.lotId)).toBeNull();
    await release(third.lotId);
    expect(await lotState(third.lotId)).toBe('RELEASED');
  });

  it('[PR-47] the extra tests QC decided for a batch are checked against the tests run on its lot: named in the specification, with a current approved passing result', async () => {
    const b = await w.gmpBatch();
    const lot = await w.lot();
    const decide = async (tests: string[], expected: string) => {
      const id = (await db.app.query<{ id: string }>("select site.qc_extra_testing_aggregate_id($1, 'EXTRA_TESTS', $2::text[]) as id", [b.id, tests])).rows[0]?.id ?? '';
      const sig = await signFor(db, w.cast.qcHead, { type: 'qc_extra_testing', id }, 'QC_EXTRA_TESTING_DECIDED', expected);
      return w.sql<string>(w.cast.qcHead, "select site.record_qc_extra_testing_decision($1, 'EXTRA_TESTS', $2::text[], $3)::text as r", [b.id, tests, sig]);
    };
    const problem = async () => (await db.app.query<{ p: string | null }>('select site.extra_testing_problem($1, $2) as p', [b.id, lot.lotId])).rows[0]?.p ?? null;
    expect(await problem()).toBeNull();
    const first = await decide(['WATER'], 'NONE');
    expect(await problem()).toMatch(/extra test WATER .* no result/);
    const water = await result(lot.lotId, { testCode: 'WATER', purpose: 'RELEASE', value: '0.9' });
    expect(await problem()).toMatch(/extra test WATER of the lot is not approved/);
    await approveResult(water.resultId);
    expect(await problem()).toMatch(/extra test WATER of the lot failed its limits/);
    const passing = await result(lot.lotId, { testCode: 'WATER', purpose: 'RELEASE', value: '0.3', revises: water.resultId, revisionReason: 'Sample re-run', oosDeviationId: await oos(lot.lotId) });
    await approveResult(passing.resultId);
    expect(await problem()).toBeNull();
    // A later decision may add tests but never drops one; a test outside the specification has no limits to judge it by.
    await decide(['DISSOLUTION', 'WATER'], first);
    expect(await problem()).toMatch(/extra test DISSOLUTION .* no test of the specification in effect/);
    expect(SPEC_TESTS.map((t) => t['testCode'])).not.toContain('DISSOLUTION');
  });
});

describe('finished lots and returned goods (IN-05 (a), PR-45, PR-48)', () => {
  it('[IN-05][PR-45] a finished lot is created in quarantine only from its packaging batch\'s output: never received, never created by the application role, and never released, rejected or recalled through the material-lot path', async () => {
    const code = unique('FPM');
    await w.material(code, 'FINISHED');
    expect(await refusal(w.sql(w.cast.warehouse, 'select site.receive_lot($1::jsonb) as r', [JSON.stringify({ lotCode: unique('L'), materialCode: code, quantity: '5', expiresAt: '2030-01-01T00:00:00Z' })])))
      .toMatch(/EBMR-SITE-420 .* finished product/);
    expect(await refusal(w.sql(w.cast.warehouse, "select site.create_finished_lot('{}'::jsonb)", []))).toMatch(/permission denied/);
    const f = await finishedLot(['IN', 'US']);
    expect(await lotState(f.lotId)).toBe('QUARANTINE');
    const batchId = (await db.app.query<{ b: string }>('select batch_id::text as b from site.finished_lot where lot_id = $1', [f.lotId])).rows[0]?.b;
    expect((await db.app.query<{ l: string }>('select site.finished_lot_of($1)::text as l', [batchId])).rows[0]?.l).toBe(f.lotId);
    await w.sql(w.cast.analyst, "select site.record_identity_result($1, 'PASS', 'IR-01', 'T-1')", [f.lotId]);
    const sig = await signFor(db, w.cast.qcHead2, { type: 'material_lot', id: f.lotId }, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    expect(await refusal(w.sql(w.cast.qcHead2, "select site.change_lot_status($1, 'RELEASE', $2::bigint, $3, 'IDENTITY_TESTED')", [f.lotId, await version(f.lotId), sig]))).toMatch(/not_finished: lot .* is finished product/);
    const rej = await signFor(db, w.cast.qa, { type: 'material_lot', id: f.lotId }, 'MATERIAL_LOT_REJECTED', 'QUARANTINE');
    expect(await refusal(w.run(w.cast.qa, async (c) => c.query("select site.change_lot_status($1, 'REJECT', $2::bigint, $3)", [f.lotId, await version(f.lotId), rej]), 'finished'))).toMatch(/not_finished/);
    expect(await lotState(f.lotId)).toBe('QUARANTINE');
    // Bypass: the application role writes no finished-lot row and no lot.
    expect(await refusal(db.app.query("insert into site.finished_lot (lot_id, batch_id, batch_number, edition, product_code, strength, markets, posted_by_person, posted_by_account) values ($1, gen_random_uuid(), 'B', 'TABLETS', 'P', 's', '{IN}', gen_random_uuid(), gen_random_uuid())", [f.lotId]))).toMatch(/permission denied/);
  });

  it('[PR-45] a RECALL of a finished lot is never proposed on the material-lot path (D-P4-3); HOLD, UNHOLD and RECALL of a material lot are proposed by QA first', async () => {
    const f = await finishedLot(['IN']);
    // A finished lot reaches RELEASED only through the release model (slice 3); written here as a fixture to show the refusal.
    await w.fixture("update platform.aggregate_state set state = 'RELEASED' where aggregate_type = 'material_lot' and aggregate_id = $1", [f.lotId]);
    expect(await refusal(w.sql(w.cast.qa, "select site.propose_lot_decision($1, 'RECALL')", [f.lotId]))).toMatch(/EBMR-SITE-421 .* recalled through the recall of the release model/);
    expect(await w.sql<string>(w.cast.qa, "select site.propose_lot_decision($1, 'HOLD')::text as r", [f.lotId])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[PR-48] returned goods are booked in quarantine linked to their finished lot; they leave it only by rejection after QC\'s signed assessment, and with any doubt only destruction or chemical recovery is chosen', async () => {
    const f = await finishedLot(['IN']);
    const book = (p: Json, by: SeededActor = w.cast.warehouse) => w.sql<{ lotId: string; lotCode: string }>(by, 'select site.receive_returned_goods($1::jsonb) as r', [JSON.stringify(p)]);
    const ret = { originalLotId: f.lotId, quantity: '120', reason: 'Damaged cartons at the distributor', returnedFrom: 'Distributor Pune' };
    expect(await refusal(book(ret, w.cast.operator))).toMatch(/EBMR-IAM/);
    expect(await refusal(book({ ...ret, quantity: '2000' }))).toMatch(/EBMR-SITE-425 .* would exceed/);
    expect(await refusal(book({ ...ret, reason: ' ' }))).toMatch(/EBMR-SITE-425/);
    const api = await w.lot({ materialKind: 'API' });
    expect(await refusal(book({ ...ret, originalLotId: api.lotId }))).toMatch(/EBMR-SITE-424 .* only finished product/);
    const g = await book(ret);
    expect(g.lotCode).toMatch(/-R1$/);
    expect(await lotState(g.lotId)).toBe('QUARANTINE');
    expect((await db.app.query('select material_kind from site.material_lot where id = $1', [g.lotId])).rows).toEqual([{ material_kind: 'RETURNED' }]);
    // Before QC's signed assessment the lot is not rejected (so not destroyed), and never released.
    const reject = async (by: SeededActor = w.cast.qa) => {
      const sig = await signFor(db, by, { type: 'material_lot', id: g.lotId }, 'MATERIAL_LOT_REJECTED', 'QUARANTINE');
      return w.run(by, async (c) => c.query("select site.change_lot_status($1, 'REJECT', $2::bigint, $3)", [g.lotId, await version(g.lotId), sig]), 'returned goods for destruction');
    };
    expect(await refusal(reject())).toMatch(/not_finished: lot .* returned goods: it is rejected only after QC signed an assessment/);
    const assessment = { nature: 'Film-coated tablets in blisters', storage: 'Store below 30 C', conditionHistory: 'Outer cartons crushed; blisters intact', timeSinceIssue: '4 months', doubt: true, implicatesOtherBatches: false };
    const assess = (p: Json, by: SeededActor = w.cast.qcHead) => w.sql<string>(by, 'select site.record_returned_goods_assessment($1, $2::jsonb)::text as r', [g.lotId, JSON.stringify(p)]);
    expect(await refusal(assess({ ...assessment, disposition: 'RETURN_TO_STOCK' }))).toMatch(/EBMR-SITE-427 with any doubt/);
    expect(await refusal(assess({ ...assessment, timeSinceIssue: '' }))).toMatch(/EBMR-SITE-426/);
    expect(await refusal(assess({ ...assessment, implicatesOtherBatches: true }))).toMatch(/EBMR-SITE-428/);
    expect(await refusal(assess(assessment, w.cast.analyst))).toMatch(/EBMR-IAM/);
    await assess(assessment);
    const { rows } = await db.app.query<{ d: string }>('select disposition as d from site.returned_goods_assessment where lot_id = $1', [g.lotId]);
    expect(rows.map((r) => r.d)).toEqual(['DESTROY']);
    expect(await refusal(reject(w.cast.qa2))).toMatch(/rejected only after QC signed an assessment/);
    // Signed by the QC person who assessed it, never another.
    const latest = (await db.app.query<{ id: string }>('select id::text from site.returned_goods_assessment where lot_id = $1', [g.lotId])).rows[0]?.id ?? '';
    const other = await signFor(db, w.cast.qcHead2, { type: 'returned_goods', id: g.lotId }, 'RETURNED_GOODS_ASSESSED', latest);
    expect(await refusal(w.sql(w.cast.qcHead2, 'select site.sign_returned_goods_assessment($1, $2)', [g.lotId, other]))).toMatch(/EBMR-SITE-429 the QC person who recorded/);
    const sig = await signFor(db, w.cast.qcHead, { type: 'returned_goods', id: g.lotId }, 'RETURNED_GOODS_ASSESSED', latest);
    await w.sql(w.cast.qcHead, 'select site.sign_returned_goods_assessment($1, $2)', [g.lotId, sig]);
    // A release of returned goods is refused whatever the assessment; the rejection now succeeds.
    const rel = await signFor(db, w.cast.qcHead2, { type: 'material_lot', id: g.lotId }, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    expect(await refusal(w.sql(w.cast.qcHead2, "select site.change_lot_status($1, 'RELEASE', $2::bigint, $3, 'IDENTITY_TESTED')", [g.lotId, await version(g.lotId), rel]))).toMatch(/returned goods: it leaves quarantine only by rejection/);
    await reject(w.cast.qa3);
    expect(await lotState(g.lotId)).toBe('REJECTED');
    // The application role writes no assessment or signature row.
    expect(await refusal(db.app.query("insert into site.returned_goods_assessment_signature (assessment_id, signature_id, signed_by_person, signed_by_account) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [latest]))).toMatch(/permission denied/);
  });
});

describe('reserve and retention samples (PR-44, IN-32)', () => {
  it('[PR-44][IN-32] a reserve sample is kept until the latest of India expiry + 3 months and US or EU expiry + 1 year; its required quantity is twice the full test plan; disposal before then is refused', async () => {
    const f = await finishedLot(['IN', 'US']);
    const pull = (lotId: string, p: Json, by: SeededActor = w.cast.analyst) => w.sql<string>(by, 'select site.pull_lot_sample($1, $2::jsonb)::text as r', [lotId, JSON.stringify(p)]);
    const sample = { kind: 'RESERVE', quantity: '60', container: 'Marketed blister in carton', storageLocation: 'Reserve room R-2, shelf 4' };
    expect(await refusal(pull(f.lotId, sample))).toMatch(/EBMR-SITE-432 .* twice the sample quantities/);
    await w.product(f.productCode);
    await w.specification(f.productCode, [
      { testCode: 'ASSAY', methodReference: 'STP-AS', unit: '%', lowerLimit: '95.0', upperLimit: '105.0', required: true, pharmacopoeia: 'IP', edition: '2022', sampleQuantity: '20', sampleUnit: 'units' },
      { testCode: 'DISSOLUTION', methodReference: 'STP-DS', unit: '%', lowerLimit: '80', required: true, pharmacopoeia: 'USP', edition: '2025', sampleQuantity: '24', sampleUnit: 'units' },
    ]);
    expect(await refusal(pull(f.lotId, { ...sample, kind: 'RETENTION' }))).toMatch(/EBMR-SITE-430 .* RESERVE/);
    expect(await refusal(pull(f.lotId, sample, w.cast.operator))).toMatch(/EBMR-IAM/);
    const problem = async () => (await db.app.query<{ p: string | null }>('select site.lot_sample_problem($1) as p', [f.lotId])).rows[0]?.p ?? null;
    expect(await problem()).toMatch(/keeps 0 units .* at least 88 units/);
    const s1 = await pull(f.lotId, sample);
    expect(await problem()).toMatch(/keeps 60 units .* at least 88 units/);
    await pull(f.lotId, { ...sample, quantity: '30' });
    expect(await problem()).toBeNull();
    const { rows } = await db.app.query<{ req: string; until: string }>("select required_quantity::text as req, to_char(retain_until at time zone 'UTC', 'YYYY-MM-DD') as until from site.lot_sample where id = $1", [s1]);
    expect(rows[0]).toEqual({ req: '88', until: '2030-06-30' });
    const indiaOnly = await finishedLot(['IN'], f.productCode);
    const s3 = await pull(indiaOnly.lotId, sample);
    expect((await db.app.query<{ until: string }>("select to_char(retain_until at time zone 'UTC', 'YYYY-MM-DD') as until from site.lot_sample where id = $1", [s3])).rows[0]?.until).toBe('2029-09-30');
    // Disposal: QA only, never before the kept-until instant; the app role writes nothing directly.
    expect(await refusal(w.sql(w.cast.analyst, "select site.dispose_lot_sample($1, 'space')", [s1]))).toMatch(/EBMR-IAM/);
    expect(await refusal(w.sql(w.cast.qa, "select site.dispose_lot_sample($1, 'space needed')", [s1]))).toMatch(/EBMR-SITE-433 .* kept until 2030-06-30/);
    expect(await refusal(db.app.query("insert into site.lot_sample_disposal (sample_id, reason, disposed_by_person, disposed_by_account) values ($1, 'x', gen_random_uuid(), gen_random_uuid())", [s1]))).toMatch(/permission denied/);
    expect(await refusal(db.app.query("update site.lot_sample set retain_until = now() where id = $1", [s1]))).toMatch(/permission denied/);
    await w.fixture("update site.lot_sample set retain_until = clock_timestamp() - interval '1 day' where id = $1", [s1]);
    expect(await refusal(w.sql(w.cast.qa, "select site.dispose_lot_sample($1, ' ')", [s1]))).toMatch(/EBMR-SITE-434/);
    await w.sql(w.cast.qa, "select site.dispose_lot_sample($1, 'Retention period over')", [s1]);
    expect(await problem()).toMatch(/keeps 30 units/);
  });

  it('[IN-32] a starting material keeps a RETENTION sample until its expiry + 1 year; an intermediate keeps none', async () => {
    const lot = await w.lot({ materialKind: 'API' });
    const pull = (lotId: string, kind: string) =>
      w.sql<string>(w.cast.analyst, 'select site.pull_lot_sample($1, $2::jsonb)::text as r', [lotId, JSON.stringify({ kind, quantity: '0.05', container: 'Amber glass jar', storageLocation: 'Retention room' })]);
    expect(await refusal(pull(lot.lotId, 'RESERVE'))).toMatch(/EBMR-SITE-430 .* RETENTION/);
    const s = await pull(lot.lotId, 'RETENTION');
    expect((await db.app.query("select kind, required_quantity::text as req, to_char(retain_until at time zone 'UTC', 'YYYY-MM-DD') as until from site.lot_sample where id = $1", [s])).rows).toEqual([{ kind: 'RETENTION', req: '0.040', until: '2031-01-01' }]);
    const inter = await w.lot({ materialKind: 'INTERMEDIATE' });
    expect(await refusal(pull(inter.lotId, 'RETENTION'))).toMatch(/EBMR-SITE-430 .* no reserve or retention sample/);
  });
});
