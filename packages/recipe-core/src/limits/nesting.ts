/**
 * Limit-tier nesting (PR-08; outline 5.2.4 "nested alert inside action inside registered (the
 * validator enforces the nesting)").
 *
 * Checked twice:
 * 1. on the written values, exactly (scaled decimals, inclusive/exclusive bounds respected);
 * 2. after rounding, through the expression language: an inner tier must never accept a raw value
 *    that an outer tier rejects once each tier rounds with its own rule (e.g. an internal action
 *    limit "95" with 0 decimals would accept 94.6, which a registered "95.0" rejects).
 */
import { compareDecimal, isDecimalLiteral } from '../flow/decimal.ts';
import type { ExpressionService } from '../flow/expression-port.ts';
import type { LimitBound, LimitRange, LimitSpec, LimitTier } from './model.ts';

export interface LimitProblem {
  code: 'NO_RANGES' | 'DUPLICATE_TIER' | 'NO_BOUND' | 'EMPTY_RANGE' | 'NOT_NESTED' | 'NOT_NESTED_AFTER_ROUNDING' | 'BAD_VALUE';
  tier?: LimitTier;
  message: string;
}

/** The tiers each tier must lie inside (when present). */
const OUTER_OF: Record<LimitTier, LimitTier[]> = {
  REGISTERED: [],
  VALIDATED: [],
  INTERNAL_ACTION: ['REGISTERED', 'VALIDATED'],
  ALERT: ['INTERNAL_ACTION', 'REGISTERED', 'VALIDATED'],
};

const TIER_NAME: Record<LimitTier, string> = {
  REGISTERED: 'registered limit',
  VALIDATED: 'validated range',
  INTERNAL_ACTION: 'internal action limit',
  ALERT: 'alert limit',
};

export function tierName(tier: LimitTier): string {
  return TIER_NAME[tier];
}

function describe(r: LimitRange): string {
  const low = r.low ? `${r.low.inclusive ? '>=' : '>'} ${r.low.value}` : '';
  const high = r.high ? `${r.high.inclusive ? '<=' : '<'} ${r.high.value}` : '';
  return [low, high].filter(Boolean).join(' and ');
}

/** inner.low is at least as strict as outer.low (inner accepts nothing below what outer accepts). */
function lowInside(inner: LimitBound | undefined, outer: LimitBound | undefined): boolean {
  if (!outer) return true;
  if (!inner) return false;
  const c = compareDecimal(inner.value, outer.value);
  return c > 0 || (c === 0 && (outer.inclusive || !inner.inclusive));
}

function highInside(inner: LimitBound | undefined, outer: LimitBound | undefined): boolean {
  if (!outer) return true;
  if (!inner) return false;
  const c = compareDecimal(inner.value, outer.value);
  return c < 0 || (c === 0 && (outer.inclusive || !inner.inclusive));
}

/** Checks the shape and exact nesting of a limit specification. */
export function checkLimitSpec(spec: LimitSpec): LimitProblem[] {
  const problems: LimitProblem[] = [];
  if (spec.ranges.length === 0) return [{ code: 'NO_RANGES', message: 'The limit has no ranges' }];
  const byTier = new Map<LimitTier, LimitRange>();
  for (const r of spec.ranges) {
    if (byTier.has(r.tier)) problems.push({ code: 'DUPLICATE_TIER', tier: r.tier, message: `The ${tierName(r.tier)} is given twice` });
    byTier.set(r.tier, r);
    for (const b of [r.low, r.high]) if (b && !isDecimalLiteral(b.value)) problems.push({ code: 'BAD_VALUE', tier: r.tier, message: `${JSON.stringify(b.value)} is not a decimal` });
    if (!r.low && !r.high) {
      problems.push({ code: 'NO_BOUND', tier: r.tier, message: `The ${tierName(r.tier)} has neither a lower nor an upper bound` });
      continue;
    }
    if (r.low && r.high && isDecimalLiteral(r.low.value) && isDecimalLiteral(r.high.value)) {
      const c = compareDecimal(r.low.value, r.high.value);
      if (c > 0 || (c === 0 && !(r.low.inclusive && r.high.inclusive))) {
        problems.push({ code: 'EMPTY_RANGE', tier: r.tier, message: `The ${tierName(r.tier)} (${describe(r)}) accepts no value` });
      }
    }
  }
  if (problems.length > 0) return problems;
  for (const [tier, inner] of byTier) {
    for (const outerTier of OUTER_OF[tier]) {
      const outer = byTier.get(outerTier);
      if (!outer) continue;
      // An alert tier only needs to sit inside the nearest outer tier present; checking all outer tiers is equivalent when they nest.
      if (!lowInside(inner.low, outer.low) || !highInside(inner.high, outer.high)) {
        problems.push({
          code: 'NOT_NESTED',
          tier,
          message: `The ${tierName(tier)} (${describe(inner)}) is not inside the ${tierName(outerTier)} (${describe(outer)})`,
        });
      }
    }
  }
  return problems;
}

/**
 * Nesting after rounding: every boundary vector the inner tier accepts must be accepted by each
 * outer tier, and every vector an outer tier rejects must be rejected by the inner tier.
 */
export function checkNestingAfterRounding(spec: LimitSpec, expr: ExpressionService): LimitProblem[] {
  const problems: LimitProblem[] = [];
  const byTier = new Map(spec.ranges.map((r) => [r.tier, r]));
  const accepts = (r: LimitRange, value: string): boolean =>
    (!r.low || expr.compareToBound(value, r.low, 'LOW', r.rounding).pass) && (!r.high || expr.compareToBound(value, r.high, 'HIGH', r.rounding).pass);
  const vectorsOf = (r: LimitRange): string[] => [
    ...(r.low ? expr.boundaryVectors(r.low, 'LOW', r.rounding) : []),
    ...(r.high ? expr.boundaryVectors(r.high, 'HIGH', r.rounding) : []),
  ].map((v) => v.value);
  for (const [tier, inner] of byTier) {
    for (const outerTier of OUTER_OF[tier]) {
      const outer = byTier.get(outerTier);
      if (!outer) continue;
      const candidates = [...new Set([...vectorsOf(inner), ...vectorsOf(outer)])].sort(compareDecimal);
      const leak = candidates.find((v) => accepts(inner, v) && !accepts(outer, v));
      if (leak !== undefined) {
        problems.push({
          code: 'NOT_NESTED_AFTER_ROUNDING',
          tier,
          message: `After rounding, the ${tierName(tier)} accepts ${leak}, which the ${tierName(outerTier)} rejects: give both the same number of decimals or tighten the inner tier`,
        });
      }
    }
  }
  return problems;
}
