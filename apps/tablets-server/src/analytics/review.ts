/**
 * The review priority in the runner (slice 6A-5; decision 0016 item 9; D-6A-13, D-6A-14, D-6A-5-*; draft control PR-61):
 * REVIEW.PRIORITY version 1 reads report.review_fact_v1 (the records in the review queue it scores), report.cpp_value_v1
 * (their critical values with the master's limits, as decimal text), report.step_use_v1 with report.batch_fact_v1 (the
 * step durations of every GMP record, per product and MBR family) and report.audit_fact_v1 (the entries the
 * audit-trail rules read; no value of an entry is in it, DI-53). Their rows become the method's input here, field by
 * field; GMP values stay decimal text (the method compares them exactly) and instants stay the database's text.
 *
 * The score is recorded as an advisory output about the batch (analytics.review_priority_v1 shows the latest). Nothing
 * in the review, the exception register, the audit-trail review or release reads it; the review queue only orders by it
 * (PR-61). REVIEW_METHOD_DEFINITIONS is the version 1 row QA puts in force under an approved change record.
 *
 * The objects are written in the shape of MethodImplementation (implementation.ts) without importing it, so that
 * implementation.ts can list them in IMPLEMENTATIONS without an import cycle.
 */
import {
  METHODS,
  REVIEW_PRIORITY,
  decimalText,
  defaultParameters,
  isDecimalText,
  type DecimalText,
  type ReviewInput,
  type ReviewRecord,
  type ReviewStep,
  type ReviewValue,
} from '@ebmr/analytics';
import { AUDIT_FACTS, auditInput } from './audit.ts';
import type { MethodDefinition } from './spc.ts';

type Row = Readonly<Record<string, unknown>>;
type Rows = Readonly<Record<string, readonly Row[]>>;

export const REVIEW_FACTS = { view: 'report.review_fact_v1', version: 1, filter: null } as const;
const CPP_VALUES = { view: 'report.cpp_value_v1', version: 1, filter: null } as const;
const STEP_USE = { view: 'report.step_use_v1', version: 1, filter: null } as const;
const BATCH_FACTS = { view: 'report.batch_fact_v1', version: 1, filter: null } as const;

class ReviewRowError extends Error {}

const text = (r: Row, k: string): string => {
  const v = r[k];
  if (typeof v !== 'string' || v === '') throw new ReviewRowError(`column ${k} is not text in a review-priority input row`);
  return v;
};
const textOrNull = (r: Row, k: string): string | null => {
  const v = r[k];
  return typeof v === 'string' && v !== '' ? v : null;
};
const count = (r: Row, k: string): number => {
  const v = r[k];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new ReviewRowError(`column ${k} is not a count in a review-priority input row`);
  return v;
};
const texts = (r: Row, k: string): string[] => {
  const v = r[k];
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ReviewRowError(`column ${k} is not a text list in a review-priority input row`);
  return [...(v as string[])].sort();
};
const decimalOrNull = (v: unknown): DecimalText | null => (isDecimalText(v) ? v : null);

function records(rows: Rows): ReviewRecord[] {
  return (rows[REVIEW_FACTS.view] ?? []).map((r) => ({
    batchId: text(r, 'batch_id'), batchNumber: text(r, 'batch_number'), product: textOrNull(r, 'product_code'), family: textOrNull(r, 'family_code'),
    reviewState: text(r, 'review_state'), endedAt: textOrNull(r, 'ended_at'),
    exceptionsCritical: count(r, 'exceptions_critical'), exceptionsMajor: count(r, 'exceptions_major'), exceptionsMinor: count(r, 'exceptions_minor'),
    corrections: count(r, 'corrections'), deviations: count(r, 'deviations'), newOperators: count(r, 'new_operators'), newEquipment: texts(r, 'new_equipment_codes'),
    reviewFindings: count(r, 'review_findings'), reviewReopenings: count(r, 'review_reopenings'),
  }));
}

/** The critical values of the scored records: the last attempt of each item in each step (D-6A-2-2), every reading of it. */
function values(rows: Rows, scored: ReadonlySet<string>): ReviewValue[] {
  interface V { batchId: string; item: string; step: string; attempt: number; recordedAt: string; reading: number | null; value: DecimalText; lower: DecimalText | null; upper: DecimalText | null }
  const all: V[] = [];
  for (const r of rows[CPP_VALUES.view] ?? []) {
    const batchId = textOrNull(r, 'batch_id');
    const item = textOrNull(r, 'item');
    if (batchId === null || item === null || !scored.has(batchId) || !isDecimalText(r['value_text'])) continue;
    all.push({
      batchId, item, step: textOrNull(r, 'step') ?? '', attempt: typeof r['attempt'] === 'number' ? r['attempt'] : 1, recordedAt: textOrNull(r, 'recorded_at') ?? '',
      reading: typeof r['reading'] === 'number' ? r['reading'] : null, value: decimalText(r['value_text']), lower: decimalOrNull(r['lower_text']), upper: decimalOrNull(r['upper_text']),
    });
  }
  // The last attempt of an item in a step: the highest attempt, then the latest recorded.
  const last = new Map<string, { attempt: number; recordedAt: string }>();
  for (const v of all) {
    const key = `${v.batchId}|${v.item}|${v.step}`;
    const l = last.get(key);
    if (!l || v.attempt > l.attempt || (v.attempt === l.attempt && v.recordedAt > l.recordedAt)) last.set(key, { attempt: v.attempt, recordedAt: v.recordedAt });
  }
  return all
    .filter((v) => {
      const l = last.get(`${v.batchId}|${v.item}|${v.step}`);
      return l !== undefined && l.attempt === v.attempt && (v.reading !== null || l.recordedAt === v.recordedAt);
    })
    .map((v) => ({ batchId: v.batchId, ref: `${v.item}@${v.step}${v.reading === null ? '' : `#${String(v.reading)}`}`, value: v.value, lower: v.lower, upper: v.upper }));
}

/** The executed steps of the completed GMP records (and of the scored ones), with their product and family. */
function steps(rows: Rows, scored: readonly ReviewRecord[]): ReviewStep[] {
  const of = new Map<string, { product: string; family: string }>();
  for (const b of rows[BATCH_FACTS.view] ?? []) {
    const [id, product, family, completed] = [textOrNull(b, 'batch_id'), textOrNull(b, 'product_code'), textOrNull(b, 'family_code'), textOrNull(b, 'completed_at')];
    if (id !== null && product !== null && family !== null && completed !== null) of.set(id, { product, family });
  }
  for (const r of scored) if (r.product !== null && r.family !== null) of.set(r.batchId, { product: r.product, family: r.family });
  const out: ReviewStep[] = [];
  for (const u of rows[STEP_USE.view] ?? []) {
    const batchId = textOrNull(u, 'batch_id');
    const [step, startedAt, endedAt] = [textOrNull(u, 'step'), textOrNull(u, 'started_at'), textOrNull(u, 'ended_at')];
    const pf = batchId === null ? undefined : of.get(batchId);
    if (batchId === null || pf === undefined || step === null || startedAt === null || endedAt === null) continue;
    out.push({ batchId, product: pf.product, family: pf.family, step, startedAt, endedAt });
  }
  return out;
}

/** The method's input from the rows of its inputs. */
export function reviewInput(rows: Rows): ReviewInput {
  const recs = records(rows);
  const scored = new Set(recs.map((r) => r.batchId));
  return { records: recs, values: values(rows, scored), steps: steps(rows, recs), audit: auditInput({ [AUDIT_FACTS.view]: rows[AUDIT_FACTS.view] ?? [] }).events };
}

/** REVIEW.PRIORITY v1 in the runner. */
export const REVIEW_PRIORITY_IMPLEMENTATION = {
  id: 'REVIEW.PRIORITY',
  versions: [1],
  inputs: [REVIEW_FACTS, CPP_VALUES, STEP_USE, BATCH_FACTS, AUDIT_FACTS],
  assemble: (rows: Rows): ReviewInput => reviewInput(rows),
  method: REVIEW_PRIORITY,
} as const;

/** The version 1 row QA puts in force under an approved change record (the methods page's POST; DI-52, DI-09). */
export const REVIEW_METHOD_DEFINITIONS: readonly MethodDefinition[] = [{
  method: 'REVIEW.PRIORITY',
  version: 1,
  title: METHODS['REVIEW.PRIORITY'].title,
  intendedUse: METHODS['REVIEW.PRIORITY'].intendedUse,
  acceptance: {
    knownAnswers: 'the known-answer scores and reasons of packages/analytics/test/review-priority.test.ts, exactly',
    reproducibility: 'a re-run on the same inputs gives the same scores and reasons (D-6A-22)',
    neverSkips: 'the review queue lists the same records with and without scores; no review, register or release function reads the score (PR-61)',
  },
  parameters: defaultParameters('REVIEW.PRIORITY'),
  validationRef: 'VAL-6A-5-REVIEW.PRIORITY-1 (packages/analytics/test/review-priority.test.ts)',
}];
