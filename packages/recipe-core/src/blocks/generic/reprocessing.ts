/**
 * Reprocessing and recovery additions on the database path (outline 5.2.9 cases 2 and 3; tablets spec K-24, TB-08;
 * Phase 3 slice 5b; D-S5-7, D-S5-8). Controls PR-47, IN-18, IN-19, PR-57; invariant INV-33.
 *
 * G-24@2 takes no start data: the database starts it only on the quality unit's signed authorisation of the step
 * (recipe-core 0622, 0623), since an accepted start never records start data (recipe-core 0345).
 *
 * G-24@1 takes the facts of a source addition (source batch, product, manufacture instant, recovered flag) from the
 * caller; the database refuses its SOURCE_ADDITION on GMP (recipe-core 0620). G-24@2 and the Tablets edition's TB-08@1
 * take them from the database instead: an ADDITION entry names a closed output container of an executed batch record
 * (never ad-hoc material) and, where per-use authorisation applies, the quality unit's signed authorisation of that use;
 * the server reads the container's facts (recipe.source_container_facts) and the authorisation's signer
 * (recipe.reprocessing_authorisation_facts) into the entry in the command's transaction, the block judges them, and the
 * database reads them again at the row's own time, refuses any other value, applies the same rules and records the
 * addition with its genealogy edge in the same transaction (recipe.source_addition, recipe-core 0622).
 *
 * The rules a block applies to an addition (`additionProblems`), shared by G-24@2 and TB-08@1:
 *   - only at a recovery or reprocessing-addition step; a case 2 (reprocessing addition) source is a reject container
 *     the quality unit reserved for reprocessing, a case 3 (recovery) source a container released by QA (D-S5-7);
 *   - never from the receiving batch itself, always of the batch's product and strength;
 *   - never from material that itself contains recovered or reprocessed material (chained recovery is blocked);
 *   - not older than the MBR's maximum age at the row's time, from the step's reference instant;
 *   - from at most the MBR's number of source batches, in the container's unit, never more than the container still
 *     holds, and the step's cumulative net never above the MBR's percentage of the standard batch size (the MBR's first
 *     batch size);
 *   - with a signed per-use authorisation (mandatory for case 2) that no other addition used, given by someone other
 *     than the person who adds.
 */
import { Dec } from '@ebmr/expr';
import { durationToMicros } from '../../flow/decimal.ts';
import type { BlockVersion, EntryResult, HandlerProblem, HandlerView, ObjectSchema } from '../contract.ts';
import { convert, micros, netOf, problem } from './common.ts';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGITS = /^[0-9]{1,20}$/;
const PLAIN_DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;

/** The cases of the reprocessing declaration an addition can be made at. */
export const ADDITION_CASES = ['REPROCESSING_ADDITION', 'RECOVERY'] as const;
export type AdditionCase = (typeof ADDITION_CASES)[number];

/** The facts of a source container as the database reads them (recipe.source_container_facts); never typed. */
export const SOURCE_FACTS_SCHEMA: ObjectSchema = {
  type: 'object',
  serverFilled: true,
  description: 'The source container as the database reads it at the moment of use (filled by the server, checked again by the database)',
  fields: {
    container: { type: 'string', pattern: UUID_PATTERN, description: 'Output container id' },
    sourceBatchId: { type: 'string', pattern: UUID_PATTERN, description: 'Batch record that created the container' },
    product: { type: 'string', description: 'Product code of the source batch' },
    strength: { type: 'string', description: 'Strength of the source batch' },
    stage: { type: 'string', description: 'Stage the container was filled at' },
    unit: { type: 'string', enum: ['kg', 'g', 'units'], description: 'Unit of the container' },
    case: { type: 'string', enum: [...ADDITION_CASES], optional: true, description: 'Reserved residue (reprocessing addition) or QA-released material (recovery); absent when neither' },
    generatedAtUs: { type: 'string', pattern: DIGITS, description: 'When the material was generated: the container closed (epoch microseconds)' },
    manufacturedAtUs: { type: 'string', pattern: DIGITS, description: 'When the source batch was issued (epoch microseconds)' },
    containsRecovered: { type: 'boolean', description: 'The source batch itself contains recovered or reprocessed material' },
    remaining: { type: 'string', pattern: PLAIN_DECIMAL, description: 'What the container still holds, in its unit' },
    expiry: { type: 'string', pattern: /^[0-9]{4}-(0[1-9]|1[0-2])$/, optional: true, description: 'Expiry month of the source batch (product master shelf life), when known' },
  },
};

export interface SourceFacts {
  container: string;
  sourceBatchId: string;
  product: string;
  strength: string;
  stage: string;
  unit: string;
  case?: AdditionCase;
  generatedAtUs: string;
  manufacturedAtUs: string;
  containsRecovered: boolean;
  remaining: string;
  expiry?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The source facts of an entry, or undefined when it carries none (ad-hoc material). */
export function sourceOf(entry: Readonly<Record<string, unknown>>): SourceFacts | undefined {
  const s = entry['source'];
  return isRecord(s) && typeof s['container'] === 'string' ? (s as unknown as SourceFacts) : undefined;
}

export interface AdditionInput {
  /** The net added, decimal text. */
  net: string;
  unit: string;
  source: SourceFacts | undefined;
  authorisation: string | undefined;
  authorisedBy: string | undefined;
  /** Whether this step needs a per-use authorisation for every addition. */
  authorisationRequired: boolean;
  /** Which instant of the source its age is counted from. */
  ageFrom: 'GENERATION' | 'MANUFACTURE';
}

/** The nets of the ADDITION entries already recorded at the step, in their units. */
function priorNets(view: HandlerView): { value: string; unit: string; sourceBatchId: string; authorisation: unknown }[] {
  return view.entries('ADDITION').map((e) => {
    const net = e.data['net'] as { value: string; unit: string } | undefined;
    const src = e.data['source'] as SourceFacts | undefined;
    return { value: net?.value ?? '0', unit: net?.unit ?? '', sourceBatchId: src?.sourceBatchId ?? '', authorisation: e.data['authorisation'] };
  });
}

/**
 * The step's cumulative net (the earlier additions and this one) in `unit`, or undefined when one cannot be converted.
 */
export function cumulativeNet(view: HandlerView, unit: string, extra?: { value: string; unit: string }): string | undefined {
  let total = Dec.ZERO;
  for (const q of [...priorNets(view), ...(extra ? [extra] : [])]) {
    const c = convert(view, q.value, q.unit, unit);
    if (c === undefined) return undefined;
    total = total.plus(Dec.parse(c));
  }
  return total.toString();
}

/** The rule codes a block gives for the addition rules (each block its own, written out in its source). */
export interface AdditionCodes {
  'NO-ADDITION': string;
  'AD-HOC': string;
  'SOURCE-STATUS': string;
  'OWN-BATCH': string;
  'OTHER-PRODUCT': string;
  CHAINED: string;
  'TOO-OLD': string;
  'TOO-MANY-SOURCES': string;
  UNIT: string;
  'OVER-REMAINING': string;
  'TOO-MUCH': string;
  'NOT-AUTHORISED': string;
  'SELF-AUTHORISED': string;
  'AUTHORISATION-USED': string;
}

/** G-24@2's codes. */
export const G24_ADDITION_CODES: AdditionCodes = {
  'NO-ADDITION': 'G24-NO-ADDITION',
  'AD-HOC': 'G24-AD-HOC',
  'SOURCE-STATUS': 'G24-SOURCE-STATUS',
  'OWN-BATCH': 'G24-OWN-BATCH',
  'OTHER-PRODUCT': 'G24-OTHER-PRODUCT',
  CHAINED: 'G24-CHAINED',
  'TOO-OLD': 'G24-TOO-OLD',
  'TOO-MANY-SOURCES': 'G24-TOO-MANY-SOURCES',
  UNIT: 'G24-UNIT',
  'OVER-REMAINING': 'G24-OVER-REMAINING',
  'TOO-MUCH': 'G24-TOO-MUCH',
  'NOT-AUTHORISED': 'G24-NOT-AUTHORISED',
  'SELF-AUTHORISED': 'G24-SELF-AUTHORISED',
  'AUTHORISATION-USED': 'G24-AUTHORISATION-USED',
};

/** Why an addition at the step of `view` is refused (with the block's `codes`); [] when allowed. */
export function additionProblems(view: HandlerView, codes: AdditionCodes, a: AdditionInput): HandlerProblem[] {
  const rp = view.phase.reprocessing;
  const p = (code: keyof AdditionCodes, message: string, controls: string[]): HandlerProblem => problem(codes[code], message, controls);
  if (!rp || !(ADDITION_CASES as readonly string[]).includes(rp.case)) return [p('NO-ADDITION', `${view.phase.id} is not a recovery or reprocessing-addition step`, ['PR-47'])];
  const s = a.source;
  if (!s) return [p('AD-HOC', 'Only a container created in an executed batch record can be added; ad-hoc material is never introduced', ['PR-47', 'IN-19'])];
  const out: HandlerProblem[] = [];
  if (s.case !== rp.case) {
    out.push(
      p(
        'SOURCE-STATUS',
        rp.case === 'REPROCESSING_ADDITION'
          ? `Container ${s.container} is not reject material the quality unit reserved for reprocessing`
          : `Container ${s.container} is not conforming material released by QA`,
        ['PR-47', 'IN-19'],
      ),
    );
  }
  if (s.sourceBatchId === view.batch.batchId) out.push(p('OWN-BATCH', `Container ${s.container} is of this batch; an addition comes from an earlier batch`, ['PR-47']));
  if (s.product !== view.batch.productCode || s.strength !== view.mbr.header.product.strength) {
    out.push(p('OTHER-PRODUCT', `Material of ${s.product} ${s.strength} cannot be added to a batch of ${view.batch.productCode} ${view.mbr.header.product.strength}`, ['PR-47', 'IN-19']));
  }
  if (s.containsRecovered) out.push(p('CHAINED', `The batch of container ${s.container} itself contains recovered or reprocessed material: chained recovery is blocked`, ['IN-19', 'PR-47']));
  const from = micros(a.ageFrom === 'GENERATION' ? s.generatedAtUs : s.manufacturedAtUs);
  const maxAge = rp.maxAge ? durationToMicros(rp.maxAge.value, rp.maxAge.unit) : undefined;
  if (from === undefined || maxAge === undefined || view.nowUs - from > maxAge) {
    out.push(p('TOO-OLD', `The material of container ${s.container} is older than the MBR maximum of ${rp.maxAge?.value ?? '?'} ${rp.maxAge?.unit ?? ''}`, ['IN-19', 'PR-47']));
  }
  const prior = priorNets(view);
  const sources = new Set([...prior.map((x) => x.sourceBatchId), s.sourceBatchId]);
  if (rp.maxSourceBatches === undefined || sources.size > rp.maxSourceBatches) out.push(p('TOO-MANY-SOURCES', `At most ${rp.maxSourceBatches ?? 0} source batches may be added at ${view.phase.id}`, ['IN-19']));
  if (a.unit !== s.unit) out.push(p('UNIT', `Container ${s.container} holds ${s.unit}; the addition is taken in its unit`, ['PR-47']));
  else if (Dec.parse(a.net).gt(Dec.parse(s.remaining))) out.push(p('OVER-REMAINING', `Container ${s.container} holds ${s.remaining} ${s.unit}; ${a.net} ${a.unit} cannot be taken from it`, ['PR-47', 'INV-33']));
  const size = view.mbr.header.batchSizes[0]?.quantity;
  const total = size ? cumulativeNet(view, size.unit, { value: a.net, unit: a.unit }) : undefined;
  if (rp.maxPercent === undefined || !size || total === undefined || Dec.parse(total).times(Dec.HUNDRED).gt(Dec.parse(size.value).times(Dec.parse(rp.maxPercent)))) {
    out.push(p('TOO-MUCH', `The material added at ${view.phase.id} would exceed ${rp.maxPercent ?? '?'} % of the standard batch size`, ['IN-19', 'PR-47']));
  }
  if (a.authorisation === undefined) {
    if (a.authorisationRequired) out.push(p('NOT-AUTHORISED', `Each addition at ${view.phase.id} needs the quality unit's prior authorisation of this use`, ['PR-47', 'IN-19']));
  } else {
    if (a.authorisedBy === undefined) out.push(p('NOT-AUTHORISED', `Authorisation ${a.authorisation} is not signed by the quality unit`, ['PR-47']));
    else if (a.authorisedBy === view.actor.id) out.push(p('SELF-AUTHORISED', 'The use is authorised by the quality unit, not by the person who adds the material', ['PR-47']));
    if (prior.some((x) => x.authorisation === a.authorisation)) out.push(p('AUTHORISATION-USED', `Authorisation ${a.authorisation} was already used for an addition`, ['PR-47']));
  }
  return out;
}

const QC_DECISION = (view: HandlerView) => ({
  type: 'QC_ADDITIONAL_TESTING_DECISION',
  title: `${view.stepKey} added reprocessed or recovered material: QC must record a decision on additional testing before release`,
  controls: ['PR-47', 'IN-19'],
  severity: 'ALERT' as const,
  category: 'DEVIATION_OR_OVERRIDE' as const,
  blocks: 'NONE' as const,
  releaseBlocking: true,
});

export const QC_DECISION_RULE = {
  type: 'QC_ADDITIONAL_TESTING_DECISION',
  category: 'DEVIATION_OR_OVERRIDE' as const,
  severity: 'ALERT' as const,
  summary: 'A QC decision on additional testing is required before release',
  controls: ['PR-47', 'IN-19'],
};

/** The release-blocking QC decision a step that added material raises when it is performed (PR-47). */
export function qcDecisionOnPerform(view: HandlerView, always = false): { exceptions: ReturnType<typeof QC_DECISION>[] } {
  return { exceptions: always || view.entries('ADDITION').length > 0 ? [QC_DECISION(view)] : [] };
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

// ---------------------------------------------------------------------------------------------
// G-24@2 Reprocessing / rework gate on the database path

const SOURCE_EXAMPLE: SourceFacts = {
  container: '00000000-0000-4000-8000-0000000000a1',
  sourceBatchId: '00000000-0000-4000-8000-0000000000b1',
  product: 'P',
  strength: '1 mg',
  stage: 'INSPECTION',
  unit: 'kg',
  case: 'RECOVERY',
  generatedAtUs: '1790000000000000',
  manufacturedAtUs: '1789000000000000',
  containsRecovered: false,
  remaining: '5',
};

export const G24V2: BlockVersion = {
  type: 'G-24',
  version: '2',
  title: 'Reprocessing / rework gate (database facts)',
  edition: 'generic',
  aliases: { tablets: 'K-24', injectables: 'KB-18' },
  level: 'PHASE',
  controls: ['PR-47', 'IN-18', 'IN-19', 'PR-57'],
  configSchema: { type: 'object', description: 'Case and limits come from the phase reprocessing declaration (outline 5.2.9)', fields: {} },
  dataSchema: {
    entries: {
      ADDITION: {
        type: 'object',
        description: 'Material taken from a closed output container of an earlier batch (recovery or reprocessing addition)',
        fields: {
          container: { type: 'string', pattern: UUID_PATTERN, description: 'The source output container' },
          quantity: { type: 'object', description: 'Net quantity taken, in the container unit', fields: { value: { type: 'decimal', min: '0', minExclusive: true, description: 'Decimal written as text' }, unit: { type: 'string', enum: ['kg', 'g', 'units'], description: 'Unit' } } },
          authorisation: { type: 'string', pattern: UUID_PATTERN, description: "The quality unit's signed authorisation of this use" },
          authorisedBy: { type: 'string', pattern: UUID_PATTERN, optional: true, serverFilled: true, description: 'Its signer, read from the database (filled by the server)' },
          source: SOURCE_FACTS_SCHEMA,
        },
      },
    },
  },
  checkConfig: (phase) =>
    phase.reprocessing === undefined ? [{ code: 'G24-NO-CASE', severity: 'ERROR', message: `Reprocessing step ${phase.id} declares no case (whole-batch reprocessing, reprocessing addition, recovery)`, controls: ['PR-47', 'IN-19'] }] : [],
  handler: {
    acceptEntry: (view, entry): EntryResult => {
      if (entry.kind !== 'ADDITION') return { ok: false, problems: [problem('G24-ENTRY', `${entry.kind} is not an entry of a reprocessing step`, ['PR-47'])] };
      const q = entry['quantity'] as { value: string; unit: string };
      const source = sourceOf(entry);
      const problems = additionProblems(view, G24_ADDITION_CODES, {
        net: q.value,
        unit: q.unit,
        source,
        authorisation: text(entry['authorisation']),
        authorisedBy: text(entry['authorisedBy']),
        authorisationRequired: true,
        ageFrom: 'GENERATION',
      });
      if (problems.length > 0) return { ok: false, problems };
      return {
        ok: true,
        data: {
          container: entry['container'],
          net: { value: q.value, unit: q.unit },
          source: entry['source'],
          case: view.phase.reprocessing?.case,
          authorisation: entry['authorisation'],
          authorisedBy: entry['authorisedBy'],
          addedBy: view.actor.id,
        },
        verificationRequired: true,
      };
    },
    onPerform: (view) => qcDecisionOnPerform(view, view.phase.reprocessing?.case === 'WHOLE_BATCH_REPROCESSING'),
  },
  exceptionRules: [QC_DECISION_RULE],
  simulatorModel: { exceptionTypes: () => ['QC_ADDITIONAL_TESTING_DECISION'], nominalEntries: () => [] },
  goldenFixture: {
    description:
      'A recovery addition of 0.02 kg from a QA-released container of an earlier batch of the same product (facts read from the database), each use authorised beforehand by the quality unit (the step itself starts on its signed authorisation, which the database holds); QC is flagged to decide on extra testing',
    controls: ['PR-47', 'IN-19'],
    phase: { block: { type: 'G-24', version: '2' }, config: {}, reprocessing: { case: 'RECOVERY', maxPercent: '3', maxAge: { value: '90', unit: 'd' }, maxSourceBatches: 2 } },
    script: [
      {
        entry: {
          kind: 'ADDITION',
          container: SOURCE_EXAMPLE.container,
          quantity: { value: '0.02', unit: 'kg' },
          authorisation: '00000000-0000-4000-8000-0000000000c2',
          authorisedBy: '00000000-0000-4000-8000-0000000000d1',
          source: { ...SOURCE_EXAMPLE },
        },
      },
    ],
    expect: { exceptions: ['QC_ADDITIONAL_TESTING_DECISION'], status: 'COMPLETED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts', 'packages/recipe-core/test/blocks/reprocessing.test.ts'],
};

/** The net of a weighed addition (gross - tare, exact), or why there is none. */
export function weighedNet(gross: unknown, tare: unknown): { ok: true; net: string } | { ok: false; message: string } {
  if (typeof gross !== 'string' || typeof tare !== 'string') return { ok: false, message: 'gross and tare are decimal text' };
  return netOf(gross, tare);
}
