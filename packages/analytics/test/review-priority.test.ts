/**
 * REVIEW.PRIORITY v1 (slice 6A-5; decision 0016 item 9; D-6A-13, D-6A-5-*; draft control PR-61) on known answers: the
 * exact near-limit comparison on decimal text, each term with its weight and cap, the yes-or-no terms counted once, the
 * top reasons in order, the step durations against the product's records, the audit-trail rule hits on a record's own
 * entries, and the reproducibility of a run. The method raises no flag and decides nothing: it only gives a score.
 */
import { describe, expect, it } from 'vitest';
import { defaultParameters, outputHash, parameterProblems, type DecimalText } from '../src/index.ts';
import type { AuditEvent } from '../src/methods/audit/index.ts';
import { nearLimit, PRIORITY_TERMS, runReviewPriority, type ReviewInput, type ReviewPriorityParameters, type ReviewRecord } from '../src/methods/review/index.ts';

const P = defaultParameters('REVIEW.PRIORITY') as ReviewPriorityParameters;
const d = (t: string): DecimalText => t as DecimalText;

function record(id: string, over: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    batchId: id, batchNumber: `B-${id}`, product: 'EXZ-250', family: 'GB-T-01', reviewState: 'PRODUCTION_APPROVED', endedAt: '2026-06-10 12:30:00+00',
    exceptionsCritical: 0, exceptionsMajor: 0, exceptionsMinor: 0, corrections: 0, deviations: 0, newOperators: 0, newEquipment: [], reviewFindings: 0, reviewReopenings: 0,
    ...over,
  };
}
const input = (over: Partial<ReviewInput>): ReviewInput => ({ records: [], values: [], steps: [], audit: [], ...over });
const only = (i: ReviewInput, p = P) => {
  const r = runReviewPriority(i, p);
  expect(r.flags).toEqual([]);
  return r;
};

describe('REVIEW.PRIORITY v1 known answers (D-6A-13)', () => {
  it('a value is near a limit when inside the limits and within 10 % of the range from either, compared exactly on the decimal text', () => {
    expect(nearLimit(d('7.10'), d('7.00'), d('8.00'), 0.1)).toBe(true);
    expect(nearLimit(d('7.1'), d('7.00'), d('8'), 0.1)).toBe(true);
    expect(nearLimit(d('7.11'), d('7.00'), d('8.00'), 0.1)).toBe(false);
    expect(nearLimit(d('7.90'), d('7.00'), d('8.00'), 0.1)).toBe(true);
    expect(nearLimit(d('7.899'), d('7.00'), d('8.00'), 0.1)).toBe(false);
    expect(nearLimit(d('8.00'), d('7.00'), d('8.00'), 0.1)).toBe(true);
    expect(nearLimit(d('7.00'), d('7.00'), d('8.00'), 0.1)).toBe(true);
    // Outside the limits it is an exception, not "near".
    expect(nearLimit(d('8.01'), d('7.00'), d('8.00'), 0.1)).toBe(false);
    expect(nearLimit(d('6.99'), d('7.00'), d('8.00'), 0.1)).toBe(false);
    // Negative limits, and a share to the millionth.
    expect(nearLimit(d('-0.95'), d('-1'), d('1'), 0.025)).toBe(true);
    expect(nearLimit(d('-0.949'), d('-1'), d('1'), 0.025)).toBe(false);
    // No two-sided range: not assessed.
    expect(nearLimit(d('7.5'), null, d('8.00'), 0.1)).toBeNull();
    expect(nearLimit(d('7.5'), d('7.00'), null, 0.1)).toBeNull();
    expect(nearLimit(d('7.5'), d('8.00'), d('8.00'), 0.1)).toBeNull();
  });

  it('each term counts with its weight; the capped terms count up to their cap and the yes-or-no terms once', () => {
    const r = only(input({
      records: [record('a', {
        exceptionsCritical: 2, exceptionsMajor: 1, exceptionsMinor: 3, corrections: 7, deviations: 2, newOperators: 3, newEquipment: ['PRESS-01', 'HSG-01'],
      })],
    }));
    const [o] = r.outputs;
    // 2x5 + 1x3 + 3x1 + min(7, 5)x1 + 2 (once) + 2 (once) + 2x4 = 10 + 3 + 3 + 5 + 2 + 2 + 8 = 33
    expect(o).toMatchObject({ subjectKind: 'BATCH', subjectRef: 'a', kind: 'REVIEW_PRIORITY' });
    expect(o!.values).toMatchObject({
      score: 33, 'EXCEPTION_CRITICAL.count': 2, 'EXCEPTION_CRITICAL.points': 10, 'CORRECTION.count': 7, 'CORRECTION.points': 5, 'NEW_OPERATOR.count': 3,
      'NEW_OPERATOR.points': 2, 'NEW_EQUIPMENT.count': 2, 'NEW_EQUIPMENT.points': 2, 'DEVIATION.points': 8, 'NEAR_LIMIT.points': 0, 'OPEN_AUDIT_FLAG.points': 0,
    });
    // The top three: the larger points first, then the term order (critical exceptions before deviations at equal points).
    expect(o!.reasons.map((x) => [x.code, x.weight])).toEqual([['EXCEPTION_CRITICAL', 10], ['DEVIATION', 8], ['CORRECTION', 5]]);
    expect(o!.reasons[0]!.text).toBe('2 critical exceptions (5 points each)');
    expect(o!.reasons[2]!.text).toBe('7 corrections after entry (1 point each, counted up to 5)');
  });

  it('the weights, caps and number of reasons are the version\'s parameters', () => {
    const p: ReviewPriorityParameters = { ...P, weights: { ...P.weights, DEVIATION: 10, EXCEPTION_MINOR: 0 }, caps: { ...P.caps, CORRECTION: 2 }, topReasons: 2 };
    expect(parameterProblems('REVIEW.PRIORITY', p)).toEqual([]);
    const [o] = only(input({ records: [record('a', { exceptionsMinor: 4, corrections: 9, deviations: 1 })] }), p).outputs;
    expect(o!.values['score']).toBe(12);
    expect(o!.reasons.map((x) => x.code)).toEqual(['DEVIATION', 'CORRECTION']);
  });

  it('a record with nothing to look at scores 0 and has no reason; it is still scored', () => {
    const r = only(input({ records: [record('z')] }));
    expect(r.outputs).toHaveLength(1);
    expect(r.outputs[0]!.values['score']).toBe(0);
    expect(r.outputs[0]!.reasons).toEqual([]);
  });

  it('values near a limit count per record, capped at 5, with the items as evidence; a value without two limits is named as not assessed', () => {
    const values = [
      ...['7.05', '7.95', '7.00', '8.00', '7.92', '7.03', '7.50'].map((v, i) => ({ batchId: 'a', ref: `endpoint@granulation#${String(i + 1)}`, value: d(v), lower: d('7.00'), upper: d('8.00') })),
      { batchId: 'a', ref: 'lod@drying', value: d('0.9'), lower: null, upper: d('2.0') },
      { batchId: 'b', ref: 'endpoint@granulation', value: d('7.05'), lower: d('7.00'), upper: d('8.00') },
    ];
    const r = only(input({ records: [record('a')], values }));
    expect(r.outputs).toHaveLength(1);
    const o = r.outputs[0]!;
    expect(o.values).toMatchObject({ 'NEAR_LIMIT.count': 6, 'NEAR_LIMIT.points': 5, score: 5 });
    expect(o.reasons[0]).toMatchObject({ code: 'NEAR_LIMIT', weight: 5, text: '6 critical values within 10 % of the range from a limit (1 point each, counted up to 5)' });
    expect(o.reasons[0]!.evidence).toHaveLength(5);
    expect(r.skipped).toContainEqual({ subject: 'B-a|NEAR_LIMIT', reason: '1 critical value without two limits not assessed for nearness' });
  });

  it('a step of unusual duration counts against the same product, family and step of every record, from 5 records on', () => {
    const at = (day: number, min: number): string => new Date(Date.UTC(2026, 5, 1 + day, 4, 30) + min * 60_000).toISOString();
    // Granulation runs 120 minutes (+-2) on five records; record x runs it 300 minutes. Compression has only 4 records.
    const lengths = [120, 118, 122, 121, 119];
    const steps = [
      ...lengths.map((m, i) => ({ batchId: `h${String(i)}`, product: 'EXZ-250', family: 'GB-T-01', step: 'granulation', startedAt: at(i, 0), endedAt: at(i, m) })),
      { batchId: 'x', product: 'EXZ-250', family: 'GB-T-01', step: 'granulation', startedAt: at(9, 0), endedAt: at(9, 300) },
      // Two units of one step: the step runs from its first start to its last end.
      { batchId: 'y', product: 'EXZ-250', family: 'GB-T-01', step: 'granulation', startedAt: at(10, 0), endedAt: at(10, 60) },
      { batchId: 'y', product: 'EXZ-250', family: 'GB-T-01', step: 'granulation', startedAt: at(10, 30), endedAt: at(10, 121) },
      ...[0, 1, 2].map((i) => ({ batchId: `h${String(i)}`, product: 'EXZ-250', family: 'GB-T-01', step: 'compression', startedAt: at(i, 200), endedAt: at(i, 380) })),
      { batchId: 'x', product: 'EXZ-250', family: 'GB-T-01', step: 'compression', startedAt: at(9, 400), endedAt: at(9, 900) },
      // Another product's records are not the baseline.
      ...[0, 1, 2, 3, 4].map((i) => ({ batchId: `o${String(i)}`, product: 'OTHER', family: 'F', step: 'granulation', startedAt: at(i, 0), endedAt: at(i, 300) })),
    ];
    const r = only(input({ records: [record('x'), record('y')], steps }));
    const x = r.outputs.find((o) => o.subjectRef === 'x')!;
    const y = r.outputs.find((o) => o.subjectRef === 'y')!;
    expect(x.values).toMatchObject({ 'STEP_DURATION.count': 1, 'STEP_DURATION.points': 1 });
    expect(x.reasons[0]).toMatchObject({ code: 'STEP_DURATION', evidence: [{ kind: 'STEP', ref: 'granulation' }] });
    expect(y.values).toMatchObject({ 'STEP_DURATION.count': 0 });
    expect(r.skipped).toContainEqual({ subject: 'B-x|compression', reason: 'duration not assessed: 4 records ran this step, 5 are needed' });
  });

  it('an audit-trail rule hit counts on the record whose entries it names, and names no person or entry in the reason', () => {
    const t = (min: number): string => new Date(Date.UTC(2026, 5, 3, 4, 30) + min * 60_000).toISOString();
    const entry = (id: string, batch: string, recorded: number, claimed: number): AuditEvent => ({
      eventId: id, chainKey: `batch:${batch}`, recordedAt: t(recorded), recordedLocal: t(recorded).slice(0, 19), claimedAt: t(claimed), personId: 'p-1', accountId: 'acc-1',
      role: 'OPERATOR', terminal: 'T-1', action: 'INSERT', tableName: 'recipe.execution_command', field: 'item.a', isCorrection: false, reasonCode: null, batchId: batch,
      step: 's1', attempt: 1, failed: false, deviationLinked: false, configArea: null,
    });
    // 47 minutes late on record a (a LATE_ENTRY hit); on time on record b.
    const r = only(input({ records: [record('a'), record('b')], audit: [entry('1', 'a', 47, 0), entry('2', 'b', 102, 100)] }));
    const a = r.outputs.find((o) => o.subjectRef === 'a')!;
    expect(a.values).toMatchObject({ 'OPEN_AUDIT_FLAG.count': 1, 'OPEN_AUDIT_FLAG.points': 3, score: 3 });
    expect(a.reasons).toEqual([{ code: 'OPEN_AUDIT_FLAG', weight: 3, text: "1 audit-trail rule hit on this record's entries (3 points each; the details are for data-integrity review)" }]);
    expect(JSON.stringify(a)).not.toContain('p-1');
    expect(r.outputs.find((o) => o.subjectRef === 'b')!.values['score']).toBe(0);
  });

  it('every output keeps the review outcome so far and the state; a re-run on the same input gives the same outputs and hash', () => {
    const i = input({ records: [record('a', { exceptionsMajor: 1, reviewFindings: 2, reviewReopenings: 1 }), record('b', { deviations: 1 })] });
    const first = only(i);
    const again = only(i);
    expect(again).toEqual(first);
    expect(outputHash(again.outputs, again.flags)).toBe(outputHash(first.outputs, first.flags));
    expect(first.outputs.find((o) => o.subjectRef === 'a')!.values).toMatchObject({ findings: 2, reopenings: 1, reviewState: 'PRODUCTION_APPROVED', batchNumber: 'B-a' });
    // Every term is shown with its count and points, whether or not it scores.
    for (const term of PRIORITY_TERMS) expect(first.outputs[0]!.values).toHaveProperty([`${term}.count`]);
  });

  it('the version 1 parameters are the plan\'s weights and fit the schema', () => {
    expect(parameterProblems('REVIEW.PRIORITY', P)).toEqual([]);
    expect(P.weights).toEqual({
      EXCEPTION_CRITICAL: 5, EXCEPTION_MAJOR: 3, EXCEPTION_MINOR: 1, NEAR_LIMIT: 1, CORRECTION: 1, OPEN_AUDIT_FLAG: 3, NEW_OPERATOR: 2, NEW_EQUIPMENT: 2, STEP_DURATION: 1,
      DEVIATION: 4,
    });
    expect(P.caps).toEqual({ NEAR_LIMIT: 5, CORRECTION: 5, STEP_DURATION: 3 });
    expect([P.nearLimitShare, P.durationZ, P.durationMinBatches, P.topReasons]).toEqual([0.1, 3, 5, 3]);
  });
});
