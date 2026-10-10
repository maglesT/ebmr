/**
 * TB-20@1 Visual inspection, sorting, AQL and reject categorisation (tablets spec B.2 TB-20, K-22, K-23; Phase 3 slice 3d,
 * builder A). Controls PR-46, PR-47, PR-50, IN-35, PR-29, DI-10, INV-41.
 *
 * The MBR sets the mode (manual belt, or a vision sorter with its recipe), the defect catalogue with each defect's class
 * (critical, major, minor; a foreign or other-product tablet is critical and flagged `foreign`), the AQL plan (the
 * inspection level and the AQL of the major and minor classes: company values, no regulatory numbers; critical defects
 * are always accepted at zero) and the G-23 step that destroys the rejects (destructionStep: witnessed, never skippable,
 * a later step of the inspection's own sequence). Rejects are for
 * destruction; a reusable-residue category exists only where the MBR has a TB-08 step to use it (none yet).
 *
 * Entries:
 *   INSPECTION_START, INSPECTION_END  the 100 % sort at the server's times (measured, never typed);
 *   SORT_RESULT   once, after the sort: the quantity inspected and accepted (count and mass), the defects found by code,
 *                 and the rejects by category, each in an identified container (IN-35 (f)). Reconciled exactly: inspected
 *                 = accepted + rejects (counts), every rejected tablet carries one defect code, the masses leave no
 *                 negative remainder (the remainder is recorded as unaccounted). A foreign tablet raises
 *                 FOREIGN_TABLET_FOUND: QA decides, and the investigation reaches other batches (PR-50);
 *   AQL_RESULT    once, after the sort: the lot is the accepted count; the inspection severity (normal or tightened)
 *                 is the switching rule's, decided by the database from the product's earlier lots and never chosen
 *                 here; the sample size code letter, sample size and acceptance and rejection numbers come from the
 *                 sampling scheme (coating/aql.ts, master data with its source: DI-10), the defects found per class are
 *                 judged against them by the block. A rejected lot raises AQL_REJECTED (QA decides; re-inspection or
 *                 re-sorting only through an approved reprocessing, G-24: PR-47). Tightened inspection is logic inside
 *                 the block, never a void or a repeat: a second AQL result is refused (INV-41).
 * Before PERFORMED: the sort ended, the sort result and the AQL result recorded.
 *
 * The database holds the same rules (tablets 0911, 0912): the reconciliation, the plan from its own tables, the severity
 * from the lot history (tab.aql_lot_result), the reject containers of this batch never charged, and the destruction step
 * closes only with every container for destruction destroyed in its witnessed G-23 step, quantity for quantity.
 */
import {
  ancestorsOf,
  CODE,
  configError,
  UUID,
  COUNT,
  isRecord,
  phasesOf,
  POSITIVE_QUANTITY,
  problem,
  quantityOf,
  refuse,
  secondsText,
  text,
  type BlockVersion,
  type Config,
  type ConfigProblem,
  type Entry,
  type EntryResult,
  type HandlerProblem,
  type HandlerView,
  type JsonValue,
  type MbrContent,
  type ObjectSchema,
  type PhaseNode,
  type Quantity,
} from './coating/common.ts';
import { AQL_SCHEME, codeLetter, INSPECTION_LEVELS, planOf, SEVERITIES, SUPPORTED_AQLS, type InspectionLevel, type Severity } from './coating/aql.ts';
import { cmp, scaled, plainText, sumText } from './coating/calc.ts';

const CONTROLS = ['PR-46', 'PR-47', 'PR-50', 'IN-35', 'PR-29', 'DI-10', 'INV-41'];
export const DEFECT_CLASSES = ['CRITICAL', 'MAJOR', 'MINOR'] as const;
export const REJECT_CATEGORIES = ['DESTRUCTION', 'REUSABLE_RESIDUE'] as const;

interface Defect {
  code: string;
  class: (typeof DEFECT_CLASSES)[number];
  foreign: boolean;
}

export function defectsOf(config: Config): Defect[] {
  return Array.isArray(config['defects'])
    ? config['defects'].filter(isRecord).map((d) => ({ code: String(d['code']), class: (DEFECT_CLASSES as readonly string[]).includes(String(d['class'])) ? (d['class'] as Defect['class']) : 'CRITICAL', foreign: d['foreign'] === true }))
    : [];
}

function aqlOf(config: Config): { level: InspectionLevel; MAJOR: string; MINOR: string } | undefined {
  const a = config['aql'];
  if (!isRecord(a)) return undefined;
  const level = (INSPECTION_LEVELS as readonly string[]).includes(String(a['level'])) ? (a['level'] as InspectionLevel) : undefined;
  return level && typeof a['major'] === 'string' && typeof a['minor'] === 'string' ? { level, MAJOR: a['major'], MINOR: a['minor'] } : undefined;
}

const residueAllowed = (config: Config): boolean => config['reusableResidue'] === true;

/** The AQL evaluation of a lot of `lotSize` tablets with `found` defects per class (undefined when off the table). */
export function evaluateAql(config: Config, severity: Severity, lotSize: bigint, found: Record<string, bigint>): Record<string, unknown> | undefined {
  const a = aqlOf(config);
  if (!a) return undefined;
  const letter = codeLetter(lotSize, a.level);
  if (!letter) return undefined;
  const major = planOf(severity, letter, a.MAJOR);
  const minor = planOf(severity, letter, a.MINOR);
  if (!major || !minor) return undefined;
  let n = major.n > minor.n ? major.n : minor.n;
  if (n > lotSize) n = lotSize;
  const judge = (ac: bigint, f: bigint) => f <= ac;
  const classes = {
    CRITICAL: { ac: '0', re: '1', found: (found['CRITICAL'] ?? 0n).toString(), accepted: judge(0n, found['CRITICAL'] ?? 0n) },
    MAJOR: { aql: a.MAJOR, letter: major.letter, n: major.n.toString(), ac: major.ac.toString(), re: major.re.toString(), found: (found['MAJOR'] ?? 0n).toString(), accepted: judge(major.ac, found['MAJOR'] ?? 0n) },
    MINOR: { aql: a.MINOR, letter: minor.letter, n: minor.n.toString(), ac: minor.ac.toString(), re: minor.re.toString(), found: (found['MINOR'] ?? 0n).toString(), accepted: judge(minor.ac, found['MINOR'] ?? 0n) },
  };
  const accepted = classes.CRITICAL.accepted && classes.MAJOR.accepted && classes.MINOR.accepted;
  return {
    scheme: AQL_SCHEME.code,
    schemeVersion: AQL_SCHEME.version,
    severity,
    level: a.level,
    lotSize: lotSize.toString(),
    letter,
    sampleSize: n.toString(),
    classes,
    result: accepted ? 'ACCEPTED' : 'REJECTED',
  };
}

const COUNTED_MASS: ObjectSchema = {
  type: 'object',
  description: 'A count of tablets and their mass',
  fields: { count: { type: 'string', pattern: COUNT, description: 'Number of tablets' }, mass: POSITIVE_QUANTITY },
};

function sortResult(view: HandlerView, entry: Entry): EntryResult {
  if (view.entries('INSPECTION_END').length === 0) return refuse('TB20-NOT-SORTED', `The sort result of ${view.stepKey} is recorded after the sort ends`, ['PR-46', 'IN-35']);
  if (view.entries('SORT_RESULT').length > 0) return refuse('TB20-SORT-TWICE', `${view.stepKey} already records its sort result`, ['DI-29']);
  const catalogue = defectsOf(view.config);
  const inspected = isRecord(entry['inspected']) ? entry['inspected'] : {};
  const accepted = isRecord(entry['accepted']) ? entry['accepted'] : {};
  const defects = Array.isArray(entry['defects']) ? entry['defects'].filter(isRecord) : [];
  const rejects = Array.isArray(entry['rejects']) ? entry['rejects'].filter(isRecord) : [];
  for (const d of defects) {
    if (!catalogue.some((c) => c.code === d['code'])) return refuse('TB20-DEFECT', `Defect ${String(d['code'])} is not in the MBR's defect catalogue`, ['PR-46']);
  }
  if (new Set(defects.map((d) => d['code'])).size !== defects.length) return refuse('TB20-DEFECT', 'Each defect code is counted once', ['PR-46']);
  for (const r of rejects) {
    if (r['category'] === 'REUSABLE_RESIDUE' && !residueAllowed(view.config)) {
      return refuse('TB20-RESIDUE', 'Reusable residue is a category only where the MBR has a recovery step (TB-08) to use it; rejects are for destruction', ['PR-46', 'PR-47']);
    }
  }
  if (new Set(rejects.map((r) => r['container'])).size !== rejects.length) return refuse('TB20-CONTAINER', 'Each reject container is named once', ['PR-46', 'IN-35']);
  const masses: Quantity[] = [inspected['mass'], accepted['mass'], ...rejects.map((r) => r['mass'])].map((m) => quantityOf(m) ?? { value: '0', unit: '' });
  const unit = masses[0]?.unit;
  if (masses.some((m) => m.unit !== unit)) return refuse('TB20-UNIT', 'The masses of a sort result are in one unit', ['PR-46']);
  const rejectCount = rejects.reduce((a, r) => a + BigInt(String(r['count'])), 0n);
  const defectCount = defects.reduce((a, d) => a + BigInt(String(d['count'])), 0n);
  if (BigInt(String(inspected['count'])) !== BigInt(String(accepted['count'])) + rejectCount) {
    return refuse('TB20-RECONCILE', `Inspected ${String(inspected['count'])} tablets are not the ${String(accepted['count'])} accepted and the ${rejectCount} rejected`, ['PR-46', 'IN-35']);
  }
  if (defectCount !== rejectCount) return refuse('TB20-RECONCILE', `Every rejected tablet carries one defect code: ${defectCount} defects, ${rejectCount} rejected`, ['PR-46', 'IN-35']);
  const out = scaled(sumText([accepted['mass'], ...rejects.map((r) => r['mass'])].map((m) => quantityOf(m)?.value ?? '0')));
  const inMass = quantityOf(inspected['mass'])?.value ?? '0';
  const rest = sumText([inMass, plainText({ n: -out.n, s: out.s })]);
  if (cmp(rest, '0') < 0) return refuse('TB20-RECONCILE', 'The accepted and rejected masses come to more than the mass inspected', ['PR-46', 'IN-35']);
  const foreign = defects.filter((d) => catalogue.some((c) => c.code === d['code'] && c.foreign) && BigInt(String(d['count'])) > 0n).map((d) => String(d['code']));
  const byClass = Object.fromEntries(
    DEFECT_CLASSES.map((k) => [k, defects.filter((d) => catalogue.find((c) => c.code === d['code'])?.class === k).reduce((a, d) => a + BigInt(String(d['count'])), 0n).toString()]),
  );
  return {
    ok: true,
    data: {
      inspected: { count: inspected['count'], mass: quantityOf(inspected['mass']) },
      accepted: { count: accepted['count'], mass: quantityOf(accepted['mass']) },
      defects: defects.map((d) => ({ code: d['code'], count: d['count'] })),
      rejects: rejects.map((r) => ({ category: r['category'], container: r['container'], count: r['count'], mass: quantityOf(r['mass']) })),
      rejectCount: rejectCount.toString(),
      defectsByClass: byClass,
      unaccountedMass: { value: rest, unit },
      recordedBy: view.actor.id,
    },
    verificationRequired: true,
    ...(foreign.length === 0
      ? {}
      : {
          exceptions: [
            {
              type: 'FOREIGN_TABLET_FOUND',
              title: `Foreign or other-product tablets (${foreign.join(', ')}) were found sorting ${view.stepKey}: QA decides, and the investigation extends to the other batches that may be affected`,
              controls: ['PR-50', 'PR-46', 'IN-35'],
              severity: 'CRITICAL',
              category: 'DEVIATION_OR_OVERRIDE',
              blocks: 'DOWNSTREAM',
              until: 'DISPOSITION',
              deviationRequired: true,
              qaOnly: true,
              releaseBlocking: true,
            },
          ],
        }),
  };
}

function aqlResult(view: HandlerView, entry: Entry): EntryResult {
  const sort = view.entries('SORT_RESULT')[0];
  if (!sort) return refuse('TB20-AQL-EARLY', `The AQL sample of ${view.stepKey} is drawn from the sorted lot`, ['PR-29', 'PR-46']);
  if (view.entries('AQL_RESULT').length > 0) return refuse('TB20-AQL-TWICE', `${view.stepKey} already records its AQL result: a rejected lot is re-inspected only through an approved reprocessing, never by a new sample here`, ['INV-41', 'PR-47']);
  const severity = (SEVERITIES as readonly string[]).includes(String(entry['severity'])) ? (entry['severity'] as Severity) : 'NORMAL';
  const lot = BigInt(String((sort.data['accepted'] as Record<string, unknown>)['count']));
  const f = isRecord(entry['found']) ? entry['found'] : {};
  const found = Object.fromEntries(DEFECT_CLASSES.map((k) => [k, BigInt(typeof f[k] === 'string' ? f[k] : '0')]));
  const evaluation = evaluateAql(view.config, severity, lot, found);
  if (!evaluation) return refuse('TB20-NO-PLAN', `The sampling scheme has no plan for a lot of ${lot} tablets at the MBR's AQL values`, ['PR-29', 'DI-10']);
  const n = BigInt(String(evaluation['sampleSize']));
  if (Object.values(found).some((x) => x > n)) return refuse('TB20-FOUND', `More defects in a class than the ${n} tablets of the sample`, ['PR-29']);
  const rejected = evaluation['result'] === 'REJECTED';
  return {
    ok: true,
    data: { ...evaluation, recordedBy: view.actor.id },
    ...(rejected
      ? {
          exceptions: [
            {
              type: 'AQL_REJECTED',
              title: `The AQL sample of ${view.stepKey} (${n} tablets, ${severity.toLowerCase()} inspection) rejects the lot: QA decides; it is re-inspected or re-sorted only through an approved reprocessing`,
              controls: ['PR-46', 'PR-47', 'PR-29', 'INV-41'],
              severity: 'ACTION',
              category: 'OUT_OF_LIMIT',
              blocks: 'DOWNSTREAM',
              until: 'DISPOSITION',
              deviationRequired: true,
              qaOnly: true,
              releaseBlocking: true,
            },
          ],
        }
      : {}),
  };
}

function accept(view: HandlerView, entry: Entry): EntryResult {
  switch (entry.kind) {
    case 'INSPECTION_START':
      if (view.entries('INSPECTION_START').length > 0) return refuse('TB20-INSPECTION-TWICE', `${view.stepKey} already started its inspection`, ['PR-46']);
      return { ok: true, data: { inspector: view.actor.id } };
    case 'INSPECTION_END': {
      const start = view.entries('INSPECTION_START')[0];
      if (!start) return refuse('TB20-NOT-STARTED', `${view.stepKey} has not started its inspection`, ['PR-46']);
      if (view.entries('INSPECTION_END').length > 0) return refuse('TB20-INSPECTION-TWICE', `${view.stepKey} already ended its inspection`, ['PR-46']);
      return { ok: true, data: { inspectionSeconds: secondsText(view.nowUs - start.recordedAt), inspector: view.actor.id } };
    }
    case 'SORT_RESULT':
      return sortResult(view, entry);
    case 'AQL_RESULT':
      return aqlResult(view, entry);
    default:
      return refuse('TB20-ENTRY', `${entry.kind} is not an entry of an inspection step`, ['PR-46']);
  }
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out: HandlerProblem[] = [];
  if (view.entries('INSPECTION_END').length === 0) out.push(problem('TB20-NOT-SORTED', `${view.stepKey} has not finished its inspection`, ['PR-46']));
  if (view.entries('SORT_RESULT').length === 0) out.push(problem('TB20-NO-SORT', `${view.stepKey} has no sort result`, ['PR-46', 'IN-35']));
  if (view.entries('AQL_RESULT').length === 0) out.push(problem('TB20-NO-AQL', `${view.stepKey} has no AQL result`, ['PR-29']));
  return out;
}

/**
 * Why the G-23 step that destroys the rejects of inspection step `phaseId` is missing or wrong: it is a later step of the
 * same sequence (it runs after the inspection, on every path that runs the inspection), witnessed, never skippable
 * (review 3d finding 2). Undefined when it is in place.
 */
export function destructionProblem(mbr: MbrContent, phaseId: string, config: Config): string | undefined {
  const id = text(config['destructionStep']);
  const g = phasesOf(mbr).find((p) => p.id === id);
  if (!g || g.block.type !== 'G-23') return `${id ?? '(none)'} is not a G-23 step of the MBR`;
  if (g.config['witness'] === false || g.signatures.check?.meaning !== 'WITNESSED') return `G-23 step ${g.id} does not destroy under a witness`;
  if (g.config['skippable'] === true) return `G-23 step ${g.id} is declared skippable`;
  const parent = ancestorsOf(mbr, phaseId).at(-1);
  const at = parent?.kind === 'sequence' ? parent.children.findIndex((c) => c.id === phaseId) : -1;
  if (parent?.kind !== 'sequence' || !parent.children.slice(at + 1).some((c) => c.id === g.id)) return `G-23 step ${g.id} is not a later step of the inspection's sequence`;
  return undefined;
}

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const catalogue = defectsOf(config);
  if (catalogue.length === 0 || new Set(catalogue.map((d) => d.code)).size !== catalogue.length) {
    out.push(configError('TB20-CATALOGUE', `Inspection step ${phase.id} has a defect catalogue, each code once`, ['PR-46']));
  }
  if (catalogue.some((d) => d.foreign && d.class !== 'CRITICAL')) out.push(configError('TB20-CATALOGUE', `A foreign or other-product tablet is a critical defect (${phase.id})`, ['PR-46', 'PR-50']));
  if (!aqlOf(config)) out.push(configError('TB20-AQL', `Inspection step ${phase.id} sets the inspection level and the AQL of the major and minor defects`, ['PR-29']));
  if (config['mode'] === 'VISION' && typeof config['visionRecipe'] !== 'string') out.push(configError('TB20-VISION', `The vision sorter of ${phase.id} runs a named recipe`, ['PR-46']));
  if (residueAllowed(config) && !phasesOf(mbr).some((p) => p.block.type === 'TB-08')) {
    out.push(configError('TB20-RESIDUE', `Reusable residue of ${phase.id} needs a recovery step (TB-08) in the MBR`, ['PR-46', 'PR-47']));
  }
  const d = destructionProblem(mbr, phase.id, config);
  if (d) out.push(configError('TB20-DESTRUCTION', `The rejects of ${phase.id} are destroyed in a witnessed G-23 step: ${d}`, ['PR-46', 'IN-35']));
  return out;
}

export const TB20: BlockVersion = {
  type: 'TB-20',
  version: '1',
  title: 'Inspection, sorting and AQL',
  edition: 'tablets',
  aliases: { tablets: 'TB-20' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'Sorting mode, defect catalogue, AQL plan, reject categories and the destruction step',
    fields: {
      mode: { type: 'string', enum: ['MANUAL_BELT', 'VISION'], description: 'Manual belt or vision sorter' },
      visionRecipe: { type: 'string', optional: true, description: 'The vision sorter recipe' },
      defects: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        description: 'The defect catalogue',
        items: {
          type: 'object',
          description: 'A defect and its class',
          fields: {
            code: { type: 'string', pattern: CODE, description: 'Defect code' },
            class: { type: 'string', enum: [...DEFECT_CLASSES], description: 'Critical, major or minor' },
            foreign: { type: 'boolean', optional: true, default: false, description: 'A foreign or other-product tablet' },
          },
        },
      },
      aql: {
        type: 'object',
        description: 'The AQL plan (company values)',
        fields: {
          level: { type: 'string', enum: [...INSPECTION_LEVELS], description: 'General inspection level' },
          major: { type: 'string', enum: [...SUPPORTED_AQLS], description: 'AQL of major defects (%)' },
          minor: { type: 'string', enum: [...SUPPORTED_AQLS], description: 'AQL of minor defects (%)' },
        },
      },
      reusableResidue: { type: 'boolean', optional: true, default: false, description: 'A reusable residue category (only with a recovery step, TB-08)' },
      destructionStep: { type: 'string', description: 'The witnessed G-23 step that destroys the rejects' },
    },
  },
  dataSchema: {
    entries: {
      INSPECTION_START: { type: 'object', description: 'The inspection starts (server time)', fields: {} },
      INSPECTION_END: { type: 'object', description: 'The inspection ends (server time)', fields: {} },
      SORT_RESULT: {
        type: 'object',
        description: 'What the 100 % sort found and where the rejects are',
        fields: {
          inspected: COUNTED_MASS,
          accepted: COUNTED_MASS,
          defects: {
            type: 'array',
            maxItems: 50,
            description: 'Defects found by code',
            items: { type: 'object', description: 'One defect code', fields: { code: { type: 'string', pattern: CODE, description: 'Defect code' }, count: { type: 'string', pattern: COUNT, description: 'Tablets' } } },
          },
          rejects: {
            type: 'array',
            maxItems: 20,
            description: 'Rejects by category, each in an identified container',
            items: {
              type: 'object',
              description: 'One reject container',
              fields: {
                category: { type: 'string', enum: [...REJECT_CATEGORIES], description: 'For destruction, or reusable residue' },
                container: { type: 'string', pattern: UUID, description: 'The output container (plant.output_container id)' },
                count: { type: 'string', pattern: COUNT, description: 'Tablets' },
                mass: POSITIVE_QUANTITY,
              },
            },
          },
        },
      },
      AQL_RESULT: {
        type: 'object',
        description: 'The AQL sample of the sorted lot',
        fields: {
          severity: { type: 'string', enum: [...SEVERITIES], description: 'Inspection severity by the switching rule (the database decides)' },
          found: {
            type: 'object',
            description: 'Defective tablets found in the sample by class',
            fields: Object.fromEntries(DEFECT_CLASSES.map((k) => [k, { type: 'string', pattern: COUNT, optional: true, description: `${k.toLowerCase()} defects` }])),
          },
        },
      },
    },
  },
  checkConfig,
  handler: { acceptEntry: accept, beforePerform },
  exceptionRules: [
    { type: 'FOREIGN_TABLET_FOUND', category: 'DEVIATION_OR_OVERRIDE', severity: 'CRITICAL', summary: 'A foreign or other-product tablet found in sorting (investigation across batches)', controls: ['PR-50', 'PR-46', 'IN-35'] },
    { type: 'AQL_REJECTED', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A lot rejected by its AQL sample', controls: ['PR-46', 'PR-47', 'PR-29', 'INV-41'] },
  ],
  simulatorModel: {
    exceptionTypes: () => ['FOREIGN_TABLET_FOUND', 'AQL_REJECTED'],
    nominalEntries: () => [
      { kind: 'INSPECTION_START' },
      { kind: 'INSPECTION_END' },
      { kind: 'SORT_RESULT', inspected: { count: '100000', mass: { value: '25.000', unit: 'kg' } }, accepted: { count: '100000', mass: { value: '25.000', unit: 'kg' } }, defects: [], rejects: [] },
      { kind: 'AQL_RESULT', severity: 'NORMAL', found: {} },
    ],
  },
  goldenFixture: {
    description:
      'A manual belt sort of 200 000 tablets (50.000 kg): 300 chipped and 20 black-spotted tablets (0.080 kg) into reject container 00000000-0000-4000-8000-000000000001 for destruction, 199 680 accepted (49.915 kg; 0.005 kg unaccounted); the AQL sample under normal inspection, level II (letter P, 800 tablets; major AQL 0.65: accept 10, minor AQL 2.5: accept 21 by the plan of letter N): 3 major and 10 minor defects, the lot is accepted; performed and verified',
    controls: ['PR-46', 'IN-35', 'PR-29'],
    phase: {
      block: { type: 'TB-20', version: '1' },
      config: {
        mode: 'MANUAL_BELT',
        defects: [
          { code: 'CHIPPED', class: 'MAJOR' },
          { code: 'BLACK-SPOT', class: 'MINOR' },
          { code: 'FOREIGN', class: 'CRITICAL', foreign: true },
        ],
        aql: { level: 'II', major: '0.65', minor: '2.5' },
        destructionStep: 'destroy',
      },
    },
    script: [
      { entry: { kind: 'INSPECTION_START' } },
      { advanceUs: 7_200_000_000n },
      { entry: { kind: 'INSPECTION_END' } },
      {
        entry: {
          kind: 'SORT_RESULT',
          inspected: { count: '200000', mass: { value: '50.000', unit: 'kg' } },
          accepted: { count: '199680', mass: { value: '49.915', unit: 'kg' } },
          defects: [{ code: 'CHIPPED', count: '300' }, { code: 'BLACK-SPOT', count: '20' }],
          rejects: [{ category: 'DESTRUCTION', container: '00000000-0000-4000-8000-000000000001', count: '320', mass: { value: '0.080', unit: 'kg' } }],
        },
      },
      { entry: { kind: 'AQL_RESULT', severity: 'NORMAL', found: { MAJOR: '3', MINOR: '10' } } },
    ],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/coating/blocks.test.ts', 'apps/tablets-server/test/blocks/coating/calc.test.ts', 'apps/tablets-server/test/blocks/coating/db-guards.test.ts'],
};
