/**
 * TB-22@1 Blister or strip leak test (tablets spec B.2 TB-22; Phase 3 slice 4b, builder A). Controls IN-38 (c), PR-29,
 * PR-37.
 *
 * One TB-22 step is the leak-test series of one run of a blister machine: RUN_START names the machine (the database
 * checks it is a plant PROCESS unit in use for the batch, after a completed TB-21 line check of it in this batch) and
 * RUN_END closes the run. The MBR sets the method (vacuum decay or dye ingress) with its validated vacuum and hold-time
 * ranges, the blisters or strips per test and per track, the tracks by name (each its own series; D one, LEAK), the interval by time (`every`) and optionally by
 * blisters formed (`everyCount`, the machine counter on the entries), the grace, the risk assessment the frequency
 * rests on (PR-07) and the events after which a test falls due at once (RESTART after a stoppage, REEL_CHANGE,
 * ADJUSTMENT; D all three). A test is always due at the start and at the end of the run (Sched M VIII 7.4: periodic tests
 * are mandatory).
 *
 * Due and overdue, per track, at the database time of each entry (never a typed time): due at the run's start, then one
 * interval after the track's last test (or the last entry that found it missed), at once after a configured event, and at
 * the end of the run. A test not made within the grace after it fell due is missed: the next entry of the step lists it
 * (`missed`) and raises LEAK_TEST_MISSED (the steps after it wait for a deviation); in the database the slice 1 container
 * hold records a MISSED check of the track's series (the track's stream of the machine), which holds the machine's
 * output since the track's last passing test, and the server's sweeper records an overdue test without waiting for an
 * entry (IN-38 (c)). A test whose counter advanced more than the count interval since the track's last test is missed
 * by count.
 *
 * LEAK_TEST: the track, the MBR's number of units tested, the applied vacuum and hold time (inside the validated
 * ranges, or the test is no test: refused), and the leaking pockets. Any leaking pocket fails it: LEAK_TEST_FAILED (the
 * steps after it wait for a deviation) and, in the database, FAIL on the track's series; a pass is the only PASS on it.
 * The applied parameters are keyed, so the step needs a second person's check (the tester interface is a later slice).
 * Before PERFORMED: the run ended and every track tested after its end.
 */
import {
  configError,
  DURATION,
  durationUs,
  EQUIPMENT_CODE,
  isRecord,
  POSITIVE_COUNT,
  STREAM,
  positiveCount,
  problem,
  refuse,
  text,
  type BlockVersion,
  type Config,
  type ConfigProblem,
  type Entry,
  type EntryRecord,
  type EntryResult,
  type ExceptionDraft,
  type HandlerProblem,
  type HandlerView,
  type JsonValue,
  type MbrContent,
  type PhaseNode,
} from './blister/common.ts';
import { dec } from './ipc/calc.ts';
import { RUN_SUMMARIES, S } from './summaries.ts';

const CONTROLS = ['IN-38', 'PR-29', 'PR-37'];
export const LEAK_EVENTS = ['RESTART', 'REEL_CHANGE', 'ADJUSTMENT'] as const;
export const LEAK_METHODS = ['VACUUM_DECAY', 'DYE_INGRESS'] as const;

export interface LeakMissed {
  stream: string;
  test: 'LEAK';
  by: 'TIME' | 'COUNT';
  dueUs?: string;
}

/** The track a run without named tracks has (one, its series named without a digit). */
export const SINGLE_TRACK = 'LEAK';
/** The machine's tracks as the MBR names them (D one track, LEAK); each is a series of the slice 1 container hold. */
export const tracksOf = (config: Config): string[] => (Array.isArray(config['tracks']) ? config['tracks'].filter((t): t is string => typeof t === 'string') : [SINGLE_TRACK]);
const eventsOf = (config: Config): string[] => (Array.isArray(config['triggers']) ? config['triggers'].map(String) : [...LEAK_EVENTS]);
const rangeOf = (config: Config, key: string): { min?: string; max?: string } => {
  const r = config[key];
  return isRecord(r) ? { ...(typeof r['min'] === 'string' ? { min: r['min'] } : {}), ...(typeof r['max'] === 'string' ? { max: r['max'] } : {}) } : {};
};
const within = (v: string, r: { min?: string; max?: string }): boolean =>
  (r.min === undefined || dec(v).gte(dec(r.min))) && (r.max === undefined || dec(v).lte(dec(r.max)));

const marks = (e: EntryRecord, stream: string): boolean => Array.isArray(e.data['missed']) && (e.data['missed'] as LeakMissed[]).some((m) => m.stream === stream);

/**
 * When the test of track `track` falls due (microseconds), or undefined when nothing is due (before the run's start;
 * after an end-of-run test).
 */
export function leakDue(entries: readonly EntryRecord[], config: Config, track: string): bigint | undefined {
  const start = entries.find((e) => e.kind === 'RUN_START');
  const every = durationUs(config['every']);
  if (!start || every === undefined) return undefined;
  let base = start.recordedAt;
  let touched = false;
  for (const e of entries) {
    if ((e.kind === 'LEAK_TEST' && e.data['track'] === track) || marks(e, track)) {
      touched = true;
      if (e.recordedAt > base) base = e.recordedAt;
    }
  }
  let due = touched ? base + every : start.recordedAt;
  const events = eventsOf(config);
  for (const e of entries) {
    if (e.kind === 'EVENT' && e.recordedAt > base && events.includes(String(e.data['event'])) && e.recordedAt < due) due = e.recordedAt;
  }
  const end = entries.find((e) => e.kind === 'RUN_END');
  if (end) {
    if (touched && base >= end.recordedAt) return undefined;
    if (end.recordedAt < due) due = end.recordedAt;
  }
  return due;
}

/** The tests missed at `nowUs` (overdue beyond the grace), track by track. */
export function leakOverdue(entries: readonly EntryRecord[], config: Config, nowUs: bigint): LeakMissed[] {
  const grace = durationUs(config['grace']) ?? 0n;
  const out: LeakMissed[] = [];
  for (const t of tracksOf(config)) {
    const due = leakDue(entries, config, t);
    if (due !== undefined && nowUs > due + grace) out.push({ stream: t, test: 'LEAK', by: 'TIME', dueUs: due.toString() });
  }
  return out;
}

/** The highest machine counter the run has recorded. */
function lastCounter(entries: readonly EntryRecord[]): number | undefined {
  let c: number | undefined;
  for (const e of entries) if (typeof e.data['counter'] === 'number') c = c === undefined || e.data['counter'] > c ? e.data['counter'] : c;
  return c;
}

/** The counter of track `track`'s last test that gave one (or the run's start). */
function trackCounter(entries: readonly EntryRecord[], track: string): number | undefined {
  const last = [...entries].reverse().find((e) => e.kind === 'LEAK_TEST' && e.data['track'] === track && typeof e.data['counter'] === 'number');
  const v = last?.data['counter'] ?? entries.find((e) => e.kind === 'RUN_START')?.data['counter'];
  return typeof v === 'number' ? v : undefined;
}

function heldBy(view: HandlerView, type: string, title: string, category: ExceptionDraft['category']): ExceptionDraft {
  return { type, title: `${title} at ${view.stepKey}: the steps after it wait for a deviation`, controls: ['IN-38', 'PR-29'], severity: 'ACTION', category, blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true };
}

function accept(view: HandlerView, entry: Entry): EntryResult {
  const c = view.config;
  const entries = view.entries();
  const started = entries.some((e) => e.kind === 'RUN_START');
  const ended = entries.some((e) => e.kind === 'RUN_END');
  if (entry.kind === 'RUN_START') {
    if (started) return refuse('TB22-TWICE', `${view.stepKey} has started its run already; a new run is a new step`, ['PR-29']);
    return { ok: true, data: { machine: entry['machine'], ...(entry['counter'] !== undefined ? { counter: entry['counter'] } : {}), startedBy: view.actor.id } };
  }
  if (!['EVENT', 'LEAK_TEST', 'RUN_END'].includes(entry.kind)) return refuse('TB22-ENTRY', `${entry.kind} is not an entry of a leak-test step`, ['PR-29']);
  if (!started) return refuse('TB22-NOT-STARTED', `${view.stepKey} has not started its run`, ['PR-29']);
  if (ended && entry.kind !== 'LEAK_TEST') return refuse('TB22-ENDED', `The run of ${view.stepKey} has ended`, ['PR-29']);
  if (entry['counter'] !== undefined) {
    const last = lastCounter(entries);
    if (last !== undefined && Number(entry['counter']) < last) return refuse('TB22-COUNTER-BACK', `The machine counter reads ${Number(entry['counter'])}, below the ${last} already recorded`, ['PR-29']);
  }
  const missed: LeakMissed[] = leakOverdue(entries, c, view.nowUs);
  const exceptions: ExceptionDraft[] = [];
  let data: Record<string, unknown>;
  const counter = entry['counter'] !== undefined ? { counter: entry['counter'] } : {};
  switch (entry.kind) {
    case 'EVENT':
      data = { event: entry['event'], ...counter, recordedBy: view.actor.id };
      break;
    case 'RUN_END':
      data = { ...counter, endedBy: view.actor.id };
      break;
    default: {
      const track = String(entry['track']);
      if (!tracksOf(c).includes(track)) return refuse('TB22-TRACK', `${track} is not a track of the machine (${tracksOf(c).join(', ')})`, ['PR-29']);
      const n = String(entry['tested']);
      if (n !== text(c['perTest'])) return refuse('TB22-SAMPLE', `A leak test takes the ${text(c['perTest']) ?? '-'} units per track the MBR sets, not ${n}`, ['PR-29']);
      const leaking = String(entry['leaking']);
      if (BigInt(leaking) > BigInt(n)) return refuse('TB22-LEAKING', `More leaking units (${leaking}) than tested (${n})`, ['PR-29']);
      const vacuum = String(entry['vacuum']);
      const hold = String(entry['holdSeconds']);
      if (!within(vacuum, rangeOf(c, 'vacuum')) || !within(hold, rangeOf(c, 'hold'))) {
        return refuse('TB22-PARAMETERS', `The test ran at ${vacuum} kPa for ${hold} s, outside the validated method's vacuum and hold-time ranges: it is no test`, ['PR-29', 'IN-38']);
      }
      const every = text(c['everyCount']);
      if (every !== undefined && entry['counter'] === undefined) return refuse('TB22-COUNTER', 'The leak test gives the machine counter (its interval is by count too)', ['PR-29']);
      if (every !== undefined && typeof entry['counter'] === 'number') {
        const prev = trackCounter(entries, track);
        if (prev !== undefined && BigInt(entry['counter'] - prev) > BigInt(every) && !missed.some((m) => m.stream === track)) missed.push({ stream: track, test: 'LEAK', by: 'COUNT' });
      }
      const pass = BigInt(leaking) === 0n;
      data = { track, tested: n, vacuum, holdSeconds: hold, leaking, ...counter, result: pass ? 'PASS' : 'FAIL', testedBy: view.actor.id };
      if (!pass) exceptions.push(heldBy(view, 'LEAK_TEST_FAILED', `A leak test of track ${track} found ${leaking} leaking units; the machine's output since the track's last passing test is held`, 'OUT_OF_LIMIT'));
    }
  }
  if (missed.length > 0) {
    exceptions.unshift(heldBy(view, 'LEAK_TEST_MISSED', `A scheduled leak test was missed (${missed.map((m) => `track ${m.stream}${m.by === 'COUNT' ? ' by count' : ''}`).join(', ')}); the machine's output since the track's last passing test is held`, 'TIME_LIMIT'));
  }
  return {
    ok: true,
    data: { ...data, ...(missed.length > 0 ? { missed } : {}) },
    ...(entry.kind === 'LEAK_TEST' ? { verificationRequired: true } : {}),
    ...(exceptions.length > 0 ? { exceptions } : {}),
  };
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const entries = view.entries();
  const end = entries.find((e) => e.kind === 'RUN_END');
  if (!end) return [problem('TB22-RUNNING', `The run of ${view.stepKey} has not ended`, ['PR-29'])];
  const out: HandlerProblem[] = [];
  for (const t of tracksOf(view.config)) {
    if (!entries.some((e) => e.kind === 'LEAK_TEST' && e.data['track'] === t && e.recordedAt >= end.recordedAt)) out.push(problem('TB22-END-TEST', `Track ${t} of ${view.stepKey} has no end-of-run leak test`, ['PR-29', 'IN-38']));
  }
  return out;
}

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, _mbr: MbrContent): ConfigProblem[] {
  void _mbr;
  const where = `Leak-test step ${phase.id}`;
  const out: ConfigProblem[] = [];
  const every = durationUs(config['every']);
  const grace = durationUs(config['grace']);
  if (every === undefined || every <= 0n || grace === undefined || grace <= 0n) out.push(configError('TB22-SCHEDULE', `${where} has no test interval and grace above zero`, ['PR-29', 'IN-38']));
  if (text(config['qrmRef']) === undefined) out.push(configError('TB22-QRM', `${where} names no risk assessment for its test frequency`, ['PR-07']));
  for (const k of ['vacuum', 'hold']) {
    const r = rangeOf(config, k);
    if (r.min === undefined || r.max === undefined || dec(r.min).gt(dec(r.max))) out.push(configError('TB22-METHOD', `${where}: the validated ${k} range has a lower and an upper limit, in order`, ['PR-29']));
  }
  const tracks = tracksOf(config);
  if (new Set(tracks).size !== tracks.length || tracks.includes('LINE')) out.push(configError('TB22-TRACKS', `${where} names each track once, and none LINE (the blister run's series)`, ['PR-29']));
  return out;
}

const RANGE = (description: string) => ({
  type: 'object' as const,
  description,
  fields: { min: { type: 'decimal' as const, min: '0', minExclusive: true, description: 'Lowest' }, max: { type: 'decimal' as const, min: '0', minExclusive: true, description: 'Highest' } },
});
const COUNTER = { type: 'integer' as const, min: 0, optional: true, description: 'Machine counter (blisters formed)' };

export const TB22: BlockVersion = {
  type: 'TB-22',
  version: '1',
  title: 'Blister leak test',
  edition: 'tablets',
  aliases: { tablets: 'TB-22' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'The validated method, the units per test and track, and the schedule with its triggers',
    fields: {
      method: { type: 'string', enum: [...LEAK_METHODS], description: 'Vacuum decay or dye ingress' },
      vacuum: RANGE('Validated vacuum, kPa below atmospheric'),
      hold: RANGE('Validated hold time, s'),
      perTest: positiveCount('Blisters or strips tested per track and test'),
      tracks: { type: 'array', minItems: 1, maxItems: 12, optional: true, items: { type: 'string', pattern: STREAM, description: 'Track' }, description: 'The tracks of the machine, by name (D one track, LEAK)' },
      every: { ...DURATION, description: 'Interval between tests' },
      everyCount: { ...positiveCount('Blisters formed between tests'), optional: true },
      grace: { ...DURATION, description: 'A test is missed when it is this long overdue' },
      qrmRef: { type: 'string', pattern: /^[A-Z0-9][A-Z0-9_./-]{0,63}$/, optional: true, description: 'The risk assessment the frequency rests on (required: TB22-QRM)' },
      triggers: { type: 'array', optional: true, maxItems: 3, items: { type: 'string', enum: [...LEAK_EVENTS], description: 'Event' }, description: 'Events after which a test falls due at once (D all)' },
    },
  },
  entrySummaries: {
    RUN_START: RUN_SUMMARIES.RUN_START,
    EVENT: (d) => `${S.cap(S.words(d['event']))}${S.str(d['counter']) !== '' ? ` at counter ${S.str(d['counter'])}` : ''}`,
    LEAK_TEST: (d) =>
      `Leak test of track ${S.val(d['track'])}: ${S.val(d['leaking'])} of ${S.count(d['tested'], 'unit')} leaking at ${S.val(d['vacuum'])} kPa for ${S.val(d['holdSeconds'])} s${S.str(d['result']) !== '' ? `: ${S.verdict(d['result'])}` : ''}`,
    RUN_END: RUN_SUMMARIES.RUN_END,
  },
  dataSchema: {
    entries: {
      RUN_START: { type: 'object', description: 'The run of the machine starts (a test falls due)', fields: { machine: { type: 'string', pattern: EQUIPMENT_CODE, description: 'Blister machine' }, counter: COUNTER } },
      EVENT: { type: 'object', description: 'A restart, reel change or adjustment', fields: { event: { type: 'string', enum: [...LEAK_EVENTS], description: 'What happened' }, counter: COUNTER } },
      LEAK_TEST: {
        type: 'object',
        description: 'A leak test of one track',
        fields: {
          track: { type: 'string', pattern: STREAM, description: 'Track (a name the MBR gives)' },
          tested: { type: 'string', pattern: POSITIVE_COUNT, description: 'Units tested' },
          vacuum: { type: 'decimal', min: '0', minExclusive: true, description: 'Applied vacuum, kPa below atmospheric' },
          holdSeconds: { type: 'decimal', min: '0', minExclusive: true, description: 'Applied hold time, s' },
          leaking: { type: 'string', pattern: /^[0-9]{1,18}$/, description: 'Leaking units' },
          counter: COUNTER,
        },
      },
      RUN_END: { type: 'object', description: 'The run ends (a test falls due)', fields: { counter: COUNTER } },
    },
  },
  checkConfig,
  handler: { acceptEntry: accept, beforePerform },
  exceptionRules: [
    { type: 'LEAK_TEST_FAILED', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A leak test found a leaking pocket (output since the last passing test held)', controls: ['IN-38', 'PR-29'] },
    { type: 'LEAK_TEST_MISSED', category: 'TIME_LIMIT', severity: 'ACTION', summary: 'A scheduled leak test was missed (output since the last passing test held)', controls: ['IN-38', 'PR-29'] },
  ],
  simulatorModel: {
    exceptionTypes: () => ['LEAK_TEST_FAILED', 'LEAK_TEST_MISSED'],
    nominalEntries: (input) => {
      const c = input.config;
      const test = (t: string) => ({ kind: 'LEAK_TEST', track: t, tested: text(c['perTest']) ?? '1', vacuum: rangeOf(c, 'vacuum').min ?? '1', holdSeconds: rangeOf(c, 'hold').min ?? '1', leaking: '0' });
      const tracks = tracksOf(c);
      return [{ kind: 'RUN_START', machine: 'TEST-BLISTER-01' }, ...tracks.map(test), { kind: 'RUN_END' }, ...tracks.map(test)];
    },
  },
  goldenFixture: {
    description:
      'Vacuum decay at 60 to 80 kPa for 30 to 60 s, 10 blisters per track on two tracks, every 30 min with a grace of 5 min: the start tests pass; after 25 min a reel change makes them due at once; track 2 tested at once passes, track 1 tested 10 min later is missed (LEAK_TEST_MISSED) and has one leaking pocket (LEAK_TEST_FAILED); the run ends and both tracks pass the end-of-run test',
    controls: ['IN-38', 'PR-29'],
    phase: {
      block: { type: 'TB-22', version: '1' },
      config: {
        method: 'VACUUM_DECAY',
        vacuum: { min: '60', max: '80' },
        hold: { min: '30', max: '60' },
        perTest: '10',
        tracks: ['T1', 'T2'],
        every: { value: '30', unit: 'min' },
        grace: { value: '5', unit: 'min' },
        qrmRef: 'QRM-LEAK-01',
      },
    },
    script: [
      { entry: { kind: 'RUN_START', machine: 'TEST-BLISTER-01' } },
      { entry: { kind: 'LEAK_TEST', track: 'T1', tested: '10', vacuum: '70', holdSeconds: '45', leaking: '0' } },
      { entry: { kind: 'LEAK_TEST', track: 'T2', tested: '10', vacuum: '70', holdSeconds: '45', leaking: '0' } },
      { advanceUs: 1_500_000_000n },
      { entry: { kind: 'EVENT', event: 'REEL_CHANGE' } },
      { entry: { kind: 'LEAK_TEST', track: 'T2', tested: '10', vacuum: '70', holdSeconds: '45', leaking: '0' } },
      { advanceUs: 600_000_000n },
      { entry: { kind: 'LEAK_TEST', track: 'T1', tested: '10', vacuum: '70', holdSeconds: '45', leaking: '1' } },
      { entry: { kind: 'RUN_END' } },
      { entry: { kind: 'LEAK_TEST', track: 'T1', tested: '10', vacuum: '70', holdSeconds: '45', leaking: '0' } },
      { entry: { kind: 'LEAK_TEST', track: 'T2', tested: '10', vacuum: '70', holdSeconds: '45', leaking: '0' } },
    ],
    expect: { exceptions: ['LEAK_TEST_FAILED', 'LEAK_TEST_MISSED'], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/blister/blocks.test.ts', 'apps/tablets-server/test/blocks/blister/db-guards.test.ts'],
};
