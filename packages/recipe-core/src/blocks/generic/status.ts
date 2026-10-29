/**
 * Equipment and area status blocks, version 1: SANDBOX_ONLY manual-attestation stand-ins (Phase 2 apps
 * plan section 7; decision D3; outline 6.6 block table G-09 and G-10).
 *
 * The real G-09 and G-10 read equipment, room and cleaning status from database-backed site services
 * (PR-22 to PR-27, IN-21, IN-25, IN-26: Phase 3 and 4). Version 1 only records what a person attests at
 * the point of work, so it may run only in the sandbox: both versions are `availability: 'SANDBOX_ONLY'`
 * and `defineBatch` refuses them for a GMP installation (ENG-DEF-SANDBOX-ONLY; DI-05, INV-18).
 *
 * - G-09@1 "Equipment status (manual attestation)": one EQUIPMENT_STATUS entry per checked equipment
 *   (the phase's STATUS_CHECK equipment), with the status-label id and a YES/NO answer for every check of
 *   the configured list. Any NO raises EQUIPMENT_STATUS_FAILED, which stops the step and the steps after
 *   it until QA dispositions it.
 * - G-10@1 "Clearance checklist": CLEARANCE_CHECK answers every item of the configured checklist
 *   (CONFIRMED, NOT_CONFIRMED, or NOT_APPLICABLE where the item allows it); PREVIOUS_BATCH records the
 *   product and batch last processed there. NOT_CONFIRMED raises CLEARANCE_FAILED (blocking until QA
 *   dispositions it). A clearance is a significant step: its entries force two-person verification.
 *   Meanings LINE_CLEARANCE_PERFORMED and LINE_CLEARANCE_VERIFIED.
 * Both accept `config: {}` (the default lists below), so the tablet fixtures run unchanged.
 */
import type { PhaseNode } from '../../flow/model.ts';
import type { BlockVersion, ExceptionDraft, HandlerProblem, HandlerView } from '../contract.ts';
import type { FieldSchema } from '../schema.ts';
import { problem } from './common.ts';
import * as S from '../summary.ts';

/** A check of the equipment-status attestation: id and the question shown. */
export interface StatusCheck {
  id: string;
  text: string;
}

/** An item of the clearance checklist. `expected` CONFIRMED_OR_NOT_APPLICABLE lets the person answer NOT_APPLICABLE. */
export interface ClearanceItem {
  id: string;
  text: string;
  expected: 'CONFIRMED' | 'CONFIRMED_OR_NOT_APPLICABLE';
}

/** Default checks of G-09@1 when the configuration names none. */
export const DEFAULT_STATUS_CHECKS: readonly StatusCheck[] = [
  { id: 'CALIBRATED', text: 'Calibration valid' },
  { id: 'DAILY_CHECK', text: 'Daily check passed today' },
  { id: 'CLEAN', text: 'Clean and ready' },
];

/** Default checklist of G-10@1 when the configuration names none (paraphrased from outline 5.2 clearance). */
export const DEFAULT_CLEARANCE_CHECKLIST: readonly ClearanceItem[] = [
  { id: 'NO_PREVIOUS_MATERIAL', text: 'No material of the previous product in the area', expected: 'CONFIRMED' },
  { id: 'NO_PREVIOUS_DOCUMENTS', text: 'No documents or labels of the previous batch', expected: 'CONFIRMED' },
  { id: 'EQUIPMENT_CLEAN_LABEL', text: 'Equipment carries a valid CLEAN label', expected: 'CONFIRMED' },
];

const ID_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;
const CHECK_ID: FieldSchema = { type: 'string', pattern: ID_PATTERN, description: 'Check id (upper case, digits and underscores)' };
const NOT_BEFORE_PHASE_3 = 'sandbox only until Phase 3, when equipment, room and cleaning status come from site services';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The checks of a G-09 phase (configured, else the default list). */
export function statusChecks(config: Readonly<Record<string, unknown>>): StatusCheck[] {
  const c = config['checks'];
  if (!Array.isArray(c) || c.length === 0) return [...DEFAULT_STATUS_CHECKS];
  return c.filter(isRecord).map((x) => ({ id: String(x['id']), text: String(x['text']) }));
}

/** The checklist of a G-10 phase (configured, else the default list). */
export function clearanceChecklist(config: Readonly<Record<string, unknown>>): ClearanceItem[] {
  const c = config['checklist'];
  if (!Array.isArray(c) || c.length === 0) return [...DEFAULT_CLEARANCE_CHECKLIST];
  return c.filter(isRecord).map((x) => ({ id: String(x['id']), text: String(x['text']), expected: x['expected'] === 'CONFIRMED_OR_NOT_APPLICABLE' ? 'CONFIRMED_OR_NOT_APPLICABLE' : 'CONFIRMED' }));
}

/** Equipment refs a G-09 phase checks: its STATUS_CHECK equipment (empty: any ref the person names). */
export function checkedEquipment(phase: PhaseNode): string[] {
  return phase.equipment.filter((e) => e.use === 'STATUS_CHECK').map((e) => e.ref);
}

function duplicateIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

/** Answers must name every listed id exactly once and nothing else. */
function answerProblems(code: string, answers: readonly { id: string }[], expected: readonly string[], what: string, controls: string[]): HandlerProblem[] {
  const ids = answers.map((a) => a.id);
  const out: HandlerProblem[] = [];
  const dup = duplicateIds(ids);
  if (dup.length > 0) out.push(problem(code, `${what}: ${dup.join(', ')} answered more than once`, controls));
  const unknown = ids.filter((id) => !expected.includes(id));
  if (unknown.length > 0) out.push(problem(code, `${what}: ${unknown.join(', ')} is not on the list of this step`, controls));
  const missing = expected.filter((id) => !ids.includes(id));
  if (missing.length > 0) out.push(problem(code, `${what}: ${missing.join(', ')} not answered; every item must be answered`, controls));
  return out;
}

function answersOf(entry: Readonly<Record<string, unknown>>): { id: string; answer: string }[] {
  const a = entry['answers'];
  return Array.isArray(a) ? a.filter(isRecord).map((x) => ({ id: String(x['id']), answer: String(x['answer']) })) : [];
}

// ---------------------------------------------------------------------------------------------
// G-09@1 Equipment status (manual attestation)

const G09_CONTROLS = ['PR-23', 'IN-25', 'DI-05'];

function equipmentFailedDraft(view: HandlerView, equipmentRef: string, failed: readonly StatusCheck[]): ExceptionDraft {
  return {
    type: 'EQUIPMENT_STATUS_FAILED',
    title: `${equipmentRef} at ${view.stepKey} failed its status check (${failed.map((c) => c.text).join('; ')}): the step and the steps after it stop until QA decides`,
    controls: ['PR-23', 'IN-25'],
    severity: 'ACTION',
    category: 'DEVIATION_OR_OVERRIDE',
    blocks: 'STEP_AND_DOWNSTREAM',
    until: 'DISPOSITION',
    // QA decides: no impact (for example re-cleaned and checked again) or a deviation raised.
    qaOnly: true,
  };
}

export const G09: BlockVersion = {
  type: 'G-09',
  version: '1',
  title: 'Equipment status (manual attestation)',
  edition: 'generic',
  aliases: { tablets: 'K-09', injectables: 'KB-07' },
  level: 'PHASE',
  availability: 'SANDBOX_ONLY',
  controls: G09_CONTROLS,
  configSchema: {
    type: 'object',
    description: `Checks a person attests for each piece of equipment before use (${NOT_BEFORE_PHASE_3})`,
    fields: {
      checks: {
        type: 'array',
        optional: true,
        minItems: 1,
        maxItems: 20,
        description: 'Checks answered YES or NO per equipment (default: calibration valid, daily check passed today, clean and ready)',
        items: { type: 'object', description: 'One check', fields: { id: CHECK_ID, text: { type: 'string', description: 'Question shown to the person' } } },
      },
    },
  },
  entrySummaries: {
    EQUIPMENT_STATUS: (d, c) => `${S.cap(c.name(d['equipmentRef']))}, status label ${S.val(d['labelId'])}: ${answerTally(d)}${d['passed'] === false ? ', not ready for use' : ''}`,
  },
  dataSchema: {
    entries: {
      EQUIPMENT_STATUS: {
        type: 'object',
        description: 'The status of one piece of equipment as the person found it (label and checks)',
        fields: {
          equipmentRef: { type: 'string', description: 'Stage equipment reference checked' },
          labelId: { type: 'string', description: 'Id of the status label read or scanned on the equipment' },
          answers: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            description: 'YES or NO for every check',
            items: { type: 'object', description: 'One answer', fields: { id: CHECK_ID, answer: { type: 'string', enum: ['YES', 'NO'], description: 'YES or NO' } } },
          },
        },
      },
    },
  },
  checkConfig: (phase, config) => {
    const ids = statusChecks(config).map((c) => c.id);
    const dup = duplicateIds(ids);
    return dup.length > 0 ? [{ code: 'G09-CHECK-IDS', severity: 'ERROR', message: `Equipment status step ${phase.id} lists check ${dup.join(', ')} twice`, controls: ['PR-23'] }] : [];
  },
  handler: {
    acceptEntry: (view, entry) => {
      const ref = String(entry['equipmentRef']);
      const allowed = checkedEquipment(view.phase);
      const problems: HandlerProblem[] = [];
      if (allowed.length > 0 && !allowed.includes(ref)) {
        problems.push(problem('G09-EQUIPMENT', `${ref} is not equipment this step checks (${allowed.join(', ')})`, ['PR-23', 'PR-22']));
      }
      const checks = statusChecks(view.config);
      const answers = answersOf(entry);
      problems.push(...answerProblems('G09-ANSWERS', answers, checks.map((c) => c.id), `Status of ${ref}`, ['PR-23']));
      if (problems.length > 0) return { ok: false, problems };
      const failed = checks.filter((c) => answers.find((a) => a.id === c.id)?.answer === 'NO');
      return {
        ok: true,
        data: { equipmentRef: ref, labelId: entry['labelId'], answers: answers.map((a) => ({ id: a.id, answer: a.answer })), passed: failed.length === 0, attestedBy: view.actor.id },
        ...(failed.length > 0 ? { exceptions: [equipmentFailedDraft(view, ref, failed)] } : {}),
      };
    },
    beforePerform: (view) => {
      const recorded = new Set(view.entries('EQUIPMENT_STATUS').map((e) => String(e.data['equipmentRef'])));
      const needed = checkedEquipment(view.phase);
      const missing = needed.filter((r) => !recorded.has(r));
      if (needed.length === 0 && recorded.size === 0) return [problem('G09-INCOMPLETE', `Record the status of the equipment of ${view.phase.id} first`, ['PR-23'])];
      return missing.length > 0 ? [problem('G09-INCOMPLETE', `Record the status of ${missing.join(', ')} first`, ['PR-23'])] : [];
    },
  },
  exceptionRules: [{ type: 'EQUIPMENT_STATUS_FAILED', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'A person found the equipment not fit for use (a status check answered NO)', controls: ['PR-23', 'IN-25'] }],
  simulatorModel: {
    exceptionTypes: () => ['EQUIPMENT_STATUS_FAILED'],
    nominalEntries: ({ phase, config }) => {
      const refs = checkedEquipment(phase);
      return (refs.length > 0 ? refs : ['EQUIPMENT']).map((ref) => ({
        kind: 'EQUIPMENT_STATUS',
        equipmentRef: ref,
        labelId: `LBL-${ref}`,
        answers: statusChecks(config).map((c) => ({ id: c.id, answer: 'YES' })),
      }));
    },
  },
  goldenFixture: {
    description: 'A balance whose daily check is answered NO raises a blocking exception: the step cannot be signed as performed until QA decides',
    controls: [],
    phase: { block: { type: 'G-09', version: '1' }, config: {}, equipment: [{ ref: 'BAL', use: 'STATUS_CHECK' }] },
    script: [
      {
        entry: {
          kind: 'EQUIPMENT_STATUS',
          equipmentRef: 'BAL',
          labelId: 'LBL-BAL-07',
          answers: [
            { id: 'CALIBRATED', answer: 'YES' },
            { id: 'DAILY_CHECK', answer: 'NO' },
            { id: 'CLEAN', answer: 'YES' },
          ],
        },
      },
    ],
    expect: { exceptions: ['EQUIPMENT_STATUS_FAILED'], status: 'IN_PROGRESS', performRefusal: 'ENG-BLOCKED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts', 'packages/recipe-core/test/blocks/status.test.ts'],
};

// ---------------------------------------------------------------------------------------------
// G-10@1 Clearance checklist

const G10_CONTROLS = ['PR-26', 'PR-34', 'IN-21', 'DI-05'];

function clearanceFailedDraft(view: HandlerView, failed: readonly ClearanceItem[]): ExceptionDraft {
  return {
    type: 'CLEARANCE_FAILED',
    title: `Clearance at ${view.stepKey} was not confirmed (${failed.map((c) => c.text).join('; ')}): the step and the steps after it stop until QA decides`,
    controls: ['PR-26', 'PR-34', 'IN-21'],
    severity: 'ACTION',
    category: 'DEVIATION_OR_OVERRIDE',
    blocks: 'STEP_AND_DOWNSTREAM',
    until: 'DISPOSITION',
    // QA decides: no impact (for example re-cleaned and checked again) or a deviation raised.
    qaOnly: true,
  };
}

export const G10: BlockVersion = {
  type: 'G-10',
  version: '1',
  title: 'Clearance checklist',
  edition: 'generic',
  aliases: { tablets: 'K-10', injectables: 'KB-08' },
  level: 'PHASE',
  availability: 'SANDBOX_ONLY',
  controls: G10_CONTROLS,
  configSchema: {
    type: 'object',
    description: `Room or line clearance against a checklist, with the previous product and batch (${NOT_BEFORE_PHASE_3})`,
    fields: {
      checklist: {
        type: 'array',
        optional: true,
        minItems: 1,
        maxItems: 40,
        description: 'Checklist items (default: no previous material, no previous documents or labels, equipment labelled CLEAN)',
        items: {
          type: 'object',
          description: 'One checklist item',
          fields: {
            id: CHECK_ID,
            text: { type: 'string', description: 'Item shown to the person' },
            expected: { type: 'string', enum: ['CONFIRMED', 'CONFIRMED_OR_NOT_APPLICABLE'], description: 'Answer expected (NOT_APPLICABLE allowed only where stated)' },
          },
        },
      },
    },
  },
  entrySummaries: {
    CLEARANCE_CHECK: (d) => `Clearance checklist: ${answerTally(d)}${d['passed'] === false ? ', not cleared' : ''}`,
    PREVIOUS_BATCH: (d) => `Previous batch: ${S.val(d['product'])} ${S.val(d['batchNumber'])}`,
  },
  dataSchema: {
    entries: {
      CLEARANCE_CHECK: {
        type: 'object',
        description: 'The checklist as the person found the area',
        fields: {
          answers: {
            type: 'array',
            minItems: 1,
            maxItems: 40,
            description: 'CONFIRMED, NOT_CONFIRMED or NOT_APPLICABLE for every item',
            items: {
              type: 'object',
              description: 'One answer',
              fields: { id: CHECK_ID, answer: { type: 'string', enum: ['CONFIRMED', 'NOT_CONFIRMED', 'NOT_APPLICABLE'], description: 'Answer' } },
            },
          },
        },
      },
      PREVIOUS_BATCH: {
        type: 'object',
        description: 'The product and batch last processed in the area (IN-21)',
        fields: {
          product: { type: 'string', description: 'Previous product (as on its batch record)' },
          batchNumber: { type: 'string', description: 'Previous batch number' },
        },
      },
    },
  },
  checkConfig: (phase, config) => {
    const ids = clearanceChecklist(config).map((c) => c.id);
    const dup = duplicateIds(ids);
    const out = dup.length > 0 ? [{ code: 'G10-CHECK-IDS', severity: 'ERROR' as const, message: `Clearance step ${phase.id} lists item ${dup.join(', ')} twice`, controls: ['PR-34'] }] : [];
    if (!phase.signatures.check) {
      out.push({ code: 'G10-NO-CHECKER', severity: 'ERROR', message: `Clearance step ${phase.id} names no checker: a clearance is a significant step with an independent checker`, controls: ['PR-14', 'PR-34'] });
    }
    return out;
  },
  handler: {
    acceptEntry: (view, entry) => {
      if (entry.kind === 'PREVIOUS_BATCH') {
        return { ok: true, data: { product: entry['product'], batchNumber: entry['batchNumber'], recordedBy: view.actor.id } };
      }
      const list = clearanceChecklist(view.config);
      const answers = answersOf(entry);
      const problems = answerProblems('G10-ANSWERS', answers, list.map((c) => c.id), 'Clearance checklist', ['PR-34', 'IN-21']);
      for (const a of answers) {
        const item = list.find((c) => c.id === a.id);
        if (item && a.answer === 'NOT_APPLICABLE' && item.expected !== 'CONFIRMED_OR_NOT_APPLICABLE') {
          problems.push(problem('G10-NOT-APPLICABLE', `"${item.text}" cannot be answered not applicable: it must be confirmed`, ['PR-34', 'IN-21']));
        }
      }
      if (problems.length > 0) return { ok: false, problems };
      const failed = list.filter((c) => answers.find((a) => a.id === c.id)?.answer === 'NOT_CONFIRMED');
      return {
        ok: true,
        data: { answers: answers.map((a) => ({ id: a.id, answer: a.answer })), passed: failed.length === 0, checkedBy: view.actor.id },
        verificationRequired: true,
        ...(failed.length > 0 ? { exceptions: [clearanceFailedDraft(view, failed)] } : {}),
      };
    },
    beforePerform: (view) => {
      const missing: string[] = [];
      if (view.entries('CLEARANCE_CHECK').length === 0) missing.push('the checklist');
      if (view.entries('PREVIOUS_BATCH').length === 0) missing.push('the previous batch');
      return missing.length > 0 ? [problem('G10-INCOMPLETE', `Record ${missing.join(' and ')} first`, ['PR-34', 'IN-21'])] : [];
    },
    meanings: { perform: ['LINE_CLEARANCE_PERFORMED'], check: ['LINE_CLEARANCE_VERIFIED'] },
  },
  exceptionRules: [{ type: 'CLEARANCE_FAILED', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', summary: 'A clearance item was not confirmed', controls: ['PR-26', 'PR-34', 'IN-21'] }],
  simulatorModel: {
    exceptionTypes: () => ['CLEARANCE_FAILED'],
    nominalEntries: ({ config }) => [
      { kind: 'CLEARANCE_CHECK', answers: clearanceChecklist(config).map((c) => ({ id: c.id, answer: 'CONFIRMED' })) },
      { kind: 'PREVIOUS_BATCH', product: 'NONE', batchNumber: 'NONE' },
    ],
  },
  goldenFixture: {
    description: 'Every item of the default checklist is confirmed and the previous batch recorded; performed and independently verified, the clearance completes',
    controls: [],
    phase: { block: { type: 'G-10', version: '1' }, config: {}, significant: true },
    script: [
      {
        entry: {
          kind: 'CLEARANCE_CHECK',
          answers: [
            { id: 'NO_PREVIOUS_MATERIAL', answer: 'CONFIRMED' },
            { id: 'NO_PREVIOUS_DOCUMENTS', answer: 'CONFIRMED' },
            { id: 'EQUIPMENT_CLEAN_LABEL', answer: 'CONFIRMED' },
          ],
        },
      },
      { entry: { kind: 'PREVIOUS_BATCH', product: 'Ibuprofen 400 mg tablets', batchNumber: 'TEST-B26-0099' } },
    ],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts', 'packages/recipe-core/test/blocks/status.test.ts'],
};

// ---------------------------------------------------------------------------------------------
// Version 2 (Phase 3 slice 3a): database-backed. The status comes from the plant schema of slice 1 (recipe-core 0400 to
// 0405), never from a person's word: the unit's use for the batch is started there (plant.start_equipment_use runs the
// fitness, cleanliness, calibration and campaign guards: INV-12, IN-25, PR-23) and the room or line is cleared, verified
// by a second person and occupied for the batch there (plant.record_clearance, verify_clearance, start_area_occupancy:
// IN-21, PR-34, INV-15). The entry names the plant record; the database binds it (recipe-core 0521: the use or the
// occupancy is open, of this batch and of the unit or area the entry names, started by the entry's person). Both run
// in GMP and the sandbox; version 1 stays SANDBOX_ONLY.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLANT_CODE: FieldSchema = { type: 'string', pattern: /^[A-Z0-9][A-Z0-9_-]{0,63}$/, description: 'Plant code of the unit, room or line (site services)' };

export const G09V2: BlockVersion = {
  type: 'G-09',
  version: '2',
  title: 'Equipment status and use (site services)',
  edition: 'generic',
  aliases: { tablets: 'K-09', injectables: 'KB-07' },
  level: 'PHASE',
  controls: ['PR-23', 'IN-25', 'INV-12', 'DI-05'],
  configSchema: { type: 'object', description: 'The units are the phase STATUS_CHECK equipment; their status is read from site services when the use starts', fields: {} },
  entrySummaries: {
    EQUIPMENT_USE: (d, c) => `Equipment ${S.val(d['equipmentCode'])} (${c.name(d['equipmentRef'])}) in use for the batch`,
  },
  dataSchema: {
    entries: {
      EQUIPMENT_USE: {
        type: 'object',
        description: 'The use of a unit for this batch, started in site services after its status guards passed',
        fields: {
          equipmentRef: { type: 'string', description: 'Stage equipment reference the unit stands for' },
          equipmentCode: PLANT_CODE,
          useId: { type: 'string', pattern: UUID_PATTERN, description: 'The open equipment use (plant.equipment_use)' },
        },
      },
    },
  },
  handler: {
    acceptEntry: (view, entry) => {
      const ref = String(entry['equipmentRef']);
      const allowed = checkedEquipment(view.phase);
      if (allowed.length > 0 && !allowed.includes(ref)) {
        return { ok: false, problems: [problem('G09-EQUIPMENT', `${ref} is not equipment this step checks (${allowed.join(', ')})`, ['PR-23', 'PR-22'])] };
      }
      if (view.entries('EQUIPMENT_USE').some((e) => e.data['equipmentRef'] === ref)) {
        return { ok: false, problems: [problem('G09-TWICE', `The unit for ${ref} is already recorded at ${view.stepKey}`, ['PR-23'])] };
      }
      return { ok: true, data: { equipmentRef: ref, equipmentCode: entry['equipmentCode'], useId: entry['useId'], recordedBy: view.actor.id } };
    },
    beforePerform: (view) => {
      const recorded = new Set(view.entries('EQUIPMENT_USE').map((e) => String(e.data['equipmentRef'])));
      const needed = checkedEquipment(view.phase);
      if (needed.length === 0 && recorded.size === 0) return [problem('G09-INCOMPLETE', `Start the use of the equipment of ${view.phase.id} first`, ['PR-23'])];
      const missing = needed.filter((r) => !recorded.has(r));
      return missing.length > 0 ? [problem('G09-INCOMPLETE', `Start the use of ${missing.join(', ')} first`, ['PR-23'])] : [];
    },
  },
  exceptionRules: [],
  simulatorModel: {
    exceptionTypes: () => [],
    nominalEntries: ({ phase }) => {
      const refs = checkedEquipment(phase);
      return (refs.length > 0 ? refs : ['EQUIPMENT']).map((ref, i) => ({
        kind: 'EQUIPMENT_USE',
        equipmentRef: ref,
        equipmentCode: `TEST-${ref.replace(/[^A-Z0-9_-]/g, '')}`.slice(0, 64),
        useId: `00000000-0000-4000-9000-${(i + 1).toString(16).padStart(12, '0')}`,
      }));
    },
  },
  goldenFixture: {
    description: 'The press whose use for the batch site services started (status guards passed) is recorded; the step completes',
    controls: ['PR-23'],
    phase: { block: { type: 'G-09', version: '2' }, config: {}, equipment: [{ ref: 'BAL', use: 'STATUS_CHECK' }] },
    script: [{ entry: { kind: 'EQUIPMENT_USE', equipmentRef: 'BAL', equipmentCode: 'TEST-PRESS-01', useId: '00000000-0000-4000-9000-000000000001' } }],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts', 'packages/recipe-core/test/plant/status-blocks.test.ts'],
};

export const G10V2: BlockVersion = {
  type: 'G-10',
  version: '2',
  title: 'Room/line status and clearance (site services)',
  edition: 'generic',
  aliases: { tablets: 'K-10', injectables: 'KB-08' },
  level: 'PHASE',
  controls: ['PR-26', 'PR-34', 'IN-21', 'INV-15', 'DI-05'],
  configSchema: { type: 'object', description: 'The clearance is performed, verified by a second person and the area occupied for the batch in site services', fields: {} },
  entrySummaries: {
    AREA_OCCUPANCY: (d) => `Area ${S.val(d['areaCode'])} occupied by the batch`,
  },
  dataSchema: {
    entries: {
      AREA_OCCUPANCY: {
        type: 'object',
        description: 'The occupancy of the room or line by this batch, started in site services on a passed and verified clearance',
        fields: {
          areaCode: PLANT_CODE,
          occupancyId: { type: 'string', pattern: UUID_PATTERN, description: 'The open area occupancy (plant.area_occupancy)' },
        },
      },
    },
  },
  checkConfig: (phase) =>
    phase.signatures.check
      ? []
      : [{ code: 'G10-NO-CHECKER', severity: 'ERROR', message: `Clearance step ${phase.id} names no checker: a clearance is a significant step with an independent checker`, controls: ['PR-14', 'PR-34'] }],
  handler: {
    acceptEntry: (view, entry) => {
      if (view.entries('AREA_OCCUPANCY').length > 0) return { ok: false, problems: [problem('G10-TWICE', `The area of ${view.stepKey} is already recorded`, ['PR-34'])] };
      return { ok: true, data: { areaCode: entry['areaCode'], occupancyId: entry['occupancyId'], recordedBy: view.actor.id } };
    },
    beforePerform: (view) => (view.entries('AREA_OCCUPANCY').length === 0 ? [problem('G10-INCOMPLETE', 'Record the cleared room or line the batch occupies first', ['PR-34', 'IN-21'])] : []),
    meanings: { perform: ['LINE_CLEARANCE_PERFORMED'], check: ['LINE_CLEARANCE_VERIFIED'] },
  },
  exceptionRules: [],
  simulatorModel: {
    exceptionTypes: () => [],
    nominalEntries: () => [{ kind: 'AREA_OCCUPANCY', areaCode: 'TEST-ROOM', occupancyId: '00000000-0000-4000-9000-000000000101' }],
  },
  goldenFixture: {
    description: 'The compression room, cleared, verified and occupied for the batch in site services, is recorded; performed and verified, the step completes',
    controls: ['PR-34'],
    phase: { block: { type: 'G-10', version: '2' }, config: {}, significant: true },
    script: [{ entry: { kind: 'AREA_OCCUPANCY', areaCode: 'TEST-COMP-1', occupancyId: '00000000-0000-4000-9000-000000000101' } }],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts', 'packages/recipe-core/test/plant/status-blocks.test.ts'],
};

export const STATUS_BLOCKS: readonly BlockVersion[] = [G09, G10, G09V2, G10V2];

/** The answers of a checklist entry counted by answer: "12 confirmed, 1 not applicable". */
function answerTally(d: Readonly<Record<string, unknown>>): string {
  const tally = new Map<string, number>();
  for (const a of S.list(d['answers'])) {
    const answer = S.words(S.rec(a)['answer']);
    tally.set(answer, (tally.get(answer) ?? 0) + 1);
  }
  return tally.size === 0 ? 'no answers' : [...tally].map(([k, n]) => `${String(n)} ${k}`).join(', ');
}
