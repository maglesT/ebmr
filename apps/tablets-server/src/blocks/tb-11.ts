/**
 * TB-11@1 Periodic IPC scheduler with streams and the bracketing hold (tablets spec B.2 TB-11; Phase 3 slice 3c,
 * builder B). Controls PR-07, PR-29, IN-35, DI-28, DI-29.
 *
 * One TB-11 step is one run of the press (or pan, or line): RUN_START names the press (a plant PROCESS unit in use for
 * the batch, checked by the database; a compression run starts only after the first-off approval of that press, a
 * TB-10 step of the batch set up on it and completed, which the database checks: TB11-FIRST-OFF) and RUN_END closes
 * the run. The configuration lists the streams (press sides,
 * layers, tracks; their ids are the streams of the slice 1 output containers) and the test plan every stream follows:
 * each test (WEIGHT: TB-12, PHYSICAL: TB-13, FRIABILITY: TB-14, DISINTEGRATION: TB-15) with its interval by time
 * (`every`), optionally by press count (`everyCount`), and its quality-risk-management reference (PR-07); a grace time;
 * the restart threshold after a stoppage (D: 15 min, allowed 0 to 60); and, for compression, the start-of-run station
 * sweep (every station of every stream, IN-35 (b)) with its optional repeat interval. A compression plan whose most
 * frequent test plus the grace exceeds 30 min is refused when the MBR is defined (IN-35 (c); rule key
 * tablets.compression.ipcSampleMaxInterval, India, HARD; the database refuses the run's start too).
 *
 * The checks themselves are TB-12..TB-15's entries, evaluated by their modules, naming the stream. Due and overdue (at
 * the database time of each entry, never a typed time): a stream's test is due one interval after its last check (or
 * the run's start), at once after a setting or tooling change, at the restart after a stoppage longer than the
 * threshold (a shorter stoppage that covers the due time moves it to the restart), at the end of the run; a running
 * stoppage suspends it. A test not checked within the grace after it fell due is a missed check: the next entry of the
 * step lists it (`missed`), raises IPC_CHECK_MISSED (the steps after it wait for a deviation) and, in the database, the
 * slice 1 container hold records a MISSED check for its stream (plant.record_ipc_check), which holds every container
 * filled since the last passing check (IN-35 (c), PR-29). A check whose press count advanced more than its count
 * interval is missed by count. The hold of a failing check is the same: the database records FAIL for the stream, and
 * PASS for a passing one (the only way a container of the run is vouched for). The station sweep cannot be recorded
 * without a result for every station (IN-35 (b)). The sampling time is a separate field from the entry time, a late
 * entry is flagged (DI-28). The step closes only after RUN_END with an end-of-run check of every stream and test, the
 * sweeps done and no compendial stage pending (INV-41). The database holds all of it (tablets 0892).
 */
import { dec, judge, KP_TO_N, worst, type Verdict } from './ipc/calc.ts';
import {
  commonOf,
  configError,
  DURATION,
  durationUs,
  EQUIPMENT_CODE,
  isRecord,
  LATE_ENTRY,
  POSITIVE_DECIMAL,
  problem,
  refuse,
  secondsText,
  STREAM,
  TEST_EXCEPTION_RULES,
  TEST_EXCEPTION_TYPES,
  TEST_FIELDS,
  text,
  tierProblems,
  tiersOf,
  TIERS,
  type BlockVersion,
  type ConfigProblem,
  type Entry,
  type EntryRecord,
  type EntryResult,
  type ExceptionDraft,
  type HandlerProblem,
  type HandlerView,
  type MbrContent,
  type ObjectSchema,
  type PhaseNode,
} from './ipc/common.ts';
import { acceptSecondStage, acceptWeightCheck, pendingFirstStages, resultOf, WEIGHT_CONFIG, WEIGHT_ENTRIES, weightConfigProblems, weightNominal, type TestOutcome } from './tb-12.ts';
import { acceptPhysicalCheck, PHYSICAL_CONFIG, PHYSICAL_ENTRIES, physicalConfigProblems, physicalNominal } from './tb-13.ts';
import { acceptFriabilityRun, FRIABILITY_CONFIG, FRIABILITY_ENTRIES, friabilityConfigProblems, friabilityNominal, pendingFriability } from './tb-14.ts';
import { acceptDtEnd, acceptDtStart, DT_CONFIG, DT_ENTRIES, dtConfigProblems, dtNominal, dtPending } from './tb-15.ts';

const CONTROLS = ['PR-07', 'PR-29', 'IN-35', 'DI-28', 'DI-29'];

/**
 * The ceiling between compression samples (rule key tablets.compression.ipcSampleMaxInterval of the tablets rule table,
 * India, HARD: Schedule M Part VIII 3.8). The database holds the same row (tablets 0890, tab.ipc_rule).
 */
export const COMPRESSION_SAMPLE_CEILING = { key: 'tablets.compression.ipcSampleMaxInterval', value: '30', unit: 'min', source: 'Schedule M Part VIII 3.8', effectiveFrom: '2023-12-28' } as const;
const CEILING_US = 30n * 60_000_000n;
/** The restart threshold when the MBR gives none (D: 15 min; allowed 0 to 60 min). */
export const DEFAULT_RESTART_US = 15n * 60_000_000n;
const MAX_RESTART_US = 60n * 60_000_000n;

export const TESTS = ['WEIGHT', 'PHYSICAL', 'FRIABILITY', 'DISINTEGRATION'] as const;
export type Test = (typeof TESTS)[number] | 'SWEEP';
const CONFIG_OF: Record<(typeof TESTS)[number], string> = { WEIGHT: 'weight', PHYSICAL: 'physical', FRIABILITY: 'friability', DISINTEGRATION: 'disintegration' };

/** The test a check entry is, when it counts as that test's check for the schedule (first stages and first runs only). */
export function checkTest(e: { kind: string; data: Record<string, unknown> }): Test | undefined {
  switch (e.kind) {
    case 'WEIGHT_CHECK':
      return 'WEIGHT';
    case 'PHYSICAL_CHECK':
      return 'PHYSICAL';
    case 'FRIABILITY_RUN':
      return e.data['repeatOf'] === undefined ? 'FRIABILITY' : undefined;
    case 'DT_START':
      return e.data['retestOf'] === undefined && e.data['stage'] !== 'BUFFER' ? 'DISINTEGRATION' : undefined;
    case 'STATION_SWEEP':
      return 'SWEEP';
    default:
      return undefined;
  }
}

const KIND_TEST: Record<string, (typeof TESTS)[number]> = {
  WEIGHT_CHECK: 'WEIGHT',
  WEIGHT_SECOND_STAGE: 'WEIGHT',
  PHYSICAL_CHECK: 'PHYSICAL',
  FRIABILITY_RUN: 'FRIABILITY',
  DT_START: 'DISINTEGRATION',
  DT_END: 'DISINTEGRATION',
};

interface PlanItem {
  test: (typeof TESTS)[number];
  every: bigint;
  everyCount?: bigint;
}

function planOf(config: Readonly<Record<string, unknown>>): PlanItem[] {
  const plan = Array.isArray(config['plan']) ? (config['plan'] as unknown[]) : [];
  return plan.filter(isRecord).map((p) => ({
    test: p['test'] as (typeof TESTS)[number],
    every: durationUs(p['every']) ?? 0n,
    ...(counterOf(p['everyCount']) !== undefined ? { everyCount: counterOf(p['everyCount']) as bigint } : {}),
  }));
}

const streamsOf = (config: Readonly<Record<string, unknown>>): string[] =>
  (Array.isArray(config['streams']) ? (config['streams'] as unknown[]) : []).filter(isRecord).map((s) => String(s['id']));

const isCompression = (config: Readonly<Record<string, unknown>>): boolean => (config['process'] ?? 'COMPRESSION') === 'COMPRESSION';
const hasSweep = (config: Readonly<Record<string, unknown>>): boolean => isRecord(config['sweep']);

export interface Missed {
  stream: string;
  test: Test;
  by: 'TIME' | 'COUNT';
  dueUs?: string;
}

/** Whether entry `e` (already recorded) marked slot (stream, test) missed. */
const marks = (e: EntryRecord, stream: string, test: Test): boolean =>
  Array.isArray(e.data['missed']) && (e.data['missed'] as Missed[]).some((m) => m.stream === stream && m.test === test);

/**
 * When the slot (stream, test) of the run in `entries` falls due, or undefined when it is not due (a sweep after the
 * first one without a repeat interval; nothing before the run's start); `suspended` while a stoppage runs.
 */
export function dueOf(entries: readonly EntryRecord[], config: Readonly<Record<string, unknown>>, stream: string, test: Test): { dueUs?: bigint; suspended: boolean } {
  const start = entries.find((e) => e.kind === 'RUN_START');
  if (!start) return { suspended: false };
  let base = start.recordedAt;
  let checked = false;
  for (const e of entries) {
    const own = checkTest(e) === test && e.data['stream'] === stream;
    if (own || marks(e, stream, test)) {
      if (e.recordedAt > base) base = e.recordedAt;
      if (own) checked = true;
    }
  }
  let due: bigint | undefined;
  if (test === 'SWEEP') {
    const sweep = config['sweep'];
    const every = isRecord(sweep) ? durationUs(sweep['every']) : undefined;
    due = !checked ? start.recordedAt : every !== undefined ? base + every : undefined;
  } else {
    const p = planOf(config).find((x) => x.test === test);
    if (!p) return { suspended: false };
    due = base + p.every;
  }
  if (due === undefined) return { suspended: false };
  const restart = durationUs(config['restartAfter']) ?? DEFAULT_RESTART_US;
  let stoppedAt: bigint | undefined;
  for (const e of entries) {
    if (e.kind === 'STOPPAGE_START') stoppedAt = e.recordedAt;
    if (e.recordedAt <= base) {
      if (e.kind === 'STOPPAGE_END') stoppedAt = undefined;
      continue;
    }
    if (e.kind === 'CHANGE' && test !== 'SWEEP') due = due < e.recordedAt ? due : e.recordedAt;
    if (e.kind === 'STOPPAGE_END' && stoppedAt !== undefined) {
      const long = e.recordedAt - stoppedAt > restart;
      if (stoppedAt <= due && due <= e.recordedAt) due = e.recordedAt;
      else if (long && test !== 'SWEEP' && due > e.recordedAt) due = e.recordedAt;
      stoppedAt = undefined;
    }
    if (e.kind === 'RUN_END') {
      if (test === 'SWEEP') return due < e.recordedAt ? { dueUs: due, suspended: false } : { suspended: false };
      due = due < e.recordedAt ? due : e.recordedAt;
    }
  }
  return { dueUs: due, suspended: stoppedAt !== undefined && due >= stoppedAt };
}

/** The slots of a run: every stream with every planned test, and the sweep where the run has one. */
export function slotsOf(config: Readonly<Record<string, unknown>>): { stream: string; test: Test }[] {
  const tests: Test[] = [...planOf(config).map((p) => p.test), ...(hasSweep(config) ? (['SWEEP'] as Test[]) : [])];
  return streamsOf(config).flatMap((stream) => tests.map((test) => ({ stream, test })));
}

/** The slots overdue at `nowUs` (missed by time), in stream and test order. */
export function overdue(entries: readonly EntryRecord[], config: Readonly<Record<string, unknown>>, nowUs: bigint): Missed[] {
  const grace = durationUs(config['grace']) ?? 0n;
  const out: Missed[] = [];
  for (const s of slotsOf(config)) {
    const d = dueOf(entries, config, s.stream, s.test);
    if (d.dueUs !== undefined && !d.suspended && nowUs > d.dueUs + grace) out.push({ ...s, by: 'TIME', dueUs: d.dueUs.toString() });
  }
  return out;
}

/**
 * A press counter or count interval as an exact integer (CLAUDE.md: no JavaScript number for GMP values). The schema
 * takes whole numbers within the safe-integer range only (recipe-core blocks/schema.ts), so anything else is no counter.
 */
export function counterOf(v: unknown): bigint | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) ? BigInt(v) : undefined;
}

/** The highest press counter the run has recorded (RUN_START and every check that gave one). */
function lastCounter(entries: readonly EntryRecord[]): bigint | undefined {
  let c: bigint | undefined;
  for (const e of entries) {
    const v = counterOf(e.data['counter']);
    if (v !== undefined && (c === undefined || v > c)) c = v;
  }
  return c;
}

/** The counter of the slot's last check (or the run's start). */
function slotCounter(entries: readonly EntryRecord[], stream: string, test: Test): bigint | undefined {
  const last = [...entries].reverse().find((e) => checkTest(e) === test && e.data['stream'] === stream && counterOf(e.data['counter']) !== undefined);
  return counterOf(last?.data['counter'] ?? entries.find((e) => e.kind === 'RUN_START')?.data['counter']);
}

function missedException(view: HandlerView, missed: readonly Missed[]): ExceptionDraft {
  return {
    type: 'IPC_CHECK_MISSED',
    title: `Missed in-process check at ${view.stepKey}: ${missed.map((m) => `${m.test.toLowerCase()} of stream ${m.stream}${m.by === 'COUNT' ? ' (by press count)' : ''}`).join(', ')}; the output since the last passing check is held and the steps after it wait for a deviation`,
    controls: ['IN-35', 'PR-29'],
    severity: 'ACTION',
    category: 'TIME_LIMIT',
    blocks: 'DOWNSTREAM',
    until: 'DEVIATION',
    deviationRequired: true,
    item: missed[0]?.stream ?? '',
  };
}

const SWEEP_PARAMETERS = ['weight', 'thickness', 'hardness'] as const;

function sweepParams(config: Readonly<Record<string, unknown>>): (typeof SWEEP_PARAMETERS)[number][] {
  const s = config['sweep'];
  return isRecord(s) ? SWEEP_PARAMETERS.filter((p) => isRecord(s[p])) : [];
}

/** A STATION_SWEEP: every station once, every parameter, each against its individual limits. */
function acceptSweep(view: HandlerView, entry: Entry): { ok: true; t: TestOutcome } | { ok: false; problems: HandlerProblem[] } {
  const sweep = view.config['sweep'];
  if (!isRecord(sweep)) return refuse('TB11-NO-SWEEP', `${view.stepKey} has no station sweep in its MBR`, ['IN-35']);
  const n = Number(sweep['stations']);
  const stations = Array.isArray(entry['stations']) ? (entry['stations'] as Record<string, unknown>[]) : [];
  const numbers = stations.map((s) => Number(s['station']));
  const params = sweepParams(view.config);
  if (stations.length !== n || new Set(numbers).size !== n || numbers.some((x) => !Number.isInteger(x) || x < 1 || x > n)) {
    return refuse('TB11-SWEEP-INCOMPLETE', `The station sweep gives each of the ${n} stations exactly one result (${stations.length} given); it cannot be recorded incomplete`, ['IN-35']);
  }
  if (stations.some((s) => SWEEP_PARAMETERS.filter((p) => s[p] !== undefined).join() !== params.join())) {
    return refuse('TB11-SWEEP-PARAMETERS', `Each station gives exactly the parameters the MBR sweeps (${params.join(', ')})`, ['IN-35', 'DI-32']);
  }
  const c = commonOf(view, entry, n * params.length, 'TB11');
  if (!c.ok) return c;
  const evaluation: Record<string, unknown> = {};
  const verdicts: Verdict[] = [];
  for (const p of params) {
    const spec = sweep[p] as Record<string, unknown>;
    const tiers = tiersOf(spec['individual']) ?? { action: {} };
    const vs = stations.map((s) => (p === 'hardness' && spec['unit'] === 'kp' ? dec(String(s[p])).times(dec(KP_TO_N)) : dec(String(s[p]))));
    const vv = vs.map((v) => judge(v, tiers));
    const v = worst(vv);
    verdicts.push(v);
    const min = vs.reduce((a, x) => (x.lt(a) ? x : a));
    const max = vs.reduce((a, x) => (x.gt(a) ? x : a));
    evaluation[p] = { min: min.toString(), max: max.toString(), outside: vv.filter((x) => x === 'FAIL').length, outsideAlert: vv.filter((x) => x !== 'PASS').length, result: v };
  }
  const outcome = worst(verdicts);
  const data = { ...c.common.base, stations: entry['stations'], evaluation, result: outcome };
  return { ok: true, t: { data, outcome, manual: c.common.manual, late: c.common.late, what: 'The station sweep' } };
}

function acceptTest(view: HandlerView, entry: Entry): { ok: true; t: TestOutcome } | { ok: false; problems: HandlerProblem[] } {
  switch (entry.kind) {
    case 'WEIGHT_CHECK':
      return acceptWeightCheck(view, entry);
    case 'WEIGHT_SECOND_STAGE':
      return acceptSecondStage(view, entry);
    case 'PHYSICAL_CHECK':
      return acceptPhysicalCheck(view, entry);
    case 'FRIABILITY_RUN':
      return acceptFriabilityRun(view, entry);
    case 'DT_START':
      return acceptDtStart(view, entry);
    case 'DT_END':
      return acceptDtEnd(view, entry);
    default:
      return acceptSweep(view, entry);
  }
}

function accept(view: HandlerView, entry: Entry): EntryResult {
  const entries = view.entries();
  const started = entries.some((e) => e.kind === 'RUN_START');
  const ended = entries.some((e) => e.kind === 'RUN_END');
  const stopped = entries.filter((e) => e.kind === 'STOPPAGE_START').length > entries.filter((e) => e.kind === 'STOPPAGE_END').length;
  if (entry.kind === 'RUN_START') {
    if (started) return refuse('TB11-TWICE', `${view.stepKey} has started its run already; a new run is a new step`, ['PR-29']);
    return { ok: true, data: { press: entry['press'], ...(entry['counter'] !== undefined ? { counter: entry['counter'] } : {}), recordedBy: view.actor.id } };
  }
  if (!started) return refuse('TB11-NOT-STARTED', `${view.stepKey} has not started its run`, ['PR-29', 'IN-35']);
  const isTest = entry.kind === 'STATION_SWEEP' || KIND_TEST[entry.kind] !== undefined;
  if (ended && !isTest) return refuse('TB11-ENDED', `The run of ${view.stepKey} has ended: only its end-of-run checks remain`, ['PR-29']);
  if (stopped && isTest) return refuse('TB11-STOPPED', `The press of ${view.stepKey} is stopped: end the stoppage before sampling`, ['PR-29', 'DI-28']);
  const missed = overdue(entries, view.config, view.nowUs);
  let t: TestOutcome | undefined;
  let data: Record<string, unknown>;
  switch (entry.kind) {
    case 'STOPPAGE_START':
      if (stopped) return refuse('TB11-STOPPED', `The press of ${view.stepKey} is stopped already`, ['PR-29']);
      data = { recordedBy: view.actor.id };
      break;
    case 'STOPPAGE_END': {
      const s = entries.filter((e) => e.kind === 'STOPPAGE_START').at(-1);
      if (!stopped || !s) return refuse('TB11-NOT-STOPPED', `The press of ${view.stepKey} is not stopped`, ['PR-29']);
      const us = view.nowUs - s.recordedAt;
      data = { start: s.id, seconds: secondsText(us), long: us > (durationUs(view.config['restartAfter']) ?? DEFAULT_RESTART_US), recordedBy: view.actor.id };
      break;
    }
    case 'CHANGE':
      data = { change: entry['change'], recordedBy: view.actor.id };
      break;
    case 'RUN_END':
      if (stopped) return refuse('TB11-STOPPED', `End the stoppage of ${view.stepKey} before the run ends`, ['PR-29']);
      data = { recordedBy: view.actor.id };
      break;
    default: {
      if (!isTest) return refuse('TB11-ENTRY', `${entry.kind} is not an entry of an IPC scheduler step`, ['PR-29']);
      const test = KIND_TEST[entry.kind];
      if (test && !planOf(view.config).some((p) => p.test === test)) return refuse('TB11-NOT-PLANNED', `${test.toLowerCase()} is not in the test plan of ${view.stepKey}`, ['PR-29', 'PR-07']);
      const counter = counterOf(entry['counter']);
      if (counter !== undefined) {
        const last = lastCounter(entries);
        if (last !== undefined && counter < last) return refuse('TB11-COUNTER-BACK', `The press counter reads ${counter}, below the ${last} already recorded`, ['DI-28', 'PR-29']);
      }
      const plan = test ? planOf(view.config).find((p) => p.test === test) : undefined;
      const counts = checkTest({ kind: entry.kind, data: entry }) !== undefined;
      if (counts && plan?.everyCount !== undefined && entry['counter'] === undefined) return refuse('TB11-COUNTER', `The ${test?.toLowerCase()} check gives the press counter (its interval is by count too)`, ['PR-29']);
      const r = acceptTest(view, entry);
      if (!r.ok) return r;
      t = r.t;
      data = r.t.data;
      const slotTest = counts ? (test ?? 'SWEEP') : undefined;
      if (slotTest && plan?.everyCount !== undefined && counter !== undefined) {
        const prev = slotCounter(entries, String(entry['stream']), slotTest);
        if (prev !== undefined && counter - prev > plan.everyCount && !missed.some((m) => m.stream === entry['stream'] && m.test === slotTest)) {
          missed.push({ stream: String(entry['stream']), test: slotTest, by: 'COUNT' });
        }
      }
    }
  }
  const exceptions: ExceptionDraft[] = missed.length > 0 ? [missedException(view, missed)] : [];
  const withMissed = missed.length > 0 ? { missed } : {};
  if (t) return resultOf(view, t, { exceptions, data: withMissed });
  return { ok: true, data: { ...data, ...withMissed }, ...(exceptions.length > 0 ? { exceptions } : {}) };
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out: HandlerProblem[] = [];
  const entries = view.entries();
  const end = entries.find((e) => e.kind === 'RUN_END');
  if (!end) return [problem('TB11-RUNNING', `The run of ${view.stepKey} has not ended`, ['PR-29', 'IN-35'])];
  if (isCompression(view.config) && hasSweep(view.config)) {
    const missing = streamsOf(view.config).filter((s) => !entries.some((e) => e.kind === 'STATION_SWEEP' && e.data['stream'] === s));
    if (missing.length > 0) out.push(problem('TB11-NO-SWEEP', `Stream ${missing.join(', ')} of ${view.stepKey} has no station sweep`, ['IN-35']));
  }
  const noEnd = slotsOf(view.config)
    .filter((s) => s.test !== 'SWEEP')
    .filter((s) => !entries.some((e) => checkTest(e) === s.test && e.data['stream'] === s.stream && e.recordedAt >= end.recordedAt));
  if (noEnd.length > 0) out.push(problem('TB11-END-CHECK', `${view.stepKey} has no end-of-run check of ${noEnd.map((s) => `${s.test.toLowerCase()} (stream ${s.stream})`).join(', ')}`, ['PR-29', 'IN-35']));
  if (pendingFirstStages(view).length > 0 || pendingFriability(view).length > 0 || dtPending(view)) out.push(problem('TB11-PENDING', `${view.stepKey} still waits for a compendial stage (a second stage, repeat runs, a retest or a running disintegration)`, ['INV-41', 'PR-29']));
  return out;
}

const PLAN_ITEM: ObjectSchema = {
  type: 'object',
  description: 'A test of the plan: its interval by time (and press count), and its quality-risk-management reference (PR-07)',
  fields: {
    test: { type: 'string', enum: [...TESTS], description: 'The test' },
    every: { ...DURATION, description: 'Interval by time' },
    everyCount: { type: 'integer', min: 1, optional: true, description: 'Interval by press count (tablets)' },
    qrmRef: { type: 'string', pattern: /^[A-Z0-9][A-Z0-9_./-]{0,63}$/, optional: true, description: 'The risk assessment the frequency rests on (required: TB11-QRM)' },
  },
};

const SWEEP_LIMIT: ObjectSchema = { type: 'object', description: 'Individual limits of a swept parameter', fields: { individual: TIERS } };

export const SCHEDULER_CONFIG: ObjectSchema = {
  type: 'object',
  description: 'Streams, the test plan with intervals and QRM references, the grace and restart times, the station sweep, and each planned test\'s configuration',
  fields: {
    process: { type: 'string', enum: ['COMPRESSION', 'OTHER'], optional: true, description: 'COMPRESSION (the default) applies the 30-min ceiling and the station sweep' },
    streams: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      description: 'Press sides, layers, tracks or pans',
      items: { type: 'object', description: 'A stream', fields: { id: { type: 'string', pattern: STREAM, description: 'Stream id (the output containers\' stream)' } } },
    },
    plan: { type: 'array', minItems: 1, maxItems: 4, items: PLAN_ITEM, description: 'The test plan of every stream' },
    grace: { ...DURATION, description: 'A check is missed when it is this long overdue' },
    restartAfter: { ...DURATION, optional: true, description: 'A stoppage longer than this makes every check due at the restart (D: 15 min; 0 to 60 min)' },
    lateEntry: LATE_ENTRY,
    sweep: {
      type: 'object',
      optional: true,
      description: 'The station sweep at the start of the run (and at an interval on multi-point presses)',
      fields: {
        stations: { type: 'integer', min: 1, max: 100, description: 'Stations (compression points) per stream' },
        weight: { ...SWEEP_LIMIT, optional: true, description: 'Tablet weight limits, mg' },
        thickness: { ...SWEEP_LIMIT, optional: true, description: 'Thickness limits, mm' },
        hardness: { type: 'object', optional: true, description: 'Breaking force: tester unit and limits in N', fields: { unit: { type: 'string', enum: ['N', 'kp'], description: 'Unit the tester reads' }, individual: TIERS } },
        every: { ...DURATION, optional: true, description: 'Repeat interval on multi-point presses' },
      },
    },
    weight: { ...WEIGHT_CONFIG, optional: true },
    physical: { ...PHYSICAL_CONFIG, optional: true },
    friability: { ...FRIABILITY_CONFIG, optional: true },
    disintegration: { ...DT_CONFIG, optional: true },
  },
};

const TB11_ENTRIES: Readonly<Record<string, ObjectSchema>> = {
  RUN_START: {
    type: 'object',
    description: 'The run starts on a press',
    fields: { press: { type: 'string', pattern: EQUIPMENT_CODE, description: 'The press (plant PROCESS unit in use for the batch)' }, counter: { type: 'integer', min: 0, optional: true, description: 'Press tablet counter at the start' } },
  },
  STOPPAGE_START: { type: 'object', description: 'The press stops (server time)', fields: {} },
  STOPPAGE_END: { type: 'object', description: 'The press restarts (server time)', fields: {} },
  CHANGE: { type: 'object', description: 'A setting or tooling change: every check falls due', fields: { change: { type: 'string', enum: ['SETTING', 'TOOLING'], description: 'What changed' } } },
  RUN_END: { type: 'object', description: 'The run ends: every check falls due for the end of the run', fields: {} },
  STATION_SWEEP: {
    type: 'object',
    description: 'The station sweep of a stream: one tablet of every station',
    fields: {
      ...TEST_FIELDS,
      stations: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        description: 'Every station once',
        items: {
          type: 'object',
          description: 'One station\'s tablet',
          fields: {
            station: { type: 'integer', min: 1, max: 100, description: 'Station number' },
            weight: { ...POSITIVE_DECIMAL, optional: true, description: 'mg' },
            thickness: { ...POSITIVE_DECIMAL, optional: true, description: 'mm' },
            hardness: { ...POSITIVE_DECIMAL, optional: true, description: 'Tester unit' },
          },
        },
      },
    },
  },
  ...WEIGHT_ENTRIES,
  ...PHYSICAL_ENTRIES,
  ...FRIABILITY_ENTRIES,
  ...DT_ENTRIES,
};

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, unknown>>, mbr: MbrContent): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const where = `IPC scheduler ${phase.id}`;
  const streams = streamsOf(config);
  if (new Set(streams).size !== streams.length) out.push(configError('TB11-STREAMS', `${where} lists a stream twice`, ['PR-29']));
  const plan = Array.isArray(config['plan']) ? (config['plan'] as Record<string, unknown>[]) : [];
  const tests = plan.map((p) => String(p['test']));
  if (new Set(tests).size !== tests.length) out.push(configError('TB11-PLAN', `${where} plans a test twice`, ['PR-29']));
  const grace = durationUs(config['grace']);
  if (grace === undefined || grace <= 0n) out.push(configError('TB11-GRACE', `${where} has no grace time above zero`, ['IN-35', 'PR-29']));
  for (const p of plan) {
    const every = durationUs(p['every']);
    if (every === undefined || every <= 0n) out.push(configError('TB11-PLAN', `${where}: ${String(p['test'])} has no interval above zero`, ['PR-29']));
    if (text(p['qrmRef']) === undefined) out.push(configError('TB11-QRM', `${where}: ${String(p['test'])} names no risk assessment for its frequency`, ['PR-07']));
    const key = CONFIG_OF[p['test'] as (typeof TESTS)[number]];
    const cfg = key ? config[key] : undefined;
    if (!isRecord(cfg)) {
      out.push(configError('TB11-TEST-CONFIG', `${where} plans ${String(p['test'])} without its configuration (${key})`, ['PR-29']));
      continue;
    }
    if (key === 'weight') out.push(...weightConfigProblems(`${where} weight`, cfg, mbr.header.marketSet));
    if (key === 'physical') out.push(...physicalConfigProblems(`${where} physical`, cfg));
    if (key === 'friability') out.push(...friabilityConfigProblems(`${where} friability`, cfg, mbr.header.marketSet));
    if (key === 'disintegration') out.push(...dtConfigProblems(`${where} disintegration`, cfg, mbr.header.marketSet));
  }
  const restart = durationUs(config['restartAfter']);
  if (config['restartAfter'] !== undefined && (restart === undefined || restart > MAX_RESTART_US)) out.push(configError('TB11-RESTART', `${where}: the restart threshold is 0 to 60 min`, ['IN-35']));
  if (isCompression(config)) {
    const fastest = plan.map((p) => durationUs(p['every'])).filter((x): x is bigint => x !== undefined).reduce<bigint | undefined>((a, x) => (a === undefined || x < a ? x : a), undefined);
    if (fastest === undefined || grace === undefined || fastest + grace > CEILING_US) {
      out.push(configError('TB11-CEILING', `${where}: in compression a sample is checked no more than ${COMPRESSION_SAMPLE_CEILING.value} min after the previous one; the most frequent test plus the grace must not exceed it (IN-35 (c))`, ['IN-35']));
    }
    if (!hasSweep(config)) out.push(configError('TB11-NO-SWEEP', `${where}: a compression run starts with a station sweep of every stream (IN-35 (b))`, ['IN-35']));
  }
  const sweep = config['sweep'];
  if (isRecord(sweep)) {
    if (sweepParams(config).length === 0) out.push(configError('TB11-SWEEP-PARAMETERS', `${where}: the station sweep examines no parameter`, ['IN-35']));
    for (const p of sweepParams(config)) out.push(...tierProblems(`${where} sweep ${p}`, tiersOf((sweep[p] as Record<string, unknown>)['individual']), 'TB11-SWEEP-PARAMETERS', ['IN-35']));
  }
  return out;
}

function nominal(input: Parameters<NonNullable<BlockVersion['simulatorModel']>['nominalEntries']>[0]): (Record<string, unknown> & { kind: string })[] {
  const cfg = input.config as Readonly<Record<string, unknown>>;
  const out: (Record<string, unknown> & { kind: string })[] = [{ kind: 'RUN_START', press: 'TEST-PRESS-01' }];
  const checks = (stream: string) =>
    planOf(cfg).flatMap((p) => {
      const c = cfg[CONFIG_OF[p.test]] as Record<string, unknown>;
      if (p.test === 'WEIGHT') return weightNominal(c, stream, input.mbr.header.marketSet);
      if (p.test === 'PHYSICAL') return physicalNominal(c, stream);
      if (p.test === 'FRIABILITY') return friabilityNominal(stream);
      return dtNominal(c, stream);
    });
  const sweep = cfg['sweep'];
  for (const stream of streamsOf(cfg)) {
    if (isRecord(sweep)) {
      const params = sweepParams(cfg);
      const n = Number(sweep['stations']);
      const mid = (p: string) => {
        const t = tiersOf((sweep[p] as Record<string, unknown>)['individual']);
        const lo = dec(t?.action.min ?? t?.action.max ?? '1');
        const hi = dec(t?.action.max ?? t?.action.min ?? '1');
        const m = lo.plus(hi).div(dec('2'));
        return (p === 'hardness' && (sweep[p] as Record<string, unknown>)['unit'] === 'kp' ? m.div(dec(KP_TO_N)) : m).toFixed(2, 'HALF_UP');
      };
      out.push({
        kind: 'STATION_SWEEP',
        instrument: 'TEST-BAL-01',
        capture: 'DEVICE',
        stream,
        readings: Array.from({ length: n * params.length }, (_, i) => `00000000-0000-4000-8000-${(i + 501).toString().padStart(12, '0')}`),
        stations: Array.from({ length: n }, (_, i) => ({ station: i + 1, ...Object.fromEntries(params.map((p) => [p, mid(p)])) })),
      });
    }
    out.push(...checks(stream));
  }
  out.push({ kind: 'RUN_END' });
  for (const stream of streamsOf(cfg)) out.push(...checks(stream));
  return out;
}

const GOLDEN_UUID = (i: number) => `00000000-0000-4000-8000-${(i + 601).toString().padStart(12, '0')}`;

export const TB11: BlockVersion = {
  type: 'TB-11',
  version: '1',
  title: 'Periodic IPC scheduler with streams and bracketing hold',
  edition: 'tablets',
  aliases: { tablets: 'TB-11' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: SCHEDULER_CONFIG,
  dataSchema: { entries: TB11_ENTRIES },
  checkConfig,
  handler: { acceptEntry: accept, beforePerform },
  exceptionRules: [
    ...TEST_EXCEPTION_RULES,
    { type: 'IPC_CHECK_MISSED', category: 'TIME_LIMIT', severity: 'ACTION', summary: 'A periodic IPC check was missed (overdue by time or by press count)', controls: ['IN-35', 'PR-29'] },
  ],
  simulatorModel: { exceptionTypes: () => [...TEST_EXCEPTION_TYPES, 'IPC_CHECK_MISSED'], nominalEntries: nominal },
  goldenFixture: {
    description:
      'A compression run on one side: the 4-station sweep, a group weight every 15 min (grace 5 min): the first at 10 min, the next at 24 min, then the run ends at 30 min and the end-of-run check passes; nothing missed, nothing held',
    controls: ['IN-35', 'PR-29'],
    phase: {
      block: { type: 'TB-11', version: '1' },
      config: {
        streams: [{ id: 'L' }],
        plan: [{ test: 'WEIGHT', every: { value: '15', unit: 'min' }, qrmRef: 'QRM-IPC-07' }],
        grace: { value: '5', unit: 'min' },
        sweep: { stations: 4, weight: { individual: { action: { min: '237.5', max: '262.5' } } } },
        weight: { mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '250.0', n: 20, weighing: 'GROUP', tolerance: { action: '2' } },
      },
    },
    script: [
      { entry: { kind: 'RUN_START', press: 'TEST-PRESS-01' } },
      {
        entry: {
          kind: 'STATION_SWEEP',
          instrument: 'TEST-BAL-01',
          capture: 'DEVICE',
          stream: 'L',
          readings: [0, 1, 2, 3].map(GOLDEN_UUID),
          stations: ['249.0', '251.5', '250.2', '248.8'].map((w, i) => ({ station: i + 1, weight: w })),
        },
      },
      { advanceUs: 600_000_000n },
      { entry: { kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'DEVICE', stream: 'L', readings: [GOLDEN_UUID(4)], groupWeight: '5012.4' } },
      { advanceUs: 840_000_000n },
      { entry: { kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'DEVICE', stream: 'L', readings: [GOLDEN_UUID(5)], groupWeight: '4987.0' } },
      { advanceUs: 360_000_000n },
      { entry: { kind: 'RUN_END' } },
      { entry: { kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'DEVICE', stream: 'L', readings: [GOLDEN_UUID(6)], groupWeight: '5001.0' } },
    ],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/ipc/blocks.test.ts', 'apps/tablets-server/test/blocks/ipc/db-guards.test.ts'],
};

