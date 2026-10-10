/**
 * TB-12@1 Tablet weight IPC: group weight, uniformity of weight, in-house individual limits, weight variation by
 * acceptance value, subdivision of scored tablets (tablets spec B.2 TB-12, C-11 to C-14, E.2, E.3; Phase 3 slice 3c,
 * builder B). Controls IN-34, IN-35, PR-29, DI-10, DI-29, DI-32.
 *
 * Modes (configuration `mode`):
 *   GROUP        (a) n tablets weighed together (weighing GROUP: one group weight) or one by one (INDIVIDUAL): the total
 *                    against n x target weight +/- the in-house tolerance, with an optional tighter alert tolerance;
 *   UNIFORMITY   (b) 20 tablets one by one against the bound compendial rule sets (IP always, the batch's other markets
 *                    beside it, the in-house legacy table where the MBR opts in): the band chosen from the measured
 *                    average with exact boundaries, at most 2 outside it and none outside twice it, every rule set
 *                    passing (the tightest band governs; IN-34); refused where no rule set covers the tablet type;
 *   INDIVIDUAL   (c) n tablets one by one against target +/- an in-house % (never looser than the band of (b) at the
 *                    target weight, checked when the MBR is defined);
 *   CONTENT      (d) weight variation: 10 tablets and the assay of a representative sample give the acceptance value
 *                    per rule set; a first stage that does not pass asks for the second stage (WEIGHT_SECOND_STAGE: 20
 *                    more, evaluated on all 30 with the unit limit). The second stage is logic inside this block, never
 *                    a repeat or a void of the first (INV-41): the first stage's units are kept and counted;
 *   SUBDIVISION  (e) 30 parts of broken scored tablets against the average +/- 15 % (at most 1) and 25 % (none).
 * The evaluation records the rule-set codes and versions it used (DI-10) and every individual weight (DI-29). A failing
 * check raises IPC_CHECK_FAILED (the steps after it wait for a deviation; at a TB-11 step the output since the last
 * passing check is held); an alert-limit breach IPC_CHECK_ALERT. The database recomputes the same evaluation (tablets
 * 0891) and refuses an entry that differs.
 */
import { Dec } from '@ebmr/expr';
import {
  acceptanceValue,
  dec,
  groupEvaluation,
  individualEvaluation,
  statistics,
  subdivisionCriteria,
  sumOf,
  tightestBand,
  uniformityCriteria,
  type Verdict,
} from './ipc/calc.ts';
import {
  captureExceptions,
  commonOf,
  configError,
  decimals,
  ENTRY_ID,
  LATE_ENTRY,
  percentTierProblems,
  percentTiersOf,
  PERCENT_TIERS,
  POSITIVE_DECIMAL,
  problem,
  refuse,
  resolve,
  TABLET_TYPE,
  TEST_EXCEPTION_RULES,
  TEST_EXCEPTION_TYPES,
  TEST_FIELDS,
  testConfig,
  text,
  verdictExceptions,
  type BlockVersion,
  type ConfigProblem,
  type Entry,
  type EntryResult,
  type HandlerProblem,
  type HandlerView,
  type ObjectSchema,
  type Outcome,
} from './ipc/common.ts';
import { resolveRuleSets, RULE_SETS, type RuleSet, type TabletType, type SubdivisionParams, type UniformityParams, type WeightVariationParams } from './ipc/rule-sets.ts';

const CONTROLS = ['IN-34', 'IN-35', 'PR-29', 'DI-10', 'DI-29', 'DI-32'];
export const WEIGHT_MODES = ['GROUP', 'UNIFORMITY', 'INDIVIDUAL', 'CONTENT', 'SUBDIVISION'] as const;
const DEFAULT_TARGET_CONTENT = '100';

export const WEIGHT_CONFIG: ObjectSchema = {
  type: 'object',
  description: 'The weight check: its mode, the tablet type and the in-house limits the mode needs',
  fields: {
    mode: { type: 'string', enum: [...WEIGHT_MODES], description: 'GROUP (a), UNIFORMITY (b), INDIVIDUAL (c), CONTENT (d), SUBDIVISION (e)' },
    tabletType: TABLET_TYPE,
    targetWeightMg: { ...POSITIVE_DECIMAL, optional: true, description: 'Target tablet weight in mg (GROUP, INDIVIDUAL)' },
    n: { type: 'integer', min: 1, max: 100, optional: true, description: 'Tablets per check (GROUP, INDIVIDUAL)' },
    weighing: { type: 'string', enum: ['GROUP', 'INDIVIDUAL'], optional: true, description: 'GROUP: weighed together; INDIVIDUAL: one by one (GROUP mode)' },
    tolerance: { ...PERCENT_TIERS, optional: true, description: 'In-house tolerance of the group or average weight, % (GROUP)' },
    individual: { ...PERCENT_TIERS, optional: true, description: 'In-house individual limits around the target, % (INDIVIDUAL)' },
    legacyTable: { type: 'boolean', optional: true, default: false, description: 'Bind the in-house legacy weight table beside the compendial ones (UNIFORMITY; it never loosens)' },
    targetContent: { ...POSITIVE_DECIMAL, optional: true, description: 'Target content at manufacture, % of label claim (CONTENT; D: 100)' },
    lateEntry: LATE_ENTRY,
  },
};

const WEIGHTS = { type: 'array' as const, items: POSITIVE_DECIMAL, minItems: 1, maxItems: 100, description: 'Individual weights in mg, in order' };

export const WEIGHT_ENTRIES: Readonly<Record<string, ObjectSchema>> = {
  WEIGHT_CHECK: {
    type: 'object',
    description: 'A weight check: the tablets weighed (mg), and the assay for a weight variation',
    fields: {
      ...TEST_FIELDS,
      weights: { ...WEIGHTS, optional: true },
      groupWeight: { ...POSITIVE_DECIMAL, optional: true, description: 'The tablets weighed together, mg (GROUP weighing)' },
      assay: { ...POSITIVE_DECIMAL, optional: true, description: 'Assay of a representative sample, % of label claim (CONTENT)' },
      assayRef: { type: 'string', pattern: /^[A-Z0-9][A-Z0-9_-]{0,31}$/, optional: true, description: 'The laboratory result the assay comes from (CONTENT)' },
    },
  },
  WEIGHT_SECOND_STAGE: {
    type: 'object',
    description: 'The second stage of a weight variation: the further tablets of a first stage that did not pass',
    fields: { ...TEST_FIELDS, check: { type: 'string', pattern: ENTRY_ID, description: 'The first-stage WEIGHT_CHECK' }, weights: WEIGHTS },
  },
};

const ref = (r: RuleSet) => ({ code: r.code, version: r.version });

/** The rule sets a weight check of `cfg` is evaluated against (UNIFORMITY, CONTENT, SUBDIVISION). */
function setsFor(view: HandlerView, cfg: Readonly<Record<string, unknown>>): RuleSet[] {
  const type = text(cfg['tabletType']);
  switch (cfg['mode']) {
    case 'UNIFORMITY':
      return resolve(view, 'UNIFORMITY_OF_WEIGHT', type, cfg['legacyTable'] === true);
    case 'CONTENT':
      return resolve(view, 'WEIGHT_VARIATION', type);
    case 'SUBDIVISION':
      return resolve(view, 'SUBDIVISION', type);
    default:
      return [];
  }
}

export interface TestOutcome {
  data: Record<string, unknown>;
  outcome: Outcome;
  manual: boolean;
  late: boolean;
  what: string;
}

type Accepted = { ok: true; t: TestOutcome } | { ok: false; problems: HandlerProblem[] };

/** A WEIGHT_CHECK, evaluated (shared by TB-12 and TB-11). */
export function acceptWeightCheck(view: HandlerView, entry: Entry): Accepted {
  if (pendingFirstStages(view).some((p) => p.data['stream'] === entry['stream'])) {
    return refuse('TB12-SECOND-STAGE-PENDING', `${view.stepKey} waits for the second stage of its weight variation; a new first stage never replaces it`, ['INV-41', 'DI-29']);
  }
  const cfg = testConfig(view, 'weight');
  const mode = String(cfg['mode']);
  const ws = decimals(entry['weights']);
  const group = text(entry['groupWeight']);
  const groupWeighing = mode === 'GROUP' && cfg['weighing'] === 'GROUP';
  if (groupWeighing ? group === undefined || ws !== undefined : ws === undefined || group !== undefined) {
    return refuse('TB12-WEIGHTS', groupWeighing ? 'This check weighs its tablets together: give the group weight only' : 'This check weighs its tablets one by one: give the individual weights only', ['PR-29', 'DI-29']);
  }
  if (mode !== 'CONTENT' && (entry['assay'] !== undefined || entry['assayRef'] !== undefined)) return refuse('TB12-ASSAY', 'Only a weight variation (CONTENT) takes an assay', ['PR-29']);
  const sets = setsFor(view, cfg);
  if (['UNIFORMITY', 'CONTENT', 'SUBDIVISION'].includes(mode) && sets.length === 0) {
    return refuse('TB12-NO-RULE-SET', `No compendial rule set for ${mode.toLowerCase()} covers ${String(cfg['tabletType'])} tablets for this batch's markets; this mode cannot be used`, ['IN-34', 'DI-10']);
  }
  const want =
    mode === 'GROUP' || mode === 'INDIVIDUAL'
      ? Number(cfg['n'] ?? 0)
      : mode === 'UNIFORMITY'
        ? (sets[0]?.params as UniformityParams).units
        : mode === 'CONTENT'
          ? (sets[0]?.params as WeightVariationParams).firstUnits
          : (sets[0]?.params as SubdivisionParams).units;
  if (ws && ws.length !== want) return refuse('TB12-COUNT', `This check weighs ${want} tablets one by one, not ${ws.length}`, ['PR-29', 'IN-35']);
  const c = commonOf(view, entry, ws ? ws.length : 1, 'TB12');
  if (!c.ok) return c;
  let evaluation: Record<string, unknown>;
  let outcome: Outcome;
  switch (mode) {
    case 'GROUP': {
      const total = group !== undefined ? dec(group) : sumOf(ws ?? []);
      const g = groupEvaluation(total, want, dec(String(cfg['targetWeightMg'])), percentTiersOf(cfg['tolerance']) ?? { action: '0' });
      evaluation = ws ? { ...statistics(ws), ...g.evaluation } : g.evaluation;
      outcome = g.verdict;
      break;
    }
    case 'UNIFORMITY': {
      const u = uniformityCriteria(ws ?? [], sets);
      evaluation = { mode, ...statistics(ws ?? []), criteria: u.criteria };
      outcome = u.verdict;
      break;
    }
    case 'INDIVIDUAL': {
      const i = individualEvaluation(ws ?? [], dec(String(cfg['targetWeightMg'])), percentTiersOf(cfg['individual']) ?? { action: '0' });
      evaluation = { ...statistics(ws ?? []), ...i.evaluation };
      outcome = i.verdict;
      break;
    }
    case 'CONTENT': {
      const assay = text(entry['assay']);
      if (assay === undefined || text(entry['assayRef']) === undefined) return refuse('TB12-ASSAY', 'A weight variation needs the assay of a representative sample and its laboratory reference', ['PR-29', 'DI-10']);
      const target = dec(text(cfg['targetContent']) ?? DEFAULT_TARGET_CONTENT);
      const criteria = sets.map((r) => acceptanceValue(ws ?? [], dec(assay), target, r, false));
      evaluation = { mode, stage: 'FIRST', ...statistics(ws ?? []), assay: dec(assay).toString(), targetContent: target.toString(), criteria };
      outcome = criteria.every((x) => x.pass) ? 'PASS' : 'SECOND_STAGE';
      break;
    }
    default: {
      const s = subdivisionCriteria(ws ?? [], sets);
      evaluation = { mode: 'SUBDIVISION', ...statistics(ws ?? []), criteria: s.criteria };
      outcome = s.verdict;
    }
  }
  const data: Record<string, unknown> = {
    ...c.common.base,
    ...(ws ? { weights: entry['weights'] } : { groupWeight: group }),
    ...(mode === 'CONTENT' ? { assay: entry['assay'], assayRef: entry['assayRef'] } : {}),
    mode,
    ...(sets.length > 0 ? { ruleSets: sets.map(ref) } : {}),
    evaluation,
    result: outcome,
  };
  return { ok: true, t: { data, outcome, manual: c.common.manual, late: c.common.late, what: 'The weight check' } };
}

/** A first-stage weight variation of this step that waits for its second stage (no later stage names it). */
export function pendingFirstStages(view: HandlerView): { id: string; data: Record<string, unknown> }[] {
  const seconds = new Set(view.entries('WEIGHT_SECOND_STAGE').map((e) => e.data['check']));
  return view.entries('WEIGHT_CHECK').filter((e) => e.data['result'] === 'SECOND_STAGE' && !seconds.has(e.id)).map((e) => ({ id: e.id, data: e.data }));
}

/** A WEIGHT_SECOND_STAGE, evaluated on every unit of both stages (shared by TB-12 and TB-11). */
export function acceptSecondStage(view: HandlerView, entry: Entry): Accepted {
  const first = view.entries('WEIGHT_CHECK').find((e) => e.id === entry['check']);
  if (!first || first.data['result'] !== 'SECOND_STAGE') return refuse('TB12-NO-FIRST-STAGE', `${String(entry['check'])} is not a first-stage weight variation of ${view.stepKey} that asks for a second stage`, ['PR-29', 'INV-41']);
  if (view.entries('WEIGHT_SECOND_STAGE').some((e) => e.data['check'] === first.id)) return refuse('TB12-SECOND-STAGE-TWICE', `The second stage of ${first.id} is recorded already; a stage is never repeated`, ['INV-41', 'DI-29']);
  if (entry['stream'] !== first.data['stream']) return refuse('TB12-SECOND-STAGE-STREAM', `The second stage of ${first.id} comes from the same stream`, ['PR-29']);
  const codes = (first.data['ruleSets'] as { code: string; version: number }[]) ?? [];
  const sets = codes.map((x) => RULE_SETS.find((r) => r.code === x.code && r.version === x.version)).filter((r): r is RuleSet => r !== undefined);
  const p = sets[0]?.params as WeightVariationParams | undefined;
  const ws = decimals(entry['weights']) ?? [];
  if (!p || ws.length !== p.totalUnits - p.firstUnits) return refuse('TB12-COUNT', `The second stage weighs ${p ? p.totalUnits - p.firstUnits : '?'} more tablets one by one, not ${ws.length}`, ['PR-29', 'INV-41']);
  const c = commonOf(view, entry, ws.length, 'TB12');
  if (!c.ok) return c;
  const all = [...(decimals(first.data['weights']) ?? []), ...ws];
  const ev = first.data['evaluation'] as Record<string, unknown>;
  const assay = dec(String(ev['assay']));
  const target = dec(String(ev['targetContent']));
  const criteria = sets.map((r) => acceptanceValue(all, assay, target, r, true));
  const outcome: Verdict = criteria.every((x) => x.pass) ? 'PASS' : 'FAIL';
  const data: Record<string, unknown> = {
    ...c.common.base,
    check: first.id,
    weights: entry['weights'],
    ruleSets: codes,
    evaluation: { mode: 'CONTENT', stage: 'SECOND', ...statistics(all), assay: assay.toString(), targetContent: target.toString(), criteria },
    result: outcome,
  };
  return { ok: true, t: { data, outcome, manual: c.common.manual, late: c.common.late, what: 'The second stage of the weight variation' } };
}

/** The entry result of a test outcome at its step: exceptions for capture, lateness and a final verdict. */
export function resultOf(view: HandlerView, t: TestOutcome, extra: { exceptions?: NonNullable<Extract<EntryResult, { ok: true }>['exceptions']>; data?: Record<string, unknown> } = {}): EntryResult {
  const verdict = t.outcome === 'PASS' || t.outcome === 'ALERT' || t.outcome === 'FAIL' ? t.outcome : 'PENDING';
  const exceptions = [...(extra.exceptions ?? []), ...captureExceptions(view, { base: t.data, manual: t.manual, late: t.late }, t.what), ...verdictExceptions(view, verdict, t.what, text(t.data['stream']))];
  return { ok: true, data: { ...t.data, ...(extra.data ?? {}) }, ...(exceptions.length > 0 ? { exceptions } : {}), ...(t.manual ? { verificationRequired: true } : {}) };
}

function accept(view: HandlerView, entry: Entry): EntryResult {
  switch (entry.kind) {
    case 'WEIGHT_CHECK': {
      const r = acceptWeightCheck(view, entry);
      return r.ok ? resultOf(view, r.t) : r;
    }
    case 'WEIGHT_SECOND_STAGE': {
      const r = acceptSecondStage(view, entry);
      return r.ok ? resultOf(view, r.t) : r;
    }
    default:
      return refuse('TB12-ENTRY', `${entry.kind} is not an entry of a weight check step`, ['PR-29']);
  }
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out: HandlerProblem[] = [];
  if (view.entries('WEIGHT_CHECK').length === 0) out.push(problem('TB12-NO-CHECK', `${view.stepKey} has no weight check`, ['PR-29', 'IN-35']));
  if (pendingFirstStages(view).length > 0) out.push(problem('TB12-SECOND-STAGE-PENDING', `${view.stepKey} waits for the second stage of its weight variation`, ['INV-41', 'PR-29']));
  return out;
}

/**
 * Definition checks of a weight configuration (TB-12 and TB-11's `weight`): the members its mode needs; in-house
 * limits never looser than the compendial band at the target weight for the MBR's markets (IN-34); a compendial mode
 * only where a rule set covers the tablet type.
 */
export function weightConfigProblems(where: string, cfg: Readonly<Record<string, unknown>>, markets: readonly string[]): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const mode = String(cfg['mode']);
  const type = text(cfg['tabletType']) as TabletType | undefined;
  const need = (k: string) => cfg[k] === undefined && out.push(configError('TB12-CONFIG', `${where}: mode ${mode} needs ${k}`, ['PR-29', 'IN-34']));
  const deny = (k: string) => cfg[k] !== undefined && out.push(configError('TB12-CONFIG', `${where}: mode ${mode} takes no ${k}`, ['PR-29']));
  if (mode === 'GROUP') ['targetWeightMg', 'n', 'weighing', 'tolerance'].forEach(need);
  if (mode === 'INDIVIDUAL') ['targetWeightMg', 'n', 'individual'].forEach(need);
  if (mode !== 'GROUP') ['weighing', 'tolerance'].forEach(deny);
  if (mode !== 'INDIVIDUAL') deny('individual');
  if (mode !== 'UNIFORMITY') deny('legacyTable');
  if (mode !== 'CONTENT') deny('targetContent');
  if (!['GROUP', 'INDIVIDUAL'].includes(mode)) ['targetWeightMg', 'n'].forEach(deny);
  out.push(...percentTierProblems(`${where} tolerance`, percentTiersOf(cfg['tolerance']), 'TB12-CONFIG', ['PR-29']));
  out.push(...percentTierProblems(`${where} individual limits`, percentTiersOf(cfg['individual']), 'TB12-CONFIG', ['PR-29']));
  // Rule sets at the date the MBR is defined are not known; every shipped set starts in 2023, so the resolution uses
  // the latest effective versions (the run re-resolves at the entry's date).
  const date = '9999-12-31';
  const test = mode === 'UNIFORMITY' ? 'UNIFORMITY_OF_WEIGHT' : mode === 'CONTENT' ? 'WEIGHT_VARIATION' : mode === 'SUBDIVISION' ? 'SUBDIVISION' : undefined;
  if (test && resolveRuleSets(test, markets, type, date, cfg['legacyTable'] === true).length === 0) {
    out.push(configError('TB12-NO-RULE-SET', `${where}: no compendial rule set for this mode covers ${String(type)} tablets for the markets ${[...new Set([...markets, 'IN'])].join(', ')}`, ['IN-34', 'DI-10']));
  }
  const ind = percentTiersOf(cfg['individual']);
  const target = text(cfg['targetWeightMg']);
  if (mode === 'INDIVIDUAL' && ind && target !== undefined) {
    const band = tightestBand(resolveRuleSets('UNIFORMITY_OF_WEIGHT', markets, type, date, false), dec(target));
    if (band && dec(ind.action).gt(band)) {
      out.push(configError('TB12-LOOSER', `${where}: the in-house individual limit of ${ind.action} % is looser than the compendial band of ${band.toString()} % at ${target} mg (IN-34: never looser)`, ['IN-34']));
    }
  }
  return out;
}

export function weightNominal(cfg: Readonly<Record<string, unknown>>, stream: string | undefined, markets: readonly string[]): (Record<string, unknown> & { kind: string })[] {
  const mode = String(cfg['mode']);
  const target = text(cfg['targetWeightMg']) ?? '250.0';
  const sets = resolveRuleSets(mode === 'CONTENT' ? 'WEIGHT_VARIATION' : 'UNIFORMITY_OF_WEIGHT', markets, text(cfg['tabletType']) as TabletType, '9999-12-31');
  const n = mode === 'GROUP' || mode === 'INDIVIDUAL' ? Number(cfg['n'] ?? 1) : mode === 'UNIFORMITY' ? ((sets[0]?.params as UniformityParams | undefined)?.units ?? 20) : mode === 'CONTENT' ? 10 : 30;
  const ws = Array.from({ length: n }, () => target);
  const uuid = (i: number) => `00000000-0000-4000-8000-${(i + 1).toString().padStart(12, '0')}`;
  const common = { instrument: 'TEST-BAL-01', capture: 'DEVICE', ...(stream !== undefined ? { stream } : {}) };
  if (mode === 'GROUP' && cfg['weighing'] === 'GROUP') return [{ kind: 'WEIGHT_CHECK', ...common, readings: [uuid(0)], groupWeight: dec(target).times(Dec.fromInteger(n)).toString() }];
  return [{ kind: 'WEIGHT_CHECK', ...common, readings: ws.map((_, i) => uuid(i)), weights: ws, ...(mode === 'CONTENT' ? { assay: '100.0', assayRef: 'TEST-LIMS-01' } : {}) }];
}

function checkConfig(phase: Parameters<NonNullable<BlockVersion['checkConfig']>>[0], config: Parameters<NonNullable<BlockVersion['checkConfig']>>[1], mbr: Parameters<NonNullable<BlockVersion['checkConfig']>>[2]): ConfigProblem[] {
  return weightConfigProblems(`Weight check ${phase.id}`, config, mbr.header.marketSet);
}

export const TB12: BlockVersion = {
  type: 'TB-12',
  version: '1',
  title: 'Tablet weight IPC',
  edition: 'tablets',
  aliases: { tablets: 'TB-12' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: WEIGHT_CONFIG,
  dataSchema: { entries: WEIGHT_ENTRIES },
  checkConfig,
  handler: { acceptEntry: accept, beforePerform },
  exceptionRules: TEST_EXCEPTION_RULES,
  simulatorModel: {
    exceptionTypes: () => TEST_EXCEPTION_TYPES,
    nominalEntries: (input) => weightNominal(input.config, undefined, input.mbr.header.marketSet),
  },
  goldenFixture: {
    description:
      'Uniformity of weight of 20 uncoated tablets for an India batch: average 250.0 mg puts the IP band at 5 %; two tablets just outside it (262.6 and 237.4 mg) and none outside 10 % pass; the IP rule set and its version recorded',
    controls: ['IN-34', 'PR-29', 'DI-10'],
    phase: { block: { type: 'TB-12', version: '1' }, config: { mode: 'UNIFORMITY', tabletType: 'UNCOATED' } },
    script: [
      {
        entry: {
          kind: 'WEIGHT_CHECK',
          instrument: 'TEST-BAL-01',
          capture: 'DEVICE',
          readings: Array.from({ length: 20 }, (_, i) => `00000000-0000-4000-8000-${(i + 1).toString().padStart(12, '0')}`),
          weights: ['262.6', '237.4', ...Array.from({ length: 18 }, () => '250.0')],
        },
      },
    ],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/ipc/blocks.test.ts', 'apps/tablets-server/test/blocks/ipc/db-guards.test.ts'],
};

