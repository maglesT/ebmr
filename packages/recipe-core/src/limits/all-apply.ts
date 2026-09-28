/**
 * ALL_APPLY acceptance schemes (outline 3.3.1; L-37): compendial criteria that cannot be ranked
 * (uniformity of dosage units, weight variation, disintegration, dissolution) all apply. Each
 * criterion is evaluated on its own, with its own rounding rule and sampling; the result passes only
 * if every criterion passes; each criterion's result is kept with its governing markets. The sampling
 * plan is the union of what every criterion needs.
 */
import type { ExpressionService } from '../flow/expression-port.ts';
import { evaluateLimits, type LimitEvaluation } from './evaluate.ts';
import type { AcceptanceCriterion, AcceptanceScheme, SamplingNeed } from './model.ts';

/**
 * Union of the criteria's sampling needs: needs for the same point and purpose share units (the
 * largest count wins, destructive if any is destructive); different purposes add up.
 */
export function samplingUnion(scheme: AcceptanceScheme): SamplingNeed[] {
  const byKey = new Map<string, SamplingNeed>();
  for (const c of scheme.criteria) {
    for (const need of c.sampling) {
      const key = `${need.point}\u0000${need.purpose}`;
      const prev = byKey.get(key);
      byKey.set(key, prev ? { point: need.point, purpose: need.purpose, units: Math.max(prev.units, need.units), destructive: prev.destructive || need.destructive } : { ...need });
    }
  }
  return [...byKey.values()].sort((a, b) => (a.point === b.point ? (a.purpose < b.purpose ? -1 : 1) : a.point < b.point ? -1 : 1));
}

export interface SamplingShortfall {
  point: string;
  purpose: string;
  needed: number;
  planned: number;
  /** Criteria that need this sampling. */
  criteria: string[];
}

/** What a phase's sampling plan lacks to serve every criterion of the scheme (empty when it serves them all). */
export function samplingShortfalls(scheme: AcceptanceScheme, plan: readonly SamplingNeed[]): SamplingShortfall[] {
  const out: SamplingShortfall[] = [];
  for (const need of samplingUnion(scheme)) {
    const planned = plan.filter((p) => p.point === need.point && p.purpose === need.purpose).reduce((sum, p) => sum + p.units, 0);
    if (planned < need.units) {
      out.push({
        point: need.point,
        purpose: need.purpose,
        needed: need.units,
        planned,
        criteria: scheme.criteria.filter((c) => c.sampling.some((s) => s.point === need.point && s.purpose === need.purpose)).map((c) => c.id),
      });
    }
  }
  return out;
}

export interface CriterionResult {
  criterion: string;
  governingMarkets: string[];
  pharmacopoeia: AcceptanceCriterion['pharmacopoeia'];
  evaluation: LimitEvaluation;
  pass: boolean;
}

export interface SchemeResult {
  scheme: string;
  /** True only if every criterion passes (a missing statistic fails). */
  pass: boolean;
  criteria: CriterionResult[];
}

/** Evaluates every criterion on its own statistic, rounding and range. */
export function evaluateAllApply(
  scheme: AcceptanceScheme,
  statistics: ReadonlyMap<string, { value: string; unit: string } | undefined>,
  expr: ExpressionService,
): SchemeResult {
  const criteria = scheme.criteria.map((c): CriterionResult => {
    const evaluation = evaluateLimits({ unit: scheme.unit, ranges: [c.range] }, statistics.get(c.statistic), expr);
    return {
      criterion: c.id,
      governingMarkets: [...c.governingMarkets],
      pharmacopoeia: c.pharmacopoeia,
      evaluation,
      pass: evaluation.value !== undefined && evaluation.breached === undefined,
    };
  });
  return { scheme: scheme.id, pass: criteria.length > 0 && criteria.every((c) => c.pass), criteria };
}
