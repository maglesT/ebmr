/**
 * TB-06@1 Dry granulation by roller compaction (tablets spec B.2 TB-06, D.2; Phase 3 slice 3d, builder B). Controls
 * PR-08, PR-29, IN-36 (a), (b), DI-31.
 *
 * The step runs on a roller compactor with its integrated mill. Process values go through G-06@1 (forming/common.ts):
 * roll force, roll gap, roll speed, feed-screw speed, deaeration vacuum and mill speed as setpoints read back and as
 * collected values with their acceptance limits (a value outside them raises PROCESS_VALUE_OUT_OF_LIMITS: the steps
 * after it wait for a deviation, PR-08; the database requires that exception too), alarms, the interface loss and the
 * recipe check.
 *
 * Its own entries:
 *   RUN_START       the compactor (a plant PROCESS unit with an open use for the batch; the database checks it, and that
 *                   it does not discharge streams into separate containers, so a hold reaches every container of it);
 *   FEED            pre-blend charged into the compactor (one unit for the whole step);
 *   RIBBON_CHECK    the ribbon's thickness, density and solid fraction (the ones the MBR names, each against its action
 *                   and alert limits) and its appearance; on the MBR's schedule (an interval and a grace, as TB-11's: due
 *                   one interval after the last check, or the run's start, and at the end of the run). A failing check
 *                   raises RIBBON_CHECK_FAILED, an alert-limit breach RIBBON_CHECK_ALERT; a check not made within the
 *                   grace after it fell due is missed: the next entry lists it (`missed`, at the database time of the
 *                   entry) and raises RIBBON_CHECK_MISSED. In the database the slice 1 container hold records the
 *                   ribbon check (stream RIBBON of the compactor: PASS, FAIL or MISSED), which holds every container of
 *                   the compactor filled since the last passing check (PR-29), and the server's sweeper records an
 *                   overdue check without waiting for an entry;
 *   SCREEN_CHECK    the mill screen before and after use, as TB-02's rule (IN-36 (b)): a screen of the MBR with its
 *                   approved aperture, checks alternating per screen, a damaged screen never checked or used again; an
 *                   after-use check that finds it damaged names in `held` the granule outputs milled through it since its
 *                   last intact check and raises SCREEN_INTEGRITY_FAILED (in the database: FAIL on stream MILL, holding
 *                   the compactor's containers since the last intact check); a check needs a second person;
 *   GRANULE_OUTPUT  granules and fines discharged, milled through a screen in use;
 *   FINES_RECYCLED  fines fed back into the compactor, only where the MBR allows a recycle, never more fines than were
 *                   discharged, and in total never above the MBR's percentage of the pre-blend fed (refused: kept within
 *                   the limit);
 *   RUN_END         the run ends (the ribbon check falls due for the end of the run);
 *   YIELD           after the run: feed, granules, fines, recycled fines and the stage yield (C-09, D.2: granules and the
 *                   fines not recycled over the pre-blend fed, two decimals), against the MBR's yield limits
 *                   (COMPACTION_YIELD_OUT_OF_RANGE: a deviation).
 * Before PERFORMED: G-06's completeness, the run ended with an end-of-run ribbon check, every screen checked after use,
 * granules discharged and the yield recorded. The database holds all of it (tablets 0931, 0932).
 */
import { Dec } from '@ebmr/expr';
import { screensOf, screenStates } from './tb-02.ts';
import { dec, fixed, judge, worst, type Verdict } from './ipc/calc.ts';
import {
  acceptProcessEntry,
  CODE,
  configError,
  DURATION,
  durationUs,
  EQUIPMENT_CODE,
  isProcessKind,
  isRecord,
  POSITIVE_DECIMAL,
  POSITIVE_QUANTITY,
  PROCESS_CONFIG_FIELDS,
  PROCESS_ENTRIES,
  PROCESS_EXCEPTION_RULES,
  processBeforePerform,
  processConfigProblems,
  processNominalEntries,
  problem,
  quantityOf,
  refuse,
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
  type JsonValue,
  type MbrContent,
  type ObjectSchema,
  type PhaseNode,
  type Quantity,
} from './forming/common.ts';

const CONTROLS = ['PR-08', 'PR-29', 'IN-36', 'DI-31'];
const HUNDRED = dec('100');

/** The ribbon parameters an MBR may examine, in the order they are evaluated. */
export const RIBBON_PARAMETERS = ['thickness', 'density', 'solidFraction'] as const;
type RibbonParameter = (typeof RIBBON_PARAMETERS)[number];

/** The stream names of the compactor's check series in the slice 1 container hold. */
export const RIBBON_STREAM = 'RIBBON';
export const MILL_STREAM = 'MILL';

type Config = Readonly<Record<string, unknown>>;

export interface RibbonMissed {
  stream: string;
  test: string;
  by: 'TIME';
  dueUs: string;
}

function ribbonOf(config: Config): Record<string, unknown> | undefined {
  const r = config['ribbon'];
  return isRecord(r) ? r : undefined;
}

export function ribbonParameters(config: Config): RibbonParameter[] {
  const r = ribbonOf(config);
  return r ? RIBBON_PARAMETERS.filter((p) => isRecord(r[p])) : [];
}

const marksRibbon = (e: EntryRecord): boolean => Array.isArray(e.data['missed']) && (e.data['missed'] as RibbonMissed[]).some((m) => m.stream === RIBBON_STREAM);

/**
 * When the ribbon check of the run in `entries` falls due (microseconds), or undefined when nothing is due (before the
 * run's start; after an end-of-run check). Due one interval after the last check, or the last entry that marked it
 * missed, or the run's start; at the latest at the end of the run.
 */
export function ribbonDue(entries: readonly EntryRecord[], config: Config): bigint | undefined {
  const start = entries.find((e) => e.kind === 'RUN_START');
  const every = durationUs(ribbonOf(config)?.['every']);
  if (!start || every === undefined) return undefined;
  let base = start.recordedAt;
  for (const e of entries) if ((e.kind === 'RIBBON_CHECK' || marksRibbon(e)) && e.recordedAt > base) base = e.recordedAt;
  const end = entries.find((e) => e.kind === 'RUN_END');
  if (end && base >= end.recordedAt) return undefined;
  const due = base + every;
  return end && end.recordedAt < due ? end.recordedAt : due;
}

/** The ribbon check missed at `nowUs` (overdue beyond the grace), as the entry lists it. */
export function ribbonOverdue(entries: readonly EntryRecord[], config: Config, nowUs: bigint): RibbonMissed[] {
  const due = ribbonDue(entries, config);
  const grace = durationUs(ribbonOf(config)?.['grace']) ?? 0n;
  return due !== undefined && nowUs > due + grace ? [{ stream: RIBBON_STREAM, test: 'RIBBON', by: 'TIME', dueUs: due.toString() }] : [];
}

function held(view: HandlerView, type: string, title: string, category: ExceptionDraft['category'], item?: string): ExceptionDraft {
  return {
    type,
    title: `${title} at ${view.stepKey}: the steps after it wait for a deviation`,
    controls: ['PR-29', 'IN-36'],
    severity: 'ACTION',
    category,
    blocks: 'DOWNSTREAM',
    until: 'DEVIATION',
    deviationRequired: true,
    ...(item !== undefined ? { item } : {}),
  };
}

const sameAperture = (a: Quantity, b: Quantity): boolean =>
  a.unit === b.unit && Dec.isValid(a.value) && Dec.isValid(b.value) && Dec.parse(a.value).eq(Dec.parse(b.value));

/** The unit the step's quantities are in: that of its first FEED. */
const feedUnit = (view: HandlerView): string | undefined => quantityOf(view.entries('FEED')[0]?.data['quantity'])?.unit;

function total(list: readonly EntryRecord[], member: string): Dec {
  return list.reduce((a, e) => a.plus(dec(quantityOf(e.data[member])?.value ?? '0')), Dec.ZERO);
}

function acceptRibbon(view: HandlerView, entry: Entry): { ok: true; data: Record<string, unknown>; verdict: Verdict } | { ok: false; problems: HandlerProblem[] } {
  const r = ribbonOf(view.config);
  const params = ribbonParameters(view.config);
  if (!r) return refuse('TB06-NO-RIBBON', `${view.phase.id} has no ribbon checks in its MBR`, ['PR-29']);
  if (RIBBON_PARAMETERS.filter((p) => entry[p] !== undefined).join() !== params.join()) {
    return refuse('TB06-RIBBON-PARAMETERS', `A ribbon check gives exactly the parameters the MBR examines (${params.join(', ')})`, ['PR-29', 'IN-36']);
  }
  const evaluation: Record<string, unknown> = {};
  const verdicts: Verdict[] = [];
  for (const p of params) {
    const v = judge(dec(String(entry[p])), tiersOf((r[p])) ?? { action: {} });
    evaluation[p] = v;
    verdicts.push(v);
  }
  const appearance = String(entry['appearance']);
  evaluation['appearance'] = appearance === 'COMPLIES' ? 'PASS' : 'FAIL';
  verdicts.push(evaluation['appearance'] as Verdict);
  const verdict = worst(verdicts);
  const data: Record<string, unknown> = { ...Object.fromEntries(params.map((p) => [p, entry[p]])), appearance, evaluation, result: verdict, recordedBy: view.actor.id };
  return { ok: true, data, verdict };
}

function acceptScreen(view: HandlerView, entry: Entry): EntryResult {
  const screen = String(entry['screen']);
  const cfg = screensOf(view.config).find((s) => s.id === screen);
  if (!cfg) return refuse('TB06-SCREEN', `${screen} is not a mill screen the MBR lists for ${view.phase.id}`, ['IN-36', 'PR-23']);
  const aperture = quantityOf(entry['aperture']) ?? { value: '', unit: '' };
  if (!sameAperture(aperture, cfg.aperture)) {
    return refuse('TB06-APERTURE', `Screen ${screen} reads ${aperture.value} ${aperture.unit}; the MBR approves ${cfg.aperture.value} ${cfg.aperture.unit}`, ['IN-36', 'PR-23']);
  }
  const state = screenStates(view).get(screen) ?? 'IDLE';
  if (state === 'DAMAGED') return refuse('TB06-SCREEN-DAMAGED', `Screen ${screen} was found damaged and is never used again`, ['IN-36', 'PR-23']);
  const when = String(entry['when']);
  if (when === 'BEFORE' && state === 'IN_USE') return refuse('TB06-CHECK-ORDER', `Screen ${screen} is in use; check it after use first`, ['IN-36']);
  if (when === 'AFTER' && state !== 'IN_USE') return refuse('TB06-CHECK-ORDER', `Screen ${screen} was not checked before use`, ['IN-36']);
  const damaged = entry['result'] === 'DAMAGED';
  const data: Record<string, unknown> = { screen, aperture: { value: aperture.value, unit: aperture.unit }, when, result: entry['result'], checkedBy: view.actor.id };
  const exceptions: ExceptionDraft[] = [];
  if (damaged && when === 'AFTER') {
    const intact = view.entries('SCREEN_CHECK').filter((e) => e.data['screen'] === screen && e.data['result'] === 'INTACT');
    const since = intact.at(-1)?.recordedSeq ?? -1;
    const out = view.entries('GRANULE_OUTPUT').filter((e) => e.data['screen'] === screen && e.recordedSeq > since).map((e) => e.id);
    data['held'] = out;
    exceptions.push(held(view, 'SCREEN_INTEGRITY_FAILED', `Mill screen ${screen} was found damaged after use; the granules milled through it since its last intact check (${out.length > 0 ? out.join(', ') : 'none'}) are held`, 'DEVIATION_OR_OVERRIDE', screen));
  } else if (damaged) {
    exceptions.push({
      type: 'SCREEN_DAMAGED',
      title: `Mill screen ${screen} of ${view.stepKey} was found damaged before use: it is not used`,
      controls: ['IN-36', 'PR-23'],
      severity: 'ALERT',
      category: 'DEVIATION_OR_OVERRIDE',
      blocks: 'NONE',
      item: screen,
    });
  }
  return { ok: true, data, verificationRequired: true, ...(exceptions.length > 0 ? { exceptions } : {}) };
}

function yieldOf(view: HandlerView): Record<string, unknown> {
  const unit = feedUnit(view) ?? '';
  const feed = total(view.entries('FEED'), 'quantity');
  const granules = total(view.entries('GRANULE_OUTPUT'), 'granules');
  const fines = total(view.entries('GRANULE_OUTPUT'), 'fines');
  const recycled = total(view.entries('FINES_RECYCLED'), 'quantity');
  const net = granules.plus(fines).minus(recycled);
  const percent = feed.isZero() ? '0.00' : fixed(net.times(HUNDRED).div(feed), 2);
  const limits = view.config['yield'];
  const out: Record<string, unknown> = {
    unit,
    feed: feed.toString(),
    granules: granules.toString(),
    fines: fines.toString(),
    recycled: recycled.toString(),
    net: net.toString(),
    yieldPercent: percent,
    recordedBy: view.actor.id,
  };
  if (isRecord(limits)) {
    const p = dec(percent);
    out['withinLimits'] = !((typeof limits['min'] === 'string' && p.lt(dec(limits['min']))) || (typeof limits['max'] === 'string' && p.gt(dec(limits['max']))));
  }
  return out;
}

function accept(view: HandlerView, entry: Entry): EntryResult {
  if (isProcessKind(entry.kind)) return acceptProcessEntry(view, entry);
  const entries = view.entries();
  const started = entries.some((e) => e.kind === 'RUN_START');
  const ended = entries.some((e) => e.kind === 'RUN_END');
  const yielded = entries.some((e) => e.kind === 'YIELD');
  if (entry.kind === 'RUN_START') {
    if (started) return refuse('TB06-TWICE', `${view.stepKey} has started its run already; a new run is a new step`, ['PR-29']);
    return { ok: true, data: { press: entry['press'], recordedBy: view.actor.id } };
  }
  if (!['FEED', 'RIBBON_CHECK', 'SCREEN_CHECK', 'GRANULE_OUTPUT', 'FINES_RECYCLED', 'RUN_END', 'YIELD'].includes(entry.kind)) {
    return refuse('TB06-ENTRY', `${entry.kind} is not an entry of a roller compaction step`, ['PR-29']);
  }
  if (!started && entry.kind !== 'SCREEN_CHECK') return refuse('TB06-NOT-STARTED', `${view.stepKey} has not started its run`, ['PR-29']);
  if (ended && ['FEED', 'FINES_RECYCLED', 'RUN_END'].includes(entry.kind)) return refuse('TB06-ENDED', `The run of ${view.stepKey} has ended`, ['PR-29']);
  if (yielded && ['GRANULE_OUTPUT', 'YIELD'].includes(entry.kind)) return refuse('TB06-AFTER-YIELD', `The yield of ${view.stepKey} is recorded: nothing more is discharged`, ['PR-29', 'DI-29']);
  const missed = started ? ribbonOverdue(entries, view.config, view.nowUs) : [];
  const exceptions: ExceptionDraft[] = missed.length > 0 ? [held(view, 'RIBBON_CHECK_MISSED', 'A ribbon check was missed; the compactor output since the last passing check is held', 'TIME_LIMIT', RIBBON_STREAM)] : [];
  const withMissed = (data: Record<string, unknown>): Record<string, unknown> => ({ ...data, ...(missed.length > 0 ? { missed } : {}) });
  const unit = feedUnit(view);
  let data: Record<string, unknown>;
  switch (entry.kind) {
    case 'FEED': {
      const q = quantityOf(entry['quantity']);
      if (!q || (unit !== undefined && q.unit !== unit)) return refuse('TB06-UNIT', `The step's quantities are in ${unit ?? 'one unit'}`, ['PR-29', 'DI-29']);
      data = { quantity: { value: q.value, unit: q.unit }, recordedBy: view.actor.id };
      break;
    }
    case 'RIBBON_CHECK': {
      const r = acceptRibbon(view, entry);
      if (!r.ok) return r;
      data = r.data;
      if (r.verdict === 'FAIL') exceptions.push(held(view, 'RIBBON_CHECK_FAILED', 'A ribbon check failed its limits; the compactor output since the last passing check is held', 'OUT_OF_LIMIT', RIBBON_STREAM));
      if (r.verdict === 'ALERT') {
        exceptions.push({ type: 'RIBBON_CHECK_ALERT', title: `A ribbon check at ${view.stepKey} is inside its action limits but outside its alert limits`, controls: ['PR-29'], severity: 'ALERT', category: 'OUT_OF_LIMIT', blocks: 'NONE', item: RIBBON_STREAM });
      }
      break;
    }
    case 'SCREEN_CHECK': {
      const r = acceptScreen(view, entry);
      if (!r.ok) return r;
      return { ...r, data: withMissed(r.data), exceptions: [...exceptions, ...(r.exceptions ?? [])] };
    }
    case 'GRANULE_OUTPUT': {
      const screen = String(entry['screen']);
      if ((screenStates(view).get(screen) ?? 'IDLE') !== 'IN_USE') return refuse('TB06-NO-PRE-CHECK', `Mill screen ${screen} has no intact check before this use; check it first`, ['IN-36', 'INV-24']);
      const g = quantityOf(entry['granules']);
      const f = quantityOf(entry['fines']);
      if (unit === undefined) return refuse('TB06-NO-FEED', `${view.stepKey} has fed no pre-blend`, ['PR-29']);
      if (!g || !f || g.unit !== unit || f.unit !== unit) return refuse('TB06-UNIT', `The step's quantities are in ${unit}`, ['PR-29', 'DI-29']);
      data = { screen, granules: { value: g.value, unit }, fines: { value: f.value, unit }, recordedBy: view.actor.id };
      break;
    }
    case 'FINES_RECYCLED': {
      const r = view.config['finesRecycle'];
      if (!isRecord(r) || typeof r['maxPercent'] !== 'string') return refuse('TB06-RECYCLE-NOT-ALLOWED', `The MBR allows no fines recycle at ${view.phase.id}`, ['PR-29', 'IN-36']);
      const q = quantityOf(entry['quantity']);
      if (!q || unit === undefined || q.unit !== unit) return refuse('TB06-UNIT', `The step's quantities are in ${unit ?? 'the unit of its feed'}`, ['PR-29', 'DI-29']);
      const recycled = total(view.entries('FINES_RECYCLED'), 'quantity').plus(dec(q.value));
      if (recycled.gt(total(view.entries('GRANULE_OUTPUT'), 'fines'))) return refuse('TB06-FINES-QUANTITY', 'More fines would be recycled than were discharged', ['PR-29', 'DI-29']);
      const feed = total(view.entries('FEED'), 'quantity');
      if (recycled.times(HUNDRED).gt(dec(r['maxPercent']).times(feed))) {
        return refuse('TB06-FINES-LIMIT', `The fines recycled would come to more than the MBR's ${r['maxPercent']} % of the pre-blend fed`, ['PR-29', 'IN-36']);
      }
      data = { quantity: { value: q.value, unit }, recycledPercent: fixed(recycled.times(HUNDRED).div(feed), 2), recordedBy: view.actor.id };
      break;
    }
    case 'RUN_END':
      data = { recordedBy: view.actor.id };
      break;
    default: {
      if (!ended) return refuse('TB06-RUNNING', `The run of ${view.stepKey} has not ended: the yield comes after it`, ['PR-29']);
      if (unit === undefined) return refuse('TB06-NO-FEED', `${view.stepKey} has fed no pre-blend`, ['PR-29']);
      data = yieldOf(view);
      if (data['withinLimits'] === false) exceptions.push(held(view, 'COMPACTION_YIELD_OUT_OF_RANGE', `The stage yield of ${String(data['yieldPercent'])} % is outside the MBR's limits`, 'OUT_OF_LIMIT'));
    }
  }
  return { ok: true, data: withMissed(data), ...(exceptions.length > 0 ? { exceptions } : {}) };
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out = processBeforePerform(view);
  const entries = view.entries();
  const end = entries.find((e) => e.kind === 'RUN_END');
  if (!end) return [...out, problem('TB06-RUNNING', `The run of ${view.stepKey} has not ended`, ['PR-29'])];
  if (!entries.some((e) => e.kind === 'RIBBON_CHECK' && e.recordedAt >= end.recordedAt)) out.push(problem('TB06-END-CHECK', `${view.stepKey} has no end-of-run ribbon check`, ['PR-29']));
  const open = [...screenStates(view)].filter(([, s]) => s === 'IN_USE').map(([k]) => k);
  if (open.length > 0) out.push(problem('TB06-AFTER-CHECK-MISSING', `Check mill screen ${open.join(', ')} after use before the step closes`, ['IN-36', 'INV-24']));
  if (view.entries('GRANULE_OUTPUT').length === 0) out.push(problem('TB06-NOTHING-DISCHARGED', `${view.stepKey} has discharged no granules`, ['PR-29']));
  if (view.entries('YIELD').length === 0) out.push(problem('TB06-NO-YIELD', `Record the yield of ${view.stepKey} first`, ['PR-29']));
  return out;
}

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const out = processConfigProblems(phase, config, mbr);
  const where = `Roller compaction step ${phase.id}`;
  if (!phase.equipment.some((q) => q.use === 'USE')) out.push(configError('TB06-NO-EQUIPMENT', `${where} names no roller compactor it uses`, ['PR-23']));
  const r = ribbonOf(config);
  const every = durationUs(r?.['every']);
  const grace = durationUs(r?.['grace']);
  if (!r || every === undefined || every <= 0n || grace === undefined || grace <= 0n) out.push(configError('TB06-RIBBON', `${where} has no ribbon check interval and grace above zero`, ['PR-29']));
  if (r && text(r['qrmRef']) === undefined) out.push(configError('TB06-QRM', `${where} names no risk assessment for its ribbon check frequency`, ['PR-07']));
  if (r && ribbonParameters(config).length === 0) out.push(configError('TB06-RIBBON', `${where} examines no ribbon thickness, density or solid fraction`, ['PR-29']));
  for (const p of ribbonParameters(config)) out.push(...tierProblems(`${where} ribbon ${p}`, tiersOf((r as Record<string, unknown>)[p]), 'TB06-RIBBON', ['PR-29']));
  const ids = screensOf(config).map((s) => s.id);
  if (new Set(ids).size !== ids.length) out.push(configError('TB06-DUPLICATE-SCREEN', `${where} lists a mill screen twice`, ['IN-36']));
  const f = config['finesRecycle'];
  if (isRecord(f) && (typeof f['maxPercent'] !== 'string' || !Dec.isValid(f['maxPercent']) || dec(f['maxPercent']).gt(HUNDRED))) {
    out.push(configError('TB06-RECYCLE', `${where}: the fines recycle limit is a percentage above zero and at most 100`, ['PR-29']));
  }
  const y = config['yield'];
  if (isRecord(y) && typeof y['min'] === 'string' && typeof y['max'] === 'string' && dec(y['min']).gt(dec(y['max']))) out.push(configError('TB06-YIELD', `${where}: the yield limits run from ${y['min']} to ${y['max']}`, ['PR-29']));
  return out;
}

const APERTURE: ObjectSchema = {
  type: 'object',
  description: 'Screen aperture: decimal text in micrometres, millimetres or as a mesh number',
  fields: { value: { type: 'decimal', min: '0', minExclusive: true, description: 'Aperture or mesh number' }, unit: { type: 'string', enum: ['um', 'mm', 'mesh'], description: 'um, mm or mesh' } },
};

const NON_NEGATIVE_QUANTITY: ObjectSchema = {
  type: 'object',
  description: 'A quantity: decimal text (zero or more) and its unit',
  fields: { value: { type: 'decimal', min: '0', description: 'Decimal written as text' }, unit: { type: 'string', description: 'UCUM unit' } },
};

const RIBBON_LIMIT = (description: string): ObjectSchema => ({ ...TIERS, optional: true, description });

export const TB06: BlockVersion = {
  type: 'TB-06',
  version: '1',
  title: 'Dry granulation by roller compaction',
  edition: 'tablets',
  aliases: { tablets: 'TB-06' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'Process values through G-06, the ribbon checks and their schedule, the mill screens, the fines recycle limit and the yield limits',
    fields: {
      ...PROCESS_CONFIG_FIELDS,
      ribbon: {
        type: 'object',
        description: 'Ribbon checks: interval, grace, the risk assessment of the frequency (PR-07) and the parameters examined with their limits',
        fields: {
          every: { ...DURATION, description: 'Interval between ribbon checks' },
          grace: { ...DURATION, description: 'A check is missed when it is this long overdue' },
          qrmRef: { type: 'string', pattern: /^[A-Z0-9][A-Z0-9_./-]{0,63}$/, optional: true, description: 'The risk assessment the frequency rests on (required: TB06-QRM)' },
          thickness: RIBBON_LIMIT('Ribbon thickness limits, mm'),
          density: RIBBON_LIMIT('Ribbon envelope density limits, g/cm3'),
          solidFraction: RIBBON_LIMIT('Ribbon solid fraction limits, %'),
        },
      },
      screens: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        description: 'Mill screens the step may use',
        items: { type: 'object', description: 'One screen', fields: { id: { type: 'string', pattern: CODE, description: 'Screen identification as scanned' }, aperture: APERTURE } },
      },
      finesRecycle: {
        type: 'object',
        optional: true,
        description: 'The MBR allows fines to be fed back, up to this percentage of the pre-blend fed',
        fields: { maxPercent: { ...POSITIVE_DECIMAL, description: 'Maximum recycled fines, % of the pre-blend fed' } },
      },
      yield: {
        type: 'object',
        optional: true,
        description: 'Stage yield limits, %',
        fields: { min: { type: 'decimal', optional: true, description: 'Lowest yield, %' }, max: { type: 'decimal', optional: true, description: 'Highest yield, %' } },
      },
    },
  },
  dataSchema: {
    entries: {
      ...PROCESS_ENTRIES,
      RUN_START: { type: 'object', description: 'The run starts on the compactor', fields: { press: { type: 'string', pattern: EQUIPMENT_CODE, description: 'The roller compactor (plant PROCESS unit in use for the batch)' } } },
      FEED: { type: 'object', description: 'Pre-blend charged into the compactor', fields: { quantity: POSITIVE_QUANTITY } },
      RIBBON_CHECK: {
        type: 'object',
        description: 'A ribbon check: the parameters the MBR examines and the appearance',
        fields: {
          thickness: { ...POSITIVE_DECIMAL, optional: true, description: 'mm' },
          density: { ...POSITIVE_DECIMAL, optional: true, description: 'g/cm3' },
          solidFraction: { ...POSITIVE_DECIMAL, optional: true, description: '%' },
          appearance: { type: 'string', enum: ['COMPLIES', 'DOES_NOT_COMPLY'], description: 'Ribbon appearance (no cracks, lamination or uncompacted edges)' },
        },
      },
      SCREEN_CHECK: {
        type: 'object',
        description: 'Integrity of a mill screen before or after use',
        fields: {
          screen: { type: 'string', pattern: CODE, description: 'Screen identification as scanned' },
          aperture: APERTURE,
          when: { type: 'string', enum: ['BEFORE', 'AFTER'], description: 'Before or after use' },
          result: { type: 'string', enum: ['INTACT', 'DAMAGED'], description: 'What the check found' },
        },
      },
      GRANULE_OUTPUT: {
        type: 'object',
        description: 'Granules and fines discharged, milled through a screen',
        fields: { screen: { type: 'string', pattern: CODE, description: 'Mill screen in use' }, granules: NON_NEGATIVE_QUANTITY, fines: NON_NEGATIVE_QUANTITY },
      },
      FINES_RECYCLED: { type: 'object', description: 'Fines fed back into the compactor', fields: { quantity: POSITIVE_QUANTITY } },
      RUN_END: { type: 'object', description: 'The run ends: the ribbon check falls due for the end of the run', fields: {} },
      YIELD: { type: 'object', description: 'The stage yield, computed from the step\'s entries', fields: {} },
    },
  },
  checkConfig,
  handler: { acceptEntry: accept, beforePerform },
  exceptionRules: [
    ...PROCESS_EXCEPTION_RULES,
    { type: 'RIBBON_CHECK_FAILED', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A ribbon check failed its action limits or its appearance', controls: ['PR-29', 'IN-36'] },
    { type: 'RIBBON_CHECK_ALERT', category: 'OUT_OF_LIMIT', severity: 'ALERT', summary: 'A ribbon check outside its alert limits', controls: ['PR-29'] },
    { type: 'RIBBON_CHECK_MISSED', category: 'TIME_LIMIT', severity: 'ACTION', summary: 'A ribbon check was missed (overdue beyond its grace)', controls: ['PR-29', 'IN-36'] },
    { type: 'SCREEN_INTEGRITY_FAILED', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'A mill screen found damaged after use; the granules since its last intact check are held', controls: ['IN-36', 'INV-24', 'PR-29'] },
    { type: 'SCREEN_DAMAGED', category: 'DEVIATION_OR_OVERRIDE', severity: 'ALERT', summary: 'A mill screen found damaged before use', controls: ['IN-36', 'PR-23'] },
    { type: 'COMPACTION_YIELD_OUT_OF_RANGE', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'The stage yield outside the MBR limits', controls: ['PR-29'] },
  ],
  simulatorModel: {
    exceptionTypes: () => [...PROCESS_EXCEPTION_RULES.map((r) => r.type), 'RIBBON_CHECK_FAILED', 'RIBBON_CHECK_ALERT', 'RIBBON_CHECK_MISSED', 'SCREEN_INTEGRITY_FAILED', 'SCREEN_DAMAGED', 'COMPACTION_YIELD_OUT_OF_RANGE'],
    // Nominal: G-06's values, the run on the test compactor, the first screen checked intact before and after, one
    // feed, a ribbon check in the middle of every limit, one discharge, the end of the run with its check, the yield.
    nominalEntries: (input) => {
      const cfg = input.config as Config;
      const s = screensOf(cfg)[0];
      const r = ribbonOf(cfg);
      const mid = (p: RibbonParameter) => {
        const t = tiersOf(r?.[p]);
        const lo = dec(t?.action.min ?? t?.action.max ?? '1');
        const hi = dec(t?.action.max ?? t?.action.min ?? '1');
        return lo.plus(hi).div(dec('2')).toString();
      };
      const ribbon = { kind: 'RIBBON_CHECK', ...Object.fromEntries(ribbonParameters(cfg).map((p) => [p, mid(p)])), appearance: 'COMPLIES' };
      const screen = (when: string) => (s ? [{ kind: 'SCREEN_CHECK', screen: s.id, aperture: s.aperture, when, result: 'INTACT' }] : []);
      return [
        ...processNominalEntries(input),
        { kind: 'RUN_START', press: 'TEST-RC-01' },
        ...screen('BEFORE'),
        { kind: 'FEED', quantity: { value: '50.000', unit: 'kg' } },
        ribbon,
        ...(s ? [{ kind: 'GRANULE_OUTPUT', screen: s.id, granules: { value: '48.500', unit: 'kg' }, fines: { value: '1.200', unit: 'kg' } }] : []),
        { kind: 'RUN_END' },
        ribbon,
        ...screen('AFTER'),
        { kind: 'YIELD' },
      ];
    },
  },
  goldenFixture: {
    description:
      'A roller compaction: roll force read back and roll gap collected from the compactor; mill screen RS-15 checked intact before and after; 50 kg of pre-blend fed, ribbon checks at 20 and 40 min (every 30 min, grace 5 min) and at the end; 48.0 kg granules and 1.8 kg fines, 1.0 kg of the fines recycled (2 % of the feed, limit 10 %); yield (48.0 + 1.8 - 1.0) / 50.0 = 97.60 %, inside 95 to 100 %',
    controls: ['PR-29'],
    phase: {
      block: { type: 'TB-06', version: '1' },
      config: {
        setpoints: [{ tag: 'roller.force_kN', value: '45.00', unit: 'kN', tolerance: '1.00' }],
        actuals: [{ tag: 'roller.gap_mm', unit: 'mm', min: '2.50', max: '3.50' }],
        maxAgeSeconds: 3600,
        ribbon: {
          every: { value: '30', unit: 'min' },
          grace: { value: '5', unit: 'min' },
          qrmRef: 'QRM-RC-01',
          thickness: { action: { min: '2.50', max: '3.50' }, alert: { min: '2.70', max: '3.30' } },
          solidFraction: { action: { min: '60', max: '75' } },
        },
        screens: [{ id: 'RS-15', aperture: { value: '1.5', unit: 'mm' } }],
        finesRecycle: { maxPercent: '10' },
        yield: { min: '95.00', max: '100.00' },
      },
      equipment: [{ ref: 'COMPACTOR', use: 'USE' }],
      system: { kind: 'PLC', ref: 'SYS-RC', recipe: 'RCP-RC', recipeVersion: '2' },
    },
    script: [
      { entry: { kind: 'RECIPE_CHECK', recipe: 'RCP-RC', recipeVersion: '2' } },
      { entry: { kind: 'SETPOINT_READBACK', tag: 'roller.force_kN', value: '45.20', unit: 'kN', source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000061', quality: 'GOOD', receivedAtUs: '1790582400000000' } },
      { entry: { kind: 'ACTUAL', tag: 'roller.gap_mm', value: '3.02', unit: 'mm', source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000062', quality: 'GOOD', receivedAtUs: '1790582400000000' } },
      { entry: { kind: 'RUN_START', press: 'TEST-RC-01' } },
      { entry: { kind: 'SCREEN_CHECK', screen: 'RS-15', aperture: { value: '1.5', unit: 'mm' }, when: 'BEFORE', result: 'INTACT' } },
      { entry: { kind: 'FEED', quantity: { value: '50.000', unit: 'kg' } } },
      { advanceUs: 1_200_000_000n },
      { entry: { kind: 'RIBBON_CHECK', thickness: '3.05', solidFraction: '68.0', appearance: 'COMPLIES' } },
      { entry: { kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: { value: '24.000', unit: 'kg' }, fines: { value: '1.000', unit: 'kg' } } },
      { entry: { kind: 'FINES_RECYCLED', quantity: { value: '1.000', unit: 'kg' } } },
      { advanceUs: 1_200_000_000n },
      { entry: { kind: 'RIBBON_CHECK', thickness: '2.95', solidFraction: '67.5', appearance: 'COMPLIES' } },
      { entry: { kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: { value: '24.000', unit: 'kg' }, fines: { value: '0.800', unit: 'kg' } } },
      { entry: { kind: 'RUN_END' } },
      { entry: { kind: 'RIBBON_CHECK', thickness: '3.00', solidFraction: '68.2', appearance: 'COMPLIES' } },
      { entry: { kind: 'SCREEN_CHECK', screen: 'RS-15', aperture: { value: '1.5', unit: 'mm' }, when: 'AFTER', result: 'INTACT' } },
      { entry: { kind: 'YIELD' } },
    ],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/forming/blocks.test.ts', 'apps/tablets-server/test/blocks/forming/db-guards.test.ts'],
};
