/**
 * Shared pieces of the packaging-line blocks of Phase 3 slice 4b (builder B): TB-23 bottle line and TB-24 secondary and
 * tertiary packaging with the finished-pack examination (tablets spec section B.2).
 *
 * Both run on one plant PROCESS unit of the line (config `unit`), whose output containers the slice 1 container hold
 * reaches (plant.record_ipc_check, tablets 0987): every scheduled check is a stream of that unit, and a failing or missed
 * check holds the containers opened since that stream's last passing check. Their inspection devices (count verifier,
 * checkweigher, desiccant and seal detectors, leaflet detector, vision) are challenged by G-21@1's own challenge rule,
 * called through `viewAs` with the step's devices, never a copy: the same entry data, the same CHALLENGE_FAILED and
 * CHALLENGE_MISSED exceptions that stop the step until QA decides, the same START and END challenges before the step is
 * performed (the database calls recipe.g21_entry_data the same way). Counts are whole-number text compared as bigint;
 * decimals are Dec; instants are epoch microseconds.
 */
import { blocks, flow } from '@ebmr/recipe-core/pure';
import { viewAs } from '../forming/common.ts';
import {
  configError,
  durationUs,
  isRecord,
  problem,
  type ConfigProblem,
  type EntryResult,
  type ExceptionDraft,
  type ExceptionRule,
  type FieldSchema,
  type HandlerProblem,
  type HandlerView,
  type MbrContent,
  type ObjectSchema,
  type PhaseNode,
} from '../granulation/common.ts';

export * from '../granulation/common.ts';
export { viewAs };

/** A plant equipment code as plant.ipc_check holds a unit (recipe-core 0420). */
export const UNIT_CODE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;
/** A device id of the step: short enough that its challenge stream D.<id> fits plant.ipc_check.stream. */
export const DEVICE_ID = /^[A-Z0-9][A-Z0-9_-]{0,15}$/;
export const COUNT = /^(0|[1-9][0-9]{0,17})$/;
export const POSITIVE_COUNT = /^[1-9][0-9]{0,17}$/;
export const countField = (description: string): FieldSchema => ({ type: 'string', pattern: COUNT, description });
export const positiveCountField = (description: string): FieldSchema => ({ type: 'string', pattern: POSITIVE_COUNT, description });

export const INTERVAL: ObjectSchema = {
  type: 'object',
  description: 'An interval: decimal text and a time unit (ms, s, min, h, d)',
  fields: { value: { type: 'decimal', min: '0', minExclusive: true, description: 'Decimal written as text, above zero' }, unit: { type: 'string', enum: ['ms', 's', 'min', 'h', 'd'], description: 'Time unit' } },
};

/** The count of whole-number text (0 when it is not one; the schema has checked it). */
export const big = (v: unknown): bigint => (typeof v === 'string' && COUNT.test(v) ? BigInt(v) : 0n);

/** The challenge stream of device `id` on the line unit. */
export const deviceStream = (id: string): string => `D.${id}`;

// ---------------------------------------------------------------------------------------------
// Inspection devices, challenged by G-21's rule

export function deviceSchema(kinds: readonly string[]): ObjectSchema {
  return {
    type: 'object',
    description: 'An inspection device of the line, challenged with known-bad test units (G-21\'s challenge rule; two persons, no gateway link in 4b)',
    fields: {
      id: { type: 'string', pattern: DEVICE_ID, description: 'Device id within the step' },
      kind: { type: 'string', enum: kinds, description: 'What the device is' },
      every: { ...INTERVAL, optional: true, description: 'Challenge interval' },
      triggers: { type: 'array', items: { type: 'string', enum: blocks.CHALLENGE_TRIGGERS, description: 'Challenge trigger' }, optional: true, description: 'When the device is challenged (default START and END)' },
    },
  };
}

/** G-21's configuration of the step's devices (only `devices`: no printed item, printer or pool). */
export const deviceConfig = (config: Readonly<Record<string, unknown>>): Record<string, unknown> => ({ devices: Array.isArray(config['devices']) ? config['devices'] : [] });

/** The view G-21's challenge rule reads: the same step, entries and person, with the step's devices. */
export const g21View = (view: HandlerView): HandlerView => viewAs(view, 'G-21', deviceConfig(view.config));

/** A CHALLENGE of a device of the step, accepted or refused by G-21@1 itself. */
export function acceptChallenge(view: HandlerView, entry: Readonly<Record<string, unknown>> & { kind: string }): EntryResult {
  return blocks.G21.handler?.acceptEntry?.(g21View(view), entry) ?? { ok: false, problems: [problem('G21-ENTRY', 'G-21 has no handler', ['IN-22'])] };
}

/** G-21's checks before the step is performed, for the devices only (a passing START and END challenge, none due). */
export function challengeProblems(view: HandlerView): HandlerProblem[] {
  return [...(blocks.G21.handler?.beforePerform?.(g21View(view)) ?? [])];
}

/** The devices whose last challenge (by the time G-21 orders them) failed: the line is stopped for them. */
export function stoppedDevices(view: HandlerView): string[] {
  const last = new Map<string, { at: bigint; result: unknown }>();
  for (const e of view.entries('CHALLENGE')) {
    const id = String(e.data['device']);
    const at = e.recordedAt;
    const prev = last.get(id);
    if (!prev || at >= prev.at) last.set(id, { at, result: e.data['result'] });
  }
  return [...last.entries()].filter(([, v]) => v.result !== 'PASS').map(([k]) => k);
}

export const CHALLENGE_RULES: readonly ExceptionRule[] = (blocks.G21.exceptionRules ?? []).filter((r) => r.type === 'CHALLENGE_FAILED' || r.type === 'CHALLENGE_MISSED');

export function deviceConfigProblems(phase: PhaseNode, config: Readonly<Record<string, unknown>>, code: string): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const devices = blocks.lineDevices(config);
  const ids = devices.map((d) => d.id);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length > 0) out.push(configError(code, `${phase.id} names device ${[...new Set(dup)].join(', ')} twice`, ['IN-22']));
  for (const d of devices) {
    if (d.every !== undefined && flow.durationToMicros(d.every.value, d.every.unit) === undefined) out.push(configError(code, `The challenge interval of ${d.id} is not a whole number of microseconds`, ['IN-22']));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Scheduled checks (streams of the line unit)

/** The last check entry of stream `stream` at the step (any of `kinds`), if any. */
export function lastCheck(view: HandlerView, stream: string): { recordedAt: bigint; data: Record<string, unknown> } | undefined {
  let out: { recordedAt: bigint; data: Record<string, unknown>; seq: number } | undefined;
  for (const e of view.entries()) {
    if (e.data['stream'] !== stream || typeof e.data['result'] !== 'string') continue;
    if (!out || e.recordedSeq > out.seq) out = { recordedAt: e.recordedAt, data: e.data, seq: e.recordedSeq };
  }
  return out;
}

/** Whether a check of `stream` now is later than `everyUs` after the stream's previous check. */
export function missedNow(view: HandlerView, stream: string, everyUs: bigint | undefined): boolean {
  const last = lastCheck(view, stream);
  return last !== undefined && everyUs !== undefined && view.nowUs - last.recordedAt > everyUs;
}

/** The exceptions of a check of `stream` at the step: missed (LINE_CHECK_MISSED) and failed (LINE_CHECK_FAILED). */
export function checkExceptions(view: HandlerView, stream: string, what: string, missed: boolean, pass: boolean, controls: string[]): ExceptionDraft[] {
  const out: ExceptionDraft[] = [];
  const held = (type: string, title: string, category: ExceptionDraft['category']): ExceptionDraft => ({
    type, title, controls, severity: 'ACTION', category, blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true, item: stream,
  });
  if (missed) out.push(held('LINE_CHECK_MISSED', `The ${what} of ${view.stepKey} was not done within its interval: the output of the line since the last passing ${what} is held and the steps after it wait for a deviation`, 'DEVIATION_OR_OVERRIDE'));
  if (!pass) out.push(held('LINE_CHECK_FAILED', `A ${what} of ${view.stepKey} failed: the output of the line since the last passing ${what} is held and the steps after it wait for a deviation`, 'OUT_OF_LIMIT'));
  return out;
}

export const CHECK_RULES: readonly ExceptionRule[] = [
  { type: 'LINE_CHECK_FAILED', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A scheduled line check failed; the output since the last passing check of its stream is held', controls: ['PR-37', 'IN-22'] },
  { type: 'LINE_CHECK_MISSED', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'A scheduled line check was not done within its interval; the output since the last passing check is held', controls: ['PR-37', 'IN-22'] },
];

/** The problems of the scheduled streams before the step is performed: each checked, its last check passing, none due. */
export function streamProblems(view: HandlerView, streams: readonly { stream: string; every: bigint | undefined; what: string }[], code: string, controls: string[]): HandlerProblem[] {
  const out: HandlerProblem[] = [];
  for (const s of streams) {
    const last = lastCheck(view, s.stream);
    if (!last) out.push(problem(`${code}-NO-CHECK`, `${view.stepKey} has no ${s.what}`, controls));
    else if (last.data['result'] !== 'PASS') out.push(problem(`${code}-LAST-CHECK`, `The last ${s.what} of ${view.stepKey} failed: a passing one comes after it`, controls));
    else if (s.every !== undefined && view.nowUs - last.recordedAt > s.every) out.push(problem(`${code}-CHECK-DUE`, `${view.stepKey} is due for its ${s.what}`, controls));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The MBR around a line step

/** The phase nodes of block `type` in the MBR. */
export function phasesOf(mbr: MbrContent, type: string): PhaseNode[] {
  const out: PhaseNode[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isRecord(n)) return;
    if (n['kind'] === 'phase' && isRecord(n['block']) && n['block']['type'] === type) out.push(n as unknown as PhaseNode);
    for (const v of Object.values(n)) if (typeof v === 'object' && v !== null) walk(v);
  };
  walk(mbr.procedure);
  return out;
}

/** The G-21 phase `id` of the MBR, if any. */
export const g21Phase = (mbr: MbrContent, id: string | undefined): PhaseNode | undefined => (id === undefined ? undefined : phasesOf(mbr, 'G-21').find((p) => p.id === id));

/** Why the line unit of `phase` is shared with another packaging-line step (G-21, TB-23, TB-24) of the MBR. */
export function sharedUnitProblem(mbr: MbrContent, phase: PhaseNode, unit: string | undefined, code: string): ConfigProblem[] {
  if (unit === undefined) return [configError(code, `${phase.id} names no plant unit of its line`, ['IN-22', 'PR-37'])];
  const other = ['G-21', 'TB-23', 'TB-24'].flatMap((t) => phasesOf(mbr, t)).find((p) => p.id !== phase.id && isRecord(p.config) && p.config['unit'] === unit);
  return other
    ? [configError(code, `${phase.id} and ${other.id} name the same plant unit ${unit}: a passing check of one would vouch for the other's output`, ['IN-22', 'PR-37'])]
    : [];
}

/** The configured interval of member `key` (an INTERVAL) in microseconds. */
export const intervalOf = (v: unknown): bigint | undefined => durationUs(v);

/** Whether the MBR is for US OTC retail packs (header predicate usOtcRetail, PR-41). */
export const usOtcRetail = (mbr: MbrContent): boolean => mbr.header.predicates['usOtcRetail'] === true;

