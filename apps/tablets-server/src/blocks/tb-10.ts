/**
 * TB-10@1 Compression set-up and first-off approval (tablets spec B.2 TB-10; Phase 3 slice 3c). Controls INV-24 (tooling
 * part), IN-26 (c), PR-23, PR-22, DI-31.
 *
 * The step runs on the press: G-06's configuration and entry kinds (common.ts) download the approved settings (turret
 * speed, pre-compression and main compression force, fill depth) and read them back, collect values, log alarms; the step
 * is bound to the press's process device, which must be the plant unit of the batch's open use of the press (tablets 0870).
 * Its own entries:
 *   PRESS_SETUP        the press (a PROCESS unit), the batch's open use of it (plant.start_equipment_use: started only on
 *                      a fit, clean, idle unit, PR-23) and the tooling issue of a TB-09 step of the batch for that press;
 *                      the database refuses it unless the tooling may compress: not returned or retired, inspected
 *                      before use, its strokes with this use so far below its limit (INV-24); once per step.
 *   PRE_USE_CHECKLIST  the pre-use checks, each once: dust extraction working, nozzles clean and no lubricant leaking into
 *                      product, a calibrated balance available (always), and the MBR's own items; all in order or the
 *                      first-off is refused.
 *   HOPPER_CHARGE      a container charged into the hopper, by its scan (plant.charge_container: refused for a label of
 *                      another batch, IN-26 (c), or a container that is not usable); after the set-up.
 *   FIRST_OFF          the first tablets checked: PASS or FAIL (FIRST_OFF_FAILED: adjust and check again); only after
 *                      the set-up, a checklist all in order and a charge. The step then needs its check signature, which
 *                      is the first-off approval (the MBR's check role, IPQA by default in the designer).
 *   SETTING_CHANGE     a setting changed during the run, with the reason; outside the MBR's approved range for that tag
 *                      it raises SETTING_OUT_OF_RANGE (a deviation).
 * Before PERFORMED: G-06's completeness, the set-up, a checklist all in order, a charge and a passing first-off; the
 * database also holds the tooling, the press's fitness and its open use at that moment (tablets 0874).
 */
import { Dec } from '@ebmr/expr';
import {
  acceptProcessEntry,
  CODE,
  configError,
  EQUIPMENT_CODE,
  isProcessKind,
  isRecord,
  problem,
  PROCESS_CONFIG_FIELDS,
  PROCESS_ENTRIES,
  PROCESS_EXCEPTION_RULES,
  processBeforePerform,
  processConfigProblems,
  processNominalEntries,
  refuse,
  uuidField,
  type BlockVersion,
  type Config,
  type ConfigProblem,
  type Entry,
  type EntryResult,
  type HandlerProblem,
  type HandlerView,
  type JsonValue,
  type MbrContent,
  type PhaseNode,
} from './compression/common.ts';

const CONTROLS = ['INV-24', 'IN-26', 'PR-23', 'PR-22', 'DI-31'];

/** The pre-use checks every press set-up records (tablets spec TB-10, Sched M VIII 1.6, 3.1, 3.3). */
export const REQUIRED_CHECKS = ['DUST_EXTRACTION', 'NOZZLES_CLEAN_NO_LEAK', 'CALIBRATED_BALANCE'] as const;

export function checklistOf(config: Config): string[] {
  const extra = Array.isArray(config['checklist']) ? config['checklist'].map(String) : [];
  return [...REQUIRED_CHECKS, ...extra.filter((x) => !(REQUIRED_CHECKS as readonly string[]).includes(x))];
}

export interface SettingRange {
  tag: string;
  unit: string;
  min: string;
  max: string;
}

export function settingRangesOf(config: Config): SettingRange[] {
  const r = config['settingRanges'];
  return Array.isArray(r) ? r.filter(isRecord).map((x) => ({ tag: String(x['tag']), unit: String(x['unit']), min: String(x['min']), max: String(x['max']) })) : [];
}

const setUp = (view: HandlerView): boolean => view.entries('PRESS_SETUP').length > 0;
const checklistOk = (view: HandlerView): boolean => view.entries('PRE_USE_CHECKLIST').at(-1)?.data['allOk'] === true;

function acceptChecklist(view: HandlerView, entry: Entry): EntryResult {
  const items = Array.isArray(entry['items']) ? entry['items'].filter(isRecord) : [];
  const named = items.map((i) => String(i['item']));
  const want = checklistOf(view.config);
  if (named.length !== new Set(named).size || named.length !== want.length || want.some((w) => !named.includes(w))) {
    return refuse('TB10-CHECKLIST', `The pre-use checklist records each of ${want.join(', ')} once`, ['PR-23']);
  }
  const ordered = want.map((w) => ({ item: w, ok: items.find((i) => i['item'] === w)?.['ok'] === true }));
  return { ok: true, data: { items: ordered, allOk: ordered.every((i) => i.ok), checkedBy: view.actor.id } };
}

function acceptFirstOff(view: HandlerView, entry: Entry): EntryResult {
  if (!setUp(view)) return refuse('TB10-NO-SETUP', `Set up the press of ${view.stepKey} first`, ['PR-23', 'INV-24']);
  if (!checklistOk(view)) return refuse('TB10-CHECKLIST-OPEN', 'The pre-use checklist is not all in order', ['PR-23']);
  if (view.entries('HOPPER_CHARGE').length === 0) return refuse('TB10-NOT-CHARGED', 'Charge the hopper by scan first', ['IN-26']);
  const failed = entry['result'] === 'FAIL';
  const observations = typeof entry['observations'] === 'string' ? entry['observations'] : undefined;
  return {
    ok: true,
    data: { result: entry['result'], ...(observations !== undefined ? { observations } : {}), recordedBy: view.actor.id },
    verificationRequired: true,
    ...(failed
      ? {
          exceptions: [
            {
              type: 'FIRST_OFF_FAILED',
              title: `The first-off tablets of ${view.stepKey} failed their check: adjust the press and check again`,
              controls: ['IN-35', 'PR-23'],
              severity: 'ALERT',
              category: 'OUT_OF_LIMIT',
              blocks: 'NONE',
            },
          ],
        }
      : {}),
  };
}

function acceptSetting(view: HandlerView, entry: Entry): EntryResult {
  if (!setUp(view)) return refuse('TB10-NO-SETUP', `Set up the press of ${view.stepKey} first`, ['PR-23']);
  const tag = String(entry['tag']);
  const range = settingRangesOf(view.config).find((r) => r.tag === tag);
  if (!range) return refuse('TB10-SETTING-TAG', `${tag} has no approved range in the MBR`, ['PR-08']);
  if (entry['unit'] !== range.unit) return refuse('TB10-SETTING-UNIT', `${tag} is set in ${range.unit}`, ['PR-08']);
  const v = Dec.parse(String(entry['value']));
  const within = v.gte(Dec.parse(range.min)) && v.lte(Dec.parse(range.max));
  return {
    ok: true,
    data: { tag, value: entry['value'], unit: entry['unit'], reason: entry['reason'], withinRange: within, changedBy: view.actor.id },
    ...(within
      ? {}
      : {
          exceptions: [
            {
              type: 'SETTING_OUT_OF_RANGE',
              title: `${tag} was set to ${String(entry['value'])} ${range.unit} at ${view.stepKey}, outside the approved ${range.min} to ${range.max}: the steps after it wait for a deviation`,
              controls: ['PR-08', 'PR-23'],
              severity: 'ACTION',
              category: 'OUT_OF_LIMIT',
              blocks: 'DOWNSTREAM',
              until: 'DEVIATION',
              deviationRequired: true,
              item: tag,
            },
          ],
        }),
  };
}

function acceptEntry(view: HandlerView, entry: Entry): EntryResult {
  if (isProcessKind(entry.kind)) return acceptProcessEntry(view, entry);
  switch (entry.kind) {
    case 'PRESS_SETUP':
      if (setUp(view)) return refuse('TB10-SETUP-TWICE', `The press of ${view.stepKey} is set up already`, ['PR-23']);
      return { ok: true, data: { press: entry['press'], useId: entry['useId'], issueId: entry['issueId'], setUpBy: view.actor.id } };
    case 'PRE_USE_CHECKLIST':
      return acceptChecklist(view, entry);
    case 'HOPPER_CHARGE':
      if (!setUp(view)) return refuse('TB10-NO-SETUP', `Set up the press of ${view.stepKey} first`, ['PR-23']);
      return { ok: true, data: { chargeId: entry['chargeId'], chargedBy: view.actor.id } };
    case 'FIRST_OFF':
      return acceptFirstOff(view, entry);
    case 'SETTING_CHANGE':
      return acceptSetting(view, entry);
    default:
      return refuse('TB10-ENTRY', `${entry.kind} is not an entry of a press set-up step`, ['PR-23']);
  }
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out = processBeforePerform(view);
  if (!setUp(view)) out.push(problem('TB10-NO-SETUP', `The press of ${view.stepKey} is not set up`, ['PR-23', 'INV-24']));
  if (!checklistOk(view)) out.push(problem('TB10-CHECKLIST-OPEN', 'The pre-use checklist is not all in order', ['PR-23']));
  if (view.entries('HOPPER_CHARGE').length === 0) out.push(problem('TB10-NOT-CHARGED', 'No container was charged into the hopper by scan', ['IN-26']));
  if (view.entries('FIRST_OFF').at(-1)?.data['result'] !== 'PASS') out.push(problem('TB10-FIRST-OFF', 'Routine compression starts only after a passing first-off check', ['IN-35', 'PR-23']));
  return out;
}

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const out = processConfigProblems(phase, config, mbr);
  if (!phase.equipment.some((q) => q.use === 'USE')) out.push(configError('TB10-NO-EQUIPMENT', `Press set-up step ${phase.id} names no press it uses`, ['PR-23', 'PR-22']));
  const tags = settingRangesOf(config).map((r) => r.tag);
  if (new Set(tags).size !== tags.length) out.push(configError('TB10-DUPLICATE-SETTING', `Press set-up step ${phase.id} lists a setting range twice`, ['PR-08']));
  for (const r of settingRangesOf(config)) {
    if (!Dec.isValid(r.min) || !Dec.isValid(r.max) || Dec.parse(r.min).gt(Dec.parse(r.max))) {
      out.push(configError('TB10-SETTING-RANGE', `The approved range of ${r.tag} at ${phase.id} has its minimum above its maximum`, ['PR-08']));
    }
  }
  return out;
}

const TAG_PATTERN = /^[a-z][a-z0-9_]*(\.[a-zA-Z0-9_]+)+$/;

export const TB10: BlockVersion = {
  type: 'TB-10',
  version: '1',
  title: 'Compression set-up and first-off approval',
  edition: 'tablets',
  aliases: { tablets: 'TB-10' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'Press settings through G-06, the press, its pre-use checklist and the approved ranges of in-run setting changes',
    fields: {
      ...PROCESS_CONFIG_FIELDS,
      pressClass: { type: 'string', enum: ['SINGLE_ROTARY', 'DOUBLE_ROTARY', 'SINGLE_PUNCH'], description: 'Kind of press' },
      stations: { type: 'integer', min: 1, max: 120, description: 'Number of stations' },
      sides: { type: 'string', enum: ['SINGLE', 'DOUBLE'], description: 'Single- or double-sided output' },
      checklist: { type: 'array', optional: true, minItems: 1, maxItems: 20, description: 'Pre-use checks besides the required three', items: { type: 'string', pattern: CODE, description: 'Check code' } },
      settingRanges: {
        type: 'array',
        optional: true,
        minItems: 1,
        maxItems: 20,
        description: 'Approved ranges of settings an operator may change during the run',
        items: {
          type: 'object',
          description: 'One setting',
          fields: {
            tag: { type: 'string', pattern: TAG_PATTERN, description: 'Process tag' },
            unit: { type: 'string', description: 'Unit' },
            min: { type: 'decimal', description: 'Lowest approved value' },
            max: { type: 'decimal', description: 'Highest approved value' },
          },
        },
      },
    },
  },
  dataSchema: {
    entries: {
      ...PROCESS_ENTRIES,
      PRESS_SETUP: {
        type: 'object',
        description: 'The press, the batch\'s open use of it and the tooling issued for it',
        fields: {
          press: { type: 'string', pattern: EQUIPMENT_CODE, description: 'Press equipment code' },
          useId: uuidField('The open use of the press by this batch'),
          issueId: uuidField('The tooling issue of a TB-09 step of this batch'),
        },
      },
      PRE_USE_CHECKLIST: {
        type: 'object',
        description: 'The pre-use checks of the press',
        fields: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 23,
            description: 'Each check once',
            items: { type: 'object', description: 'One check', fields: { item: { type: 'string', pattern: CODE, description: 'Check code' }, ok: { type: 'boolean', description: 'In order' } } },
          },
        },
      },
      HOPPER_CHARGE: { type: 'object', description: 'A container charged into the hopper by scan', fields: { chargeId: uuidField('The charge (plant.charge_container)') } },
      FIRST_OFF: {
        type: 'object',
        description: 'The first tablets checked',
        fields: { result: { type: 'string', enum: ['PASS', 'FAIL'], description: 'Result' }, observations: { type: 'string', optional: true, description: 'What was seen' } },
      },
      SETTING_CHANGE: {
        type: 'object',
        description: 'A setting changed during the run',
        fields: {
          tag: { type: 'string', pattern: TAG_PATTERN, description: 'Process tag' },
          value: { type: 'decimal', description: 'New value' },
          unit: { type: 'string', description: 'Unit' },
          reason: { type: 'string', description: 'Why it was changed' },
        },
      },
    },
  },
  checkConfig,
  handler: { acceptEntry, beforePerform },
  exceptionRules: [
    ...PROCESS_EXCEPTION_RULES,
    { type: 'FIRST_OFF_FAILED', category: 'OUT_OF_LIMIT', severity: 'ALERT', summary: 'The first-off tablets failed their check', controls: ['IN-35', 'PR-23'] },
    { type: 'SETTING_OUT_OF_RANGE', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A press setting changed outside its approved range', controls: ['PR-08', 'PR-23'] },
  ],
  simulatorModel: {
    exceptionTypes: () => [...PROCESS_EXCEPTION_RULES.map((r) => r.type), 'FIRST_OFF_FAILED', 'SETTING_OUT_OF_RANGE'],
    // Nominal: G-06's values, the set-up on the simulator's register ids, a checklist all in order, one charge and a
    // passing first-off.
    nominalEntries: (input) => [
      ...processNominalEntries(input),
      { kind: 'PRESS_SETUP', press: 'PRESS-01', useId: '00000000-0000-4000-8000-000000001001', issueId: '00000000-0000-4000-8000-000000000902' },
      { kind: 'PRE_USE_CHECKLIST', items: checklistOf(input.config).map((item) => ({ item, ok: true })) },
      { kind: 'HOPPER_CHARGE', chargeId: '00000000-0000-4000-8000-000000001002' },
      { kind: 'FIRST_OFF', result: 'PASS' },
    ],
  },
  goldenFixture: {
    description:
      'The press set up on its open use with the issued tooling, the checklist in order, the hopper charged by scan; the first first-off fails (FIRST_OFF_FAILED), a second passes; a main-force change inside its range; performed and the first-off approved by the check',
    controls: ['INV-24', 'IN-26', 'PR-23'],
    phase: {
      block: { type: 'TB-10', version: '1' },
      config: { pressClass: 'SINGLE_ROTARY', stations: 27, sides: 'SINGLE', settingRanges: [{ tag: 'force.main_kN', unit: 'kN', min: '10.0', max: '15.0' }] },
      equipment: [{ ref: 'PRESS', use: 'USE' }],
    },
    script: [
      { entry: { kind: 'PRESS_SETUP', press: 'PRESS-01', useId: '00000000-0000-4000-8000-000000001001', issueId: '00000000-0000-4000-8000-000000000902' } },
      { entry: { kind: 'PRE_USE_CHECKLIST', items: REQUIRED_CHECKS.map((item) => ({ item, ok: true })) } },
      { entry: { kind: 'HOPPER_CHARGE', chargeId: '00000000-0000-4000-8000-000000001002' } },
      { entry: { kind: 'FIRST_OFF', result: 'FAIL', observations: 'Capping at station 4' } },
      { entry: { kind: 'SETTING_CHANGE', tag: 'force.main_kN', value: '13.5', unit: 'kN', reason: 'Capping: main force raised' } },
      { entry: { kind: 'FIRST_OFF', result: 'PASS' } },
    ],
    expect: { exceptions: ['FIRST_OFF_FAILED'], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/compression/blocks.test.ts', 'apps/tablets-server/test/blocks/compression/db-guards.test.ts'],
};
