/**
 * TB-18@1 Coating process and weight gain: film, functional film and sugar coating on the coater (tablets spec B.2 TB-18,
 * C-16; Phase 3 slice 3d, builder A). Controls IN-37, PR-08, PR-29, DI-29, DI-49.
 *
 * Two parts (configuration `part`), each its own step:
 *   CORES    before coating: the coating room and its filtered pan air (ROOM_CHECK: Sched M VIII 4.1, the temperature and
 *            humidity against the MBR's limits, out of limits ROOM_CONDITIONS_OUT_OF_LIMITS), the core load of the pan
 *            (PAN_LOAD, outside the MBR's load range LOAD_OUT_OF_RANGE) and the core sample (CORE_SAMPLE: the MBR's
 *            number of tablets, D 100, allowed 20 to 200, weighed together or one by one). The core mean weight is the
 *            block's (calc.ts: the exact total over the count, 6 decimals) into the MBR's core item (coreItem, mg),
 *            never typed (INV-25).
 *   COATING  one spraying iteration, in a bounded repeat-until loop (G-19, ADR 0004) that exits on the weight gain
 *            (gainItem: a process end point in %, with limits): continued coating to the weight gain is the loop, never
 *            rework. The coater runs through G-06 (common.ts): the MBR collects at least the inlet, exhaust and bed
 *            temperatures, the spray rate and the pan speed, each with lower and upper limits (TB18-PARAMETERS; out of
 *            limits G-06's PROCESS_VALUE_OUT_OF_LIMITS, PR-08), and its alarms (DI-49). Entries besides:
 *              SPRAY_START, SPRAY_END  the spraying at the server's times (measured, never typed); at the end every
 *                                      collected tag must have a usable value at least every log interval (D 15 min)
 *                                      from start to end, or PARAMETER_LOG_GAP is raised;
 *              SUSPENSION_USED         the coating suspension sprayed, naming its TB-03 preparation; the database refuses
 *                                      a binder, a preparation of another batch, one past its use-by at the row's time
 *                                      (IN-37) and more than was prepared;
 *              APPLICATION             sugar coating: the phase of the application (seal, sub-coat, smoothing, colour,
 *                                      polish), each iteration its own application;
 *              WEIGHT_CHECK            after spraying, once per iteration (every check is a retained iteration, DI-29):
 *                                      the coated sample against the core mean the step read when it started; the weight
 *                                      gain (C-16) computed exactly, 4 decimals, into gainItem; above the MBR's maximum
 *                                      weight gain WEIGHT_GAIN_ABOVE_MAXIMUM (QA decides).
 *            The functional film (FC_F) needs a minimum weight gain in the MBR and an end point with a lower limit: an
 *            exit below it is the engine's LIMIT_BREACH (PR-08). The loop is bounded (1 to 20 iterations).
 * Every sample weight is keyed by hand and the step needs a second person's check (DI-30, PR-14).
 *
 * The database holds the same rules (tablets 0911, 0912): the samples, means and weight gain recomputed, the suspension's
 * use-by and quantities, the parameter log, the computed items, the loop bound, and the close.
 */
import {
  acceptProcessEntry,
  ancestorsOf,
  configError,
  DURATION,
  durationUs,
  ENTRY_ID,
  isProcessKind,
  isRecord,
  POSITIVE_QUANTITY,
  positiveCount,
  problem,
  PROCESS_CONFIG_FIELDS,
  PROCESS_ENTRIES,
  PROCESS_EXCEPTION_RULES,
  processBeforePerform,
  processConfigProblems,
  processNominalEntries,
  quantityOf,
  refuse,
  SAMPLE_ENTRY,
  sampleData,
  sampleOf,
  secondsText,
  text,
  type BlockVersion,
  type Config,
  type ConfigProblem,
  type Entry,
  type EntryResult,
  type ExceptionDraft,
  type HandlerProblem,
  type HandlerView,
  type JsonValue,
  type MbrContent,
  type PhaseNode,
} from './coating/common.ts';
import { cmp, compareGain, fixedText, roundHalfAway, scaled, weightGain } from './coating/calc.ts';

const CONTROLS = ['IN-37', 'PR-08', 'PR-29', 'DI-29', 'DI-49'];
/** The loop bound of the block (maximum iterations 1 to 20). */
export const TB18_MAX_ITERATIONS = 20;
/** The coater tags every coating iteration collects with limits (integration-sdk COATER_TAGS). */
export const REQUIRED_TAGS = ['inlet.temp_C', 'exhaust.temp_C', 'bed.temp_C', 'spray.rate_g_min', 'pan.speed_rpm'] as const;
export const SUGAR_PHASES = ['SEAL', 'SUBCOAT', 'SMOOTHING', 'COLOUR', 'POLISH'] as const;
/** The parameter log interval when the MBR gives none (D: 15 min). */
export const DEFAULT_LOG_INTERVAL_US = 15n * 60_000_000n;
/** The core sample when the MBR gives none (D: 100 tablets; allowed 20 to 200). */
export const DEFAULT_SAMPLE = '100';

const part = (config: Config): string => (config['part'] === 'COATING' ? 'COATING' : 'CORES');
const sampleSize = (config: Config): string => (typeof config['sampleSize'] === 'string' ? config['sampleSize'] : DEFAULT_SAMPLE);
export const logIntervalUs = (config: Config): bigint => durationUs(config['logInterval']) ?? DEFAULT_LOG_INTERVAL_US;

function deviation(view: HandlerView, type: string, title: string, controls: string[], category: ExceptionDraft['category'] = 'OUT_OF_LIMIT'): ExceptionDraft {
  return { type, title, controls, severity: 'ACTION', category, blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true };
}

/** The usable values of tag `tag` collected at the step, by their database times. */
function actualTimes(view: HandlerView, tag: string): bigint[] {
  return view.entries('ACTUAL').filter((e) => e.data['tag'] === tag && e.data['usable'] === true).map((e) => e.recordedAt);
}

/** The collected tags whose usable values leave a gap longer than the log interval between `from` and `to`. */
export function logGaps(view: HandlerView, from: bigint, to: bigint): string[] {
  const limit = logIntervalUs(view.config);
  const tags = Array.isArray(view.config['actuals']) ? (view.config['actuals'] as unknown[]).filter(isRecord).map((a) => String(a['tag'])) : [];
  return tags.filter((tag) => {
    const times = [from, ...actualTimes(view, tag).filter((t) => t >= from && t <= to), to];
    return times.some((t, i) => i > 0 && t - (times[i - 1] ?? t) > limit);
  });
}

// ---------------------------------------------------------------------------------------------
// CORES

function acceptCores(view: HandlerView, entry: Entry): EntryResult {
  const c = view.config;
  switch (entry.kind) {
    case 'ROOM_CHECK': {
      if (view.entries('ROOM_CHECK').length > 0) return refuse('TB18-ROOM-TWICE', `${view.stepKey} already checked its coating room`, ['IN-37']);
      if (entry['filteredAir'] !== true) return refuse('TB18-AIR', 'The air of the coating pan is filtered before coating starts', ['IN-37']);
      const room = isRecord(c['room']) ? c['room'] : {};
      const t = String(entry['temperature']);
      const h = String(entry['humidity']);
      const within =
        (typeof room['temperatureMin'] !== 'string' || cmp(t, room['temperatureMin']) >= 0) &&
        (typeof room['temperatureMax'] !== 'string' || cmp(t, room['temperatureMax']) <= 0) &&
        (typeof room['humidityMax'] !== 'string' || cmp(h, room['humidityMax']) <= 0);
      return {
        ok: true,
        data: { filteredAir: true, temperature: t, humidity: h, withinLimits: within, checkedBy: view.actor.id },
        ...(within ? {} : { exceptions: [deviation(view, 'ROOM_CONDITIONS_OUT_OF_LIMITS', `The coating room of ${view.stepKey} is at ${t} degC and ${h} % RH, outside the MBR's limits: the steps after it wait for a deviation`, ['IN-37', 'PR-25'])] }),
      };
    }
    case 'PAN_LOAD': {
      if (view.entries('PAN_LOAD').length > 0) return refuse('TB18-LOAD-TWICE', `${view.stepKey} already records its pan load`, ['IN-37']);
      const q = quantityOf(entry['quantity']);
      const r = isRecord(c['loadRange']) ? c['loadRange'] : undefined;
      if (!q || (r && q.unit !== r['unit'])) return refuse('TB18-LOAD-UNIT', `The pan load is in ${text(r?.['unit']) ?? 'kg'}, the unit of the MBR's load range`, ['IN-37']);
      const within = !r || (cmp(q.value, text(r['min']) ?? '0') >= 0 && cmp(q.value, text(r['max']) ?? '0') <= 0);
      return {
        ok: true,
        data: { quantity: q, withinRange: within, recordedBy: view.actor.id },
        ...(within ? {} : { exceptions: [deviation(view, 'LOAD_OUT_OF_RANGE', `The core load of ${view.stepKey} (${q.value} ${q.unit}) is outside the pan's load range: the steps after it wait for a deviation`, ['IN-37', 'PR-08'])] }),
      };
    }
    case 'CORE_SAMPLE': {
      if (view.entries('CORE_SAMPLE').length > 0) return refuse('TB18-SAMPLE-TWICE', `${view.stepKey} already records its core sample`, ['DI-29']);
      const s = sampleOf(entry, sampleSize(c));
      if (!s.ok) return refuse('TB18-SAMPLE', s.message, ['PR-29', 'DI-29']);
      return { ok: true, data: { ...sampleData(s.sample), recordedBy: view.actor.id }, verificationRequired: true };
    }
    default:
      return refuse('TB18-PART', `${entry.kind} is not an entry of the cores part of a coating step`, ['IN-37']);
  }
}

// ---------------------------------------------------------------------------------------------
// COATING

function coreMeanOf(view: HandlerView): string | undefined {
  const item = text(view.config['coreItem']);
  const v = item ? view.target(item) : undefined;
  return v?.kind === 'DECIMAL' && v.unit === 'mg' ? v.value : undefined;
}

function acceptCoating(view: HandlerView, entry: Entry): EntryResult {
  if (isProcessKind(entry.kind)) return acceptProcessEntry(view, entry);
  const c = view.config;
  const started = view.entries('SPRAY_START')[0];
  const ended = view.entries('SPRAY_END').length > 0;
  switch (entry.kind) {
    case 'SPRAY_START':
      if (started) return refuse('TB18-SPRAY-TWICE', `${view.stepKey} already started spraying`, ['IN-37']);
      if (coreMeanOf(view) === undefined) return refuse('TB18-NO-CORES', `${view.stepKey} has no core mean weight to coat against (the cores part comes first)`, ['IN-37', 'PR-29']);
      return { ok: true, data: { startedBy: view.actor.id } };
    case 'SPRAY_END': {
      if (!started) return refuse('TB18-NOT-SPRAYING', `${view.stepKey} has not started spraying`, ['IN-37']);
      if (ended) return refuse('TB18-SPRAY-TWICE', `${view.stepKey} already ended spraying`, ['IN-37']);
      const gaps = logGaps(view, started.recordedAt, view.nowUs);
      return {
        ok: true,
        data: { sprayingSeconds: secondsText(view.nowUs - started.recordedAt), logGaps: gaps, endedBy: view.actor.id },
        ...(gaps.length === 0
          ? {}
          : { exceptions: [deviation(view, 'PARAMETER_LOG_GAP', `The coating parameters ${gaps.join(', ')} of ${view.stepKey} were not logged at every interval while spraying: the steps after it wait for a deviation`, ['IN-37', 'PR-29', 'DI-29'], 'DEVIATION_OR_OVERRIDE')] }),
      };
    }
    case 'SUSPENSION_USED': {
      if (!started) return refuse('TB18-NOT-SPRAYING', `The suspension of ${view.stepKey} is used while spraying`, ['IN-37']);
      return { ok: true, data: { preparation: entry['preparation'], quantity: quantityOf(entry['quantity']), usedBy: view.actor.id } };
    }
    case 'APPLICATION': {
      if (c['coatingType'] !== 'SC') return refuse('TB18-NOT-SUGAR', 'Applications by phase are recorded for sugar coating only', ['IN-37']);
      if (!started) return refuse('TB18-NOT-SPRAYING', `${view.stepKey} has not started its application`, ['IN-37']);
      if (view.entries('APPLICATION').length > 0) return refuse('TB18-APPLICATION-TWICE', `${view.stepKey} already records its application; the next iteration takes the next`, ['DI-29']);
      return { ok: true, data: { phase: entry['phase'], appliedBy: view.actor.id } };
    }
    case 'WEIGHT_CHECK': {
      if (!ended) return refuse('TB18-CHECK-EARLY', `The weight-gain check of ${view.stepKey} is made after spraying`, ['IN-37', 'PR-29']);
      if (view.entries('WEIGHT_CHECK').length > 0) return refuse('TB18-CHECK-TWICE', `${view.stepKey} already records its weight-gain check; continued coating is the loop's next iteration`, ['DI-29']);
      const core = coreMeanOf(view);
      if (core === undefined) return refuse('TB18-NO-CORES', `${view.stepKey} has no core mean weight to coat against`, ['IN-37', 'PR-29']);
      const s = sampleOf(entry, sampleSize(c));
      if (!s.ok) return refuse('TB18-SAMPLE', s.message, ['PR-29', 'DI-29']);
      const n = BigInt(s.sample.count);
      const gain = weightGain(s.sample.totalMg, n, core);
      const min = text(c['minGain']);
      const max = text(c['maxGain']);
      const below = min !== undefined && compareGain(s.sample.totalMg, n, core, min) < 0;
      const above = max !== undefined && compareGain(s.sample.totalMg, n, core, max) > 0;
      return {
        ok: true,
        data: { ...sampleData(s.sample), coreMeanMg: core, weightGain: gain, belowMinimum: below, aboveMaximum: above, recordedBy: view.actor.id },
        verificationRequired: true,
        ...(above
          ? {
              exceptions: [
                {
                  type: 'WEIGHT_GAIN_ABOVE_MAXIMUM',
                  title: `The weight gain of ${view.stepKey} is ${gain} %, above the MBR's maximum of ${max} %: QA assesses the coated tablets before anything after it runs`,
                  controls: ['IN-37', 'PR-08', 'PR-29'],
                  severity: 'ACTION',
                  category: 'OUT_OF_LIMIT',
                  blocks: 'DOWNSTREAM',
                  until: 'DISPOSITION',
                  deviationRequired: true,
                  qaOnly: true,
                },
              ],
            }
          : {}),
      };
    }
    default:
      return refuse('TB18-PART', `${entry.kind} is not an entry of the coating part of a coating step`, ['IN-37']);
  }
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out: HandlerProblem[] = [];
  if (part(view.config) === 'CORES') {
    if (view.entries('ROOM_CHECK').length === 0) out.push(problem('TB18-NO-ROOM-CHECK', `${view.stepKey} has not checked its coating room and pan air`, ['IN-37']));
    if (view.entries('PAN_LOAD').length === 0) out.push(problem('TB18-NO-LOAD', `${view.stepKey} has no pan load`, ['IN-37']));
    if (view.entries('CORE_SAMPLE').length === 0) out.push(problem('TB18-NO-SAMPLE', `${view.stepKey} has no core sample`, ['IN-37', 'PR-29']));
    return out;
  }
  out.push(...processBeforePerform(view));
  if (view.entries('SPRAY_END').length === 0) out.push(problem('TB18-NOT-SPRAYED', `${view.stepKey} has not finished spraying`, ['IN-37']));
  if (view.entries('SUSPENSION_USED').length === 0) out.push(problem('TB18-NO-SUSPENSION', `${view.stepKey} records no suspension used`, ['IN-37']));
  if (view.config['coatingType'] === 'SC' && view.entries('APPLICATION').length === 0) out.push(problem('TB18-NO-APPLICATION', `${view.stepKey} records no sugar-coating application`, ['IN-37']));
  if (view.entries('WEIGHT_CHECK').length === 0) out.push(problem('TB18-NO-CHECK', `${view.stepKey} has no weight-gain check`, ['IN-37', 'PR-29']));
  return out;
}

function computedItemsOf(config: Config): { item: string; kind: string; member: string; unit: string }[] {
  if (part(config) === 'CORES') {
    const item = text(config['coreItem']);
    return item ? [{ item, kind: 'CORE_SAMPLE', member: 'meanMg', unit: 'mg' }] : [];
  }
  const item = text(config['gainItem']);
  return item ? [{ item, kind: 'WEIGHT_CHECK', member: 'weightGain', unit: '%' }] : [];
}

/** The loop enclosing a coating phase whose exit reads `gainItem` (the innermost such loop). */
export function gainLoopOf(mbr: MbrContent, phaseId: string, gainItem: string | undefined) {
  return ancestorsOf(mbr, phaseId)
    .filter((n) => n.kind === 'loop')
    .reverse()
    .find((n) => n.kind === 'loop' && n.exit.endpoint === gainItem);
}

function itemProblem(mbr: MbrContent, item: string | undefined, unit: string, digits: number): boolean {
  const p = mbr.parameters.find((q) => q.id === item);
  return !p || p.valueType !== 'DECIMAL' || p.unit !== unit || (p.readings ?? 1) !== 1 || (p.precision !== undefined && (p.precision.kind !== 'DECIMALS' || p.precision.digits < digits));
}

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const core = text(config['coreItem']);
  const size = text(config['sampleSize']);
  if (size !== undefined && (BigInt(size) < 20n || BigInt(size) > 200n)) out.push(configError('TB18-SAMPLE-SIZE', `The sample of ${phase.id} is 20 to 200 tablets`, ['PR-29']));
  if (part(config) === 'CORES') {
    if (itemProblem(mbr, core, 'mg', 6) || !core || !phase.records.includes(core)) {
      out.push(configError('TB18-CORE-ITEM', `The cores step ${phase.id} records the core mean weight as a single decimal in mg (coreItem, 6 decimals or more)`, ['IN-37', 'INV-25']));
    }
    const room = isRecord(config['room']) ? config['room'] : undefined;
    if (!room || (room['temperatureMin'] === undefined && room['temperatureMax'] === undefined) || room['humidityMax'] === undefined) {
      out.push(configError('TB18-ROOM', `The cores step ${phase.id} sets the coating room's temperature and humidity limits (Sched M VIII 4.1)`, ['IN-37']));
    }
    for (const k of ['setpoints', 'actuals', 'gainItem', 'minGain', 'maxGain', 'logInterval']) {
      if (config[k] !== undefined) out.push(configError('TB18-PART', `${k} belongs to the coating part, not the cores part of ${phase.id}`, ['IN-37']));
    }
    return out;
  }
  out.push(...processConfigProblems(phase, config, mbr));
  if (!core || !phase.reads.includes(core) || itemProblem(mbr, core, 'mg', 6)) out.push(configError('TB18-CORE-ITEM', `Coating step ${phase.id} reads the core mean weight (coreItem) the cores step records`, ['IN-37', 'PR-29']));
  const actuals = Array.isArray(config['actuals']) ? (config['actuals'] as unknown[]).filter(isRecord) : [];
  const missing = REQUIRED_TAGS.filter((t) => !actuals.some((a) => a['tag'] === t && typeof a['min'] === 'string' && typeof a['max'] === 'string'));
  if (missing.length > 0) out.push(configError('TB18-PARAMETERS', `Coating step ${phase.id} collects ${missing.join(', ')} with lower and upper limits`, ['IN-37', 'PR-08']));
  const gain = text(config['gainItem']);
  const p = mbr.parameters.find((q) => q.id === gain);
  if (!gain || !phase.records.includes(gain) || itemProblem(mbr, gain, '%', 4) || p?.role !== 'PROCESS_ENDPOINT') {
    out.push(configError('TB18-GAIN-ITEM', `Coating step ${phase.id} records the weight gain as a decimal process end point in % (gainItem, 4 decimals or more)`, ['IN-37', 'INV-25']));
  } else if (!p.limits?.ranges.some((r) => r.high !== undefined) || (config['coatingType'] === 'FC_F' && !p.limits.ranges.some((r) => r.low !== undefined))) {
    out.push(configError('TB18-GAIN-LIMITS', `The weight gain of ${phase.id} has an upper limit${config['coatingType'] === 'FC_F' ? ' and, for a functional film, a lower limit' : ''}`, ['IN-37', 'PR-08']));
  }
  if (typeof config['maxGain'] !== 'string') out.push(configError('TB18-MAX-GAIN', `Coating step ${phase.id} sets the maximum weight gain`, ['IN-37', 'PR-08']));
  if (config['coatingType'] === 'FC_F' && typeof config['minGain'] !== 'string') out.push(configError('TB18-MIN-GAIN', `A functional film (${phase.id}) sets the minimum weight gain`, ['IN-37', 'PR-08']));
  if (typeof config['minGain'] === 'string' && typeof config['maxGain'] === 'string' && cmp(config['minGain'], config['maxGain']) > 0) {
    out.push(configError('TB18-MAX-GAIN', `The minimum weight gain of ${phase.id} is above its maximum`, ['IN-37', 'PR-08']));
  }
  const interval = durationUs(config['logInterval']);
  if (config['logInterval'] !== undefined && (interval === undefined || interval <= 0n)) out.push(configError('TB18-LOG-INTERVAL', `The parameter log interval of ${phase.id} is a positive whole number of microseconds`, ['IN-37', 'PR-29']));
  const loop = gainLoopOf(mbr, phase.id, gain);
  if (!loop) out.push(configError('TB18-NO-LOOP', `Coating step ${phase.id} sits in a bounded loop that exits on its weight gain`, ['IN-37', 'DI-34']));
  else if (loop.kind === 'loop' && (loop.maxIterations < 1 || loop.maxIterations > TB18_MAX_ITERATIONS)) {
    out.push(configError('TB18-ITERATIONS', `The coating loop of ${phase.id} allows ${loop.maxIterations} iterations; the block allows 1 to ${TB18_MAX_ITERATIONS}`, ['IN-37', 'DI-34']));
  }
  for (const k of ['room', 'loadRange']) if (config[k] !== undefined) out.push(configError('TB18-PART', `${k} belongs to the cores part, not the coating part of ${phase.id}`, ['IN-37']));
  return out;
}

const SAMPLE_CONFIG = positiveCount('Tablets per sample (D 100; 20 to 200)');

export const TB18: BlockVersion = {
  type: 'TB-18',
  version: '1',
  title: 'Coating to weight gain',
  edition: 'tablets',
  aliases: { tablets: 'TB-18' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'The part (cores or a coating iteration), the coating type, the coater values through G-06 and the weight-gain end point',
    fields: {
      ...PROCESS_CONFIG_FIELDS,
      part: { type: 'string', enum: ['CORES', 'COATING'], description: 'Cores before coating, or one coating iteration of the weight-gain loop' },
      coatingType: { type: 'string', enum: ['FC', 'FC_F', 'SC'], description: 'Film, functional film or sugar coating' },
      coreItem: { type: 'string', description: 'The core mean weight item (mg): recorded by the cores part, read by the coating part' },
      sampleSize: { ...SAMPLE_CONFIG, optional: true },
      room: {
        type: 'object',
        optional: true,
        description: 'Coating room limits (cores part)',
        fields: {
          temperatureMin: { type: 'decimal', optional: true, description: 'Lowest room temperature (degC)' },
          temperatureMax: { type: 'decimal', optional: true, description: 'Highest room temperature (degC)' },
          humidityMax: { type: 'decimal', optional: true, description: 'Highest relative humidity (%)' },
        },
      },
      loadRange: {
        type: 'object',
        optional: true,
        description: 'Validated core load of the pan (cores part)',
        fields: { min: { type: 'decimal', min: '0', description: 'Lowest load' }, max: { type: 'decimal', min: '0', description: 'Highest load' }, unit: { type: 'string', description: 'Mass unit' } },
      },
      gainItem: { type: 'string', optional: true, description: 'The weight gain item (%) the coating part computes; the loop exits on it' },
      targetGain: { type: 'decimal', optional: true, description: 'Target weight gain (%)' },
      minGain: { type: 'decimal', optional: true, description: 'Minimum weight gain (%; mandatory for a functional film)' },
      maxGain: { type: 'decimal', optional: true, description: 'Maximum weight gain (%): above it QA assesses' },
      logInterval: { ...DURATION, optional: true, description: 'Coating parameters logged at least this often (D 15 min)' },
    },
  },
  dataSchema: {
    entries: {
      ...PROCESS_ENTRIES,
      ROOM_CHECK: {
        type: 'object',
        description: 'The coating room and the pan air before coating',
        fields: {
          filteredAir: { type: 'boolean', description: 'The pan air is filtered' },
          temperature: { type: 'decimal', description: 'Room temperature (degC)' },
          humidity: { type: 'decimal', min: '0', description: 'Relative humidity (%)' },
        },
      },
      PAN_LOAD: { type: 'object', description: 'The core load of the pan', fields: { quantity: POSITIVE_QUANTITY } },
      CORE_SAMPLE: SAMPLE_ENTRY('The core sample before coating'),
      SPRAY_START: { type: 'object', description: 'Spraying of the iteration starts (server time)', fields: {} },
      SPRAY_END: { type: 'object', description: 'Spraying of the iteration ends (server time)', fields: {} },
      SUSPENSION_USED: {
        type: 'object',
        description: 'Coating suspension sprayed',
        fields: { preparation: { type: 'string', pattern: ENTRY_ID, description: 'The PREPARED entry of the suspension (TB-03)' }, quantity: POSITIVE_QUANTITY },
      },
      APPLICATION: { type: 'object', description: 'One sugar-coating application', fields: { phase: { type: 'string', enum: [...SUGAR_PHASES], description: 'The phase of the application' } } },
      WEIGHT_CHECK: SAMPLE_ENTRY('The coated sample of the iteration'),
    },
  },
  checkConfig,
  handler: {
    computedItems: (phase) => computedItemsOf(phase.config).map((c) => c.item),
    acceptEntry: (view, entry) => (part(view.config) === 'CORES' ? acceptCores(view, entry) : acceptCoating(view, entry)),
    computeItems: (view) =>
      computedItemsOf(view.config).flatMap(({ item, kind, member, unit }) => {
        const e = view.entries(kind)[0];
        return e ? [{ item, value: { kind: 'DECIMAL' as const, value: String(e.data[member]), unit }, entries: [e.id] }] : [];
      }),
    beforePerform,
  },
  exceptionRules: [
    ...PROCESS_EXCEPTION_RULES,
    { type: 'ROOM_CONDITIONS_OUT_OF_LIMITS', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'The coating room outside its temperature or humidity limits', controls: ['IN-37', 'PR-25'] },
    { type: 'LOAD_OUT_OF_RANGE', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A core load outside the pan load range', controls: ['IN-37', 'PR-08'] },
    { type: 'PARAMETER_LOG_GAP', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'Coating parameters not logged at every interval', controls: ['IN-37', 'PR-29', 'DI-29'] },
    { type: 'WEIGHT_GAIN_ABOVE_MAXIMUM', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A weight gain above the maximum, for QA assessment', controls: ['IN-37', 'PR-08', 'PR-29'] },
  ],
  simulatorModel: {
    exceptionTypes: (phase) =>
      part(phase.config) === 'CORES' ? ['ROOM_CONDITIONS_OUT_OF_LIMITS', 'LOAD_OUT_OF_RANGE'] : [...PROCESS_EXCEPTION_RULES.map((r) => r.type), 'PARAMETER_LOG_GAP', 'WEIGHT_GAIN_ABOVE_MAXIMUM'],
    nominalEntries: (input) => {
      const n = sampleSize(input.config);
      if (part(input.config) === 'CORES') {
        return [
          { kind: 'ROOM_CHECK', filteredAir: true, temperature: '24.0', humidity: '45' },
          { kind: 'PAN_LOAD', quantity: { value: '60.000', unit: 'kg' } },
          { kind: 'CORE_SAMPLE', instrument: 'BAL-01', weighing: 'GROUP', count: n, total: (250n * BigInt(n)).toString(), unit: 'mg' },
        ];
      }
      // The coated sample at the MBR's target gain over the core mean the step reads (exact; 6 decimals of mg). The
      // suspension use names a TB-03 preparation of the run, which the model cannot know: the simulator adds it.
      const core = text(input.config['coreItem']);
      const v = core ? input.target(core) : undefined;
      const gain = text(input.config['targetGain']) ?? '0';
      const total = v?.kind === 'DECIMAL' ? fixedText(roundHalfAway(scaled(v.value).n * BigInt(n) * (100n * 10n ** BigInt(scaled(gain).s) + scaled(gain).n) * 1000000n, 10n ** BigInt(scaled(v.value).s + scaled(gain).s) * 100n), 6) : undefined;
      return [
        { kind: 'SPRAY_START' },
        ...processNominalEntries(input),
        { kind: 'SPRAY_END' },
        ...(total ? [{ kind: 'WEIGHT_CHECK', instrument: 'BAL-01', weighing: 'GROUP', count: n, total, unit: 'mg' }] : []),
      ];
    },
  },
  goldenFixture: {
    description:
      'The cores part of a film coating: the room at 24.0 degC and 45 % RH within 20 to 25 degC and 60 % RH with filtered pan air, 60.000 kg of cores within the 40 to 80 kg load range, 20 cores weighed together at 5.0012 g: the core mean 250.060000 mg is the block\'s, never typed; performed and verified',
    controls: ['IN-37', 'INV-25'],
    phase: {
      block: { type: 'TB-18', version: '1' },
      records: ['coreMean'],
      config: {
        part: 'CORES',
        coatingType: 'FC',
        coreItem: 'coreMean',
        sampleSize: '20',
        room: { temperatureMin: '20', temperatureMax: '25', humidityMax: '60' },
        loadRange: { min: '40', max: '80', unit: 'kg' },
      },
    },
    parameters: [
      { id: 'coreMean', name: 'Core mean weight', valueType: 'DECIMAL', unit: 'mg', precision: { kind: 'DECIMALS', digits: 6 }, role: 'PROCESS_PARAMETER', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'MANUAL' },
    ],
    script: [
      { entry: { kind: 'ROOM_CHECK', filteredAir: true, temperature: '24.0', humidity: '45' } },
      { entry: { kind: 'PAN_LOAD', quantity: { value: '60.000', unit: 'kg' } } },
      { entry: { kind: 'CORE_SAMPLE', instrument: 'BAL-01', weighing: 'GROUP', count: '20', total: '5.0012', unit: 'g' } },
    ],
    expect: { exceptions: [], values: { coreMean: '250.060000' }, status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/coating/blocks.test.ts', 'apps/tablets-server/test/blocks/coating/calc.test.ts', 'apps/tablets-server/test/blocks/coating/db-guards.test.ts'],
};
