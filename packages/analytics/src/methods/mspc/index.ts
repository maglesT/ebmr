/**
 * Method MSPC.PCA version 1, multivariate monitoring (decision 0016 item 2; slice 6A-3; D-6A-11, D-6A-3-1 to D-6A-3-9).
 * Advisory: it shows a batch whose combination of critical values departs from QA's reference batches, even when each
 * value is within its own limits, and names the variables that contribute most. It never writes a GMP record.
 *
 * A scope is a product and MBR family. A batch's vector holds the critical items of the scope (one value per batch, or
 * the mean of a subgroup item's readings; the runner assembles them from 6A-2's batch vectors), autoscaled. The
 * arithmetic is pca.ts.
 *
 * Without a reference set (ref null) the method fits a model candidate per scope (output MODEL_CANDIDATE, subject
 * PRODUCT_ITEM `<product>|<family>`):
 *   1. The batches that may be reference batches: released, no critical deviation linked, every variable recorded
 *      (the others are named with the reason, at most 50, then counted); the newest `maxReferenceBatches` of them, in
 *      completion order (older batches are counted, not named).
 *   2. Variables without variation among them are left out of the model, with the reason; a model needs two or more.
 *   3. Fewer than `minReferenceBatches` batches, or no more than the variables plus one, give no model, with the reason.
 *   4. A first fit; the batches beyond its Phase I limits (T-squared above the beta limit or Q above the Q limit) are
 *      left out, named with their values, and the model is fitted again on the rest (once; D-6A-3-3). Step 3's minimum
 *      applies again.
 * The candidate's values hold the model, its SHA-256 (canonical text), the reference batches' T-squared and Q, and the
 * batches left out. QA makes it effective as a reference set under an ANALYTICS_REFERENCE change record; the database
 * checks the model and its hash are the candidate's (EBMR-ANA-010, kernel 1270 EBMR-ANA-030).
 *
 * With a reference set the method scores the scope's batches against its model (output MSPC_SCORE per batch, subject
 * BATCH): every reference batch (against the beta limit) and the newest `scoredBatches` other batches (against the F
 * limit). It flags T2_ABOVE and Q_ABOVE on the other batches only (a reference batch is one QA approved), each flag
 * naming its top contributing variables. A batch missing a variable of the model is skipped with the reason. A
 * reference set fitted with other fit parameters than this version's is not scored, with the reason.
 */
import { AnalyticsInputError } from '../../errors.ts';
import type { Method, MethodResult, Parameters, ReferenceModel, Skipped } from '../../method.ts';
import { canonicalText } from '../../numeric/canonical.ts';
import { statOf, type DecimalText } from '../../numeric/from-decimal.ts';
import { sha256Hex } from '../../numeric/sha256.ts';
import type { FlagDraft, OutputDraft, Reason } from '../../types.ts';
import { fitPca, scorePca, type PcaFit, type PcaScore } from './pca.ts';

export { columnMoments, fitPca, qLimit, scorePca, t2NewLimit, t2ReferenceLimit, type PcaFit, type PcaScore, type QLimit, type QLimitMethod } from './pca.ts';

export interface MspcParameters extends Parameters {
  readonly maxComponents: number;
  readonly varianceTarget: number;
  readonly limitConfidence: number;
  readonly minReferenceBatches: number;
  readonly maxReferenceBatches: number;
  readonly scoredBatches: number;
}

/** One completed batch of a scope: each variable's recorded value, or a subgroup item's readings, as decimal text. */
export interface MspcBatch {
  readonly batchId: string;
  readonly batchNumber: string;
  readonly completedAt: string;
  readonly values: Readonly<Record<string, readonly DecimalText[]>>;
  /** Why the batch may not be a reference batch (not released, a critical deviation), or null when it may. */
  readonly notReference: string | null;
}

export interface MspcScopeInput {
  readonly product: string;
  readonly family: string;
  /** The scope's variables (the critical items of its newest batch), sorted. */
  readonly variables: readonly string[];
  /** In completion order. */
  readonly batches: readonly MspcBatch[];
}

export interface MspcInput {
  readonly scopes: readonly MspcScopeInput[];
}

/** The fit parameters a model records; a reference set is scored only by a version with the same (D-6A-3-6). */
export interface MspcFitParameters {
  readonly varianceTarget: number;
  readonly maxComponents: number;
  readonly limitConfidence: number;
  readonly minReferenceBatches: number;
  readonly maxReferenceBatches: number;
}

/** The model a candidate holds and a reference set carries. */
export interface MspcModel extends PcaFit {
  readonly method: 'MSPC.PCA';
  readonly scope: { readonly product: string; readonly family: string };
  readonly variables: readonly string[];
  /** The reference batches, sorted. */
  readonly batchIds: readonly string[];
  readonly confidence: number;
  readonly fit: MspcFitParameters;
}

export const mspcScopeRef = (product: string, family: string): string => `${product}|${family}`;

/** The SHA-256 of a model's canonical text (what a candidate records and a reference set must carry). */
export function mspcModelSha256(model: MspcModel): string {
  return sha256Hex(canonicalText(model));
}

const fitOf = (p: MspcParameters): MspcFitParameters => ({
  varianceTarget: p.varianceTarget, maxComponents: p.maxComponents, limitConfidence: p.limitConfidence, minReferenceBatches: p.minReferenceBatches,
  maxReferenceBatches: p.maxReferenceBatches,
});

const isNumbers = (v: unknown, n?: number): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x)) && (n === undefined || v.length === n);
const isTexts = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '');

/** A reference set's model, checked for shape; throws AnalyticsInputError when it is not an MSPC.PCA model. */
export function mspcModelOf(m: Readonly<Record<string, unknown>>): MspcModel {
  const scope = m['scope'] as Record<string, unknown> | undefined;
  const fit = m['fit'] as Record<string, unknown> | undefined;
  const variables = m['variables'];
  const p = isTexts(variables) ? variables.length : -1;
  const k = m['components'];
  const loadings = m['loadings'];
  const ok = m['method'] === 'MSPC.PCA' && typeof scope?.['product'] === 'string' && typeof scope['family'] === 'string' && p >= 2
    && typeof k === 'number' && Number.isInteger(k) && k >= 1 && k < p && typeof m['n'] === 'number'
    && isNumbers(m['mean'], p) && isNumbers(m['sd'], p) && (m['sd']).every((s) => s > 0) && isNumbers(m['eigenvalues'], p) && isNumbers(m['explained'], p)
    && Array.isArray(loadings) && loadings.length === p && loadings.every((r) => isNumbers(r, k))
    && (m['eigenvalues']).slice(0, k).every((l) => l > 0)
    && isTexts(m['batchIds']) && ['t2Reference', 't2New', 'q', 'confidence'].every((f) => typeof m[f] === 'number' && Number.isFinite(m[f]) && (m[f]) > 0)
    && (m['qMethod'] === 'JACKSON_MUDHOLKAR' || m['qMethod'] === 'BOX')
    && fit !== undefined && ['varianceTarget', 'maxComponents', 'limitConfidence', 'minReferenceBatches', 'maxReferenceBatches'].every((f) => typeof fit[f] === 'number');
  if (!ok) throw new AnalyticsInputError('the reference set does not hold an MSPC.PCA model', m);
  return m as unknown as MspcModel;
}

/** Each variable's value of a batch: the recorded value, or the mean of a subgroup item's readings; null if missing. */
function vectorOf(b: MspcBatch, variables: readonly string[]): number[] | null {
  const out: number[] = [];
  for (const v of variables) {
    const texts = b.values[v];
    if (!texts || texts.length === 0) return null;
    out.push(texts.reduce((s, t) => s + statOf(t), 0) / texts.length);
  }
  return out;
}

const missingOf = (b: MspcBatch, variables: readonly string[]): string[] => variables.filter((v) => !(b.values[v]?.length));
const fixed = (x: number): string => x.toPrecision(4);
/** The batches left out of a candidate that its reasons name one by one (the rest are counted). */
const MAX_NAMED = 50;
const pct = (x: number): string => `${(100 * x).toFixed(0)} %`;

/**
 * The variables that contribute most to a statistic: largest first, until they cover 80 % of it, at most three
 * (D-6A-3-5). For T-squared only positive contributions count (a negative one lowers it).
 */
export function topContributors(variables: readonly string[], contributions: readonly number[]): { variable: string; share: number }[] {
  const positive = contributions.map((c, j) => ({ variable: variables[j]!, c: Math.max(c, 0) })).filter((x) => x.c > 0);
  const total = positive.reduce((s, x) => s + x.c, 0);
  if (!(total > 0)) return [];
  positive.sort((a, b) => b.c - a.c || (a.variable < b.variable ? -1 : 1));
  const out: { variable: string; share: number }[] = [];
  let covered = 0;
  for (const x of positive) {
    if (out.length === 3 || covered >= 0.8) break;
    out.push({ variable: x.variable, share: x.c / total });
    covered += x.c / total;
  }
  return out;
}

const named = (top: readonly { variable: string; share: number }[]): string => top.map((t) => `${t.variable} (${pct(t.share)})`).join(', ');

type Fitted = { ok: true; fit: PcaFit; variables: string[]; dropped: Reason[] } | { ok: false; why: string };

/** Fits on rows of the scope's variables, leaving out variables without variation (named). */
function fitRows(rows: readonly number[][], variables: readonly string[], p: MspcParameters, what: string): Fitted {
  const n = rows.length;
  if (n < p.minReferenceBatches) return { ok: false, why: `${n.toString()} ${what}; a model needs at least ${p.minReferenceBatches.toString()}` };
  const keep: number[] = [];
  const dropped: Reason[] = [];
  variables.forEach((v, j) => {
    const xs = rows.map((r) => r[j]!);
    if (xs.every((x) => x === xs[0])) dropped.push({ code: 'VARIABLE_LEFT_OUT', text: `${v}: no variation among the reference batches, so it is not in the model` });
    else keep.push(j);
  });
  if (keep.length < 2) return { ok: false, why: `${keep.length.toString()} variable(s) vary among the reference batches; a model needs two or more` };
  if (n <= keep.length + 1) return { ok: false, why: `${n.toString()} ${what} for ${keep.length.toString()} variables; a model needs more batches than variables plus one` };
  const fit = fitPca(rows.map((r) => keep.map((j) => r[j]!)), p);
  return { ok: true, fit, variables: keep.map((j) => variables[j]!), dropped };
}

function candidates(input: MspcInput, p: MspcParameters): MethodResult {
  const outputs: OutputDraft[] = [];
  const skipped: Skipped[] = [];
  for (const s of input.scopes) {
    const subject = mspcScopeRef(s.product, s.family);
    const notUsed: Reason[] = [];
    // From the newest batch back, until the newest maxReferenceBatches that may be reference batches are found; the
    // batches left out on the way are named (at most MAX_NAMED, then counted), older ones only counted (bounded output).
    const chosen: { b: MspcBatch; x: number[] }[] = [];
    let examined = 0;
    for (let i = s.batches.length - 1; i >= 0 && chosen.length < p.maxReferenceBatches; i--, examined++) {
      const b = s.batches[i]!;
      const evidence = [{ kind: 'BATCH', ref: b.batchId }];
      const missing = missingOf(b, s.variables);
      if (b.notReference !== null) notUsed.push({ code: 'NOT_REFERENCE', text: `${b.batchNumber}: ${b.notReference}`, evidence });
      else if (missing.length > 0) notUsed.push({ code: 'MISSING_VARIABLE', text: `${b.batchNumber}: ${missing.join(', ')} not recorded`, evidence });
      else chosen.unshift({ b, x: vectorOf(b, s.variables)! });
    }
    notUsed.reverse();
    if (notUsed.length > MAX_NAMED) {
      const more = notUsed.length - MAX_NAMED;
      notUsed.splice(MAX_NAMED, more, { code: 'NOT_REFERENCE_MORE', text: `${more.toString()} more batches may not be reference batches (not released, a critical deviation, or a variable not recorded)` });
    }
    const older = s.batches.length - examined;
    if (older > 0) notUsed.push({ code: 'OLDER', text: `${older.toString()} older batches: the candidate takes the newest ${p.maxReferenceBatches.toString()} that may be reference batches` });
    const first = fitRows(chosen.map((e) => e.x), s.variables, p, 'batches may be reference batches');
    if (!first.ok) {
      skipped.push({ subject, reason: first.why });
      continue;
    }
    // The first fit's Phase I limits leave out the batches beyond them; the model is fitted again on the rest (once).
    const index = first.variables.map((v) => s.variables.indexOf(v));
    const firstScores = chosen.map((e) => scorePca(first.fit, index.map((j) => e.x[j]!)));
    const outliers = chosen.filter((_, i) => firstScores[i]!.t2 > first.fit.t2Reference || firstScores[i]!.q > first.fit.q);
    for (const e of outliers) {
      const sc = firstScores[chosen.indexOf(e)]!;
      notUsed.push({
        code: 'BEYOND_PHASE_I',
        text: `${e.b.batchNumber}: beyond the first fit's Phase I limits (T-squared ${fixed(sc.t2)} against ${fixed(first.fit.t2Reference)}, Q ${fixed(sc.q)} against ${fixed(first.fit.q)}); left out of the refit`,
        evidence: [{ kind: 'BATCH', ref: e.b.batchId }],
      });
    }
    const kept = chosen.filter((e) => !outliers.includes(e));
    const second = outliers.length === 0 ? first : fitRows(kept.map((e) => e.x), s.variables, p, 'batches remain within the first fit\'s Phase I limits');
    if (!second.ok) {
      skipped.push({ subject, reason: second.why });
      continue;
    }
    const used = second.variables.map((v) => s.variables.indexOf(v));
    const model: MspcModel = {
      method: 'MSPC.PCA', scope: { product: s.product, family: s.family }, variables: second.variables, batchIds: kept.map((e) => e.b.batchId).sort(),
      ...second.fit, confidence: p.limitConfidence, fit: fitOf(p),
    };
    const sha = mspcModelSha256(model);
    const refScores = kept.map((e) => scorePca(model, used.map((j) => e.x[j]!)));
    outputs.push({
      subjectKind: 'PRODUCT_ITEM', subjectRef: subject, kind: 'MODEL_CANDIDATE',
      values: {
        model: model as unknown as Readonly<Record<string, unknown>>, modelSha256: sha, product: s.product, family: s.family, batches: kept.length,
        batchIds: kept.map((e) => e.b.batchId), batchNumbers: kept.map((e) => e.b.batchNumber), components: model.components, variables: [...model.variables],
        explainedVariance: model.explained.slice(0, model.components), t2Reference: model.t2Reference, t2New: model.t2New, qLimit: model.q, qMethod: model.qMethod,
        confidence: model.confidence, referenceT2: refScores.map((r) => r.t2), referenceQ: refScores.map((r) => r.q), leftOut: outliers.map((e) => e.b.batchId),
      },
      reasons: [
        {
          code: 'CANDIDATE',
          text: `fitted on ${kept.length.toString()} batches that may be reference batches (released, no critical deviation, every variable recorded), ${model.components.toString()} components explaining ${pct(model.explained.slice(0, model.components).reduce((a, b) => a + b, 0))}; QA makes it a reference set under a change record`,
        },
        ...second.dropped,
        ...notUsed,
      ],
    });
  }
  return { outputs, flags: [], skipped };
}

const sameFit = (a: MspcFitParameters, b: MspcFitParameters): boolean => canonicalText(a) === canonicalText(b);

function scores(input: MspcInput, p: MspcParameters, ref: ReferenceModel): MethodResult {
  const model = mspcModelOf(ref.model);
  const subject = mspcScopeRef(model.scope.product, model.scope.family);
  const scope = input.scopes.find((s) => s.product === model.scope.product && s.family === model.scope.family);
  if (!scope) return { outputs: [], flags: [], skipped: [{ subject, reason: `no completed batch of ${subject} was read` }] };
  if (!sameFit(model.fit, fitOf(p))) {
    return { outputs: [], flags: [], skipped: [{ subject, reason: `reference set ${ref.id} was fitted with other parameters than this method version's; it is not scored` }] };
  }
  const outputs: OutputDraft[] = [];
  const flags: FlagDraft[] = [];
  const skipped: Skipped[] = [];
  const refs = new Set(model.batchIds);
  const others = scope.batches.filter((b) => !refs.has(b.batchId));
  const window = new Set([...scope.batches.filter((b) => refs.has(b.batchId)), ...others.slice(-p.scoredBatches)]);
  for (const b of scope.batches) {
    if (!window.has(b)) continue;
    const reference = refs.has(b.batchId);
    const missing = missingOf(b, model.variables);
    if (missing.length > 0) {
      skipped.push({ subject: b.batchId, reason: `${b.batchNumber}: ${missing.join(', ')} not recorded; not scored` });
      continue;
    }
    const sc: PcaScore = scorePca(model, vectorOf(b, model.variables)!);
    const t2Limit = reference ? model.t2Reference : model.t2New;
    const evidence = [{ kind: 'BATCH', ref: b.batchId }, { kind: 'REFERENCE_SET', ref: ref.id }];
    const t2Top = topContributors(model.variables, sc.t2Contributions);
    const qTop = topContributors(model.variables, sc.qContributions);
    const t2Reason: Reason = {
      code: 'T2_ABOVE', weight: sc.t2, evidence,
      text: `Hotelling T-squared ${fixed(sc.t2)} against its ${pct(model.confidence)} limit ${fixed(t2Limit)} (${reference ? 'reference batch, beta' : 'new batch, F'}); top contributors ${named(t2Top) || 'none'}`,
    };
    const qReason: Reason = {
      code: 'Q_ABOVE', weight: sc.q, evidence,
      text: `Q residual ${fixed(sc.q)} against its ${pct(model.confidence)} limit ${fixed(model.q)}: the combination of values departs from the reference batches' correlation; top contributors ${named(qTop) || 'none'}`,
    };
    const t2Above = !reference && sc.t2 > t2Limit;
    const qAbove = !reference && sc.q > model.q;
    outputs.push({
      subjectKind: 'BATCH', subjectRef: b.batchId, kind: 'MSPC_SCORE',
      values: {
        status: 'SCORED', product: model.scope.product, family: model.scope.family, batchNumber: b.batchNumber, completedAt: b.completedAt, referenceSet: ref.id,
        reference: reference ? 'REFERENCE' : 'NEW', t2: sc.t2, q: sc.q, t2Limit, qLimit: model.q, confidence: model.confidence, scores: sc.scores,
        variables: [...model.variables], valueTexts: model.variables.map((v) => (b.values[v] ?? []).join(';')),
        t2Contributions: sc.t2Contributions, qContributions: sc.qContributions, flagged: [...(t2Above ? ['T2_ABOVE'] : []), ...(qAbove ? ['Q_ABOVE'] : [])],
      },
      reasons: [t2Reason, qReason],
    });
    if (t2Above) flags.push({ subjectKind: 'BATCH', subjectRef: b.batchId, rule: 'T2_ABOVE', severity: 'ATTENTION', reasons: [t2Reason] });
    if (qAbove) flags.push({ subjectKind: 'BATCH', subjectRef: b.batchId, rule: 'Q_ABOVE', severity: 'ATTENTION', reasons: [qReason] });
  }
  return { outputs, flags, skipped };
}

export function runMspc(input: MspcInput, params: MspcParameters, ref: ReferenceModel | null): MethodResult {
  return ref === null ? candidates(input, params) : scores(input, params, ref);
}

export const MSPC_PCA: Method<MspcInput, MspcParameters> = { id: 'MSPC.PCA', versions: [1], run: runMspc };
