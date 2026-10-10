/**
 * Shared pieces of the IPC blocks of Phase 3 slice 3c (builder B): TB-11 periodic IPC scheduler, TB-12 weight, TB-13
 * breaking force, thickness, diameter and appearance, TB-14 friability, TB-15 disintegration (tablets spec B.2).
 *
 * A test entry (WEIGHT_CHECK, PHYSICAL_CHECK, FRIABILITY_RUN, DT_START and DT_END, and the second stage of a weight
 * variation, WEIGHT_SECOND_STAGE) is evaluated by its test module (tb-12.ts to tb-15.ts) in the same way whether it is
 * recorded at a TB-12..TB-15 step of its own or at a TB-11 step, where it also names its stream. Every test entry
 * names the instrument it was made on (a plant instrument with a use for the batch open at the entry's time: the
 * database checks it, recipe-core 0403 calibration and per-use or daily check), how it was captured (DEVICE: each value
 * stands on a reading claimed for it in the same command, in order; MANUAL: flagged, an IPC_MANUAL_ENTRY exception and
 * a second person's check of the step), and when the sample was taken (sampledAtUs, separate from the entry's own
 * database time; an entry recorded more than the late-entry time after its sampling is flagged late, DI-28). GMP values
 * are decimal text; instants are epoch microseconds.
 */
import type { flow } from '@ebmr/recipe-core/pure';
import { Dec } from '@ebmr/expr';
import {
  configError,
  durationUs,
  isRecord,
  problem,
  refuse,
  text,
  type ConfigProblem,
  type Entry,
  type ExceptionDraft,
  type FieldSchema,
  type HandlerProblem,
  type HandlerView,
  type ObjectSchema,
} from '../granulation/common.ts';
import { PROCEDURE_KEYS, resolveRuleSets, shared, TABLET_TYPES, uncoveredMarkets, utcDate, type RuleSet, type RuleTest, type TabletType } from './rule-sets.ts';
import type { Bounds, Tiers, Verdict } from './calc.ts';

export * from '../granulation/common.ts';

/** Instrument and press codes (plant equipment codes), stream ids (plant.ipc_check streams). */
export const EQUIPMENT_CODE = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;
export const STREAM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MICROS = /^[0-9]{1,20}$/;

/** The late-entry time when the MBR gives none (D: 10 min; DI-28). */
export const DEFAULT_LATE_ENTRY_US = 600_000_000n;

export const POSITIVE_DECIMAL: FieldSchema = { type: 'decimal', min: '0', minExclusive: true, description: 'Decimal written as text, above zero' };
export const DECIMAL: FieldSchema = { type: 'decimal', description: 'Decimal written as text' };

const BOUNDS: ObjectSchema = {
  type: 'object',
  description: 'Lower and upper limit (inclusive), decimal text',
  fields: { min: { ...DECIMAL, optional: true }, max: { ...DECIMAL, optional: true } },
};

/** Action limits and optional alert limits inside them. */
export const TIERS: ObjectSchema = {
  type: 'object',
  description: 'Action limits (a breach fails the check) and optional alert limits inside them (a warning)',
  fields: { action: BOUNDS, alert: { ...BOUNDS, optional: true } },
};

/** Action and optional alert tolerance in % (relative limits). */
export const PERCENT_TIERS: ObjectSchema = {
  type: 'object',
  description: 'Action tolerance in % and an optional tighter alert tolerance',
  fields: { action: POSITIVE_DECIMAL, alert: { ...POSITIVE_DECIMAL, optional: true } },
};

export const TABLET_TYPE: FieldSchema = { type: 'string', enum: [...TABLET_TYPES], description: 'Tablet type (selects the compendial rule sets)' };

/** The members every test entry shares (the TB-11 stream and press counter included). */
export const TEST_FIELDS: Readonly<Record<string, FieldSchema>> = {
  instrument: { type: 'string', pattern: EQUIPMENT_CODE, description: 'Plant instrument the test was made on' },
  capture: { type: 'string', enum: ['DEVICE', 'MANUAL'], description: 'From the instrument interface, or keyed by hand (flagged and verified)' },
  readings: { type: 'array', optional: true, items: { type: 'string', pattern: UUID, description: 'Reading id' }, minItems: 1, maxItems: 300, description: 'The claimed instrument readings of the values, in order (DEVICE)' },
  sampledAtUs: { type: 'string', pattern: MICROS, optional: true, description: 'When the sample was taken (epoch microseconds); the entry time when absent' },
  stream: { type: 'string', pattern: STREAM, optional: true, description: 'The TB-11 stream the sample comes from (TB-11 steps only)' },
  counter: { type: 'integer', min: 0, optional: true, description: 'The press tablet counter at sampling (TB-11, plans with a count interval)' },
};

/** Configuration members every IPC test block shares. */
export const LATE_ENTRY: FieldSchema = {
  type: 'object',
  optional: true,
  description: 'An entry recorded later than this after its sampling is flagged late (D: 10 min)',
  fields: { value: { type: 'decimal', min: '0', minExclusive: true, description: 'Decimal written as text' }, unit: { type: 'string', enum: ['s', 'min', 'h'], description: 'Time unit' } },
};

export function boundsOf(v: unknown): Bounds | undefined {
  if (!isRecord(v)) return undefined;
  const out: Bounds = {};
  if (typeof v['min'] === 'string') out.min = v['min'];
  if (typeof v['max'] === 'string') out.max = v['max'];
  return out;
}

export function tiersOf(v: unknown): Tiers | undefined {
  if (!isRecord(v)) return undefined;
  const action = boundsOf(v['action']);
  if (!action) return undefined;
  const alert = boundsOf(v['alert']);
  return { action, ...(alert ? { alert } : {}) };
}

export function percentTiersOf(v: unknown): { action: string; alert?: string } | undefined {
  if (!isRecord(v) || typeof v['action'] !== 'string') return undefined;
  return { action: v['action'], ...(typeof v['alert'] === 'string' ? { alert: v['alert'] } : {}) };
}

/** Definition problems of a tiered limit: an alert band lies inside its action band; a band has at least one end. */
export function tierProblems(where: string, t: Tiers | undefined, code: string, controls: string[]): ConfigProblem[] {
  if (!t) return [];
  const out: ConfigProblem[] = [];
  const has = (b: Bounds) => b.min !== undefined || b.max !== undefined;
  const lt = (a: string, b: string) => Dec.parse(a).lt(Dec.parse(b));
  if (!has(t.action)) out.push(configError(code, `${where} has action limits without a lower or upper limit`, controls));
  for (const b of [t.action, ...(t.alert ? [t.alert] : [])]) {
    if (b.min !== undefined && b.max !== undefined && lt(b.max, b.min)) out.push(configError(code, `${where} has a lower limit above its upper limit`, controls));
  }
  if (t.alert) {
    const a = t.action;
    const w = t.alert;
    if ((a.min !== undefined && (w.min === undefined || lt(w.min, a.min))) || (a.max !== undefined && (w.max === undefined || lt(a.max, w.max)))) {
      out.push(configError(code, `${where} has alert limits outside its action limits`, controls));
    }
  }
  return out;
}

export function percentTierProblems(where: string, t: { action: string; alert?: string } | undefined, code: string, controls: string[]): ConfigProblem[] {
  if (t?.alert !== undefined && Dec.parse(t.action).lt(Dec.parse(t.alert))) return [configError(code, `${where} has an alert tolerance wider than its action tolerance`, controls)];
  return [];
}

// ---------------------------------------------------------------------------------------------
// Where the entry is recorded

/** Whether the step is a TB-11 scheduler step (its test entries name a stream). */
export const isScheduler = (view: HandlerView): boolean => view.phase.block.type === 'TB-11';

/** The configuration of test `key` (weight, physical, friability, disintegration): TB-11 nests it, a test block is it. */
export function testConfig(view: HandlerView, key: string): Readonly<Record<string, unknown>> {
  if (!isScheduler(view)) return view.config;
  const c = view.config[key];
  return isRecord(c) ? c : {};
}

/** The markets of the batch (IN always) and the UTC date of the entry, for rule-set resolution. */
/**
 * Why the rule sets bound for a check cannot be used (review 3c finding 5), as a refusal: a batch market neither a set
 * nor a not-applicable record covers (`<code>-NO-RULE-SET`), or sets whose procedures differ (`<code>-RULE-SETS-DIFFER`).
 */
export function ruleSetRefusal(view: HandlerView, test: RuleTest, type: string | undefined, sets: readonly RuleSet[], code: string): { ok: false; problems: HandlerProblem[] } | undefined {
  const date = utcDate(view.nowUs);
  const open = uncoveredMarkets(test, view.batch.marketSet, type as TabletType | undefined, date);
  if (sets.length === 0 || open.length > 0) {
    return refuse(`${code}-NO-RULE-SET`, `No compendial rule set covers ${String(type)} tablets for market ${open.join(', ') || 'IN'} of this batch, and no record says none applies`, ['IN-34', 'DI-10']);
  }
  const differ = PROCEDURE_KEYS[test].filter((k) => shared(sets, k) === undefined);
  if (differ.length > 0) return refuse(`${code}-RULE-SETS-DIFFER`, `The rule sets bound for this check give different procedures (${differ.join(', ')})`, ['IN-34', 'DI-10']);
  return undefined;
}

export function resolve(view: HandlerView, test: RuleTest, type: string | undefined, optIn = false): RuleSet[] {
  return resolveRuleSets(test, view.batch.marketSet, type as TabletType | undefined, utcDate(view.nowUs), optIn);
}

/** The value count of a DEVICE entry's readings, in order. */
export interface Common {
  base: Record<string, unknown>;
  manual: boolean;
  late: boolean;
}

/**
 * The members every test entry stores, and its refusals: the stream (a TB-11 step's test entry names one of its streams;
 * a test block's entry none), the sampling time (not in the future, not before the step started), the readings of a
 * DEVICE entry (exactly `values` of them) and none for a MANUAL one.
 */
export function commonOf(view: HandlerView, entry: Entry, values: number, code: string): { ok: true; common: Common } | { ok: false; problems: HandlerProblem[] } {
  const stream = text(entry['stream']);
  if (isScheduler(view)) {
    const streams = Array.isArray(view.config['streams']) ? (view.config['streams'] as unknown[]).map((s) => (isRecord(s) ? s['id'] : undefined)) : [];
    if (stream === undefined || !streams.includes(stream)) return refuse(`${code}-STREAM`, `A check at ${view.stepKey} names one of its streams (${streams.join(', ')})`, ['PR-29', 'IN-35']);
  } else if (stream !== undefined || entry['counter'] !== undefined) {
    return refuse(`${code}-STREAM`, `${view.stepKey} is not a TB-11 scheduler step: its checks name no stream or counter`, ['PR-29']);
  }
  const sampledAt = text(entry['sampledAtUs']) !== undefined ? BigInt(String(entry['sampledAtUs'])) : view.nowUs;
  if (sampledAt > view.nowUs) return refuse(`${code}-SAMPLED-LATER`, `The sample of ${view.stepKey} cannot be taken after it is recorded`, ['DI-28']);
  const started = view.entries().at(0)?.recordedAt;
  const startedAt = started ?? view.nowUs;
  if (sampledAt < startedAt && view.entries().length > 0) return refuse(`${code}-SAMPLED-EARLY`, `The sample of ${view.stepKey} cannot be taken before the step's first entry`, ['DI-28']);
  const capture = String(entry['capture']);
  const readings = Array.isArray(entry['readings']) ? (entry['readings'] as string[]) : undefined;
  if (capture === 'DEVICE' && readings?.length !== values) {
    return refuse(`${code}-READINGS`, `A check captured from the instrument names one claimed reading per value (${values}), in order`, ['DI-32', 'DI-31']);
  }
  if (capture === 'MANUAL' && readings !== undefined) return refuse(`${code}-READINGS`, 'A check keyed by hand names no instrument readings', ['DI-32']);
  const lateUs = durationUs(view.config['lateEntry']) ?? DEFAULT_LATE_ENTRY_US;
  const late = view.nowUs - sampledAt > lateUs;
  const base: Record<string, unknown> = {
    instrument: entry['instrument'],
    capture,
    ...(readings ? { readings } : {}),
    sampledAtUs: sampledAt.toString(),
    ...(stream !== undefined ? { stream } : {}),
    ...(entry['counter'] !== undefined ? { counter: entry['counter'] } : {}),
    late,
    recordedBy: view.actor.id,
  };
  return { ok: true, common: { base, manual: capture === 'MANUAL', late } };
}

/** The exceptions a test entry raises for how it was captured and when (manual keying, late entry). */
export function captureExceptions(view: HandlerView, c: Common, what: string): ExceptionDraft[] {
  const out: ExceptionDraft[] = [];
  if (c.manual) {
    out.push({
      type: 'IPC_MANUAL_ENTRY',
      title: `${what} at ${view.stepKey} was keyed by hand instead of taken from the instrument interface; the step now needs a second person`,
      controls: ['DI-32', 'PR-29'],
      severity: 'ALERT',
      category: 'MANUAL_ENTRY',
      blocks: 'NONE',
    });
  }
  if (c.late) {
    out.push({
      type: 'IPC_LATE_ENTRY',
      title: `${what} at ${view.stepKey} was recorded later than the late-entry time after its sampling`,
      controls: ['DI-28'],
      severity: 'ALERT',
      category: 'LATE_ENTRY',
      blocks: 'NONE',
    });
  }
  return out;
}

/** The exception of a final verdict: FAIL holds the steps after it until a deviation; ALERT warns. */
export function verdictExceptions(view: HandlerView, verdict: Verdict | 'PENDING', what: string, stream: string | undefined): ExceptionDraft[] {
  const where = stream !== undefined ? ` (stream ${stream})` : '';
  if (verdict === 'FAIL') {
    return [
      {
        type: 'IPC_CHECK_FAILED',
        title: `${what} at ${view.stepKey}${where} failed its limits: output since the last passing check is held and the steps after it wait for a deviation`,
        controls: ['PR-29', 'IN-35'],
        severity: 'ACTION',
        category: 'OUT_OF_LIMIT',
        blocks: 'DOWNSTREAM',
        until: 'DEVIATION',
        deviationRequired: true,
        ...(stream !== undefined ? { item: stream } : {}),
      },
    ];
  }
  if (verdict === 'ALERT') {
    return [
      {
        type: 'IPC_CHECK_ALERT',
        title: `${what} at ${view.stepKey}${where} is inside its action limits but outside its alert limits`,
        controls: ['PR-29'],
        severity: 'ALERT',
        category: 'OUT_OF_LIMIT',
        blocks: 'NONE',
        ...(stream !== undefined ? { item: stream } : {}),
      },
    ];
  }
  return [];
}

/** Exception rules every IPC test block declares. */
export const TEST_EXCEPTION_RULES = [
  { type: 'IPC_CHECK_FAILED', category: 'OUT_OF_LIMIT' as const, severity: 'ACTION' as const, summary: 'An IPC check failed its action limits or its compendial criteria', controls: ['PR-29', 'IN-35'] },
  { type: 'IPC_CHECK_ALERT', category: 'OUT_OF_LIMIT' as const, severity: 'ALERT' as const, summary: 'An IPC check is outside its alert limits', controls: ['PR-29'] },
  { type: 'IPC_MANUAL_ENTRY', category: 'MANUAL_ENTRY' as const, severity: 'ALERT' as const, summary: 'An IPC result keyed by hand instead of taken from the instrument', controls: ['DI-32'] },
  { type: 'IPC_LATE_ENTRY', category: 'LATE_ENTRY' as const, severity: 'ALERT' as const, summary: 'An IPC result recorded late after its sampling', controls: ['DI-28'] },
];
export const TEST_EXCEPTION_TYPES = TEST_EXCEPTION_RULES.map((r) => r.type);

/** A list of decimal texts, or undefined. */
export function decimals(v: unknown): Dec[] | undefined {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return undefined;
  return (v as string[]).map((x) => Dec.parse(x));
}

export { problem };

/** The type of a phase's block (for configuration checks that run on a TB-11 nested test). */
export type PhaseNode = flow.PhaseNode;

/** The final result of a test entry (PASS, ALERT, FAIL), or the stage still to come. */
export type Outcome = Verdict | 'SECOND_STAGE' | 'REPEAT' | 'RETEST' | 'BUFFER';
export const isFinal = (o: unknown): o is Verdict => o === 'PASS' || o === 'ALERT' || o === 'FAIL';
