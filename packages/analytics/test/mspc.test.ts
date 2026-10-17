/**
 * Known answers of slice 6A-3's method MSPC.PCA (Phase 6A; D-6A-11, D-6A-3-*): PCA, the T-squared and Q limits and the
 * contributions against test/reference/mspc-reference.json, computed with NumPy and SciPy by mspc_reference.py beside it;
 * the candidate's trimming of a batch beyond its Phase I limits; and the synthetic history's batch 27 (test-kit
 * analyticsHistory), within every limit of its own but with hardness and thickness out of their correlation.
 */
import { describe, expect, it } from 'vitest';
import { analyticsHistory, HISTORY_ITEMS, HISTORY_PRODUCT, HISTORY_SEEDS } from '../../test-kit/src/analytics-history.ts';
import {
  MSPC_PCA,
  decimalText,
  defaultParameters,
  fitPca,
  mspcModelOf,
  mspcModelSha256,
  qLimit,
  runImr,
  scorePca,
  t2NewLimit,
  t2ReferenceLimit,
  topContributors,
  type MspcBatch,
  type MspcInput,
  type MspcModel,
  type MspcParameters,
  type ReferenceModel,
  type SpcParameters,
} from '../src/index.ts';
import ref from './reference/mspc-reference.json' with { type: 'json' };

const close = (actual: number, expected: number, rel = 1e-9): void => {
  const scale = Math.max(Math.abs(expected), 1e-12);
  expect(Math.abs(actual - expected) / scale, `${actual} against ${expected}`).toBeLessThanOrEqual(rel);
};
const closeAll = (a: readonly number[], e: readonly number[], rel = 1e-9): void => {
  expect(a).toHaveLength(e.length);
  a.forEach((x, i) => close(x, e[i]!, rel));
};
const rows = (t: readonly (readonly string[])[]): number[][] => t.map((r) => r.map(Number));
const params = defaultParameters('MSPC.PCA') as MspcParameters;
const options = { varianceTarget: 0.9, maxComponents: 5, limitConfidence: 0.99 };

type RefModel = typeof ref.basic.model;
function sameModel(m: ReturnType<typeof fitPca>, r: RefModel): void {
  expect(m.n).toBe(r.n);
  expect(m.components).toBe(r.components);
  closeAll(m.mean, r.mean, 1e-12);
  closeAll(m.sd, r.sd, 1e-12);
  closeAll(m.eigenvalues.slice(0, m.components), r.eigenvalues.slice(0, r.components), 1e-10);
  closeAll(m.explained, r.explained, 1e-8);
  m.loadings.forEach((row, j) => closeAll(row, r.loadings[j]!, 1e-8));
  close(m.t2Reference, r.t2Reference, 1e-9);
  close(m.t2New, r.t2New, 1e-9);
  close(m.q, r.q, 1e-8);
  expect(m.qMethod).toBe(r.qMethod);
}

describe('MSPC.PCA arithmetic (methods/mspc/pca.ts)', () => {
  it('agrees with NumPy and SciPy: autoscaling, eigenvalues, components to 90 %, signed loadings, T-squared (beta and F) and Q limits', () => {
    const m = fitPca(rows(ref.basic.reference), options);
    sameModel(m, ref.basic.model);
    // The total variance of autoscaled data is the number of variables.
    close(m.eigenvalues.reduce((s, l) => s + l, 0), 4, 1e-12);
  });

  it('agrees with NumPy: the scores, T-squared, Q and both contributions of reference and new batches; each set of contributions sums to its statistic', () => {
    const m = fitPca(rows(ref.basic.reference), options);
    const all = [...rows(ref.basic.reference), ...rows(ref.basic.new)];
    const expected = [...ref.basic.referenceScores, ...ref.basic.newScores];
    all.forEach((x, i) => {
      const s = scorePca(m, x);
      const e = expected[i]!;
      closeAll(s.scores, e.scores, 1e-8);
      close(s.t2, e.t2, 1e-8);
      close(s.q, e.q, 1e-8);
      closeAll(s.t2Contributions, e.t2Contributions, 1e-7);
      closeAll(s.qContributions, e.qContributions, 1e-7);
      close(s.t2Contributions.reduce((a, b) => a + b, 0), s.t2, 1e-9);
      close(s.qContributions.reduce((a, b) => a + b, 0), s.q, 1e-9);
    });
    // The batch breaking the correlation of variables 1 and 2 has its Q far above the limit, and they contribute most.
    const broken = scorePca(m, rows(ref.basic.new)[2]!);
    expect(broken.q).toBeGreaterThan(m.q);
    expect(topContributors(['v1', 'v2', 'v3', 'v4'], broken.qContributions).map((t) => t.variable).slice(0, 2).sort()).toEqual(['v1', 'v2']);
  });

  it('agrees with SciPy: the T-squared limits of a reference batch (beta) and a new batch (F), and the Q limit (Jackson-Mudholkar, Box when h0 is not positive)', () => {
    for (const [key, v] of Object.entries(ref.t2Reference)) {
      const [n, k] = key.split('|').map(Number) as [number, number];
      close(t2ReferenceLimit(n, k, 0.99), v, 1e-9);
    }
    for (const [key, v] of Object.entries(ref.t2New)) {
      const [n, k] = key.split('|').map(Number) as [number, number];
      close(t2NewLimit(n, k, 0.99), v, 1e-9);
    }
    close(t2NewLimit(24, 2, 0.95), ref.t2New95['24|2'], 1e-9);
    const one = qLimit([0.12], 0.99);
    close(one.limit, ref.qLimit.one.limit, 1e-9);
    expect(one.method).toBe('JACKSON_MUDHOLKAR');
    close(qLimit([0.3, 0.1, 0.05], 0.99).limit, ref.qLimit.three.limit, 1e-9);
    const spread = qLimit([1, ...Array.from({ length: 50 }, () => 0.1)], 0.99);
    expect(spread.method).toBe('BOX');
    close(spread.limit, ref.qLimit.spread.limit, 1e-9);
    expect(() => qLimit([0, 0], 0.99)).toThrow(/no variation/);
  });
});

/** A scope's input from rows of decimal text (one value per variable). */
function scopeInput(texts: readonly (readonly string[])[], variables: readonly string[], notReference: (i: number) => string | null = () => null): MspcInput {
  const batches: MspcBatch[] = texts.map((r, i) => ({
    batchId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, batchNumber: `B-${String(i + 1).padStart(3, '0')}`, completedAt: `2026-06-${String(i + 1).padStart(2, '0')}`,
    values: Object.fromEntries(variables.map((v, j) => [v, [decimalText(r[j]!)]])), notReference: notReference(i),
  }));
  return { scopes: [{ product: 'P', family: 'F', variables, batches }] };
}

const asRef = (model: MspcModel, id = 'RS-MSPC'): ReferenceModel => ({ id, method: 'MSPC.PCA', model: model as unknown as Record<string, unknown>, modelSha256: mspcModelSha256(model) });

describe('method MSPC.PCA (methods/mspc/index.ts)', () => {
  it('a candidate leaves out the batch beyond its first fit\'s Phase I limits, names it, and agrees with the reference refit', () => {
    const r = MSPC_PCA.run(scopeInput(ref.trim.batches, ['a', 'b', 'c']), params, null);
    expect(r.flags).toEqual([]);
    expect(r.outputs).toHaveLength(1);
    const c = r.outputs[0]!;
    expect(c).toMatchObject({ subjectKind: 'PRODUCT_ITEM', subjectRef: 'P|F', kind: 'MODEL_CANDIDATE' });
    const model = mspcModelOf(c.values['model'] as Record<string, unknown>);
    sameModel(model, ref.trim.refit);
    expect(c.values['modelSha256']).toBe(mspcModelSha256(model));
    expect(c.values['leftOut']).toEqual(ref.trim.leftOut.map((i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`));
    expect(model.batchIds).toHaveLength(24);
    expect(c.reasons.find((x) => x.code === 'BEYOND_PHASE_I')!.text).toMatch(/^B-025: beyond the first fit's Phase I limits/);
    // The left-out batch scored against the refit agrees with the reference.
    const left = scorePca(model, rows(ref.trim.batches)[24]!);
    close(left.q, ref.trim.leftOutScores[0]!.q, 1e-8);
  });

  it('fewer than 15 reference batches gives no model and says why', () => {
    const fourteen = MSPC_PCA.run(scopeInput(ref.basic.reference.slice(0, 14), ['a', 'b', 'c', 'd']), params, null);
    expect(fourteen.outputs).toEqual([]);
    expect(fourteen.skipped).toEqual([{ subject: 'P|F', reason: '14 batches may be reference batches; a model needs at least 15' }]);
    // Batches that may not be reference batches do not count, and are named in a candidate's reasons.
    const notReleased = MSPC_PCA.run(scopeInput(ref.basic.reference, ['a', 'b', 'c', 'd'], (i) => (i < 10 ? 'not released' : null)), params, null);
    expect(notReleased.skipped[0]!.reason).toBe('14 batches may be reference batches; a model needs at least 15');
    const some = MSPC_PCA.run(scopeInput(ref.basic.reference, ['a', 'b', 'c', 'd'], (i) => (i === 0 ? 'a critical deviation is linked to it' : null)), params, null);
    expect(some.outputs[0]!.reasons.find((x) => x.code === 'NOT_REFERENCE')!.text).toBe('B-001: a critical deviation is linked to it');
    expect(some.outputs[0]!.values['batches']).toBe(23);
    // A variable without variation is left out of the model; with fewer than two that vary there is no model.
    const constant = ref.basic.reference.map((r) => [...r.slice(0, 3), '5.0']);
    const out = MSPC_PCA.run(scopeInput(constant, ['a', 'b', 'c', 'd']), params, null).outputs[0]!;
    expect((out.values['model'] as { variables: string[] }).variables).toEqual(['a', 'b', 'c']);
    expect(out.reasons.map((x) => x.code)).toContain('VARIABLE_LEFT_OUT');
    const flat = ref.basic.reference.map((r) => [r[0]!, '5.0', '5.0']);
    expect(MSPC_PCA.run(scopeInput(flat, ['a', 'b', 'c']), params, null).skipped[0]!.reason).toMatch(/1 variable\(s\) vary among the reference batches; a model needs two or more/);
  });

  it('a candidate takes the newest batches that may be reference batches, names at most 50 left out and counts the rest', () => {
    // 130 batches: the 24 reference rows repeated; the newest 60 are not released, so the 70 older ones are examined.
    const texts = Array.from({ length: 130 }, (_, i) => ref.basic.reference[i % 24]!.map((t, j) => (Number(t) + i * 1e-4 * (j + 1)).toFixed(4)));
    const r = MSPC_PCA.run(scopeInput(texts, ['a', 'b', 'c', 'd'], (i) => (i >= 70 ? 'not released' : null)), { ...params, maxReferenceBatches: 20 }, null);
    const c = r.outputs[0]!;
    expect(c.values['batches']! as number).toBeLessThanOrEqual(20);
    expect((c.values['batchNumbers'] as string[])[0]).toBe('B-051');
    const codes = c.reasons.map((x) => x.code);
    expect(codes.filter((x) => x === 'NOT_REFERENCE')).toHaveLength(50);
    expect(c.reasons.find((x) => x.code === 'NOT_REFERENCE_MORE')!.text).toBe('10 more batches may not be reference batches (not released, a critical deviation, or a variable not recorded)');
    expect(c.reasons.find((x) => x.code === 'OLDER')!.text).toBe('50 older batches: the candidate takes the newest 20 that may be reference batches');
  });

  it('a scoring run flags only batches outside the reference set; a set fitted with other parameters, or a batch missing a variable, is not scored, with the reason', () => {
    const input = scopeInput([...ref.basic.reference, ...ref.basic.new], ['a', 'b', 'c', 'd']);
    const refOnly = scopeInput(ref.basic.reference, ['a', 'b', 'c', 'd']);
    const model = mspcModelOf(MSPC_PCA.run(refOnly, params, null).outputs[0]!.values['model'] as Record<string, unknown>);
    const r = MSPC_PCA.run(input, params, asRef(model));
    expect(r.outputs).toHaveLength(input.scopes[0]!.batches.length);
    expect(r.outputs.filter((o) => o.values['reference'] === 'REFERENCE')).toHaveLength(model.batchIds.length);
    const newIds = input.scopes[0]!.batches.slice(24).map((b) => b.batchId);
    expect(r.flags.map((f) => [f.rule, f.subjectRef])).toEqual(
      ref.basic.newScores.flatMap((s, i) => [
        ...(s.t2 > ref.basic.model.t2New ? [['T2_ABOVE', newIds[i]]] : []), ...(s.q > ref.basic.model.q ? [['Q_ABOVE', newIds[i]]] : []),
      ]),
    );
    const q = r.flags.find((f) => f.rule === 'Q_ABOVE')!;
    expect(q.reasons[0].text).toMatch(/^Q residual \S+ against its 99 % limit \S+: the combination of values departs .*; top contributors [ab] \(\d+ %\), [ab] \(\d+ %\)$/);
    expect(q.reasons[0].evidence).toEqual([{ kind: 'BATCH', ref: newIds[2] }, { kind: 'REFERENCE_SET', ref: 'RS-MSPC' }]);
    const other = MSPC_PCA.run(input, { ...params, varianceTarget: 0.8 }, asRef(model));
    expect(other.outputs).toEqual([]);
    expect(other.skipped[0]!.reason).toMatch(/fitted with other parameters than this method version's/);
    const missing: MspcInput = { scopes: [{ ...input.scopes[0]!, batches: input.scopes[0]!.batches.map((b, i) => (i === 25 ? { ...b, values: { a: b.values['a']! } } : b)) }] };
    expect(MSPC_PCA.run(missing, params, asRef(model)).skipped).toEqual([{ subject: newIds[1], reason: 'B-026: b, c, d not recorded; not scored' }]);
    // Only the newest scoredBatches batches outside the set are scored.
    expect(MSPC_PCA.run(input, { ...params, scoredBatches: 1 }, asRef(model)).outputs.filter((o) => o.values['reference'] === 'NEW').map((o) => o.subjectRef)).toEqual([newIds[2]]);
    expect(() => MSPC_PCA.run(input, params, { ...asRef(model), model: { method: 'MSPC.PCA' } })).toThrow(/does not hold an MSPC.PCA model/);
  });
});

describe('the synthetic history (test-kit analyticsHistory)', () => {
  const h = analyticsHistory();
  const items = [HISTORY_ITEMS.endpoint, HISTORY_ITEMS.hardness, HISTORY_ITEMS.thickness];
  /** Each batch's last attempt of each item (the runner's rule, D-6A-2-2). */
  const lastValue = (batchId: string, item: string): string => {
    const vs = h.cppValues.filter((v) => v.batch_id === batchId && v.item === item).sort((a, b) => b.attempt - a.attempt);
    return vs[0]!.value_text;
  };
  const input: MspcInput = {
    scopes: [{
      product: HISTORY_PRODUCT.code, family: HISTORY_PRODUCT.family, variables: items.map((i) => i.item).sort(),
      batches: h.batches.map((b) => ({
        batchId: b.batch_id, batchNumber: b.batch_number, completedAt: b.completed_at, notReference: b.released ? null : 'not released',
        values: Object.fromEntries(items.map((i) => [i.item, [decimalText(lastValue(b.batch_id, i.item))]])),
      })),
    }],
  };
  const b27 = h.batches[HISTORY_SEEDS.brokenCorrelation - 1]!;

  it('[DI-52] the multivariate run flags the seeded batch 27 within every limit and names the top contributing variables', () => {
    // Every value of batch 27 is within the master's limits, and no I-MR chart of its items puts it beyond its control limits.
    for (const i of items) {
      const v = Number(lastValue(b27.batch_id, i.item));
      expect(v, i.item).toBeGreaterThanOrEqual(Number(i.lower));
      expect(v, i.item).toBeLessThanOrEqual(Number(i.upper));
      const chart = runImr({ series: [{
        product: HISTORY_PRODUCT.code, family: HISTORY_PRODUCT.family, item: i.item, specification: { lower: null, upper: null, target: null, unit: null },
        points: h.batches.map((b) => ({ batchId: b.batch_id, batchNumber: b.batch_number, completedAt: b.completed_at, value: decimalText(lastValue(b.batch_id, i.item)) })),
      }] }, defaultParameters('SPC.IMR') as SpcParameters, null);
      const beyond = chart.flags.filter((f) => f.rule === 'NELSON_1').flatMap((f) => f.reasons.flatMap((r) => (r.evidence ?? []).map((e) => e.ref)));
      expect(beyond, i.item).not.toContain(b27.batch_id);
    }
    // The candidate leaves batch 27 out (beyond its first fit's Q limit); scored against the reference set, it is flagged.
    const cand = MSPC_PCA.run(input, params, null).outputs[0]!;
    expect(cand.values['leftOut']).toEqual([b27.batch_id]);
    const model = mspcModelOf(cand.values['model'] as Record<string, unknown>);
    expect(model.batchIds).toHaveLength(29);
    const r = MSPC_PCA.run(input, params, asRef(model));
    expect(r.flags.map((f) => [f.rule, f.subjectKind, f.subjectRef])).toEqual([['Q_ABOVE', 'BATCH', b27.batch_id]]);
    const expected = h.expected.find((e) => e.method === 'MSPC.PCA')!;
    expect([r.flags[0]!.rule, r.flags[0]!.subjectRef]).toEqual([expected.rule, expected.subjectRef]);
    const score = r.outputs.find((o) => o.subjectRef === b27.batch_id)!;
    expect(score.values).toMatchObject({ reference: 'NEW', flagged: ['Q_ABOVE'] });
    expect(score.values['t2'] as number).toBeLessThanOrEqual(score.values['t2Limit'] as number);
    // The top contributors to Q are hardness and thickness, named in the flag's reason.
    const top = topContributors(model.variables, score.values['qContributions'] as number[]).map((t) => t.variable);
    expect(top.sort()).toEqual([HISTORY_ITEMS.hardness.item, HISTORY_ITEMS.thickness.item].sort());
    expect(r.flags[0]!.reasons[0].text).toMatch(new RegExp(`top contributors (${HISTORY_ITEMS.hardness.item}|${HISTORY_ITEMS.thickness.item}) \\(\\d+ %\\), (${HISTORY_ITEMS.hardness.item}|${HISTORY_ITEMS.thickness.item}) \\(\\d+ %\\)$`));
    expect(r.flags[0]!.reasons[0].text).not.toContain(HISTORY_ITEMS.endpoint.item);
    // A re-run reproduces the outputs exactly (D-6A-22).
    expect(MSPC_PCA.run(input, params, asRef(model))).toEqual(r);
  });
});
