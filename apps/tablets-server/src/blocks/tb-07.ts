/**
 * TB-07@1 Blending, lubrication and blend-uniformity sampling (tablets spec B.2 TB-07; Phase 3 slice 3b). Controls
 * IN-36 (a), IN-13, PR-29, DI-29.
 *
 * Blender speed and revolutions go through G-06@1 (setpoint read back, values collected with their limits). Times are
 * measured between entries at the server's times, never typed:
 *   BLEND_START, BLEND_END      the main blend; ending it before the MBR's minimum is refused (TB07-BLEND-SHORT), after
 *                               its maximum raises BLEND_TIME_EXCEEDED (deviation);
 *   LUBRICANT_ADDED             only after the main blend has ended (TB07-LUBRICANT-EARLY), once;
 *   LUBRICATION_END             before the minimum lubrication time refused, after the maximum LUBRICATION_TIME_EXCEEDED;
 *   BU_SAMPLE                   a blend-uniformity sample of the MBR's plan (location, replicate) after blending is
 *                               finished, each once; a sample mass outside 1 to 3 times the unit dose needs a recorded
 *                               justification (TB07-SAMPLE-SIZE). Locations not sampled at PERFORMED raise
 *                               BU_LOCATION_MISSING (flagged for review).
 * The MBR may name the blend and lubrication time items (parameters the step records, in s): the block computes them
 * from the entries, so they are judged against the parameters' limit tiers (PR-08) and never typed (INV-25). The BU
 * results are a readings parameter of the step (one reading per planned sample, bu.resultsItem) with its limits and the
 * MBR's mean and RSD calculations (C-18): a failing result is an OUT_OF_LIMIT exception and an investigation, never a
 * loop (re-blending is reprocessing, G-24).
 *
 * The database holds the same rules (tablets 0850).
 */
import { Dec } from '@ebmr/expr';
import {
  acceptProcessEntry,
  CODE,
  configError,
  DURATION,
  durationUs,
  isProcessKind,
  isRecord,
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
  secondsText,
  text,
  type BlockVersion,
  type Config,
  type ConfigProblem,
  type EntryResult,
  type ExceptionDraft,
  type HandlerProblem,
  type HandlerView,
  type Entry,
  type JsonValue,
  type MbrContent,
  type PhaseNode,
} from './granulation/common.ts';

const CONTROLS = ['IN-36', 'IN-13', 'PR-29', 'DI-29'];

interface Window {
  min?: bigint;
  max?: bigint;
  item?: string;
}

function windowOf(config: Config, key: string): Window | undefined {
  const w = config[key];
  if (!isRecord(w)) return undefined;
  const min = durationUs(w['min']);
  const max = durationUs(w['max']);
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(text(w['item']) !== undefined ? { item: text(w['item']) as string } : {}) };
}

export interface BuPlan {
  locations: string[];
  replicates: number;
  unitDose: { value: string; unit: string };
  resultsItem?: string;
}

export function buPlanOf(config: Config): BuPlan | undefined {
  const b = config['bu'];
  const dose = isRecord(b) ? quantityOf(b['unitDose']) : undefined;
  if (!isRecord(b) || !dose) return undefined;
  return {
    locations: Array.isArray(b['locations']) ? b['locations'].map(String) : [],
    replicates: typeof b['replicates'] === 'number' ? b['replicates'] : 1,
    unitDose: dose,
    ...(text(b['resultsItem']) !== undefined ? { resultsItem: text(b['resultsItem']) as string } : {}),
  };
}

function exceeded(view: HandlerView, type: string, what: string, elapsed: bigint): ExceptionDraft {
  return {
    type,
    title: `The ${what} of ${view.stepKey} took ${secondsText(elapsed)} s, beyond the MBR's maximum: the steps after it wait for a deviation`,
    controls: ['IN-36', 'IN-13', 'PR-29'],
    severity: 'ACTION',
    category: 'TIME_LIMIT',
    blocks: 'DOWNSTREAM',
    until: 'DEVIATION',
    deviationRequired: true,
  };
}

function acceptEnd(view: HandlerView, startKind: string, kind: string, key: string, what: string, type: string): EntryResult {
  const start = view.entries(startKind)[0];
  if (!start) return refuse(kind === 'BLEND_END' ? 'TB07-NOT-STARTED' : 'TB07-NO-LUBRICANT', `${view.stepKey} has no ${startKind.toLowerCase().replace('_', ' ')} yet`, ['IN-36']);
  if (view.entries(kind).length > 0) return refuse('TB07-TWICE', `${view.stepKey} already records ${kind}`, ['IN-36', 'DI-29']);
  const w = windowOf(view.config, key) ?? {};
  const elapsed = view.nowUs - start.recordedAt;
  if (w.min !== undefined && elapsed < w.min) {
    return refuse(kind === 'BLEND_END' ? 'TB07-BLEND-SHORT' : 'TB07-LUBRICATION-SHORT', `The ${what} of ${view.stepKey} (${secondsText(elapsed)} s) has not reached the MBR's minimum`, ['IN-36', 'IN-13']);
  }
  const ok = w.max === undefined || elapsed <= w.max;
  return { ok: true, data: { seconds: secondsText(elapsed), withinLimits: ok, recordedBy: view.actor.id }, ...(ok ? {} : { exceptions: [exceeded(view, type, what, elapsed)] }) };
}

function blendingFinished(view: HandlerView): boolean {
  return windowOf(view.config, 'lubrication') ? view.entries('LUBRICATION_END').length > 0 : view.entries('BLEND_END').length > 0;
}

function acceptSample(view: HandlerView, entry: Entry): EntryResult {
  const plan = buPlanOf(view.config);
  if (!plan) return refuse('TB07-NO-BU-PLAN', `${view.phase.id} has no blend-uniformity plan`, ['PR-29']);
  if (!blendingFinished(view)) return refuse('TB07-BU-EARLY', `Blend-uniformity samples of ${view.stepKey} are taken when blending is finished`, ['PR-29', 'IN-36']);
  const location = String(entry['location']);
  const replicate = entry['replicate'];
  if (!plan.locations.includes(location) || typeof replicate !== 'number' || replicate > plan.replicates) {
    return refuse('TB07-NOT-PLANNED', `Location ${location}, replicate ${String(replicate)} is not in the sampling plan of ${view.phase.id}`, ['PR-29']);
  }
  if (view.entries('BU_SAMPLE').some((e) => e.data['location'] === location && e.data['replicate'] === replicate)) {
    return refuse('TB07-SAMPLE-TWICE', `Location ${location}, replicate ${replicate} is already sampled`, ['PR-29', 'DI-29']);
  }
  const mass = quantityOf(entry['mass']);
  if (!mass || mass.unit !== plan.unitDose.unit) return refuse('TB07-SAMPLE-UNIT', `The sample mass is in the unit of the unit dose (${plan.unitDose.unit})`, ['PR-29']);
  const dose = Dec.parse(plan.unitDose.value);
  const m = Dec.parse(mass.value);
  const inRange = m.gte(dose) && m.lte(dose.times(Dec.fromInteger(3)));
  const justification = text(entry['justification']);
  if (!inRange && (justification === undefined || justification.trim() === '')) {
    return refuse('TB07-SAMPLE-SIZE', `A sample of ${mass.value} ${mass.unit} is outside 1 to 3 times the unit dose (${plan.unitDose.value} ${plan.unitDose.unit}); record why`, ['PR-29']);
  }
  return {
    ok: true,
    data: { location, replicate, mass, withinDoseRange: inRange, ...(justification !== undefined ? { justification } : {}), sampledBy: view.actor.id },
  };
}

function accept(view: HandlerView, entry: Entry): EntryResult {
  if (isProcessKind(entry.kind)) return acceptProcessEntry(view, entry);
  switch (entry.kind) {
    case 'BLEND_START':
      if (view.entries('BLEND_START').length > 0) return refuse('TB07-TWICE', `${view.stepKey} already started blending`, ['IN-36']);
      return { ok: true, data: { startedBy: view.actor.id } };
    case 'BLEND_END':
      return acceptEnd(view, 'BLEND_START', 'BLEND_END', 'blendTime', 'main blend', 'BLEND_TIME_EXCEEDED');
    case 'LUBRICANT_ADDED': {
      if (!windowOf(view.config, 'lubrication')) return refuse('TB07-NO-LUBRICATION', `${view.phase.id} has no lubrication in its MBR`, ['IN-36']);
      if (view.entries('BLEND_END').length === 0) return refuse('TB07-LUBRICANT-EARLY', `The lubricant of ${view.stepKey} is added only after the main blend time`, ['IN-36', 'IN-13']);
      if (view.entries('LUBRICANT_ADDED').length > 0) return refuse('TB07-TWICE', `${view.stepKey} already records its lubricant`, ['IN-36']);
      return { ok: true, data: { quantity: quantityOf(entry['quantity']), ...(typeof entry['lot'] === 'string' ? { lot: entry['lot'] } : {}), addedBy: view.actor.id } };
    }
    case 'LUBRICATION_END':
      return acceptEnd(view, 'LUBRICANT_ADDED', 'LUBRICATION_END', 'lubrication', 'lubrication', 'LUBRICATION_TIME_EXCEEDED');
    case 'BU_SAMPLE':
      return acceptSample(view, entry);
    default:
      return refuse('TB07-ENTRY', `${entry.kind} is not an entry of a blending step`, ['IN-36']);
  }
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out = processBeforePerform(view);
  if (view.entries('BLEND_END').length === 0) out.push(problem('TB07-NOT-BLENDED', `${view.stepKey} has not finished its main blend`, ['IN-36']));
  if (windowOf(view.config, 'lubrication') && view.entries('LUBRICATION_END').length === 0) out.push(problem('TB07-NOT-LUBRICATED', `${view.stepKey} has not finished its lubrication`, ['IN-36']));
  return out;
}

function onPerform(view: HandlerView): { exceptions?: ExceptionDraft[] } {
  const plan = buPlanOf(view.config);
  if (!plan) return {};
  const taken = new Set(view.entries('BU_SAMPLE').map((e) => `${String(e.data['location'])}#${String(e.data['replicate'])}`));
  const missing = plan.locations.flatMap((l) => Array.from({ length: plan.replicates }, (_, i) => `${l}#${i + 1}`)).filter((k) => !taken.has(k));
  return missing.length === 0
    ? {}
    : {
        exceptions: [
          {
            type: 'BU_LOCATION_MISSING',
            title: `Blend-uniformity samples of ${view.stepKey} missing from the plan: ${missing.map((k) => k.replace('#', ' replicate ')).join(', ')}`,
            controls: ['PR-29', 'DI-29'],
            severity: 'ALERT',
            category: 'FORCED_SKIPPED_NA',
            blocks: 'NONE',
          },
        ],
      };
}

function computedItemsOf(config: Config): { item: string; kind: string }[] {
  const out: { item: string; kind: string }[] = [];
  const b = windowOf(config, 'blendTime')?.item;
  const l = windowOf(config, 'lubrication')?.item;
  if (b !== undefined) out.push({ item: b, kind: 'BLEND_END' });
  if (l !== undefined) out.push({ item: l, kind: 'LUBRICATION_END' });
  return out;
}

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const out = processConfigProblems(phase, config, mbr);
  for (const key of ['blendTime', 'lubrication']) {
    const w = windowOf(config, key);
    if (!w) continue;
    if (w.max === undefined) out.push(configError('TB07-TIME', `The ${key === 'blendTime' ? 'blend' : 'lubrication'} time of ${phase.id} has no maximum (a whole number of microseconds)`, ['IN-36', 'IN-13']));
    if (w.min !== undefined && w.max !== undefined && w.min > w.max) out.push(configError('TB07-TIME', `The ${key} of ${phase.id} runs from more to less`, ['IN-36']));
  }
  for (const { item } of computedItemsOf(config)) {
    const p = mbr.parameters.find((q) => q.id === item);
    if (!p || !phase.records.includes(item) || p.valueType !== 'DECIMAL' || p.unit !== 's' || (p.readings ?? 1) !== 1) {
      out.push(configError('TB07-TIME-ITEM', `The time item ${item} of ${phase.id} is a single decimal in s that the step records`, ['IN-36', 'INV-25']));
    }
  }
  const plan = buPlanOf(config);
  if (plan) {
    if (new Set(plan.locations).size !== plan.locations.length) out.push(configError('TB07-BU-PLAN', `The sampling map of ${phase.id} lists a location twice`, ['PR-29']));
    if (plan.resultsItem !== undefined) {
      const p = mbr.parameters.find((q) => q.id === plan.resultsItem);
      if (!p || !phase.records.includes(plan.resultsItem) || p.valueType !== 'DECIMAL' || (p.readings ?? 1) !== plan.locations.length * plan.replicates || !p.limits) {
        out.push(configError('TB07-BU-RESULTS', `The blend-uniformity results of ${phase.id} are a decimal parameter the step records with limits, one reading per planned sample (${plan.locations.length * plan.replicates})`, ['PR-29']));
      }
    }
  }
  return out;
}

export const TB07: BlockVersion = {
  type: 'TB-07',
  version: '1',
  title: 'Blending, lubrication and blend uniformity',
  edition: 'tablets',
  aliases: { tablets: 'TB-07' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'Process values through G-06, the blend and lubrication times, and the blend-uniformity sampling plan',
    fields: {
      ...PROCESS_CONFIG_FIELDS,
      blendTime: {
        type: 'object',
        description: 'Main blend time: minimum, maximum and the item the block computes',
        fields: { min: { ...DURATION, optional: true }, max: DURATION, item: { type: 'string', optional: true, description: 'Parameter (s) the block computes' } },
      },
      lubrication: {
        type: 'object',
        optional: true,
        description: 'Lubrication time after the lubricant is added: minimum, maximum and the item the block computes',
        fields: { min: { ...DURATION, optional: true }, max: DURATION, item: { type: 'string', optional: true, description: 'Parameter (s) the block computes' } },
      },
      bu: {
        type: 'object',
        optional: true,
        description: 'Blend-uniformity sampling plan',
        fields: {
          locations: { type: 'array', minItems: 1, maxItems: 40, description: 'Sampling map locations', items: { type: 'string', pattern: CODE, description: 'Location' } },
          replicates: { type: 'integer', min: 1, max: 6, description: 'Samples per location' },
          unitDose: { ...POSITIVE_QUANTITY, description: 'Unit dose weight (sample size 1 to 3 times it)' },
          resultsItem: { type: 'string', optional: true, description: 'Readings parameter holding one result per planned sample' },
        },
      },
    },
  },
  dataSchema: {
    entries: {
      ...PROCESS_ENTRIES,
      BLEND_START: { type: 'object', description: 'Main blend starts (server time)', fields: {} },
      BLEND_END: { type: 'object', description: 'Main blend ends (server time)', fields: {} },
      LUBRICANT_ADDED: { type: 'object', description: 'Lubricant added after the main blend', fields: { quantity: POSITIVE_QUANTITY, lot: { type: 'string', optional: true, description: 'Lot or container' } } },
      LUBRICATION_END: { type: 'object', description: 'Lubrication ends (server time)', fields: {} },
      BU_SAMPLE: {
        type: 'object',
        description: 'A blend-uniformity sample',
        fields: {
          location: { type: 'string', pattern: CODE, description: 'Location of the sampling map' },
          replicate: { type: 'integer', min: 1, max: 6, description: 'Replicate at the location' },
          mass: POSITIVE_QUANTITY,
          justification: { type: 'string', optional: true, description: 'Why a sample outside 1 to 3 unit doses' },
        },
      },
    },
  },
  checkConfig,
  handler: {
    computedItems: (phase) => computedItemsOf(phase.config).map((c) => c.item),
    acceptEntry: accept,
    computeItems: (view) =>
      computedItemsOf(view.config).flatMap(({ item, kind }) => {
        const e = view.entries(kind)[0];
        return e ? [{ item, value: { kind: 'DECIMAL' as const, value: String(e.data['seconds']), unit: 's' }, entries: [e.id] }] : [];
      }),
    beforePerform,
    onPerform,
  },
  exceptionRules: [
    ...PROCESS_EXCEPTION_RULES,
    { type: 'BLEND_TIME_EXCEEDED', category: 'TIME_LIMIT', severity: 'ACTION', summary: 'The main blend beyond its maximum time', controls: ['IN-36', 'IN-13', 'PR-29'] },
    { type: 'LUBRICATION_TIME_EXCEEDED', category: 'TIME_LIMIT', severity: 'ACTION', summary: 'Lubrication beyond its maximum time', controls: ['IN-36', 'IN-13', 'PR-29'] },
    { type: 'BU_LOCATION_MISSING', category: 'FORCED_SKIPPED_NA', severity: 'ALERT', summary: 'Blend-uniformity locations of the plan not sampled', controls: ['PR-29', 'DI-29'] },
  ],
  simulatorModel: {
    exceptionTypes: () => [...PROCESS_EXCEPTION_RULES.map((r) => r.type), 'BLEND_TIME_EXCEEDED', 'LUBRICATION_TIME_EXCEEDED', 'BU_LOCATION_MISSING'],
    // Nominal: G-06's values and the blend; the lubricant, the ends and the samples follow the run's clock.
    nominalEntries: (input) => [...processNominalEntries(input), { kind: 'BLEND_START' }],
  },
  goldenFixture: {
    description:
      'Blend 10 min (8 to 15 min), lubricant added after the main blend, lubricated 3 min (2 to 5 min), times computed into their items; blend uniformity at 3 of 4 planned locations: the missing one is flagged (BU_LOCATION_MISSING); performed and verified',
    controls: ['IN-36', 'PR-29'],
    phase: {
      block: { type: 'TB-07', version: '1' },
      records: ['blendTime', 'lubeTime'],
      config: {
        blendTime: { min: { value: '8', unit: 'min' }, max: { value: '15', unit: 'min' }, item: 'blendTime' },
        lubrication: { min: { value: '2', unit: 'min' }, max: { value: '5', unit: 'min' }, item: 'lubeTime' },
        bu: { locations: ['L1', 'L2', 'L3', 'L4'], replicates: 1, unitDose: { value: '250', unit: 'mg' } },
      },
      system: { kind: 'PLC', ref: 'SYS-BLD', recipe: 'RCP-BLEND', recipeVersion: '1' },
    },
    parameters: [
      { id: 'blendTime', name: 'Main blend time', valueType: 'DECIMAL', unit: 's', role: 'PROCESS_PARAMETER', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'AUTOMATION', limits: { unit: 's', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: '480', inclusive: true }, high: { value: '900', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] } },
      { id: 'lubeTime', name: 'Lubrication time', valueType: 'DECIMAL', unit: 's', role: 'PROCESS_PARAMETER', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'AUTOMATION' },
    ],
    script: [
      { entry: { kind: 'BLEND_START' } },
      { advanceUs: 600_000_000n },
      { entry: { kind: 'BLEND_END' } },
      { entry: { kind: 'LUBRICANT_ADDED', quantity: { value: '0.250', unit: 'kg' } } },
      { advanceUs: 180_000_000n },
      { entry: { kind: 'LUBRICATION_END' } },
      { entry: { kind: 'BU_SAMPLE', location: 'L1', replicate: 1, mass: { value: '510', unit: 'mg' } } },
      { entry: { kind: 'BU_SAMPLE', location: 'L2', replicate: 1, mass: { value: '495', unit: 'mg' } } },
      { entry: { kind: 'BU_SAMPLE', location: 'L3', replicate: 1, mass: { value: '1100', unit: 'mg' }, justification: 'Thief chamber of the larger size used at the bottom location' } },
    ],
    expect: { exceptions: ['BU_LOCATION_MISSING'], values: { blendTime: '600.000000', lubeTime: '180.000000' }, status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/granulation/blocks.test.ts', 'apps/tablets-server/test/blocks/granulation/db-guards.test.ts'],
};
