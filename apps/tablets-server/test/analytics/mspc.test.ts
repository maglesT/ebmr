/**
 * Slice 6A-3 end to end (Phase 6A; ADR 0020; draft controls DI-51, DI-52; DI-09; D-6A-11, D-6A-3-*): QA puts MSPC.PCA
 * and SPC.IMR version 1 in force through the methods route under an approved change record; the runner fits the model
 * candidates on the synthetic history (test-kit analyticsHistory: 30 released batches of GB-T-01's product; batch 27
 * within every limit, its hardness and thickness out of their correlation); QA makes a candidate the reference set under
 * a change record approved for ANALYTICS_REFERENCE; the next run scores the batches against it (reference sets in runs,
 * read through report.analytics_reference_v1 as slice 6A-6 does), and the routes show what it recorded. The same for an
 * SPC chart's Phase I limits. Later runs raise the same open flag again; the flags list shows it once.
 *
 * TEST FIXTURE: as in spc.test.ts, the row functions behind the input views (recipe-core 1115, 1130) are replaced in
 * this test's own database, as the database superuser, by functions of the same signature over the history's
 * view-shaped tables (analyticsHistorySql, schema analytics_fixture), so the runner reads the synthetic history through
 * the real views, grants and snapshot. The views themselves are proven over GMP records in recipe-core's tests.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MspcBatchView, MspcChartView, routes } from '@ebmr/api-contract';
import { analyticsHistory, analyticsHistorySql, HISTORY_ITEMS, HISTORY_PRODUCT, HISTORY_SEEDS, type AnalyticsHistory } from '@ebmr/test-kit';
import { MSPC_METHOD_DEFINITION } from '../../src/analytics/mspc.ts';
import type { AnalyticsRunner } from '../../src/analytics/runner.ts';
import { SPC_METHOD_DEFINITIONS, type MethodDefinition } from '../../src/analytics/spc.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

let gmp: TestServer;
let qa: TestBrowser;
let qa2: TestBrowser;
let steward: TestBrowser;
let h: AnalyticsHistory;

const SCOPE = { product: HISTORY_PRODUCT.code, family: HISTORY_PRODUCT.family };

const ROW_FUNCTIONS = `
create or replace function report.batch_fact_rows_v1()
returns table (batch_id uuid, batch_number text, product_code text, strength text, mbr_version_id uuid, family_code text, record_kind text,
               status text, issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select f.batch_id, f.batch_number, f.product_code, f.strength, f.mbr_version_id, f.family_code, 'PROCESSING', f.status, f.issued_at, f.completed_at, f.released,
         statement_timestamp(), f.data_as_of from analytics_fixture.batch_fact_v1 f
$$;
create or replace function report.cpp_value_rows_v1()
returns table (batch_id uuid, batch_number text, kind text, item text, step text, attempt integer, reading integer, role text, value_text text, unit text,
               lower_text text, upper_text text, target_text text, limit_tier text, failed boolean, recorded_at timestamptz, ref text,
               read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select v.batch_id, b.batch_number, v.kind, v.item, v.step, v.attempt, null::integer, v.role, v.value_text, v.unit, v.lower_text, v.upper_text, v.target_text,
         'VALIDATED', v.failed, v.recorded_at, v.item || ':' || v.attempt, statement_timestamp(), v.data_as_of
    from analytics_fixture.cpp_value_v1 v join analytics_fixture.batch_fact_v1 b using (batch_id)
$$;
create or replace function report.deviation_fact_rows_v1()
returns table (deviation_id uuid, deviation_ref text, deviation_kind text, classification text, raised_at timestamptz, batch_id uuid, batch_number text,
               step text, equipment_code text, room_code text, material_lot text, supplier_code text, shift text, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select d.deviation_id, 'DEV-' || d.deviation_id, 'DEVIATION', d.classification, d.raised_at, d.batch_id, b.batch_number, d.step, d.equipment_code, d.room_code,
         d.material_lot, d.supplier_code, d.shift, statement_timestamp(), d.data_as_of
    from analytics_fixture.deviation_fact_v1 d join analytics_fixture.batch_fact_v1 b using (batch_id)
$$;
`;

async function approvedChangeRecord(areas: string[]): Promise<string> {
  const number = `CR-ANA-${randomUUID().slice(0, 8).toUpperCase()}`;
  valueOf(await steward.call(routes.config.raiseChangeRecord, { body: { number, title: 'Multivariate monitoring', description: 'Advisory analytics of slice 6A-3', areas } }));
  const signed = await signAction(gmp, qa2, 'qaApprover2', { kind: 'CONFIG_CHANGE_ACT', act: 'APPROVE', number });
  expect(signed.ok).toBe(true);
  return number;
}

const runner = (): AnalyticsRunner => {
  const r = gmp.built.analytics;
  if (!r) throw new Error('the GMP server started without its analytics runner');
  return r;
};

const putInForce = async (d: MethodDefinition, changeRecord: string): Promise<void> => {
  valueOf(await qa.call(routes.analyticsConfig.setMethodVersion, {
    body: { method: d.method, version: d.version, status: 'EFFECTIVE', title: d.title, intendedUse: d.intendedUse, acceptanceJson: JSON.stringify(d.acceptance),
            parametersJson: JSON.stringify(d.parameters), validationRef: d.validationRef, changeRecord, reason: 'Multivariate monitoring and SPC reference limits (advisory)' },
  }));
};

const b = (n: number) => h.batches[n - 1]!;

beforeAll(async () => {
  gmp = await startSigningServer('GMP', { env: { EBMR_ANALYTICS: 'on' }, analytics: { pollMs: 3_600_000 } });
  [qa, qa2, steward] = await Promise.all([gmp.asPersona('qaInvestigator'), gmp.asPersona('qaApprover2'), gmp.asPersona('steward')]);
  h = analyticsHistory();
  await gmp.db.admin.query(analyticsHistorySql(h));
  await gmp.db.admin.query(`grant usage on schema analytics_fixture to ebmr_owner;
    grant select on all tables in schema analytics_fixture to ebmr_owner;
    ${ROW_FUNCTIONS}`);
  const changeRecord = await approvedChangeRecord(['ANALYTICS_METHOD']);
  await putInForce(MSPC_METHOD_DEFINITION, changeRecord);
  await putInForce(SPC_METHOD_DEFINITIONS.find((d) => d.method === 'SPC.IMR')!, changeRecord);
}, 900_000);
afterAll(async () => {
  await gmp?.close();
});

describe('multivariate monitoring (MSPC.PCA, slice 6A-3)', () => {
  it('[DI-52] the multivariate run flags the seeded batch 27 within every limit and names the top contributing variables', async () => {
    // No reference set yet: the run fits a candidate and scores nothing; the chart answers 404 with what is missing.
    const first = await runner().runAll('ON_DEMAND');
    expect(first.map((r) => [r.method, r.status, r.referenceSet ?? null])).toEqual([['MSPC.PCA', 'DONE', null], ['SPC.IMR', 'DONE', null]]);
    expect(first[0]).toMatchObject({ outputs: 1, flags: 0 });
    expect(refusalOf(await qa.call(routes.analyticsMspc.chart, { query: SCOPE }))).toMatchObject({ status: 404, code: 'EBMR-ANA-031' });
    const cands = valueOf(await qa.call(routes.analyticsMspc.candidates));
    expect(cands).toMatchObject({ advisory: true, notForGmpDecisions: true, method: null, run: null });
    expect(cands.candidates).toHaveLength(1);
    const cand = cands.candidates[0]!;
    expect(cand).toMatchObject({ ...SCOPE, batches: 29, components: 2, referenceSet: null, variables: Object.values(HISTORY_ITEMS).map((i) => i.item).sort() });
    // Batch 27 is left out of the candidate: beyond its first fit's Phase I limits.
    expect(cand.skipped).toEqual([{ subject: b(27).batch_id, reason: expect.stringMatching(/^EXZ250-26-027: beyond the first fit's Phase I limits/) as string }]);
    expect(cand.batchIds).not.toContain(b(27).batch_id);

    // QA makes it the reference set under a change record approved for ANALYTICS_REFERENCE.
    const body = { method: 'MSPC.PCA' as const, scope: SCOPE, batchIds: cand.batchIds!, candidateOutput: cand.outputId, status: 'EFFECTIVE' as const, reason: 'Twenty-nine released batches without critical deviation' };
    const set = valueOf(await qa.call(routes.analyticsConfig.setReferenceSet, { body: { ...body, changeRecord: await approvedChangeRecord(['ANALYTICS_REFERENCE']) } })).referenceSet;
    expect(set).toMatchObject({ method: 'MSPC.PCA', status: 'EFFECTIVE', modelSha256: cand.modelSha256 });

    // The next run: the candidates again, then the scoring run against the set; only batch 27 is flagged, by Q.
    const second = await runner().runAll('ON_DEMAND');
    const scored = second.find((r) => r.method === 'MSPC.PCA' && r.referenceSet === set.referenceSetId)!;
    expect(scored).toMatchObject({ status: 'DONE', outputs: 30, flags: 1 });
    const { rows: run } = await gmp.db.admin.query<{ reference_set: string; inputs: { view: string; filter: unknown }[] }>('select reference_set::text, inputs from analytics.run where id = $1', [scored.runId]);
    expect(run[0]!.reference_set).toBe(set.referenceSetId);
    expect(run[0]!.inputs.map((i) => [i.view, i.filter])).toEqual([
      ['report.batch_fact_v1', { product_code: SCOPE.product, family_code: SCOPE.family }], ['report.cpp_value_v1', null], ['report.deviation_fact_v1', null],
      ['report.analytics_reference_v1', { method: 'MSPC.PCA', reference_set_id: set.referenceSetId }],
    ]);

    const chart = valueOf(await qa.call(routes.analyticsMspc.chart, { query: SCOPE }));
    expect(MspcChartView.safeParse(chart).success).toBe(true);
    expect(chart).toMatchObject({ advisory: true, notForGmpDecisions: true, method: { id: 'MSPC.PCA', version: 1 }, referenceSet: set.referenceSetId, components: 2 });
    expect(chart.batches).toHaveLength(30);
    expect(chart.batches.filter((x) => x.flagged).map((x) => [x.batchNumber, x.reference])).toEqual([[b(27).batch_number, false]]);
    const b27 = chart.batches.find((x) => x.batchId === b(27).batch_id)!;
    expect(b27.q).toBeGreaterThan(chart.limits.q);
    expect(b27.t2).toBeLessThanOrEqual(b27.t2Limit!);
    expect(b27.t2Limit).toBe(chart.limits.t2);
    expect(chart.batches.find((x) => x.reference)!.t2Limit).toBe(chart.limits.t2Reference);
    expect(chart.flags.map((f) => [f.rule, f.subjectRef, f.subjectLabel])).toEqual([['Q_ABOVE', b(27).batch_id, b(27).batch_id]]);
    const reason = chart.flags[0]!.reasons[0]!.text;
    expect(reason).toMatch(/^Q residual \S+ against its 99 % limit \S+: the combination of values departs from the reference batches' correlation; top contributors /);
    expect(reason).toContain(HISTORY_ITEMS.hardness.item);
    expect(reason).toContain(HISTORY_ITEMS.thickness.item);
    expect(reason).not.toContain(HISTORY_ITEMS.endpoint.item);

    // The batch's contributions, largest Q first: hardness and thickness, with the values as recorded (decimal text),
    // each within the master's limits.
    const view = valueOf(await qa.call(routes.analyticsMspc.batch, { params: { batchId: b(27).batch_id } }));
    expect(MspcBatchView.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({ ...SCOPE, referenceSet: set.referenceSetId, reference: false });
    expect(view.contributions.slice(0, 2).map((c) => c.variable).sort()).toEqual([HISTORY_ITEMS.hardness.item, HISTORY_ITEMS.thickness.item].sort());
    for (const c of view.contributions) {
      const item = Object.values(HISTORY_ITEMS).find((i) => i.item === c.variable)!;
      const recorded = h.cppValues.filter((v) => v.batch_id === b(27).batch_id && v.item === c.variable).sort((x, y) => y.attempt - x.attempt)[0]!.value_text;
      expect(c.value).toBe(recorded);
      expect(Number(c.value)).toBeGreaterThanOrEqual(Number(item.lower));
      expect(Number(c.value)).toBeLessThanOrEqual(Number(item.upper));
    }
    expect(view.flags.map((f) => f.rule)).toEqual(['Q_ABOVE']);
    expect(refusalOf(await qa.call(routes.analyticsMspc.batch, { params: { batchId: randomUUID() } }))).toMatchObject({ status: 404, code: 'EBMR-ANA-032' });
    // The newest candidate (refitted by the run without a set, the same model) names the reference set in force.
    const newest = valueOf(await qa.call(routes.analyticsMspc.candidates)).candidates[0]!;
    expect(newest.outputId).not.toBe(cand.outputId);
    expect(newest).toMatchObject({ modelSha256: cand.modelSha256, referenceSet: set.referenceSetId });
    // The expected flag of the history is this one.
    expect(h.expected.find((e) => e.method === 'MSPC.PCA')).toMatchObject({ rule: 'Q_ABOVE', subjectRef: b(HISTORY_SEEDS.brokenCorrelation).batch_id });
  });

  it('[DI-52] a reference set whose model hash differs from its candidate is refused', async () => {
    const cand = valueOf(await qa.call(routes.analyticsMspc.candidates)).candidates[0]!;
    const cr = await approvedChangeRecord(['ANALYTICS_REFERENCE']);
    const body = { method: 'MSPC.PCA' as const, scope: SCOPE, batchIds: cand.batchIds!, candidateOutput: cand.outputId, status: 'EFFECTIVE' as const, changeRecord: cr, reason: 'Hash check' };
    // An output that is not a model candidate carries no model hash; another method's candidate is not this method's.
    const { rows: score } = await gmp.db.admin.query<{ id: string }>("select id::text from analytics.output where kind = 'MSPC_SCORE' limit 1");
    expect(refusalOf(await qa.call(routes.analyticsConfig.setReferenceSet, { body: { ...body, candidateOutput: score[0]!.id } }))).toMatchObject({ status: 422, code: 'EBMR-ANA-010' });
    expect(refusalOf(await qa.call(routes.analyticsConfig.setReferenceSet, { body: { ...body, method: 'SPC.IMR' } }))).toMatchObject({ status: 422, code: 'EBMR-ANA-010' });
    // Other batches than the candidate's are refused too (kernel 1270).
    expect(refusalOf(await qa.call(routes.analyticsConfig.setReferenceSet, { body: { ...body, batchIds: cand.batchIds!.slice(1) } }))).toMatchObject({ status: 422, code: 'EBMR-ANA-030' });
  });

  it('[DI-09] a reference set without an approved change record is refused', async () => {
    const cand = valueOf(await qa.call(routes.analyticsMspc.candidates)).candidates[0]!;
    const body = { method: 'MSPC.PCA' as const, scope: SCOPE, batchIds: cand.batchIds!, candidateOutput: cand.outputId, status: 'EFFECTIVE' as const, reason: 'No change record' };
    const none = refusalOf(await qa.call(routes.analyticsConfig.setReferenceSet, { body: { ...body, changeRecord: 'CR-NOT-THERE' } }));
    expect(`${none.code} ${none.why}`).toMatch(/EBMR-CFG-002/);
    // Raised but not approved; approved but for another area: both refused.
    const raised = `CR-ANA-${randomUUID().slice(0, 8).toUpperCase()}`;
    valueOf(await steward.call(routes.config.raiseChangeRecord, { body: { number: raised, title: 'Not approved', description: 'Raised only', areas: ['ANALYTICS_REFERENCE'] } }));
    const unapproved = refusalOf(await qa.call(routes.analyticsConfig.setReferenceSet, { body: { ...body, changeRecord: raised } }));
    expect(`${unapproved.code} ${unapproved.why}`).toMatch(/EBMR-CFG-00[1-4]/);
    const methodOnly = refusalOf(await qa.call(routes.analyticsConfig.setReferenceSet, { body: { ...body, changeRecord: await approvedChangeRecord(['ANALYTICS_METHOD']) } }));
    expect(`${methodOnly.code} ${methodOnly.why}`).toMatch(/EBMR-CFG-00[1-4]/);
    const { rows } = await gmp.db.admin.query<{ n: number }>("select count(*)::int as n from analytics.reference_set where method = 'MSPC.PCA'");
    expect(rows[0]!.n).toBe(1);
  });

  it('[DI-52] an SPC chart uses the limits of a reference set made from its Phase I candidate; the run without a set leaves that chart to it', async () => {
    const q = { ...SCOPE, item: HISTORY_ITEMS.hardness.item };
    const phaseOne = valueOf(await qa.call(routes.analyticsSpc.chart, { query: q }));
    expect(phaseOne).toMatchObject({ limitsSource: 'PHASE_I', referenceSet: null });
    const c = phaseOne.candidate!;
    expect(c.batches).toBe(20);
    expect([...c.batchIds].sort()).toEqual(h.batches.slice(0, 20).map((x) => x.batch_id).sort());
    // A scope that is not the model's is accepted by the route, but its run fails with the reason (the runner checks).
    const cr = await approvedChangeRecord(['ANALYTICS_REFERENCE']);
    const body = { method: 'SPC.IMR' as const, batchIds: c.batchIds, candidateOutput: c.outputId, status: 'EFFECTIVE' as const, changeRecord: cr, reason: 'Phase I limits of the hardness chart' };
    const wrong = valueOf(await qa.call(routes.analyticsConfig.setReferenceSet, { body: { ...body, scope: { ...q, item: HISTORY_ITEMS.thickness.item, chart: 'IMR' } } })).referenceSet;
    let reports = await runner().runAll('ON_DEMAND');
    expect(reports.find((r) => r.referenceSet === wrong.referenceSetId)).toMatchObject({ method: 'SPC.IMR', status: 'FAILED', error: expect.stringMatching(/its scope is not its model's/) as string });
    valueOf(await qa.call(routes.analyticsConfig.setReferenceSet, { body: { ...body, referenceSetId: wrong.referenceSetId, scope: wrong.scope, batchIds: wrong.batchIds, status: 'RETIRED', reason: 'Wrong scope, retired' } }));
    const set = valueOf(await qa.call(routes.analyticsConfig.setReferenceSet, { body: { ...body, scope: { ...q, chart: 'IMR' } } })).referenceSet;
    reports = await runner().runAll('ON_DEMAND');
    const own = reports.find((r) => r.referenceSet === set.referenceSetId)!;
    expect(own).toMatchObject({ method: 'SPC.IMR', status: 'DONE', outputs: 1 });
    const chart = valueOf(await qa.call(routes.analyticsSpc.chart, { query: q }));
    expect(chart).toMatchObject({ limitsSource: 'REFERENCE_SET', referenceSet: set.referenceSetId, candidate: null, centre: phaseOne.centre, upperControl: phaseOne.upperControl });
    expect(chart.run?.id).toBe(own.runId);
    // The run without a set no longer charts hardness (it says why), and still charts the other items.
    const plain = reports.find((r) => r.method === 'SPC.IMR' && !r.referenceSet)!;
    const { rows } = await gmp.db.admin.query<{ subject_ref: string; kind: string }>("select subject_ref, kind from analytics.output where run = $1 and kind = 'CONTROL_CHART' order by 1", [plain.runId]);
    expect(rows.map((r) => r.subject_ref).sort()).toEqual([`${SCOPE.product}|${SCOPE.family}|${HISTORY_ITEMS.endpoint.item}`, `${SCOPE.product}|${SCOPE.family}|${HISTORY_ITEMS.thickness.item}`].sort());
    const { rows: counts } = await gmp.db.admin.query<{ counts: { skipped: number } }>('select counts from analytics.run_end where run = $1', [plain.runId]);
    expect(counts[0]!.counts.skipped).toBeGreaterThanOrEqual(1);
  });

  it('[DI-52] later runs raise an open flag again; the open flags list shows it once with how often it was raised, and every raise stays recorded', async () => {
    const open = valueOf(await qa.call(routes.analytics.flags, { query: {} })).flags.filter((f) => f.method.id === 'MSPC.PCA');
    expect(open.map((f) => f.rule)).toEqual(['Q_ABOVE']);
    const { rows } = await gmp.db.admin.query<{ n: number }>("select count(*)::int as n from analytics.flag f join analytics.run r on r.id = f.run where r.method = 'MSPC.PCA' and f.rule = 'Q_ABOVE'");
    expect(rows[0]!.n).toBeGreaterThanOrEqual(3);
    expect(open[0]!.raisedCount).toBe(rows[0]!.n);
    expect(open[0]!.firstRaisedAt!.us < open[0]!.raisedAt.us).toBe(true);
    // QA dispositions it once; the same hit raised again by the next run stays closed.
    valueOf(await qa.call(routes.analytics.dispose, { params: { flagId: open[0]!.flagId }, body: { verdict: 'TRUE_SIGNAL', cause: 'Punch wear on press 1 changed the hardness-thickness relation' } }));
    await runner().runAll('ON_DEMAND');
    expect(valueOf(await qa.call(routes.analytics.flags, { query: {} })).flags.filter((f) => f.method.id === 'MSPC.PCA')).toEqual([]);
    const { rows: after } = await gmp.db.admin.query<{ n: number }>("select count(*)::int as n from analytics.flag f join analytics.run r on r.id = f.run where r.method = 'MSPC.PCA' and f.rule = 'Q_ABOVE'");
    expect(after[0]!.n).toBe(rows[0]!.n + 1);
  });
});
