/**
 * The methods of slice 6A-2 end to end (Phase 6A; ADR 0020; draft controls DI-51, DI-52; DI-09; D-6A-7 to D-6A-10,
 * D-6A-2-*): QA puts SPC.IMR, SPC.XBAR_S, CAP.INDEX, DRIFT.TREND and RATE.DEVIATION version 1 in force through the
 * methods route under an approved change record; the runner runs each on the synthetic history (test-kit
 * analyticsHistory: 30 batches of GB-T-01's product, a one-sigma shift of the granulation end-point from batch 24,
 * room R-2 at three times the others' deviation rate) and the SPC routes show what it recorded, with the master's limits
 * and the recorded values as the source's decimal text and every statistic a StatNumber.
 *
 * TEST FIXTURE: in this test's own database the row functions behind the input views (recipe-core 1115, 1130) are
 * replaced, as the database superuser, by functions of the same signature over the history's view-shaped tables
 * (analyticsHistorySql, schema analytics_fixture), so the runner reads the synthetic history through the real views,
 * grants and snapshot. The views themselves are proven over GMP records in recipe-core's input-views and rate-inputs
 * tests. Subgroup readings (20 tablet weights per batch, five readings shown) are added to the history for Xbar-S.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, RatesView, SpcChartView, StatNumber } from '@ebmr/api-contract';
import { analyticsHistory, analyticsHistorySql, HISTORY_ITEMS, HISTORY_PRODUCT, HISTORY_SEEDS, type AnalyticsHistory } from '@ebmr/test-kit';
import { SPC_METHOD_DEFINITIONS } from '../../src/analytics/spc.ts';
import type { AnalyticsRunner, RunReport } from '../../src/analytics/runner.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

let gmp: TestServer;
let qa: TestBrowser;
let qa2: TestBrowser;
let steward: TestBrowser;
let author: TestBrowser;
let h: AnalyticsHistory;
let reports: RunReport[];

const ENDPOINT = `${HISTORY_PRODUCT.code}|${HISTORY_PRODUCT.family}|${HISTORY_ITEMS.endpoint.item}`;
const chartQuery = { product: HISTORY_PRODUCT.code, family: HISTORY_PRODUCT.family, item: HISTORY_ITEMS.endpoint.item };

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
  select v.batch_id, b.batch_number, v.kind, v.item, v.step, v.attempt, v.reading, v.role, v.value_text, v.unit, v.lower_text, v.upper_text, v.target_text,
         'VALIDATED', v.failed, v.recorded_at, v.item || ':' || v.attempt || ':' || coalesce(v.reading, 0), statement_timestamp(), v.data_as_of
    from analytics_fixture.cpp_value_v1 v join analytics_fixture.batch_fact_v1 b using (batch_id)
$$;
create or replace function report.step_use_rows_v1()
returns table (batch_id uuid, batch_number text, step text, step_id text, equipment_code text, equipment_type text, room_code text,
               started_at timestamptz, ended_at timestamptz, person_ids uuid[], material_lots jsonb, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select s.batch_id, b.batch_number, s.step, s.step, s.equipment_code, s.equipment_type, s.room_code, s.started_at, s.ended_at, s.person_ids, s.material_lots,
         statement_timestamp(), s.data_as_of
    from analytics_fixture.step_use_v1 s join analytics_fixture.batch_fact_v1 b using (batch_id)
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

/** Five readings of the tablet weight per batch (decimal text), for Xbar-S. */
function weightReadings(hist: AnalyticsHistory): string {
  const rows: string[] = [];
  hist.batches.forEach((b, k) => {
    for (let r = 1; r <= 5; r++) {
      const v = (250 + ((k * 7 + r * 13) % 9) - 4 + (k >= 25 ? 1 : 0)).toFixed(1);
      rows.push(`('${b.batch_id}', 'PARAMETER', 'compression.weight', 'compression', 1, ${r.toString()}, 'IPC', '${v}', 'mg', '237.5', '262.5', '250.0', false, '${b.completed_at}')`);
    }
  });
  return `alter table analytics_fixture.cpp_value_v1 add column reading integer;
          insert into analytics_fixture.cpp_value_v1 (batch_id, kind, item, step, attempt, reading, role, value_text, unit, lower_text, upper_text, target_text, failed, recorded_at)
          values ${rows.join(',\n')};`;
}

async function approvedChangeRecord(areas: string[]): Promise<string> {
  const number = `CR-ANA-${randomUUID().slice(0, 8).toUpperCase()}`;
  valueOf(await steward.call(routes.config.raiseChangeRecord, { body: { number, title: 'SPC and rates methods in force', description: 'Advisory analytics methods of slice 6A-2', areas } }));
  const signed = await signAction(gmp, qa2, 'qaApprover2', { kind: 'CONFIG_CHANGE_ACT', act: 'APPROVE', number });
  expect(signed.ok).toBe(true);
  return number;
}

const runner = (): AnalyticsRunner => {
  const r = gmp.built.analytics;
  if (!r) throw new Error('the GMP server started without its analytics runner');
  return r;
};

beforeAll(async () => {
  gmp = await startSigningServer('GMP', { env: { EBMR_ANALYTICS: 'on' }, analytics: { pollMs: 3_600_000 } });
  [qa, qa2, steward, author] = await Promise.all([gmp.asPersona('qaInvestigator'), gmp.asPersona('qaApprover2'), gmp.asPersona('steward'), gmp.asPersona('author')]);
  h = analyticsHistory();
  await gmp.db.admin.query(analyticsHistorySql(h));
  await gmp.db.admin.query(`${weightReadings(h)}
    grant usage on schema analytics_fixture to ebmr_owner;
    grant select on all tables in schema analytics_fixture to ebmr_owner;
    ${ROW_FUNCTIONS}`);
  // QA puts the five methods in force under one approved change record, as the methods page does.
  const changeRecord = await approvedChangeRecord(['ANALYTICS_METHOD']);
  for (const d of SPC_METHOD_DEFINITIONS) {
    valueOf(await qa.call(routes.analyticsConfig.setMethodVersion, {
      body: { method: d.method, version: d.version, status: 'EFFECTIVE', title: d.title, intendedUse: d.intendedUse, acceptanceJson: JSON.stringify(d.acceptance),
              parametersJson: JSON.stringify(d.parameters), validationRef: d.validationRef, changeRecord, reason: 'SPC, capability, drift and rates for CPV support (advisory)' },
    }));
  }
  reports = await runner().runAll('ON_DEMAND');
}, 900_000);
afterAll(async () => {
  await gmp?.close();
});

describe('the SPC, capability, drift and rate methods (slice 6A-2)', () => {
  it('[DI-52] the 6A-2 method versions are in force only under an approved change record, and the runner runs each on its catalogued inputs', async () => {
    const page = valueOf(await qa.call(routes.analytics.methods));
    for (const d of SPC_METHOD_DEFINITIONS) {
      const v = page.versions.find((x) => x.method === d.method && x.version === 1);
      expect(v, d.method).toMatchObject({ status: 'EFFECTIVE', validationRef: d.validationRef, validTo: null, changeRecord: expect.stringMatching(/^CR-ANA-/) as unknown });
    }
    expect(reports.map((r) => [r.method, r.status]).sort()).toEqual(SPC_METHOD_DEFINITIONS.map((d) => [d.method, 'DONE']).sort());
    const { rows } = await gmp.db.admin.query<{ method: string; inputs: { view: string; rows: number }[] }>(
      'select r.method, r.inputs from analytics.run r where r.id = any($1::uuid[])', [reports.map((r) => r.runId)]);
    const rates = rows.find((r) => r.method === 'RATE.DEVIATION')!;
    expect(rates.inputs.map((i) => i.view)).toEqual(['report.batch_fact_v1', 'report.step_use_v1', 'report.step_shift_v1', 'report.deviation_fact_v1']);
    expect(rates.inputs.find((i) => i.view === 'report.deviation_fact_v1')!.rows).toBe(h.deviations.length);
    // A re-run on the same data reproduces every output hash (D-6A-22).
    const again = await runner().runAll('ON_DEMAND');
    for (const r of again) expect(r.outputSha256, r.method).toBe(reports.find((x) => x.method === r.method)!.outputSha256);
  });

  it('[DI-52] the SPC run on the synthetic history flags the seeded shift at batch 24 with Nelson rule 2 and names its reasons', async () => {
    const run = reports.find((r) => r.method === 'SPC.IMR')!.runId;
    const { rows } = await gmp.db.admin.query<{ rule: string; subject_kind: string; subject_ref: string; severity: string; reasons: { code: string; text: string; evidence: { kind: string; ref: string }[] }[] }>(
      'select rule, subject_kind, subject_ref, severity, reasons from analytics.flag where run = $1 and subject_ref = $2', [run, ENDPOINT]);
    const expected = h.expected.find((e) => e.method === 'SPC.IMR')!;
    const nelson2 = rows.find((r) => r.rule === expected.rule)!;
    expect(nelson2).toMatchObject({ subject_kind: expected.subjectKind, subject_ref: expected.subjectRef, severity: 'ATTENTION' });
    const shifted = h.batches.slice(HISTORY_SEEDS.shiftFrom - 1).map((b) => b.batch_id);
    const reason = nelson2.reasons.find((r) => shifted.every((id) => r.evidence.some((e) => e.kind === 'BATCH' && e.ref === id)))!;
    expect(reason.code).toBe('NELSON_2');
    expect(reason.evidence.length).toBeGreaterThanOrEqual(9);
    expect(reason.text).toMatch(/Nelson rule 2: nine or more points in a row on one side of the centre line \(above the centre line\)/);
    expect(reason.text).toContain(`to ${h.batches[29]!.batch_number}`);
    // The run starts no later than the seeded run (batch 22), before the shift itself.
    const firstId = reason.evidence[0]!.ref;
    expect(h.batches.findIndex((b) => b.batch_id === firstId) + 1).toBeLessThanOrEqual(HISTORY_SEEDS.nelsonRunFrom);
    // The hardness and thickness charts are drawn too; the subgrouped weight has its Xbar-S chart.
    const { rows: outputs } = await gmp.db.admin.query<{ subject_ref: string; method: string }>(
      "select o.subject_ref, r.method from analytics.output o join analytics.run r on r.id = o.run where o.run = any($1::uuid[]) and o.kind = 'CONTROL_CHART' order by 1",
      [reports.filter((r) => r.method.startsWith('SPC.')).map((r) => r.runId)]);
    expect(outputs.map((o) => [o.subject_ref.split('|')[2], o.method])).toEqual([
      ['compression.hardness', 'SPC.IMR'], ['compression.thickness', 'SPC.IMR'], ['compression.weight', 'SPC.XBAR_S'], ['granulation.endpoint', 'SPC.IMR'],
    ]);
  });

  it('[DI-51] the SPC response echoes the master\'s limits as the source\'s decimal text and types statistics as StatNumber', async () => {
    const chart = valueOf(await qa.call(routes.analyticsSpc.chart, { query: chartQuery }));
    expect(SpcChartView.parse(chart)).toEqual(chart);
    expect(chart).toMatchObject({ advisory: true, notForGmpDecisions: true, method: { id: 'SPC.IMR', version: 1 }, chart: 'IMR', limitsSource: 'PHASE_I',
                                  specification: { lower: HISTORY_ITEMS.endpoint.lower, upper: HISTORY_ITEMS.endpoint.upper, target: HISTORY_ITEMS.endpoint.target, unit: 'A' } });
    expect(chart.specification).toEqual({ lower: '7.00', upper: '8.00', target: '7.50', unit: 'A' });
    const recorded = new Map(h.cppValues.filter((v) => v.item === HISTORY_ITEMS.endpoint.item).map((v) => [v.batch_id, v.value_text]));
    expect(chart.points.map((p) => p.batchNumber)).toEqual(h.batches.map((b) => b.batch_number));
    for (const p of chart.points) {
      expect(p.value, p.batchNumber).toBe(recorded.get(p.batchId));
      expect(StatNumber.safeParse(p.plotted).success).toBe(true);
      expect(p.drill).toBe(`/review/${p.batchId}`);
    }
    for (const s of [chart.centre, chart.upperControl, chart.lowerControl, chart.spreadChart!.upper]) expect(typeof s).toBe('number');
    expect(chart.lowerControl).toBeLessThan(chart.centre);
    expect(chart.points[0]!.spread).toBeNull();
    expect(chart.points[HISTORY_SEEDS.shiftFrom - 1]!.rules).toContain('NELSON_2');
    expect(chart.flags.map((f) => f.rule)).toContain('NELSON_2');
    // The chart is the newest SPC.IMR run's (the re-run above reproduced it).
    const { rows: newest } = await gmp.db.admin.query<{ id: string }>("select r.id::text from analytics.run r join analytics.run_end e on e.run = r.id where r.method = 'SPC.IMR' order by e.ended_at desc limit 1");
    expect(chart.run!.id).toBe(newest[0]!.id);
    // The capability panel: 30 batches, shown, with intervals; the subgrouped chart has its S chart.
    const cap = valueOf(await qa.call(routes.analyticsSpc.capability, { query: chartQuery }));
    expect(cap).toMatchObject({ method: { id: 'CAP.INDEX', version: 1 }, batches: 30, shown: true, notShownReason: null, specification: chart.specification });
    expect(cap.cpk!.lower).toBeLessThan(cap.cpk!.value);
    expect(cap.ppk!.upper).toBeGreaterThan(cap.ppk!.value);
    expect(cap.normality!.note.length).toBeGreaterThan(0);
    const xbar = valueOf(await qa.call(routes.analyticsSpc.chart, { query: { ...chartQuery, item: 'compression.weight' } }));
    expect(xbar).toMatchObject({ chart: 'XBAR_S', method: { id: 'SPC.XBAR_S' }, specification: { lower: '237.5', upper: '262.5', target: '250.0', unit: 'mg' }, spreadChart: { kind: 'S' } });
    expect(xbar.points.every((p) => p.value === null && typeof p.spread === 'number')).toBe(true);
  });

  it('[DI-52] the deviation-rate comparison finds the seeded room and keeps the others within limits', async () => {
    const view = valueOf(await qa.call(routes.analyticsSpc.rates, { query: { product: HISTORY_PRODUCT.code, by: 'ROOM' } }));
    expect(RatesView.parse(view)).toEqual(view);
    expect(view).toMatchObject({ method: { id: 'RATE.DEVIATION', version: 1 }, overall: { batches: 30, withDeviation: 15, share: 0.5, unattributedDeviations: 0 } });
    expect(view.groups.map((g) => [g.group, g.batches, g.withDeviation, g.above])).toEqual([['R-1', 10, 3, false], ['R-2', 10, 9, true], ['R-3', 10, 3, false]]);
    const r2 = view.groups.find((g) => g.group === 'R-2')!;
    expect(r2.qValue).toBeLessThanOrEqual(0.1);
    expect(r2.share.value).toBeGreaterThan(r2.funnel!.upper);
    for (const g of view.groups.filter((x) => x.group !== 'R-2')) expect(g.share.value).toBeLessThanOrEqual(g.funnel!.upper);
    // The granulation room holds every batch: nothing to compare it with, reported as such.
    expect(view.skipped).toEqual([{ subject: 'R-G', reason: 'no batch of the product outside the group to compare with' }]);
    expect(view.flags.map((f) => [f.rule, f.subjectRef])).toEqual([['RATE_ABOVE', `${HISTORY_PRODUCT.code}|ROOM:R-2`]]);
    // Across every grouping the room is the only group raised (the history's expected flag).
    const { rows } = await gmp.db.admin.query<{ subject_ref: string }>('select subject_ref from analytics.flag where run = $1', [reports.find((r) => r.method === 'RATE.DEVIATION')!.runId]);
    const expected = h.expected.find((e) => e.method === 'RATE.DEVIATION')!;
    expect(rows.map((r) => r.subject_ref)).toEqual([`${HISTORY_PRODUCT.code}|${expected.subjectRef}`]);
    // A period the comparison does not lie within has none; equipment and shift are compared as well.
    expect(refusalOf(await qa.call(routes.analyticsSpc.rates, { query: { product: HISTORY_PRODUCT.code, by: 'ROOM', from: '2026-06-10', to: '2026-06-20' } }))).toMatchObject({ status: 404, code: 'EBMR-ANA-021' });
    const eq = valueOf(await qa.call(routes.analyticsSpc.rates, { query: { product: HISTORY_PRODUCT.code, by: 'EQUIPMENT', from: '2026-05-01', to: '2026-12-31' } }));
    expect(eq.groups.map((g) => [g.group, g.above])).toEqual([['PRESS-01', false], ['PRESS-02', false]]);
  });

  it('[DI-51] every SPC read needs ANALYTICS.VIEW; an item without a chart answers 404', async () => {
    expect(refusalOf(await author.call(routes.analyticsSpc.chart, { query: chartQuery }))).toMatchObject({ code: 'EBMR-IAM-040' });
    expect(refusalOf(await qa.call(routes.analyticsSpc.chart, { query: { ...chartQuery, item: 'no.such.item' } }))).toMatchObject({ status: 404, code: 'EBMR-ANA-021' });
    expect(refusalOf(await qa.call(routes.analyticsSpc.capability, { query: { ...chartQuery, product: 'NONE' } }))).toMatchObject({ status: 404 });
  });
});
