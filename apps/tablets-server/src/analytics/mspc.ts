/**
 * The runner's implementation of MSPC.PCA, multivariate monitoring (slice 6A-3; D-6A-11, D-6A-3-1 to D-6A-3-9), and
 * its version 1 definition. A scope is a product and MBR family; a batch's vector is 6A-2's batch vectors put side by
 * side (spc.ts: the batch's last attempt of each critical item, or the readings of a subgroup item, decimal text):
 *   - the variables are the critical items of the scope's newest completed batch (D-6A-3-1);
 *   - a batch may be a reference batch when it is released and no CRITICAL deviation is linked to it
 *     (report.deviation_fact_v1; cancelled deviations are not there);
 *   - reference sets are read as 6A-6 reads its own (report.analytics_reference_v1, recipe-core 1170): the runner runs
 *     the version once without a set (the candidates) and once per set in force, narrowed to the set's product and
 *     family; a set whose scope or batches are not its model's fails its run with the reason.
 * GMP values stay decimal text here; the method converts them with statOf.
 */
import { METHODS, MSPC_PCA, canonicalText, defaultParameters, type DecimalText, type MspcBatch, type MspcInput, type MspcParameters } from '@ebmr/analytics';
import type { MethodDefinition } from './spc.ts';
import { assembleBatchValues, assembleSubgroups, completedBatches } from './spc.ts';
import { implementation, type InputRow, type InputSpec, type MethodImplementation, type ReferenceRow } from './method-types.ts';

type Rows = Readonly<Record<string, readonly InputRow[]>>;

const BATCH_FACT = 'report.batch_fact_v1';
const CPP_VALUE = 'report.cpp_value_v1';
const DEVIATION_FACT = 'report.deviation_fact_v1';
const REFERENCES: InputSpec = { view: 'report.analytics_reference_v1', version: 1, filter: { method: 'MSPC.PCA' } };
const spec = (view: string, filter: InputSpec['filter'] = null): InputSpec => ({ view, version: 1, filter });

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The method's input: per product and family, its completed batches with their vectors, in completion order. */
export function assembleMspc(rows: Rows): MspcInput {
  const released = new Map<string, boolean>();
  for (const r of rows[BATCH_FACT] ?? []) released.set(text(r['batch_id']), r['released'] === true);
  const critical = new Set<string>();
  for (const r of rows[DEVIATION_FACT] ?? []) if (r['classification'] === 'CRITICAL') critical.add(text(r['batch_id']));
  // Each batch's values per item: one value, or the readings of a subgroup item (a one-value item wins on a clash).
  const values = new Map<string, Map<string, DecimalText[]>>();
  const put = (batchId: string, item: string, texts: readonly DecimalText[], replace: boolean): void => {
    const per = values.get(batchId) ?? new Map<string, DecimalText[]>();
    if (replace || !per.has(item)) per.set(item, [...texts]);
    values.set(batchId, per);
  };
  for (const s of assembleSubgroups(rows).series) for (const p of s.points) put(p.batchId, s.item, p.values, false);
  for (const s of assembleBatchValues(rows).series) for (const p of s.points) put(p.batchId, s.item, [p.value], true);
  const scopes = new Map<string, { product: string; family: string; batches: MspcBatch[] }>();
  for (const b of completedBatches(rows)) {
    const key = `${b.product}|${b.family}`;
    const scope = scopes.get(key) ?? { product: b.product, family: b.family, batches: [] };
    const why = [...(released.get(b.batchId) === true ? [] : ['not released']), ...(critical.has(b.batchId) ? ['a critical deviation is linked to it'] : [])];
    scope.batches.push({
      batchId: b.batchId, batchNumber: b.batchNumber, completedAt: b.completedAt,
      values: Object.fromEntries(values.get(b.batchId) ?? []), notReference: why.length > 0 ? why.join('; ') : null,
    });
    scopes.set(key, scope);
  }
  return {
    scopes: [...scopes.entries()].sort(([a], [b]) => cmp(a, b)).map(([, s]) => ({
      ...s, variables: Object.keys(s.batches[s.batches.length - 1]?.values ?? {}).sort(),
    })),
  };
}

/** The inputs of a run against a reference set: its product and family. */
function mspcInputsFor(ref: ReferenceRow): readonly InputSpec[] {
  const scope = (ref.model['scope'] ?? {}) as Record<string, unknown>;
  return [spec(BATCH_FACT, { product_code: text(scope['product']), family_code: text(scope['family']) }), spec(CPP_VALUE), spec(DEVIATION_FACT)];
}

/** Why a reference set cannot be scored by this code (empty when it can): its scope and batches must be its model's. */
export function mspcReferenceProblems(ref: ReferenceRow): string[] {
  const m = ref.model;
  const scope = (m['scope'] ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (m['method'] !== 'MSPC.PCA' || typeof scope['product'] !== 'string' || typeof scope['family'] !== 'string') problems.push('its model is not an MSPC.PCA model of a product and family');
  if (ref.scope['product'] !== scope['product'] || ref.scope['family'] !== scope['family']) problems.push("its scope is not its model's (product and family)");
  const modelBatches = Array.isArray(m['batchIds']) ? (m['batchIds'] as unknown[]).map(String).sort() : [];
  if (canonicalText([...ref.batchIds].sort()) !== canonicalText(modelBatches)) problems.push("its batches are not its model's reference batches");
  return problems;
}

/** MSPC.PCA as the runner holds it (IMPLEMENTATIONS). */
export const MSPC_IMPLEMENTATION: MethodImplementation = implementation<MspcInput, MspcParameters>({
  id: 'MSPC.PCA', versions: [1], inputs: [spec(BATCH_FACT), spec(CPP_VALUE), spec(DEVIATION_FACT)], assemble: (rows) => assembleMspc(rows), method: MSPC_PCA,
  references: REFERENCES, inputsFor: mspcInputsFor, referenceProblems: mspcReferenceProblems,
});

/** Version 1 as QA records it (the body of POST /api/analytics/method-versions, but for the change record). */
export const MSPC_METHOD_DEFINITION: MethodDefinition = {
  method: 'MSPC.PCA',
  version: 1,
  title: METHODS['MSPC.PCA'].title,
  intendedUse: METHODS['MSPC.PCA'].intendedUse,
  acceptance: {
    referenceValues: 'PCA, T-squared and Q limits and contributions within a relative 1e-8 of the offline reference (NumPy 2.2.6, SciPy 1.14.1)',
    reproducibility: 'a re-run on the same inputs gives the same flags and values within a relative 1e-9 (D-6A-22)',
    seededCase: 'the synthetic history\'s batch 27, within every limit of its own, is flagged Q_ABOVE with hardness and thickness named',
    falseAlarmRateReview: 'QA reviews the monthly false-alarm rate on the methods page; above 0.5 the version is re-assessed',
  },
  parameters: defaultParameters('MSPC.PCA'),
  validationRef: 'VAL-6A-3-MSPC.PCA-1 (packages/analytics/test/mspc.test.ts)',
};
