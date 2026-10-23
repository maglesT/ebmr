/**
 * Phase 7 slice 7p in the database (site services 1640): a multi-point profile (a dissolution profile of a
 * sustained-release tablet) as one test of a specification, its results per time point from QC and from the LIMS
 * interface, and the lot release on it. Proven as the application role, with its bypass attempts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { envelopeFor, nowUs, receive, registerAdapter, type TestAdapter } from '../../../kernel/test/integrations/support.ts';
import { createTestDatabase, signFor, type TestDatabase } from '../helpers.ts';
import { QualityWorld, refusal, seedQualityCast, unique } from './support.ts';

let db: TestDatabase;
let w: QualityWorld;
let lims: TestAdapter;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new QualityWorld(db, await seedQualityCast(db));
  lims = await registerAdapter(db, 'LIMS');
}, 300_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

/** The invented sustained-release tablet's dissolution profile: 1 h at most 40 %, 4 h 45 to 70 %, 8 h at least 80 %. */
const POINTS: Json[] = [
  { label: '1 h', timeValue: '1', timeUnit: 'h', upperLimit: '40' },
  { label: '4 h', timeValue: '4', timeUnit: 'h', lowerLimit: '45', upperLimit: '70' },
  { label: '8 h', timeValue: '480', timeUnit: 'min', lowerLimit: '80' },
];
const assay: Json = { testCode: 'ASSAY', methodReference: 'STP-AS', unit: '%', lowerLimit: '95.0', upperLimit: '105.0', required: true, pharmacopoeia: 'IP', edition: '2022', sampleQuantity: '20', sampleUnit: 'units' };
const profile = (extra: Json = {}): Json => ({
  testCode: 'DISSOLUTION', methodReference: 'STP-DS-SR', unit: '%', required: true, pharmacopoeia: 'IN_HOUSE', edition: 'STP-DS-SR v1', sampleQuantity: '12', sampleUnit: 'units',
  points: POINTS, ...extra,
});
const draft = (materialCode: string, tests: Json[]) =>
  w.sql<{ specificationId: string; version: number }>(w.cast.analyst, 'select site.draft_specification($1::jsonb) as r', [
    JSON.stringify({ materialCode, title: `Specification of ${materialCode}`, monographReference: 'In-house monograph', tests }),
  ]);
async function approveSpec(id: string): Promise<void> {
  const sig = await signFor(db, w.cast.qcHead, { type: 'specification', id }, 'SPECIFICATION_APPROVED', 'DRAFT');
  await w.sql(w.cast.qcHead, 'select site.approve_specification($1, $2)', [id, sig]);
}
const result = (lotId: string, p: Json) =>
  w.sql<{ resultId: string; verdict: string }>(w.cast.analyst, 'select site.record_lot_test_result($1, $2::jsonb) as r', [lotId, JSON.stringify(p)]);
async function approveResult(resultId: string): Promise<void> {
  const sig = await signFor(db, w.cast.qcHead, { type: 'lot_test_result', id: resultId }, 'QC_RESULT_APPROVED', 'RECORDED');
  await w.sql(w.cast.qcHead, 'select site.approve_lot_test_result($1, $2)', [resultId, sig]);
}
const point = async (lotId: string, label: string, value: string): Promise<{ resultId: string; verdict: string }> => {
  const r = await result(lotId, { testCode: 'DISSOLUTION', point: label, purpose: 'RELEASE', value });
  await approveResult(r.resultId);
  return r;
};
const limsProblem = async (lotId: string): Promise<string | null> =>
  (await db.app.query<{ p: string | null }>('select site.lot_lims_release_problem($1) as p', [lotId])).rows[0]?.p ?? null;
interface Status { testCode: string; status: 'PASS' | 'FAIL' | 'OPEN'; problem: string | null; points: { label: string; result: { value: string; verdict: string; state: string } | null; lims: Json | null }[] }
const status = async (lotId: string): Promise<Status[]> => (await db.app.query<{ s: Status[] }>('select site.lot_profile_status($1) as s', [lotId])).rows[0]!.s;
const version = async (lotId: string): Promise<string> =>
  (await db.app.query<{ v: string }>("select version::text as v from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lotId])).rows[0]?.v ?? '';
async function releaseLot(lotId: string): Promise<void> {
  await w.sql(w.cast.analyst, "select site.record_identity_result($1, 'PASS', 'IR-01', $2)", [lotId, unique('T')]);
  const sig = await signFor(db, w.cast.qcHead2, { type: 'material_lot', id: lotId }, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
  await w.sql(w.cast.qcHead2, "select site.change_lot_status($1, 'RELEASE', $2::bigint, $3, 'IDENTITY_TESTED')", [lotId, await version(lotId), sig]);
}

/** A material with the approved profile specification, and a lot of it in quarantine with its passing assay. */
async function profiledLot(): Promise<{ lotId: string; lotCode: string; materialCode: string }> {
  const materialCode = unique('SR');
  await w.material(materialCode);
  await approveSpec((await draft(materialCode, [assay, profile()])).specificationId);
  const lot = await w.lot({ materialCode });
  await approveResult((await result(lot.lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '99.8' })).resultId);
  return lot;
}

describe('a multi-point profile as one test of a specification (IN-33)', () => {
  it('[IN-33] a profile carries its ordered time points, each with its own limits, the approval signs them, and nothing changes once approved', async () => {
    const materialCode = unique('SR');
    await w.material(materialCode);
    // Refused shapes: limits on the profile itself, one point, a point without a limit, times out of order, crossed limits.
    expect(await refusal(draft(materialCode, [profile({ upperLimit: '100' })]))).toMatch(/EBMR-SITE-970 profile DISSOLUTION carries its limits on its time points/);
    expect(await refusal(draft(materialCode, [profile({ points: [POINTS[0]] })]))).toMatch(/EBMR-SITE-970 profile DISSOLUTION has 2 to 24 time points/);
    expect(await refusal(draft(materialCode, [profile({ points: [POINTS[0], { label: '4 h', timeValue: '4', timeUnit: 'h' }] })]))).toMatch(/EBMR-SITE-970 each time point/);
    expect(await refusal(draft(materialCode, [profile({ points: [POINTS[0], { label: '2 h', timeValue: '2', timeUnit: 'days', upperLimit: '50' }] })]))).toMatch(/EBMR-SITE-970/);
    expect(await refusal(draft(materialCode, [profile({ points: [POINTS[1], POINTS[0]] })]))).toMatch(/EBMR-SITE-971 point 1 h of profile DISSOLUTION is not later than point 4 h/);
    expect(await refusal(draft(materialCode, [profile({ points: [POINTS[0], { label: '60 min', timeValue: '60', timeUnit: 'min', upperLimit: '50' }] })]))).toMatch(/EBMR-SITE-971/);
    expect(await refusal(draft(materialCode, [profile({ points: [POINTS[0], { label: '4 h', timeValue: '4', timeUnit: 'h', lowerLimit: '70', upperLimit: '45' }] })]))).toMatch(/EBMR-SITE-971 the lower limit/);
    expect(await refusal(draft(materialCode, [profile({ points: [POINTS[0], { ...POINTS[1], label: '1 h' }] })]))).toMatch(/duplicate key|EBMR-SITE/);
    const spec = await draft(materialCode, [assay, profile()]);
    const { rows } = await db.app.query<{ point_no: number; label: string; time_value: string; time_unit: string; lower_limit: string | null; upper_limit: string | null }>(
      `select p.point_no, p.label, p.time_value::text, p.time_unit, p.lower_limit::text, p.upper_limit::text from site.specification_test_point p
         join site.specification_test t on t.id = p.spec_test_id where t.specification_id = $1 order by p.point_no`, [spec.specificationId]);
    expect(rows).toEqual([
      { point_no: 1, label: '1 h', time_value: '1', time_unit: 'h', lower_limit: null, upper_limit: '40' },
      { point_no: 2, label: '4 h', time_value: '4', time_unit: 'h', lower_limit: '45', upper_limit: '70' },
      { point_no: 3, label: '8 h', time_value: '480', time_unit: 'min', lower_limit: '80', upper_limit: null },
    ]);
    // The approval signs the points with the test; a test without points signs what it signed before.
    const content = (await db.admin.query<{ c: { content: { tests: Json[] } } }>('select site.specification_content($1) as c', [spec.specificationId])).rows[0]!.c;
    expect(content.content.tests.find((t) => t['test_code'] === 'DISSOLUTION')).toMatchObject({ profile: true, lower_limit: null, upper_limit: null, points: [{ label: '1 h' }, { label: '4 h' }, { label: '8 h' }] });
    expect(Object.keys(content.content.tests.find((t) => t['test_code'] === 'ASSAY') ?? {})).not.toContain('points');
    await approveSpec(spec.specificationId);
    // Nothing is written around the commands; an approved specification takes no new point even from the owner's role.
    for (const sql of [
      'update site.specification_test_point set upper_limit = 99 where specification_id = $1',
      'delete from site.specification_test_point where specification_id = $1',
      "insert into site.specification_test_point (specification_id, spec_test_id, point_no, label, time_value, time_unit, upper_limit) select $1, id, 4, '12 h', 12, 'h', 100 from site.specification_test where specification_id = $1 and profile",
    ]) {
      expect(await refusal(db.app.query(sql, [spec.specificationId]))).toMatch(/permission denied/);
    }
    expect(await refusal(withCommand(db.admin, { ...w.cast.analyst, correlationId: randomUUID() }, (c) =>
      c.query("insert into site.specification_test_point (specification_id, spec_test_id, point_no, label, time_value, time_unit, upper_limit) select $1, id, 4, '12 h', 12, 'h', 100 from site.specification_test where specification_id = $1 and profile", [spec.specificationId]),
    ))).toMatch(/EBMR-SITE-974 an approved specification never changes|insert-only|EBMR-/);
    // A profile test written around the command without its points fails at commit.
    const other = await draft(materialCode, [assay]);
    expect(await refusal(withCommand(db.admin, { ...w.cast.analyst, correlationId: randomUUID() }, (c) =>
      c.query("insert into site.specification_test (specification_id, test_code, method_reference, unit, required, pharmacopoeia, edition, sample_quantity, sample_unit, profile) values ($1, 'DISS2', 'STP', '%', true, 'IP', '2022', 1, 'units', true)", [other.specificationId]),
    ))).toMatch(/EBMR-SITE-975 profile DISS2 has 0 time points/);
  });

  it('[IN-33][PR-45] a result names its time point and is judged against that point\'s limits; the lot is released only when every point has an approved result within its limits', async () => {
    const lot = await profiledLot();
    expect(await refusal(result(lot.lotId, { testCode: 'DISSOLUTION', purpose: 'RELEASE', value: '30' }))).toMatch(/EBMR-SITE-972 DISSOLUTION is a profile of the time points 1 h, 4 h, 8 h; a result names one of them, not none/);
    expect(await refusal(result(lot.lotId, { testCode: 'DISSOLUTION', point: '2 h', purpose: 'RELEASE', value: '30' }))).toMatch(/EBMR-SITE-972 .* not 2 h/);
    expect(await refusal(result(lot.lotId, { testCode: 'ASSAY', point: '1 h', purpose: 'RELEASE', value: '99' }))).toMatch(/EBMR-SITE-972 ASSAY is a single test/);
    expect(await refusal(result(lot.lotId, { testCode: 'DISSOLUTION', point: '1 h', purpose: 'RELEASE', value: '30', upperLimit: '100' }))).toMatch(/EBMR-SITE-410/);
    // A missing point keeps the profile open and the lot unreleased.
    const first = await point(lot.lotId, '1 h', '32');
    expect(first.verdict).toBe('PASS');
    expect((await point(lot.lotId, '4 h', '58')).verdict).toBe('PASS');
    expect(await limsProblem(lot.lotId)).toMatch(/time point 8 h of the required profile DISSOLUTION .* has no current RELEASE result/);
    expect((await status(lot.lotId))[0]).toMatchObject({ testCode: 'DISSOLUTION', status: 'OPEN', problem: 'time point 8 h of profile DISSOLUTION has no current RELEASE result' });
    expect(await refusal(releaseLot(lot.lotId))).toMatch(/time point 8 h/);
    // An unapproved point keeps it open too.
    const last = await result(lot.lotId, { testCode: 'DISSOLUTION', point: '8 h', purpose: 'RELEASE', value: '91' });
    expect((await status(lot.lotId))[0]?.status).toBe('OPEN');
    expect(await limsProblem(lot.lotId)).toMatch(/the DISSOLUTION at 8 h result 91 % of the lot is not approved by QC/);
    await approveResult(last.resultId);
    const s = (await status(lot.lotId))[0]!;
    expect(s.status).toBe('PASS');
    expect(s.points.map((p) => [p.label, p.result?.value, p.result?.verdict, p.result?.state])).toEqual([['1 h', '32', 'PASS', 'APPROVED'], ['4 h', '58', 'PASS', 'APPROVED'], ['8 h', '91', 'PASS', 'APPROVED']]);
    expect(await limsProblem(lot.lotId)).toBeNull();
    // The stored limits are the point's; a row written around the command with the test's limits is refused.
    const { rows } = await db.app.query<{ lower_limit: string | null; upper_limit: string | null }>('select lower_limit::text, upper_limit::text from site.lot_test_result where id = $1', [first.resultId]);
    expect(rows[0]).toEqual({ lower_limit: null, upper_limit: '40' });
    const content = (await db.admin.query<{ c: { content: Json } }>('select site.lot_test_result_content($1) as c', [first.resultId])).rows[0]!.c;
    expect(content.content).toMatchObject({ test_code: 'DISSOLUTION', point: '1 h', upper_limit: '40', verdict: 'PASS' });
    await releaseLot(lot.lotId);
    expect((await db.app.query<{ s: string }>("select state as s from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lot.lotId])).rows[0]?.s).toBe('RELEASED');
  });

  it('[IN-33][PR-45][IN-20] one time point out of its limits fails the profile and stops the release; a revision names the same point and its OOS record', async () => {
    const lot = await profiledLot();
    await point(lot.lotId, '1 h', '33');
    const failing = await point(lot.lotId, '4 h', '72.5');
    expect(failing.verdict).toBe('FAIL');
    await point(lot.lotId, '8 h', '88');
    const s = (await status(lot.lotId))[0]!;
    expect(s.status).toBe('FAIL');
    expect(s.problem).toBe('time point 4 h of profile DISSOLUTION: 72.5 % is outside its limits (45 to 70)');
    expect(await limsProblem(lot.lotId)).toMatch(/the approved DISSOLUTION at 4 h result 72.5 % of the lot failed its limits/);
    expect(await refusal(releaseLot(lot.lotId))).toMatch(/DISSOLUTION at 4 h/);
    // The OOS path as for any failing result: an OOS record linked to the lot and to the failing point's result.
    const d = await w.sql<{ deviationId: string }>(w.cast.analyst, 'select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind: 'OOS', title: 'Dissolution 4 h out of limits', classification: 'MAJOR', riskRationale: 'One point of the release profile is outside its limits' }),
    ]);
    await w.sql(w.cast.analyst, "select site.link_deviation($1, 'LOT', $2)", [d.deviationId, lot.lotId]);
    await w.sql(w.cast.analyst, 'select site.link_lot_test_oos($1, $2)', [failing.resultId, d.deviationId]);
    // A revision revises the current result of the same point only; the failure stands until the OOS is concluded.
    const other = (await db.app.query<{ id: string }>("select r.id from site.lot_test_result r join site.specification_test_point p on p.id = r.point_id where r.lot_id = $1 and p.label = '1 h'", [lot.lotId])).rows[0]!.id;
    expect(await refusal(result(lot.lotId, { testCode: 'DISSOLUTION', point: '4 h', purpose: 'RELEASE', value: '60', revises: other, revisionReason: 'Transcription', oosDeviationId: d.deviationId }))).toMatch(/EBMR-SITE-202 .* same lot, test, time point and purpose/);
    const revised = await result(lot.lotId, { testCode: 'DISSOLUTION', point: '4 h', purpose: 'RELEASE', value: '60', revises: failing.resultId, revisionReason: 'Vessel 3 filter clogged', oosDeviationId: d.deviationId });
    await approveResult(revised.resultId);
    expect((await status(lot.lotId))[0]?.status).toBe('PASS');
    expect(await limsProblem(lot.lotId)).toMatch(/the DISSOLUTION at 4 h result 72.5 % of the lot failed its limits and was revised; the failure stands/);
  });

  it('[DI-31][IN-33] a LIMS result names its time point; an unknown point is refused and the database computes the verdict against the point\'s limits', async () => {
    const lot = await profiledLot();
    const send = (over: Json) => receive(db, lims, 'site.receive_lims_sample_result', envelopeFor(lims, 'lims.sample_result', {
      sampleId: unique('S-'), lotNumber: lot.lotCode, testCode: 'DISSOLUTION', specificationRef: 'SPEC-SR-01', result: { value: '35', unit: '%' },
      conformance: 'CONFORMS', state: 'APPROVED', recordedAt: nowUs(), ...over,
    }));
    expect(await refusal(send({}))).toMatch(/EBMR-SITE-973 .* DISSOLUTION is a profile of the time points 1 h, 4 h, 8 h .* not none/);
    expect(await refusal(send({ point: '12 h' }))).toMatch(/EBMR-SITE-973 .* not 12 h/);
    expect(await refusal(send({ testCode: 'ASSAY', point: '1 h' }))).toMatch(/EBMR-SITE-973 .* ASSAY is no profile/);
    expect(await refusal(send({ point: 1 }))).toMatch(/EBMR-LIMS-101/);
    // The LIMS says it conforms; the database judges 4 h at 75 % against 45 to 70 % and records FAIL.
    expect(await send({ point: '1 h', result: { value: '35.0', unit: '%' } })).toMatchObject({ outcome: 'ACCEPTED', applied: 'RECORDED' });
    await send({ point: '4 h', result: { value: '75', unit: '%' } });
    const { rows } = await db.app.query<{ point_label: string; verdict: string; conformance: string }>(
      'select point_label, verdict, conformance from site.lims_sample_result where lot_id = $1 order by received_at', [lot.lotId]);
    expect(rows).toEqual([{ point_label: '1 h', verdict: 'PASS', conformance: 'CONFORMS' }, { point_label: '4 h', verdict: 'FAIL', conformance: 'CONFORMS' }]);
    const s = (await status(lot.lotId))[0]!;
    expect(s.points.map((p) => p.lims?.['verdict'] ?? null)).toEqual(['PASS', 'FAIL', null]);
    // The LIMS row does not release the lot (D-P6a-B-6): the profile stays open until QC records the results.
    expect(s.status).toBe('OPEN');
    const listed = (await db.app.query<{ v: Json[] }>('select site.lims_lot_results($1) as v', [lot.lotId])).rows[0]!.v;
    expect(listed.map((x) => [x['point'], x['verdict']])).toEqual(expect.arrayContaining([['1 h', 'PASS'], ['4 h', 'FAIL']]));
  });
  it('[IN-33][PR-45] a two-stage dissolution (acid stage at most a limit, then buffer stage at least a limit) is one profile with a stage on each point (R8 C4)', async () => {
    const materialCode = unique('DR');
    await w.material(materialCode);
    const acid = { label: 'Acid 2 h', stage: 'Acid 0.1 M HCl', timeValue: '2', timeUnit: 'h', upperLimit: '10' };
    const buffer = { label: 'Buffer 45 min', stage: 'Buffer pH 6.8', timeValue: '45', timeUnit: 'min', lowerLimit: '75' };
    const twoStage = (points: Json[]) => profile({ testCode: 'DISSOLUTION-DR', points });
    // Every point names its stage or none does; a stage's points follow one another; time starts again in a new stage.
    expect(await refusal(draft(materialCode, [twoStage([acid, { ...buffer, stage: undefined }])]))).toMatch(/EBMR-SITE-971 either every point/);
    expect(await refusal(draft(materialCode, [twoStage([acid, buffer, { ...acid, label: 'Acid 3 h', timeValue: '3' }])]))).toMatch(/EBMR-SITE-971 the points of stage Acid 0.1 M HCl/);
    expect(await refusal(draft(materialCode, [twoStage([acid, { ...acid, label: 'Acid 1 h', timeValue: '1' }])]))).toMatch(/EBMR-SITE-971 point Acid 1 h .* not later than point Acid 2 h/);
    await approveSpec((await draft(materialCode, [assay, twoStage([acid, buffer])])).specificationId);
    const lot = await w.lot({ materialCode });
    await approveResult((await result(lot.lotId, { testCode: 'ASSAY', purpose: 'RELEASE', value: '100.1' })).resultId);
    const at = async (label: string, value: string) => {
      const r = await result(lot.lotId, { testCode: 'DISSOLUTION-DR', point: label, purpose: 'RELEASE', value });
      await approveResult(r.resultId);
      return r.verdict;
    };
    // Release in the acid stage above its limit fails the requirement even with a good buffer stage.
    expect(await at('Acid 2 h', '12')).toBe('FAIL');
    expect((await status(lot.lotId))[0]).toMatchObject({ testCode: 'DISSOLUTION-DR', status: 'FAIL' }); // a failure outweighs a missing point
    expect(await at('Buffer 45 min', '88')).toBe('PASS');
    const s = (await status(lot.lotId))[0]!;
    expect(s.status).toBe('FAIL');
    expect(s.points.map((p) => [(p as unknown as Json)['stage'], p.label, p.result?.verdict])).toEqual([['Acid 0.1 M HCl', 'Acid 2 h', 'FAIL'], ['Buffer pH 6.8', 'Buffer 45 min', 'PASS']]);
    expect(await refusal(releaseLot(lot.lotId))).toMatch(/DISSOLUTION-DR at Acid 2 h/);
  });
});

describe('profile limits at their boundaries and profile codes (slice 7p review)', () => {
  it('[IN-33][PR-45] a QC result exactly on a point\'s upper or lower limit passes, at any scale; just beyond it fails (P7P-3)', async () => {
    const lot = await profiledLot();
    const verdict = async (label: string, value: string) => (await result(lot.lotId, { testCode: 'DISSOLUTION', point: label, purpose: 'RELEASE', value })).verdict;
    for (const [label, value, expected] of [
      ['1 h', '40', 'PASS'], ['1 h', '40.0', 'PASS'], ['1 h', '40.000000', 'PASS'], ['1 h', '40.001', 'FAIL'],
      ['4 h', '45', 'PASS'], ['4 h', '45.000', 'PASS'], ['4 h', '44.999', 'FAIL'], ['4 h', '70.00', 'PASS'], ['4 h', '70.01', 'FAIL'],
      ['8 h', '80.0', 'PASS'], ['8 h', '79.9999', 'FAIL'],
    ] as const) {
      expect(`${label} ${value} ${await verdict(label, value)}`).toBe(`${label} ${value} ${expected}`);
    }
  });

  it('[DI-31][IN-33] a LIMS result exactly on a point\'s limit is judged PASS by the database at any scale, just beyond it FAIL, whatever the LIMS says (P7P-3)', async () => {
    const lot = await profiledLot();
    const cases = [
      ['1 h', '40', 'PASS'], ['1 h', '40.0', 'PASS'], ['1 h', '40.01', 'FAIL'],
      ['4 h', '45', 'PASS'], ['4 h', '45.000', 'PASS'], ['4 h', '44.99', 'FAIL'],
    ] as const;
    for (const [label, value] of cases) {
      await receive(db, lims, 'site.receive_lims_sample_result', envelopeFor(lims, 'lims.sample_result', {
        sampleId: unique('S-'), lotNumber: lot.lotCode, testCode: 'DISSOLUTION', specificationRef: 'SPEC-SR-01', point: label, result: { value, unit: '%' },
        conformance: 'DOES_NOT_CONFORM', state: 'APPROVED', recordedAt: nowUs(),
      }));
    }
    const { rows } = await db.app.query<{ point_label: string; raw_value: string; verdict: string }>(
      'select point_label, raw_value, verdict from site.lims_sample_result where lot_id = $1 order by received_at', [lot.lotId]);
    expect(rows.map((r) => [r.point_label, r.raw_value, r.verdict])).toEqual(cases.map((c) => [...c]));
  });

  it('[IN-33] two profiles whose codes differ only in characters other than letters, digits and _ are refused: each is its own release item named from its code (P7P-4)', async () => {
    const materialCode = unique('SR');
    await w.material(materialCode);
    expect(await refusal(draft(materialCode, [profile({ testCode: 'DISS.1' }), profile({ testCode: 'DISS-1' })]))).toMatch(/EBMR-SITE-976 two profile tests/);
    // A profile beside a single test of such a code, or two distinct profile codes, are accepted.
    await draft(materialCode, [profile({ testCode: 'DISS.1' }), { ...assay, testCode: 'DISS-1' }]);
    await draft(materialCode, [profile({ testCode: 'DISS.1' }), profile({ testCode: 'DISS.2' })]);
  });
});
