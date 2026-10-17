/**
 * SPC.IMR and SPC.XBAR_S (slice 6A-2; interfaces section 4; D-6A-7, D-6A-2-1 to D-6A-2-4): control charts per product,
 * MBR family and critical item, with Nelson rules 1, 2, 3 and 5. Advisory: an output is a chart for QA to look at and a
 * flag a pointer to the batches behind a rule hit; nothing here decides anything about a batch.
 *
 * I-MR (one value per batch): the centre is the mean of the Phase I batches (the first `phaseOneBatches`, in completion
 * order), sigma the mean moving range of those batches over d2 (2 / sqrt(pi)); the limits are centre +- 3 sigma and the
 * moving-range limit D4 times the mean moving range.
 * Xbar-S (two or more readings per batch): the centre is the mean of the Phase I subgroup means weighted by their
 * sizes, sigma the mean of s / c4(n) over the Phase I subgroups; a point of n readings has sigma / sqrt(n), and the
 * chart's drawn limits are for the most frequent subgroup size (the smallest if tied). The S chart's limits are
 * sigma (c4 +- 3 sqrt(1 - c4^2)) at that size, the lower one not below 0.
 * With a reference model (an approved reference set, D-6A-2-1) whose subject and chart match, its centre and sigma are
 * used instead, and the output says REFERENCE_SET; otherwise PHASE_I, labelled as such.
 * Reference sets in runs (slice 6A-3, D-6A-3-7): a run with a reference set charts only that set's series (any other is
 * skipped with the reason). A run without one leaves out the series a set in force covers (input `covered`, skipped
 * with the reason) and, for each series charted with complete Phase I limits, gives a MODEL_CANDIDATE: the model
 * {subjectRef, chart, centre, sigma, batchIds (the Phase I batches, sorted), phaseOneBatches} and its SHA-256, which QA
 * can make a reference set under a change record (the database checks the hash, EBMR-ANA-010).
 * The rules run on every point, standardised by its own sigma. A series with fewer batches than Phase I needs, or no
 * variation in Phase I, is skipped with the reason.
 */
import type { Method, MethodResult, Parameters, ReferenceModel, Skipped } from '../../method.ts';
import { canonicalText } from '../../numeric/canonical.ts';
import { statOf } from '../../numeric/from-decimal.ts';
import { sha256Hex } from '../../numeric/sha256.ts';
import type { FlagDraft, OutputDraft, Reason } from '../../types.ts';
import { seriesRef, specificationValues, type BatchRef, type BatchValueInput, type SubgroupInput } from './input.ts';
import { RULE_TEXT, nelsonHits, type RuleHit } from './rules.ts';
import { c4, D2_TWO, D4_TWO, mean, movingRanges, sampleSd } from './stats.ts';

export interface SpcParameters extends Parameters {
  readonly rules: readonly string[];
  readonly phaseOneBatches: number;
}

export interface XbarSParameters extends SpcParameters {
  readonly minSubgroup: number;
}

/** The limits a chart uses (from Phase I or the reference model). */
interface Limits {
  readonly centre: number;
  readonly sigma: number;
  readonly source: 'PHASE_I' | 'REFERENCE_SET';
}

/** The limits of a reference model for this subject and chart, or null. Its model is {subjectRef, chart, centre, sigma}. */
export function referenceLimits(ref: ReferenceModel | null, subjectRef: string, chart: 'IMR' | 'XBAR_S'): Limits | null {
  if (!ref) return null;
  const m = ref.model;
  const centre = m['centre'];
  const sigma = m['sigma'];
  if (m['subjectRef'] !== subjectRef || m['chart'] !== chart) return null;
  if (typeof centre !== 'number' || !Number.isFinite(centre) || typeof sigma !== 'number' || !Number.isFinite(sigma) || sigma <= 0) return null;
  return { centre, sigma, source: 'REFERENCE_SET' };
}

const LABEL = { PHASE_I: 'Phase I limits from the first batches', REFERENCE_SET: 'limits from the approved reference set' } as const;

function limitsReason(l: Limits, phaseOne: number, refId: string | null): Reason {
  return l.source === 'PHASE_I'
    ? { code: 'LIMITS_PHASE_I', text: `Control limits from the first ${phaseOne.toString()} batches (Phase I), not from an approved reference set` }
    : { code: 'LIMITS_REFERENCE_SET', text: `Control limits from the approved reference set ${refId ?? ''}`.trim() };
}

/** The flags of a chart's rule hits: one flag per rule, one reason per hit naming its batches. */
function ruleFlags(subjectRef: string, hits: readonly RuleHit[], points: readonly BatchRef[], what: string): FlagDraft[] {
  const byRule = new Map<string, RuleHit[]>();
  for (const h of hits) byRule.set(h.rule, [...(byRule.get(h.rule) ?? []), h]);
  const flags: FlagDraft[] = [];
  for (const [rule, list] of byRule) {
    const reasons = list.map((h): Reason => {
      const first = points[h.points[0]!]!;
      const last = points[h.points[h.points.length - 1]!]!;
      const side = h.rule === 'NELSON_3' ? (h.direction > 0 ? 'increasing' : 'decreasing') : h.direction > 0 ? 'above the centre line' : 'below the centre line';
      const span = h.points.length === 1 ? `batch ${first.batchNumber}` : `${h.points.length.toString()} points, batches ${first.batchNumber} to ${last.batchNumber}`;
      return {
        code: rule,
        text: `${RULE_TEXT[h.rule]} (${side}): ${span} of the ${what}`,
        evidence: h.points.map((k) => ({ kind: 'BATCH', ref: points[k]!.batchId })),
      };
    });
    flags.push({ subjectKind: 'PRODUCT_ITEM', subjectRef, rule, severity: 'ATTENTION', reasons: reasons as [Reason, ...Reason[]] });
  }
  return flags;
}

/**
 * Whether a run charts a series: a run with a reference set only that set's series and chart; a run without one every
 * series no set in force covers. Returns the reason it does not, or null.
 */
function notCharted(subjectRef: string, chart: 'IMR' | 'XBAR_S', ref: ReferenceModel | null, covered: readonly string[] | undefined): string | null {
  if (ref === null) return covered?.includes(subjectRef) ? 'a reference set in force covers this chart; it is charted by that set\'s own run' : null;
  if (ref.model['subjectRef'] !== subjectRef || ref.model['chart'] !== chart) return `outside reference set ${ref.id}'s scope; it is charted by the run without a reference set`;
  return referenceLimits(ref, subjectRef, chart) ? null : `reference set ${ref.id} does not hold a centre and a positive sigma; not charted`;
}

/** The model candidate of a chart with complete Phase I limits (D-6A-3-7). */
function spcCandidate(subjectRef: string, chart: 'IMR' | 'XBAR_S', limits: Limits, phaseOne: readonly BatchRef[], m: number): OutputDraft {
  const model = { subjectRef, chart, centre: limits.centre, sigma: limits.sigma, batchIds: phaseOne.map((b) => b.batchId).sort(), phaseOneBatches: m };
  const [product, family, item] = subjectRef.split('|');
  return {
    subjectKind: 'PRODUCT_ITEM', subjectRef, kind: 'MODEL_CANDIDATE',
    values: {
      model, modelSha256: sha256Hex(canonicalText(model)), product: product ?? '', family: family ?? '', item: item ?? '', chart, centre: limits.centre, sigma: limits.sigma,
      batches: phaseOne.length, batchIds: phaseOne.map((b) => b.batchId), batchNumbers: phaseOne.map((b) => b.batchNumber),
    },
    reasons: [{ code: 'CANDIDATE', text: `the Phase I limits of the first ${m.toString()} batches; QA can make them the chart's reference set under a change record` }],
  };
}

/** The rule names per point (for the chart's points), as a ';'-separated list per point, ','-joined. */
const pointRules = (n: number, hits: readonly RuleHit[]): string =>
  Array.from({ length: n }, (_, k) => [...new Set(hits.filter((h) => h.points.includes(k)).map((h) => h.rule))].sort().join(';')).join(',');

export function runImr(input: BatchValueInput, params: SpcParameters, ref: ReferenceModel | null): MethodResult {
  const outputs: OutputDraft[] = [];
  const flags: FlagDraft[] = [];
  const skipped: Skipped[] = [];
  for (const s of input.series) {
    const subjectRef = seriesRef(s);
    const m = params.phaseOneBatches;
    const not = notCharted(subjectRef, 'IMR', ref, input.covered);
    if (not !== null) {
      skipped.push({ subject: subjectRef, reason: not });
      continue;
    }
    const x = s.points.map((p) => statOf(p.value));
    const fromRef = referenceLimits(ref, subjectRef, 'IMR');
    if (!fromRef && x.length < m) {
      skipped.push({ subject: subjectRef, reason: `an I-MR chart needs ${m.toString()} completed batches for its Phase I limits; there are ${x.length.toString()}` });
      continue;
    }
    if (x.length < 2) {
      skipped.push({ subject: subjectRef, reason: 'an I-MR chart needs two or more batches' });
      continue;
    }
    const mr = movingRanges(x);
    const phaseMr = movingRanges(x.slice(0, m));
    const limits: Limits = fromRef ?? { centre: mean(x.slice(0, m)), sigma: mean(phaseMr) / D2_TWO, source: 'PHASE_I' };
    if (!(limits.sigma > 0)) {
      skipped.push({ subject: subjectRef, reason: 'the Phase I batches show no variation (every moving range is 0), so no limits can be set' });
      continue;
    }
    const z = x.map((v) => (v - limits.centre) / limits.sigma);
    const hits = nelsonHits(z, params.rules);
    const mrBar = limits.sigma * D2_TWO;
    outputs.push({
      subjectKind: 'PRODUCT_ITEM',
      subjectRef,
      kind: 'CONTROL_CHART',
      values: {
        product: s.product, family: s.family, item: s.item, chart: 'IMR', limitsSource: limits.source, phaseOneBatches: Math.min(m, x.length),
        centre: limits.centre, sigma: limits.sigma, upperControl: limits.centre + 3 * limits.sigma, lowerControl: limits.centre - 3 * limits.sigma,
        movingRangeMean: mrBar, movingRangeUpper: D4_TWO * mrBar,
        ...specificationValues(s.specification),
        batchIds: s.points.map((p) => p.batchId).join(','),
        valueTexts: s.points.map((p) => p.value).join(','),
        plotted: x, spread: mr, pointRules: pointRules(x.length, hits),
      },
      reasons: [limitsReason(limits, m, ref?.id ?? null), { code: 'CHART_IMR', text: `I-MR chart of ${x.length.toString()} batches (${LABEL[limits.source]})` }],
    });
    flags.push(...ruleFlags(subjectRef, hits, s.points, `${s.item} I-MR chart`));
    if (limits.source === 'PHASE_I' && x.length >= m) outputs.push(spcCandidate(subjectRef, 'IMR', limits, s.points.slice(0, m), m));
  }
  return { outputs, flags, skipped };
}

/** The most frequent subgroup size (the smallest if tied). */
function modalSize(sizes: readonly number[]): number {
  const count = new Map<number, number>();
  for (const n of sizes) count.set(n, (count.get(n) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
}

export function runXbarS(input: SubgroupInput, params: XbarSParameters, ref: ReferenceModel | null): MethodResult {
  const outputs: OutputDraft[] = [];
  const flags: FlagDraft[] = [];
  const skipped: Skipped[] = [];
  for (const s of input.series) {
    const subjectRef = seriesRef(s);
    const m = params.phaseOneBatches;
    const not = notCharted(subjectRef, 'XBAR_S', ref, input.covered);
    if (not !== null) {
      skipped.push({ subject: subjectRef, reason: not });
      continue;
    }
    const kept = s.points.filter((p) => {
      if (p.values.length >= params.minSubgroup) return true;
      skipped.push({ subject: `${subjectRef}|${p.batchNumber}`, reason: `fewer than ${params.minSubgroup.toString()} readings (${p.values.length.toString()}); not charted` });
      return false;
    });
    const groups = kept.map((p) => p.values.map((v) => statOf(v)));
    const fromRef = referenceLimits(ref, subjectRef, 'XBAR_S');
    if (!fromRef && groups.length < m) {
      skipped.push({ subject: subjectRef, reason: `an Xbar-S chart needs ${m.toString()} completed batches for its Phase I limits; there are ${groups.length.toString()}` });
      continue;
    }
    if (groups.length === 0) continue;
    const means = groups.map(mean);
    const sds = groups.map(sampleSd);
    const sizes = groups.map((g) => g.length);
    const phase = groups.slice(0, m);
    const phaseN = phase.reduce((t, g) => t + g.length, 0);
    const limits: Limits = fromRef ?? {
      centre: phase.reduce((t, g, k) => t + means[k]! * g.length, 0) / phaseN,
      sigma: mean(phase.map((g, k) => sds[k]! / c4(g.length))),
      source: 'PHASE_I',
    };
    if (!(limits.sigma > 0)) {
      skipped.push({ subject: subjectRef, reason: 'the Phase I subgroups show no variation, so no limits can be set' });
      continue;
    }
    const z = means.map((v, k) => (v - limits.centre) / (limits.sigma / Math.sqrt(sizes[k]!)));
    const hits = nelsonHits(z, params.rules);
    const n = modalSize(sizes);
    const c = c4(n);
    const half = (3 * limits.sigma) / Math.sqrt(n);
    outputs.push({
      subjectKind: 'PRODUCT_ITEM',
      subjectRef,
      kind: 'CONTROL_CHART',
      values: {
        product: s.product, family: s.family, item: s.item, chart: 'XBAR_S', limitsSource: limits.source, phaseOneBatches: Math.min(m, groups.length),
        centre: limits.centre, sigma: limits.sigma, upperControl: limits.centre + half, lowerControl: limits.centre - half, subgroupSize: n,
        sCentre: c * limits.sigma, sUpper: limits.sigma * (c + 3 * Math.sqrt(1 - c * c)), sLower: Math.max(0, limits.sigma * (c - 3 * Math.sqrt(1 - c * c))),
        ...specificationValues(s.specification),
        batchIds: kept.map((p) => p.batchId).join(','),
        plotted: means, spread: sds, sizes, pointRules: pointRules(means.length, hits),
      },
      reasons: [limitsReason(limits, m, ref?.id ?? null), { code: 'CHART_XBAR_S', text: `Xbar-S chart of ${means.length.toString()} batches, subgroups of ${n.toString()} readings (${LABEL[limits.source]})` }],
    });
    flags.push(...ruleFlags(subjectRef, hits, kept, `${s.item} Xbar-S chart`));
    if (limits.source === 'PHASE_I' && groups.length >= m) outputs.push(spcCandidate(subjectRef, 'XBAR_S', limits, kept.slice(0, m), m));
  }
  return { outputs, flags, skipped };
}

export const SPC_IMR: Method<BatchValueInput, SpcParameters> = { id: 'SPC.IMR', versions: [1], run: runImr };
export const SPC_XBAR_S: Method<SubgroupInput, XbarSParameters> = { id: 'SPC.XBAR_S', versions: [1], run: runXbarS };
