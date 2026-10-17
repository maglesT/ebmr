/**
 * The review facts of the synthetic analytics history (Phase 6A slice 6A-5; D-6A-17; draft control PR-61): one row of
 * report.review_fact_v1 per batch of `analyticsHistory(seed)`, derived from the history without drawing from its PRNG,
 * so every other slice's rows stay exactly as they are.
 *
 * What the rows say:
 *   - every batch awaits QA review (PRODUCTION_APPROVED, cycle 1) and ended when the history completed it;
 *   - linked deviations are the history's deviations of the batch (room R-2 on 9 of its 10 batches);
 *   - a person is new to the product on the batch of their first step in the history (batches 1 to 4, one clean operator
 *     each), a unit is new on the batch of its first use (HSG-01 and PRESS-01 on batch 1, PRESS-02 on batch 2);
 *   - the seeded exception-rich batch (REVIEW_SEEDS.exceptionRich, 21) has one critical, two major (action) and one
 *     minor (alert) exception and two post-entry corrections; batches 5, 10, ..., 30 have one minor exception each.
 * REVIEW_EXPECTED is what a correct REVIEW.PRIORITY v1 gives on it with the default weights (D-6A-13).
 */
import type { AnalyticsHistory } from './analytics-history.ts';

export const REVIEW_SEEDS = { exceptionRich: 21 } as const;

/** A row of report.review_fact_v1 (recipe-core 1160), values as the view gives them. */
export interface ReviewFact {
  batch_id: string;
  batch_number: string;
  product_code: string;
  strength: string;
  family_code: string;
  record_kind: 'PROCESSING';
  status: 'EXECUTION_COMPLETE';
  review_state: 'PRODUCTION_APPROVED';
  cycle: number;
  ended_at: string;
  exceptions_critical: number;
  exceptions_major: number;
  exceptions_minor: number;
  corrections: number;
  deviations: number;
  new_operator: boolean;
  new_operators: number;
  new_equipment: boolean;
  new_equipment_codes: string[];
  review_findings: number;
  review_reopenings: number;
}

/**
 * The expected result on the default history: the exception-rich batch first, score 14 (two major exceptions 6, one
 * critical 5, two corrections 2, one minor 1), with these three reasons in this order.
 */
export const REVIEW_EXPECTED = {
  first: REVIEW_SEEDS.exceptionRich,
  score: 14,
  reasons: ['EXCEPTION_MAJOR', 'EXCEPTION_CRITICAL', 'CORRECTION'],
} as const;

export function analyticsReviewFacts(h: AnalyticsHistory): ReviewFact[] {
  const firstPerson = new Map<string, string>();
  const firstUnit = new Map<string, string>();
  const order = [...h.stepUses].sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0));
  for (const s of order) {
    for (const p of s.person_ids) if (!firstPerson.has(p)) firstPerson.set(p, s.batch_id);
    if (!firstUnit.has(s.equipment_code)) firstUnit.set(s.equipment_code, s.batch_id);
  }
  return h.batches.map((b, i) => {
    const n = i + 1;
    const rich = n === REVIEW_SEEDS.exceptionRich;
    const newOperators = [...firstPerson.values()].filter((x) => x === b.batch_id).length;
    const units = [...firstUnit.entries()].filter(([, x]) => x === b.batch_id).map(([code]) => code).sort();
    return {
      batch_id: b.batch_id, batch_number: b.batch_number, product_code: b.product_code, strength: b.strength, family_code: b.family_code, record_kind: 'PROCESSING',
      status: 'EXECUTION_COMPLETE', review_state: 'PRODUCTION_APPROVED', cycle: 1, ended_at: b.completed_at,
      exceptions_critical: rich ? 1 : 0, exceptions_major: rich ? 2 : 0, exceptions_minor: rich || n % 5 === 0 ? 1 : 0, corrections: rich ? 2 : 0,
      deviations: h.deviations.filter((d) => d.batch_id === b.batch_id).length,
      new_operator: newOperators > 0, new_operators: newOperators, new_equipment: units.length > 0, new_equipment_codes: units, review_findings: 0, review_reopenings: 0,
    };
  });
}
