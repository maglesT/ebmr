/**
 * TB-09@1 Tooling (punch and die) custody and inspection before and after use (tablets spec B.2 TB-09; Phase 3 slice
 * 3c). Controls IN-36 (b), INV-24 (tooling part), PR-22, PR-23, PR-27.
 *
 * The tooling register is the database's (tablets 0871): a set's master data (product assignment, shape, embossing,
 * score, punches and dies, usage limit in press strokes), its inspections, its issue to a batch and press, and its
 * return with the strokes the press counted. The step records what the register holds, in one of two parts:
 *   part ISSUE (before press set-up):
 *     TOOLING_INSPECTED  when BEFORE: a pre-use inspection of the set (tab.inspect_tooling), its result; a failed one
 *                        raises TOOLING_FAILED_BEFORE_USE (the set is not issued).
 *     TOOLING_ISSUED     the set issued to the batch for a press (tab.issue_tooling: refused for a set of another product,
 *                        retired, past its stroke limit, without its inspections, or issued elsewhere), only after a
 *                        passing BEFORE inspection of the set in this step (TB09-NOT-INSPECTED); it must match the MBR's
 *                        approved tooling specification (shape, embossing, score), which the database checks against
 *                        the set's master data (TB09-SPEC).
 *   part RETURN (after compression):
 *     TOOLING_RETURNED   the set returned (tab.return_tooling): the strokes of the use from the press counter (or keyed,
 *                        flagged MANUAL, when the press sent none), whether a punch or die is missing (TOOLING_COUNT_
 *                        MISMATCH: fragment risk; the press output since the issue is held) and whether the cumulative
 *                        strokes passed the set's limit (TOOLING_LIMIT_EXCEEDED); both wait for a deviation.
 *     TOOLING_INSPECTED  when AFTER: the after-return inspection of that use; a failed one raises TOOLING_FAILED_AFTER_USE
 *                        (the database held the press output since the issue; the steps after it wait for a deviation).
 * Before PERFORMED: ISSUE has issued a set; RETURN has returned one and inspected every returned set after use (IN-36:
 * the after-use check is mandatory before the step closes).
 */
import {
  CODE,
  configError,
  countField,
  EQUIPMENT_CODE,
  isRecord,
  problem,
  refuse,

  uuidField,
  type BlockVersion,
  type Config,
  type ConfigProblem,
  type Entry,
  type EntryResult,
  type ExceptionDraft,
  type HandlerProblem,
  type HandlerView,
  type ObjectSchema,
} from './compression/common.ts';
import { S } from './summaries.ts';

const CONTROLS = ['IN-36', 'INV-24', 'PR-22', 'PR-23', 'PR-27'];

export type ToolingPart = 'ISSUE' | 'RETURN';

export const partOf = (config: Config): ToolingPart => (config['part'] === 'RETURN' ? 'RETURN' : 'ISSUE');

export interface ToolingSpecification {
  type: string;
  shape: string;
  upperEmbossing: string;
  lowerEmbossing: string;
  score: string;
}

export function specificationOf(config: Config): ToolingSpecification | undefined {
  const s = config['specification'];
  return isRecord(s)
    ? { type: String(s['type']), shape: String(s['shape']), upperEmbossing: String(s['upperEmbossing']), lowerEmbossing: String(s['lowerEmbossing']), score: String(s['score']) }
    : undefined;
}

const held = (type: string, title: string, controls: string[], item: string): ExceptionDraft => ({
  type,
  title,
  controls,
  severity: 'ACTION',
  category: 'DEVIATION_OR_OVERRIDE',
  blocks: 'DOWNSTREAM',
  until: 'DEVIATION',
  deviationRequired: true,
  item,
});

function acceptInspection(view: HandlerView, entry: Entry): EntryResult {
  const set = String(entry['set']);
  const when = String(entry['when']);
  const part = partOf(view.config);
  if ((part === 'ISSUE') !== (when === 'BEFORE')) {
    return refuse('TB09-PART', `A ${part === 'ISSUE' ? 'tooling issue step records the inspection before use' : 'tooling return step records the inspection after use'}`, ['IN-36']);
  }
  if (when === 'AFTER') {
    if (!view.entries('TOOLING_RETURNED').some((e) => e.data['set'] === set)) return refuse('TB09-NOT-RETURNED', `Set ${set} is inspected after use once it is returned`, ['IN-36']);
    if (view.entries('TOOLING_INSPECTED').some((e) => e.data['set'] === set)) return refuse('TB09-INSPECTED-TWICE', `Set ${set} was inspected after this use already`, ['IN-36']);
  }
  const failed = entry['result'] === 'FAIL';
  const exceptions: ExceptionDraft[] = !failed
    ? []
    : when === 'AFTER'
      ? [held('TOOLING_FAILED_AFTER_USE', `Set ${set} failed its inspection after use at ${view.stepKey}: the tablets compressed since its issue are held and the steps after it wait for a deviation`, ['IN-36', 'INV-24', 'PR-23'], set)]
      : [
          {
            type: 'TOOLING_FAILED_BEFORE_USE',
            title: `Set ${set} failed its inspection before use at ${view.stepKey}: it is not issued`,
            controls: ['IN-36', 'PR-23'],
            severity: 'ALERT',
            category: 'DEVIATION_OR_OVERRIDE',
            blocks: 'NONE',
            item: set,
          },
        ];
  return {
    ok: true,
    data: { set, inspectionId: entry['inspectionId'], when, result: entry['result'], inspectedBy: view.actor.id },
    ...(exceptions.length > 0 ? { exceptions } : {}),
  };
}

function acceptIssue(view: HandlerView, entry: Entry): EntryResult {
  const set = String(entry['set']);
  if (partOf(view.config) !== 'ISSUE') return refuse('TB09-PART', 'A tooling return step issues no set', ['IN-36']);
  if (view.entries('TOOLING_ISSUED').some((e) => e.data['set'] === set)) return refuse('TB09-ISSUED-TWICE', `Set ${set} was issued in ${view.stepKey} already`, ['IN-36']);
  const inspection = view.entries('TOOLING_INSPECTED').filter((e) => e.data['set'] === set).at(-1);
  if (!inspection || inspection.data['result'] !== 'PASS') {
    return refuse('TB09-NOT-INSPECTED', `Set ${set} has no passing inspection before use in ${view.stepKey}`, ['IN-36', 'INV-24']);
  }
  return { ok: true, data: { set, issueId: entry['issueId'], press: entry['press'], inspection: inspection.id, issuedBy: view.actor.id } };
}

function acceptReturn(view: HandlerView, entry: Entry): EntryResult {
  const set = String(entry['set']);
  if (partOf(view.config) !== 'RETURN') return refuse('TB09-PART', 'A tooling issue step returns no set', ['IN-36']);
  if (view.entries('TOOLING_RETURNED').some((e) => e.data['set'] === set)) return refuse('TB09-RETURNED-TWICE', `Set ${set} was returned in ${view.stepKey} already`, ['IN-36']);
  const exceptions: ExceptionDraft[] = [];
  if (entry['countMismatch'] === true) {
    exceptions.push(held('TOOLING_COUNT_MISMATCH', `Set ${set} came back with punches or dies missing at ${view.stepKey}: the tablets compressed since its issue are held and the steps after it wait for a deviation`, ['IN-36', 'PR-22'], set));
  }
  if (entry['limitExceeded'] === true) {
    exceptions.push(held('TOOLING_LIMIT_EXCEEDED', `Set ${set} passed its usage limit during this use (${String(entry['strokes'])} strokes): the steps after it wait for a deviation`, ['INV-24', 'PR-23'], set));
  }
  return {
    ok: true,
    data: {
      set,
      issueId: entry['issueId'],
      strokes: entry['strokes'],
      strokeSource: entry['strokeSource'],
      countMismatch: entry['countMismatch'],
      limitExceeded: entry['limitExceeded'],
      returnedBy: view.actor.id,
    },
    ...(exceptions.length > 0 ? { exceptions } : {}),
  };
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  if (partOf(view.config) === 'ISSUE') {
    return view.entries('TOOLING_ISSUED').length === 0 ? [problem('TB09-NOT-ISSUED', `${view.stepKey} has issued no tooling set`, ['IN-36', 'INV-24'])] : [];
  }
  const returned = view.entries('TOOLING_RETURNED').map((e) => String(e.data['set']));
  if (returned.length === 0) return [problem('TB09-NOT-RETURNED', `${view.stepKey} has returned no tooling set`, ['IN-36'])];
  const inspected = new Set(view.entries('TOOLING_INSPECTED').map((e) => String(e.data['set'])));
  const open = returned.filter((s) => !inspected.has(s));
  return open.length > 0 ? [problem('TB09-AFTER-CHECK-MISSING', `Inspect set ${open.join(', ')} after use before the step closes`, ['IN-36', 'INV-24'])] : [];
}

function checkConfig(phase: Parameters<NonNullable<BlockVersion['checkConfig']>>[0], config: Config): ConfigProblem[] {
  return partOf(config) === 'ISSUE' && !specificationOf(config)
    ? [configError('TB09-NO-SPECIFICATION', `Tooling issue step ${phase.id} names no approved tooling specification`, ['PR-27', 'IN-36'])]
    : [];
}

const SET: ObjectSchema['fields'][string] = { type: 'string', pattern: CODE, description: 'Tooling set code as scanned' };

export const TB09: BlockVersion = {
  type: 'TB-09',
  version: '1',
  title: 'Tooling custody and inspection',
  edition: 'tablets',
  aliases: { tablets: 'TB-09' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'Which part of the custody the step records, and the approved tooling specification of the product',
    fields: {
      part: { type: 'string', enum: ['ISSUE', 'RETURN'], description: 'Issue before set-up, or return after compression' },
      specification: {
        type: 'object',
        optional: true,
        description: 'The approved tooling of the product (required for the issue part)',
        fields: {
          type: { type: 'string', enum: ['B', 'D', 'BB'], description: 'Tooling type' },
          shape: { type: 'string', description: 'Tablet shape and dimensions' },
          upperEmbossing: { type: 'string', description: 'Upper punch embossing or debossing' },
          lowerEmbossing: { type: 'string', description: 'Lower punch embossing or debossing' },
          score: { type: 'string', description: 'Break line, or NONE' },
        },
      },
    },
  },
  entrySummaries: {
    TOOLING_INSPECTED: (d) => `Tooling set ${S.val(d['set'])} inspected ${d['when'] === 'AFTER' ? 'after return' : 'before issue'}${S.str(d['result']) !== '' ? `: ${S.verdict(d['result'])}` : ''}`,
    TOOLING_ISSUED: (d) => `Tooling set ${S.val(d['set'])} issued for press ${S.val(d['press'])}`,
    TOOLING_RETURNED: (d) =>
      `Tooling set ${S.val(d['set'])} returned after ${S.val(d['strokes'])} strokes (${d['strokeSource'] === 'PRESS_COUNTER' ? 'press counter' : 'keyed by hand'})${d['countMismatch'] === true ? ', punches or dies differ from those issued' : ''}${d['limitExceeded'] === true ? ', stroke limit passed' : ''}`,
  },
  dataSchema: {
    entries: {
      TOOLING_INSPECTED: {
        type: 'object',
        description: 'An inspection of the set in the tooling register, before or after use',
        fields: {
          set: SET,
          inspectionId: uuidField('The inspection in the tooling register'),
          when: { type: 'string', enum: ['BEFORE', 'AFTER'], description: 'Before issue or after return' },
          result: { type: 'string', enum: ['PASS', 'FAIL'], description: 'Its result as the register holds it' },
        },
      },
      TOOLING_ISSUED: {
        type: 'object',
        description: 'The set issued to the batch for a press',
        fields: { set: SET, issueId: uuidField('The issue in the tooling register'), press: { type: 'string', pattern: EQUIPMENT_CODE, description: 'The press it was issued for' } },
      },
      TOOLING_RETURNED: {
        type: 'object',
        description: 'The set returned, with the strokes of the use',
        fields: {
          set: SET,
          issueId: uuidField('The issue it closes'),
          strokes: countField('Strokes of this use as the register holds them'),
          strokeSource: { type: 'string', enum: ['PRESS_COUNTER', 'MANUAL'], description: 'Counted by the press or keyed' },
          countMismatch: { type: 'boolean', description: 'Punches or dies returned differ from those issued' },
          limitExceeded: { type: 'boolean', description: 'The cumulative strokes passed the set\'s limit' },
        },
      },
    },
  },
  checkConfig: (phase, config) => checkConfig(phase, config),
  handler: {
    acceptEntry: (view, entry) => {
      if (entry.kind === 'TOOLING_INSPECTED') return acceptInspection(view, entry);
      if (entry.kind === 'TOOLING_ISSUED') return acceptIssue(view, entry);
      if (entry.kind === 'TOOLING_RETURNED') return acceptReturn(view, entry);
      return refuse('TB09-ENTRY', `${entry.kind} is not an entry of a tooling step`, ['IN-36']);
    },
    beforePerform,
  },
  exceptionRules: [
    { type: 'TOOLING_FAILED_BEFORE_USE', category: 'DEVIATION_OR_OVERRIDE', severity: 'ALERT', summary: 'A tooling set failed its inspection before use; it is not issued', controls: ['IN-36', 'PR-23'] },
    { type: 'TOOLING_FAILED_AFTER_USE', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'A tooling set failed its inspection after use; the tablets since its issue are held', controls: ['IN-36', 'INV-24', 'PR-23'] },
    { type: 'TOOLING_COUNT_MISMATCH', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'Punches or dies missing at return (fragment risk); the tablets since the issue are held', controls: ['IN-36', 'PR-22'] },
    { type: 'TOOLING_LIMIT_EXCEEDED', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'A tooling set passed its usage limit during the use', controls: ['INV-24', 'PR-23'] },
  ],
  simulatorModel: {
    exceptionTypes: () => ['TOOLING_FAILED_BEFORE_USE', 'TOOLING_FAILED_AFTER_USE', 'TOOLING_COUNT_MISMATCH', 'TOOLING_LIMIT_EXCEEDED'],
    // Nominal: the issue part inspects and issues set SET-01; the return part returns and inspects it. The register ids
    // are the simulator's own (the database run writes real ones).
    nominalEntries: ({ config }) =>
      partOf(config) === 'ISSUE'
        ? [
            { kind: 'TOOLING_INSPECTED', set: 'SET-01', inspectionId: '00000000-0000-4000-8000-000000000901', when: 'BEFORE', result: 'PASS' },
            { kind: 'TOOLING_ISSUED', set: 'SET-01', issueId: '00000000-0000-4000-8000-000000000902', press: 'PRESS-01' },
          ]
        : [
            { kind: 'TOOLING_RETURNED', set: 'SET-01', issueId: '00000000-0000-4000-8000-000000000902', strokes: '120000', strokeSource: 'PRESS_COUNTER', countMismatch: false, limitExceeded: false },
            { kind: 'TOOLING_INSPECTED', set: 'SET-01', inspectionId: '00000000-0000-4000-8000-000000000903', when: 'AFTER', result: 'PASS' },
          ],
  },
  goldenFixture: {
    description:
      'The return part: set SET-07 returned with 412000 strokes counted by the press and one die missing, then found chipped at the after-use inspection: TOOLING_COUNT_MISMATCH and TOOLING_FAILED_AFTER_USE wait for a deviation; performed and verified',
    controls: ['IN-36', 'INV-24'],
    phase: { block: { type: 'TB-09', version: '1' }, config: { part: 'RETURN' } },
    script: [
      { entry: { kind: 'TOOLING_RETURNED', set: 'SET-07', issueId: '00000000-0000-4000-8000-000000000702', strokes: '412000', strokeSource: 'PRESS_COUNTER', countMismatch: true, limitExceeded: false } },
      { entry: { kind: 'TOOLING_INSPECTED', set: 'SET-07', inspectionId: '00000000-0000-4000-8000-000000000703', when: 'AFTER', result: 'FAIL' } },
    ],
    expect: { exceptions: ['TOOLING_COUNT_MISMATCH', 'TOOLING_FAILED_AFTER_USE'], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/compression/blocks.test.ts', 'apps/tablets-server/test/blocks/compression/db-guards.test.ts'],
};

