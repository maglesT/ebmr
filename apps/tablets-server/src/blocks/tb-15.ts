/**
 * TB-15@1 Disintegration, gastro-resistant stages included (tablets spec B.2 TB-15, E.5; Phase 3 slice 3c, builder
 * B). Controls IN-35, PR-29, DI-29.
 *
 * The tablet type selects, from the bound rule sets (IP always; the batch's other markets beside it), the bath
 * temperature range, the time limit (the shortest of the rule sets' and the MBR's own, which may only be tighter), 6
 * units and the retest staging (1 or 2 units failing: 12 more, passing when at least 16 of the 18 do). Gastro-resistant
 * tablets run an acid stage (no disintegration or cracks for the whole acid time) and then a buffer stage.
 *
 *   DT_START  the bath temperature (verified within the rule set's range before the start: TB15-BATH-TEMP), the stage,
 *             the units (6, or 12 for a retest of a first run that asks for one); the start is the server's time;
 *   DT_END    each unit's result; the elapsed time is measured between the two entries at the server's times, never
 *             typed. A unit read from the instrument carries its own disintegration time (never beyond the elapsed
 *             time); one observed by hand counts only when the whole run ended within the limit.
 * The retest is logic inside the block (INV-41): the first run's units are kept and counted with the 12 more; a new
 * first run while a retest is due is refused. A failure raises IPC_CHECK_FAILED (at a TB-11 step the output since the
 * last passing check is held). The database recomputes the limits, the elapsed time and the result (tablets 0891).
 */
import { Dec } from '@ebmr/expr';
import { dec, disintegrationLimits, type DtLimits } from './ipc/calc.ts';
import {
  commonOf,
  configError,
  DECIMAL,
  DURATION,
  durationUs,
  ENTRY_ID,
  LATE_ENTRY,
  problem,
  refuse,
  resolve,
  ruleSetRefusal,
  secondsText,
  TABLET_TYPE,
  TEST_EXCEPTION_RULES,
  TEST_EXCEPTION_TYPES,
  TEST_FIELDS,
  testConfig,
  text,
  UUID,
  type BlockVersion,
  type ConfigProblem,
  type Entry,
  type EntryRecord,
  type EntryResult,
  type HandlerProblem,
  type HandlerView,
  type ObjectSchema,
  type Outcome,
} from './ipc/common.ts';
import { recorded, resolveRuleSets, uncoveredMarkets, type RuleSet, type TabletType } from './ipc/rule-sets.ts';
import { resultOf, type TestOutcome } from './tb-12.ts';
import { DT_SUMMARIES } from './summaries.ts';

const CONTROLS = ['IN-35', 'PR-29', 'DI-29'];

export const DT_CONFIG: ObjectSchema = {
  type: 'object',
  description: 'Tablet type (selects the rule sets) and the MBR\'s own time limits',
  fields: {
    tabletType: TABLET_TYPE,
    timeLimit: { ...DURATION, optional: true, description: 'The MBR\'s time limit, tighter than the rule sets\' (required where they set none)' },
    acidTime: { ...DURATION, optional: true, description: 'Gastro-resistant: the acid stage as authorised (D: the rule set\'s)' },
    lateEntry: LATE_ENTRY,
  },
};

export const DT_ENTRIES: Readonly<Record<string, ObjectSchema>> = {
  DT_START: {
    type: 'object',
    description: 'A disintegration run starts: the bath temperature and the stage',
    fields: {
      ...TEST_FIELDS,
      bathTemperature: { ...DECIMAL, description: 'Bath (medium) temperature, degree Celsius' },
      stage: { type: 'string', enum: ['MAIN', 'ACID', 'BUFFER'], description: 'MAIN; gastro-resistant: ACID then BUFFER' },
      retestOf: { type: 'string', pattern: ENTRY_ID, optional: true, description: 'The DT_END of the first run this retest completes' },
    },
  },
  DT_END: {
    type: 'object',
    description: 'A disintegration run ends: each unit\'s result',
    fields: {
      start: { type: 'string', pattern: ENTRY_ID, optional: true, description: 'The DT_START of the run (D: the one run of the step still running)' },
      capture: { type: 'string', enum: ['DEVICE', 'MANUAL'], description: 'From the instrument, or observed by hand' },
      readings: { type: 'array', optional: true, items: { type: 'string', pattern: UUID, description: 'Reading id' }, minItems: 1, maxItems: 12, description: 'The claimed instrument readings of the units\' times, in order (DEVICE)' },
      units: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        description: 'Each unit in order',
        items: {
          type: 'object',
          description: 'One unit',
          fields: {
            disintegrated: { type: 'boolean', description: 'Disintegrated (acid stage: false when intact, without cracks)' },
            seconds: { type: 'decimal', min: '0', optional: true, description: 'Its disintegration time from the instrument, s (DEVICE)' },
          },
        },
      },
    },
  },
};

const secondsOf = (q: unknown): string | undefined => {
  const us = durationUs(q);
  return us === undefined ? undefined : Dec.fromScaled(us, -6).toString();
};

/** The limits a disintegration of `cfg` runs under with rule sets `sets` (undefined: none covers the type). */
export function dtLimits(sets: readonly RuleSet[], cfg: Readonly<Record<string, unknown>>): DtLimits | undefined {
  return disintegrationLimits(sets, String(cfg['tabletType']), secondsOf(cfg['timeLimit']), secondsOf(cfg['acidTime']));
}

/** The rule sets the run's start recorded (a retest, a buffer stage and the run's end reuse them: review 3c finding 5). */
function startSets(view: HandlerView, endId: unknown): RuleSet[] {
  const end = view.entries('DT_END').find((e) => e.id === endId);
  const start = view.entries('DT_START').find((s) => s.id === end?.data['start']);
  return recorded(start?.data['ruleSets']);
}

/** DT_START entries of the step not yet ended. */
const openStarts = (view: HandlerView): EntryRecord[] => {
  const ended = new Set(view.entries('DT_END').map((e) => e.data['start']));
  return view.entries('DT_START').filter((s) => !ended.has(s.id));
};

/** First runs (DT_END) that ask for a retest no retest has completed or started. */
export function pendingRetests(view: HandlerView): EntryRecord[] {
  const starts = view.entries('DT_START');
  return view.entries('DT_END').filter((e) => e.data['result'] === 'RETEST' && !starts.some((s) => s.data['retestOf'] === e.id));
}

/** Acid stages passed that no buffer stage has followed yet. */
export function pendingBuffers(view: HandlerView): EntryRecord[] {
  const starts = view.entries('DT_START');
  return view.entries('DT_END').filter((e) => e.data['result'] === 'BUFFER' && !starts.some((s) => s.data['stage'] === 'BUFFER' && s.data['afterAcid'] === e.id));
}

/** A DT_START (shared by TB-15 and TB-11); it has no result of its own. */
export function acceptDtStart(view: HandlerView, entry: Entry): { ok: true; t: TestOutcome } | { ok: false; problems: HandlerProblem[] } {
  const cfg = testConfig(view, 'disintegration');
  const stage = String(entry['stage']);
  const gastro = cfg['tabletType'] === 'GASTRO_RESISTANT';
  if (gastro !== (stage !== 'MAIN')) return refuse('TB15-STAGE', gastro ? 'Gastro-resistant tablets run an acid stage and then a buffer stage' : 'Only gastro-resistant tablets run acid and buffer stages', ['PR-29']);
  if (openStarts(view).some((s) => s.data['stream'] === entry['stream'])) return refuse('TB15-RUNNING', 'A disintegration run of this stream is still running; end it first', ['PR-29', 'DI-29']);
  const retestOf = text(entry['retestOf']);
  const retests = pendingRetests(view).filter((e) => e.data['stream'] === entry['stream']);
  let afterAcid: string | undefined;
  if (retestOf !== undefined) {
    const first = retests.find((e) => e.id === retestOf);
    if (!first || first.data['stage'] !== stage) return refuse('TB15-NOT-RETESTED', `${retestOf} is not a run of this stage and stream that asks for a retest`, ['PR-29', 'INV-41']);
  } else if (retests.length > 0) {
    return refuse('TB15-RETEST-PENDING', `${view.stepKey} waits for the retest of its disintegration run; a new first run never replaces it`, ['INV-41', 'DI-29']);
  } else if (stage === 'BUFFER') {
    afterAcid = pendingBuffers(view).find((e) => e.data['stream'] === entry['stream'])?.id;
    if (afterAcid === undefined) return refuse('TB15-NO-ACID', 'The buffer stage follows an acid stage that passed', ['PR-29']);
  } else if (stage === 'ACID' && pendingBuffers(view).some((e) => e.data['stream'] === entry['stream'])) {
    return refuse('TB15-BUFFER-PENDING', 'The acid stage passed: the buffer stage comes next', ['PR-29', 'INV-41']);
  }
  const sets = retestOf !== undefined ? startSets(view, retestOf) : afterAcid !== undefined ? startSets(view, afterAcid) : resolve(view, 'DISINTEGRATION', text(cfg['tabletType']));
  if (retestOf === undefined && afterAcid === undefined) {
    const bad = ruleSetRefusal(view, 'DISINTEGRATION', text(cfg['tabletType']), sets, 'TB15');
    if (bad) return bad;
  }
  const lim = dtLimits(sets, cfg);
  if (!lim) return refuse('TB15-NO-RULE-SET', `No disintegration rule set covers ${String(cfg['tabletType'])} tablets for this batch`, ['PR-29', 'DI-10']);
  const limit = stage === 'ACID' ? lim.acidSeconds : lim.seconds;
  if (limit === undefined) return refuse('TB15-NO-LIMIT', 'Neither a rule set nor the MBR gives this stage a time limit', ['PR-29']);
  const t = dec(String(entry['bathTemperature']));
  if (t.lt(dec(lim.tempMin)) || t.gt(dec(lim.tempMax))) {
    return refuse('TB15-BATH-TEMP', `The bath is at ${t.toString()} degC; the run starts only between ${lim.tempMin} and ${lim.tempMax} degC`, ['PR-29', 'IN-35']);
  }
  const c = commonOf(view, entry, 1, 'TB15');
  if (!c.ok) return c;
  const units = retestOf !== undefined ? lim.staging.retestUnits : lim.units;
  const data: Record<string, unknown> = {
    ...c.common.base,
    bathTemperature: entry['bathTemperature'],
    stage,
    ...(retestOf !== undefined ? { retestOf } : {}),
    ...(afterAcid !== undefined ? { afterAcid } : {}),
    ruleSets: sets.map((r) => ({ code: r.code, version: r.version })),
    limitSeconds: limit,
    temperature: { min: lim.tempMin, max: lim.tempMax },
    units,
  };
  return { ok: true, t: { data, outcome: 'RETEST', manual: c.common.manual, late: c.common.late, what: 'The disintegration start' } };
}

/** A DT_END, evaluated against its start (shared by TB-15 and TB-11). */
export function acceptDtEnd(view: HandlerView, entry: Entry): { ok: true; t: TestOutcome } | { ok: false; problems: HandlerProblem[] } {
  const cfg = testConfig(view, 'disintegration');
  const open = openStarts(view);
  const named = text(entry['start']);
  if (named === undefined && open.length > 1) return refuse('TB15-WHICH-START', `${view.stepKey} has ${open.length} runs running: name the one that ends`, ['PR-29']);
  const start = named === undefined ? open[0] : open.find((s) => s.id === named);
  if (!start) return refuse('TB15-NOT-STARTED', `${named ?? 'No run'} is not a running disintegration of ${view.stepKey}`, ['PR-29']);
  const sd = start.data;
  const units = Array.isArray(entry['units']) ? (entry['units'] as Record<string, unknown>[]) : [];
  if (units.length !== sd['units']) return refuse('TB15-UNITS', `This run tests ${String(sd['units'])} units, not ${units.length}`, ['PR-29', 'IN-35']);
  const device = entry['capture'] === 'DEVICE';
  const readings = Array.isArray(entry['readings']) ? entry['readings'] : undefined;
  if (device ? readings?.length !== units.length || units.some((u) => u['seconds'] === undefined) : readings !== undefined || units.some((u) => u['seconds'] !== undefined)) {
    return refuse('TB15-READINGS', device ? 'A run read from the instrument gives each unit its time and one claimed reading per unit' : 'Units observed by hand carry no times or readings', ['DI-32']);
  }
  const elapsedUs = view.nowUs - start.recordedAt;
  const elapsed = Dec.fromScaled(elapsedUs, -6);
  if (units.some((u) => u['seconds'] !== undefined && dec(text(u['seconds']) ?? '0').gt(elapsed))) return refuse('TB15-TIME', 'A unit cannot disintegrate after its run ended', ['DI-28', 'PR-29']);
  const limit = dec(String(sd['limitSeconds']));
  const stage = String(sd['stage']);
  let outcome: Outcome;
  let passed: number;
  const extra: Record<string, unknown> = {};
  if (stage === 'ACID') {
    if (elapsedUs < BigInt(limit.times(dec('1000000')).toString())) return refuse('TB15-ACID-SHORT', `The acid stage runs its full ${limit.toString()} s`, ['PR-29']);
    passed = units.filter((u) => u['disintegrated'] === false).length;
    outcome = passed === units.length ? 'BUFFER' : 'FAIL';
  } else {
    passed = units.filter((u) => u['disintegrated'] === true && (u['seconds'] !== undefined ? dec(text(u['seconds']) ?? '0').lte(limit) : elapsed.lte(limit))).length;
    const failed = units.length - passed;
    const lim = dtLimits(recorded(sd['ruleSets']), cfg);
    const staging = lim?.staging ?? { failMin: 1, failMax: 2, retestUnits: 12, passMin: 16 };
    if (sd['retestOf'] !== undefined) {
      const firstEnd = view.entries('DT_END').find((e) => e.id === sd['retestOf']);
      const total = Number(firstEnd?.data['passed'] ?? 0) + passed;
      extra['passedInAll'] = total;
      outcome = total >= staging.passMin ? 'PASS' : 'FAIL';
    } else {
      outcome = failed === 0 ? 'PASS' : failed >= staging.failMin && failed <= staging.failMax ? 'RETEST' : 'FAIL';
    }
  }
  const data: Record<string, unknown> = {
    start: start.id,
    stage,
    ...(sd['stream'] !== undefined ? { stream: sd['stream'] } : {}),
    capture: entry['capture'],
    ...(readings ? { readings } : {}),
    units: entry['units'],
    elapsedSeconds: secondsText(elapsedUs),
    passed,
    ...extra,
    result: outcome,
    recordedBy: view.actor.id,
  };
  return { ok: true, t: { data, outcome, manual: !device, late: false, what: `The disintegration (${stage.toLowerCase()} stage)` } };
}

function accept(view: HandlerView, entry: Entry): EntryResult {
  switch (entry.kind) {
    case 'DT_START': {
      const r = acceptDtStart(view, entry);
      return r.ok ? resultOf(view, r.t) : r;
    }
    case 'DT_END': {
      const r = acceptDtEnd(view, entry);
      return r.ok ? resultOf(view, r.t) : r;
    }
    default:
      return refuse('TB15-ENTRY', `${entry.kind} is not an entry of a disintegration step`, ['PR-29']);
  }
}

/** Whether the step still waits for part of a disintegration test (a run running, a retest or a buffer stage due). */
export function dtPending(view: HandlerView): boolean {
  return openStarts(view).length > 0 || pendingRetests(view).length > 0 || pendingBuffers(view).length > 0;
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out: HandlerProblem[] = [];
  if (view.entries('DT_END').length === 0) out.push(problem('TB15-NO-RUN', `${view.stepKey} has no disintegration run`, ['PR-29', 'IN-35']));
  if (dtPending(view)) out.push(problem('TB15-PENDING', `${view.stepKey} has a disintegration run running, or a retest or buffer stage still due`, ['INV-41', 'PR-29']));
  return out;
}

/** Definition checks of a disintegration configuration (TB-15 and TB-11's `disintegration`). */
export function dtConfigProblems(where: string, cfg: Readonly<Record<string, unknown>>, markets: readonly string[]): ConfigProblem[] {
  const type = String(cfg['tabletType']);
  const lim = disintegrationLimits(resolveRuleSets('DISINTEGRATION', markets, type as TabletType, '9999-12-31'), type, secondsOf(cfg['timeLimit']), secondsOf(cfg['acidTime']));
  if (!lim || uncoveredMarkets('DISINTEGRATION', markets, type as TabletType, '9999-12-31').length > 0) return [configError('TB15-NO-RULE-SET', `${where}: no disintegration rule set covers ${type} tablets`, ['PR-29', 'DI-10'])];
  const out: ConfigProblem[] = [];
  if (lim.seconds === undefined) out.push(configError('TB15-NO-LIMIT', `${where}: the rule sets give ${type} tablets no time limit; the MBR states one`, ['PR-29']));
  if (type !== 'GASTRO_RESISTANT' && cfg['acidTime'] !== undefined) out.push(configError('TB15-STAGE', `${where}: only gastro-resistant tablets have an acid stage`, ['PR-29']));
  if (cfg['timeLimit'] !== undefined && secondsOf(cfg['timeLimit']) === undefined) out.push(configError('TB15-NO-LIMIT', `${where}: the time limit is not a whole number of microseconds`, ['PR-29']));
  return out;
}

export function dtNominal(cfg: Readonly<Record<string, unknown>>, stream: string | undefined): (Record<string, unknown> & { kind: string })[] {
  const s = stream !== undefined ? { stream } : {};
  const start = (stage: string) => ({ kind: 'DT_START', instrument: 'TEST-DT-01', capture: 'DEVICE', readings: ['00000000-0000-4000-8000-000000000401'], bathTemperature: '37.0', stage, ...s });
  const end = (disintegrated: boolean) => ({ kind: 'DT_END', capture: 'MANUAL', units: Array.from({ length: 6 }, () => ({ disintegrated })) });
  // Nominal: the run ends at once (within any limit); the acid stage of gastro-resistant tablets is not nominal (it
  // runs its full time), so their nominal path is the start only.
  return cfg['tabletType'] === 'GASTRO_RESISTANT' ? [start('ACID')] : [start('MAIN'), end(true)];
}

export const TB15: BlockVersion = {
  type: 'TB-15',
  version: '1',
  title: 'Disintegration',
  edition: 'tablets',
  aliases: { tablets: 'TB-15' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: DT_CONFIG,
  entrySummaries: DT_SUMMARIES,
  dataSchema: { entries: DT_ENTRIES },
  checkConfig: (phase, config, mbr) => dtConfigProblems(`Disintegration step ${phase.id}`, config, mbr.header.marketSet),
  handler: { acceptEntry: accept, beforePerform },
  exceptionRules: TEST_EXCEPTION_RULES,
  simulatorModel: { exceptionTypes: () => TEST_EXCEPTION_TYPES, nominalEntries: (input) => dtNominal(input.config, undefined) },
  goldenFixture: {
    description:
      'Uncoated cores, MBR limit 10 min (tighter than the IP 15 min): bath at 37.0 degC, six units read from the tester at 4 to 7 min, the run ended after 8 min measured: all within the limit, the check passes',
    controls: ['IN-35', 'PR-29'],
    phase: { block: { type: 'TB-15', version: '1' }, config: { tabletType: 'UNCOATED', timeLimit: { value: '10', unit: 'min' } } },
    script: [
      { entry: { kind: 'DT_START', instrument: 'TEST-DT-01', capture: 'DEVICE', readings: ['00000000-0000-4000-8000-000000000401'], bathTemperature: '37.0', stage: 'MAIN' } },
      { advanceUs: 480_000_000n },
      {
        entry: {
          kind: 'DT_END',
          start: 'EN-1',
          capture: 'DEVICE',
          readings: Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-${(i + 411).toString().padStart(12, '0')}`),
          units: ['240', '300', '310', '355', '400', '420'].map((s) => ({ disintegrated: true, seconds: s })),
        },
      },
    ],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/ipc/blocks.test.ts', 'apps/tablets-server/test/blocks/ipc/db-guards.test.ts'],
};

