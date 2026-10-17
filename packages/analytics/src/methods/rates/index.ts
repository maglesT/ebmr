/**
 * RATE.DEVIATION (slice 6A-2; D-6A-10, D-6A-2-6 to D-6A-2-9): the deviation rate of each step, equipment, room,
 * material lot, supplier and shift of a product, each compared with the rest of the product's batches.
 *
 * For a grouping (say ROOM) and a group (R-2):
 *   - the group's batches are the completed batches exposed to it (a step ran in the room); a deviation counts for the
 *     group when it is attributed to it (report.deviation_fact_v1: the step its exception was raised at, that step's
 *     unit, room and consumed lots, the shift it was raised in). A deviation linked to the batch only is unattributed
 *     for every grouping but SHIFT (D-6A-10) and counts in `unattributedDeviations`, not in a group or the rest;
 *   - the share of the group's batches with a deviation gets a Wilson interval, the deviations per 100 batches an exact
 *     Poisson (Garwood) interval, both at `confidence`;
 *   - the rest is the product's batches not exposed to the group, with a deviation attributed within the grouping; the
 *     group is compared with it by Fisher's exact test, one-sided (the group's share higher);
 *   - the p-values of the compared groups of one product and grouping get Benjamini-Hochberg q-values; a group is
 *     ABOVE when q <= falseDiscoveryRate and its share is higher than the rest's, and that raises RATE_ABOVE;
 *   - a group with fewer than `minBatchesPerGroup` batches, or with no batch outside it, is reported with the reason
 *     and not compared;
 *   - the funnel limits at the group's size are p0 +- z sqrt(p0 (1 - p0) / n), p0 the product's share of batches with
 *     a deviation attributed within the grouping, clipped to [0, 1].
 * One output per group (subject GROUP, `<product>|<grouping>:<group>`), so a flag names its own output.
 */
import type { Method, MethodResult, Parameters } from '../../method.ts';
import { chiSquareQuantile, normalQuantile } from '../../numeric/quantiles.ts';
import type { FlagDraft, OutputDraft } from '../../types.ts';

export const GROUPINGS = ['STEP', 'EQUIPMENT', 'ROOM', 'MATERIAL_LOT', 'SUPPLIER', 'SHIFT'] as const;
export type Grouping = (typeof GROUPINGS)[number];
export type GroupMembership = Readonly<Partial<Record<Grouping, readonly string[]>>>;

export interface RateBatch {
  readonly batchId: string;
  readonly batchNumber: string;
  readonly completedAt: string;
  /** The groups the batch was exposed to, per grouping. */
  readonly groups: GroupMembership;
}

export interface RateDeviation {
  readonly deviationId: string;
  readonly batchId: string;
  /** The groups the deviation is attributed to, per grouping (none: unattributed for that grouping). */
  readonly groups: GroupMembership;
}

export interface RateProduct {
  readonly product: string;
  readonly batches: readonly RateBatch[];
  readonly deviations: readonly RateDeviation[];
}

export interface RateInput {
  readonly products: readonly RateProduct[];
}

export interface RateParameters extends Parameters {
  readonly groupings: readonly string[];
  readonly minBatchesPerGroup: number;
  readonly falseDiscoveryRate: number;
  readonly confidence: number;
}

/** Wilson's score interval of k successes in n trials. */
export function wilsonInterval(k: number, n: number, confidence: number): { lower: number; upper: number } {
  const z = normalQuantile((1 + confidence) / 2);
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/** Garwood's exact interval of a Poisson count k: chi-square quantiles of 2k and 2k + 2 degrees of freedom, halved. */
export function garwoodInterval(k: number, confidence: number): { lower: number; upper: number } {
  const a = 1 - confidence;
  return { lower: k === 0 ? 0 : chiSquareQuantile(a / 2, 2 * k) / 2, upper: chiSquareQuantile(1 - a / 2, 2 * k + 2) / 2 };
}

const logFactorials = (n: number): number[] => {
  const f = [0];
  for (let i = 1; i <= n; i++) f.push(f[i - 1]! + Math.log(i));
  return f;
};

/**
 * Fisher's exact test of a 2 x 2 table, one-sided: P(X >= a) for X hypergeometric with the margins of
 * [[a, b], [c, d]] (a: the group's batches with a deviation, b: without; c and d the rest's).
 */
export function fisherOneSided(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  const lf = logFactorials(n);
  const row = a + b;
  const col = a + c;
  const logP = (x: number): number => lf[row]! + lf[n - row]! + lf[col]! + lf[n - col]! - lf[n]! - lf[x]! - lf[row - x]! - lf[col - x]! - lf[n - row - col + x]!;
  let p = 0;
  for (let x = a; x <= Math.min(row, col); x++) p += Math.exp(logP(x));
  return Math.min(1, p);
}

/** Benjamini-Hochberg q-values of p-values (in their order). */
export function benjaminiHochberg(ps: readonly number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p || x.i - y.i);
  const q = new Array<number>(m);
  let running = 1;
  for (let r = m - 1; r >= 0; r--) {
    const { p, i } = order[r]!;
    running = Math.min(running, (p * m) / (r + 1));
    q[i] = Math.min(1, running);
  }
  return q;
}

const pct = (x: number): string => `${(x * 100).toPrecision(3)} %`;
const LABEL: Readonly<Record<Grouping, string>> = { STEP: 'Step', EQUIPMENT: 'Equipment', ROOM: 'Room', MATERIAL_LOT: 'Material lot', SUPPLIER: 'Supplier', SHIFT: 'Shift' };

export function runRates(input: RateInput, params: RateParameters): MethodResult {
  const outputs: OutputDraft[] = [];
  const flags: FlagDraft[] = [];
  const z = normalQuantile((1 + params.confidence) / 2);
  for (const prod of input.products) {
    const batches = prod.batches;
    if (batches.length === 0) continue;
    const ids = new Set(batches.map((b) => b.batchId));
    const deviations = prod.deviations.filter((d) => ids.has(d.batchId));
    const times = batches.map((b) => b.completedAt).sort();
    const period = { periodFrom: times[0]!, periodTo: times[times.length - 1]! };
    for (const grouping of GROUPINGS.filter((g) => params.groupings.includes(g))) {
      const attributed = deviations.filter((d) => (d.groups[grouping] ?? []).length > 0);
      const withAny = new Set(attributed.map((d) => d.batchId));
      const overall = { overallBatches: batches.length, overallWithDeviation: withAny.size, overallShare: withAny.size / batches.length };
      const names = [...new Set(batches.flatMap((b) => b.groups[grouping] ?? []))].sort();
      const common = { product: prod.product, grouping, ...overall, unattributedDeviations: deviations.length - attributed.length, ...period, confidence: params.confidence, falseDiscoveryRate: params.falseDiscoveryRate };
      const rows = names.map((g) => {
        const exposed = batches.filter((b) => (b.groups[grouping] ?? []).includes(g));
        const exposedIds = new Set(exposed.map((b) => b.batchId));
        const mine = attributed.filter((d) => exposedIds.has(d.batchId) && (d.groups[grouping] ?? []).includes(g));
        const withDev = new Set(mine.map((d) => d.batchId));
        const rest = batches.length - exposed.length;
        const restWith = [...withAny].filter((b) => !exposedIds.has(b)).length;
        return { g, n: exposed.length, k: withDev.size, deviations: new Set(mine.map((d) => d.deviationId)).size, rest, restWith, evidence: [...withDev].sort() };
      });
      const compared = rows.filter((r) => r.n >= params.minBatchesPerGroup && r.rest > 0);
      const ps = compared.map((r) => fisherOneSided(r.k, r.n - r.k, r.restWith, r.rest - r.restWith));
      const qs = benjaminiHochberg(ps);
      for (const r of rows) {
        const subjectRef = `${prod.product}|${grouping}:${r.g}`;
        const at = compared.indexOf(r);
        const base = { ...common, group: r.g, batches: r.n, withDeviation: r.k, deviations: r.deviations, restBatches: r.rest, restWithDeviation: r.restWith };
        if (at < 0) {
          const reason = r.n < params.minBatchesPerGroup
            ? `fewer than ${params.minBatchesPerGroup.toString()} batches (${r.n.toString()})`
            : 'no batch of the product outside the group to compare with';
          outputs.push({ subjectKind: 'GROUP', subjectRef, kind: 'RATE_COMPARISON', values: { ...base, status: r.n < params.minBatchesPerGroup ? 'TOO_FEW_BATCHES' : 'NO_REST', notComparedReason: reason },
                         reasons: [{ code: 'NOT_COMPARED', text: `${LABEL[grouping]} ${r.g}: not compared, ${reason}` }] });
          continue;
        }
        const share = r.k / r.n;
        const restShare = r.restWith / r.rest;
        const w = wilsonInterval(r.k, r.n, params.confidence);
        const gw = garwoodInterval(r.deviations, params.confidence);
        const p0 = overall.overallShare;
        const half = z * Math.sqrt((p0 * (1 - p0)) / r.n);
        const p = ps[at]!;
        const q = qs[at]!;
        const above = q <= params.falseDiscoveryRate && share > restShare;
        const summary = `${LABEL[grouping]} ${r.g}: a deviation on ${r.k.toString()} of ${r.n.toString()} batches (${pct(share)}, interval ${pct(w.lower)} to ${pct(w.upper)}) against ${r.restWith.toString()} of ${r.rest.toString()} elsewhere (${pct(restShare)}); one-sided Fisher p = ${p.toPrecision(2)}, Benjamini-Hochberg q = ${q.toPrecision(2)}`;
        outputs.push({
          subjectKind: 'GROUP', subjectRef, kind: 'RATE_COMPARISON',
          values: {
            ...base, status: 'COMPARED', share, shareLower: w.lower, shareUpper: w.upper, per100: (100 * r.deviations) / r.n, per100Lower: (100 * gw.lower) / r.n,
            per100Upper: (100 * gw.upper) / r.n, restShare, pValue: p, qValue: q, above: above ? 'YES' : 'NO',
            funnelLower: Math.max(0, p0 - half), funnelUpper: Math.min(1, p0 + half),
          },
          reasons: [{ code: 'RATE_COMPARISON', text: summary }],
        });
        if (above) {
          flags.push({
            subjectKind: 'GROUP', subjectRef, rule: 'RATE_ABOVE', severity: 'ATTENTION',
            reasons: [{ code: 'RATE_ABOVE', text: `${summary}: above the rest at a false-discovery rate of ${pct(params.falseDiscoveryRate)}`,
                        evidence: r.evidence.map((b) => ({ kind: 'BATCH', ref: b })) }],
          });
        }
      }
    }
  }
  return { outputs, flags, skipped: [] };
}

export const RATE_DEVIATION: Method<RateInput, RateParameters> = { id: 'RATE.DEVIATION', versions: [1], run: runRates };
