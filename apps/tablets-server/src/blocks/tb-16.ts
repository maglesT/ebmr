/**
 * TB-16@1 Bilayer (multilayer) compression (tablets spec B.2 TB-16, A.3 UP-75; Phase 3 slice 3d, builder B). Controls
 * PR-21, PR-29, IN-26 (c), IN-35, DI-31.
 *
 * One TB-16 step is one bilayer run of the press, after its set-up and first-off (TB-10; the database refuses the run's
 * start before them) on tooling that may compress (TB-09). Process values go through G-06@1: the layer settings of the
 * press (each layer's fill depth, the tamping force of the first layer, the final forces) read back and collected with
 * their acceptance limits.
 *
 * The configuration lists the layers in their order (two or three): each with its stream id, the stage of the blend
 * containers that feed it, its hopper, and its own IPC plan and test configurations. Every layer but the last is
 * sampled alone (layer-only samples: a weight check with in-house limits, GROUP or INDIVIDUAL, never a compendial
 * mode); the last layer's samples are the full tablets: its plan holds the total weight and a physical check whose
 * appearance examines LAMINATION (the layer-separation check) and may hold friability and disintegration, and it starts
 * with the station sweep (IN-35 (b)). Layer-only samples are recorded on their own layer's stream and evaluated against
 * their own limits, never mixed into the full-tablet statistics.
 *
 * Entries:
 *   HOPPER_CHARGE   a blend container charged into a layer's hopper by its scan (plant.charge_container, IN-26 (c)):
 *                   the hopper must be the layer's (swapping is blocked: TB16-HOPPER) and the container's blend the
 *                   layer's (TB16-WRONG-BLEND; the database reads the container's stage from the charge it names). Each
 *                   charge makes the step need a second person's check (PR-21: the kit of both layers verified); the
 *                   run cannot start while a layer has no charge (TB16-LAYER-UNCHARGED).
 *   RUN_START, STOPPAGE_START, STOPPAGE_END, CHANGE, RUN_END and the test entries (STATION_SWEEP, WEIGHT_CHECK, ...)
 *                   exactly as TB-11's, each layer a TB-11 run of one stream with its own plan (forming/common.ts
 *                   viewAs): due and overdue at the database time of each entry, a test entry names its layer's stream.
 *                   An entry lists the checks missed on every layer (`missed`) and raises IPC_CHECK_MISSED; in the
 *                   database the slice 1 container hold records PASS, FAIL or MISSED for the layer's stream of the press,
 *                   so a failing or missed layer-only check holds every container of the press filled since that layer's
 *                   last passing check (the layers feed the same containers: the press must discharge its output
 *                   together, TB16-DISCHARGE).
 * Before PERFORMED: G-06's completeness, every layer charged, and TB-11's completeness for every layer (the run ended,
 * an end-of-run check of every planned test of every layer, the sweep done, no compendial stage pending). The database
 * holds all of it (tablets 0931, 0932).
 */
import { overdue, SCHEDULER_CONFIG, TB11, type Missed } from './tb-11.ts';
import {
  acceptProcessEntry,
  CODE,
  configError,
  DURATION,
  durationUs,
  isProcessKind,
  isRecord,
  LATE_ENTRY,
  phasesOf,
  PROCESS_CONFIG_FIELDS,
  PROCESS_ENTRIES,
  PROCESS_EXCEPTION_RULES,
  processBeforePerform,
  processConfigProblems,
  processNominalEntries,
  problem,
  refuse,
  STAGE,
  STREAM,
  UUID,
  viewAs,
  type BlockVersion,
  type ConfigProblem,
  type Entry,
  type EntryResult,
  type ExceptionDraft,
  type HandlerProblem,
  type HandlerView,
  type JsonValue,
  type MbrContent,
  type ObjectSchema,
  type PhaseNode,
} from './forming/common.ts';

const CONTROLS = ['PR-21', 'PR-29', 'IN-26', 'IN-35', 'DI-31'];
type Config = Readonly<Record<string, unknown>>;

/** The ceiling between compression samples (tb-11.ts COMPRESSION_SAMPLE_CEILING): every layer keeps it. */
const CEILING_US = 30n * 60_000_000n;

/** The entry kinds TB-16 takes from TB-11 (its run and its test entries). */
export const SCHEDULER_KINDS = ['RUN_START', 'STOPPAGE_START', 'STOPPAGE_END', 'CHANGE', 'RUN_END', 'STATION_SWEEP', 'WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE', 'PHYSICAL_CHECK', 'FRIABILITY_RUN', 'DT_START', 'DT_END'] as const;
const TEST_KINDS = ['STATION_SWEEP', 'WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE', 'PHYSICAL_CHECK', 'FRIABILITY_RUN', 'DT_START', 'DT_END'];
const TEST_CONFIG_KEYS = ['weight', 'physical', 'friability', 'disintegration'] as const;

export interface Layer {
  id: string;
  stage: string;
  hopper: string;
  raw: Record<string, unknown>;
}

export function layersOf(config: Config): Layer[] {
  const l = config['layers'];
  return Array.isArray(l) ? l.filter(isRecord).map((x) => ({ id: String(x['id']), stage: String(x['stage']), hopper: String(x['hopper']), raw: x })) : [];
}

/**
 * The TB-11 configuration of layer `i`: one stream (the layer's), its plan and test configurations, the run's grace,
 * restart and late-entry times; the last layer (the full tablets) is a compression run with its station sweep, the
 * others are layer-only runs. The database builds the same (tablets 0931, tab.bilayer_layer_cfg).
 */
export function layerConfig(config: Config, i: number): Record<string, unknown> {
  const ls = layersOf(config);
  const l = ls[i]?.raw ?? {};
  const last = i === ls.length - 1;
  const out: Record<string, unknown> = { process: last ? 'COMPRESSION' : 'OTHER', streams: [{ id: l['id'] }], plan: l['plan'], grace: config['grace'] };
  for (const k of ['restartAfter', 'lateEntry'] as const) if (config[k] !== undefined) out[k] = config[k];
  if (last && l['sweep'] !== undefined) out['sweep'] = l['sweep'];
  for (const k of TEST_CONFIG_KEYS) if (l[k] !== undefined) out[k] = l[k];
  return out;
}

/** The checks missed on every layer at `nowUs`, layer by layer in their order. */
export function missedOf(view: HandlerView): Missed[] {
  return layersOf(view.config).flatMap((_, i) => overdue(view.entries(), layerConfig(view.config, i), view.nowUs));
}

function missedException(view: HandlerView, missed: readonly Missed[]): ExceptionDraft {
  return {
    type: 'IPC_CHECK_MISSED',
    title: `Missed in-process check at ${view.stepKey}: ${missed.map((m) => `${m.test.toLowerCase()} of layer ${m.stream}`).join(', ')}; the press output since that layer's last passing check is held and the steps after it wait for a deviation`,
    controls: ['IN-35', 'PR-29'],
    severity: 'ACTION',
    category: 'TIME_LIMIT',
    blocks: 'DOWNSTREAM',
    until: 'DEVIATION',
    deviationRequired: true,
    item: missed[0]?.stream ?? '',
  };
}

const uncharged = (view: HandlerView): string[] =>
  layersOf(view.config).filter((l) => !view.entries('HOPPER_CHARGE').some((e) => e.data['layer'] === l.id)).map((l) => l.id);

function acceptCharge(view: HandlerView, entry: Entry): EntryResult {
  if (view.entries('RUN_END').length > 0) return refuse('TB16-ENDED', `The run of ${view.stepKey} has ended: no more charges`, ['PR-21']);
  const layer = layersOf(view.config).find((l) => l.id === entry['layer']);
  if (!layer) return refuse('TB16-LAYER', `${String(entry['layer'])} is not a layer of ${view.phase.id}`, ['PR-21', 'IN-26']);
  if (entry['hopper'] !== layer.hopper) {
    return refuse('TB16-HOPPER', `Layer ${layer.id} is fed from hopper ${layer.hopper}, not ${String(entry['hopper'])}: the layers' hoppers are never swapped`, ['PR-21', 'IN-26']);
  }
  if (entry['blend'] !== layer.stage) {
    return refuse('TB16-WRONG-BLEND', `The container scanned holds ${String(entry['blend'])}; layer ${layer.id} takes ${layer.stage} only`, ['PR-21', 'IN-26']);
  }
  return { ok: true, data: { layer: layer.id, hopper: layer.hopper, blend: layer.stage, chargeId: entry['chargeId'], chargedBy: view.actor.id }, verificationRequired: true };
}

function accept(view: HandlerView, entry: Entry): EntryResult {
  if (isProcessKind(entry.kind)) return acceptProcessEntry(view, entry);
  if (entry.kind === 'HOPPER_CHARGE') return acceptCharge(view, entry);
  if (!(SCHEDULER_KINDS as readonly string[]).includes(entry.kind)) return refuse('TB16-ENTRY', `${entry.kind} is not an entry of a bilayer compression step`, ['PR-29']);
  const ls = layersOf(view.config);
  if (entry.kind === 'RUN_START') {
    const open = uncharged(view);
    if (open.length > 0) return refuse('TB16-LAYER-UNCHARGED', `Layer ${open.join(', ')} has no blend charged into its hopper: the run starts with every layer's kit charged`, ['PR-21']);
  }
  let i = ls.length - 1;
  if (TEST_KINDS.includes(entry.kind)) {
    i = ls.findIndex((l) => l.id === entry['stream']);
    if (i < 0) return refuse('TB16-STREAM', `A check at ${view.stepKey} names the stream of one of its layers (${ls.map((l) => l.id).join(', ')})`, ['PR-29', 'IN-35']);
  }
  const r = TB11.handler?.acceptEntry?.(viewAs(view, 'TB-11', layerConfig(view.config, i)), entry);
  if (!r) throw new Error('TB-11 has no entry handler');
  if (!r.ok || entry.kind === 'RUN_START') return r;
  const missed = missedOf(view);
  const { missed: _own, ...data } = r.data;
  void _own;
  const exceptions = [...(missed.length > 0 ? [missedException(view, missed)] : []), ...(r.exceptions ?? []).filter((e) => e.type !== 'IPC_CHECK_MISSED')];
  const { exceptions: _raised, ...rest } = r;
  void _raised;
  return { ...rest, data: { ...data, ...(missed.length > 0 ? { missed } : {}) }, ...(exceptions.length > 0 ? { exceptions } : {}) };
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out = processBeforePerform(view);
  const open = uncharged(view);
  if (open.length > 0) out.push(problem('TB16-LAYER-UNCHARGED', `Layer ${open.join(', ')} of ${view.stepKey} was never charged`, ['PR-21']));
  const seen = new Set<string>();
  layersOf(view.config).forEach((_, i) => {
    for (const p of TB11.handler?.beforePerform?.(viewAs(view, 'TB-11', layerConfig(view.config, i))) ?? []) {
      if (!seen.has(p.message)) {
        seen.add(p.message);
        out.push(p);
      }
    }
  });
  return out;
}

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const out = processConfigProblems(phase, config, mbr);
  const where = `Bilayer compression step ${phase.id}`;
  const ls = layersOf(config);
  if (ls.length < 2 || ls.length > 3) out.push(configError('TB16-LAYERS', `${where} has ${ls.length} layers; a bilayer or trilayer run has two or three`, ['PR-21']));
  for (const k of ['id', 'hopper', 'stage'] as const) {
    const v = ls.map((l) => l[k]);
    if (new Set(v).size !== v.length) out.push(configError('TB16-LAYERS', `${where}: two layers share a ${k}`, ['PR-21', 'IN-26']));
  }
  if (!phase.equipment.some((q) => q.use === 'USE')) out.push(configError('TB16-NO-EQUIPMENT', `${where} names no press it uses`, ['PR-23']));
  const grace = durationUs(config['grace']);
  ls.forEach((l, i) => {
    const lc = layerConfig(config, i);
    out.push(...(TB11.checkConfig?.(phase, lc as Readonly<Record<string, JsonValue>>, mbr) ?? []));
    const plan = Array.isArray(l.raw['plan']) ? (l.raw['plan'] as unknown[]).filter(isRecord) : [];
    if (plan.some((p) => p['everyCount'] !== undefined)) out.push(configError('TB16-PLAN', `${where}: layer ${l.id} plans by time only (no press-count interval)`, ['PR-29']));
    if (i < ls.length - 1) {
      const weight = isRecord(l.raw['weight']) ? l.raw['weight'] : {};
      if (plan.some((p) => p['test'] !== 'WEIGHT') || !['GROUP', 'INDIVIDUAL'].includes(String(weight['mode'])) || l.raw['sweep'] !== undefined) {
        out.push(configError('TB16-LAYER-ONLY', `${where}: layer ${l.id} is sampled alone: a weight check with in-house limits (GROUP or INDIVIDUAL) and nothing else`, ['PR-29', 'IN-35']));
      }
      const fastest = plan.map((p) => durationUs(p['every'])).filter((x): x is bigint => x !== undefined).reduce<bigint | undefined>((a, x) => (a === undefined || x < a ? x : a), undefined);
      if (fastest === undefined || grace === undefined || fastest + grace > CEILING_US) {
        out.push(configError('TB16-CEILING', `${where}: layer ${l.id} is checked no more than 30 min after its previous sample; its interval plus the grace must not exceed it (IN-35 (c))`, ['IN-35']));
      }
    } else {
      const physical = isRecord(l.raw['physical']) ? l.raw['physical'] : {};
      const defects = Array.isArray(physical['defects']) ? physical['defects'] : [];
      if (!plan.some((p) => p['test'] === 'WEIGHT') || !plan.some((p) => p['test'] === 'PHYSICAL') || !defects.includes('LAMINATION')) {
        out.push(configError('TB16-SEPARATION', `${where}: the full tablets of layer ${l.id} are checked for their total weight and for layer separation (a physical check examining LAMINATION)`, ['PR-29', 'IN-35']));
      }
    }
  });
  const others = phasesOf(mbr).filter((p) => p.block.type === 'TB-11').flatMap((p) => (Array.isArray(p.config['streams']) ? (p.config['streams'] as unknown[]).filter(isRecord).map((s) => String(s['id'])) : []));
  const clash = ls.filter((l) => others.includes(l.id)).map((l) => l.id);
  if (clash.length > 0) out.push(configError('TB16-STREAM-CLASH', `${where}: layer stream ${clash.join(', ')} is also a stream of an IPC scheduler step; a passing check of one would vouch for the other`, ['PR-29']));
  if (!phasesOf(mbr).some((p) => p.block.type === 'TB-10')) out.push(configError('TB16-NO-SETUP', `${where}: the MBR has no press set-up and first-off step (TB-10) before the bilayer run`, ['IN-35', 'PR-23']));
  return out;
}

const LAYER: ObjectSchema = {
  type: 'object',
  description: 'One layer: its stream, its blend containers\' stage, its hopper, and its own IPC plan and test configurations',
  fields: {
    id: { type: 'string', pattern: STREAM, description: 'Stream id of the layer\'s samples (the output containers\' check series)' },
    stage: { type: 'string', pattern: STAGE, description: 'Stage of the blend containers that feed the layer' },
    hopper: { type: 'string', pattern: CODE, description: 'The layer\'s hopper as labelled' },
    plan: SCHEDULER_CONFIG.fields['plan'] as ObjectSchema,
    sweep: { ...(SCHEDULER_CONFIG.fields['sweep'] as ObjectSchema), optional: true, description: 'The station sweep of the full tablets (last layer only)' },
    weight: SCHEDULER_CONFIG.fields['weight'] as ObjectSchema,
    physical: SCHEDULER_CONFIG.fields['physical'] as ObjectSchema,
    friability: SCHEDULER_CONFIG.fields['friability'] as ObjectSchema,
    disintegration: SCHEDULER_CONFIG.fields['disintegration'] as ObjectSchema,
  },
};

const RUN_ENTRIES = (TB11.dataSchema?.entries ?? {});

function nominal(input: Parameters<NonNullable<BlockVersion['simulatorModel']>['nominalEntries']>[0]): (Record<string, unknown> & { kind: string })[] {
  const cfg = input.config as Config;
  const ls = layersOf(cfg);
  const charges = ls.map((l, i) => ({ kind: 'HOPPER_CHARGE', layer: l.id, hopper: l.hopper, blend: l.stage, chargeId: `00000000-0000-4000-8000-${(i + 1601).toString().padStart(12, '0')}` }));
  const runs = ls.map((_, i) => TB11.simulatorModel?.nominalEntries({ ...input, config: layerConfig(cfg, i) as Readonly<Record<string, JsonValue>> }) ?? []);
  const before = runs.flatMap((r) => r.slice(1, r.findIndex((e) => e.kind === 'RUN_END')));
  const after = runs.flatMap((r) => r.slice(r.findIndex((e) => e.kind === 'RUN_END') + 1));
  return [...processNominalEntries(input), ...charges, { kind: 'RUN_START', press: 'TEST-PRESS-01' }, ...before, { kind: 'RUN_END' }, ...after];
}

const GOLDEN_UUID = (i: number) => `00000000-0000-4000-8000-${(i + 1701).toString().padStart(12, '0')}`;
const LAYER_WEIGHT = { mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '150.0', n: 10, weighing: 'GROUP', tolerance: { action: '3', alert: '2' } };
const TOTAL_WEIGHT = { mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '400.0', n: 10, weighing: 'GROUP', tolerance: { action: '2', alert: '1' } };
const PHYSICAL = { n: 2, thickness: { individual: { action: { min: '5.2', max: '5.6' } } }, defects: ['CAPPING', 'LAMINATION'] };

export const TB16: BlockVersion = {
  type: 'TB-16',
  version: '1',
  title: 'Bilayer compression',
  edition: 'tablets',
  aliases: { tablets: 'TB-16' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'Press values through G-06, the layers in their order with their blends, hoppers and IPC plans, and the run\'s grace and restart times',
    fields: {
      ...PROCESS_CONFIG_FIELDS,
      layers: { type: 'array', minItems: 2, maxItems: 3, items: LAYER, description: 'The layers in their order; the last one\'s samples are the full tablets' },
      grace: { ...DURATION, description: 'A check is missed when it is this long overdue' },
      restartAfter: { ...DURATION, optional: true, description: 'A stoppage longer than this makes every check due at the restart (D: 15 min; 0 to 60 min)' },
      lateEntry: LATE_ENTRY,
    },
  },
  dataSchema: {
    entries: {
      ...PROCESS_ENTRIES,
      HOPPER_CHARGE: {
        type: 'object',
        description: 'A blend container charged into a layer\'s hopper by its scan',
        fields: {
          layer: { type: 'string', pattern: STREAM, description: 'The layer' },
          hopper: { type: 'string', pattern: CODE, description: 'The hopper as scanned' },
          blend: { type: 'string', pattern: STAGE, description: 'The stage of the container scanned (its blend)' },
          chargeId: { type: 'string', pattern: UUID, description: 'The charge (plant.charge_container)' },
        },
      },
      ...RUN_ENTRIES,
    },
  },
  checkConfig,
  handler: { acceptEntry: accept, beforePerform },
  exceptionRules: [...PROCESS_EXCEPTION_RULES, ...(TB11.exceptionRules ?? [])],
  simulatorModel: { exceptionTypes: (phase) => [...PROCESS_EXCEPTION_RULES.map((r) => r.type), ...(TB11.simulatorModel?.exceptionTypes(phase) ?? [])], nominalEntries: nominal },
  goldenFixture: {
    description:
      'A bilayer run: layer L1 (blend BLEND_L1, hopper H1) checked alone by group weight every 15 min against 150 mg +/- 3 %; the full tablets (layer T, blend BLEND_L2, hopper H2) by group weight against 400 mg +/- 2 % and a physical check that examines lamination, with the 3-station sweep; both hoppers charged by scan, every check passes on time and at the end of the run; nothing missed, nothing held',
    controls: ['IN-35', 'PR-29'],
    phase: {
      block: { type: 'TB-16', version: '1' },
      config: {
        layers: [
          { id: 'L1', stage: 'BLEND_L1', hopper: 'H1', plan: [{ test: 'WEIGHT', every: { value: '15', unit: 'min' }, qrmRef: 'QRM-BL-01' }], weight: LAYER_WEIGHT },
          {
            id: 'T', stage: 'BLEND_L2', hopper: 'H2',
            plan: [{ test: 'WEIGHT', every: { value: '15', unit: 'min' }, qrmRef: 'QRM-BL-01' }, { test: 'PHYSICAL', every: { value: '15', unit: 'min' }, qrmRef: 'QRM-BL-01' }],
            sweep: { stations: 3, weight: { individual: { action: { min: '392.0', max: '408.0' } } } },
            weight: TOTAL_WEIGHT, physical: PHYSICAL,
          },
        ],
        grace: { value: '5', unit: 'min' },
      },
      equipment: [{ ref: 'PRESS', use: 'USE' }],
    },
    script: [
      { entry: { kind: 'HOPPER_CHARGE', layer: 'L1', hopper: 'H1', blend: 'BLEND_L1', chargeId: '00000000-0000-4000-8000-000000001601' } },
      { entry: { kind: 'HOPPER_CHARGE', layer: 'T', hopper: 'H2', blend: 'BLEND_L2', chargeId: '00000000-0000-4000-8000-000000001602' } },
      { entry: { kind: 'RUN_START', press: 'TEST-PRESS-01' } },
      { entry: { kind: 'STATION_SWEEP', instrument: 'TEST-BAL-01', capture: 'DEVICE', stream: 'T', readings: [0, 1, 2].map(GOLDEN_UUID), stations: ['399.0', '401.5', '400.2'].map((w, i) => ({ station: i + 1, weight: w })) } },
      { advanceUs: 600_000_000n },
      { entry: { kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'DEVICE', stream: 'L1', readings: [GOLDEN_UUID(3)], groupWeight: '1502.0' } },
      { entry: { kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'DEVICE', stream: 'T', readings: [GOLDEN_UUID(4)], groupWeight: '4001.0' } },
      { entry: { kind: 'PHYSICAL_CHECK', instrument: 'TEST-HT-01', capture: 'DEVICE', stream: 'T', readings: [5, 6].map(GOLDEN_UUID), tablets: [{ thickness: '5.40' }, { thickness: '5.42' }], defects: [] } },
      { advanceUs: 300_000_000n },
      { entry: { kind: 'RUN_END' } },
      { entry: { kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'DEVICE', stream: 'L1', readings: [GOLDEN_UUID(7)], groupWeight: '1497.5' } },
      { entry: { kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'DEVICE', stream: 'T', readings: [GOLDEN_UUID(8)], groupWeight: '3998.0' } },
      { entry: { kind: 'PHYSICAL_CHECK', instrument: 'TEST-HT-01', capture: 'DEVICE', stream: 'T', readings: [9, 10].map(GOLDEN_UUID), tablets: [{ thickness: '5.41' }, { thickness: '5.39' }], defects: [] } },
    ],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/forming/blocks.test.ts', 'apps/tablets-server/test/blocks/forming/db-guards.test.ts'],
};
