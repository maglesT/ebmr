/**
 * G-06@1 Automated equipment phase / Level-2 data exchange (outline 6.6; tablets spec K-06, injectables KB-03;
 * Phase 3 slice 3a). Controls PR-14, DI-04, DI-31, DI-32, DI-49.
 *
 * The phase runs on automated equipment (a tablet press, a coater) behind the site gateway. Its configuration is part of
 * the approved MBR: the setpoints the equipment must hold (downloaded by the server and read back by the gateway), the
 * actual values it collects with their acceptance limits, the alarm tags that are GMP-critical, the age after which a
 * value is stale, and whether the MBR allows a manual fallback.
 *
 * Entries (each value with its provenance: EQUIPMENT, a process reading the server received from the gateway, named by its
 * reading id and the database time it was received; or MANUAL, keyed by a person under the MBR's fallback path):
 *   SETPOINT_READBACK  the setpoint as the equipment reports it holds it; compared with the MBR's setpoint (its
 *                      tolerance, default exact): a mismatch raises SETPOINT_MISMATCH, which stops the step and the
 *                      steps after it until QA decides.
 *   ACTUAL             a measured value of a collected tag, checked against its acceptance limits
 *                      (PROCESS_VALUE_OUT_OF_LIMITS: the steps after it wait for a deviation).
 *   ALARM              an alarm the equipment raised; one on a GMP-critical tag raises GMP_CRITICAL_ALARM (review item,
 *                      DI-49). Every alarm is acknowledged before the step is signed performed.
 *   ALARM_ACK          a person's acknowledgement of an ALARM entry of the step; a GMP-critical alarm needs a comment.
 *   INTERFACE_LOSS     the link to the equipment was lost: INTERFACE_LOSS exception, and the step needs a second
 *                      person (PR-14: automation unavailable escalates to two-person mode).
 *   RECIPE_CHECK       the recipe and recipe version the equipment runs, compared with the MBR's (phase.system):
 *                      a mismatch raises RECIPE_MISMATCH (blocks until QA decides).
 * A EQUIPMENT value is usable only with quality GOOD and received at most maxAgeSeconds (default 60) before it is recorded
 * (database time); otherwise PROCESS_DATA_UNUSABLE is raised and the value does not satisfy the step. A MANUAL value is
 * refused unless the MBR allows the fallback; allowed, it is flagged (manualFallback), raises PROCESS_MANUAL_FALLBACK
 * and makes the step need a second person (PR-14, DI-30, DI-32).
 *
 * Before PERFORMED (when the phase configures setpoints or actuals): a usable read-back that matches for every
 * setpoint, the recipe checked (when the MBR names one), a usable value for every collected tag; always: every alarm
 * acknowledged. A phase configured with nothing (`config: {}`) records nothing of its own (the earlier fixtures).
 *
 * The database holds the same rules (recipe-core 0520: the entry's data as built here; tablets 0820: a EQUIPMENT value is
 * a process reading of the step's bound device, claimed for the entry in its own command, exactly as received).
 */
import { Dec } from '@ebmr/expr';
import type { JsonValue, PhaseNode } from '../../flow/model.ts';
import type { BlockVersion, ExceptionDraft, HandlerProblem, HandlerView } from '../contract.ts';
import type { FieldSchema, ObjectSchema } from '../schema.ts';
import { micros, problem } from './common.ts';
import * as S from '../summary.ts';

const CONTROLS = ['PR-14', 'DI-04', 'DI-31', 'DI-32', 'DI-49'];
/** Default age after which a device value is stale (seconds, database time). */
export const DEFAULT_MAX_AGE_SECONDS = 60;
const QUALITIES = ['GOOD', 'UNCERTAIN', 'BAD', 'STALE'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TAG: FieldSchema = { type: 'string', pattern: /^[a-z][a-z0-9_]*(\.[a-zA-Z0-9_]+)+$/, description: 'Process tag (e.g. force.main_kN)' };
const UNIT: FieldSchema = { type: 'string', description: 'Engineering unit of the tag' };

export interface SetpointConfig {
  tag: string;
  value: string;
  unit: string;
  tolerance: string;
}
export interface ActualConfig {
  tag: string;
  unit: string;
  min?: string;
  max?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The setpoints a G-06 phase downloads (its configuration). */
export function setpointsOf(config: Readonly<Record<string, unknown>>): SetpointConfig[] {
  const c = config['setpoints'];
  return Array.isArray(c) ? c.filter(isRecord).map((x) => ({ tag: String(x['tag']), value: String(x['value']), unit: String(x['unit']), tolerance: text(x['tolerance']) ?? '0' })) : [];
}

/** The tags a G-06 phase collects (its configuration). */
export function actualsOf(config: Readonly<Record<string, unknown>>): ActualConfig[] {
  const c = config['actuals'];
  return Array.isArray(c)
    ? c.filter(isRecord).map((x) => ({ tag: String(x['tag']), unit: String(x['unit']), ...(text(x['min']) !== undefined ? { min: text(x['min']) as string } : {}), ...(text(x['max']) !== undefined ? { max: text(x['max']) as string } : {}) }))
    : [];
}

export function criticalAlarmTags(config: Readonly<Record<string, unknown>>): string[] {
  const c = config['criticalAlarms'];
  return Array.isArray(c) ? c.map(String) : [];
}

export function maxAgeMicros(config: Readonly<Record<string, unknown>>): bigint {
  const s = config['maxAgeSeconds'];
  return BigInt(typeof s === 'number' && Number.isInteger(s) ? s : DEFAULT_MAX_AGE_SECONDS) * 1_000_000n;
}

/** The phase configures the equipment interface (setpoints or collected values). */
export function interfaceConfigured(config: Readonly<Record<string, unknown>>): boolean {
  return setpointsOf(config).length > 0 || actualsOf(config).length > 0;
}

const VALUE_FIELDS: Record<string, FieldSchema> = {
  tag: TAG,
  value: { type: 'decimal', description: 'Value as decimal text in the tag unit' },
  unit: UNIT,
  source: { type: 'string', enum: ['EQUIPMENT', 'MANUAL'], description: 'EQUIPMENT: a process reading received from the gateway; MANUAL: keyed under the MBR fallback path' },
  readingId: { type: 'string', pattern: UUID, optional: true, serverFilled: true, description: 'The process reading (EQUIPMENT only)' },
  quality: { type: 'string', enum: [...QUALITIES], optional: true, serverFilled: true, description: 'Quality the device reported (EQUIPMENT only)' },
  receivedAtUs: { type: 'string', pattern: /^[0-9]{1,20}$/, optional: true, serverFilled: true, description: 'Database time the server received the reading (EQUIPMENT only)' },
};

function valueEntry(description: string): ObjectSchema {
  return { type: 'object', description, fields: VALUE_FIELDS };
}

interface Provenance {
  ok: boolean;
  problems: HandlerProblem[];
  data: Record<string, unknown>;
  usable: boolean;
  manual: boolean;
}

/** The provenance members of a value entry as stored, whether it is usable, and the refusals (MBR fallback, EQUIPMENT facts). */
function provenance(view: HandlerView, entry: Readonly<Record<string, unknown>>): Provenance {
  const source = String(entry['source']);
  const problems: HandlerProblem[] = [];
  if (source === 'MANUAL') {
    if (view.config['manualFallback'] !== true) {
      problems.push(problem('G06-MANUAL-NOT-ALLOWED', `${view.phase.id} takes its values from the equipment; its MBR allows no manual fallback`, ['DI-32', 'PR-14']));
    }
    if (entry['readingId'] !== undefined || entry['quality'] !== undefined || entry['receivedAtUs'] !== undefined) {
      problems.push(problem('G06-PROVENANCE', 'A value keyed by hand names no device reading, quality or receipt time', ['DI-32']));
    }
    return { ok: problems.length === 0, problems, data: { source: 'MANUAL', manualFallback: true }, usable: true, manual: true };
  }
  const received = micros(entry['receivedAtUs']);
  if (typeof entry['readingId'] !== 'string' || typeof entry['quality'] !== 'string' || received === undefined) {
    problems.push(problem('G06-PROVENANCE', 'A value from the equipment names its process reading, the quality the device reported and when the server received it', ['DI-31', 'DI-32']));
    return { ok: false, problems, data: {}, usable: false, manual: false };
  }
  const age = view.nowUs - received;
  const usable = entry['quality'] === 'GOOD' && age >= 0n && age <= maxAgeMicros(view.config);
  return {
    ok: true,
    problems,
    data: { source: 'EQUIPMENT', readingId: entry['readingId'], quality: entry['quality'], receivedAtUs: entry['receivedAtUs'], manualFallback: false },
    usable,
    manual: false,
  };
}

function unusableDraft(view: HandlerView, kind: string, tag: string, entry: Readonly<Record<string, unknown>>): ExceptionDraft {
  return {
    type: 'PROCESS_DATA_UNUSABLE',
    title: `The ${kind === 'ACTUAL' ? 'value' : 'read-back'} of ${tag} at ${view.stepKey} is stale or not good (quality ${String(entry['quality'])}, received at ${String(entry['receivedAtUs'])}): it does not count for the step`,
    controls: ['DI-31', 'DI-32'],
    severity: 'ALERT',
    category: 'INTERFACE_FALLBACK',
    blocks: 'NONE',
    item: tag,
  };
}

function manualDraft(view: HandlerView, tag: string): ExceptionDraft {
  return {
    type: 'PROCESS_MANUAL_FALLBACK',
    title: `${tag} at ${view.stepKey} was keyed by hand under the MBR's fallback path; the step now needs a second person`,
    controls: ['PR-14', 'DI-32'],
    severity: 'ALERT',
    category: 'MANUAL_ENTRY',
    blocks: 'NONE',
    item: tag,
  };
}

function withinLimits(value: string, a: ActualConfig): boolean {
  const v = Dec.parse(value);
  if (a.min !== undefined && v.lt(Dec.parse(a.min))) return false;
  if (a.max !== undefined && v.gt(Dec.parse(a.max))) return false;
  return true;
}

function setpointMatches(value: string, unit: string, s: SetpointConfig): boolean {
  return unit === s.unit && Dec.parse(value).minus(Dec.parse(s.value)).abs().lte(Dec.parse(s.tolerance));
}

function acceptValue(view: HandlerView, entry: Readonly<Record<string, unknown>> & { readonly kind: string }) {
  const tag = String(entry['tag']);
  const value = String(entry['value']);
  const unit = String(entry['unit']);
  const p = provenance(view, entry);
  const problems = [...p.problems];
  const base = { tag, value, unit };
  const exceptions: ExceptionDraft[] = [];
  let extra: Record<string, unknown> = {};
  if (entry.kind === 'SETPOINT_READBACK') {
    const s = setpointsOf(view.config).find((x) => x.tag === tag);
    if (!s) problems.push(problem('G06-NOT-A-SETPOINT', `${tag} is not a setpoint of ${view.phase.id}`, ['DI-31', 'PR-14']));
    else {
      const matches = setpointMatches(value, unit, s);
      extra = { setpoint: { value: s.value, unit: s.unit }, matches };
      if (!matches) {
        exceptions.push({
          type: 'SETPOINT_MISMATCH',
          title: `${tag} at ${view.stepKey} reads back ${value} ${unit}, not the MBR's ${s.value} ${s.unit} (tolerance ${s.tolerance}): the step and the steps after it stop until QA decides`,
          controls: ['DI-31', 'PR-14'],
          severity: 'ACTION',
          category: 'DEVIATION_OR_OVERRIDE',
          blocks: 'STEP_AND_DOWNSTREAM',
          until: 'DISPOSITION',
          qaOnly: true,
          item: tag,
        });
      }
    }
  } else if (entry.kind === 'ACTUAL') {
    const a = actualsOf(view.config).find((x) => x.tag === tag);
    if (!a) problems.push(problem('G06-NOT-COLLECTED', `${tag} is not a value ${view.phase.id} collects`, ['DI-31']));
    else if (a.unit !== unit) problems.push(problem('G06-UNIT', `${tag} is collected in ${a.unit}, not ${unit}`, ['DI-31']));
    else {
      const ok = withinLimits(value, a);
      extra = { withinLimits: ok };
      if (!ok) {
        exceptions.push({
          type: 'PROCESS_VALUE_OUT_OF_LIMITS',
          title: `${tag} at ${view.stepKey} is ${value} ${unit}, outside its acceptance limits (${a.min ?? '-'} to ${a.max ?? '-'}): the steps after it wait for a deviation`,
          controls: ['DI-31', 'PR-14'],
          severity: 'ACTION',
          category: 'OUT_OF_LIMIT',
          blocks: 'DOWNSTREAM',
          until: 'DEVIATION',
          deviationRequired: true,
          item: tag,
        });
      }
    }
  } else {
    const critical = criticalAlarmTags(view.config).includes(tag);
    extra = { critical };
    if (critical) {
      exceptions.push({
        type: 'GMP_CRITICAL_ALARM',
        title: `GMP-critical alarm on ${tag} at ${view.stepKey} (${value} ${unit}): it is acknowledged with a comment and reviewed`,
        controls: ['DI-49'],
        severity: 'ALERT',
        category: 'DEVIATION_OR_OVERRIDE',
        blocks: 'NONE',
        item: tag,
      });
    }
  }
  if (problems.length > 0) return { ok: false as const, problems };
  if (!p.usable && entry.kind !== 'ALARM') exceptions.push(unusableDraft(view, entry.kind, tag, entry));
  if (p.manual) exceptions.push(manualDraft(view, tag));
  const usable = entry.kind === 'ALARM' ? {} : { usable: p.usable };
  return {
    ok: true as const,
    data: { ...base, ...p.data, ...extra, ...usable, recordedBy: view.actor.id },
    ...(p.manual ? { verificationRequired: true } : {}),
    ...(exceptions.length > 0 ? { exceptions } : {}),
  };
}

/** The ALARM entries of the step not yet acknowledged. */
function unacknowledged(view: HandlerView): string[] {
  const acked = new Set(view.entries('ALARM_ACK').map((e) => String(e.data['alarm'])));
  return view.entries('ALARM').map((e) => e.id).filter((id) => !acked.has(id));
}

const usableOf = (view: HandlerView, kind: string, tag: string, also: (d: Record<string, unknown>) => boolean = () => true): boolean =>
  view.entries(kind).some((e) => e.data['tag'] === tag && e.data['usable'] === true && also(e.data));

function configProblems(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>) {
  const out: { code: string; severity: 'ERROR'; message: string; controls: string[] }[] = [];
  const dup = (tags: string[]) => [...new Set(tags.filter((t, i) => tags.indexOf(t) !== i))];
  const s = dup(setpointsOf(config).map((x) => x.tag));
  if (s.length > 0) out.push({ code: 'G06-DUPLICATE-TAG', severity: 'ERROR', message: `Automated step ${phase.id} lists setpoint ${s.join(', ')} twice`, controls: ['DI-31'] });
  const a = dup(actualsOf(config).map((x) => x.tag));
  if (a.length > 0) out.push({ code: 'G06-DUPLICATE-TAG', severity: 'ERROR', message: `Automated step ${phase.id} collects ${a.join(', ')} twice`, controls: ['DI-31'] });
  for (const x of actualsOf(config)) {
    if (x.min !== undefined && x.max !== undefined && Dec.parse(x.min).gt(Dec.parse(x.max))) {
      out.push({ code: 'G06-LIMITS', severity: 'ERROR', message: `Automated step ${phase.id}: the limits of ${x.tag} run from ${x.min} to ${x.max}`, controls: ['DI-31'] });
    }
  }
  if (interfaceConfigured(config) && !phase.system?.recipe) {
    out.push({ code: 'G06-NO-RECIPE', severity: 'ERROR', message: `Automated step ${phase.id} names no equipment recipe and version to check against`, controls: ['DI-04', 'PR-14'] });
  }
  return out;
}

export const G06: BlockVersion = {
  type: 'G-06',
  version: '1',
  title: 'Automated equipment phase',
  edition: 'generic',
  aliases: { tablets: 'K-06', injectables: 'KB-03' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'Setpoints downloaded and read back, values collected with their limits, GMP-critical alarm tags, stale age and the manual fallback path',
    fields: {
      setpoints: {
        type: 'array',
        optional: true,
        minItems: 1,
        maxItems: 40,
        description: 'Approved setpoints the server downloads and the equipment reads back',
        items: {
          type: 'object',
          description: 'One setpoint',
          fields: { tag: TAG, value: { type: 'decimal', description: 'Setpoint' }, unit: UNIT, tolerance: { type: 'decimal', min: '0', optional: true, description: 'Allowed read-back difference (default exact)' } },
        },
      },
      actuals: {
        type: 'array',
        optional: true,
        minItems: 1,
        maxItems: 40,
        description: 'Values collected from the equipment, with their acceptance limits',
        items: {
          type: 'object',
          description: 'One collected tag',
          fields: { tag: TAG, unit: UNIT, min: { type: 'decimal', optional: true, description: 'Lowest acceptable value' }, max: { type: 'decimal', optional: true, description: 'Highest acceptable value' } },
        },
      },
      criticalAlarms: { type: 'array', optional: true, minItems: 1, maxItems: 40, description: 'Tags whose alarms are GMP-critical (acknowledged with a comment)', items: TAG },
      maxAgeSeconds: { type: 'integer', min: 1, max: 86400, optional: true, description: `Age after which a device value is stale (default ${DEFAULT_MAX_AGE_SECONDS} s, database time)` },
      manualFallback: { type: 'boolean', optional: true, default: false, description: 'The MBR allows values to be keyed by hand when the interface is unavailable (flagged, two persons)' },
    },
  },
  entrySummaries: {
    SETPOINT_READBACK: (d) =>
      `Setpoint ${S.val(d['tag'])} read back as ${S.amount(d['value'], d['unit'])}${S.str(S.rec(d['setpoint'])['value']) !== '' ? ` (setpoint ${S.qty(d['setpoint'])})` : ''}${S.str(d['matches']) !== '' ? `, ${S.inRange(d['matches'], 'matches', 'does not match')}` : ''}${valueFlags(d)}`,
    ACTUAL: (d) => `${S.val(d['tag'])}: ${S.amount(d['value'], d['unit'])}${S.str(d['withinLimits']) !== '' ? `, ${S.inRange(d['withinLimits'], 'within limits', 'outside limits')}` : ''}${valueFlags(d)}`,
    ALARM: (d) => `Alarm on ${S.val(d['tag'])} at ${S.amount(d['value'], d['unit'])}${d['critical'] === true ? ', GMP-critical' : ''}${valueFlags(d)}`,
    ALARM_ACK: (d) => `Alarm acknowledged${S.str(d['comment']) !== '' ? `: ${S.str(d['comment'])}` : ''}`,
    INTERFACE_LOSS: (d) => `Link to the equipment lost: ${S.val(d['reason'])}`,
    RECIPE_CHECK: (d) => `Recipe ${S.val(d['recipe'])} v${S.val(d['recipeVersion'])} ${d['matches'] === false ? "does not match the master's" : 'matches'}`,
  },
  dataSchema: {
    entries: {
      SETPOINT_READBACK: valueEntry('A setpoint as the equipment reports it holds it'),
      ACTUAL: valueEntry('A value collected from the equipment'),
      ALARM: valueEntry('An alarm the equipment raised, with the value of its tag then'),
      ALARM_ACK: {
        type: 'object',
        description: 'A person acknowledges an alarm of the step',
        fields: { alarm: { type: 'string', description: 'Entry id of the ALARM' }, comment: { type: 'string', optional: true, description: 'Comment and action taken (required for a GMP-critical alarm)' } },
      },
      INTERFACE_LOSS: { type: 'object', description: 'The link to the equipment was lost', fields: { reason: { type: 'string', description: 'What was observed' } } },
      RECIPE_CHECK: {
        type: 'object',
        description: 'The recipe and version the equipment runs',
        fields: { recipe: { type: 'string', description: 'Recipe the equipment runs' }, recipeVersion: { type: 'string', description: 'Its version' } },
      },
    },
  },
  checkConfig: configProblems,
  handler: {
    acceptEntry: (view, entry) => {
      switch (entry.kind) {
        case 'SETPOINT_READBACK':
        case 'ACTUAL':
        case 'ALARM':
          return acceptValue(view, entry);
        case 'ALARM_ACK': {
          const id = String(entry['alarm']);
          const alarm = view.entries('ALARM').find((e) => e.id === id);
          if (!alarm) return { ok: false, problems: [problem('G06-ACK-UNKNOWN', `${id} is not an alarm of ${view.stepKey}`, ['DI-49'])] };
          if (view.entries('ALARM_ACK').some((e) => e.data['alarm'] === id)) return { ok: false, problems: [problem('G06-ACK-TWICE', `Alarm ${id} is already acknowledged`, ['DI-49'])] };
          const comment = typeof entry['comment'] === 'string' ? entry['comment'] : undefined;
          if (alarm.data['critical'] === true && (comment === undefined || comment.trim() === '')) {
            return { ok: false, problems: [problem('G06-ACK-COMMENT', `Alarm ${id} on ${String(alarm.data['tag'])} is GMP-critical: its acknowledgement needs a comment and the action taken`, ['DI-49'])] };
          }
          return { ok: true, data: { alarm: id, ...(comment !== undefined ? { comment } : {}), acknowledgedBy: view.actor.id } };
        }
        case 'INTERFACE_LOSS':
          return {
            ok: true,
            data: { reason: entry['reason'], recordedBy: view.actor.id },
            verificationRequired: true,
            exceptions: [
              {
                type: 'INTERFACE_LOSS',
                title: `The link to the equipment of ${view.stepKey} was lost (${String(entry['reason'])}): the step needs a second person`,
                controls: ['DI-31', 'PR-14'],
                severity: 'ALERT',
                category: 'INTERFACE_FALLBACK',
                blocks: 'NONE',
              },
            ],
          };
        case 'RECIPE_CHECK': {
          const sys = view.phase.system;
          if (!sys?.recipe) return { ok: false, problems: [problem('G06-NO-RECIPE', `${view.phase.id} names no equipment recipe to check against`, ['DI-04'])] };
          const matches = entry['recipe'] === sys.recipe && entry['recipeVersion'] === sys.recipeVersion;
          return {
            ok: true,
            data: { recipe: entry['recipe'], recipeVersion: entry['recipeVersion'], matches, checkedBy: view.actor.id },
            ...(matches
              ? {}
              : {
                  exceptions: [
                    {
                      type: 'RECIPE_MISMATCH',
                      title: `The equipment of ${view.stepKey} runs recipe ${String(entry['recipe'])} version ${String(entry['recipeVersion'])}, not the MBR's ${sys.recipe} version ${sys.recipeVersion ?? '-'}: the step and the steps after it stop until QA decides`,
                      controls: ['DI-04', 'PR-14'],
                      severity: 'ACTION',
                      category: 'DEVIATION_OR_OVERRIDE',
                      blocks: 'STEP_AND_DOWNSTREAM',
                      until: 'DISPOSITION',
                      qaOnly: true,
                    } satisfies ExceptionDraft,
                  ],
                }),
          };
        }
        default:
          return { ok: false, problems: [problem('G06-ENTRY', `${entry.kind} is not an entry of an automated step`, ['DI-31'])] };
      }
    },
    beforePerform: (view) => {
      const out: HandlerProblem[] = [];
      const open = unacknowledged(view);
      if (open.length > 0) out.push(problem('G06-ALARM-UNACKNOWLEDGED', `Acknowledge alarm ${open.join(', ')} first`, ['DI-49']));
      if (!interfaceConfigured(view.config)) return out;
      const missing = setpointsOf(view.config).filter((s) => !usableOf(view, 'SETPOINT_READBACK', s.tag, (d) => d['matches'] === true)).map((s) => s.tag);
      if (missing.length > 0) out.push(problem('G06-READBACK-MISSING', `Setpoint ${missing.join(', ')} has no usable read-back equal to the MBR's`, ['DI-31', 'PR-14']));
      if (view.phase.system?.recipe && view.entries('RECIPE_CHECK').length === 0) out.push(problem('G06-RECIPE-UNCHECKED', `Check the recipe the equipment runs first`, ['DI-04', 'PR-14']));
      const values = actualsOf(view.config).filter((a) => !usableOf(view, 'ACTUAL', a.tag)).map((a) => a.tag);
      if (values.length > 0) out.push(problem('G06-ACTUAL-MISSING', `${values.join(', ')} has no usable value yet`, ['DI-31', 'DI-32']));
      return out;
    },
  },
  exceptionRules: [
    { type: 'SETPOINT_MISMATCH', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'A setpoint read back from the equipment is not the MBR setpoint', controls: ['DI-31', 'PR-14'] },
    { type: 'PROCESS_VALUE_OUT_OF_LIMITS', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A collected value outside its acceptance limits', controls: ['DI-31', 'PR-14'] },
    { type: 'PROCESS_DATA_UNUSABLE', category: 'INTERFACE_FALLBACK', severity: 'ALERT', summary: 'A device value that is stale or not of good quality', controls: ['DI-31', 'DI-32'] },
    { type: 'PROCESS_MANUAL_FALLBACK', category: 'MANUAL_ENTRY', severity: 'ALERT', summary: 'A value keyed by hand under the MBR fallback path; two-person mode', controls: ['PR-14', 'DI-32'] },
    { type: 'GMP_CRITICAL_ALARM', category: 'DEVIATION_OR_OVERRIDE', severity: 'ALERT', summary: 'A GMP-critical equipment alarm during the step', controls: ['DI-49'] },
    { type: 'INTERFACE_LOSS', category: 'INTERFACE_FALLBACK', severity: 'ALERT', summary: 'The link to the equipment was lost; two-person mode', controls: ['DI-31', 'PR-14'] },
    { type: 'RECIPE_MISMATCH', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'The equipment runs another recipe or version than the MBR names', controls: ['DI-04', 'PR-14'] },
  ],
  simulatorModel: {
    exceptionTypes: () => ['SETPOINT_MISMATCH', 'PROCESS_VALUE_OUT_OF_LIMITS', 'PROCESS_DATA_UNUSABLE', 'PROCESS_MANUAL_FALLBACK', 'GMP_CRITICAL_ALARM', 'INTERFACE_LOSS', 'RECIPE_MISMATCH'],
    // The nominal path of a configured phase: the recipe as the MBR names it, then each setpoint read back and each
    // collected value from the equipment (GOOD, received now; the gateway simulators of apps/simulators supply them).
    nominalEntries: ({ phase, config, nowUs }) => {
      if (!interfaceConfigured(config)) return [];
      if (nowUs === undefined) return [];
      const id = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
      const device = (i: number) => ({ source: 'EQUIPMENT', readingId: id(i), quality: 'GOOD', receivedAtUs: nowUs.toString() });
      const out: (Record<string, unknown> & { kind: string })[] = [];
      if (phase.system?.recipe) out.push({ kind: 'RECIPE_CHECK', recipe: phase.system.recipe, recipeVersion: phase.system.recipeVersion ?? '' });
      setpointsOf(config).forEach((s, i) => out.push({ kind: 'SETPOINT_READBACK', tag: s.tag, value: s.value, unit: s.unit, ...device(i + 1) }));
      actualsOf(config).forEach((a, i) => out.push({ kind: 'ACTUAL', tag: a.tag, value: a.min ?? a.max ?? '0', unit: a.unit, ...device(100 + i) }));
      return out;
    },
  },
  goldenFixture: {
    description:
      'A press step: the main force setpoint read back equal, the turret speed collected; a GMP-critical force alarm acknowledged with a comment; the link lost and the tablet count keyed by hand under the MBR fallback (flagged, two persons); the recipe checked; performed and verified',
    controls: ['PR-14', 'DI-31', 'DI-32', 'DI-49'],
    phase: {
      block: { type: 'G-06', version: '1' },
      config: {
        setpoints: [{ tag: 'force.main_kN', value: '12.50', unit: 'kN', tolerance: '0.05' }],
        actuals: [
          { tag: 'turret.speed_rpm', unit: 'rpm', min: '20.0', max: '60.0' },
          { tag: 'tablet.count', unit: 'count' },
        ],
        criticalAlarms: ['force.main_kN'],
        maxAgeSeconds: 3600,
        manualFallback: true,
      },
      system: { kind: 'PLC', ref: 'SYS-PRS', recipe: 'RCP-COMP', recipeVersion: '5' },
    },
    script: [
      { entry: { kind: 'RECIPE_CHECK', recipe: 'RCP-COMP', recipeVersion: '5' } },
      { entry: { kind: 'SETPOINT_READBACK', tag: 'force.main_kN', value: '12.52', unit: 'kN', source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000001', quality: 'GOOD', receivedAtUs: '1790582400000000' } },
      { entry: { kind: 'ACTUAL', tag: 'turret.speed_rpm', value: '45.0', unit: 'rpm', source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000002', quality: 'GOOD', receivedAtUs: '1790582400000000' } },
      { entry: { kind: 'ALARM', tag: 'force.main_kN', value: '14.10', unit: 'kN', source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000003', quality: 'GOOD', receivedAtUs: '1790582400000000' } },
      { entry: { kind: 'ALARM_ACK', alarm: 'EN-4', comment: 'Force spike on one station; tooling inspected, no defect found' } },
      { entry: { kind: 'INTERFACE_LOSS', reason: 'Gateway link down at the press' } },
      { entry: { kind: 'ACTUAL', tag: 'tablet.count', value: '120000', unit: 'count', source: 'MANUAL' } },
    ],
    expect: { exceptions: ['GMP_CRITICAL_ALARM', 'INTERFACE_LOSS', 'PROCESS_MANUAL_FALLBACK'], status: 'COMPLETED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts', 'packages/recipe-core/test/blocks/automated.test.ts'],
};

export const AUTOMATED_BLOCKS: readonly BlockVersion[] = [G06];

/** What a stored value of the step adds to its sentence: keyed by hand, not counted (stale or not good). */
function valueFlags(d: Readonly<Record<string, unknown>>): string {
  return `${d['source'] === 'MANUAL' ? ', keyed by hand' : ''}${d['usable'] === false ? ', not counted (stale or not good)' : ''}`;
}
