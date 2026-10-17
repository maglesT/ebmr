/**
 * The runner's implementations of slice 6A-2 (ADR 0020 point 1; D-6A-7 to D-6A-10, D-6A-2-*): SPC.IMR, SPC.XBAR_S,
 * CAP.INDEX, DRIFT.TREND and RATE.DEVIATION, version 1, and how the rows of their catalogued inputs become each method's
 * input. GMP values stay the views' decimal text here (decimalText checks the grammar); only the methods turn them into
 * statistics, through statOf (ADR 0020 point 5).
 *
 *   One value per batch (I-MR, capability, drift): the critical values of report.cpp_value_v1 without a reading number
 *   (DECIMAL and COUNT values), per product, MBR family and item, the batch's last attempt (the highest attempt, then
 *   the latest recorded; D-6A-2-2), completed batches only, in completion order (then batch number).
 *   Readings (Xbar-S): the values of a SERIES (with a reading number), one subgroup per batch: the readings of its last
 *   attempt, in reading order.
 *   The specification echoed is that of the newest batch's master (D-6A-2-3).
 *   Deviation rates: per product, its completed batches with the groups they were exposed to (report.step_use_v1:
 *   step, unit, room, material lots and suppliers; report.step_shift_v1: shifts) and its deviations with the groups
 *   they are attributed to (report.deviation_fact_v1).
 *
 * SPC_METHOD_DEFINITIONS are the version 1 rows QA puts in force under an approved change record (the methods page's
 * POST /api/analytics/method-versions; DI-52, DI-09): the plan's default parameters, the intended use, the acceptance
 * criteria and the validation reference (the known-answer tests of packages/analytics/test/spc-methods.test.ts).
 */
import {
  CAP_INDEX,
  DRIFT_TREND,
  GROUPINGS,
  METHODS,
  RATE_DEVIATION,
  SPC_IMR,
  SPC_XBAR_S,
  decimalText,
  defaultParameters,
  isDecimalText,
  type BatchValueInput,
  type CapabilityParameters,
  type DecimalText,
  type DriftParameters,
  type Grouping,
  type Method,
  type MethodId,
  type Parameters,
  type RateInput,
  type RateParameters,
  type Specification,
  type SpcParameters,
  type SubgroupInput,
  type XbarSParameters,
} from '@ebmr/analytics';

// The shapes of implementation.ts (InputRow, InputSpec, MethodImplementation), declared here structurally: that file
// lists this one's implementations, and an import back would be a cycle (dependency-cruiser no-circular).
type InputRow = Readonly<Record<string, unknown>>;
interface InputSpec {
  readonly view: string;
  readonly version: number;
  readonly filter: Readonly<Record<string, string | number | boolean>> | null;
}
interface MethodImplementation<I = unknown, P extends Parameters = Parameters> {
  readonly id: MethodId;
  readonly versions: readonly number[];
  readonly inputs: readonly InputSpec[];
  assemble(rows: Readonly<Record<string, readonly InputRow[]>>, params: P): I;
  readonly method: Method<I, P>;
}
const implementation = <I, P extends Parameters>(impl: MethodImplementation<I, P>): MethodImplementation => impl;

type Rows = Readonly<Record<string, readonly InputRow[]>>;

const BATCH_FACT = 'report.batch_fact_v1';
const CPP_VALUE = 'report.cpp_value_v1';
const STEP_USE = 'report.step_use_v1';
const STEP_SHIFT = 'report.step_shift_v1';
const DEVIATION_FACT = 'report.deviation_fact_v1';
const spec = (view: string): InputSpec => ({ view, version: 1, filter: null });

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const decimalOrNull = (v: unknown): DecimalText | null => (isDecimalText(v) ? v : null);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface CompletedBatch {
  batchId: string;
  batchNumber: string;
  product: string;
  family: string;
  completedAt: string;
}

/** The completed GMP batches of report.batch_fact_v1 with a product and family, in completion order. */
export function completedBatches(rows: Rows): CompletedBatch[] {
  const out: CompletedBatch[] = [];
  for (const r of rows[BATCH_FACT] ?? []) {
    const [batchId, batchNumber, product, family, completedAt] = [text(r['batch_id']), text(r['batch_number']), text(r['product_code']), text(r['family_code']), text(r['completed_at'])];
    if (batchId && batchNumber && product && family && completedAt) out.push({ batchId, batchNumber, product, family, completedAt });
  }
  return out.sort((a, b) => cmp(a.completedAt, b.completedAt) || cmp(a.batchNumber, b.batchNumber));
}

interface ValueRow {
  batchId: string;
  item: string;
  attempt: number;
  reading: number | null;
  recordedAt: string;
  step: string;
  value: DecimalText;
  spec: Specification;
}

function valueRows(rows: Rows): ValueRow[] {
  const out: ValueRow[] = [];
  for (const r of rows[CPP_VALUE] ?? []) {
    const batchId = text(r['batch_id']);
    const item = text(r['item']);
    if (!batchId || !item || !isDecimalText(r['value_text'])) continue;
    out.push({
      batchId, item,
      attempt: typeof r['attempt'] === 'number' ? r['attempt'] : 1,
      reading: typeof r['reading'] === 'number' ? r['reading'] : null,
      recordedAt: text(r['recorded_at']) ?? '',
      step: text(r['step']) ?? '',
      value: decimalText(r['value_text']),
      spec: { lower: decimalOrNull(r['lower_text']), upper: decimalOrNull(r['upper_text']), target: decimalOrNull(r['target_text']), unit: text(r['unit']) },
    });
  }
  return out;
}

/** The last attempt of an item in a batch: the highest attempt, then the latest recorded, then the step. */
const later = (a: ValueRow, b: ValueRow): boolean => a.attempt > b.attempt || (a.attempt === b.attempt && (a.recordedAt > b.recordedAt || (a.recordedAt === b.recordedAt && a.step > b.step)));

function bySeries<P>(rows: Rows, readings: boolean, point: (b: CompletedBatch, last: ValueRow, all: ValueRow[]) => P | null) {
  const batches = completedBatches(rows);
  const byId = new Map(batches.map((b) => [b.batchId, b]));
  const groups = new Map<string, { b: CompletedBatch; item: string; rows: ValueRow[] }>();
  for (const v of valueRows(rows)) {
    if ((v.reading !== null) !== readings) continue;
    const b = byId.get(v.batchId);
    if (!b) continue;
    const key = `${b.product}|${b.family}|${v.item}|${b.batchId}`;
    const g = groups.get(key) ?? { b, item: v.item, rows: [] };
    g.rows.push(v);
    groups.set(key, g);
  }
  const series = new Map<string, { product: string; family: string; item: string; specification: Specification; points: (P & { completedAt: string; batchNumber: string })[] }>();
  for (const g of [...groups.values()].sort((x, y) => cmp(x.b.completedAt, y.b.completedAt) || cmp(x.b.batchNumber, y.b.batchNumber))) {
    const last = g.rows.reduce((a, r) => (later(r, a) ? r : a));
    const p = point(g.b, last, g.rows);
    if (p === null) continue;
    const key = `${g.b.product}|${g.b.family}|${g.item}`;
    const s = series.get(key) ?? { product: g.b.product, family: g.b.family, item: g.item, specification: last.spec, points: [] };
    s.points.push({ ...p, completedAt: g.b.completedAt, batchNumber: g.b.batchNumber });
    // The newest batch's master gives the specification.
    s.specification = last.spec;
    series.set(key, s);
  }
  return [...series.entries()].sort(([a], [b]) => cmp(a, b)).map(([, s]) => s);
}

/** One value per batch (BATCH_VALUE). */
export function assembleBatchValues(rows: Rows): BatchValueInput {
  return { series: bySeries(rows, false, (b, last) => ({ batchId: b.batchId, batchNumber: b.batchNumber, completedAt: b.completedAt, value: last.value })) };
}

/** The readings of each batch's last attempt (SUBGROUP_VALUES). */
export function assembleSubgroups(rows: Rows): SubgroupInput {
  return {
    series: bySeries(rows, true, (b, last, all) => {
      const values = all.filter((r) => r.attempt === last.attempt && r.step === last.step).sort((x, y) => (x.reading ?? 0) - (y.reading ?? 0)).map((r) => r.value);
      return { batchId: b.batchId, batchNumber: b.batchNumber, completedAt: b.completedAt, values };
    }),
  };
}

const add = (m: Map<string, Map<Grouping, Set<string>>>, id: string, g: Grouping, v: unknown): void => {
  const value = text(v);
  if (!value) return;
  const per = m.get(id) ?? new Map<Grouping, Set<string>>();
  per.set(g, (per.get(g) ?? new Set()).add(value));
  m.set(id, per);
};
const membership = (per: Map<Grouping, Set<string>> | undefined): Partial<Record<Grouping, string[]>> =>
  Object.fromEntries(GROUPINGS.filter((g) => per?.has(g)).map((g) => [g, [...per!.get(g)!].sort()]));

/** A material lot pair of report.step_use_v1: {lot, supplier} (or the synthetic history's {lot_code, supplier_code}). */
function lotPairs(v: unknown): { lot: unknown; supplier: unknown }[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null).map((x) => ({ lot: x['lot'] ?? x['lot_code'], supplier: x['supplier'] ?? x['supplier_code'] }));
}

/** Per product: its completed batches with their exposures and its deviations with their attributions (DEVIATION_GROUPS). */
export function assembleRates(rows: Rows): RateInput {
  const batches = completedBatches(rows);
  const exposure = new Map<string, Map<Grouping, Set<string>>>();
  for (const r of rows[STEP_USE] ?? []) {
    const id = text(r['batch_id']);
    if (!id) continue;
    add(exposure, id, 'STEP', r['step']);
    add(exposure, id, 'EQUIPMENT', r['equipment_code']);
    add(exposure, id, 'ROOM', r['room_code']);
    for (const p of lotPairs(r['material_lots'])) {
      add(exposure, id, 'MATERIAL_LOT', p.lot);
      add(exposure, id, 'SUPPLIER', p.supplier);
    }
  }
  for (const r of rows[STEP_SHIFT] ?? []) {
    const id = text(r['batch_id']);
    if (id) add(exposure, id, 'SHIFT', r['shift']);
  }
  const attribution = new Map<string, Map<Grouping, Set<string>>>();
  const deviationBatch = new Map<string, { deviationId: string; batchId: string }>();
  for (const r of rows[DEVIATION_FACT] ?? []) {
    const [deviationId, batchId] = [text(r['deviation_id']), text(r['batch_id'])];
    if (!deviationId || !batchId) continue;
    const key = `${deviationId}|${batchId}`;
    deviationBatch.set(key, { deviationId, batchId });
    add(attribution, key, 'STEP', r['step']);
    add(attribution, key, 'EQUIPMENT', r['equipment_code']);
    add(attribution, key, 'ROOM', r['room_code']);
    add(attribution, key, 'MATERIAL_LOT', r['material_lot']);
    add(attribution, key, 'SUPPLIER', r['supplier_code']);
    add(attribution, key, 'SHIFT', r['shift']);
  }
  const products = [...new Set(batches.map((b) => b.product))].sort();
  return {
    products: products.map((product) => {
      const mine = batches.filter((b) => b.product === product);
      const ids = new Set(mine.map((b) => b.batchId));
      return {
        product,
        batches: mine.map((b) => ({ batchId: b.batchId, batchNumber: b.batchNumber, completedAt: b.completedAt, groups: membership(exposure.get(b.batchId)) })),
        deviations: [...deviationBatch.entries()].filter(([, d]) => ids.has(d.batchId)).sort(([a], [b]) => cmp(a, b))
          .map(([key, d]) => ({ deviationId: d.deviationId, batchId: d.batchId, groups: membership(attribution.get(key)) })),
      };
    }),
  };
}

export const SPC_IMPLEMENTATIONS: readonly MethodImplementation[] = [
  implementation<BatchValueInput, SpcParameters>({ id: 'SPC.IMR', versions: [1], inputs: [spec(BATCH_FACT), spec(CPP_VALUE)], assemble: assembleBatchValues, method: SPC_IMR }),
  implementation<SubgroupInput, XbarSParameters>({ id: 'SPC.XBAR_S', versions: [1], inputs: [spec(BATCH_FACT), spec(CPP_VALUE)], assemble: assembleSubgroups, method: SPC_XBAR_S }),
  implementation<BatchValueInput, CapabilityParameters>({ id: 'CAP.INDEX', versions: [1], inputs: [spec(BATCH_FACT), spec(CPP_VALUE)], assemble: assembleBatchValues, method: CAP_INDEX }),
  implementation<BatchValueInput, DriftParameters>({ id: 'DRIFT.TREND', versions: [1], inputs: [spec(BATCH_FACT), spec(CPP_VALUE)], assemble: assembleBatchValues, method: DRIFT_TREND }),
  implementation<RateInput, RateParameters>({
    id: 'RATE.DEVIATION', versions: [1], inputs: [spec(BATCH_FACT), spec(STEP_USE), spec(STEP_SHIFT), spec(DEVIATION_FACT)], assemble: assembleRates, method: RATE_DEVIATION,
  }),
];

/** A method version 1 as QA records it (the body of POST /api/analytics/method-versions, but for the change record). */
export interface MethodDefinition {
  method: MethodId;
  version: 1;
  title: string;
  intendedUse: string;
  acceptance: Record<string, string | number>;
  parameters: Parameters;
  validationRef: string;
}

const ACCEPTANCE = {
  referenceValues: 'known-answer statistics within a relative 1e-9 of the offline reference (SciPy 1.14.1) and the published examples',
  reproducibility: 'a re-run on the same inputs gives the same flags and values within a relative 1e-9 (D-6A-22)',
  falseAlarmRateReview: 'QA reviews the monthly false-alarm rate on the methods page; above 0.5 the version is re-assessed',
};

export const SPC_METHOD_DEFINITIONS: readonly MethodDefinition[] = (['SPC.IMR', 'SPC.XBAR_S', 'CAP.INDEX', 'DRIFT.TREND', 'RATE.DEVIATION'] as const).map((id) => ({
  method: id,
  version: 1,
  title: METHODS[id].title,
  intendedUse: METHODS[id].intendedUse,
  acceptance: ACCEPTANCE,
  parameters: defaultParameters(id),
  validationRef: `VAL-6A-2-${id}-1 (packages/analytics/test/spc-methods.test.ts)`,
}));
