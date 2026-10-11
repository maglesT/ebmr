/**
 * TB-23@1 Bottle line: count verification, desiccant, closure torque, induction seal, labelling and bright stock
 * (tablets spec B.2 TB-23; Phase 3 slice 4b, builder B). Controls PR-37, PR-38, PR-41, IN-17, IN-22.
 *
 * The line is one plant PROCESS unit (config `unit`, of no other packaging step). Its checks run on a schedule
 * (`checkEvery`), each a stream of the unit (bottle/common.ts):
 *   COUNT_CHECK      the tablets counted in each bottle sampled; PASS only when every bottle holds the MBR's count;
 *   DESICCANT_CHECK  bottles examined and those missing the desiccant or coil (when the MBR names one); PASS with none;
 *   TORQUE_CHECK     application and removal torque on the MBR's tester (a plant instrument with a use for this batch
 *                    open now: its calibration and per-use check passed; the database checks it), each within the MBR's
 *                    limits;
 *   SEAL_CHECK       bottles examined and defective induction seals; on a US OTC retail pack (tamperEvident) also that
 *                    the labelling statement names the tamper-evident feature (PR-41); PASS with no defect.
 * A failing check raises LINE_CHECK_FAILED, a check later than the interval after the stream's previous one
 * LINE_CHECK_MISSED (both: the steps after it wait for a deviation), and the database holds every container of the unit
 * opened since that stream's last passing check (slice 1 container hold).
 *   CHALLENGE        a challenge of an inspection device (count verifier, checkweigher, desiccant or seal detector,
 *                    vision, reader) by G-21@1's own rule (two persons): a failed or late one raises CHALLENGE_FAILED or
 *                    CHALLENGE_MISSED, which stop the step until QA decides, and holds the unit's output since the
 *                    device's last passing challenge; while a device's last challenge failed, no output is counted
 *                    (GOOD_OUTPUT, BRIGHT_STOCK, BRIGHT_STOCK_USE are refused: the step is stopped).
 *   REJECTS          bottles rejected by type; rejects are destroyed, never returned (the schema has no other way).
 *   BRIGHT_STOCK     filled, unlabelled bottles set aside for later labelling (PR-38), where the MBR allows it: the block
 *                    writes their identification from the record (product name, strength, batch, bottles, count per
 *                    bottle) under the step's next tag number;
 *   BRIGHT_STOCK_USE bright stock taken back to labelling only by the scan of its tag's batch and product, matching this
 *                    batch, never more than is left under the tag (PR-38);
 *   GOOD_OUTPUT      the good labelled bottles, once.
 * The roll labels are issued and reconciled at the MBR's G-21 step (`labelStep`, item `labelItem`): that step always
 * reconciles and is never skipped (IN-17, INV-32), and the MBR is not accepted without it (here and in the database).
 * Before PERFORMED: each stream checked with its last check passing and none due; each device's START and END challenge
 * passing (G-21); the good output recorded; every bright stock tag used up.
 */
import { Dec } from '@ebmr/expr';
import { blocks } from '@ebmr/recipe-core/pure';
import {
  acceptChallenge,
  big,
  CHALLENGE_RULES,
  CHECK_RULES,
  checkExceptions,
  challengeProblems,
  configError,
  COUNT,
  countField,
  deviceConfigProblems,
  deviceSchema,
  g21Phase,
  INTERVAL,
  intervalOf,
  isRecord,
  missedNow,
  phasesOf,
  positiveCountField,
  problem,
  refuse,
  sharedUnitProblem,
  stoppedDevices,
  streamProblems,
  text,
  UNIT_CODE,
  usOtcRetail,
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
} from './bottle/common.ts';

/** G-21@1's CHALLENGE schema, unchanged (the entries are G-21's). */
export const G21_CHALLENGE = (blocks.G21.dataSchema as NonNullable<BlockVersion['dataSchema']>).entries['CHALLENGE'] as NonNullable<BlockVersion['dataSchema']>['entries'][string];

const CONTROLS = ['PR-37', 'PR-38', 'PR-41', 'IN-17', 'IN-22'];
export const BOTTLE_DEVICE_KINDS = ['COUNT_VERIFIER', 'CHECKWEIGHER', 'DESICCANT_DETECTOR', 'SEAL_DETECTOR', 'VISION', 'READER'] as const;
export const REJECT_REASONS = ['COUNT', 'DESICCANT_MISSING', 'TORQUE', 'SEAL', 'LABEL', 'CHECKWEIGHER', 'OTHER'] as const;
export const TORQUE_UNITS = ['N.m', 'lbf.in'] as const;

/** The scheduled streams of a TB-23 configuration: COUNT, DESICCANT (when a desiccant is named), TORQUE, SEAL. */
export function streamsOf(config: Config): { stream: string; every: bigint | undefined; what: string }[] {
  const every = intervalOf(config['checkEvery']);
  return [
    { stream: 'COUNT', every, what: 'count check' },
    ...(isRecord(config['desiccant']) ? [{ stream: 'DESICCANT', every, what: 'desiccant check' }] : []),
    { stream: 'TORQUE', every, what: 'torque check' },
    { stream: 'SEAL', every, what: 'seal check' },
  ];
}

const limitsOf = (v: unknown): { min: Dec; max: Dec } | undefined =>
  isRecord(v) && Dec.isValid(v['min']) && Dec.isValid(v['max']) ? { min: Dec.parse(String(v['min'])), max: Dec.parse(String(v['max'])) } : undefined;

const within = (values: readonly string[], l: { min: Dec; max: Dec } | undefined): boolean => l !== undefined && values.every((v) => Dec.parse(v).gte(l.min) && Dec.parse(v).lte(l.max));

/** The product identification the record gives bright stock (PR-38). */
export function productOf(mbr: MbrContent): { code: string; name: string; strength: string } {
  const p = mbr.header.product;
  return { code: p.code, name: p.name, strength: p.strength };
}

/** Bottles left under bright stock tag `tag` (set aside less used back). */
export function brightLeft(view: HandlerView, tag: string): bigint {
  const set = view.entries('BRIGHT_STOCK').filter((e) => e.data['tag'] === tag).reduce((a, e) => a + big(e.data['bottles']), 0n);
  const used = view.entries('BRIGHT_STOCK_USE').filter((e) => e.data['tag'] === tag).reduce((a, e) => a + big(e.data['bottles']), 0n);
  return set - used;
}

function check(view: HandlerView, entry: Entry, stream: string, what: string, pass: boolean, data: Record<string, unknown>): EntryResult {
  const missed = missedNow(view, stream, intervalOf(view.config['checkEvery']));
  const exceptions = checkExceptions(view, stream, what, missed, pass, ['PR-37', 'IN-22']);
  void entry;
  return {
    ok: true,
    data: { stream, ...data, result: pass ? 'PASS' : 'FAIL', missed, checkedBy: view.actor.id },
    ...(exceptions.length > 0 ? { exceptions } : {}),
  };
}

function stopped(view: HandlerView): EntryResult | undefined {
  const s = stoppedDevices(view);
  return s.length > 0 ? refuse('TB23-STOPPED', `The line of ${view.stepKey} is stopped: ${s.join(', ')} failed its last challenge; no output is counted before a passing challenge`, ['IN-22', 'PR-37']) : undefined;
}

function acceptEntry(view: HandlerView, entry: Entry): EntryResult {
  const cfg = view.config;
  switch (entry.kind) {
    case 'COUNT_CHECK': {
      const counts = Array.isArray(entry['counts']) ? entry['counts'].map(String) : [];
      const expected = text(cfg['countPerBottle']) ?? '';
      return check(view, entry, 'COUNT', 'count check', counts.every((c) => c === expected), { counts, expected });
    }
    case 'DESICCANT_CHECK': {
      if (!isRecord(cfg['desiccant'])) return refuse('TB23-NO-DESICCANT', `The MBR names no desiccant for ${view.phase.id}`, ['PR-37']);
      const examined = big(entry['examined']);
      const missing = big(entry['missing']);
      if (missing > examined) return refuse('TB23-COUNTS', `More bottles without a desiccant (${missing}) than examined (${examined})`, ['PR-37']);
      return check(view, entry, 'DESICCANT', 'desiccant check', missing === 0n, { examined: entry['examined'], missing: entry['missing'], desiccant: cfg['desiccant']['item'] });
    }
    case 'TORQUE_CHECK': {
      const t = isRecord(cfg['torque']) ? cfg['torque'] : {};
      const application = Array.isArray(entry['application']) ? entry['application'].map(String) : [];
      const removal = Array.isArray(entry['removal']) ? entry['removal'].map(String) : [];
      const pass = within(application, limitsOf(t['application'])) && within(removal, limitsOf(t['removal']));
      return check(view, entry, 'TORQUE', 'torque check', pass, { tester: entry['tester'], application, removal, unit: t['unit'] });
    }
    case 'SEAL_CHECK': {
      const examined = big(entry['examined']);
      const defective = big(entry['defective']);
      if (defective > examined) return refuse('TB23-COUNTS', `More defective seals (${defective}) than bottles examined (${examined})`, ['PR-37']);
      const te = cfg['tamperEvident'] === true;
      if (te !== (typeof entry['statementChecked'] === 'boolean')) {
        return refuse('TB23-TAMPER-EVIDENT', te ? 'A US OTC retail pack\'s seal check also checks the labelling statement of the tamper-evident feature' : 'Only a tamper-evident pack\'s seal check states the labelling statement check', ['PR-41']);
      }
      const pass = defective === 0n && (!te || entry['statementChecked'] === true);
      return check(view, entry, 'SEAL', 'seal check', pass, { examined: entry['examined'], defective: entry['defective'], ...(te ? { statementChecked: entry['statementChecked'] } : {}) });
    }
    case 'CHALLENGE':
      return acceptChallenge(view, entry);
    case 'REJECTS':
      return { ok: true, data: { reason: entry['reason'], bottles: entry['bottles'], disposition: 'DESTRUCTION', recordedBy: view.actor.id } };
    case 'BRIGHT_STOCK': {
      if (cfg['brightStock'] !== true) return refuse('TB23-NO-BRIGHT-STOCK', `The MBR does not let ${view.phase.id} set filled, unlabelled bottles aside`, ['PR-38']);
      const s = stopped(view);
      if (s) return s;
      const tag = String(view.entries('BRIGHT_STOCK').length + 1);
      return {
        ok: true,
        data: { tag, bottles: entry['bottles'], product: productOf(view.mbr), batch: view.batch.batchNumber, countPerBottle: cfg['countPerBottle'], setAsideBy: view.actor.id },
      };
    }
    case 'BRIGHT_STOCK_USE': {
      const s = stopped(view);
      if (s) return s;
      const tag = String(entry['tag']);
      if (!view.entries('BRIGHT_STOCK').some((e) => e.data['tag'] === tag)) return refuse('TB23-BRIGHT-STOCK-TAG', `${tag} is no bright stock of ${view.stepKey}`, ['PR-38']);
      if (entry['scannedBatch'] !== view.batch.batchNumber || entry['scannedProduct'] !== productOf(view.mbr).code) {
        return refuse('TB23-BRIGHT-STOCK-SCAN', `The bright stock scanned is of batch ${String(entry['scannedBatch'])} and product ${String(entry['scannedProduct'])}: only this batch's own is labelled here`, ['PR-38']);
      }
      if (big(entry['bottles']) > brightLeft(view, tag)) return refuse('TB23-BRIGHT-STOCK-QUANTITY', `Only ${brightLeft(view, tag)} bottles are left under ${tag}`, ['PR-38']);
      return { ok: true, data: { tag, bottles: entry['bottles'], scannedBatch: entry['scannedBatch'], scannedProduct: entry['scannedProduct'], usedBy: view.actor.id } };
    }
    case 'GOOD_OUTPUT': {
      const s = stopped(view);
      if (s) return s;
      if (view.entries('GOOD_OUTPUT').length > 0) return refuse('TB23-OUTPUT-TWICE', `${view.stepKey} records its good output once`, ['IN-17']);
      return { ok: true, data: { bottles: entry['bottles'], recordedBy: view.actor.id } };
    }
    default:
      return refuse('TB23-ENTRY', `${entry.kind} is not an entry of a bottle line step`, ['IN-22']);
  }
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out = [...streamProblems(view, streamsOf(view.config), 'TB23', ['PR-37', 'IN-22']), ...challengeProblems(view)];
  if (view.entries('GOOD_OUTPUT').length === 0) out.push(problem('TB23-NO-OUTPUT', `Record the good bottles of ${view.stepKey}`, ['IN-17']));
  const open = [...new Set(view.entries('BRIGHT_STOCK').map((e) => String(e.data['tag'])))].filter((t) => brightLeft(view, t) > 0n);
  if (open.length > 0) out.push(problem('TB23-BRIGHT-STOCK-OPEN', `Bright stock ${open.join(', ')} is not labelled yet`, ['PR-38']));
  return out;
}

/** Why the roll-label G-21 step of a TB-23 phase is missing or wrong (undefined when it is in place). */
export function labelStepProblem(mbr: MbrContent, config: Config): string | undefined {
  const g = g21Phase(mbr, text(config['labelStep']));
  if (!g) return `${text(config['labelStep']) ?? '(none)'} is no G-21 step of the MBR`;
  const items = Array.isArray(g.config['items']) ? g.config['items'] : [];
  if (!items.some((i) => isRecord(i) && i['id'] === config['labelItem'])) return `G-21 step ${g.id} issues no printed item ${text(config['labelItem']) ?? '(none)'}`;
  return undefined;
}

/** PR-41: why an MBR for US OTC retail packs has no tamper-evident check (a TB-23 seal check or a TB-24 ATD check). */
export function tamperEvidentProblem(mbr: MbrContent): string | undefined {
  if (!usOtcRetail(mbr)) return undefined;
  const ok = phasesOf(mbr, 'TB-23').some((p) => p.config['tamperEvident'] === true) || phasesOf(mbr, 'TB-24').some((p) => isRecord(p.config['atd']));
  return ok ? undefined : 'the MBR is for US OTC retail packs and no packaging step checks the tamper-evident feature';
}

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const out: ConfigProblem[] = [...sharedUnitProblem(mbr, phase, text(config['unit']), 'TB23-UNIT'), ...deviceConfigProblems(phase, config, 'TB23-DEVICE')];
  const label = labelStepProblem(mbr, config);
  if (label) out.push(configError('TB23-LABEL-STEP', `The roll labels of ${phase.id} are issued and reconciled at a G-21 step: ${label}`, ['IN-17', 'INV-32']));
  if (intervalOf(config['checkEvery']) === undefined) out.push(configError('TB23-INTERVAL', `The check interval of ${phase.id} is not a whole number of microseconds`, ['PR-37']));
  const t = isRecord(config['torque']) ? config['torque'] : {};
  for (const k of ['application', 'removal']) {
    const l = limitsOf(t[k]);
    if (!l || l.min.gt(l.max)) out.push(configError('TB23-TORQUE', `The ${k} torque limits of ${phase.id} are not a range`, ['PR-37']));
  }
  const te = tamperEvidentProblem(mbr);
  if (te && phasesOf(mbr, 'TB-23')[0]?.id === phase.id) out.push(configError('TB23-TAMPER-EVIDENT', `A tamper-evident check is required: ${te}`, ['PR-41']));
  return out;
}

const LIMITS = { type: 'object' as const, description: 'Limits', fields: { min: { type: 'decimal' as const, min: '0', description: 'Lowest' }, max: { type: 'decimal' as const, min: '0', description: 'Highest' } } };
const DECIMALS = (description: string, min: number) => ({
  type: 'array' as const, description, minItems: min, maxItems: 24,
  items: { type: 'decimal' as const, min: '0', description: 'Torque reading' },
});

export const TB23: BlockVersion = {
  type: 'TB-23',
  version: '1',
  title: 'Bottle line: count, desiccant, closure torque, induction seal',
  edition: 'tablets',
  aliases: { tablets: 'TB-23' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'The bottle line: its unit, count, desiccant, torque and seal checks, devices, roll-label step and bright stock',
    fields: {
      unit: { type: 'string', pattern: UNIT_CODE, description: 'Plant PROCESS unit of the bottle line (its output containers are held by failed checks)' },
      countPerBottle: positiveCountField('Tablets per bottle'),
      counter: { type: 'string', enum: ['SLAT', 'ELECTRONIC', 'WEIGH_COUNT'], description: 'Counter type' },
      desiccant: {
        type: 'object', optional: true, description: 'Desiccant or coil inserted in each bottle',
        fields: { item: { type: 'string', description: 'Desiccant or coil item' }, method: { type: 'string', enum: ['VISION', 'MANUAL'], description: 'Verification method' } },
      },
      torque: {
        type: 'object', description: 'Closure torque limits and unit',
        fields: { unit: { type: 'string', enum: TORQUE_UNITS, description: 'Torque unit' }, application: { ...LIMITS, description: 'Application torque limits' }, removal: { ...LIMITS, description: 'Removal torque limits' } },
      },
      seal: { type: 'object', description: 'Induction seal check', fields: { method: { type: 'string', enum: ['LEAK_DETECTOR', 'PEEL', 'VACUUM_DECAY'], description: 'Seal check method' } } },
      tamperEvident: { type: 'boolean', optional: true, default: false, description: 'US OTC retail pack: the seal is the tamper-evident feature and its labelling statement is checked (PR-41)' },
      checkEvery: { ...INTERVAL, description: 'Interval of the count, desiccant, torque and seal checks' },
      devices: { type: 'array', items: deviceSchema(BOTTLE_DEVICE_KINDS), optional: true, description: 'Inspection devices challenged by G-21\'s rule' },
      labelStep: { type: 'string', description: 'The G-21 step that issues and reconciles the roll labels' },
      labelItem: { type: 'string', description: 'The roll-label item of that step' },
      brightStock: { type: 'boolean', optional: true, default: false, description: 'Filled, unlabelled bottles may be set aside for later labelling' },
    },
  },
  dataSchema: {
    entries: {
      COUNT_CHECK: {
        type: 'object', description: 'The tablets counted in each bottle sampled',
        fields: { counts: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', pattern: COUNT, description: 'Tablets in one bottle' }, description: 'Counts' } },
      },
      DESICCANT_CHECK: { type: 'object', description: 'Desiccant presence', fields: { examined: positiveCountField('Bottles examined'), missing: countField('Bottles without the desiccant') } },
      TORQUE_CHECK: {
        type: 'object', description: 'Closure torque on the tester',
        fields: { tester: { type: 'string', pattern: UNIT_CODE, description: 'Torque tester (a plant instrument)' }, application: DECIMALS('Application torque readings', 1), removal: DECIMALS('Removal torque readings', 1) },
      },
      SEAL_CHECK: {
        type: 'object', description: 'Induction seal integrity',
        fields: { examined: positiveCountField('Bottles examined'), defective: countField('Defective seals'), statementChecked: { type: 'boolean', optional: true, description: 'The labelling statement names the tamper-evident feature (US OTC retail)' } },
      },
      CHALLENGE: G21_CHALLENGE,
      REJECTS: {
        type: 'object', description: 'Bottles rejected (destroyed)',
        fields: { reason: { type: 'string', enum: REJECT_REASONS, description: 'Why' }, bottles: positiveCountField('Bottles') },
      },
      BRIGHT_STOCK: { type: 'object', description: 'Filled, unlabelled bottles set aside', fields: { bottles: positiveCountField('Bottles') } },
      BRIGHT_STOCK_USE: {
        type: 'object', description: 'Bright stock taken to labelling by scan',
        fields: { tag: { type: 'string', pattern: /^[1-9][0-9]{0,5}$/, description: 'Bright stock tag number of the step' }, scannedBatch: { type: 'string', description: 'Batch read from the tag' }, scannedProduct: { type: 'string', description: 'Product read from the tag' }, bottles: positiveCountField('Bottles') },
      },
      GOOD_OUTPUT: { type: 'object', description: 'Good labelled bottles', fields: { bottles: countField('Bottles') } },
    },
  },
  checkConfig,
  handler: { acceptEntry, beforePerform },
  exceptionRules: [...CHECK_RULES, ...CHALLENGE_RULES],
  simulatorModel: {
    exceptionTypes: () => ['LINE_CHECK_FAILED', 'LINE_CHECK_MISSED', 'CHALLENGE_FAILED', 'CHALLENGE_MISSED'],
    // Nominal: each device challenged at START, one passing check of each stream, the good output, each device at END.
    nominalEntries: ({ config }) => {
      const devices = blocks.lineDevices(config);
      const n = text(config['countPerBottle']) ?? '1';
      const t = isRecord(config['torque']) ? config['torque'] : {};
      const mid = (l: unknown): string => (isRecord(l) && typeof l['min'] === 'string' ? l['min'] : '0');
      return [
        ...devices.map((d) => ({ kind: 'CHALLENGE', device: d.id, trigger: 'START', result: 'PASS' })),
        { kind: 'COUNT_CHECK', counts: [n, n, n] },
        ...(isRecord(config['desiccant']) ? [{ kind: 'DESICCANT_CHECK', examined: '10', missing: '0' }] : []),
        { kind: 'TORQUE_CHECK', tester: 'TQ-01', application: [mid(t['application'])], removal: [mid(t['removal'])] },
        { kind: 'SEAL_CHECK', examined: '10', defective: '0', ...(config['tamperEvident'] === true ? { statementChecked: true } : {}) },
        { kind: 'GOOD_OUTPUT', bottles: '1000' },
        ...devices.map((d) => ({ kind: 'CHALLENGE', device: d.id, trigger: 'END', result: 'PASS' })),
      ];
    },
  },
  goldenFixture: {
    description:
      'A 30-count bottle line: a count check finds a bottle of 29 (LINE_CHECK_FAILED), the next passes; desiccant, torque and seal checks pass; bright stock set aside and labelled back by the scan of its batch and product; the seal detector challenged at start and end (two persons); good output recorded; performed and verified',
    controls: ['PR-37', 'PR-38', 'IN-22'],
    phase: {
      block: { type: 'TB-23', version: '1' },
      config: {
        unit: 'BTL-LINE-1', countPerBottle: '30', counter: 'ELECTRONIC', desiccant: { item: 'SILICA-1G', method: 'VISION' },
        torque: { unit: 'N.m', application: { min: '1.8', max: '2.4' }, removal: { min: '1.0', max: '2.2' } }, seal: { method: 'LEAK_DETECTOR' },
        checkEvery: { value: '30', unit: 'min' }, devices: [{ id: 'SEALDET', kind: 'SEAL_DETECTOR', every: { value: '2', unit: 'h' } }],
        labelStep: 'lbl', labelItem: 'ROLL-LABEL', brightStock: true,
      },
    },
    script: [
      { entry: { kind: 'CHALLENGE', device: 'SEALDET', trigger: 'START', result: 'PASS' } },
      { entry: { kind: 'COUNT_CHECK', counts: ['30', '29', '30'] } },
      { advanceUs: 600_000_000n },
      { entry: { kind: 'COUNT_CHECK', counts: ['30', '30', '30'] } },
      { entry: { kind: 'DESICCANT_CHECK', examined: '20', missing: '0' } },
      { entry: { kind: 'TORQUE_CHECK', tester: 'TQ-01', application: ['2.0', '2.1'], removal: ['1.6', '1.7'] } },
      { entry: { kind: 'SEAL_CHECK', examined: '20', defective: '0' } },
      { entry: { kind: 'BRIGHT_STOCK', bottles: '240' } },
      { entry: { kind: 'REJECTS', reason: 'SEAL', bottles: '14' } },
      { entry: { kind: 'BRIGHT_STOCK_USE', tag: '1', scannedBatch: '$BATCH', scannedProduct: 'P', bottles: '240' } },
      { entry: { kind: 'GOOD_OUTPUT', bottles: '9760' } },
      { entry: { kind: 'CHALLENGE', device: 'SEALDET', trigger: 'END', result: 'PASS' } },
    ],
    expect: { exceptions: ['LINE_CHECK_FAILED'], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/bottle/blocks.test.ts', 'apps/tablets-server/test/blocks/bottle/db-guards.test.ts'],
};
