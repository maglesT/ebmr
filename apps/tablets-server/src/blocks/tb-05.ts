/**
 * TB-05@1 Drying with the LOD end-point loop (fluid bed or tray) and filter-bag control (tablets spec B.2 TB-05; Phase 3
 * slice 3b). Controls IN-36 (a), (d), IN-13, PR-27, PR-29, DI-29.
 *
 * One TB-05 step is one drying iteration. The MBR places it in a bounded repeat-until loop (G-19, ADR 0004) that exits
 * on the LOD parameter the step records (lodItem: a process end point with its limit tiers, the upper bound mandatory,
 * e.g. GB-T-01's 2.0 to 3.5 %). The maximum number of iterations is the loop's (1 to 10, TB05-ITERATIONS); every
 * iteration is its own step instance, kept in order; exhausting the loop raises the engine's exception (never rework).
 * LOD outside its tiers (over-drying included) is the engine's LIMIT_BREACH.
 *
 * Process values go through G-06@1 (inlet, bed and exhaust temperatures, air flow from the dryer). Entries besides:
 *   DRYING_START, DRYING_END  the drying of the iteration at the server's times (the duration is measured, never typed);
 *   LOD_SAMPLE                the LOD sample after drying: the moisture analyser and the sample mass;
 *   BAG_CHECK                 fluid bed only: the filter bag BEFORE (with the product it was last used for, its wash
 *                             record, and the product it is dedicated to) and AFTER use. A bag last used for another
 *                             product without a wash record is refused (TB05-BAG-WASH); where the MBR asks for
 *                             product-dedicated bags (highly potent or sensitising products), only a bag dedicated to the
 *                             batch's product (TB05-BAG-DEDICATED). Drying starts only after an intact BEFORE check; a
 *                             bag found damaged AFTER use raises FILTER_BAG_FAILED (deviation).
 * Before PERFORMED: G-06's completeness, the drying ended, the LOD sample taken, and (fluid bed) the bag checked after use.
 *
 * The database holds the same rules (tablets 0850), the loop bound included: no TB-05 step instance beyond the
 * enclosing loop's maximum.
 */
import {
  acceptProcessEntry,
  ancestorsOf,
  CODE,
  configError,
  isProcessKind,
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
  type HandlerProblem,
  type HandlerView,
  type Entry,
  type JsonValue,
  type MbrContent,
  type PhaseNode,
} from './granulation/common.ts';

const CONTROLS = ['IN-36', 'IN-13', 'PR-27', 'PR-29', 'DI-29'];
/** The loop bound the spec allows (maximum iterations 1 to 10; tablets spec TB-05). */
export const TB05_MAX_ITERATIONS = 10;

const fluidBed = (config: Config): boolean => config['dryer'] === 'FBD';
const dedicated = (config: Config): boolean => config['dedicatedBags'] === true;

function bagChecks(view: HandlerView): { before?: Record<string, unknown>; after?: Record<string, unknown> } {
  const checks = view.entries('BAG_CHECK');
  const before = checks.find((e) => e.data['when'] === 'BEFORE')?.data;
  const after = checks.find((e) => e.data['when'] === 'AFTER')?.data;
  return { ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

function acceptBag(view: HandlerView, entry: Entry): EntryResult {
  if (!fluidBed(view.config)) return refuse('TB05-NO-BAG', `${view.phase.id} is not a fluid-bed drying`, ['IN-36']);
  const { before, after } = bagChecks(view);
  const when = String(entry['when']);
  const bag = String(entry['bag']);
  const product = view.batch.productCode;
  if (when === 'BEFORE') {
    if (before) return refuse('TB05-BAG-TWICE', `${view.stepKey} already checked its filter bag before use`, ['IN-36']);
    const last = text(entry['lastProduct']);
    const fresh = entry['newBag'] === true;
    // Review 3b finding 4: the bag's history is always stated (the product it was last used for, or a new bag), unless
    // the MBR asks for product-dedicated bags (then its dedication decides); an omitted history never skips the wash rule.
    if (fresh && last !== undefined) return refuse('TB05-BAG-HISTORY', `Filter bag ${bag} is either new or was last used for a product, not both`, ['IN-36', 'PR-27']);
    if (!fresh && last === undefined && !dedicated(view.config)) {
      return refuse('TB05-BAG-HISTORY', `State the product filter bag ${bag} was last used for, or that it is new`, ['IN-36', 'PR-27']);
    }
    const wash = text(entry['washRecord']);
    const dedicatedTo = text(entry['dedicatedTo']);
    if (last !== undefined && last !== product && wash === undefined) {
      return refuse('TB05-BAG-WASH', `Filter bag ${bag} was last used for ${last}; it is used for ${product} only with its wash record`, ['IN-36', 'PR-27']);
    }
    if (dedicated(view.config) && dedicatedTo !== product) {
      return refuse('TB05-BAG-DEDICATED', `The MBR asks for a filter bag dedicated to ${product}; ${bag} is ${dedicatedTo === undefined ? 'not dedicated' : `dedicated to ${dedicatedTo}`}`, ['IN-36', 'PR-27']);
    }
    if (entry['result'] === 'DAMAGED') return refuse('TB05-BAG-DAMAGED', `Filter bag ${bag} is damaged; fit another bag`, ['IN-36']);
    return {
      ok: true,
      data: { bag, when, result: 'INTACT', ...(entry['newBag'] !== undefined ? { newBag: entry['newBag'] } : {}), ...(last !== undefined ? { lastProduct: last } : {}), ...(wash !== undefined ? { washRecord: wash } : {}), ...(dedicatedTo !== undefined ? { dedicatedTo } : {}), checkedBy: view.actor.id },
    };
  }
  if (!before) return refuse('TB05-BAG-ORDER', `Check the filter bag of ${view.stepKey} before use first`, ['IN-36']);
  if (after) return refuse('TB05-BAG-TWICE', `${view.stepKey} already checked its filter bag after use`, ['IN-36']);
  if (before['bag'] !== bag) return refuse('TB05-BAG-ORDER', `The bag checked after use is the one checked before use (${String(before['bag'])})`, ['IN-36']);
  if (entry['lastProduct'] !== undefined || entry['newBag'] !== undefined || entry['washRecord'] !== undefined || entry['dedicatedTo'] !== undefined) {
    return refuse('TB05-BAG-ORDER', 'The check after use names only the bag and what was found', ['IN-36']);
  }
  const damaged = entry['result'] === 'DAMAGED';
  return {
    ok: true,
    data: { bag, when, result: entry['result'], checkedBy: view.actor.id },
    ...(damaged
      ? {
          exceptions: [
            {
              type: 'FILTER_BAG_FAILED',
              title: `Filter bag ${bag} of ${view.stepKey} was found damaged after use: the steps after it wait for a deviation`,
              controls: ['IN-36', 'PR-27'],
              severity: 'ACTION',
              category: 'DEVIATION_OR_OVERRIDE',
              blocks: 'DOWNSTREAM',
              until: 'DEVIATION',
              deviationRequired: true,
              item: bag,
            },
          ],
        }
      : {}),
  };
}

function accept(view: HandlerView, entry: Entry): EntryResult {
  if (isProcessKind(entry.kind)) return acceptProcessEntry(view, entry);
  switch (entry.kind) {
    case 'DRYING_START':
      if (view.entries('DRYING_START').length > 0) return refuse('TB05-DRYING-TWICE', `${view.stepKey} already started drying`, ['IN-36']);
      if (fluidBed(view.config) && !bagChecks(view).before) return refuse('TB05-BAG-UNCHECKED', `Check the filter bag of ${view.stepKey} before drying`, ['IN-36', 'PR-27']);
      return { ok: true, data: { startedBy: view.actor.id } };
    case 'DRYING_END': {
      const start = view.entries('DRYING_START')[0];
      if (!start) return refuse('TB05-NOT-STARTED', `${view.stepKey} has not started drying`, ['IN-36']);
      if (view.entries('DRYING_END').length > 0) return refuse('TB05-DRYING-TWICE', `${view.stepKey} already ended drying`, ['IN-36']);
      return { ok: true, data: { dryingSeconds: secondsText(view.nowUs - start.recordedAt), endedBy: view.actor.id } };
    }
    case 'LOD_SAMPLE': {
      if (view.entries('DRYING_END').length === 0) return refuse('TB05-SAMPLE-EARLY', `The LOD sample of ${view.stepKey} is taken after drying`, ['IN-36', 'PR-29']);
      if (view.entries('LOD_SAMPLE').length > 0) return refuse('TB05-SAMPLE-TWICE', `${view.stepKey} already records its LOD sample; a new iteration takes the next`, ['DI-29']);
      return { ok: true, data: { analyser: entry['analyser'], sampleMass: quantityOf(entry['sampleMass']), sampledBy: view.actor.id } };
    }
    case 'BAG_CHECK':
      return acceptBag(view, entry);
    default:
      return refuse('TB05-ENTRY', `${entry.kind} is not an entry of a drying step`, ['IN-36']);
  }
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out = processBeforePerform(view);
  if (view.entries('DRYING_END').length === 0) out.push(problem('TB05-NOT-DRIED', `${view.stepKey} has not finished drying`, ['IN-36']));
  if (view.entries('LOD_SAMPLE').length === 0) out.push(problem('TB05-NO-SAMPLE', `${view.stepKey} has no LOD sample`, ['IN-36', 'PR-29']));
  if (fluidBed(view.config) && !bagChecks(view).after) out.push(problem('TB05-BAG-AFTER-MISSING', `Check the filter bag of ${view.stepKey} after use`, ['IN-36', 'PR-27']));
  return out;
}

/** The loop enclosing a TB-05 phase whose exit reads `lodItem` (the innermost such loop). */
export function lodLoopOf(mbr: MbrContent, phaseId: string, lodItem: string | undefined) {
  return ancestorsOf(mbr, phaseId)
    .filter((n) => n.kind === 'loop')
    .reverse()
    .find((n) => n.kind === 'loop' && n.exit.endpoint === lodItem);
}

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const out = processConfigProblems(phase, config, mbr);
  const lod = text(config['lodItem']);
  const p = mbr.parameters.find((q) => q.id === lod);
  if (!lod || !p || !phase.records.includes(lod) || p.valueType !== 'DECIMAL' || p.role !== 'PROCESS_ENDPOINT') {
    out.push(configError('TB05-LOD-ITEM', `Drying step ${phase.id} records its LOD as a decimal process end point (lodItem)`, ['IN-36', 'PR-29']));
  } else if (!p.limits?.ranges.some((r) => r.high !== undefined)) {
    out.push(configError('TB05-LOD-LIMITS', `The LOD of drying step ${phase.id} has no upper limit`, ['IN-36', 'PR-08']));
  }
  const loop = lodLoopOf(mbr, phase.id, lod);
  if (!loop) out.push(configError('TB05-NO-LOOP', `Drying step ${phase.id} sits in a bounded loop that exits on its LOD`, ['IN-36', 'DI-34']));
  else if (loop.kind === 'loop' && (loop.maxIterations < 1 || loop.maxIterations > TB05_MAX_ITERATIONS)) {
    out.push(configError('TB05-ITERATIONS', `The drying loop of ${phase.id} allows ${loop.maxIterations} iterations; the block allows 1 to ${TB05_MAX_ITERATIONS}`, ['IN-36', 'DI-34']));
  }
  if (!fluidBed(config) && config['dedicatedBags'] === true) out.push(configError('TB05-NO-BAG', `Tray drying step ${phase.id} has no filter bag to dedicate`, ['IN-36']));
  return out;
}

export const TB05: BlockVersion = {
  type: 'TB-05',
  version: '1',
  title: 'Drying with LOD loop and filter bag',
  edition: 'tablets',
  aliases: { tablets: 'TB-05' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'Process values through G-06, the LOD end point the loop exits on, the dryer and its filter-bag rule',
    fields: {
      ...PROCESS_CONFIG_FIELDS,
      dryer: { type: 'string', enum: ['FBD', 'TRAY'], description: 'Fluid-bed dryer or tray dryer' },
      lodItem: { type: 'string', description: 'The LOD parameter the step records (the enclosing loop exits on it)' },
      dedicatedBags: { type: 'boolean', optional: true, default: false, description: 'Only filter bags dedicated to the product (highly potent or sensitising products)' },
    },
  },
  dataSchema: {
    entries: {
      ...PROCESS_ENTRIES,
      DRYING_START: { type: 'object', description: 'Drying of the iteration starts (server time)', fields: {} },
      DRYING_END: { type: 'object', description: 'Drying of the iteration ends (server time)', fields: {} },
      LOD_SAMPLE: {
        type: 'object',
        description: 'The LOD sample of the iteration',
        fields: { analyser: { type: 'string', pattern: CODE, description: 'Moisture analyser' }, sampleMass: POSITIVE_QUANTITY },
      },
      BAG_CHECK: {
        type: 'object',
        description: 'The fluid-bed filter bag before or after use',
        fields: {
          bag: { type: 'string', pattern: CODE, description: 'Filter bag identification' },
          when: { type: 'string', enum: ['BEFORE', 'AFTER'], description: 'Before or after use' },
          result: { type: 'string', enum: ['INTACT', 'DAMAGED'], description: 'What the check found' },
          lastProduct: { type: 'string', optional: true, description: 'Product the bag was last used for (BEFORE; or newBag)' },
          newBag: { type: 'boolean', optional: true, description: 'The bag has never been used (BEFORE; instead of lastProduct)' },
          washRecord: { type: 'string', optional: true, description: 'Its wash record (BEFORE)' },
          dedicatedTo: { type: 'string', optional: true, description: 'Product the bag is dedicated to (BEFORE)' },
        },
      },
    },
  },
  checkConfig,
  handler: { acceptEntry: accept, beforePerform },
  exceptionRules: [
    ...PROCESS_EXCEPTION_RULES,
    { type: 'FILTER_BAG_FAILED', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'A filter bag found damaged after use', controls: ['IN-36', 'PR-27'] },
  ],
  simulatorModel: {
    exceptionTypes: () => [...PROCESS_EXCEPTION_RULES.map((r) => r.type), 'FILTER_BAG_FAILED'],
    nominalEntries: (input) => {
      const bag = fluidBed(input.config) ? [{ kind: 'BAG_CHECK', bag: 'BAG-1', when: 'BEFORE', result: 'INTACT', ...(dedicated(input.config) ? { dedicatedTo: 'PRODUCT' } : { newBag: true }) }] : [];
      const after = fluidBed(input.config) ? [{ kind: 'BAG_CHECK', bag: 'BAG-1', when: 'AFTER', result: 'INTACT' }] : [];
      return [...bag, ...processNominalEntries(input), { kind: 'DRYING_START' }, { kind: 'DRYING_END' }, { kind: 'LOD_SAMPLE', analyser: 'MA-1', sampleMass: { value: '5.000', unit: 'g' } }, ...after];
    },
  },
  goldenFixture: {
    description:
      'One fluid-bed drying iteration: the filter bag (last used for this product) checked before and after use, the inlet temperature read back and the bed temperature collected, 25 min of drying measured, the LOD sample taken and the LOD (2.8 %) recorded within 2.0 to 3.5 %; performed and verified (the loop is the MBR\'s, proven with the database)',
    controls: ['IN-36', 'PR-29'],
    phase: {
      block: { type: 'TB-05', version: '1' },
      records: ['lod'],
      config: {
        dryer: 'FBD',
        lodItem: 'lod',
        setpoints: [{ tag: 'dryer.inlet_temp_C', value: '60.0', unit: 'degC', tolerance: '2.0' }],
        actuals: [{ tag: 'dryer.bed_temp_C', unit: 'degC', max: '45.0' }],
        maxAgeSeconds: 3600,
      },
      system: { kind: 'PLC', ref: 'SYS-FBD', recipe: 'RCP-DRY', recipeVersion: '2' },
    },
    parameters: [
      {
        id: 'lod',
        name: 'Loss on drying',
        valueType: 'DECIMAL',
        unit: '%',
        semanticTag: 'lod',
        precision: { kind: 'DECIMALS', digits: 1 },
        role: 'PROCESS_ENDPOINT',
        criticality: 'CRITICAL',
        riskClass: 'HIGH',
        capture: 'DEVICE',
        limits: { unit: '%', ranges: [{ tier: 'VALIDATED', low: { value: '2.0', inclusive: true }, high: { value: '3.5', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] },
      },
    ],
    script: [
      { entry: { kind: 'BAG_CHECK', bag: 'BAG-07', when: 'BEFORE', result: 'INTACT', lastProduct: 'P' } },
      { entry: { kind: 'RECIPE_CHECK', recipe: 'RCP-DRY', recipeVersion: '2' } },
      { entry: { kind: 'SETPOINT_READBACK', tag: 'dryer.inlet_temp_C', value: '60.5', unit: 'degC', source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000021', quality: 'GOOD', receivedAtUs: '1790582400000000' } },
      { entry: { kind: 'DRYING_START' } },
      { entry: { kind: 'ACTUAL', tag: 'dryer.bed_temp_C', value: '38.5', unit: 'degC', source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000022', quality: 'GOOD', receivedAtUs: '1790582400000000' } },
      { advanceUs: 1_500_000_000n },
      { entry: { kind: 'DRYING_END' } },
      { entry: { kind: 'LOD_SAMPLE', analyser: 'MA-02', sampleMass: { value: '5.012', unit: 'g' } } },
      { record: 'lod', value: { kind: 'DECIMAL', value: '2.8', unit: '%' } },
      { entry: { kind: 'BAG_CHECK', bag: 'BAG-07', when: 'AFTER', result: 'INTACT' } },
    ],
    expect: { exceptions: [], values: { lod: '2.8' }, status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/granulation/blocks.test.ts', 'apps/tablets-server/test/blocks/granulation/db-guards.test.ts'],
};

