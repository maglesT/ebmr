/**
 * TB-08@1 Rework / recovered-material addition across batches (tablets spec B.2 TB-08; outline 5.2.9 cases 2 and 3;
 * Phase 3 slice 5b; D-S5-7). Controls PR-47, IN-19, IN-18, PR-57; invariant INV-33.
 *
 * The MBR step declares its case (reprocessing addition of rejected in-process material, class b, or recovery of
 * conforming material, class a) with the maximum percentage of the standard batch size, the maximum age and the maximum
 * number of source batches (the phase's reprocessing declaration, mandatory), and configures:
 *   - ageFrom          the reference instant of the age: GENERATION (when the source container was closed: the date the
 *                      rework was generated) or MANUFACTURE (when the source batch was issued) [P: mandatory];
 *   - sourceStages     the source material types allowed, as the stages their containers were filled at (optional);
 *   - pretreatmentStep the TB-02 step of the MBR that pre-treats the material (milling through a checked screen; optional);
 *   - perUseAuthorisation  the quality unit authorises every use (default on; always on for a reprocessing addition;
 *                      off for a recovery only when the step carries its prior authorisation and risk-evaluation reference
 *                      in priorAuthorisation);
 *   - addedItem        the parameter (kg or g) the block computes as the net added at the step, so the receiving
 *                      checkpoint's theoretical yield includes it (C-07: theoretical = standard + rework added).
 *
 * Entries:
 *   ADDITION  a weighed take from a closed output container of an earlier batch of the same product (gross, tare, net =
 *             gross - tare in the container's unit; a part of the container may be taken). The server reads the
 *             container's facts from the database (source batch, product and strength, case: reserved residue or
 *             QA-released material, generation and manufacture instants, recovered flag, remaining quantity, expiry) and
 *             the signer of the authorisation named; the block judges them with recipe-core's addition rules (blocks
 *             reprocessing.ts) and keeps them with the weighing, so the source batch and quantity are in the record
 *             (EU 4.20(d); 211.188(b)). Keyed by hand: the step needs its second person.
 * When performed: the net added is computed into addedItem, and a step that added material raises the release-blocking
 * QC_ADDITIONAL_TESTING_DECISION (PR-47: QC decides on additional testing before release).
 *
 * The database holds the same rules (recipe-core 0621, 0622; tablets 1020, 1021): the facts are read again at the row's
 * time and any other value is refused, the addition and its genealogy edge (recipe.source_addition) are written in the
 * entry's transaction, the container never gives more than it holds, and the computed item is the database's sum.
 */
import { blocks } from '@ebmr/recipe-core/pure';
import {
  configError,
  isRecord,
  phasesOf,
  refuse,
  text,
  type BlockVersion,
  type Config,
  type ConfigProblem,
  type Entry,
  type EntryResult,
  type HandlerView,
  type MbrContent,
  type PhaseNode,
} from './granulation/common.ts';
import { plainText, scaled, sumText } from './coating/calc.ts';
import { S } from './summaries.ts';

const R = blocks.reprocessing;

const CONTROLS = ['PR-47', 'IN-19', 'IN-18', 'PR-57', 'INV-33'];
export const AGE_FROM = ['GENERATION', 'MANUFACTURE'] as const;
const UUID = R.UUID_PATTERN;
const STAGE = /^[A-Z][A-Z0-9_]{0,39}$/;

/** TB-08's rule codes (recipe-core's addition rules, blocks reprocessing.ts). */
export const TB08_ADDITION_CODES: blocks.reprocessing.AdditionCodes = {
  'NO-ADDITION': 'TB08-NO-ADDITION',
  'AD-HOC': 'TB08-AD-HOC',
  'SOURCE-STATUS': 'TB08-SOURCE-STATUS',
  'OWN-BATCH': 'TB08-OWN-BATCH',
  'OTHER-PRODUCT': 'TB08-OTHER-PRODUCT',
  CHAINED: 'TB08-CHAINED',
  'TOO-OLD': 'TB08-TOO-OLD',
  'TOO-MANY-SOURCES': 'TB08-TOO-MANY-SOURCES',
  UNIT: 'TB08-UNIT',
  'OVER-REMAINING': 'TB08-OVER-REMAINING',
  'TOO-MUCH': 'TB08-TOO-MUCH',
  'NOT-AUTHORISED': 'TB08-NOT-AUTHORISED',
  'SELF-AUTHORISED': 'TB08-SELF-AUTHORISED',
  'AUTHORISATION-USED': 'TB08-AUTHORISATION-USED',
};

const ageFromOf = (config: Config): (typeof AGE_FROM)[number] | undefined =>
  (AGE_FROM as readonly string[]).includes(String(config['ageFrom'])) ? (config['ageFrom'] as (typeof AGE_FROM)[number]) : undefined;

/** Whether every use at the step needs the quality unit's authorisation (on unless a recovery step carries its own). */
export function perUseRequired(phase: Pick<PhaseNode, 'reprocessing'>, config: Config): boolean {
  return !(config['perUseAuthorisation'] === false && phase.reprocessing?.case === 'RECOVERY' && isRecord(config['priorAuthorisation']));
}

/** A net in `from` (kg or g) as `to` (kg or g), exact canonical text; undefined for any other unit. */
export function massText(value: string, from: string, to: string): string | undefined {
  const v = scaled(value);
  if (from === to) return plainText(v);
  if (from === 'g' && to === 'kg') return plainText({ n: v.n, s: v.s + 3 });
  if (from === 'kg' && to === 'g') return plainText({ n: v.n * 1000n, s: v.s });
  return undefined;
}

function accept(view: HandlerView, entry: Entry): EntryResult {
  if (entry.kind !== 'ADDITION') return refuse('TB08-ENTRY', `${entry.kind} is not an entry of a rework or recovery addition step`, ['PR-47']);
  const net = blocks.reprocessing.weighedNet(entry['gross'], entry['tare']);
  if (!net.ok) return refuse('TB08-NET', `The addition is weighed: ${net.message}`, ['PR-47', 'INV-33']);
  const unit = String(entry['unit']);
  const source = R.sourceOf(entry);
  const stages = Array.isArray(view.config['sourceStages']) ? view.config['sourceStages'].map(String) : undefined;
  if (source && stages && !stages.includes(source.stage)) {
    return refuse('TB08-SOURCE-TYPE', `Material filled at stage ${source.stage} is not a source type the MBR allows here (${stages.join(', ')})`, ['PR-47', 'IN-19']);
  }
  const problems = R.additionProblems(view, TB08_ADDITION_CODES, {
    net: net.net,
    unit,
    source,
    authorisation: text(entry['authorisation']),
    authorisedBy: text(entry['authorisedBy']),
    authorisationRequired: perUseRequired(view.phase, view.config),
    ageFrom: ageFromOf(view.config) ?? 'GENERATION',
  });
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    data: {
      container: entry['container'],
      gross: entry['gross'],
      tare: entry['tare'],
      net: { value: net.net, unit },
      source: entry['source'],
      case: view.phase.reprocessing?.case,
      ...(text(entry['authorisation']) !== undefined ? { authorisation: entry['authorisation'] } : {}),
      ...(text(entry['authorisedBy']) !== undefined ? { authorisedBy: entry['authorisedBy'] } : {}),
      addedBy: view.actor.id,
    },
    verificationRequired: true,
  };
}

/** The parameter of the MBR the step computes as the net added (C-07), when it names one. */
function addedItemOf(config: Config): string | undefined {
  return text(config['addedItem']);
}

function computeItems(view: HandlerView): blocks.ComputedItem[] {
  const item = addedItemOf(view.config);
  const p = item === undefined ? undefined : view.parameter(item);
  if (item === undefined || !p?.unit) return [];
  const adds = view.entries('ADDITION');
  const parts = adds.map((e) => {
    const n = e.data['net'] as { value: string; unit: string };
    return massText(n.value, n.unit, p.unit ?? '');
  });
  if (parts.some((x) => x === undefined)) return [];
  return [{ item, value: { kind: 'DECIMAL', value: plainText(scaled(sumText(parts as string[]))), unit: p.unit }, entries: adds.map((e) => e.id) }];
}

function checkConfig(phase: PhaseNode, config: Config, mbr: MbrContent): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const rp = phase.reprocessing;
  if (!rp || (rp.case !== 'REPROCESSING_ADDITION' && rp.case !== 'RECOVERY')) {
    out.push(configError('TB08-NO-CASE', `Addition step ${phase.id} declares the case reprocessing addition or recovery with its limits`, ['PR-47', 'IN-19']));
  }
  if (!ageFromOf(config)) out.push(configError('TB08-AGE-FROM', `Addition step ${phase.id} says from which instant the age of the source is counted`, ['IN-19']));
  if (config['perUseAuthorisation'] === false && (rp?.case !== 'RECOVERY' || !isRecord(config['priorAuthorisation']))) {
    out.push(configError('TB08-AUTHORISATION', `Per-use authorisation is always on for a reprocessing addition, and off for a recovery only when ${phase.id} carries its prior authorisation and risk evaluation`, ['PR-47']));
  }
  const size = mbr.header.batchSizes[0]?.quantity;
  if (!size || (size.unit !== 'kg' && size.unit !== 'g')) out.push(configError('TB08-BATCH-MASS', `The maximum addition of ${phase.id} is a percentage of the standard batch mass, so the MBR's first batch size is a mass`, ['IN-19']));
  const item = addedItemOf(config);
  if (item !== undefined) {
    const p = mbr.parameters.find((q) => q.id === item);
    if (!p || p.valueType !== 'DECIMAL' || (p.unit !== 'kg' && p.unit !== 'g') || !phase.records.includes(item) || (p.readings ?? 1) !== 1) {
      out.push(configError('TB08-ADDED-ITEM', `The added-material item ${item} of ${phase.id} is a single decimal in kg or g that the step records`, ['PR-47', 'INV-25']));
    }
  }
  const pre = text(config['pretreatmentStep']);
  if (pre !== undefined && !phasesOf(mbr).some((p) => p.id === pre && p.block.type === 'TB-02')) {
    out.push(configError('TB08-PRETREATMENT', `The pre-treatment of ${phase.id} is a sifting or milling step (TB-02) of the MBR`, ['PR-47']));
  }
  return out;
}

const SOURCE_EXAMPLE = {
  container: '00000000-0000-4000-8000-0000000000a8',
  sourceBatchId: '00000000-0000-4000-8000-0000000000b8',
  product: 'P',
  strength: '1 mg',
  stage: 'INSPECTION',
  unit: 'kg',
  case: 'REPROCESSING_ADDITION',
  generatedAtUs: '1786000000000000',
  manufacturedAtUs: '1785000000000000',
  containsRecovered: false,
  remaining: '0.4',
};

export const TB08: BlockVersion = {
  type: 'TB-08',
  version: '1',
  title: 'Rework or recovered-material addition',
  edition: 'tablets',
  aliases: { tablets: 'TB-08' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'Age reference, source types, pre-treatment, per-use authorisation and the computed added-material item (the case and limits are the phase reprocessing declaration)',
    fields: {
      ageFrom: { type: 'string', enum: [...AGE_FROM], description: 'The age of the source is counted from its generation (container closed) or the source batch manufacture' },
      sourceStages: { type: 'array', optional: true, minItems: 1, maxItems: 10, items: { type: 'string', pattern: STAGE, description: 'Stage code' }, description: 'Source material types allowed (stages their containers were filled at)' },
      pretreatmentStep: { type: 'string', optional: true, description: 'The TB-02 step that pre-treats the material' },
      perUseAuthorisation: { type: 'boolean', optional: true, default: true, description: 'The quality unit authorises every use (always on for a reprocessing addition)' },
      priorAuthorisation: {
        type: 'object',
        optional: true,
        description: 'The prior authorisation the approved MBR step carries (recovery only, when per-use authorisation is off)',
        fields: { authorisationRef: { type: 'string', description: 'Prior authorisation' }, riskEvaluationRef: { type: 'string', description: 'Risk evaluation addressing shelf life' } },
      },
      addedItem: { type: 'string', optional: true, description: 'Parameter (kg or g) the block computes as the net added (C-07)' },
    },
  },
  entrySummaries: {
    ADDITION: blocks.G24V2.entrySummaries?.['ADDITION'] ?? ((d) => `Added ${S.qty(d['net'])} from container ${S.val(d['container'])}`),
  },
  dataSchema: {
    entries: {
      ADDITION: {
        type: 'object',
        description: 'A weighed take from a closed output container of an earlier batch (the source facts are read from the database)',
        fields: {
          container: { type: 'string', pattern: UUID, description: 'The source output container' },
          gross: { type: 'decimal', min: '0', minExclusive: true, description: 'Gross weight' },
          tare: { type: 'decimal', min: '0', description: 'Tare weight' },
          unit: { type: 'string', enum: ['kg', 'g'], description: 'Unit of the weighing (the container unit)' },
          authorisation: { type: 'string', pattern: UUID, optional: true, description: "The quality unit's signed authorisation of this use" },
          authorisedBy: { type: 'string', pattern: UUID, optional: true, serverFilled: true, description: 'Its signer, read from the database (filled by the server)' },
          source: R.SOURCE_FACTS_SCHEMA,
        },
      },
    },
  },
  checkConfig,
  handler: {
    computedItems: (phase) => {
      const item = addedItemOf(phase.config);
      return item === undefined ? [] : [item];
    },
    acceptEntry: accept,
    computeItems,
    onPerform: (view) => R.qcDecisionOnPerform(view),
  },
  exceptionRules: [R.QC_DECISION_RULE],
  simulatorModel: { exceptionTypes: () => ['QC_ADDITIONAL_TESTING_DECISION'], nominalEntries: () => [] },
  goldenFixture: {
    description:
      'A reprocessing addition (case 2, the sample BMR: at most 3 % of the batch and 3 months old) of 0.025 kg of reserved residue (gross 0.525 kg, tare 0.500 kg) from a container of an earlier batch of the same product, with the facts read from the database and the quality unit\'s per-use authorisation; the net added is computed into the item the yield reads (C-07) and QC is flagged to decide on extra testing; performed and verified',
    controls: ['PR-47', 'IN-19'],
    phase: {
      block: { type: 'TB-08', version: '1' },
      records: ['reworkAdded'],
      config: { ageFrom: 'GENERATION', sourceStages: ['INSPECTION'], addedItem: 'reworkAdded' },
      reprocessing: { case: 'REPROCESSING_ADDITION', maxPercent: '3', maxAge: { value: '90', unit: 'd' }, maxSourceBatches: 3 },
    },
    parameters: [{ id: 'reworkAdded', name: 'Rework added', valueType: 'DECIMAL', unit: 'kg', role: 'PROCESS_PARAMETER', criticality: 'NON_CRITICAL', riskClass: 'LOW', capture: 'AUTOMATION' }],
    script: [
      {
        entry: {
          kind: 'ADDITION',
          container: SOURCE_EXAMPLE.container,
          gross: '0.525',
          tare: '0.500',
          unit: 'kg',
          authorisation: '00000000-0000-4000-8000-0000000000c8',
          authorisedBy: '00000000-0000-4000-8000-0000000000d8',
          source: { ...SOURCE_EXAMPLE },
        },
      },
    ],
    expect: { exceptions: ['QC_ADDITIONAL_TESTING_DECISION'], values: { reworkAdded: '0.025' }, status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/reprocessing/blocks.test.ts', 'apps/tablets-server/test/blocks/reprocessing/db-guards.test.ts'],
};
