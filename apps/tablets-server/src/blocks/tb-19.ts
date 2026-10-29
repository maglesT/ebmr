/**
 * TB-19@1 Tablet printing or laser marking with the post-printing QC approval gate (tablets spec B.2 TB-19, K-16;
 * Phase 3 slice 3d, builder A). Controls IN-37, PR-29.
 *
 * The MBR sets the marking method, the mark content (from the approved master, never typed at the step), the check
 * sample size and the defects a check may find before it fails (D 0). Entries:
 *   PRINT_SETUP  once: the printer (a PROCESS unit of the plant: the database checks it), the ink or colour lot and that
 *                it is of edible grade (Sched M VIII 6.1: refused otherwise), and whether other products or batches are
 *                printed at the same time, which needs the segregation record (refused without it).
 *   PRINT_CHECK  periodic, after the set-up: the MBR's number of tablets examined, legibility, whether the mark matches
 *                the master content (the block writes the content from the MBR), and the defects by category (smudged,
 *                missing, misregistered). PASS only legible, matching and with no more defects than the MBR allows;
 *                a FAIL raises PRINT_CHECK_FAILED (the steps after it wait for a deviation) and, in the database, holds
 *                every printed container of the printer since its last passing check (the slice 1 container hold,
 *                plant.record_ipc_check); a PASS is the passing check that vouches for them.
 * Before PERFORMED: the set-up and a last check that passes.
 *
 * The QC approval gate (Sched M VIII 6.2): the MBR places a QA hold point (G-17) directly after the printing step, signed
 * by the quality unit's role the MBR names (gateRole, D 'QA'), with a non-releasing disposition among its dispositions;
 * nothing after it runs until it is signed (the engine and the database, recipe-core 0307/0308), it is not released while
 * a failed check is open (PR-45), and a printed container cannot be charged, packed or merged until it is released
 * (tablets 0912). The database refuses every row of a batch whose MBR has a printing step without that gate.
 */
import {
  configError,
  COUNT,
  EQUIPMENT_CODE,
  isRecord,
  POSITIVE_COUNT,
  positiveCount,
  problem,
  refuse,
  text,
  type BlockVersion,
  type Config,
  type ConfigProblem,
  type Entry,
  type EntryResult,
  type FlowNode,
  type HandlerProblem,
  type HandlerView,
  type JsonValue,
  type MbrContent,
  type PhaseNode,
} from './coating/common.ts';
import { ancestorsOf } from './coating/common.ts';
import { S } from './summaries.ts';

const CONTROLS = ['IN-37', 'PR-29'];
export const PRINT_DEFECTS = ['SMUDGED', 'MISSING', 'MISREGISTERED'] as const;
const RELEASING = ['APPROVED', 'APPROVED_WITH_CONDITIONS', 'CONTINUE', 'RELEASED', 'ACCEPTED'];

const gateRole = (config: Config): string => text(config['gateRole']) ?? 'QA';
const maxDefects = (config: Config): bigint => BigInt(text(config['maxDefects']) ?? '0');

/** The node right after phase `id` in its enclosing sequence (undefined when it is last or not in a sequence). */
export function nextNodeOf(mbr: MbrContent, id: string): FlowNode | undefined {
  const path = ancestorsOf(mbr, id);
  const parent = path.at(-1);
  if (parent?.kind !== 'sequence') return undefined;
  const i = parent.children.findIndex((c) => c.id === id);
  return i >= 0 ? parent.children[i + 1] : undefined;
}

/** Why the QC gate after printing step `phase` is missing or wrong (undefined when it is in place). */
export function gateProblem(mbr: MbrContent, phase: PhaseNode, config: Config): string | undefined {
  const next = nextNodeOf(mbr, phase.id);
  if (next?.kind !== 'holdPoint') return `the node after printing step ${phase.id} is not a QA hold point`;
  if (next.role !== gateRole(config)) return `hold point ${next.id} after printing step ${phase.id} is signed by ${next.role}, not ${gateRole(config)}`;
  if (!next.dispositions.some((d) => !RELEASING.includes(d))) return `hold point ${next.id} after printing step ${phase.id} has no disposition that rejects the printed tablets`;
  return undefined;
}

function acceptSetup(view: HandlerView, entry: Entry): EntryResult {
  if (view.entries('PRINT_SETUP').length > 0) return refuse('TB19-SETUP-TWICE', `${view.stepKey} already records its printing set-up`, ['IN-37']);
  if (entry['inkEdibleGrade'] !== true) return refuse('TB19-INK', `Ink or colour lot ${String(entry['inkLot'])} is used for printing tablets only when it is of edible grade`, ['IN-37']);
  const others = entry['otherProductsPrinting'] === true;
  const record = text(entry['segregationRecord']);
  if (others && (record === undefined || record.trim() === '')) {
    return refuse('TB19-SEGREGATION', 'Other products or batches are printed at the same time: the segregation record is required', ['IN-37']);
  }
  if (!others && record !== undefined) return refuse('TB19-SEGREGATION', 'A segregation record is given only when other products or batches are printed at the same time', ['IN-37']);
  return {
    ok: true,
    data: { printer: entry['printer'], inkLot: entry['inkLot'], inkEdibleGrade: true, otherProductsPrinting: others, ...(record !== undefined ? { segregationRecord: record } : {}), setUpBy: view.actor.id },
  };
}

function acceptCheck(view: HandlerView, entry: Entry): EntryResult {
  if (view.entries('PRINT_SETUP').length === 0) return refuse('TB19-NO-SETUP', `Set up the printing of ${view.stepKey} first`, ['IN-37']);
  const n = String(entry['examined']);
  if (n !== text(view.config['sampleSize'])) return refuse('TB19-SAMPLE', `A print check examines the ${text(view.config['sampleSize']) ?? '-'} tablets the MBR sets, not ${n}`, ['PR-29']);
  const d = isRecord(entry['defects']) ? entry['defects'] : {};
  const counts = PRINT_DEFECTS.map((k) => BigInt(typeof d[k] === 'string' ? d[k] : '0'));
  const total = counts.reduce((a, b) => a + b, 0n);
  if (total > BigInt(n)) return refuse('TB19-DEFECTS', `More defects (${total}) than tablets examined (${n})`, ['PR-29']);
  const legible = entry['legible'] === true;
  const matches = entry['contentMatches'] === true;
  const pass = legible && matches && total <= maxDefects(view.config);
  return {
    ok: true,
    data: {
      examined: n,
      legible,
      contentMatches: matches,
      content: view.config['content'],
      defects: entry['defects'],
      defectCounts: Object.fromEntries(PRINT_DEFECTS.map((k, i) => [k, (counts[i] ?? 0n).toString()])),
      defectTotal: total.toString(),
      result: pass ? 'PASS' : 'FAIL',
      checkedBy: view.actor.id,
    },
    ...(pass
      ? {}
      : {
          exceptions: [
            {
              type: 'PRINT_CHECK_FAILED',
              title: `A print check of ${view.stepKey} failed (${legible ? '' : 'illegible; '}${matches ? '' : 'mark does not match the master; '}${total} defects in ${n}): the tablets printed since the last passing check are held and the steps after it wait for a deviation`,
              controls: ['IN-37', 'PR-29'],
              severity: 'ACTION',
              category: 'OUT_OF_LIMIT',
              blocks: 'DOWNSTREAM',
              until: 'DEVIATION',
              deviationRequired: true,
            },
          ],
        }),
  };
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  const out: HandlerProblem[] = [];
  if (view.entries('PRINT_SETUP').length === 0) out.push(problem('TB19-NO-SETUP', `${view.stepKey} has no printing set-up`, ['IN-37']));
  const last = view.entries('PRINT_CHECK').at(-1);
  if (!last) out.push(problem('TB19-NO-CHECK', `${view.stepKey} has no print check`, ['IN-37', 'PR-29']));
  else if (last.data['result'] !== 'PASS') out.push(problem('TB19-LAST-CHECK', `The last print check of ${view.stepKey} failed: a passing check comes after it`, ['IN-37', 'PR-29']));
  return out;
}

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const gate = gateProblem(mbr, phase, config);
  if (gate) out.push(configError('TB19-NO-GATE', `Printed tablets wait for the QC approval: ${gate}`, ['IN-37', 'PR-29']));
  const content = text(config['content']);
  if (!content || content.trim() === '') out.push(configError('TB19-CONTENT', `Printing step ${phase.id} names the mark content from the approved master`, ['IN-37']));
  return out;
}

export const TB19: BlockVersion = {
  type: 'TB-19',
  version: '1',
  title: 'Tablet printing with QC approval',
  edition: 'tablets',
  aliases: { tablets: 'TB-19' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: {
    type: 'object',
    description: 'Marking method and content, the check sample, the defects allowed and the role of the QC approval gate',
    fields: {
      method: { type: 'string', enum: ['INK', 'LASER'], description: 'Ink printing or laser marking' },
      content: { type: 'string', description: 'The mark content from the approved product master' },
      sampleSize: positiveCount('Tablets examined per print check'),
      maxDefects: { type: 'string', pattern: COUNT, optional: true, description: 'Defects a check may find and still pass (D 0)' },
      gateRole: { type: 'string', optional: true, description: 'Role of the QC approval hold point after the step (D QA)' },
    },
  },
  entrySummaries: {
    PRINT_SETUP: (d) =>
      `Printer ${S.val(d['printer'])} set up with ink lot ${S.val(d['inkLot'])}${d['inkEdibleGrade'] === true ? ' (edible grade)' : ''}${d['otherProductsPrinting'] === true ? `, other products printed at the same time${S.str(d['segregationRecord']) !== '' ? ` (segregation record ${S.str(d['segregationRecord'])})` : ''}` : ''}`,
    PRINT_CHECK: (d) =>
      `Print check of ${S.count(d['examined'], 'tablet')}: ${d['legible'] === true ? 'legible' : 'not legible'}, ${d['contentMatches'] === true ? 'content matches' : 'content does not match'}, ${S.str(d['defectTotal']) !== '' ? `${S.str(d['defectTotal'])} defects` : `defects ${S.tally(d['defects'])}`}${S.str(d['result']) !== '' ? `: ${S.verdict(d['result'])}` : ''}`,
  },
  dataSchema: {
    entries: {
      PRINT_SETUP: {
        type: 'object',
        description: 'The printer, the ink lot and the segregation of simultaneous printing',
        fields: {
          printer: { type: 'string', pattern: EQUIPMENT_CODE, description: 'Printer or laser marker (a PROCESS unit of the plant)' },
          inkLot: { type: 'string', description: 'Ink or colour lot' },
          inkEdibleGrade: { type: 'boolean', description: 'The ink is of edible grade' },
          otherProductsPrinting: { type: 'boolean', description: 'Other products or batches are printed at the same time' },
          segregationRecord: { type: 'string', optional: true, description: 'The segregation record (when others are printed at the same time)' },
        },
      },
      PRINT_CHECK: {
        type: 'object',
        description: 'A periodic check of the printed tablets',
        fields: {
          examined: { type: 'string', pattern: POSITIVE_COUNT, description: 'Tablets examined' },
          legible: { type: 'boolean', description: 'The mark is legible' },
          contentMatches: { type: 'boolean', description: 'The mark matches the master content' },
          defects: {
            type: 'object',
            description: 'Defects found by category',
            fields: Object.fromEntries(PRINT_DEFECTS.map((k) => [k, { type: 'string', pattern: COUNT, optional: true, description: `${k.toLowerCase()} marks` }])),
          },
        },
      },
    },
  },
  checkConfig,
  handler: {
    acceptEntry: (view, entry) => {
      if (entry.kind === 'PRINT_SETUP') return acceptSetup(view, entry);
      if (entry.kind === 'PRINT_CHECK') return acceptCheck(view, entry);
      return refuse('TB19-ENTRY', `${entry.kind} is not an entry of a printing step`, ['IN-37']);
    },
    beforePerform,
  },
  exceptionRules: [{ type: 'PRINT_CHECK_FAILED', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A failed print check (output since the last passing check held)', controls: ['IN-37', 'PR-29'] }],
  simulatorModel: {
    exceptionTypes: () => ['PRINT_CHECK_FAILED'],
    nominalEntries: (input) => [
      { kind: 'PRINT_SETUP', printer: 'PRINTER-01', inkLot: 'INK-001', inkEdibleGrade: true, otherProductsPrinting: false },
      { kind: 'PRINT_CHECK', examined: text(input.config['sampleSize']) ?? '1', legible: true, contentMatches: true, defects: {} },
    ],
  },
  goldenFixture: {
    description:
      'Ink printing of "C3" with edible ink and no simultaneous printing: a check of 50 tablets with 2 smudged marks fails (PRINT_CHECK_FAILED), the next check of 50 passes; performed and verified, then the QC hold point after it is the gate',
    controls: ['IN-37', 'PR-29'],
    phase: { block: { type: 'TB-19', version: '1' }, config: { method: 'INK', content: 'C3', sampleSize: '50' } },
    script: [
      { entry: { kind: 'PRINT_SETUP', printer: 'PRINTER-01', inkLot: 'INK-24-117', inkEdibleGrade: true, otherProductsPrinting: false } },
      { entry: { kind: 'PRINT_CHECK', examined: '50', legible: true, contentMatches: true, defects: { SMUDGED: '2' } } },
      { advanceUs: 1_800_000_000n },
      { entry: { kind: 'PRINT_CHECK', examined: '50', legible: true, contentMatches: true, defects: {} } },
    ],
    expect: { exceptions: ['PRINT_CHECK_FAILED'], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/coating/blocks.test.ts', 'apps/tablets-server/test/blocks/coating/db-guards.test.ts'],
};
