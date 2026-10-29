/**
 * TB-14@1 Friability (tablets spec B.2 TB-14, C-15, E.4; Phase 3 slice 3c, builder B). Controls IN-35, PR-29, DI-29.
 *
 * The bound rule sets (IP always; the batch's other markets beside it) give the procedure (100 rotations at 25 +/- 1
 * rpm; whole tablets as near as possible to 6.5 g for a unit mass of 650 mg or less, otherwise 10 tablets) and the
 * guidance limit of 1.0 % mean loss; the MBR may set a tighter limit, never a looser one. A FRIABILITY_RUN records the
 * tablets, the dedusted masses before and after, the rotations and rate (from the friabilator or verified), and whether
 * any tablet is cracked, cleaved or broken. The block computes the loss (C-15) and compares it after rounding to one
 * decimal. When the loss is above the limit or the analyst finds the result doubtful, the test is run twice more
 * (FRIABILITY_RUN with repeatOf the first run) and the mean of the three runs decides; the first run is never discarded
 * or replaced (INV-41: the repeat is the compendial rule, not a new attempt): a new first run while the repeats are
 * pending is refused. A broken tablet fails the test. A failure raises IPC_CHECK_FAILED (at a TB-11 step the output
 * since the last passing check is held). The database recomputes all of it (tablets 0891).
 */
import { Dec } from '@ebmr/expr';
import { dec, fixed, friabilityLimit, friabilityLoss, friabilitySampleProblem } from './ipc/calc.ts';
import {
  commonOf,
  configError,
  DECIMAL,
  ENTRY_ID,
  LATE_ENTRY,
  POSITIVE_DECIMAL,
  problem,
  refuse,
  resolve,
  ruleSetRefusal,
  TABLET_TYPE,
  TEST_EXCEPTION_RULES,
  TEST_EXCEPTION_TYPES,
  TEST_FIELDS,
  testConfig,
  text,
  type BlockVersion,
  type ConfigProblem,
  type Entry,
  type EntryResult,
  type HandlerProblem,
  type HandlerView,
  type ObjectSchema,
  type Outcome,
} from './ipc/common.ts';
import { recorded, resolveRuleSets, uncoveredMarkets, type FriabilityParams, type TabletType } from './ipc/rule-sets.ts';
import { resultOf, type TestOutcome } from './tb-12.ts';
import { FRIABILITY_SUMMARIES } from './summaries.ts';

const CONTROLS = ['IN-35', 'PR-29', 'DI-29'];

export const FRIABILITY_CONFIG: ObjectSchema = {
  type: 'object',
  description: 'Tablet type (selects the rule sets) and an optional tighter in-house limit',
  fields: {
    tabletType: TABLET_TYPE,
    limitPercent: { ...POSITIVE_DECIMAL, optional: true, description: 'In-house maximum mean loss, % (never looser than the rule sets)' },
    lateEntry: LATE_ENTRY,
  },
};

export const FRIABILITY_ENTRIES: Readonly<Record<string, ObjectSchema>> = {
  FRIABILITY_RUN: {
    type: 'object',
    description: 'One run of the friabilator',
    fields: {
      ...TEST_FIELDS,
      tablets: { type: 'integer', min: 1, max: 200, description: 'Whole tablets in the drum' },
      initialMass: { ...POSITIVE_DECIMAL, description: 'Dedusted mass before, g' },
      finalMass: { ...DECIMAL, description: 'Dedusted mass after, g' },
      rotations: { type: 'integer', min: 1, max: 1000, description: 'Drum rotations' },
      rpm: { ...POSITIVE_DECIMAL, description: 'Rate, rotations per minute' },
      broken: { type: 'boolean', description: 'Any tablet cracked, cleaved or broken' },
      doubtful: { type: 'boolean', optional: true, description: 'The analyst finds the result doubtful (runs it twice more)' },
      repeatOf: { type: 'string', pattern: ENTRY_ID, optional: true, description: 'The first run this run repeats' },
    },
  },
};

/** First runs of the step whose repeats are still to come. */
export function pendingFriability(view: HandlerView): string[] {
  const runs = view.entries('FRIABILITY_RUN');
  return runs
    .filter((r) => r.data['run'] === 1 && r.data['result'] === 'REPEAT')
    .filter((r) => !runs.some((x) => x.data['repeatOf'] === r.id && x.data['result'] !== 'REPEAT'))
    .map((r) => r.id);
}

/** A FRIABILITY_RUN, evaluated (shared by TB-14 and TB-11). */
export function acceptFriabilityRun(view: HandlerView, entry: Entry): { ok: true; t: TestOutcome } | { ok: false; problems: HandlerProblem[] } {
  const cfg = testConfig(view, 'friability');
  const runs = view.entries('FRIABILITY_RUN');
  const repeatOf = text(entry['repeatOf']);
  let run = 1;
  let first: (typeof runs)[number] | undefined;
  if (repeatOf === undefined) {
    if (pendingFriability(view).some((id) => runs.find((r) => r.id === id)?.data['stream'] === entry['stream'])) {
      return refuse('TB14-REPEAT-PENDING', `${view.stepKey} waits for the repeat runs of its friability test; a new first run never replaces them`, ['INV-41', 'DI-29']);
    }
    if (entry['doubtful'] !== undefined && entry['doubtful'] !== true) return refuse('TB14-DOUBTFUL', 'Doubtful is stated only when it is so', ['DI-29']);
  } else {
    first = runs.find((r) => r.id === repeatOf);
    if (!first || first.data['run'] !== 1 || !pendingFriability(view).includes(first.id)) {
      return refuse('TB14-NOT-REPEATED', `${repeatOf} is not a first friability run of ${view.stepKey} waiting for its repeats`, ['PR-29', 'INV-41']);
    }
    if (entry['stream'] !== first.data['stream']) return refuse('TB14-NOT-REPEATED', 'A repeat run tests the same stream as its first run', ['PR-29']);
    if (entry['doubtful'] !== undefined) return refuse('TB14-DOUBTFUL', 'Only the first run is found doubtful', ['DI-29']);
    run = 1 + runs.filter((r) => r.data['repeatOf'] === first?.id).length + 1;
  }
  // A repeat run is part of its first run's test: it uses the rule sets the first run recorded (review 3c finding 5).
  const sets = first ? recorded(first.data['ruleSets']) : resolve(view, 'FRIABILITY', text(cfg['tabletType']));
  if (!first) {
    const bad = ruleSetRefusal(view, 'FRIABILITY', text(cfg['tabletType']), sets, 'TB14');
    if (bad) return bad;
  }
  const p = sets[0]?.params as FriabilityParams;
  const limit = friabilityLimit(sets, text(cfg['limitPercent'])) ?? dec(p.maxLossPercent);
  const tablets = Number(entry['tablets']);
  const initial = dec(String(entry['initialMass']));
  const final = dec(String(entry['finalMass']));
  if (final.isNegative() || final.gt(initial)) return refuse('TB14-MASS', 'The mass after the test lies between zero and the mass before it', ['PR-29']);
  const sample = friabilitySampleProblem(p, tablets, initial);
  if (sample) return refuse('TB14-SAMPLE', `The sample does not follow the rule set: ${sample}`, ['PR-29', 'IN-35']);
  if (Number(entry['rotations']) !== p.rotations) return refuse('TB14-ROTATIONS', `The drum turns ${p.rotations} times, not ${String(entry['rotations'])}`, ['PR-29']);
  const rpm = dec(String(entry['rpm']));
  if (rpm.lt(dec(p.rpmMin)) || rpm.gt(dec(p.rpmMax))) return refuse('TB14-RATE', `The drum turns at ${p.rpmMin} to ${p.rpmMax} rpm, not ${rpm.toString()}`, ['PR-29']);
  const c = commonOf(view, entry, 2, 'TB14');
  if (!c.ok) return c;
  const loss = friabilityLoss(initial, final);
  const reported = fixed(loss, p.lossDecimals);
  const broken = entry['broken'] === true;
  let outcome: Outcome;
  let mean: string | undefined;
  if (broken) outcome = 'FAIL';
  else if (run === 1) outcome = dec(reported).gt(limit) || entry['doubtful'] === true ? 'REPEAT' : 'PASS';
  else if (run < p.repeatRuns) outcome = 'REPEAT';
  else {
    const all = [first, ...runs.filter((r) => r.data['repeatOf'] === first?.id)].map((r) => friabilityLoss(dec(String(r?.data['initialMass'])), dec(String(r?.data['finalMass']))));
    const m = [...all, loss].reduce((a, v) => a.plus(v), Dec.ZERO).div(Dec.fromInteger(all.length + 1));
    mean = fixed(m, p.lossDecimals);
    outcome = dec(mean).lte(limit) ? 'PASS' : 'FAIL';
  }
  const data: Record<string, unknown> = {
    ...c.common.base,
    tablets: entry['tablets'],
    initialMass: entry['initialMass'],
    finalMass: entry['finalMass'],
    rotations: entry['rotations'],
    rpm: entry['rpm'],
    broken,
    ...(entry['doubtful'] === true ? { doubtful: true } : {}),
    ...(repeatOf !== undefined ? { repeatOf } : {}),
    run,
    ruleSets: sets.map((r) => ({ code: r.code, version: r.version })),
    averageWeight: fixed(initial.times(dec('1000')).div(Dec.fromInteger(tablets)), 2),
    loss: fixed(loss, 4),
    reported,
    limit: limit.toString(),
    ...(mean !== undefined ? { meanOfRuns: mean } : {}),
    result: outcome,
  };
  return { ok: true, t: { data, outcome, manual: c.common.manual, late: c.common.late, what: `Friability run ${run}` } };
}

function accept(view: HandlerView, entry: Entry): EntryResult {
  if (entry.kind !== 'FRIABILITY_RUN') return refuse('TB14-ENTRY', `${entry.kind} is not an entry of a friability step`, ['PR-29']);
  const r = acceptFriabilityRun(view, entry);
  return r.ok ? resultOf(view, r.t) : r;
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out: HandlerProblem[] = [];
  if (view.entries('FRIABILITY_RUN').length === 0) out.push(problem('TB14-NO-RUN', `${view.stepKey} has no friability run`, ['PR-29', 'IN-35']));
  if (pendingFriability(view).length > 0) out.push(problem('TB14-REPEAT-PENDING', `${view.stepKey} waits for the repeat runs of its friability test`, ['INV-41', 'PR-29']));
  return out;
}

/** Definition checks of a friability configuration (TB-14 and TB-11's `friability`): never looser than a rule set. */
export function friabilityConfigProblems(where: string, cfg: Readonly<Record<string, unknown>>, markets: readonly string[]): ConfigProblem[] {
  const sets = resolveRuleSets('FRIABILITY', markets, text(cfg['tabletType']) as TabletType | undefined, '9999-12-31');
  if (sets.length === 0 || uncoveredMarkets('FRIABILITY', markets, text(cfg['tabletType']) as TabletType | undefined, '9999-12-31').length > 0) return [configError('TB14-NO-RULE-SET', `${where}: no friability rule set covers ${String(cfg['tabletType'])} tablets`, ['PR-29', 'DI-10'])];
  const lim = text(cfg['limitPercent']);
  const tightest = friabilityLimit(sets, undefined);
  if (lim !== undefined && tightest && dec(lim).gt(tightest)) {
    return [configError('TB14-LOOSER', `${where}: the in-house limit of ${lim} % is looser than the rule sets' ${tightest.toString()} %`, ['PR-29', 'IN-35'])];
  }
  return [];
}

export function friabilityNominal(stream: string | undefined): (Record<string, unknown> & { kind: string })[] {
  return [
    {
      kind: 'FRIABILITY_RUN',
      instrument: 'TEST-FRB-01',
      capture: 'DEVICE',
      readings: ['00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000302'],
      tablets: 26,
      initialMass: '6.512',
      finalMass: '6.470',
      rotations: 100,
      rpm: '25.0',
      broken: false,
      ...(stream !== undefined ? { stream } : {}),
    },
  ];
}

export const TB14: BlockVersion = {
  type: 'TB-14',
  version: '1',
  title: 'Friability',
  edition: 'tablets',
  aliases: { tablets: 'TB-14' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: FRIABILITY_CONFIG,
  entrySummaries: FRIABILITY_SUMMARIES,
  dataSchema: { entries: FRIABILITY_ENTRIES },
  checkConfig: (phase, config, mbr) => friabilityConfigProblems(`Friability step ${phase.id}`, config, mbr.header.marketSet),
  handler: { acceptEntry: accept, beforePerform },
  exceptionRules: TEST_EXCEPTION_RULES,
  simulatorModel: { exceptionTypes: () => TEST_EXCEPTION_TYPES, nominalEntries: () => friabilityNominal(undefined) },
  goldenFixture: {
    description:
      'C-15 worked example: 26 tablets of 250.5 mg (6.512 g, the whole number nearest to 6.5 g), 100 rotations at 25.0 rpm, 6.470 g after: loss 0.645 %, reported 0.6 %, within 1.0 %; the IP rule set recorded',
    controls: ['IN-35', 'PR-29'],
    phase: { block: { type: 'TB-14', version: '1' }, config: { tabletType: 'UNCOATED' } },
    script: [{ entry: friabilityNominal(undefined)[0] as Record<string, unknown> & { kind: string } }],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/ipc/blocks.test.ts', 'apps/tablets-server/test/blocks/ipc/db-guards.test.ts'],
};
