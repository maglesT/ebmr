/**
 * Example library block definitions and uses for the S1 tests (decision 0026). Invented values only; the reference
 * limit note paraphrases a common compendial value and quotes no text.
 */
import type { LimitSpec } from '../../src/limits/model.ts';
import type { BlockDefinition, BlockUse } from '../../src/library/model.ts';

export function range(unit: string, low: string | undefined, high: string | undefined, tier: 'REGISTERED' | 'INTERNAL_ACTION' | 'ALERT' = 'REGISTERED'): LimitSpec {
  const r: LimitSpec['ranges'][number] = { tier, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'REF-1' } };
  if (low !== undefined) r.low = { value: low, inclusive: true };
  if (high !== undefined) r.high = { value: high, inclusive: true };
  return { unit, ranges: [r] };
}

export function friability(): BlockDefinition {
  return {
    code: 'IPC-FRIAB',
    version: 1,
    title: 'Friability',
    category: 'TEST_IPC',
    sections: [
      {
        id: 'run',
        title: 'Run',
        fields: [
          { id: 'drum', label: 'Friabilator', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'friabilatorClass' },
          { id: 'w0', label: 'Weight before', type: 'NUMBER', unit: 'g', decimals: 3 },
          { id: 'w1', label: 'Weight after', type: 'NUMBER', unit: 'g', decimals: 3 },
          { id: 'loss', label: 'Weight loss', type: 'CALC', expression: '(w0 - w1) / w0 * 100 [%]', unit: '%', limitSlot: 'loss', critical: true },
          { id: 'cracked', label: 'Any tablet cracked or broken', type: 'YES_NO', expected: false },
        ],
      },
    ],
    signatures: [{ meaning: 'PERFORMED', role: 'IPC_OPERATOR' }],
    referenceLimits: { loss: { unit: '%', high: '1.0', note: 'A common compendial maximum for uncoated tablets' } },
  };
}

export function friabilityUse(): BlockUse {
  return { block: { code: 'IPC-FRIAB', version: 1 }, limits: { loss: range('%', undefined, '0.8') }, equipmentClasses: { friabilatorClass: 'FRIABILATOR' } };
}

export function fluidBedDrying(): BlockDefinition {
  return {
    code: 'PROC-FBD',
    version: 1,
    title: 'Fluid bed drying with LOD check',
    category: 'PROCESS',
    sections: [
      {
        id: 'setup',
        title: 'Set-up',
        fields: [
          { id: 'dryer', label: 'Fluid bed dryer', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'dryerClass' },
          { id: 'inletTemp', label: 'Inlet air temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'inletTemp', critical: true },
          { id: 'drying', label: 'Drying time', type: 'TIMER', durationUnit: 'min', limitSlot: 'dryingTime' },
        ],
      },
      {
        id: 'lodLoop',
        title: 'LOD check',
        repeat: { kind: 'UNTIL_PASS', untilField: 'lod', maxRepeatsSlot: 'maxLodChecks' },
        fields: [
          { id: 'sample', label: 'LOD sample', type: 'SAMPLE', unitsSlot: 'lodSampleUnits' },
          { id: 'lod', label: 'Loss on drying', type: 'NUMBER', unit: '%', decimals: 2, limitSlot: 'lod', critical: true },
        ],
      },
      {
        id: 'out',
        title: 'Output',
        fields: [
          { id: 'container', label: 'Dried granules container', type: 'CONTAINER', action: 'REGISTER' },
          { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          { id: 'lastLod', label: 'Highest LOD recorded', type: 'CALC', expression: 'max(lod)', unit: '%' },
        ],
      },
    ],
    signatures: [
      { meaning: 'PERFORMED', role: 'OPERATOR' },
      { meaning: 'CHECKED', role: 'SUPERVISOR' },
    ],
  };
}

export function fluidBedDryingUse(): BlockUse {
  return {
    block: { code: 'PROC-FBD', version: 1 },
    limits: { inletTemp: range('Cel', '55', '65'), dryingTime: range('min', '20', '90', 'INTERNAL_ACTION'), lod: range('%', '1.5', '2.5') },
    targets: { inletTemp: '60' },
    equipmentClasses: { dryerClass: 'FBD' },
    counts: { maxLodChecks: '6', lodSampleUnits: '1' },
  };
}

export function dissolutionProfile(): BlockDefinition {
  return {
    code: 'REL-DISSO-PROFILE',
    version: 1,
    title: 'Dissolution profile',
    category: 'TEST_RELEASE',
    sections: [
      {
        id: 'run',
        title: 'Run',
        fields: [
          { id: 'apparatus', label: 'Dissolution apparatus', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'apparatusClass' },
          { id: 'released', label: 'Released', type: 'TEST_RESULT', unit: '%', replicatesSlot: 'vessels', statistics: [{ statistic: 'INDIVIDUAL', limitSlot: 'individual' }, { statistic: 'MEAN', limitSlot: 'mean' }], perPoint: true },
        ],
      },
    ],
    signatures: [
      { meaning: 'PERFORMED', role: 'QC_ANALYST' },
      { meaning: 'VERIFIED', role: 'QC_REVIEWER' },
    ],
  };
}

export function dissolutionUse(): BlockUse {
  return {
    block: { code: 'REL-DISSO-PROFILE', version: 1 },
    equipmentClasses: { apparatusClass: 'USP-2' },
    counts: { vessels: '6' },
    points: {
      released: [
        { id: 'h1', label: '1 h', limits: range('%', '20', '40') },
        { id: 'h4', label: '4 h', limits: range('%', '45', '65') },
        { id: 'h8', label: '8 h', limits: range('%', '80', undefined) },
      ],
    },
  };
}

/** Potency-adjusted dispensing: reads the formula line, the lot's assay and the LOD of an earlier step. */
export function potencyDispensing(): BlockDefinition {
  return {
    code: 'PROC-DISP-POTENCY',
    version: 1,
    title: 'Potency-adjusted dispensing',
    category: 'PROCESS',
    inputs: [
      { id: 'labelQty', label: 'Formula quantity (100 % basis)', kind: 'FORMULA_LINE', unit: 'kg', slot: 'activeLine' },
      { id: 'assay', label: 'Approved assay of the lot', kind: 'LOT_ASSAY', unit: '%', lotField: 'lot' },
      { id: 'lodLot', label: 'LOD of the lot', kind: 'STEP_VALUE', unit: '%', slot: 'lodSource' },
      { id: 'batchSize', label: 'Batch size', kind: 'BATCH_SIZE', unit: 'kg' },
    ],
    sections: [
      {
        id: 'weigh',
        title: 'Weigh',
        fields: [
          { id: 'lot', label: 'Lot', type: 'MATERIAL_LOT' },
          { id: 'required', label: 'Quantity to dispense', type: 'CALC', expression: 'labelQty * 100 [%] / assay * 100 [%] / (100 [%] - lodLot)', unit: 'kg' },
          { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg', bomLine: true },
          { id: 'rework', label: 'Rework material added', type: 'YES_NO' },
          { id: 'reworkRef', label: 'Rework authorisation', type: 'TEXT', showWhen: { field: 'rework', equals: true } },
          { id: 'reworkQty', label: 'Rework quantity', type: 'NUMBER', unit: 'kg', showWhen: { field: 'rework', equals: true } },
        ],
      },
    ],
    signatures: [
      { meaning: 'PERFORMED', role: 'DISPENSER' },
      { meaning: 'VERIFIED', role: 'DISPENSER' },
    ],
  };
}
