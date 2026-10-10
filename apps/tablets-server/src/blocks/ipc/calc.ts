/**
 * Pure calculations of the IPC blocks TB-11 to TB-15 (tablets spec C-11 to C-15, C-17, E.2 to E.5). Every GMP value
 * is a Dec built from decimal text; nothing here reads a clock. The database computes the same results (tablets 0891,
 * tab.ipc_* functions) and refuses an entry whose stored evaluation differs, so the rules below are written so that
 * both sides decide exactly:
 *   * comparisons against a limit relative to a mean are made without dividing (|n.w - sum| x 100 against p x sum);
 *   * a value shown with decimals is rounded half away from zero (HALF_UP), as PostgreSQL's round() does;
 *   * a compendial comparison that the rule set rounds (friability: one decimal; acceptance value: one decimal) is made
 *     on the rounded value, exactly as stored.
 */
import { Dec } from '@ebmr/expr';
import type { DisintegrationParams, FriabilityParams, RuleSet, SubdivisionParams, UniformityParams, WeightVariationParams } from './rule-sets.ts';

export interface Bounds {
  min?: string;
  max?: string;
}
/** Action limits (a breach fails the check and holds output) and alert limits inside them (a warning). */
export interface Tiers {
  action: Bounds;
  alert?: Bounds;
}
export type Verdict = 'PASS' | 'ALERT' | 'FAIL';

export const dec = (s: string): Dec => Dec.parse(s);
const HUNDRED = dec('100');
export const KP_TO_N = '9.80665';

export const fixed = (d: Dec, places: number): string => d.toFixed(places, 'HALF_UP');

function beyond(v: Dec, b: Bounds | undefined): boolean {
  if (!b) return false;
  return (b.min !== undefined && v.lt(dec(b.min))) || (b.max !== undefined && v.gt(dec(b.max)));
}

/** PASS inside the alert limits, ALERT inside the action limits only, FAIL outside the action limits. */
export function judge(v: Dec, t: Tiers): Verdict {
  if (beyond(v, t.action)) return 'FAIL';
  if (beyond(v, t.alert)) return 'ALERT';
  return 'PASS';
}

export function worst(vs: readonly Verdict[]): Verdict {
  return vs.includes('FAIL') ? 'FAIL' : vs.includes('ALERT') ? 'ALERT' : 'PASS';
}

/** Limits of value `of` +/- `percent` %: canonical decimal text. */
export function relative(of: Dec, percent: string): Bounds {
  const p = dec(percent).div(HUNDRED);
  return { min: of.times(Dec.fromInteger(1).minus(p)).toString(), max: of.times(Dec.fromInteger(1).plus(p)).toString() };
}

export function relativeTiers(of: Dec, t: { action: string; alert?: string }): Tiers {
  return { action: relative(of, t.action), ...(t.alert !== undefined ? { alert: relative(of, t.alert) } : {}) };
}

export interface Statistics {
  n: number;
  sum: string;
  mean: string;
  min: string;
  max: string;
  /** Standard deviation (n - 1) and relative standard deviation, from two values on. */
  sd?: string;
  rsd?: string;
  minDeviation: string;
  maxDeviation: string;
}

export const sumOf = (vs: readonly Dec[]): Dec => vs.reduce((a, v) => a.plus(v), Dec.ZERO);

/** Variance with n - 1 (exact up to the final division). */
function variance(vs: readonly Dec[]): Dec {
  const n = Dec.fromInteger(vs.length);
  const s = sumOf(vs);
  const sq = vs.reduce((a, v) => a.plus(v.times(v)), Dec.ZERO);
  return n.times(sq).minus(s.times(s)).div(n.times(n.minus(Dec.fromInteger(1))));
}

/** C-13 statistics of individual values (mean 4 decimals, SD 4, RSD and deviations 2). */
export function statistics(vs: readonly Dec[]): Statistics {
  const n = Dec.fromInteger(vs.length);
  const s = sumOf(vs);
  const min = vs.reduce((a, v) => (v.lt(a) ? v : a));
  const max = vs.reduce((a, v) => (v.gt(a) ? v : a));
  const dev = (x: Dec) => fixed(n.times(x).minus(s).times(HUNDRED).div(s), 2);
  const out: Statistics = { n: vs.length, sum: s.toString(), mean: fixed(s.div(n), 4), min: min.toString(), max: max.toString(), minDeviation: dev(min), maxDeviation: dev(max) };
  if (vs.length > 1) {
    const sd = variance(vs).sqrt();
    out.sd = fixed(sd, 4);
    out.rsd = fixed(sd.times(n).times(HUNDRED).div(s), 2);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// TB-12 weight modes

/** (a) C-11: the group weight (or the sum of the individual weights) of n tablets against n x target +/- tolerance. */
export function groupEvaluation(total: Dec, n: number, target: Dec, tol: { action: string; alert?: string }): { evaluation: Record<string, unknown>; verdict: Verdict } {
  const groupTarget = target.times(Dec.fromInteger(n));
  const tiers = relativeTiers(groupTarget, tol);
  return {
    evaluation: { mode: 'GROUP', n, total: total.toString(), mean: fixed(total.div(Dec.fromInteger(n)), 4), target: groupTarget.toString(), limits: tiers },
    verdict: judge(total, tiers),
  };
}

/** The deviation band of a uniformity rule set for the average of `n` weights summing to `sum` (exact boundaries). */
export function bandOf(p: UniformityParams, sum: Dec, n: number): string {
  for (const b of p.bands) {
    if (b.upToMg === undefined) return b.percent;
    const lim = dec(b.upToMg).times(Dec.fromInteger(n));
    if (b.inclusive ? sum.lte(lim) : sum.lt(lim)) return b.percent;
  }
  throw new Error('a uniformity rule set ends with an open band');
}

/** Units whose |n.w - sum| x 100 exceeds percent x sum, i.e. outside the average +/- percent %. */
export function countOutside(ws: readonly Dec[], sum: Dec, percent: Dec): number {
  const n = Dec.fromInteger(ws.length);
  const lim = percent.times(sum);
  return ws.filter((w) => n.times(w).minus(sum).abs().times(HUNDRED).gt(lim)).length;
}

/** (b) C-12 per rule set: band from the measured average, at most k outside the band and none outside twice it. */
export function uniformityCriteria(ws: readonly Dec[], sets: readonly RuleSet[]): { criteria: Record<string, unknown>[]; verdict: Verdict } {
  const sum = sumOf(ws);
  const criteria = sets.map((r) => {
    const p = r.params as UniformityParams;
    const band = bandOf(p, sum, ws.length);
    const outside = countOutside(ws, sum, dec(band));
    const outsideDouble = countOutside(ws, sum, dec(band).times(Dec.fromInteger(2)));
    return { ruleSet: r.code, version: r.version, percent: band, outside, outsideDouble, pass: outside <= p.maxOutside && outsideDouble <= p.maxOutsideDouble };
  });
  return { criteria, verdict: criteria.every((c) => c.pass) ? 'PASS' : 'FAIL' };
}

/** The tightest band the rule sets give at an average weight (for the definition check of mode (c)). */
export function tightestBand(sets: readonly RuleSet[], mean: Dec): Dec | undefined {
  let out: Dec | undefined;
  for (const r of sets) {
    const p = dec(bandOf(r.params as UniformityParams, mean, 1));
    if (!out || p.lt(out)) out = p;
  }
  return out;
}

/** (c) In-house individual limits around the target weight. */
export function individualEvaluation(ws: readonly Dec[], target: Dec, t: { action: string; alert?: string }): { evaluation: Record<string, unknown>; verdict: Verdict } {
  const tiers = relativeTiers(target, t);
  const verdicts = ws.map((w) => judge(w, tiers));
  return {
    evaluation: { mode: 'INDIVIDUAL', target: target.toString(), limits: tiers, outside: verdicts.filter((v) => v === 'FAIL').length, outsideAlert: verdicts.filter((v) => v !== 'PASS').length },
    verdict: worst(verdicts),
  };
}

/** C-14 reference value M from the mean content x (= the assay) and the target content T. */
export function referenceValue(p: WeightVariationParams, x: Dec, t: Dec): Dec {
  const low = dec(p.referenceLow);
  const high = dec(p.referenceHigh);
  if (x.lt(low)) return low;
  const cap = t.lte(high) ? high : t;
  return x.gt(cap) ? cap : x;
}

/**
 * (d) C-14 weight variation by acceptance value for one rule set: contents x_i = w_i x A / mean(w), so the mean content
 * is A itself and s = A x SD(w) / mean(w); AV = |M - A| + k x s, compared after rounding to the rule set's decimals.
 * At the second stage (all units) no unit may lie outside M x (1 +/- unitLimit %).
 */
export function acceptanceValue(ws: readonly Dec[], assay: Dec, target: Dec, r: RuleSet, second: boolean): Record<string, unknown> & { pass: boolean } {
  const p = r.params as WeightVariationParams;
  const n = Dec.fromInteger(ws.length);
  const sum = sumOf(ws);
  const m = referenceValue(p, assay, target);
  const k = dec(second ? p.secondK : p.firstK);
  const s = assay.times(variance(ws).sqrt()).times(n).div(sum);
  const av = fixed(m.minus(assay).abs().plus(k.times(s)), p.avDecimals);
  let pass = dec(av).lte(dec(p.acceptanceLimit));
  const out: Record<string, unknown> & { pass: boolean } = { ruleSet: r.code, version: r.version, reference: m.toString(), k: second ? p.secondK : p.firstK, av, pass };
  if (second) {
    const u = dec(p.unitLimitPercent).div(HUNDRED);
    const one = Dec.fromInteger(1);
    const lo = one.minus(u).times(m).times(sum);
    const hi = one.plus(u).times(m).times(sum);
    const outside = ws.filter((w) => {
      const v = n.times(w).times(assay);
      return v.lt(lo) || v.gt(hi);
    }).length;
    out['outsideUnitLimit'] = outside;
    pass = pass && outside === 0;
    out.pass = pass;
  }
  return out;
}

/** (e) Subdivision of scored tablets: parts against the average +/- inner and outer percent. */
export function subdivisionCriteria(ws: readonly Dec[], sets: readonly RuleSet[]): { criteria: Record<string, unknown>[]; verdict: Verdict } {
  const sum = sumOf(ws);
  const criteria = sets.map((r) => {
    const p = r.params as SubdivisionParams;
    const outsideInner = countOutside(ws, sum, dec(p.innerPercent));
    const outsideOuter = countOutside(ws, sum, dec(p.outerPercent));
    return { ruleSet: r.code, version: r.version, outsideInner, outsideOuter, pass: outsideInner <= p.maxOutsideInner && outsideOuter <= p.maxOutsideOuter };
  });
  return { criteria, verdict: criteria.every((c) => c.pass) ? 'PASS' : 'FAIL' };
}

// ---------------------------------------------------------------------------------------------
// TB-14 friability (C-15)

/** The friability limit: the smallest of the bound rule sets' and the MBR's (never looser than a rule set). */
export function friabilityLimit(sets: readonly RuleSet[], mbr: string | undefined): Dec | undefined {
  const all = [...sets.map((r) => dec((r.params as FriabilityParams).maxLossPercent)), ...(mbr !== undefined ? [dec(mbr)] : [])];
  return all.reduce<Dec | undefined>((a, v) => (a === undefined || v.lt(a) ? v : a), undefined);
}

/** Loss in % at full precision. */
export const friabilityLoss = (initial: Dec, final: Dec): Dec => initial.minus(final).times(HUNDRED).div(initial);

/**
 * Why the sample breaks the rule set's sample rule, or undefined: unit mass 650 mg or less, whole tablets as near as
 * possible to 6.5 g (within half a tablet of it); above, 10 tablets.
 */
export function friabilitySampleProblem(p: FriabilityParams, tablets: number, initialGrams: Dec): string | undefined {
  const n = Dec.fromInteger(tablets);
  // Average unit mass above the heavy-unit mass, without dividing: 1000.W1 > heavy x n.
  if (initialGrams.times(dec('1000')).gt(dec(p.heavyUnitMg).times(n))) return tablets === p.heavyUnitCount ? undefined : `tablets above ${p.heavyUnitMg} mg are tested ${p.heavyUnitCount} at a time, not ${tablets}`;
  // |1000.W1 - 1000.target| x 2 x n <= 1000.W1 (within half the average unit mass of the target).
  const target = dec(p.targetSampleGrams);
  return initialGrams.minus(target).abs().times(Dec.fromInteger(2)).times(n).lte(initialGrams)
    ? undefined
    : `${tablets} tablets weighing ${initialGrams.toString()} g are not the whole number of tablets nearest to ${p.targetSampleGrams} g`;
}

// ---------------------------------------------------------------------------------------------
// TB-15 disintegration

export interface DtLimits {
  /** Limit of the main (or buffer) stage in seconds, the shortest of the rule sets' and the MBR's. */
  seconds?: string;
  acidSeconds?: string;
  tempMin: string;
  tempMax: string;
  units: number;
  staging: DisintegrationParams['staging'];
}

/** The disintegration limits for tablet type `type` from the bound rule sets and the MBR's own time (tighter only). */
export function disintegrationLimits(sets: readonly RuleSet[], type: string, mbrSeconds: string | undefined, mbrAcidSeconds: string | undefined): DtLimits | undefined {
  let seconds: Dec | undefined = mbrSeconds !== undefined ? dec(mbrSeconds) : undefined;
  let acid: Dec | undefined;
  let tmin: Dec | undefined;
  let tmax: Dec | undefined;
  let first: DisintegrationParams | undefined;
  const sixty = dec('60');
  for (const r of sets) {
    const p = r.params as DisintegrationParams;
    const t = p.types[type as keyof DisintegrationParams['types']];
    if (!t) continue;
    first ??= p;
    if (t.minutes !== undefined) {
      const s = dec(t.minutes).times(sixty);
      if (seconds === undefined || s.lt(seconds)) seconds = s;
    }
    if (t.acidMinutes !== undefined) {
      const a = dec(t.acidMinutes).times(sixty);
      if (acid === undefined || a.gt(acid)) acid = a;
    }
    const lo = dec(t.tempMin);
    const hi = dec(t.tempMax);
    if (tmin === undefined || lo.gt(tmin)) tmin = lo;
    if (tmax === undefined || hi.lt(tmax)) tmax = hi;
  }
  if (!first || tmin === undefined || tmax === undefined) return undefined;
  if (mbrAcidSeconds !== undefined) acid = dec(mbrAcidSeconds);
  return {
    ...(seconds !== undefined ? { seconds: seconds.toString() } : {}),
    ...(acid !== undefined ? { acidSeconds: acid.toString() } : {}),
    tempMin: tmin.toString(),
    tempMax: tmax.toString(),
    units: first.units,
    staging: first.staging,
  };
}
