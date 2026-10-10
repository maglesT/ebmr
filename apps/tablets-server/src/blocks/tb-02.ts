/**
 * TB-02@1 Sifting, screening and milling with screen integrity before and after use (tablets spec B.2 TB-02; Phase 3
 * slice 3b). Controls IN-36 (b), (c), PR-23, PR-29, DI-29, INV-24 (the sieve part of the before-and-after check).
 *
 * The step runs on a sifter or mill the MBR names as the phase's USE equipment; that unit's status and use are G-09@2's
 * (a G-09 step of the MBR checks the same reference: TB02-EQUIPMENT-UNCHECKED), never this block's. The MBR lists the
 * screens the step may use with their approved aperture.
 *
 * Entries:
 *   SCREEN_CHECK   a screen's integrity BEFORE or AFTER use, with the aperture read from the screen: an unknown screen
 *                  or another aperture is refused (TB02-SCREEN, TB02-APERTURE). Per screen the checks alternate: a
 *                  BEFORE check opens a use (INTACT) and an AFTER check closes it; a screen found DAMAGED is never used
 *                  or checked again in the step (TB02-SCREEN-DAMAGED). An AFTER check that finds the screen DAMAGED
 *                  holds every material pass made through it since its last intact check (named in `held`) and raises
 *                  SCREEN_INTEGRITY_FAILED: the steps after it wait for a deviation. A check makes the step need a
 *                  second person (the verifier of the check).
 *   MATERIAL_PASS  one material through an intact, checked screen (TB02-NO-PRE-CHECK): quantity in and out (out never
 *                  above in, one unit), the oversize retained (mandatory unless the MBR turns the examination off),
 *                  foreign matter yes/no with its description; foreign matter raises FOREIGN_MATTER_FOUND (deviation).
 * Before PERFORMED: something was processed, and no screen is left without its AFTER check (IN-36: the after-use check
 * is mandatory before the step closes).
 *
 * The database holds the same rules (tablets 0850, tab.granulation_entry_problem and tab.granulation_perform_problem).
 */
import { Dec } from '@ebmr/expr';
import {
  CODE,
  configError,
  isRecord,
  phasesOf,
  problem,
  quantityOf,
  refuse,
  type BlockVersion,
  type Config,
  type ConfigProblem,
  type EntryRecord,
  type EntryResult,
  type ExceptionDraft,
  type HandlerProblem,
  type HandlerView,
  type Entry,
  type ObjectSchema,
} from './granulation/common.ts';

const CONTROLS = ['IN-36', 'PR-23', 'PR-29', 'DI-29', 'INV-24'];

export interface ScreenConfig {
  id: string;
  aperture: { value: string; unit: string };
}

export function screensOf(config: Config): ScreenConfig[] {
  const c = config['screens'];
  return Array.isArray(c)
    ? c.filter(isRecord).map((s) => ({ id: String(s['id']), aperture: quantityOf(s['aperture']) ?? { value: '', unit: '' } }))
    : [];
}

const oversizeExamined = (config: Config): boolean => config['oversizeExamination'] !== false;

type ScreenState = 'IDLE' | 'IN_USE' | 'DAMAGED';

/** Where each screen of the step stands: idle, in use since an intact BEFORE check, or damaged. */
export function screenStates(view: HandlerView): Map<string, ScreenState> {
  const out = new Map<string, ScreenState>();
  for (const e of view.entries('SCREEN_CHECK')) {
    const s = String(e.data['screen']);
    out.set(s, e.data['result'] === 'DAMAGED' ? 'DAMAGED' : e.data['when'] === 'BEFORE' ? 'IN_USE' : 'IDLE');
  }
  return out;
}

/** The material passes made through `screen` since its last intact check (the BEFORE check that opened its use). */
function passesSinceIntact(view: HandlerView, screen: string): EntryRecord[] {
  const checks = view.entries('SCREEN_CHECK').filter((e) => e.data['screen'] === screen && e.data['result'] === 'INTACT');
  const since = checks.at(-1)?.recordedSeq ?? -1;
  return view.entries('MATERIAL_PASS').filter((e) => e.data['screen'] === screen && e.recordedSeq > since);
}

function sameAperture(a: { value: string; unit: string }, b: { value: string; unit: string }): boolean {
  return a.unit === b.unit && Dec.isValid(a.value) && Dec.isValid(b.value) && Dec.parse(a.value).eq(Dec.parse(b.value));
}

function acceptCheck(view: HandlerView, entry: Entry): EntryResult {
  const screen = String(entry['screen']);
  const cfg = screensOf(view.config).find((s) => s.id === screen);
  if (!cfg) return refuse('TB02-SCREEN', `${screen} is not a screen the MBR lists for ${view.phase.id}`, ['IN-36', 'PR-23']);
  const aperture = quantityOf(entry['aperture']) ?? { value: '', unit: '' };
  if (!sameAperture(aperture, cfg.aperture)) {
    return refuse('TB02-APERTURE', `Screen ${screen} reads ${aperture.value} ${aperture.unit}; the MBR approves ${cfg.aperture.value} ${cfg.aperture.unit}`, ['IN-36', 'PR-23']);
  }
  const state = screenStates(view).get(screen) ?? 'IDLE';
  if (state === 'DAMAGED') return refuse('TB02-SCREEN-DAMAGED', `Screen ${screen} was found damaged and is never used again`, ['IN-36', 'PR-23']);
  const when = String(entry['when']);
  if (when === 'BEFORE' && state === 'IN_USE') return refuse('TB02-CHECK-ORDER', `Screen ${screen} is in use; check it after use first`, ['IN-36']);
  if (when === 'AFTER' && state !== 'IN_USE') return refuse('TB02-CHECK-ORDER', `Screen ${screen} was not checked before use`, ['IN-36']);
  const damaged = entry['result'] === 'DAMAGED';
  const exceptions: ExceptionDraft[] = [];
  const data: Record<string, unknown> = { screen, aperture: { value: aperture.value, unit: aperture.unit }, when, result: entry['result'] };
  if (damaged && when === 'AFTER') {
    const held = passesSinceIntact(view, screen).map((e) => e.id);
    data['held'] = held;
    exceptions.push({
      type: 'SCREEN_INTEGRITY_FAILED',
      title: `Screen ${screen} of ${view.stepKey} was found damaged after use: the material passed through it since its last intact check (${held.length > 0 ? held.join(', ') : 'none'}) is held and the steps after it wait for a deviation`,
      controls: ['IN-36', 'INV-24', 'PR-29'],
      severity: 'ACTION',
      category: 'DEVIATION_OR_OVERRIDE',
      blocks: 'DOWNSTREAM',
      until: 'DEVIATION',
      deviationRequired: true,
      item: screen,
    });
  } else if (damaged) {
    exceptions.push({
      type: 'SCREEN_DAMAGED',
      title: `Screen ${screen} of ${view.stepKey} was found damaged before use: it is not used`,
      controls: ['IN-36', 'PR-23'],
      severity: 'ALERT',
      category: 'DEVIATION_OR_OVERRIDE',
      blocks: 'NONE',
      item: screen,
    });
  }
  return { ok: true, data: { ...data, checkedBy: view.actor.id }, verificationRequired: true, ...(exceptions.length > 0 ? { exceptions } : {}) };
}

function acceptPass(view: HandlerView, entry: Entry): EntryResult {
  const screen = String(entry['screen']);
  if ((screenStates(view).get(screen) ?? 'IDLE') !== 'IN_USE') {
    return refuse('TB02-NO-PRE-CHECK', `Screen ${screen} has no intact check before this use; check it first`, ['IN-36', 'INV-24']);
  }
  const qIn = quantityOf(entry['quantityIn']);
  const qOut = quantityOf(entry['quantityOut']);
  const over = quantityOf(entry['oversize']);
  if (!qIn || !qOut || qIn.unit !== qOut.unit || Dec.parse(qOut.value).gt(Dec.parse(qIn.value)) || (over !== undefined && (over.unit !== qIn.unit || Dec.parse(over.value).gt(Dec.parse(qIn.value))))) {
    return refuse('TB02-QUANTITY', 'The quantity out and the oversize are in the unit of the quantity in and never above it', ['PR-29', 'DI-29']);
  }
  if (oversizeExamined(view.config) && over === undefined) {
    return refuse('TB02-OVERSIZE', 'The MBR asks for the oversize retained on the screen to be examined and recorded', ['IN-36']);
  }
  const foreign = entry['foreignMatter'] === true;
  const description = typeof entry['foreignMatterDescription'] === 'string' ? entry['foreignMatterDescription'] : undefined;
  if (foreign !== (description !== undefined)) {
    return refuse('TB02-FOREIGN-MATTER', 'Foreign matter found is described; none found has no description', ['IN-36']);
  }
  const data: Record<string, unknown> = {
    screen,
    material: entry['material'],
    ...(typeof entry['lot'] === 'string' ? { lot: entry['lot'] } : {}),
    quantityIn: qIn,
    quantityOut: qOut,
    ...(over ? { oversize: over } : {}),
    foreignMatter: foreign,
    ...(description !== undefined ? { foreignMatterDescription: description } : {}),
    recordedBy: view.actor.id,
  };
  const exceptions: ExceptionDraft[] = foreign
    ? [
        {
          type: 'FOREIGN_MATTER_FOUND',
          title: `Foreign matter in the residue of ${String(entry['material'])} on screen ${screen} at ${view.stepKey}: the steps after it wait for a deviation`,
          controls: ['IN-36', 'PR-29'],
          severity: 'ACTION',
          category: 'DEVIATION_OR_OVERRIDE',
          blocks: 'DOWNSTREAM',
          until: 'DEVIATION',
          deviationRequired: true,
          item: screen,
        },
      ]
    : [];
  return { ok: true, data, ...(exceptions.length > 0 ? { exceptions } : {}) };
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out: HandlerProblem[] = [];
  if (view.entries('MATERIAL_PASS').length === 0) out.push(problem('TB02-NOTHING-PROCESSED', `${view.stepKey} has no material pass`, ['IN-36', 'PR-29']));
  const open = [...screenStates(view)].filter(([, s]) => s === 'IN_USE').map(([k]) => k);
  if (open.length > 0) out.push(problem('TB02-AFTER-CHECK-MISSING', `Check screen ${open.join(', ')} after use before the step closes`, ['IN-36', 'INV-24']));
  return out;
}

function checkConfig(phase: Parameters<NonNullable<BlockVersion['checkConfig']>>[0], config: Config, mbr: Parameters<NonNullable<BlockVersion['checkConfig']>>[2]): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const ids = screensOf(config).map((s) => s.id);
  const dup = [...new Set(ids.filter((s, i) => ids.indexOf(s) !== i))];
  if (dup.length > 0) out.push(configError('TB02-DUPLICATE-SCREEN', `Sifting step ${phase.id} lists screen ${dup.join(', ')} twice`, ['IN-36']));
  const uses = phase.equipment.filter((q) => q.use === 'USE').map((q) => q.ref);
  if (uses.length === 0) {
    out.push(configError('TB02-NO-EQUIPMENT', `Sifting step ${phase.id} names no sifter or mill it uses`, ['PR-23', 'IN-36']));
  } else {
    const checked = new Set(phasesOf(mbr).filter((p) => p.block.type === 'G-09').flatMap((p) => p.equipment.filter((q) => q.use === 'STATUS_CHECK').map((q) => q.ref)));
    const unchecked = uses.filter((r) => !checked.has(r));
    if (unchecked.length > 0) out.push(configError('TB02-EQUIPMENT-UNCHECKED', `No equipment status step (G-09) of the MBR checks ${unchecked.join(', ')}, which sifting step ${phase.id} uses`, ['PR-23', 'INV-12']));
  }
  return out;
}

const APERTURE: ObjectSchema = {
  type: 'object',
  description: 'Screen aperture: decimal text in micrometres, millimetres or as a mesh number',
  fields: { value: { type: 'decimal', min: '0', minExclusive: true, description: 'Aperture or mesh number' }, unit: { type: 'string', enum: ['um', 'mm', 'mesh'], description: 'um, mm or mesh' } },
};

export const TB02: BlockVersion = {
  type: 'TB-02',
  version: '1',
  title: 'Sifting and milling with screen integrity',
  edition: 'tablets',
  aliases: { tablets: 'TB-02' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'The sifter or mill class, the screens the step may use with their approved aperture, and the residue examination',
    fields: {
      equipmentClass: { type: 'string', enum: ['VIBRO_SIFTER', 'CO_MILL', 'MULTIMILL', 'OSCILLATING_GRANULATOR', 'CONE_MILL'], description: 'Kind of sifter or mill' },
      screens: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        description: 'Screens or sieves the step may use',
        items: { type: 'object', description: 'One screen', fields: { id: { type: 'string', pattern: CODE, description: 'Screen identification as scanned' }, aperture: APERTURE } },
      },
      oversizeExamination: { type: 'boolean', optional: true, default: true, description: 'The oversize retained is examined and recorded for every material (Sched M VIII 2.2)' },
    },
  },
  dataSchema: {
    entries: {
      SCREEN_CHECK: {
        type: 'object',
        description: 'Integrity of a screen before or after use',
        fields: {
          screen: { type: 'string', pattern: CODE, description: 'Screen identification as scanned' },
          aperture: APERTURE,
          when: { type: 'string', enum: ['BEFORE', 'AFTER'], description: 'Before or after use' },
          result: { type: 'string', enum: ['INTACT', 'DAMAGED'], description: 'What the check found' },
        },
      },
      MATERIAL_PASS: {
        type: 'object',
        description: 'One material through a checked screen',
        fields: {
          screen: { type: 'string', pattern: CODE, description: 'Screen used' },
          material: { type: 'string', description: 'Material, BOM line or intermediate' },
          lot: { type: 'string', optional: true, description: 'Lot or container' },
          quantityIn: { type: 'object', description: 'Quantity fed', fields: { value: { type: 'decimal', min: '0', minExclusive: true, description: 'Decimal text' }, unit: { type: 'string', description: 'Unit' } } },
          quantityOut: { type: 'object', description: 'Quantity through the screen', fields: { value: { type: 'decimal', min: '0', description: 'Decimal text' }, unit: { type: 'string', description: 'Unit' } } },
          oversize: { type: 'object', optional: true, description: 'Oversize retained', fields: { value: { type: 'decimal', min: '0', description: 'Decimal text' }, unit: { type: 'string', description: 'Unit' } } },
          foreignMatter: { type: 'boolean', description: 'Foreign matter found in the residue' },
          foreignMatterDescription: { type: 'string', optional: true, description: 'What was found' },
        },
      },
    },
  },
  checkConfig,
  handler: {
    acceptEntry: (view, entry) => {
      if (entry.kind === 'SCREEN_CHECK') return acceptCheck(view, entry);
      if (entry.kind === 'MATERIAL_PASS') return acceptPass(view, entry);
      return refuse('TB02-ENTRY', `${entry.kind} is not an entry of a sifting step`, ['IN-36']);
    },
    beforePerform,
  },
  exceptionRules: [
    { type: 'SCREEN_INTEGRITY_FAILED', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'A screen found damaged after use; the material since its last intact check is held', controls: ['IN-36', 'INV-24', 'PR-29'] },
    { type: 'SCREEN_DAMAGED', category: 'DEVIATION_OR_OVERRIDE', severity: 'ALERT', summary: 'A screen found damaged before use', controls: ['IN-36', 'PR-23'] },
    { type: 'FOREIGN_MATTER_FOUND', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'Foreign matter in a sieve residue', controls: ['IN-36', 'PR-29'] },
  ],
  simulatorModel: {
    exceptionTypes: () => ['SCREEN_INTEGRITY_FAILED', 'SCREEN_DAMAGED', 'FOREIGN_MATTER_FOUND'],
    // Nominal: the first screen checked intact before and after one pass of the first consumed material.
    nominalEntries: ({ phase, config }) => {
      const s = screensOf(config)[0];
      if (!s) return [];
      const check = (when: string) => ({ kind: 'SCREEN_CHECK', screen: s.id, aperture: s.aperture, when, result: 'INTACT' });
      const pass = {
        kind: 'MATERIAL_PASS',
        screen: s.id,
        material: phase.consumes[0] ?? phase.uses[0] ?? 'MATERIAL',
        quantityIn: { value: '10.000', unit: 'kg' },
        quantityOut: { value: '9.990', unit: 'kg' },
        ...(oversizeExamined(config) ? { oversize: { value: '0.010', unit: 'kg' } } : {}),
        foreignMatter: false,
      };
      return [check('BEFORE'), pass, check('AFTER')];
    },
  },
  goldenFixture: {
    description:
      'Two materials sifted through screen SCR-40 checked intact before use; the after-use check finds it damaged: both passes are held, SCREEN_INTEGRITY_FAILED waits for a deviation; performed and verified',
    controls: ['IN-36', 'INV-24'],
    phase: {
      block: { type: 'TB-02', version: '1' },
      config: { equipmentClass: 'VIBRO_SIFTER', screens: [{ id: 'SCR-40', aperture: { value: '425', unit: 'um' } }] },
      equipment: [{ ref: 'SIFTER', use: 'USE' }],
    },
    script: [
      { entry: { kind: 'SCREEN_CHECK', screen: 'SCR-40', aperture: { value: '425', unit: 'um' }, when: 'BEFORE', result: 'INTACT' } },
      { entry: { kind: 'MATERIAL_PASS', screen: 'SCR-40', material: 'BOM-API', quantityIn: { value: '12.500', unit: 'kg' }, quantityOut: { value: '12.480', unit: 'kg' }, oversize: { value: '0.020', unit: 'kg' }, foreignMatter: false } },
      { entry: { kind: 'MATERIAL_PASS', screen: 'SCR-40', material: 'BOM-MCC', quantityIn: { value: '30.000', unit: 'kg' }, quantityOut: { value: '29.950', unit: 'kg' }, oversize: { value: '0.050', unit: 'kg' }, foreignMatter: false } },
      { entry: { kind: 'SCREEN_CHECK', screen: 'SCR-40', aperture: { value: '425', unit: 'um' }, when: 'AFTER', result: 'DAMAGED' } },
    ],
    expect: { exceptions: ['SCREEN_INTEGRITY_FAILED'], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/granulation/blocks.test.ts', 'apps/tablets-server/test/blocks/granulation/db-guards.test.ts'],
};
