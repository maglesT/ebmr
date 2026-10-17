/**
 * The golden batch profile end to end (Phase 6A slice 6A-6; method GBP.DTW_BAND; recipe-core 1170; contract
 * ns/analytics-profile.ts; ADR 0020; draft controls DI-51, DI-52; DI-32, DI-09; D-6A-16, D-6A-6-1 to D-6A-6-8): the
 * runner reads the native press series of the synthetic history as ebmr_analytics, fits a model candidate on the
 * batches that may be reference batches, QA makes it a reference set under an approved change record, and the next run
 * flags the abnormal curve and none of the 20 normal ones. The profile overlay repeats the raw samples as recorded,
 * nothing outside the analytics schema changes, and a step without a series has no profile.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { callQuery, inputQuery, InputSpecError } from '../../src/analytics/inputs.ts';
import { assembleProfile } from '../../src/analytics/profile.ts';
import type { AnalyticsRunner } from '../../src/analytics/runner.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';
import { PROFILE_STEP, PROFILE_TAG, seedPressHistory, type ProfileBatch } from './profile-support.ts';
import { releaseMethodVersion } from './support.ts';

let gmp: TestServer;
let qa: TestBrowser;
let qa2: TestBrowser;
let steward: TestBrowser;
let author: TestBrowser;
let batches: ProfileBatch[];
let abnormal: ProfileBatch;

const runner = (): AnalyticsRunner => {
  const r = gmp.built.analytics;
  if (!r) throw new Error('the GMP server started without its analytics runner');
  return r;
};

/** A change record covering `areas`, raised by the steward and approved by QA's signature (as routes.test.ts). */
async function approvedChangeRecord(areas: string[]): Promise<string> {
  const number = `CR-GBP-${randomUUID().slice(0, 8).toUpperCase()}`;
  valueOf(await steward.call(routes.config.raiseChangeRecord, { body: { number, title: 'Golden batch profile reference set', description: 'Advisory golden profile reference batches', areas } }));
  const signed = await signAction(gmp, qa2, 'qaApprover2', { kind: 'CONFIG_CHANGE_ACT', act: 'APPROVE', number });
  expect(signed.ok).toBe(true);
  return number;
}

/** A fingerprint of the GMP rows the profile reads: the native series, the step bindings and the batch records. */
async function gmpFingerprint(): Promise<Record<string, string>> {
  const ids = batches.map((b) => b.id);
  const { rows } = await gmp.db.admin.query<{ k: string; h: string }>(
    `select 'plant.series' as k, md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) as h from plant.series s
     union all select 'plant.step_equipment', md5(coalesce(string_agg(to_jsonb(e)::text, '|' order by e.batch_id, e.step), '')) from plant.step_equipment e
     union all select 'recipe.batch_execution', md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from recipe.batch_execution x where x.id = any($1::uuid[])
     union all select 'recipe.execution_state', md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.batch_id), '')) from recipe.execution_state x where x.batch_id = any($1::uuid[])
     union all select 'audit outside analytics', count(*)::text from kernel.audit_event where table_name is not null and table_name not like 'analytics.%'`,
    [ids],
  );
  return Object.fromEntries(rows.map((r) => [r.k, r.h]));
}

beforeAll(async () => {
  gmp = await startSigningServer('GMP', { env: { EBMR_ANALYTICS: 'on' }, analytics: { pollMs: 3_600_000 } });
  [qa, qa2, steward, author] = await Promise.all([gmp.asPersona('qaInvestigator'), gmp.asPersona('qaApprover2'), gmp.asPersona('steward'), gmp.asPersona('author')]);
  // Batch 18 is the abnormal curve; a deviation linked to it keeps it out of the reference batches (D-6A-6-2).
  ({ batches } = await seedPressHistory(gmp, { deviationOn: [18] }));
  abnormal = batches.find((b) => b.abnormal)!;
  await releaseMethodVersion(gmp, 'GBP.DTW_BAND', 1);
}, 900_000);
afterAll(async () => {
  await gmp?.close();
});

describe('the golden batch profile (GBP.DTW_BAND)', () => {
  it('[DI-52] the seeded abnormal press curve is flagged and the 20 normal ones are not', async () => {
    // No reference set yet: the run fits a model candidate and flags nothing; the profile route has none yet.
    const first = await runner().runAll('ON_DEMAND');
    expect(first.map((r) => [r.method, r.status, r.referenceSet ?? null, r.outputs, r.flags])).toEqual([['GBP.DTW_BAND', 'DONE', null, 1, 0]]);
    expect(refusalOf(await qa.call(routes.analyticsProfile.batch, { query: { batch: abnormal.id, step: PROFILE_STEP, tag: PROFILE_TAG } }))).toMatchObject({ status: 404, code: 'EBMR-ANA-061' });
    const cands = valueOf(await qa.call(routes.analyticsProfile.candidates));
    expect(cands).toMatchObject({ advisory: true, notForGmpDecisions: true, method: null, run: null });
    expect(cands.candidates).toHaveLength(1);
    const cand = cands.candidates[0]!;
    expect(cand).toMatchObject({ equipmentType: 'TABLET_PRESS', step: PROFILE_STEP, tag: PROFILE_TAG, unit: 'kN', batches: 20, referenceSet: null });
    expect([...cand.batchIds].sort()).toEqual(batches.filter((b) => !b.abnormal).map((b) => b.id).sort());
    expect(cand.skipped).toEqual([{ subject: abnormal.id, reason: expect.stringMatching(/^GBP-.*: 1 deviation\(s\) linked to the batch$/) as string }]);

    // QA makes the candidate a reference set under an approved change record (ANALYTICS_REFERENCE; DI-09, DI-52).
    const body = {
      method: 'GBP.DTW_BAND' as const, scope: { productCode: cand.productCode, familyCode: cand.familyCode, equipmentType: cand.equipmentType, step: cand.step, tag: cand.tag },
      batchIds: cand.batchIds, candidateOutput: cand.outputId, status: 'EFFECTIVE' as const, reason: 'Twenty released press curves without deviation or alarm',
    };
    const refused = refusalOf(await qa.call(routes.analyticsConfig.setReferenceSet, { body: { ...body, changeRecord: 'CR-NOT-THERE' } }));
    expect(`${refused.code} ${refused.why}`).toMatch(/EBMR-CFG-002/);
    const set = valueOf(await qa.call(routes.analyticsConfig.setReferenceSet, { body: { ...body, changeRecord: await approvedChangeRecord(['ANALYTICS_REFERENCE']) } })).referenceSet;
    expect(set).toMatchObject({ method: 'GBP.DTW_BAND', status: 'EFFECTIVE', modelSha256: cand.modelSha256 });

    // The next run: the candidates again, then the scoring against the set; only the abnormal curve is flagged.
    const second = await runner().runAll('ON_DEMAND');
    expect(second.map((r) => [r.status, r.referenceSet ?? null])).toEqual([['DONE', null], ['DONE', set.referenceSetId]]);
    const scored = second[1]!;
    expect(scored).toMatchObject({ outputs: 21, flags: 2 });
    const { rows: flags } = await gmp.db.admin.query<{ subject_ref: string; rule: string; severity: string }>(
      'select subject_ref, rule, severity from analytics.flag where run = $1 order by rule', [scored.runId]);
    expect(flags).toEqual([{ subject_ref: abnormal.id, rule: 'DTW_DISTANCE', severity: 'ATTENTION' }, { subject_ref: abnormal.id, rule: 'OUT_OF_BAND', severity: 'ATTENTION' }]);
    const { rows: run } = await gmp.db.admin.query<{ reference_set: string; inputs: { view: string; rows: number }[] }>('select reference_set::text, inputs from analytics.run where id = $1', [scored.runId]);
    expect(run[0]!.reference_set).toBe(set.referenceSetId);
    // The latest curves of the scope only (D-6A-6-12), named in the run's input record.
    expect((run[0]!.inputs[0] as unknown as { filter: unknown }).filter).toEqual({ ended: true, equipment_type: 'TABLET_PRESS', step: PROFILE_STEP, tag: PROFILE_TAG, 'recency<=': 50 });
    expect(run[0]!.inputs.map((i) => [i.view, i.rows])).toEqual([
      ['report.series_ref_v1', 21], ['report.analytics_reference_v1', 1], ['report.series_samples_v1(uuid,text,text)', 21 * 120],
    ]);
    // The candidate now names its reference set; the flags list shows the two flags of the abnormal batch.
    expect(valueOf(await qa.call(routes.analyticsProfile.candidates)).candidates.find((c) => c.outputId === cand.outputId)!.referenceSet).toBe(set.referenceSetId);
    const open = valueOf(await qa.call(routes.analytics.flags, { query: {} })).flags.filter((f) => f.method.id === 'GBP.DTW_BAND');
    expect(open.map((f) => [f.subjectRef, f.subjectLabel, f.rule]).sort()).toEqual([[abnormal.id, abnormal.number, 'DTW_DISTANCE'], [abnormal.id, abnormal.number, 'OUT_OF_BAND']]);
  });

  it('[DI-32] the overlay shows the raw values as recorded', async () => {
    const view = valueOf(await qa.call(routes.analyticsProfile.batch, { query: { batch: abnormal.id, step: PROFILE_STEP, tag: PROFILE_TAG } }));
    expect(view).toMatchObject({ advisory: true, notForGmpDecisions: true, method: { id: 'GBP.DTW_BAND', version: 1 }, batchNumber: abnormal.number, status: 'PROFILED', why: null,
                                 equipmentType: 'TABLET_PRESS', unit: 'kN', points: 200, referenceBatches: 20, used: 120, droppedBad: 0, uncertain: 0 });
    // Every sample of the window, exactly as the chunk holds it: raw text, shown decimal and status code, in order.
    expect(view.samples.map((s) => ({ sourceTime: s.sourceUs, serverTime: null, raw: s.raw, value: s.value, status: s.statusCode }))).toEqual(abnormal.samples);
    const { rows: stored } = await gmp.db.admin.query<{ samples: unknown[] }>('select samples from plant.series where id = $1', [abnormal.chunkId]);
    expect(view.samples.map((s) => ({ sourceTime: s.sourceUs, serverTime: null, raw: s.raw, value: s.value, status: s.statusCode }))).toEqual(stored[0]!.samples);
    expect(view.samples[0]!.at).toBe(0);
    expect(view.samples[view.samples.length - 1]!.at).toBe(1);
    // The statistics: the band, the aligned curve, the share outside and the distance against its limit; the flags.
    expect([view.band.low.length, view.band.high.length, view.band.reference.length, view.curve.length]).toEqual([200, 200, 200, 200]);
    expect(view.outsideShare!).toBeGreaterThan(0.1);
    expect(view.distance!).toBeGreaterThan(view.distanceLimit);
    expect(view.flags.map((f) => f.rule).sort()).toEqual(['DTW_DISTANCE', 'OUT_OF_BAND']);
    // Batch 3's two BAD samples are shown as received and counted as dropped; a normal batch has no flag.
    const third = valueOf(await qa.call(routes.analyticsProfile.batch, { query: { batch: batches[2]!.id, step: PROFILE_STEP, tag: PROFILE_TAG } }));
    expect(third).toMatchObject({ droppedBad: 2, used: 118, flags: [] });
    expect(third.samples.filter((s) => s.quality === 'BAD').map((s) => [s.raw, s.value, s.statusCode, s.at])).toEqual([[expect.any(String), null, '0x80000000', null], [expect.any(String), null, '0x80000000', null]]);
    expect(third.outsideShare!).toBeLessThanOrEqual(0.1);
    // Every read needs ANALYTICS.VIEW.
    const denied = refusalOf(await author.call(routes.analyticsProfile.batch, { query: { batch: abnormal.id, step: PROFILE_STEP, tag: PROFILE_TAG } }));
    expect(`${denied.code} ${denied.why}`).toMatch(/EBMR-IAM-040/);
  });

  it('a step without a series gives no profile', async () => {
    const r = refusalOf(await qa.call(routes.analyticsProfile.batch, { query: { batch: abnormal.id, step: 'blending', tag: PROFILE_TAG } }));
    expect(r).toMatchObject({ status: 404, code: 'EBMR-ANA-060' });
    expect(r.why).toMatch(/connected equipment only/);
    expect(refusalOf(await qa.call(routes.analyticsProfile.batch, { query: { batch: abnormal.id, step: PROFILE_STEP, tag: 'force.pre_kN' } }))).toMatchObject({ status: 404, code: 'EBMR-ANA-060' });
    const { rows } = await gmp.db.admin.query("select count(*)::int as n from analytics.output where kind = 'PROFILE_DISTANCE' and \"values\" ->> 'step' <> $1", [PROFILE_STEP]);
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('[DI-51] the profile reads the native series and never changes plant.series or the record\'s dynamic data refs', async () => {
    const before = await gmpFingerprint();
    const reports = await runner().runAll('SCHEDULED');
    expect(reports.every((r) => r.status === 'DONE')).toBe(true);
    expect(await gmpFingerprint()).toEqual(before);
    // The runner connected as ebmr_analytics, which may not write the series it reads.
    const { rows } = await gmp.db.admin.query<{ ins: boolean; upd: boolean; sel: boolean }>(
      "select has_table_privilege('ebmr_analytics', 'plant.series', 'INSERT') as ins, has_table_privilege('ebmr_analytics', 'plant.series', 'UPDATE') as upd, has_table_privilege('ebmr_analytics', 'plant.series', 'SELECT') as sel");
    expect(rows[0]).toEqual({ ins: false, upd: false, sel: false });
    // Its outputs are analytics rows only, each naming its run and the native inputs it read.
    const { rows: outs } = await gmp.db.admin.query<{ n: number }>("select count(*)::int as n from analytics.output o join analytics.run r on r.id = o.run where r.method = 'GBP.DTW_BAND'");
    expect(outs[0]!.n).toBeGreaterThanOrEqual(3 * 1 + 2 * 21);
    // A re-run on the same data reproduces the scoring run (D-6A-22).
    const again = await runner().runAll('ON_DEMAND');
    expect(again.map((r) => r.outputSha256)).toEqual(reports.map((r) => r.outputSha256));
  });
});

describe('the profile\'s reads in the runner (inputs.ts, profile.ts)', () => {
  it('a bounded read and a row function call are built from fixed shapes; another shape is refused', () => {
    expect(inputQuery({ view: 'report.series_ref_v1', version: 1, filter: { ended: true, tag: PROFILE_TAG }, atMost: { recency: 50 } })).toEqual({
      text: 'select * from report.series_ref_v1 where "ended" = $1 and "tag" = $2 and "recency" <= $3', values: [true, PROFILE_TAG, 50],
    });
    const call = { view: 'report.series_samples_v1(uuid,text,text)', version: 1, filter: null, call: { from: 'report.series_ref_v1', args: ['batch_id', 'step', 'tag'] } };
    expect(callQuery(call)).toBe('select * from report.series_samples_v1($1::uuid, $2::text, $3::text)');
    expect(() => callQuery({ ...call, call: { ...call.call, args: ['batch_id'] } })).toThrow(InputSpecError);
    expect(() => callQuery({ ...call, view: 'report.series_samples_v1(uuid,text,text); drop table x' })).toThrow(InputSpecError);
    expect(() => callQuery({ ...call, filter: { a: 1 } })).toThrow(InputSpecError);
    expect(() => inputQuery({ view: 'report.series_ref_v1', version: 1, filter: null, atMost: { 'recency" or true --': 1 } })).toThrow(InputSpecError);
    expect(() => inputQuery({ view: 'report.series_ref_v1', version: 1, filter: null, atMost: { recency: 1.5 } })).toThrow(InputSpecError);
  });

  it('each curve gets the samples of its own unit\'s chunks; the reference rule names why a batch is left out', () => {
    const ref = (equipment: string, chunks: string[], over: Record<string, unknown> = {}) => ({
      batch_id: 'b1', batch_number: 'B-1', product_code: null, family_code: 'F', step: PROFILE_STEP, equipment_code: equipment, equipment_type: 'TABLET_PRESS',
      tag: PROFILE_TAG, unit: 'kN', ended: true, released: true, deviations: 0, alarms: 0, chunk_ids: chunks, ...over,
    });
    const sample = (chunk: string, us: string, status = 'GOOD', value: string | null = '1.5') => ({ batch_id: 'b1', step: PROFILE_STEP, tag: PROFILE_TAG, chunk_id: chunk, source_us: us, value_text: value, status });
    const input = assembleProfile({
      'report.series_ref_v1': [ref('P-1', ['c1']), ref('P-2', ['c2'], { released: false, deviations: 2, alarms: 1 })],
      'report.series_samples_v1(uuid,text,text)': [sample('c1', '1'), sample('c2', '2'), sample('c1', '3', 'BAD', null)],
    });
    expect(input.curves.map((c) => [c.equipmentCode, c.productCode, c.notReference, c.samples.map((s) => [s.sourceUs, s.status, s.value])])).toEqual([
      ['P-1', '-', null, [['1', 'GOOD', '1.5'], ['3', 'BAD', null]]],
      ['P-2', '-', 'not released; 2 deviation(s) linked to the batch; 1 alarm(s) on the step', [['2', 'GOOD', '1.5']]],
    ]);
  });
});
