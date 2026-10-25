/**
 * "Add a coating layer" (Phase 7 slice 7o, R4 second check product and R8 C3; decision D-7o-2): one more coat of the same
 * tablets in the same pan, after a chosen step: the layer's own suspension (TB-03), its own cores step (TB-18 CORES: room,
 * pan load and the core sample of the tablets as they are now, into its own core item) and its own coating loop (TB-18
 * COATING to its own weight gain, into its own gain item with its own limits). So a seal coat, an enteric coat and a top
 * coat follow one another, each judged against its own core sample (C-16).
 *
 * The layer copies the settings an approved coating step of the master already has (room limits, pan load range, sample
 * size, coater values and limits, log interval, coater system, equipment, signatures) when there is one; otherwise it
 * starts from the block's defaults and the validator says what is left to set. The two items are new parameters of the
 * master: the core mean (mg, 6 decimals, critical, second-person check) with its validated range and the weight gain (a
 * process end point in %, 4 decimals) with the layer's maximum and, for a functional film, its minimum. Every value is
 * decimal text; nothing is a JavaScript number.
 *
 * Moved here from the web designer (slice 7s, D-7s-2) so the DEMO-ONLY P3 seed of the tablets server builds the same
 * layers the designer's "Add a coating layer" builds; the designer re-exports it.
 */
import { compareDecimal, isDecimalLiteral } from './decimal.ts';
import { childrenOf, walk, type FlowNode, type JsonValue, type LimitSource, type LimitSpec, type LoopNode, type MbrContent, type Parameter, type PhaseNode } from './model.ts';
import type { LimitRange } from '../limits/model.ts';

type Content = MbrContent;

export interface CoatingLayer {
  /** A short name of the layer, e.g. "Seal coat"; ids and items are made from it. */
  name: string;
  coatingType: 'FC' | 'FC_F' | 'SC';
  solutionType: 'FILM_COAT' | 'ENTERIC' | 'SUGAR';
  targetGain: string;
  /** Mandatory for a functional film (FC_F). */
  minGain?: string;
  maxGain: string;
  /** The validated range of the tablets' mean weight before this coat (mg). */
  coreLow: string;
  coreHigh: string;
  /** Iterations the loop allows (1 to 20). */
  maxIterations: number;
}

export interface LayerParts {
  steps: FlowNode[];
  parameters: Parameter[];
}

const COATER_DEFAULTS: { tag: string; unit: string; min: string; max: string }[] = [
  { tag: 'inlet.temp_C', unit: 'degC', min: '45.0', max: '65.0' },
  { tag: 'exhaust.temp_C', unit: 'degC', min: '35.0', max: '50.0' },
  { tag: 'bed.temp_C', unit: 'degC', min: '35.0', max: '48.0' },
  { tag: 'spray.rate_g_min', unit: 'g/min', min: '50.0', max: '200.0' },
  { tag: 'pan.speed_rpm', unit: 'rpm', min: '2.0', max: '12.0' },
];

/** A layer's problem in plain words, or null. */
export function layerProblem(l: CoatingLayer): string | null {
  if (l.name.trim() === '') return 'Name the layer (for example "Seal coat").';
  for (const [v, what] of [[l.targetGain, 'The target weight gain'], [l.maxGain, 'The maximum weight gain'], [l.coreLow, 'The lowest core mean'], [l.coreHigh, 'The highest core mean']] as const) {
    if (!isDecimalLiteral(v)) return `${what} must be a decimal number such as 2.5.`;
  }
  if (l.minGain !== undefined && !isDecimalLiteral(l.minGain)) return 'The minimum weight gain must be a decimal number such as 8.0.';
  if (l.coatingType === 'FC_F' && l.minGain === undefined) return 'A functional film sets its minimum weight gain.';
  if (l.minGain !== undefined && compareDecimal(l.minGain, l.maxGain) > 0) return 'The minimum weight gain is above the maximum.';
  if (compareDecimal(l.targetGain, l.maxGain) > 0) return 'The target weight gain is above the maximum.';
  if (compareDecimal(l.coreLow, l.coreHigh) > 0) return 'The lowest core mean is above the highest.';
  if (!Number.isInteger(l.maxIterations) || l.maxIterations < 1 || l.maxIterations > 20) return 'The loop allows 1 to 20 iterations.';
  return null;
}

/** Every id used in the content: tree nodes and list items (new ids never collide with any of them). */
export function contentIds(c: Content): Set<string> {
  const ids = new Set<string>();
  const visit = (n: FlowNode): void => {
    ids.add(n.id);
    if (n.kind === 'parallel') for (const b of n.branches) ids.add(b.id);
    if (n.kind === 'alternative') for (const b of n.branches) ids.add(b.id);
    childrenOf(n).forEach(visit);
  };
  ids.add(c.procedure.id);
  visit(c.procedure.body);
  for (const e of c.library) visit(e.body);
  for (const list of [c.references, c.inputs, c.bom, c.intermediates, c.parameters, c.calculations, c.yieldCheckpoints, c.acceptanceSchemes, c.timeConstraints, c.riskReductions, c.goldenCases]) {
    for (const x of list) ids.add(x.id);
  }
  return ids;
}

/** The first phase of a block type and part in the procedure (the model the layer copies its settings from). */
function modelOf(c: Content, type: string, part?: string): PhaseNode | undefined {
  let found: PhaseNode | undefined;
  walk(c.procedure.body, (n) => {
    if (!found && n.kind === 'phase' && n.block.type === type && (part === undefined || n.config['part'] === part)) found = n;
  });
  return found;
}

/**
 * The steps and items of a layer, with ids unique against `used` (the caller's set of every id of the content). `slug`
 * comes from the layer's name ("Seal coat" gives p-susp-seal-coat, p-cores-seal-coat, L-COAT-SEAL-COAT, p-coat-seal-coat
 * and the items coreSealCoat, gainSealCoat).
 */
export function coatingLayerParts(c: Content, l: CoatingLayer, used: ReadonlySet<string>): LayerParts {
  const words = l.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w !== '');
  const slug = words.join('-').slice(0, 24) || 'layer';
  const camel = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('').slice(0, 24) || 'Layer';
  const taken = new Set(used);
  const fresh = (base: string): string => {
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${String(n)}`;
    taken.add(id);
    return id;
  };
  const freshItem = (base: string): string => {
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}${String(n)}`;
    taken.add(id);
    return id;
  };
  const core = freshItem(`core${camel}`);
  const gain = freshItem(`gain${camel}`);
  const coatModel = modelOf(c, 'TB-18', 'COATING');
  const coresModel = modelOf(c, 'TB-18', 'CORES');
  const suspModel = modelOf(c, 'TB-03');
  const gainModel = c.parameters.find((p) => p.id === coatModel?.config['gainItem']);
  const source: LimitSource | undefined =
    gainModel?.limits?.ranges[0]?.source ?? (() => {
      const vr = c.references.find((r) => r.kind === 'VALIDATION_REPORT');
      return vr ? { kind: 'VALIDATION_REPORT' as const, ref: vr.id } : undefined;
    })();
  const witnessed: PhaseNode['signatures'] = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } };
  const verified: PhaseNode['signatures'] = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };
  const base = (id: string, name: string, type: string, config: Record<string, JsonValue>, signatures: PhaseNode['signatures']): PhaseNode => ({
    kind: 'phase', id, name, block: { type, version: '1' }, config, records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
    signatures, significant: true, riskClass: coatModel?.riskClass ?? 'HIGH',
  });
  const display = l.name.trim();
  const susp = base(fresh(`p-susp-${slug}`), `${display}: suspension`, 'TB-03', {
    solutionType: l.solutionType,
    solvent: (suspModel?.config['solvent']) ?? 'PURIFIED_WATER',
    useBy: (suspModel?.config['useBy']) ?? { value: '12', unit: 'h' },
  }, suspModel?.signatures ?? verified);
  const pick = (m: PhaseNode | undefined, keys: readonly string[]): Record<string, JsonValue> =>
    Object.fromEntries(keys.filter((k) => m?.config[k] !== undefined).map((k) => [k, structuredClone(m?.config[k]) as JsonValue]));
  const cores = base(fresh(`p-cores-${slug}`), `${display}: tablets, room and pan load before coating`, 'TB-18', {
    room: { temperatureMin: '20', temperatureMax: '25', humidityMax: '60' },
    sampleSize: '20',
    ...pick(coresModel, ['room', 'loadRange', 'sampleSize']),
    part: 'CORES', coatingType: l.coatingType, coreItem: core,
  }, coresModel?.signatures ?? witnessed);
  cores.records = [core];
  cores.equipment = structuredClone(coresModel?.equipment ?? []);
  const coatId = fresh(`p-coat-${slug}`);
  const coat = base(coatId, `${display} to its weight gain`, 'TB-18', {
    sampleSize: '20',
    actuals: COATER_DEFAULTS,
    manualFallback: true,
    ...pick(coatModel, ['sampleSize', 'actuals', 'setpoints', 'manualFallback', 'maxAgeSeconds', 'logInterval']),
    part: 'COATING', coatingType: l.coatingType, coreItem: core, gainItem: gain, targetGain: l.targetGain, maxGain: l.maxGain, ...(l.minGain !== undefined ? { minGain: l.minGain } : {}),
  }, coatModel?.signatures ?? witnessed);
  coat.records = [gain];
  coat.reads = [core];
  coat.equipment = structuredClone(coatModel?.equipment ?? []);
  if (coatModel?.system) coat.system = structuredClone(coatModel.system);
  const loop: LoopNode = {
    kind: 'loop', id: fresh(`L-COAT-${slug.toUpperCase()}`), name: `${display}: coat until the weight gain is reached`, maxIterations: l.maxIterations,
    exit: { condition: `${gain} >= ${l.minGain ?? l.targetGain} [%]`, endpoint: gain }, body: coat,
  };
  const range = (unit: string, bounds: Partial<Pick<LimitRange, 'low' | 'high'>>): LimitSpec | undefined =>
    source ? { unit, ranges: [{ tier: 'VALIDATED', ...bounds, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source }] } : undefined;
  const coreLimits = range('mg', { low: { value: l.coreLow, inclusive: true }, high: { value: l.coreHigh, inclusive: true } });
  const gainLimits = range('%', { ...(l.minGain !== undefined ? { low: { value: l.minGain, inclusive: true } } : {}), high: { value: l.maxGain, inclusive: true } });
  const parameters: Parameter[] = [
    {
      id: core, name: `Core mean weight before the ${display.toLowerCase()}`, valueType: 'DECIMAL', unit: 'mg', precision: { kind: 'DECIMALS', digits: 6 }, role: 'PROCESS_PARAMETER',
      criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'MANUAL', evidence: 'PRINTOUT', accuracyCheck: 'SECOND_PERSON', ...(coreLimits ? { limits: coreLimits } : {}),
    },
    {
      id: gain, name: `Weight gain of the ${display.toLowerCase()}`, valueType: 'DECIMAL', unit: '%', precision: { kind: 'DECIMALS', digits: 4 }, role: 'PROCESS_ENDPOINT',
      criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'MANUAL', evidence: 'PRINTOUT', accuracyCheck: 'SECOND_PERSON', ...(gainLimits ? { limits: gainLimits } : {}),
    },
  ] as Parameter[];
  return { steps: [susp, cores, loop], parameters };
}
