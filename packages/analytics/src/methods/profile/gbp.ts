/**
 * Method GBP.DTW_BAND version 1, the golden batch profile (decision 0016 item 10; slice 6A-6; D-6A-16, D-6A-6-1 to
 * D-6A-6-8). Advisory: it compares a batch's equipment curve of one step and tag (the native OPC UA series of slice
 * 6b, connected equipment only) with the band of QA's reference batches, and never writes a GMP record.
 *
 * A curve is the series of one batch, MBR step and tag on its unit (scope: product, family, equipment type, step and
 * tag). Its usable samples are the GOOD and UNCERTAIN ones with a value; BAD samples are dropped and counted, UNCERTAIN
 * ones are used and counted (D-6A-6-5). A curve is not assessed, with the reason, when its step has not ended on the
 * unit, when it has fewer than `minSamples` usable samples, or when a gap between usable samples is longer than
 * `maxGapShare` of its time (missing samples). Each assessed curve is resampled to `points` instants of normalised
 * step time (its first to its last usable sample).
 *
 * Without a reference set (ref null) the method fits a model candidate per scope (output MODEL_CANDIDATE) on the batches
 * that may be reference batches: released, no deviation linked to the batch, no alarm on the step (D-6A-6-2); at least
 * `minReferenceBatches`, else the scope is skipped with the reason. The fit:
 *   - the medoid: the reference curve with the least sum of DTW distances to the others (Sakoe-Chiba band of
 *     `sakoeChiba` of the points);
 *   - every reference curve aligned to the medoid by DTW;
 *   - the band: the pointwise `bandLowPercentile` to `bandHighPercentile` percentile of the aligned references, with a
 *     timing tolerance of `bandTolerancePoints` (D-6A-6-3);
 *   - the distance limit: the references' `distancePercentile` percentile of DTW distance to the medoid, estimated as a
 *     log-normal prediction limit (D-6A-6-4).
 * The model and its SHA-256 (canonical text) are the candidate's values; QA makes it effective as a reference set under
 * an ANALYTICS_REFERENCE change record, and the database checks the hash (EBMR-ANA-010).
 *
 * With a reference set the method scores every assessed curve of the set's scope (output PROFILE_DISTANCE per batch):
 * the curve aligned to the medoid by DTW, its share of points outside the band and its DTW distance. It flags
 * OUT_OF_BAND when more than `outsideShare` of the points fall outside, and DTW_DISTANCE when the distance is above the
 * limit. A curve not assessed gets a PROFILE_DISTANCE output with status NOT_ASSESSED and the reason, and no flag.
 */
import { AnalyticsInputError } from '../../errors.ts';
import type { Method, MethodResult, Parameters, ReferenceModel, Skipped } from '../../method.ts';
import { canonicalText } from '../../numeric/canonical.ts';
import { decimalText, isDecimalText, statOf } from '../../numeric/from-decimal.ts';
import { tQuantile } from '../../numeric/quantiles.ts';
import { sha256Hex } from '../../numeric/sha256.ts';
import type { FlagDraft, OutputDraft, Reason } from '../../types.ts';
import { alignAlong, bandRadius, dtw, medoidIndex, meanSd, outsidePoints, pointwiseBand, resample } from './curves.ts';

export type SampleStatus = 'GOOD' | 'UNCERTAIN' | 'BAD';

/** One native sample as report.series_samples_v1 gives it: source time in epoch microseconds and the shown decimal. */
export interface ProfileSample {
  readonly sourceUs: string;
  /** The decimal text the eBMR shows (null for a BAD sample or a value that is not a number). */
  readonly value: string | null;
  readonly status: SampleStatus;
}

/** What a profile is per: the product and family (whose master the step belongs to), equipment type, step and tag. */
export interface ProfileScope {
  readonly productCode: string;
  readonly familyCode: string;
  readonly equipmentType: string;
  readonly step: string;
  readonly tag: string;
}

/** One batch's series of one step and tag on its unit (report.series_ref_v1 with its samples). */
export interface ProfileCurve extends ProfileScope {
  readonly batchId: string;
  readonly batchNumber: string;
  readonly equipmentCode: string;
  readonly unit: string;
  /** Whether the step's window on the unit has ended (an open window is not profiled). */
  readonly ended: boolean;
  /** Why the batch may not be a reference batch; null when it may (released, no deviation, no alarm on the step). */
  readonly notReference: string | null;
  readonly samples: readonly ProfileSample[];
}

export interface ProfileInput {
  readonly curves: readonly ProfileCurve[];
}

export interface GbpParameters extends Parameters {
  readonly points: number;
  readonly sakoeChiba: number;
  readonly bandLowPercentile: number;
  readonly bandHighPercentile: number;
  readonly outsideShare: number;
  readonly distancePercentile: number;
  readonly minReferenceBatches: number;
  readonly bandTolerancePoints: number;
  readonly maxGapShare: number;
  readonly minSamples: number;
}

/** What a model was fitted with; a reference set is scored only by a version with the same (D-6A-6-6). */
export interface ProfileFit {
  readonly points: number;
  readonly sakoeChiba: number;
  readonly radius: number;
  readonly bandLowPercentile: number;
  readonly bandHighPercentile: number;
  readonly bandTolerancePoints: number;
  readonly distancePercentile: number;
}

/** The fitted golden profile of one scope (a model candidate's `model`, and a reference set's). */
export interface ProfileModel {
  readonly method: 'GBP.DTW_BAND';
  readonly scope: ProfileScope;
  readonly unit: string;
  readonly fit: ProfileFit;
  /** The reference batches, sorted, and the medoid among them. */
  readonly batchIds: readonly string[];
  readonly medoidBatchId: string;
  /** The medoid curve (the reference the curves are aligned to) and the band, each `points` long. */
  readonly reference: readonly number[];
  readonly low: readonly number[];
  readonly high: readonly number[];
  /** Each reference batch's DTW distance to the medoid (in batchIds order) and the distance limit. */
  readonly distances: readonly number[];
  readonly distanceLimit: number;
}

/** The scope as text (subject of a candidate): product|family|equipment type|step|tag. */
export function scopeKey(s: ProfileScope): string {
  return [s.productCode, s.familyCode, s.equipmentType, s.step, s.tag].join('|');
}

const scopeOf = (s: ProfileScope): ProfileScope => ({ productCode: s.productCode, familyCode: s.familyCode, equipmentType: s.equipmentType, step: s.step, tag: s.tag });

/** The SHA-256 of a model's canonical text (what a candidate records and a reference set must carry). */
export function profileModelSha256(model: ProfileModel): string {
  return sha256Hex(canonicalText(model));
}

export interface SampleCounts {
  /** Usable samples (GOOD and UNCERTAIN with a value). */
  readonly used: number;
  /** BAD samples, and samples without a value, dropped. */
  readonly droppedBad: number;
  /** UNCERTAIN samples among the used ones. */
  readonly uncertain: number;
}

export interface PreparedCurve {
  readonly curve: ProfileCurve;
  readonly counts: SampleCounts;
  /** Resampled to the version's points over normalised step time. */
  readonly values: readonly number[];
  /** The normalisation window: the first and last usable sample (epoch microseconds, as given). */
  readonly startUs: string;
  readonly endUs: string;
}

export type Preparation = { readonly ok: true; readonly prepared: PreparedCurve } | { readonly ok: false; readonly counts: SampleCounts; readonly why: string };

const pct = (x: number): string => `${(Math.round(x * 1000) / 10).toString()} %`;

/** A curve's usable samples, resampled; or why it is not assessed (D-6A-6-5). */
export function prepareCurve(curve: ProfileCurve, p: GbpParameters): Preparation {
  const usable: { t: number; v: number; us: string; status: SampleStatus }[] = [];
  let droppedBad = 0;
  for (const s of curve.samples) {
    if (s.status === 'BAD' || s.value === null) {
      droppedBad += 1;
      continue;
    }
    if (!isDecimalText(s.sourceUs)) throw new AnalyticsInputError(`a sample's source time is epoch microseconds as decimal text, not ${JSON.stringify(s.sourceUs)}`, s);
    usable.push({ t: statOf(s.sourceUs), v: statOf(decimalText(s.value)), us: s.sourceUs, status: s.status });
  }
  usable.sort((a, b) => a.t - b.t);
  // A repeated source time keeps its first sample (chunks never overlap, so this is a guard, not a rule of the data).
  const distinct = usable.filter((s, i) => i === 0 || s.t !== usable[i - 1]!.t);
  droppedBad += usable.length - distinct.length;
  const counts: SampleCounts = { used: distinct.length, droppedBad, uncertain: distinct.filter((s) => s.status === 'UNCERTAIN').length };
  if (!curve.ended) return { ok: false, counts, why: 'the step has not ended on the unit, so its curve is not complete' };
  if (distinct.length < p.minSamples) {
    return { ok: false, counts, why: `${distinct.length} usable samples (${droppedBad} BAD dropped); a curve needs at least ${p.minSamples}` };
  }
  const span = distinct[distinct.length - 1]!.t - distinct[0]!.t;
  let gap = 0;
  for (let i = 1; i < distinct.length; i++) gap = Math.max(gap, distinct[i]!.t - distinct[i - 1]!.t);
  if (gap > p.maxGapShare * span) {
    return { ok: false, counts, why: `missing samples: a gap of ${pct(gap / span)} of the curve's time between usable samples (at most ${pct(p.maxGapShare)})` };
  }
  const values = resample({ t: distinct.map((s) => s.t), v: distinct.map((s) => s.v) }, p.points);
  return { ok: true, prepared: { curve, counts, values, startUs: distinct[0]!.us, endUs: distinct[distinct.length - 1]!.us } };
}

/**
 * The distance limit: the `percentile`th percentile of the references' DTW distances to the medoid, as a log-normal
 * prediction limit for one new batch, exp(m + t(p, n - 1) s sqrt(1 + 1/n)) over the n positive distances (the medoid's
 * own is 0). An empirical 99th percentile of 10 to 50 distances is the largest one or beyond it (D-6A-6-4). With fewer
 * than three positive distances the limit is the largest distance.
 */
export function distanceLimitOf(distances: readonly number[], percentile: number): number {
  const positive = distances.filter((d) => d > 0);
  if (positive.length < 3) return Math.max(0, ...distances);
  const logs = positive.map((d) => Math.log(d));
  const { mean, sd } = meanSd(logs);
  const n = logs.length;
  return Math.exp(mean + tQuantile(percentile / 100, n - 1) * sd * Math.sqrt(1 + 1 / n));
}

function fitOf(p: GbpParameters): ProfileFit {
  return {
    points: p.points, sakoeChiba: p.sakoeChiba, radius: bandRadius(p.points, p.sakoeChiba), bandLowPercentile: p.bandLowPercentile,
    bandHighPercentile: p.bandHighPercentile, bandTolerancePoints: p.bandTolerancePoints, distancePercentile: p.distancePercentile,
  };
}

/** The model of one scope fitted on its reference curves (each already prepared with `p`). */
export function fitProfile(scope: ProfileScope, references: readonly PreparedCurve[], p: GbpParameters): ProfileModel {
  if (references.length < 2) throw new AnalyticsInputError('a profile is fitted on at least two reference curves', references.length);
  const refs = [...references].sort((a, b) => (a.curve.batchId < b.curve.batchId ? -1 : a.curve.batchId > b.curve.batchId ? 1 : 0));
  const fit = fitOf(p);
  const d: number[][] = refs.map(() => refs.map(() => 0));
  for (let i = 0; i < refs.length; i++) {
    for (let k = i + 1; k < refs.length; k++) {
      const x = dtw(refs[i]!.values, refs[k]!.values, fit.radius).distance;
      d[i]![k] = x;
      d[k]![i] = x;
    }
  }
  const m = medoidIndex(d);
  const reference = refs[m]!.values;
  const aligned = refs.map((r) => alignAlong(r.values, dtw(r.values, reference, fit.radius).path, p.points));
  const band = pointwiseBand(aligned, p.bandLowPercentile, p.bandHighPercentile, p.bandTolerancePoints);
  const distances = refs.map((_, i) => d[i]![m]!);
  return {
    method: 'GBP.DTW_BAND', scope: scopeOf(scope), unit: refs[m]!.curve.unit, fit, batchIds: refs.map((r) => r.curve.batchId), medoidBatchId: refs[m]!.curve.batchId,
    reference: [...reference], low: band.low, high: band.high, distances, distanceLimit: distanceLimitOf(distances, p.distancePercentile),
  };
}

export interface ProfileScore {
  /** The curve aligned to the model's medoid. */
  readonly curve: readonly number[];
  readonly distance: number;
  /** The points outside the band (indices) and their share of all points. */
  readonly outside: readonly number[];
  readonly outsideShare: number;
}

/** A prepared curve against a model. */
export function scoreCurve(prepared: PreparedCurve, model: ProfileModel): ProfileScore {
  const { path, distance } = dtw(prepared.values, model.reference, model.fit.radius);
  const curve = alignAlong(prepared.values, path, model.reference.length);
  const outside = outsidePoints(curve, { low: [...model.low], high: [...model.high] });
  return { curve, distance, outside, outsideShare: outside.length / curve.length };
}

const isNumbers = (x: unknown, n: number): x is number[] => Array.isArray(x) && x.length === n && x.every((v) => typeof v === 'number' && Number.isFinite(v));
const isText = (x: unknown): x is string => typeof x === 'string' && x.length > 0;

/** A reference set's model as this method fitted it, or AnalyticsInputError (the run then fails with the reason). */
export function profileModelOf(model: Readonly<Record<string, unknown>>): ProfileModel {
  const m = model as Partial<Record<keyof ProfileModel, unknown>>;
  const scope = m.scope as Partial<Record<keyof ProfileScope, unknown>> | undefined;
  const fit = m.fit as Partial<Record<keyof ProfileFit, unknown>> | undefined;
  const points = typeof fit?.points === 'number' ? fit.points : -1;
  const ok =
    m.method === 'GBP.DTW_BAND' && scope !== undefined && [scope.productCode, scope.familyCode, scope.equipmentType, scope.step, scope.tag].every(isText) &&
    isText(m.unit) && fit !== undefined && Number.isInteger(points) && points >= 2 &&
    [fit.sakoeChiba, fit.radius, fit.bandLowPercentile, fit.bandHighPercentile, fit.bandTolerancePoints, fit.distancePercentile].every((x) => typeof x === 'number' && Number.isFinite(x)) &&
    Array.isArray(m.batchIds) && m.batchIds.length >= 2 && m.batchIds.every(isText) && isText(m.medoidBatchId) && m.batchIds.includes(m.medoidBatchId) &&
    isNumbers(m.reference, points) && isNumbers(m.low, points) && isNumbers(m.high, points) && isNumbers(m.distances, m.batchIds.length) &&
    typeof m.distanceLimit === 'number' && Number.isFinite(m.distanceLimit);
  if (!ok) throw new AnalyticsInputError('the reference set does not hold a GBP.DTW_BAND model (method, scope, unit, fit, batches, medoid, band, distances, limit)', model);
  return model as unknown as ProfileModel;
}

const sameFit = (a: ProfileFit, b: ProfileFit): boolean => canonicalText(a) === canonicalText(b);

interface Identity {
  readonly [k: string]: string;
}

function identityOf(c: ProfileCurve): Identity {
  return {
    batchNumber: c.batchNumber, productCode: c.productCode, familyCode: c.familyCode, equipmentType: c.equipmentType, equipmentCode: c.equipmentCode, step: c.step,
    tag: c.tag, unit: c.unit,
  };
}

const byBatch = (a: ProfileCurve, b: ProfileCurve): number =>
  a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : a.equipmentCode < b.equipmentCode ? -1 : a.equipmentCode > b.equipmentCode ? 1 : 0;

function groups(curves: readonly ProfileCurve[]): Map<string, ProfileCurve[]> {
  const out = new Map<string, ProfileCurve[]>();
  for (const c of [...curves].sort(byBatch)) {
    const k = scopeKey(c);
    const list = out.get(k) ?? [];
    list.push(c);
    out.set(k, list);
  }
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function candidates(input: ProfileInput, p: GbpParameters): MethodResult {
  const outputs: OutputDraft[] = [];
  const skipped: Skipped[] = [];
  for (const [key, curves] of groups(input.curves)) {
    const notUsed: Reason[] = [];
    const references: PreparedCurve[] = [];
    const perBatch = new Map<string, number>();
    for (const c of curves) perBatch.set(c.batchId, (perBatch.get(c.batchId) ?? 0) + 1);
    for (const c of curves) {
      const evidence = [{ kind: 'BATCH', ref: c.batchId }];
      const why = c.notReference ?? (perBatch.get(c.batchId)! > 1 ? 'the step ran on more than one unit of this type' : null);
      if (why !== null) {
        notUsed.push({ code: 'NOT_REFERENCE', text: `${c.batchNumber} (${c.equipmentCode}): ${why}`, evidence });
        continue;
      }
      const prep = prepareCurve(c, p);
      if (!prep.ok) {
        notUsed.push({ code: 'NOT_ASSESSED', text: `${c.batchNumber} (${c.equipmentCode}): ${prep.why}`, evidence });
        continue;
      }
      references.push(prep.prepared);
    }
    const units = new Set(references.map((r) => r.curve.unit));
    if (units.size > 1) {
      skipped.push({ subject: key, reason: `the reference curves are in more than one unit (${[...units].sort().join(', ')})` });
      continue;
    }
    if (references.length < p.minReferenceBatches) {
      skipped.push({ subject: key, reason: `${references.length} batches may be reference batches; a profile needs at least ${p.minReferenceBatches}` });
      continue;
    }
    const model = fitProfile(curves[0]!, references, p);
    const sha = profileModelSha256(model);
    outputs.push({
      subjectKind: 'EQUIPMENT_STEP_TAG', subjectRef: key, kind: 'MODEL_CANDIDATE',
      values: {
        model: model as unknown as Readonly<Record<string, unknown>>, modelSha256: sha, ...scopeOf(model.scope), unit: model.unit, batches: model.batchIds.length,
        batchIds: model.batchIds, medoidBatchId: model.medoidBatchId, distanceLimit: model.distanceLimit,
      },
      reasons: [
        { code: 'CANDIDATE', text: `fitted on ${model.batchIds.length} batches that may be reference batches (released, no deviation, no alarm on the step); QA makes it a reference set under a change record` },
        ...notUsed,
      ],
    });
  }
  return { outputs, flags: [], skipped };
}

function scores(input: ProfileInput, p: GbpParameters, ref: ReferenceModel): MethodResult {
  const model = profileModelOf(ref.model);
  const key = scopeKey(model.scope);
  const curves = (groups(input.curves).get(key) ?? []);
  if (!sameFit(model.fit, fitOf(p))) {
    return { outputs: [], flags: [], skipped: curves.map((c) => ({ subject: c.batchId, reason: `reference set ${ref.id} was fitted with other parameters than this method version's; it is not scored` })) };
  }
  const outputs: OutputDraft[] = [];
  const flags: FlagDraft[] = [];
  const skipped: Skipped[] = [];
  const references = model.batchIds.length;
  for (const c of curves) {
    const evidence = [{ kind: 'BATCH', ref: c.batchId }, { kind: 'REFERENCE_SET', ref: ref.id }];
    const prep = c.unit === model.unit ? prepareCurve(c, p) : ({ ok: false, counts: { used: 0, droppedBad: 0, uncertain: 0 }, why: `the series is in ${c.unit}, the reference set in ${model.unit}` } as const);
    if (!prep.ok) {
      skipped.push({ subject: c.batchId, reason: prep.why });
      outputs.push({
        subjectKind: 'BATCH', subjectRef: c.batchId, kind: 'PROFILE_DISTANCE',
        values: { status: 'NOT_ASSESSED', ...identityOf(c), referenceSet: ref.id, why: prep.why, ...prep.counts },
        reasons: [{ code: 'NOT_ASSESSED', text: prep.why, evidence }],
      });
      continue;
    }
    const s = scoreCurve(prep.prepared, model);
    const reasons: Reason[] = [];
    const outside: Reason = {
      code: 'OUT_OF_BAND', weight: s.outsideShare, evidence,
      text: `${pct(s.outsideShare)} of the ${s.curve.length} points of ${c.tag} in ${c.step} fall outside the band of ${references} reference batches (flagged above ${pct(p.outsideShare)})`,
    };
    const far: Reason = {
      code: 'DTW_DISTANCE', weight: s.distance, evidence,
      text: `the DTW distance to the reference curve is ${s.distance.toPrecision(4)} ${model.unit}, against the references' ${p.distancePercentile}th percentile of ${model.distanceLimit.toPrecision(4)}`,
    };
    reasons.push(outside, far);
    outputs.push({
      subjectKind: 'BATCH', subjectRef: c.batchId, kind: 'PROFILE_DISTANCE',
      values: {
        status: 'PROFILED', ...identityOf(c), referenceSet: ref.id, points: s.curve.length, curve: s.curve, distance: s.distance, distanceLimit: model.distanceLimit,
        outsideShare: s.outsideShare, outsidePoints: s.outside.length, ...prep.prepared.counts, startUs: prep.prepared.startUs, endUs: prep.prepared.endUs,
      },
      reasons,
    });
    if (s.outsideShare > p.outsideShare) flags.push({ subjectKind: 'BATCH', subjectRef: c.batchId, rule: 'OUT_OF_BAND', severity: 'ATTENTION', reasons: [outside] });
    if (s.distance > model.distanceLimit) flags.push({ subjectKind: 'BATCH', subjectRef: c.batchId, rule: 'DTW_DISTANCE', severity: 'ATTENTION', reasons: [far] });
  }
  return { outputs, flags, skipped };
}

export const GBP_DTW_BAND: Method<ProfileInput, GbpParameters> = {
  id: 'GBP.DTW_BAND',
  versions: [1],
  run: (input, params, ref) => (ref === null ? candidates(input, params) : scores(input, params, ref)),
};
