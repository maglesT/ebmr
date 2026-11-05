/**
 * The generic handler (decision 0026, slice S2): one BlockVersion built from a library definition, so the existing
 * engine runs any library block with no code of its own.
 *
 * - Configuration: the product's values for the block (a `BlockUse` without its `block` key), checked by
 *   `checkBlockUse` when the batch is defined (errors refuse, warnings need a justification).
 * - Entries: one entry kind per section (the section id), whose fields are the section's typed fields; TIMER_START and
 *   TIMER_STOP for timers (the engine's trusted time gives the duration). A calculated field is never typed: the
 *   schema refuses it (INV-25) and the handler computes it.
 * - O-9 (b): a calculated field is stored with its evaluation record (expression, language version, the inputs it
 *   read), so every figure can be re-verified; the database does not recompute it.
 * - Limits: each value with a limit slot is evaluated against the formulation's tiered limits; a breach raises the
 *   exception LIB_LIMIT_BREACH with the consequences the engine gives that tier (PR-08).
 * - External inputs: a formula line is the master's BOM line scaled exactly to the batch's issued size, and the batch
 *   size is that size (S10, ./scaling.ts); lot assay and earlier-step values are read from the phase's targets
 *   (`view.target(id)`), as is a formula line or size the master cannot give.
 * - Smart fields (weighing, lot, equipment, container, sample) record their identifiers and quantities here; their
 *   status checks against the plant and stores arrive in S6. Signature roles are mapped to steps in S4.
 */
import { Dec } from '@ebmr/expr';
import type { BlockVersion, ExceptionDraft, ExceptionRule, HandlerProblem, HandlerView, EntryResult } from '../blocks/contract.ts';
import type { FieldSchema, ObjectSchema } from '../blocks/schema.ts';
import { tierDraft } from '../engine/exceptions.ts';
import type { EntryRecord } from '../engine/types.ts';
import type { ExpressionService, ExprType, ExprValue } from '../flow/expression-port.ts';
import { durationToMicros, midpointDecimal } from '../flow/decimal.ts';
import type { JsonValue, MbrContent } from '../flow/model.ts';
import { evaluateLimits } from '../limits/evaluate.ts';
import { LIMIT_SOURCE_KINDS, LIMIT_TIERS, ROUNDING_RULES, type LimitSpec } from '../limits/model.ts';
import { lotProblems } from '../blocks/generic/material.ts';
import { checkBlockUse } from './check-use.ts';
import { scaledInputs } from './scaling.ts';
import type { BlockDefinition, BlockUse, FieldDef, SectionDef, TestStatistic } from './model.ts';

/** Block type of a library definition in the registry and in the MBR, e.g. LIB-IPC-FRIAB. */
export function libraryBlockType(code: string): string {
  return `LIB-${code}`;
}

export const TIMER_START = 'TIMER_START';
export const TIMER_STOP = 'TIMER_STOP';

/** Exception types a library block raises. */
export const LIBRARY_EXCEPTION_RULES: ExceptionRule[] = [
  { type: 'LIB_LIMIT_BREACH', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A value outside the formulation\'s limit (with the consequences of the tier breached)', controls: ['PR-08'] },
  { type: 'LIB_UNEXPECTED_ANSWER', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A yes/no answer other than the expected one', controls: ['PR-29', 'PR-08'] },
  { type: 'LIB_NOT_ALLOWED_CHOICE', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A choice the formulation marks as not allowed', controls: ['PR-29', 'PR-08'] },
  { type: 'LIB_IPC_INTERVAL_MISSED', category: 'TIME_LIMIT', severity: 'ACTION', summary: 'An in-process check was recorded later than its interval', controls: ['PR-29', 'PR-30'] },
  { type: 'LIB_REPEAT_LIMIT_REACHED', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'The maximum number of repeats was reached without a passing value', controls: ['PR-08', 'INV-20'] },
];

type Config = Omit<BlockUse, 'block'> & { hash?: string };

/** Severity of a tier's breach, least to most severe (an alert, an internal action, a registered or validated tier). */
const SEVERITY_RANK: Readonly<Record<ExceptionDraft['severity'], number>> = { ALERT: 1, ACTION: 2, CRITICAL: 3 };

const LIMIT_SCHEMA: ObjectSchema = {
  type: 'object',
  description: 'A tiered limit (PR-08)',
  fields: {
    unit: { type: 'string', description: 'UCUM unit of every bound' },
    ranges: {
      type: 'array',
      description: 'One range per tier',
      minItems: 1,
      items: {
        type: 'object',
        description: 'A tier',
        fields: {
          tier: { type: 'string', enum: LIMIT_TIERS, description: 'Tier' },
          low: { type: 'object', optional: true, description: 'Lower bound', fields: { value: { type: 'decimal', description: 'Value' }, inclusive: { type: 'boolean', description: 'The bound itself passes' } } },
          high: { type: 'object', optional: true, description: 'Upper bound', fields: { value: { type: 'decimal', description: 'Value' }, inclusive: { type: 'boolean', description: 'The bound itself passes' } } },
          rounding: { type: 'string', enum: ROUNDING_RULES, description: 'Rounding at comparison' },
          source: { type: 'object', description: 'Where the limit comes from', fields: { kind: { type: 'string', enum: LIMIT_SOURCE_KINDS, description: 'Kind' }, ref: { type: 'string', description: 'Reference id' } } },
          pharmacopoeia: { type: 'object', optional: true, description: 'Pharmacopoeia and edition', fields: { code: { type: 'string', description: 'Code' }, edition: { type: 'string', description: 'Edition' } } },
        },
      },
    },
    actionBreach: { type: 'string', optional: true, enum: ['STOP_DEPENDENT_STEP', 'CONTINUE_CURRENT_STEP_WITH_DEVIATION'], description: 'What an internal action breach does' },
  },
};

const CONFIG_SCHEMA: ObjectSchema = {
  type: 'object',
  description: "The product's values for this library block (decision 0026)",
  fields: {
    hash: { type: 'string', optional: true, pattern: /^[0-9a-f]{64}$/, description: 'Content hash of the library version pinned at formulation approval' },
    limits: { type: 'record', optional: true, values: LIMIT_SCHEMA, description: 'Limits by slot' },
    targets: { type: 'record', optional: true, values: { type: 'decimal', description: 'Target' }, description: 'Targets by limit slot' },
    equipmentClasses: { type: 'record', optional: true, values: { type: 'string', description: 'Equipment class' }, description: 'Equipment classes by slot' },
    counts: { type: 'record', optional: true, values: { type: 'string', pattern: /^[1-9][0-9]{0,6}$/, description: 'Whole number' }, description: 'Counts by slot' },
    intervals: { type: 'record', optional: true, values: { type: 'object', description: 'Interval', fields: { value: { type: 'decimal', description: 'Value' }, unit: { type: 'string', description: 'Time unit' } } }, description: 'Intervals by slot' },
    justifications: { type: 'record', optional: true, values: { type: 'string', description: 'Reason' }, description: 'Reasons for limits looser than the reference' },
    marketRules: {
      type: 'record',
      optional: true,
      description: 'Limit slots bound to a market rule (O-5)',
      values: { type: 'object', description: 'Market rule', fields: { key: { type: 'string', description: 'Rule key' }, bound: { type: 'string', enum: ['LOW', 'HIGH'], description: 'Bound' } } },
    },
    bomLines: { type: 'record', optional: true, values: { type: 'string', description: 'BOM line id' }, description: 'Formula lines by slot' },
    stepValues: { type: 'record', optional: true, values: { type: 'object', description: 'Earlier step value', fields: { step: { type: 'string', description: 'Step' }, field: { type: 'string', description: 'Field' } } }, description: 'Earlier-step values by slot' },
    points: {
      type: 'record',
      optional: true,
      description: 'Time points or stages of per-point tests, by field',
      values: { type: 'array', minItems: 1, description: 'Points', items: { type: 'object', description: 'Point', fields: { id: { type: 'string', description: 'Id' }, label: { type: 'string', description: 'Label' }, limits: LIMIT_SCHEMA } } },
    },
  },
};

const READINGS: FieldSchema = { type: 'array', description: 'Readings in the field unit', minItems: 1, maxItems: 1000, items: { type: 'decimal', description: 'Reading' } };

function fieldSchema(f: FieldDef): FieldSchema | undefined {
  const d = f.label;
  switch (f.type) {
    case 'NUMBER':
      return { type: 'decimal', optional: true, description: `${d} (${f.unit})` };
    case 'WEIGHING':
      return { type: 'decimal', optional: true, description: `${d}, net (${f.unit})` };
    case 'TEXT':
      return f.pattern !== undefined ? { type: 'string', optional: true, pattern: new RegExp(`^(?:${f.pattern})$`, 'u'), description: d } : { type: 'string', optional: true, description: d };
    case 'YES_NO':
      return { type: 'boolean', optional: true, description: d };
    case 'CHOICE':
      return { type: 'string', optional: true, enum: f.options, description: d };
    case 'DATE_TIME':
      return { type: 'string', optional: true, pattern: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/, description: `${d} (date, or date and time)` };
    case 'MATERIAL_LOT':
    case 'EQUIPMENT':
    case 'CONTAINER':
      return { type: 'string', optional: true, description: `${d} (identifier)` };
    case 'SAMPLE':
      return { type: 'integer', optional: true, min: 1, max: 100000, description: `${d} (units taken)` };
    case 'TEST_RESULT':
      return f.perPoint === true ? { type: 'record', optional: true, values: READINGS, description: `${d}, readings by point` } : { ...READINGS, optional: true };
    case 'CALC':
    case 'TIMER':
      return undefined;
  }
}

/** S6: the facts the server reads from the stores and the plant, by field id; the browser never sends them. */
const LOT_FACTS: FieldSchema = {
  type: 'record',
  optional: true,
  serverFilled: true,
  description: 'Lot facts by field, read by the server from the lot register',
  values: {
    type: 'object',
    description: 'A lot',
    fields: {
      id: { type: 'string', description: 'Lot code' },
      material: { type: 'string', description: 'Material code' },
      status: { type: 'string', description: 'Lot status' },
      expiresAtUs: { type: 'string', optional: true, description: 'Expiry (epoch microseconds)' },
      retestAtUs: { type: 'string', optional: true, description: 'Retest date (epoch microseconds)' },
      identityTested: { type: 'boolean', description: 'Identity tested' },
    },
  },
};
const EQUIPMENT_FACTS: FieldSchema = {
  type: 'record',
  optional: true,
  serverFilled: true,
  description: 'Equipment facts by field, read by the server from the plant register',
  values: {
    type: 'object',
    description: 'Equipment',
    fields: {
      code: { type: 'string', description: 'Equipment code' },
      classCode: { type: 'string', description: 'Equipment class' },
      fitness: { type: 'string', description: 'Fitness (QUALIFIED, CALIBRATION_DUE_SOON, ...)' },
    },
  },
};
/** Fitness states in which equipment may be used (plant.equipment_fitness). */
export const USABLE_FITNESS = ['QUALIFIED', 'CALIBRATION_DUE_SOON'];

function sectionSchema(s: SectionDef): ObjectSchema {
  const fields: Record<string, FieldSchema> = {};
  for (const f of s.fields) {
    const fs = fieldSchema(f);
    if (fs) fields[f.id] = fs;
  }
  if (s.fields.some((f) => f.type === 'MATERIAL_LOT')) fields['lots'] = LOT_FACTS;
  if (s.fields.some((f) => f.type === 'EQUIPMENT')) fields['equipment'] = EQUIPMENT_FACTS;
  return { type: 'object', description: s.title, fields };
}

/** A recorded scalar as text (entries hold strings, booleans and whole numbers; never an object here). */
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : JSON.stringify(v));
const isRepeating = (s: SectionDef): boolean => s.repeat !== undefined && s.repeat.kind !== 'ONCE';
const problem = (code: string, message: string, controls: string[] = ['PR-03']): HandlerProblem => ({ code, message, controls });
const configOf = (view: Pick<HandlerView, 'config'>): Config => view.config;

function shown(f: FieldDef, values: Readonly<Record<string, unknown>>): boolean {
  return f.showWhen === undefined || values[f.showWhen.field] === f.showWhen.equals;
}

/** The value of a field as a calculation reads it. */
function exprValue(f: FieldDef, v: unknown): ExprValue | undefined {
  if (v === undefined) return undefined;
  switch (f.type) {
    case 'NUMBER':
    case 'WEIGHING':
    case 'CALC':
      return { kind: 'DECIMAL', value: text(typeof v === 'object' && v !== null && 'value' in v ? (v).value : v), unit: f.unit };
    case 'TEST_RESULT':
      return Array.isArray(v) ? { kind: 'SERIES', values: v.map(String), unit: f.unit } : undefined;
    case 'YES_NO':
      return { kind: 'BOOLEAN', value: v === true };
    case 'CHOICE':
      return { kind: 'CATEGORY', value: text(v) };
    case 'TEXT':
      return { kind: 'TEXT', value: text(v) };
    default:
      return undefined;
  }
}

function exprTypeOf(f: FieldDef): ExprType | undefined {
  switch (f.type) {
    case 'NUMBER':
    case 'WEIGHING':
    case 'CALC':
      return { kind: 'DECIMAL', unit: f.unit };
    case 'TEST_RESULT':
      return f.perPoint === true ? undefined : { kind: 'SERIES', of: { kind: 'DECIMAL', unit: f.unit } };
    case 'YES_NO':
      return { kind: 'BOOLEAN' };
    case 'CHOICE':
      return { kind: 'CATEGORY', values: f.options };
    case 'TEXT':
      return { kind: 'TEXT' };
    default:
      return undefined;
  }
}

/** Statistics of readings, in decimal arithmetic (never a JavaScript number). RSD is a sample RSD in %. */
export function statistic(stat: TestStatistic, readings: readonly string[]): string[] {
  const ds = readings.map((r) => Dec.parse(r));
  if (stat === 'INDIVIDUAL') return readings.slice();
  const first = ds[0];
  if (first === undefined) return [];
  const sum = ds.reduce((a, b) => a.plus(b), Dec.parse('0'));
  const mean = sum.div(Dec.fromInteger(ds.length));
  switch (stat) {
    case 'MEAN':
      return [mean.toString()];
    case 'MIN':
      return [ds.reduce((a, b) => Dec.min(a, b), first).toString()];
    case 'MAX':
      return [ds.reduce((a, b) => Dec.max(a, b), first).toString()];
    case 'RANGE':
      return [ds.reduce((a, b) => Dec.max(a, b), first).minus(ds.reduce((a, b) => Dec.min(a, b), first)).toString()];
    case 'RSD': {
      if (ds.length < 2 || mean.isZero()) return [];
      const ss = ds.reduce((a, d) => a.plus(d.minus(mean).times(d.minus(mean))), Dec.parse('0'));
      const sd = ss.div(Dec.fromInteger(ds.length - 1)).sqrt();
      return [sd.div(mean.abs()).times(Dec.parse('100')).toString()];
    }
  }
}

/** Where an earlier-step value a calculation read came from (decision 0026 STEP_VALUE). */
interface StepValueRead {
  step: string;
  field: string;
  stepKey: string;
  entryId: string;
  /** The figure as the earlier step recorded it, before conversion to the input's unit. */
  recorded: { value: string; unit: string };
}

/** Builds the registry block version of a library definition. */
export function libraryBlockVersion(def: BlockDefinition, expr: ExpressionService): BlockVersion {
  const type = libraryBlockType(def.code);
  const sections = new Map(def.sections.map((s) => [s.id, s]));
  const fieldsById = new Map(def.sections.flatMap((s) => s.fields.map((f) => [f.id, { field: f, section: s }] as const)));
  const timers = def.sections.flatMap((s) => s.fields).filter((f) => f.type === 'TIMER');
  // The values a later step may read: numbers, weighings and calculations of a section recorded once.
  const readable = new Map<string, { section: string; unit: string; calc: boolean }>();
  for (const s of def.sections) {
    if (isRepeating(s)) continue;
    for (const f of s.fields) if (f.type === 'NUMBER' || f.type === 'WEIGHING' || f.type === 'CALC') readable.set(f.id, { section: s.id, unit: f.unit, calc: f.type === 'CALC' });
  }
  const readableValues: Record<string, string> = Object.fromEntries([...readable].map(([id, r]) => [id, r.unit]));
  const entries: Record<string, ObjectSchema> = {};
  for (const s of def.sections) entries[s.id] = sectionSchema(s);
  if (timers.length > 0) {
    const field: FieldSchema = { type: 'string', enum: timers.map((t) => t.id), description: 'Timer' };
    entries[TIMER_START] = { type: 'object', description: 'Start a timer', fields: { field } };
    entries[TIMER_STOP] = { type: 'object', description: 'Stop a timer', fields: { field } };
  }

  /** Evaluates one value against the formulation's limit for its slot; returns the exception draft on a breach. */
  const breach = (spec: LimitSpec | undefined, value: string, unit: string, subject: string, item: string): ExceptionDraft | undefined => {
    if (!spec) return undefined;
    const ev = evaluateLimits(spec, { value, unit }, expr);
    const d = tierDraft(ev, subject, 'PARAMETER', item, ev.currentStepMayContinueWithDeviation);
    // The tier's consequences as the engine gives them, under the library's own type: the engine's LIMIT_BREACH stays the
    // verdict of an MBR parameter (recipe-core 0305, EBMR-EXE-044); the database checks this one (recipe-core 1810).
    return d ? { ...d, type: 'LIB_LIMIT_BREACH', title: `${d.title} [${ev.breached?.toLowerCase().replace('_', ' ') ?? ''} tier]` } : undefined;
  };

  /** Whether one section instance passes (for UNTIL_PASS): its until-field within limits or with the expected answer. */
  const passes = (s: SectionDef, data: Readonly<Record<string, unknown>>, config: Config): boolean => {
    if (s.repeat?.kind !== 'UNTIL_PASS') return true;
    const until = s.repeat.untilField;
    const f = fieldsById.get(until)?.field;
    const v = data[until] ?? (data['computed'] as Record<string, { value: string }> | undefined)?.[until]?.value;
    if (!f || v === undefined) return false;
    if (f.type === 'YES_NO') return f.expected === undefined || v === f.expected;
    if ('limitSlot' in f && f.limitSlot !== undefined && 'unit' in f) {
      const spec = config.limits?.[f.limitSlot];
      return spec === undefined || evaluateLimits(spec, { value: text(v), unit: f.unit }, expr).breached === undefined;
    }
    return true;
  };

  /** Values the calculations of an entry can read: external inputs, other sections' entries, then this entry. */
  const calcInputs = (view: HandlerView, section: SectionDef, data: Readonly<Record<string, unknown>>): { types: Map<string, ExprType>; values: Map<string, ExprValue>; read: Map<string, StepValueRead>; missingInput?: string } => {
    const types = new Map<string, ExprType>();
    const values = new Map<string, ExprValue>();
    const read = new Map<string, StepValueRead>();
    // S10: formula-line and batch-size inputs come from the master's BOM scaled to the batch's issued size.
    const scaled = scaledInputs(def, configOf(view), view.mbr, view.batch.batchSize, expr);
    for (const i of def.inputs ?? []) {
      types.set(i.id, { kind: 'DECIMAL', unit: i.unit });
      const sc = scaled[i.id];
      if (sc) {
        values.set(i.id, { kind: 'DECIMAL', value: sc.value, unit: sc.unit });
        continue;
      }
      const t = view.target(i.id);
      if (t?.kind === 'DECIMAL') values.set(i.id, { kind: 'DECIMAL', value: t.value, unit: t.unit });
      else if (t?.kind === 'COUNT') values.set(i.id, { kind: 'DECIMAL', value: t.value, unit: '1' });
      else if (i.kind === 'STEP_VALUE') {
        // The earlier step and field the formulation names (decision 0026; injectables I-1 finding): read from that
        // step's completed record, in this input's unit. Missing stays missing (the calculation is refused, DI-33).
        const sv = configOf(view).stepValues?.[i.slot];
        const v = sv ? view.stepValue?.(sv.step, sv.field) : undefined;
        const value = v ? (v.unit === i.unit ? v.value : expr.convert(v.value, v.unit, i.unit)) : undefined;
        if (v && sv && value !== undefined) {
          values.set(i.id, { kind: 'DECIMAL', value, unit: i.unit });
          read.set(i.id, { step: sv.step, field: sv.field, stepKey: v.stepKey, entryId: v.entryId, recorded: { value: v.value, unit: v.unit } });
        }
      }
    }
    for (const s of def.sections) {
      if (s === section) continue;
      const recorded = view.entries(s.id);
      for (const f of s.fields) {
        const t = exprTypeOf(f);
        if (!t) continue;
        const read = (e: EntryRecord): ExprValue | undefined => exprValue(f, f.type === 'CALC' ? (e.data['computed'] as Record<string, unknown> | undefined)?.[f.id] : e.data[f.id]);
        if (isRepeating(s)) {
          if (t.kind !== 'DECIMAL') continue;
          types.set(f.id, { kind: 'SERIES', of: t });
          const vs = recorded.map(read).filter((v): v is ExprValue & { kind: 'DECIMAL' } => v?.kind === 'DECIMAL');
          if (vs.length > 0) values.set(f.id, { kind: 'SERIES', values: vs.map((v) => v.value), unit: t.unit });
        } else {
          types.set(f.id, t);
          const last = recorded[recorded.length - 1];
          const v = last ? read(last) : undefined;
          if (v) values.set(f.id, v);
        }
      }
    }
    for (const f of section.fields) {
      const t = exprTypeOf(f);
      if (!t) continue;
      types.set(f.id, t);
      const v = exprValue(f, data[f.id]);
      if (v) values.set(f.id, v);
    }
    return { types, values, read };
  };

  /**
   * An IPC section's interval missed now (trusted time): more than the formulation's interval since its last round, or
   * since the step started when it has none yet (R3-ENG-4). `what` says which gap, e.g. "check 3 came later than".
   */
  const intervalMissed = (view: HandlerView, section: SectionDef, what: string): ExceptionDraft | undefined => {
    if (section.repeat?.kind !== 'PER_INTERVAL') return undefined;
    const iv = configOf(view).intervals?.[section.repeat.intervalSlot];
    if (!iv) return undefined;
    const limitUs = durationToMicros(iv.value, iv.unit);
    const since = view.entries(section.id).at(-1)?.recordedAt ?? view.startedAtUs;
    if (limitUs === undefined || since === undefined || view.nowUs - since <= limitUs) return undefined;
    return { type: 'LIB_IPC_INTERVAL_MISSED', title: `${def.title}, ${section.title}: ${what} every ${iv.value} ${iv.unit}`, controls: ['PR-29', 'PR-30'], severity: 'ACTION', category: 'TIME_LIMIT', blocks: 'NONE' };
  };

  const acceptSection = (view: HandlerView, section: SectionDef, entry: Readonly<Record<string, unknown>>): EntryResult => {
    const config = configOf(view);
    const previous = view.entries(section.id);
    const r = section.repeat ?? { kind: 'ONCE' as const };
    if (r.kind === 'ONCE' && previous.length > 0) return { ok: false, problems: [problem('LIB-SECTION-ONCE', `${section.title} is recorded once in ${view.phase.id}; correct the recorded entry instead`)] };
    if (r.kind === 'COUNT' && previous.length >= Number(config.counts?.[r.countSlot] ?? '1')) return { ok: false, problems: [problem('LIB-SECTION-COUNT', `${section.title} is recorded ${config.counts?.[r.countSlot] ?? '1'} times in ${view.phase.id}, and all are recorded`)] };
    if (r.kind === 'UNTIL_PASS') {
      const last = previous[previous.length - 1];
      if (last && passes(section, last.data, config)) return { ok: false, problems: [problem('LIB-SECTION-PASSED', `${section.title} already passed; no further repeat is needed`, ['INV-20'])] };
      const max = r.maxRepeatsSlot !== undefined ? config.counts?.[r.maxRepeatsSlot] : undefined;
      if (max !== undefined && previous.length >= Number(max)) return { ok: false, problems: [problem('LIB-SECTION-MAX', `${section.title} has reached its maximum of ${max} repeats`, ['INV-20'])] };
    }

    const problems: HandlerProblem[] = [];
    const data: Record<string, unknown> = {};
    for (const f of section.fields) {
      if (f.type === 'CALC' || f.type === 'TIMER') continue;
      const v = entry[f.id];
      if (!shown(f, entry)) {
        if (v !== undefined) problems.push(problem('LIB-ENTRY-HIDDEN', `${f.label} applies only when ${f.showWhen?.field} is ${String(f.showWhen?.equals)}; leave it empty`));
        continue;
      }
      if (v === undefined) {
        if (f.required !== false) problems.push(problem('LIB-ENTRY-REQUIRED', `${f.label} is required`));
        continue;
      }
      if (f.type === 'TEST_RESULT') {
        const n = config.counts?.[f.replicatesSlot];
        const sets = f.perPoint === true ? Object.entries(v as Record<string, string[]>) : [['', v as string[]] as const];
        if (f.perPoint === true) {
          const ids = (config.points?.[f.id] ?? []).map((p) => p.id);
          const given = sets.map(([k]) => k);
          if (ids.some((id) => !given.includes(id)) || given.some((g) => !ids.includes(g))) problems.push(problem('LIB-ENTRY-POINTS', `${f.label} needs readings for exactly the points ${ids.join(', ')}`));
        }
        for (const [, readings] of sets) if (n !== undefined && readings.length !== Number(n)) problems.push(problem('LIB-ENTRY-REPLICATES', `${f.label} needs ${n} readings, not ${readings.length}`, ['PR-29']));
      }
      data[f.id] = v;
    }
    // S6: lots and equipment, from the facts the server read (the database compares them with its registers).
    const lots = (entry['lots'] ?? {}) as Record<string, Record<string, unknown>>;
    const equipment = (entry['equipment'] ?? {}) as Record<string, Record<string, unknown>>;
    let manualWeighing = false;
    for (const f of section.fields) {
      if (!shown(f, entry) || data[f.id] === undefined) continue;
      if (f.type === 'MATERIAL_LOT') {
        const lot = lots[f.id];
        if (!lot || lot['id'] !== data[f.id]) {
          problems.push(problem('LIB-LOT-FACTS', `${f.label}: the lot register has no facts for lot ${text(data[f.id])}`, ['PR-18', 'IN-23']));
          continue;
        }
        const line = f.bomLineSlot !== undefined ? config.bomLines?.[f.bomLineSlot] : undefined;
        const bomLine = line !== undefined ? view.mbr.bom.find((b) => b.id === line) : undefined;
        // R3-ENG-3: a field that reads a formula line whose line is not in the BOM is refused, never left unchecked.
        if (f.bomLineSlot !== undefined && bomLine === undefined) {
          problems.push(problem('LIB-LOT-BOM-LINE', `${f.label}: the formulation's line ${line ?? '(none)'} is not a line of the master's bill of materials, so lot ${text(data[f.id])} cannot be checked against it`, ['PR-18', 'IN-23', 'INV-25']));
          continue;
        }
        problems.push(...lotProblems(view, lot, bomLine?.material));
      }
      if (f.type === 'EQUIPMENT') {
        const e = equipment[f.id];
        const wanted = config.equipmentClasses?.[f.classSlot];
        if (!e || e['code'] !== data[f.id]) problems.push(problem('LIB-EQUIPMENT-FACTS', `${f.label}: the plant register has no equipment ${text(data[f.id])}`, ['PR-19']));
        else if (wanted !== undefined && e['classCode'] !== wanted) problems.push(problem('LIB-EQUIPMENT-CLASS', `${f.label}: ${text(e['code'])} is of class ${text(e['classCode'])}, not ${wanted} as the formulation requires`, ['PR-19', 'IN-11']));
        else if (!USABLE_FITNESS.includes(text(e['fitness']))) problems.push(problem('LIB-EQUIPMENT-FITNESS', `${f.label}: ${text(e['code'])} is ${text(e['fitness']).toLowerCase().replace(/_/g, ' ')} and may not be used`, ['PR-19', 'IN-11']));
      }
      // Every library weighing is keyed by hand (balances join in a later slice): two-person verification (DI-30, PR-14).
      if (f.type === 'WEIGHING') manualWeighing = true;
    }
    if (section.fields.some((f) => f.type === 'MATERIAL_LOT')) data['lots'] = lots;
    if (section.fields.some((f) => f.type === 'EQUIPMENT')) data['equipment'] = equipment;
    if (problems.length > 0) return { ok: false, problems };

    // O-9 (b): the server computes each calculated field and stores it with its evaluation record.
    const computed: Record<string, { value: string; unit: string; expression: string; languageVersion: string; inputs: Record<string, ExprValue>; stepValues?: Record<string, StepValueRead> }> = {};
    for (const f of section.fields) {
      if (f.type !== 'CALC' || !shown(f, entry)) continue;
      const { types, values, read: fromSteps } = calcInputs(view, section, { ...data, ...Object.fromEntries(Object.entries(computed).map(([k, c]) => [k, c.value])) });
      for (const [k, c] of Object.entries(computed)) values.set(k, { kind: 'DECIMAL', value: c.value, unit: c.unit });
      const outcome = expr.evaluate(f.expression, types, values, { role: 'CALCULATION', output: { kind: 'DECIMAL', unit: f.unit } });
      if (!outcome.ok) return { ok: false, problems: [problem('LIB-CALC-FAILED', `${f.label} cannot be calculated: ${outcome.message}`, ['DI-33'])] };
      if (outcome.value.kind !== 'DECIMAL') return { ok: false, problems: [problem('LIB-CALC-FAILED', `${f.label} did not give a number`, ['DI-33'])] };
      const read = expr.check(f.expression, types, { role: 'CALCULATION' }).reads;
      // An earlier-step value is stored with where it came from (the step instance, the entry, the figure as recorded
      // before conversion), so the figure can be re-verified from the record alone.
      const sources = Object.fromEntries(read.flatMap((k) => { const s = fromSteps.get(k); return s ? [[k, s]] : []; }));
      computed[f.id] = { value: outcome.value.value, unit: f.unit, expression: f.expression, languageVersion: expr.languageVersion, inputs: Object.fromEntries(read.flatMap((k) => { const v = values.get(k); return v ? [[k, v]] : []; })), ...(Object.keys(sources).length > 0 ? { stepValues: sources } : {}) };
    }

    const stored = { ...data, ...(Object.keys(computed).length > 0 ? { computed } : {}) };
    // A loop: a value that does not pass is a repeat while repeats remain (the loop decides at its exit, as an MBR loop
    // endpoint does). R3-ENG-1: the last allowed repeat without a pass exhausts the loop; its endpoint is then judged
    // against its tier like any value (an MBR loop's exit judges it, recipe-core advance.ts raiseForEvaluationAtExit).
    const maxRepeats = r.kind === 'UNTIL_PASS' && r.maxRepeatsSlot !== undefined ? config.counts?.[r.maxRepeatsSlot] : undefined;
    const exhausted = maxRepeats !== undefined && previous.length + 1 >= Number(maxRepeats) && !passes(section, stored, config);

    // Values against limits, expected answers and allowed choices.
    const exceptions: ExceptionDraft[] = [];
    const where = `${def.title}, ${section.title}`;
    for (const f of section.fields) {
      if (!shown(f, entry)) continue;
      const item = `${view.phase.id}.${f.id}`;
      const v = f.type === 'CALC' ? computed[f.id]?.value : data[f.id];
      if (v === undefined) continue;
      const loopEndpoint = section.repeat?.kind === 'UNTIL_PASS' && section.repeat.untilField === f.id;
      if (loopEndpoint && (!exhausted || f.type === 'YES_NO')) continue;
      if ((f.type === 'NUMBER' || f.type === 'WEIGHING' || f.type === 'CALC') && f.limitSlot !== undefined) {
        const d = breach(config.limits?.[f.limitSlot], text(v), f.unit, `${where}: ${f.label}`, item);
        if (d) exceptions.push(d);
      } else if (f.type === 'YES_NO' && f.expected !== undefined && v !== f.expected) {
        exceptions.push({ type: 'LIB_UNEXPECTED_ANSWER', title: `${where}: ${f.label} was answered ${v ? 'yes' : 'no'}; ${f.expected ? 'yes' : 'no'} is expected`, controls: ['PR-29'], severity: 'ACTION', category: 'OUT_OF_LIMIT', item, blocks: 'STEP', until: 'DEVIATION', deviationRequired: true });
      } else if (f.type === 'CHOICE' && (f.notAllowed ?? []).includes(text(v))) {
        exceptions.push({ type: 'LIB_NOT_ALLOWED_CHOICE', title: `${where}: ${f.label} is "${text(v)}", which is not allowed`, controls: ['PR-29'], severity: 'ACTION', category: 'OUT_OF_LIMIT', item, blocks: 'STEP', until: 'DEVIATION', deviationRequired: true });
      } else if (f.type === 'TEST_RESULT') {
        const unitOf = (st: TestStatistic): string => (st === 'RSD' ? '%' : f.unit);
        // R3-ENG-2: every value of a statistic is judged; one exception per statistic, that of the most severe tier any
        // value breaches (the first value at that tier), as the engine judges a series (its worst reading governs).
        const judge = (readings: string[], spec: (st: TestStatistic, slot: string) => LimitSpec | undefined, label: string): void => {
          for (const { statistic: st, limitSlot } of f.statistics) {
            let worst: ExceptionDraft | undefined;
            for (const value of statistic(st, readings)) {
              const d = breach(spec(st, limitSlot), value, unitOf(st), `${where}: ${f.label}${label} (${st.toLowerCase()})`, item);
              if (d && (worst === undefined || SEVERITY_RANK[d.severity] > SEVERITY_RANK[worst.severity])) worst = d;
            }
            if (worst) exceptions.push(worst);
          }
        };
        if (f.perPoint === true) for (const p of config.points?.[f.id] ?? []) judge((v as Record<string, string[]>)[p.id] ?? [], () => p.limits, ` at ${p.label}`);
        else judge(v as string[], (_st, slot) => config.limits?.[slot], '');
      }
    }
    // An exhausted loop has the consequences of an MBR loop's LOOP_EXHAUSTED (recipe-core advance.ts): the steps after it
    // wait for QA's disposition, a deviation is required, and release is blocked.
    if (exhausted && r.kind === 'UNTIL_PASS') {
      exceptions.push({
        type: 'LIB_REPEAT_LIMIT_REACHED',
        title: `${where}: the maximum of ${maxRepeats ?? ''} repeats was reached without a passing value; QA must disposition it before the steps after it run`,
        controls: ['PR-08', 'INV-20'],
        severity: 'ACTION',
        category: 'OUT_OF_LIMIT',
        item: `${view.phase.id}.${r.untilField}`,
        blocks: 'DOWNSTREAM',
        until: 'DISPOSITION',
        qaOnly: true,
        deviationRequired: true,
        releaseBlocking: true,
      });
    }

    // IPC rounds: a round recorded later than the interval after the previous one, the first round after the step's start
    // (R3-ENG-4; the end of the step after the last round is held at PERFORMED, onPerform). Only a PER_INTERVAL section has one.
    const missed = intervalMissed(view, section, `check ${previous.length + 1} came later than`);
    if (missed) exceptions.push(missed);
    return { ok: true, data: stored, exceptions, ...(manualWeighing ? { verificationRequired: true } : {}) };
  };

  const acceptTimer = (view: HandlerView, kind: string, entry: Readonly<Record<string, unknown>>): EntryResult => {
    const field = String(entry['field']);
    const started = view.entries(TIMER_START).some((e) => e.data['field'] === field);
    const stopped = view.entries(TIMER_STOP).some((e) => e.data['field'] === field);
    if (kind === TIMER_START && started) return { ok: false, problems: [problem('LIB-TIMER-STARTED', `The timer ${field} is already started`, ['PR-30'])] };
    if (kind === TIMER_STOP && !started) return { ok: false, problems: [problem('LIB-TIMER-NOT-STARTED', `The timer ${field} is not started`, ['PR-30'])] };
    if (kind === TIMER_STOP && stopped) return { ok: false, problems: [problem('LIB-TIMER-STOPPED', `The timer ${field} is already stopped`, ['PR-30'])] };
    if (kind === TIMER_START) return { ok: true, data: { field } };
    const f = fieldsById.get(field)?.field;
    const start = view.entries(TIMER_START).find((e) => e.data['field'] === field);
    if (!f || f.type !== 'TIMER' || !start) return { ok: true, data: { field } };
    const unit = f.durationUnit ?? 'min';
    const seconds = Dec.parse((view.nowUs - start.recordedAt).toString()).div(Dec.parse('1000000'));
    // The length of one `unit` in seconds converts exactly (min, h, d); the duration is the division in decimals, so a
    // duration that is no whole number of the unit (64 min in h) is still that duration, never seconds under another name.
    const perUnit = expr.convert('1', unit, 's');
    if (perUnit === undefined) return { ok: false, problems: [problem('LIB-TIMER-UNIT', `The timer ${field} is in ${unit}, which is not a time`, ['PR-30'])] };
    const d = seconds.div(Dec.parse(perUnit)).toString();
    const found = f.limitSlot !== undefined ? breach(configOf(view).limits?.[f.limitSlot], d, unit, `${def.title}: ${f.label}`, `${view.phase.id}.${f.id}`) : undefined;
    // S11a finding: the duration is recorded and compared exactly (the limit check rounds it at the limit's decimals);
    // the exception's text shows it to three decimals of its unit, not the full quotient (0.58333333333333333333 min).
    const shown = Dec.parse(d).roundToDecimals(3, 'HALF_UP').toString();
    const draft = found && shown !== d ? { ...found, title: found.title.replace(`${d} ${unit}`, `${shown} ${unit}`) } : found;
    return { ok: true, data: { field, duration: { value: d, unit } }, ...(draft ? { exceptions: [draft] } : {}) };
  };

  return {
    type,
    version: String(def.version),
    title: def.title,
    edition: 'generic',
    aliases: {},
    level: 'PHASE',
    controls: ['PR-03', 'PR-08', 'PR-29', 'DI-33'],
    configSchema: CONFIG_SCHEMA,
    dataSchema: { entries },
    // S5: the plain sentence of each entry, for the step screens, the review and the printed record.
    entrySummaries: entrySummariesOf(def),
    readableValues,
    readValue: (recorded, field) => {
      const at = readable.get(field);
      if (!at) return undefined;
      const last = recorded.filter((e) => e.kind === at.section).at(-1);
      if (!last) return undefined;
      const raw = at.calc ? (last.data['computed'] as Record<string, { value?: unknown }> | undefined)?.[field]?.value : last.data[field];
      const v = typeof raw === 'object' && raw !== null && 'value' in raw ? raw.value : raw;
      return typeof v === 'string' && v !== '' ? { value: v, unit: at.unit, entryId: last.id } : undefined;
    },
    stepReads: (config) =>
      (def.inputs ?? []).flatMap((i) => {
        if (i.kind !== 'STEP_VALUE') return [];
        const sv = (config as unknown as Config).stepValues?.[i.slot];
        return sv ? [{ input: i.id, step: sv.step, field: sv.field, unit: i.unit }] : [];
      }),
    checkConfig: (_phase, config, mbr) =>
      checkBlockUse(def, { block: { code: def.code, version: def.version, ...(typeof config['hash'] === 'string' ? { hash: config['hash'] } : {}) }, ...(config as unknown as Config) }, expr, mbr.bom).map((p) => ({
        code: p.code,
        severity: p.severity,
        message: `${p.path}: ${p.message}`,
        controls: p.controls,
      })),
    handler: {
      acceptEntry: (view, entry) => {
        if (entry.kind === TIMER_START || entry.kind === TIMER_STOP) return acceptTimer(view, entry.kind, entry);
        const section = sections.get(entry.kind);
        if (!section) return { ok: false, problems: [problem('LIB-ENTRY-KIND', `${def.title} has no section ${entry.kind}`)] };
        const fields = Object.fromEntries(Object.entries(entry).filter(([k]) => k !== 'kind'));
        return acceptSection(view, section, fields);
      },
      // R3-ENG-4: the step's end is held to each IPC interval too (after its last round, or its start without one).
      onPerform: (view) => ({
        exceptions: def.sections.flatMap((s) => intervalMissed(view, s, 'the step ended later after its last check than') ?? []),
      }),
      beforePerform: (view) => {
        const config = configOf(view);
        const out: HandlerProblem[] = [];
        for (const s of def.sections) {
          const n = view.entries(s.id).length;
          const r = s.repeat ?? { kind: 'ONCE' as const };
          if (r.kind === 'COUNT') {
            const want = Number(config.counts?.[r.countSlot] ?? '1');
            if (n < want) out.push(problem('LIB-PERFORM-SECTION', `${s.title} is recorded ${n} of ${want} times`));
          } else if (n === 0) out.push(problem('LIB-PERFORM-SECTION', `${s.title} is not recorded yet`));
          if (r.kind === 'UNTIL_PASS' && n > 0) {
            const last = view.entries(s.id)[n - 1];
            const max = r.maxRepeatsSlot !== undefined ? config.counts?.[r.maxRepeatsSlot] : undefined;
            const atMax = max !== undefined && n >= Number(max);
            if (last && !passes(s, last.data, config) && !atMax) out.push(problem('LIB-PERFORM-NOT-PASSED', `${s.title} has not passed yet; repeat it`, ['INV-20']));
          }
        }
        for (const t of timers) {
          if (t.type !== 'TIMER' || t.required === false) continue;
          if (!view.entries(TIMER_STOP).some((e) => e.data['field'] === t.id)) out.push(problem('LIB-PERFORM-TIMER', `The timer ${t.label} is not stopped`, ['PR-30']));
        }
        return out;
      },
    },
    exceptionRules: LIBRARY_EXCEPTION_RULES,
    simulatorModel: {
      exceptionTypes: () => LIBRARY_EXCEPTION_RULES.map((r) => r.type),
      nominalEntries: ({ config, mbr }) => nominalEntries(def, config, mbr),
    },
    tests: ['packages/recipe-core/test/library/block-version.test.ts'],
  };
}

/** One recorded value as people read it: the label, the value and its unit; a calculated value says so. */
function valueText(f: FieldDef, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  switch (f.type) {
    case 'YES_NO':
      return `${f.label}: ${v === true ? 'yes' : 'no'}`;
    case 'NUMBER':
    case 'WEIGHING':
      return `${f.label} ${text(v)} ${f.unit}`;
    case 'CALC':
      return `${f.label} ${text((v as { value?: unknown }).value)} ${f.unit} (calculated)`;
    case 'TEST_RESULT':
      if (Array.isArray(v)) return `${f.label}: ${v.map(text).join(', ')} ${f.unit}`;
      return `${f.label}: ${Object.entries(v as Record<string, unknown[]>).map(([p, rs]) => `${p} ${rs.map(text).join(', ')}`).join('; ')} ${f.unit}`;
    case 'SAMPLE':
      return `${f.label}: ${text(v)} units`;
    default:
      return `${f.label}: ${text(v)}`;
  }
}

/** The sentences of a definition's entry kinds (sections and timers), from the stored data. */
export function entrySummariesOf(def: BlockDefinition): Record<string, (data: Readonly<Record<string, unknown>>) => string> {
  const out: Record<string, (data: Readonly<Record<string, unknown>>) => string> = {};
  for (const s of def.sections) {
    out[s.id] = (d) => {
      const computed = (d['computed'] ?? {}) as Record<string, unknown>;
      const parts = s.fields.flatMap((f) => {
        const t = valueText(f, f.type === 'CALC' ? computed[f.id] : d[f.id]);
        return t === undefined ? [] : [t];
      });
      return `${s.title}: ${parts.length > 0 ? parts.join('; ') : 'recorded'}`;
    };
  }
  const label = (d: Readonly<Record<string, unknown>>): string => def.sections.flatMap((s) => s.fields).find((f) => f.id === d['field'])?.label ?? text(d['field']);
  out[TIMER_START] = (d) => `${label(d)} started`;
  out[TIMER_STOP] = (d) => {
    const dur = d['duration'] as { value?: unknown; unit?: unknown } | undefined;
    return `${label(d)} stopped${dur ? ` after ${text(dur.value)} ${text(dur.unit)}` : ''}`;
  };
  return out;
}

/** A value inside a limit: the target, else the middle of the innermost range, else its one bound. */
function nominalValue(spec: LimitSpec | undefined, target: string | undefined): string {
  if (target !== undefined) return target;
  const r = spec ? (['ALERT', 'INTERNAL_ACTION', 'REGISTERED', 'VALIDATED'] as const).map((t) => spec.ranges.find((x) => x.tier === t)).find((x) => x !== undefined) : undefined;
  if (!r) return '1';
  if (r.low && r.high) return midpointDecimal(r.low.value, r.high.value);
  const one = r.low ?? r.high;
  if (!one) return '1';
  if (one.inclusive) return one.value;
  return r.low ? Dec.parse(one.value).plus(Dec.parse('1')).toString() : Dec.parse(one.value).minus(Dec.parse('1')).toString();
}

/** The entries a nominal execution records: every section once (or its count), values inside their limits. */
export function nominalEntries(def: BlockDefinition, rawConfig: Readonly<Record<string, JsonValue>>, mbr?: Pick<MbrContent, 'bom'>): (Record<string, unknown> & { kind: string })[] {
  const config = rawConfig as unknown as Config;
  const out: (Record<string, unknown> & { kind: string })[] = [];
  const timers = def.sections.flatMap((s) => s.fields).filter((f) => f.type === 'TIMER');
  for (const t of timers) out.push({ kind: TIMER_START, field: t.id });
  for (const s of def.sections) {
    const times = s.repeat?.kind === 'COUNT' ? Number(config.counts?.[s.repeat.countSlot] ?? '1') : 1;
    for (let i = 0; i < times; i++) {
      const e: Record<string, unknown> & { kind: string } = { kind: s.id };
      for (const f of s.fields) {
        if (!shown(f, e)) continue;
        const target = 'limitSlot' in f && f.limitSlot !== undefined ? config.targets?.[f.limitSlot] : undefined;
        const spec = 'limitSlot' in f && f.limitSlot !== undefined ? config.limits?.[f.limitSlot] : undefined;
        switch (f.type) {
          case 'NUMBER':
          case 'WEIGHING':
            e[f.id] = nominalValue(spec, target);
            break;
          case 'TEXT':
            if (f.pattern === undefined || f.required !== false) e[f.id] = 'SIM-1';
            break;
          case 'YES_NO':
            e[f.id] = f.expected ?? false;
            break;
          case 'CHOICE':
            e[f.id] = f.options.find((o) => !(f.notAllowed ?? []).includes(o)) ?? f.options[0];
            break;
          case 'DATE_TIME':
            e[f.id] = '2026-01-01';
            break;
          case 'MATERIAL_LOT': {
            // The facts the server would read: a released lot of the line's material (S6).
            e[f.id] = `SIM-${f.id.toUpperCase()}`;
            const line = f.bomLineSlot !== undefined ? config.bomLines?.[f.bomLineSlot] : undefined;
            const material = (line !== undefined ? mbr?.bom.find((b) => b.id === line)?.material : undefined) ?? 'SIM-MATERIAL';
            e['lots'] = { ...((e['lots']) ?? {}), [f.id]: { id: e[f.id], material, status: 'RELEASED', identityTested: true } };
            break;
          }
          case 'EQUIPMENT':
            e[f.id] = `SIM-${f.id.toUpperCase()}`;
            e['equipment'] = { ...((e['equipment']) ?? {}), [f.id]: { code: e[f.id], classCode: config.equipmentClasses?.[f.classSlot] ?? 'SIM', fitness: 'QUALIFIED' } };
            break;
          case 'CONTAINER':
            e[f.id] = `SIM-${f.id.toUpperCase()}`;
            break;
          case 'SAMPLE':
            e[f.id] = Number(config.counts?.[f.unitsSlot] ?? '1');
            break;
          case 'TEST_RESULT': {
            const n = Number(config.counts?.[f.replicatesSlot] ?? '1');
            if (f.perPoint === true) {
              e[f.id] = Object.fromEntries((config.points?.[f.id] ?? []).map((p) => [p.id, Array.from({ length: n }, () => nominalValue(p.limits, undefined))]));
            } else {
              const slot = f.statistics.find((st) => st.statistic !== 'RSD')?.limitSlot;
              e[f.id] = Array.from({ length: n }, () => nominalValue(slot !== undefined ? config.limits?.[slot] : undefined, undefined));
            }
            break;
          }
          default:
            break;
        }
      }
      out.push(e);
    }
  }
  for (const t of timers) out.push({ kind: TIMER_STOP, field: t.id });
  return out;
}
