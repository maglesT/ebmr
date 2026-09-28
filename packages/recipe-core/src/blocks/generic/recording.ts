/**
 * Generic value-recording blocks, version 1 (outline 6.6; tablets spec K-03, K-04, K-05, K-11, K-13,
 * K-14, S-3, K-18): G-03 instruction and acknowledgement, G-04 process parameter record, G-05
 * observation capture, G-11 environmental condition check, G-13 IPC with readings and statistics,
 * G-14 calculation, G-16 verification/witness, G-20 yield and reconciliation.
 *
 * The engine core does what every phase shares (typed values, limit tiers, derived values, repeats,
 * signatures, segregation); these handlers add each block's own rules.
 */
import type { PhaseNode } from '../../flow/model.ts';
import type { BlockVersion, ExceptionDraft, SimulatorModel } from '../contract.ts';
import { configRecord, CORE_VALUE_RULES, expectedAnswer, isUnexpected, problem, SKIPPABLE } from './common.ts';

const NO_ENTRIES = { entries: {} };
const noEntryModel = (types: (phase: PhaseNode) => string[]): SimulatorModel => ({ exceptionTypes: types, nominalEntries: () => [] });

// ---------------------------------------------------------------------------------------------
// G-03 Instruction and acknowledgement

export const G03: BlockVersion = {
  type: 'G-03',
  version: '1',
  title: 'Instruction and acknowledgement',
  edition: 'generic',
  aliases: { tablets: 'K-03', injectables: 'KB-02' },
  level: 'PHASE',
  controls: ['PR-03', 'DI-10', 'IN-27'],
  configSchema: {
    type: 'object',
    description: 'Instruction shown from the approved MBR text; acknowledgement type; the SOP it follows',
    fields: {
      text: { type: 'string', optional: true, description: 'Instruction text (from the approved master only)' },
      acknowledgement: { type: 'string', enum: ['READ', 'CONFIRM_PERFORMED'], optional: true, description: 'Read, or confirm performed (default READ)' },
      sop: { type: 'string', optional: true, description: 'Reference id (kind SOP) of the procedure; its version in force is written into the record' },
      skippable: SKIPPABLE,
    },
  },
  dataSchema: {
    entries: {
      ACKNOWLEDGE: {
        type: 'object',
        description: 'Acknowledgement by the person performing the step',
        fields: {
          mode: { type: 'string', enum: ['READ', 'CONFIRM_PERFORMED'], description: 'What the person confirms' },
          sopVersion: { type: 'string', optional: true, description: 'SOP version displayed to the person' },
        },
      },
    },
  },
  checkConfig: (phase, config, mbr) => {
    const sop = config['sop'];
    if (typeof sop === 'string' && !mbr.references.some((r) => r.id === sop && r.kind === 'SOP')) {
      return [{ code: 'G03-SOP-REF', severity: 'ERROR', message: `Instruction ${phase.id} names SOP ${sop}, which is not an SOP reference of this MBR`, controls: ['DI-10', 'PR-03'] }];
    }
    return [];
  },
  handler: {
    acceptEntry: (view, entry) => {
      const mode = (view.config['acknowledgement'] as string | undefined) ?? 'READ';
      if (entry['mode'] !== mode) return { ok: false, problems: [problem('G03-ACK-MODE', `This instruction needs a "${mode === 'READ' ? 'read' : 'confirm performed'}" acknowledgement`, ['PR-03'])] };
      const sop = view.config['sop'];
      const ref = typeof sop === 'string' ? view.mbr.references.find((r) => r.id === sop) : undefined;
      if (ref && entry['sopVersion'] !== undefined && entry['sopVersion'] !== ref.version) {
        return { ok: false, problems: [problem('G03-SOP-VERSION', `The SOP shown (version ${JSON.stringify(entry['sopVersion'])}) is not the version pinned by the MBR (${ref.version})`, ['DI-10'])] };
      }
      return { ok: true, data: { mode, acknowledgedBy: view.actor.id, ...(ref ? { sop: ref.code, sopVersion: ref.version, sopHash: ref.hash ?? null } : {}) } };
    },
    beforePerform: (view) =>
      view.entries('ACKNOWLEDGE').length === 0 ? [problem('G03-NOT-ACKNOWLEDGED', `The instruction of ${view.phase.id} has not been acknowledged`, ['PR-03', 'DI-10'])] : [],
  },
  exceptionRules: [],
  simulatorModel: { exceptionTypes: () => [], nominalEntries: ({ config }) => [{ kind: 'ACKNOWLEDGE', mode: (config['acknowledgement']) ?? 'READ' }] },
  goldenFixture: {
    description: 'An instruction is acknowledged and signed; without the acknowledgement the PERFORMED signature is refused',
    controls: [],
    phase: { block: { type: 'G-03', version: '1' }, config: { acknowledgement: 'CONFIRM_PERFORMED' } },
    script: [{ entry: { kind: 'ACKNOWLEDGE', mode: 'CONFIRM_PERFORMED' } }],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts'],
};

// ---------------------------------------------------------------------------------------------
// G-04 Process parameter record

export const G04: BlockVersion = {
  type: 'G-04',
  version: '1',
  title: 'Process parameter record',
  edition: 'generic',
  aliases: { tablets: 'K-04', injectables: 'KB-02' },
  level: 'PHASE',
  controls: ['PR-08', 'IN-13', 'DI-07', 'DI-30'],
  configSchema: { type: 'object', description: 'Parameters, units and limit tiers come from the MBR parameter list', fields: { skippable: SKIPPABLE } },
  dataSchema: NO_ENTRIES,
  handler: {},
  exceptionRules: [...CORE_VALUE_RULES],
  simulatorModel: noEntryModel(() => ['LIMIT_BREACH']),
  goldenFixture: {
    description: 'A temperature outside its validated range: stored as acquired, a registration-relevant deviation is required and the step cannot complete until it is linked',
    phase: { block: { type: 'G-04', version: '1' }, config: {}, records: ['temp'] },
    parameters: [
      {
        id: 'temp',
        name: 'Binder temperature',
        valueType: 'DECIMAL',
        unit: 'Cel',
        precision: { kind: 'DECIMALS', digits: 1 },
        role: 'PROCESS_PARAMETER',
        criticality: 'CRITICAL',
        riskClass: 'HIGH',
        capture: 'DEVICE',
        limits: { unit: 'Cel', ranges: [{ tier: 'VALIDATED', low: { value: '20.0', inclusive: true }, high: { value: '30.0', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] },
      },
    ],
    script: [{ record: 'temp', value: { kind: 'DECIMAL', value: '30.2', unit: 'Cel' } }],
    expect: { exceptions: ['LIMIT_BREACH'], status: 'IN_PROGRESS', performRefusal: 'ENG-BLOCKED', values: { temp: '30.2' } },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts'],
};

// ---------------------------------------------------------------------------------------------
// G-05 Observation capture

const UNEXPECTED_RULE = { type: 'UNEXPECTED_OBSERVATION', category: 'OUT_OF_LIMIT' as const, severity: 'ACTION' as const, summary: 'An answer other than the expected one', controls: ['PR-11', 'DI-26'] };

function unexpectedDraft(item: string, value: string, expected: string, block: boolean): ExceptionDraft {
  return {
    type: 'UNEXPECTED_OBSERVATION',
    title: `${item} was answered ${value} where ${expected} is expected${block ? '; the steps after it wait for a deviation' : ''}`,
    controls: ['PR-11', 'DI-26'],
    severity: 'ACTION',
    category: 'OUT_OF_LIMIT',
    item,
    blocks: block ? 'DOWNSTREAM' : 'NONE',
    until: 'DEVIATION',
    deviationRequired: block,
  };
}

export const G05: BlockVersion = {
  type: 'G-05',
  version: '1',
  title: 'Observation capture',
  edition: 'generic',
  aliases: { tablets: 'K-05', injectables: 'KB-02' },
  level: 'PHASE',
  controls: ['PR-11', 'DI-28', 'DI-41'],
  configSchema: {
    type: 'object',
    description: 'Expected answers of categorical checks, and whether an unexpected answer stops the steps after it',
    fields: {
      expected: { type: 'record', optional: true, description: 'Expected answer per item (default PASS/CONFIRMED/YES when offered)', values: { type: 'string', description: 'Expected category (or true/false)' } },
      blockOnUnexpected: { type: 'boolean', optional: true, description: 'An unexpected answer stops the steps after it until a deviation is linked (default true)' },
      skippable: SKIPPABLE,
    },
  },
  dataSchema: {
    entries: {
      ATTACHMENT: {
        type: 'object',
        description: 'Attached evidence (printout, photo); immutable, identified by its hash',
        fields: {
          sha256: { type: 'string', pattern: /^[0-9a-f]{64}$/, description: 'SHA-256 of the file' },
          mediaType: { type: 'string', description: 'Media type' },
          description: { type: 'string', description: 'What it shows' },
          paperOriginal: { type: 'boolean', optional: true, description: 'A scan of a paper original: a true copy that a second person verifies (DI-41)' },
        },
      },
    },
  },
  handler: {
    onValue: (view, item, value) => {
      const expected = expectedAnswer(view.parameter(item), configRecord(view.config, 'expected')[item]);
      if (!isUnexpected(expected, value)) return {};
      const block = view.config['blockOnUnexpected'] !== false;
      return { failed: true, exceptions: [unexpectedDraft(item, value.kind === 'CATEGORY' || value.kind === 'BOOLEAN' ? String(value.value) : '?', String(expected), block)] };
    },
    acceptEntry: (view, entry) => ({ ok: true, data: { sha256: entry['sha256'], mediaType: entry['mediaType'], description: entry['description'], paperOriginal: entry['paperOriginal'] === true, attachedBy: view.actor.id }, verificationRequired: entry['paperOriginal'] === true }),
  },
  exceptionRules: [UNEXPECTED_RULE, ...CORE_VALUE_RULES],
  simulatorModel: noEntryModel(() => ['UNEXPECTED_OBSERVATION']),
  goldenFixture: {
    description: 'A line check answered NOT_CONFIRMED raises an exception that stops the steps after it',
    controls: [],
    phase: { block: { type: 'G-05', version: '1' }, config: {}, records: ['check'] },
    parameters: [{ id: 'check', name: 'No remnants', valueType: 'CATEGORY', categories: ['CONFIRMED', 'NOT_CONFIRMED'], role: 'OBSERVATION', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'SCAN' }],
    script: [{ record: 'check', value: { kind: 'CATEGORY', value: 'NOT_CONFIRMED' } }],
    expect: { exceptions: ['UNEXPECTED_OBSERVATION'], status: 'COMPLETED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts'],
};

// ---------------------------------------------------------------------------------------------
// G-11 Environmental condition check

export const G11: BlockVersion = {
  type: 'G-11',
  version: '1',
  title: 'Environmental condition check',
  edition: 'generic',
  aliases: { tablets: 'K-11', injectables: 'IB-02/IB-05' },
  level: 'PHASE',
  controls: ['PR-25', 'IN-39', 'DI-49'],
  configSchema: {
    type: 'object',
    description: 'Room conditions (temperature, humidity, pressure difference) against room and product limits',
    fields: {
      onExcursion: { type: 'string', enum: ['BLOCK', 'EXCEPTION'], optional: true, description: 'An excursion stops the step and the steps after it (default), or is an exception only' },
      notify: { type: 'array', optional: true, items: { type: 'string', description: 'Role' }, description: 'Roles notified at once of an excursion (default production supervisor and QA)' },
      skippable: SKIPPABLE,
    },
  },
  dataSchema: NO_ENTRIES,
  handler: {
    onValue: (view, item, _value, point) => {
      if (point.evaluation?.breached === undefined) return {};
      const roles = Array.isArray(view.config['notify']) ? (view.config['notify'] as string[]) : ['PRODUCTION_SUPERVISOR', 'QA'];
      const block = view.config['onExcursion'] !== 'EXCEPTION';
      return {
        exceptions: [
          {
            type: 'ENVIRONMENT_EXCURSION',
            title: `Room condition ${item} is outside its ${point.evaluation.breached.toLowerCase()} limit at ${view.stepKey}; production and QA are notified and a deviation is linked to the batch`,
            controls: ['PR-25', 'IN-39'],
            severity: 'ACTION',
            category: 'OUT_OF_LIMIT',
            item,
            blocks: block ? 'STEP_AND_DOWNSTREAM' : 'NONE',
            until: 'DEVIATION',
            deviationRequired: true,
          },
        ],
        notifications: [{ roles, message: `Environmental excursion: ${item} at ${view.stepKey}` }],
      };
    },
  },
  exceptionRules: [{ type: 'ENVIRONMENT_EXCURSION', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A room condition outside its limits: notification and deviation', controls: ['PR-25', 'IN-39'] }, ...CORE_VALUE_RULES],
  simulatorModel: noEntryModel(() => ['ENVIRONMENT_EXCURSION', 'LIMIT_BREACH']),
  goldenFixture: {
    description: 'Relative humidity above the alert limit: register item plus an excursion that notifies production and QA',
    phase: { block: { type: 'G-11', version: '1' }, config: { onExcursion: 'EXCEPTION' }, records: ['rh'] },
    parameters: [
      {
        id: 'rh',
        name: 'Relative humidity',
        valueType: 'DECIMAL',
        unit: '%',
        precision: { kind: 'DECIMALS', digits: 0 },
        role: 'PROCESS_PARAMETER',
        criticality: 'CRITICAL',
        riskClass: 'MEDIUM',
        capture: 'DEVICE',
        limits: { unit: '%', ranges: [{ tier: 'INTERNAL_ACTION', high: { value: '60', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }, { tier: 'ALERT', high: { value: '55', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] },
      },
    ],
    script: [{ record: 'rh', value: { kind: 'DECIMAL', value: '57', unit: '%' } }],
    expect: { exceptions: ['ENVIRONMENT_EXCURSION', 'LIMIT_BREACH'], status: 'COMPLETED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts'],
};

// ---------------------------------------------------------------------------------------------
// G-13 IPC with readings and statistics

export const G13: BlockVersion = {
  type: 'G-13',
  version: '1',
  title: 'IPC with readings and statistics',
  edition: 'generic',
  aliases: { tablets: 'K-13', injectables: 'KB-09' },
  level: 'PHASE',
  controls: ['PR-29', 'IN-35', 'DI-29', 'DI-10'],
  configSchema: {
    type: 'object',
    description: 'IPC test: readings per sample come from the parameter; statistics are calculations; acceptance may be an ALL_APPLY scheme',
    fields: {
      method: { type: 'string', optional: true, description: 'Method and version reference' },
      sampleMassGrams: { type: 'decimal', optional: true, description: 'Sample mass for the test (g)' },
      expected: { type: 'record', optional: true, description: 'Expected result per categorical item (default PASS)', values: { type: 'string', description: 'Expected category' } },
      skippable: SKIPPABLE,
    },
  },
  dataSchema: NO_ENTRIES,
  handler: {
    onValue: (view, item, value) => {
      const expected = expectedAnswer(view.parameter(item), configRecord(view.config, 'expected')[item]);
      if (!isUnexpected(expected, value)) return {};
      return {
        failed: true,
        exceptions: [
          {
            type: 'IPC_RESULT_FAILED',
            title: `IPC ${item} at ${view.stepKey} gave ${value.kind === 'CATEGORY' || value.kind === 'BOOLEAN' ? String(value.value) : '?'}; the step and the steps after it wait for a deviation, and a re-test never replaces this result`,
            controls: ['PR-29', 'IN-20', 'DI-29'],
            severity: 'ACTION',
            category: 'OUT_OF_LIMIT',
            item,
            blocks: 'STEP_AND_DOWNSTREAM',
            until: 'DEVIATION',
            deviationRequired: true,
            releaseBlocking: true,
          },
        ],
      };
    },
    meanings: { perform: ['IPC_PERFORMED'], check: ['IPC_VERIFIED'] },
  },
  exceptionRules: [
    { type: 'IPC_RESULT_FAILED', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A categorical IPC result is not the expected one', controls: ['PR-29', 'IN-20'] },
    { type: 'ACCEPTANCE_CRITERION_FAILED', category: 'OUT_OF_LIMIT', severity: 'CRITICAL', summary: 'An ALL_APPLY criterion failed', controls: ['PR-08', 'IN-34'] },
    ...CORE_VALUE_RULES,
  ],
  simulatorModel: noEntryModel(() => ['IPC_RESULT_FAILED', 'LIMIT_BREACH', 'ACCEPTANCE_CRITERION_FAILED', 'REPEAT_AFTER_FAIL']),
  goldenFixture: {
    description: 'Twenty tablet weights with their mean and RSD computed, all readings kept',
    phase: { block: { type: 'G-13', version: '1' }, config: {}, records: ['w'], computes: ['mw', 'rw'], signatures: { perform: { role: 'OPERATOR' }, check: { meaning: 'VERIFIED', role: 'VERIFIER' } } },
    parameters: [
      {
        id: 'w',
        name: 'Tablet weight',
        valueType: 'DECIMAL',
        unit: 'mg',
        precision: { kind: 'DECIMALS', digits: 1 },
        readings: 5,
        role: 'IPC',
        criticality: 'CRITICAL',
        riskClass: 'HIGH',
        capture: 'DEVICE',
        limits: { unit: 'mg', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: '237.5', inclusive: true }, high: { value: '262.5', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] },
      },
    ],
    calculations: [
      { id: 'mw', name: 'Mean weight', expression: 'mean(w)', output: { valueType: 'DECIMAL', unit: 'mg' }, criticality: 'CRITICAL', riskClass: 'HIGH' },
      { id: 'rw', name: 'RSD', expression: 'rsd(w)', output: { valueType: 'DECIMAL', unit: '%', semanticTag: 'rsd' }, criticality: 'CRITICAL', riskClass: 'HIGH' },
    ],
    script: [{ record: 'w', value: { kind: 'SERIES', values: ['249.8', '251.2', '250.4', '248.9', '252.0'], unit: 'mg' } }],
    expect: { exceptions: [], status: 'COMPLETED', values: { mw: '250.46' } },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts'],
};

// ---------------------------------------------------------------------------------------------
// G-14 Calculation

export const G14: BlockVersion = {
  type: 'G-14',
  version: '1',
  title: 'Calculation',
  edition: 'generic',
  aliases: { tablets: 'K-14', injectables: 'KB-04' },
  level: 'PHASE',
  controls: ['PR-31', 'DI-33', 'INV-25'],
  configSchema: { type: 'object', description: 'Calculations come from the MBR; the formula is shown to the operator', fields: { showFormula: { type: 'boolean', optional: true, description: 'Show the formula (default true)' } } },
  dataSchema: NO_ENTRIES,
  checkConfig: (phase) => (phase.computes.length === 0 ? [{ code: 'G14-NO-CALCULATION', severity: 'ERROR', message: `Calculation step ${phase.id} computes nothing`, controls: ['DI-33'] }] : []),
  handler: {},
  exceptionRules: [
    { type: 'CALCULATION_FAILED', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'Missing input, division by zero or domain error: never a silent zero', controls: ['DI-33'] },
    { type: 'LIMIT_BREACH', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A calculated value outside its limits', controls: ['PR-08'] },
  ],
  simulatorModel: noEntryModel(() => ['CALCULATION_FAILED']),
  goldenFixture: {
    description: 'Potency-adjusted quantity from the tablets worked example (C-06): computed with an evaluation record, never typed',
    controls: ['DI-33', 'INV-25'],
    phase: { block: { type: 'G-14', version: '1' }, config: {}, records: ['assay', 'water'], computes: ['asis', 'adj'] },
    // Base quantity: the salt-corrected label-claim quantity of C-06 at full precision (8.2727 kg).
    inputs: [{ id: 'base', valueType: 'DECIMAL', unit: 'kg', value: '8.272662179578977516826578834311904' }, { id: 'factor', valueType: 'DECIMAL', unit: '1', value: '1' }],
    parameters: [
      { id: 'assay', name: 'Assay (anhydrous)', valueType: 'DECIMAL', unit: '%', semanticTag: 'w/w', precision: { kind: 'DECIMALS', digits: 1 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'LIMS' },
      { id: 'water', name: 'Water', valueType: 'DECIMAL', unit: '%', semanticTag: 'w/w', precision: { kind: 'DECIMALS', digits: 1 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'LIMS' },
    ],
    calculations: [
      { id: 'asis', name: 'As-is assay', expression: 'assay_as_is_anhydrous(assay, water)', output: { valueType: 'DECIMAL', unit: '%', semanticTag: 'w/w' }, criticality: 'CRITICAL', riskClass: 'HIGH' },
      { id: 'adj', name: 'Adjusted quantity', expression: 'potency_adjusted_quantity(base, factor, 0 [%], asis)', output: { valueType: 'DECIMAL', unit: 'kg' }, criticality: 'CRITICAL', riskClass: 'HIGH' },
    ],
    script: [
      { record: 'assay', value: { kind: 'DECIMAL', value: '99.2', unit: '%' } },
      { record: 'water', value: { kind: 'DECIMAL', value: '4.6', unit: '%' } },
    ],
    expect: { exceptions: [], status: 'COMPLETED', values: { asis: '94.6368', adj: '8.741486' } },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts'],
};

// ---------------------------------------------------------------------------------------------
// G-16 Verification / witness (a standalone check step)

export const G16: BlockVersion = {
  type: 'G-16',
  version: '1',
  title: 'Verification / witness',
  edition: 'generic',
  aliases: { tablets: 'S-3', injectables: 'KB-11' },
  level: 'PHASE',
  controls: ['PR-14', 'PR-20', 'PR-21', 'DI-30', 'INV-03'],
  configSchema: {
    type: 'object',
    description: 'A standalone independent check with its expected answers',
    fields: {
      expected: { type: 'record', optional: true, description: 'Expected answer per item (default CONFIRMED/PASS)', values: { type: 'string', description: 'Expected category' } },
      skippable: SKIPPABLE,
    },
  },
  dataSchema: NO_ENTRIES,
  handler: {
    onValue: (view, item, value) => {
      const expected = expectedAnswer(view.parameter(item), configRecord(view.config, 'expected')[item]);
      if (!isUnexpected(expected, value)) return {};
      return { failed: true, exceptions: [unexpectedDraft(item, value.kind === 'CATEGORY' || value.kind === 'BOOLEAN' ? String(value.value) : '?', String(expected), true)] };
    },
  },
  exceptionRules: [UNEXPECTED_RULE, ...CORE_VALUE_RULES],
  simulatorModel: noEntryModel(() => ['UNEXPECTED_OBSERVATION']),
  goldenFixture: {
    description: 'An independent line check confirmed and witnessed by a second person',
    phase: { block: { type: 'G-16', version: '1' }, config: {}, records: ['ok'], signatures: { perform: { role: 'OPERATOR' }, check: { meaning: 'WITNESSED', role: 'VERIFIER' } } },
    parameters: [{ id: 'ok', name: 'Line is clear', valueType: 'CATEGORY', categories: ['CONFIRMED', 'NOT_CONFIRMED'], role: 'OBSERVATION', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON' }],
    script: [{ record: 'ok', value: { kind: 'CATEGORY', value: 'CONFIRMED' } }],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts'],
};

// ---------------------------------------------------------------------------------------------
// G-20 Yield and reconciliation

export const G20: BlockVersion = {
  type: 'G-20',
  version: '1',
  title: 'Yield and reconciliation',
  edition: 'generic',
  aliases: { tablets: 'K-18', injectables: 'KB-15' },
  level: 'PHASE',
  controls: ['PR-31', 'PR-39', 'IN-17', 'DI-33'],
  configSchema: {
    type: 'object',
    description: 'Yield or reconciliation computed from quantities recorded elsewhere; limits come from the yield checkpoint',
    fields: { showResidueYield: { type: 'boolean', optional: true, description: 'Also show the yield including reusable residue (design choice)' } },
  },
  dataSchema: NO_ENTRIES,
  checkConfig: (phase) => {
    const out = [];
    if (phase.computes.length === 0) out.push({ code: 'G20-NO-CALCULATION', severity: 'ERROR' as const, message: `Yield step ${phase.id} computes no yield or reconciliation`, controls: ['PR-31'] });
    if (!phase.signatures.check) out.push({ code: 'G20-NO-VERIFIER', severity: 'ERROR' as const, message: `Yield step ${phase.id} has no verifier: every yield calculation is independently verified`, controls: ['PR-31', 'DI-33'] });
    return out;
  },
  handler: { meanings: { check: ['YIELD_VERIFIED'] } },
  exceptionRules: [
    { type: 'YIELD_OUT_OF_LIMITS', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'Yield or reconciliation outside its limits: investigation required, release blocked', controls: ['PR-31', 'PR-39', 'IN-17'] },
    { type: 'CALCULATION_FAILED', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A yield could not be computed', controls: ['DI-33'] },
  ],
  simulatorModel: noEntryModel(() => ['YIELD_OUT_OF_LIMITS']),
  goldenFixture: {
    description: 'A yield of 94.0 % against limits of 95.0-101.0 % creates an exception that needs an investigation and blocks release (PR-31 catalog test)',
    phase: { block: { type: 'G-20', version: '1' }, config: {}, records: ['good'], computes: ['y'], yieldCheckpoint: 'Y1' },
    inputs: [{ id: 'theo', valueType: 'DECIMAL', unit: 'kg', value: '100.0' }],
    parameters: [{ id: 'good', name: 'Good output', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 1 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' }],
    calculations: [{ id: 'y', name: 'Yield', expression: 'yield(good, theo)', output: { valueType: 'DECIMAL', unit: '%', semanticTag: 'yield' }, criticality: 'CRITICAL', riskClass: 'HIGH' }],
    yieldCheckpoints: [
      {
        id: 'Y1',
        name: 'Stage yield',
        kind: 'YIELD',
        theoretical: 'theo',
        result: 'y',
        basis: 'AS_IS',
        limits: { unit: '%', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: '95.0', inclusive: true }, high: { value: '101.0', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] },
      },
    ],
    script: [{ record: 'good', value: { kind: 'DECIMAL', value: '94.0', unit: 'kg' } }],
    expect: { exceptions: ['YIELD_OUT_OF_LIMITS'], status: 'IN_PROGRESS', performRefusal: 'ENG-BLOCKED', values: { y: '94' } },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts'],
};

export const RECORDING_BLOCKS: readonly BlockVersion[] = [G03, G04, G05, G11, G13, G14, G16, G20];
