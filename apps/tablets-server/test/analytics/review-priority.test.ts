/**
 * The review priority of slice 6A-5 on the synthetic history (Phase 6A; decision 0016 item 9; D-6A-13, D-6A-14,
 * D-6A-17; draft controls DI-52, PR-61), without a database: the history's rows in the shape of the input views
 * (test-kit analyticsHistory and analyticsReviewFacts) go through the runner's own assembly (analytics/review.ts) and
 * REVIEW.PRIORITY v1, and the scores through the review queue's own ordering (features/review/reads.ts priorityOrder).
 * The database path (the views over GMP records, the runner, the queue route) is review.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { ReviewPriority, ReviewSummaryView } from '@ebmr/api-contract';
import { defaultParameters } from '@ebmr/analytics';
import { analyticsHistory, analyticsReviewFacts, REVIEW_EXPECTED, type AnalyticsHistory } from '@ebmr/test-kit';
import { REVIEW_METHOD_DEFINITIONS, REVIEW_PRIORITY_IMPLEMENTATION } from '../../src/analytics/review.ts';
import { IMPLEMENTATIONS } from '../../src/analytics/implementation.ts';
import { priorityOrder, type PrioritisedRecord } from '../../src/features/review/reads.ts';

type Row = Record<string, unknown>;

/** The history as the input views give their rows (instants as ISO text, counts as numbers, lists as arrays). */
function viewRows(h: AnalyticsHistory): Record<string, Row[]> {
  const cpp = new Map(h.cppValues.map((v) => [`${v.batch_id}|${v.item}|${v.recorded_at}`, v]));
  const deviated = new Set(h.deviations.map((x) => x.batch_id));
  return {
    'report.review_fact_v1': analyticsReviewFacts(h).map((r) => ({ ...r })),
    'report.batch_fact_v1': h.batches.map((b) => ({ ...b })),
    'report.cpp_value_v1': h.cppValues.map((v) => ({ ...Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'person_id')), reading: null })),
    'report.step_use_v1': h.stepUses.map((s) => ({ ...s })),
    'report.audit_fact_v1': h.auditEvents.map((e) => {
      const v = e.claimed_at === null ? undefined : cpp.get(`${e.batch_id ?? ''}|${e.field ?? ''}|${e.claimed_at}`);
      return {
        event_id: e.event_id, chain_key: `batch:${e.batch_id ?? 'none'}`, recorded_at: e.recorded_at, recorded_local: e.recorded_at.slice(0, 19), claimed_at: e.claimed_at,
        person_id: e.person_id, account_id: e.account_id, role: e.role, terminal: e.terminal, action: e.action, command_type: 'RECORD_ENTRY', table_name: e.table_name,
        field: e.field, is_correction: e.is_correction, reason_code: e.reason_code, batch_id: e.batch_id, step: e.step, attempt: v?.attempt ?? null, failed: v ? v.failed : null,
        deviation_linked: e.batch_id !== null && deviated.has(e.batch_id), config_area: null,
      };
    }),
  };
}

describe('the review priority on the synthetic history (REVIEW.PRIORITY v1)', () => {
  it('[DI-52] the score on the synthetic history ranks the seeded exception-rich batch first and shows its three reasons', () => {
    const h = analyticsHistory();
    const result = REVIEW_PRIORITY_IMPLEMENTATION.method.run(REVIEW_PRIORITY_IMPLEMENTATION.assemble(viewRows(h)), defaultParameters('REVIEW.PRIORITY') as never, null);
    expect(result.flags).toEqual([]);
    expect(result.outputs).toHaveLength(30);
    const scores = result.outputs.map((o) => ({ batchId: o.subjectRef, score: o.values['score'] as number, reasons: o.reasons }));
    const ranked = [...scores].sort((a, b) => b.score - a.score);
    const rich = h.batches[REVIEW_EXPECTED.first - 1]!;
    expect(ranked[0]).toMatchObject({ batchId: rich.batch_id, score: REVIEW_EXPECTED.score });
    expect(ranked[1]!.score).toBeLessThan(REVIEW_EXPECTED.score);
    expect(ranked[0]!.reasons.map((r) => r.code)).toEqual(REVIEW_EXPECTED.reasons);
    expect(ranked[0]!.reasons.map((r) => r.text)).toEqual([
      '2 major exceptions (action level; 3 points each)',
      '1 critical exception (5 points each)',
      '2 corrections after entry (1 point each, counted up to 5)',
    ]);
    // The history's other seeds show where they belong: the late entry on batch 12 and the back-dated one on batch 9 are
    // audit-trail rule hits on those records; the first batches bring new operators and units; R-2's deviations count.
    const of = (n: number) => scores.find((s) => s.batchId === h.batches[n - 1]!.batch_id)!;
    expect(of(12).reasons.map((r) => r.code)).toContain('OPEN_AUDIT_FLAG');
    expect(of(9).reasons.map((r) => r.code)).toContain('OPEN_AUDIT_FLAG');
    expect(of(1).reasons.map((r) => r.code)).toEqual(['NEW_OPERATOR', 'NEW_EQUIPMENT']);
    expect(of(2).reasons.map((r) => r.code)).toEqual(['DEVIATION', 'NEW_OPERATOR', 'NEW_EQUIPMENT']);

    // In the queue's own order the exception-rich record leads the scored ones, after any record not scored yet.
    const summary = (b: (typeof h.batches)[number]): ReviewSummaryView => ({
      batchId: b.batch_id, batchNumber: b.batch_number, recordKind: 'PROCESSING', product: 'EXZ-250 250 mg', executionStatus: 'EXECUTION_COMPLETE',
      reviewState: 'PRODUCTION_APPROVED', cycle: 1, markets: ['IN'],
    });
    const priority = (s: (typeof scores)[number]): ReviewPriority => ({
      score: s.score, reasons: s.reasons.map((r) => ({ code: r.code, text: r.text, ...(r.weight === undefined ? {} : { weight: r.weight }) })),
      methodVersion: { id: 'REVIEW.PRIORITY', version: 1 }, scoredAt: { us: '1780000000000000', text: 'scored' },
    });
    const late = { ...h.batches[0]!, batch_id: '6a060000-0000-4000-8000-0000000000ff', batch_number: 'EXZ250-26-031' };
    const records: PrioritisedRecord[] = [
      ...h.batches.map((b, i) => ({ summary: summary(b), priority: priority(scores.find((s) => s.batchId === b.batch_id)!), endedUs: String(1_780_000_000_000_000 + i) })),
      { summary: summary(late), priority: null, endedUs: '1790000000000000' },
    ];
    const queue = priorityOrder(records);
    expect(queue).toHaveLength(31);
    expect(queue.map((q) => q.batchNumber)).toEqual(expect.arrayContaining(records.map((r) => r.summary.batchNumber)));
    expect(queue[0]).toMatchObject({ batchNumber: 'EXZ250-26-031', priority: null });
    expect(queue[1]).toMatchObject({ batchId: rich.batch_id, priority: { score: REVIEW_EXPECTED.score } });
  });

  it('[PR-61] the runner runs REVIEW.PRIORITY version 1 from its catalogued inputs; QA\'s version 1 row holds the plan\'s weights', () => {
    expect(IMPLEMENTATIONS.find((i) => i.id === 'REVIEW.PRIORITY')).toMatchObject({ versions: [1] });
    expect(REVIEW_PRIORITY_IMPLEMENTATION.inputs.map((i) => i.view)).toEqual(['report.review_fact_v1', 'report.cpp_value_v1', 'report.step_use_v1', 'report.batch_fact_v1', 'report.audit_fact_v1']);
    expect(REVIEW_METHOD_DEFINITIONS).toEqual([expect.objectContaining({ method: 'REVIEW.PRIORITY', version: 1, parameters: defaultParameters('REVIEW.PRIORITY') })]);
  });
});
