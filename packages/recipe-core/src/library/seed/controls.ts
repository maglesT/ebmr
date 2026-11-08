/** Ready-made library blocks: controls (decision 0026, S7). See types.ts. */
import type { SeedItem } from './types.ts';

const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const CHECKER = { meaning: 'CHECKED' as const, role: 'PRODUCTION_VERIFIER' };
const VERIFIER = { meaning: 'VERIFIED' as const, role: 'PRODUCTION_VERIFIER' };
const reg = (unit: string, low?: string, high?: string) => ({
  unit,
  ranges: [{ tier: 'REGISTERED' as const, ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS' as const, source: { kind: 'VALIDATION_REPORT' as const, ref: 'PV-REF' } }],
});

export const CONTROL_SEEDS: readonly SeedItem[] = [
  {
    definition: {
      code: 'CTRL-LINE-CLEAR-START',
      version: 1,
      edition: 'generic',
      title: 'Line clearance before start',
      category: 'CONTROL',
      roles: ['CLEARANCE'],
      instructions: 'Confirm the room and equipment are free of the previous product, its documents and materials.',
      sections: [
        {
          id: 'check',
          title: 'Clearance checks',
          fields: [
            { id: 'room', label: 'Room', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'roomClass' },
            { id: 'previousProduct', label: 'Previous product', type: 'TEXT' },
            { id: 'previousBatch', label: 'Previous batch', type: 'TEXT' },
            { id: 'noMaterials', label: 'No materials of the previous batch remain', type: 'YES_NO', expected: true },
            { id: 'noDocuments', label: 'No documents or labels of the previous batch remain', type: 'YES_NO', expected: true },
            { id: 'cleanStatus', label: 'Room and equipment labelled clean', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [
        { meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' },
        { meaning: 'CHECKED', role: 'PRODUCTION_VERIFIER' },
      ],
    },
    exampleUse: { equipmentClasses: { roomClass: 'GRANULATION-ROOM' } },
  },
  {
    definition: {
      code: 'CTRL-LINE-CLEAR-END',
      version: 1,
      edition: 'generic',
      title: 'Line clearance at the end of the stage',
      category: 'CONTROL',
      roles: ['CLEARANCE'],
      instructions: 'Remove everything of this batch from the room and equipment, and label the room and equipment for cleaning.',
      sections: [
        {
          id: 'check',
          title: 'End-of-stage checks',
          fields: [
            { id: 'room', label: 'Room', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'roomClass' },
            { id: 'outputRemoved', label: 'All output containers of this batch moved out', type: 'YES_NO', expected: true },
            { id: 'rejectsSegregated', label: 'Rejects and waste of this batch removed and labelled', type: 'YES_NO', expected: true },
            { id: 'unusedReturned', label: 'Unused materials returned with their labels', type: 'YES_NO', expected: true },
            { id: 'documentsRemoved', label: 'Documents and labels of this batch removed', type: 'YES_NO', expected: true },
            { id: 'toBeCleaned', label: 'Room and equipment labelled "to be cleaned"', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: { equipmentClasses: { roomClass: 'COMPRESSION-ROOM' } },
  },
  {
    definition: {
      code: 'CTRL-ROOM-STATUS',
      version: 1,
      edition: 'generic',
      title: 'Room status check',
      category: 'CONTROL',
      roles: ['ENVIRONMENT_CHECK'],
      instructions: 'Read the room monitors before starting; do not start if a reading is outside its limit.',
      sections: [
        {
          id: 'check',
          title: 'Room readings',
          fields: [
            { id: 'room', label: 'Room', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'roomClass' },
            { id: 'temperature', label: 'Room temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'temperature', critical: true },
            { id: 'humidity', label: 'Relative humidity', type: 'NUMBER', unit: '%', decimals: 0, limitSlot: 'humidity', critical: true },
            { id: 'pressureDiff', label: 'Differential pressure to the corridor', type: 'NUMBER', unit: 'Pa', decimals: 0, limitSlot: 'pressureDiff' },
            { id: 'statusLabel', label: 'Room status label shows clean', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR],
    },
    exampleUse: {
      limits: { temperature: reg('Cel', undefined, '25.0'), humidity: reg('%', undefined, '60'), pressureDiff: reg('Pa', '10', '30') },
      targets: { temperature: '22.0', humidity: '45', pressureDiff: '15' },
      equipmentClasses: { roomClass: 'GRANULATION-ROOM' },
    },
  },
  {
    definition: {
      code: 'CTRL-EQUIP-STATUS',
      version: 1,
      edition: 'generic',
      title: 'Equipment status and cleaning label check',
      category: 'CONTROL',
      roles: ['EQUIPMENT_STATUS_CHECK'],
      instructions: 'Check the cleaning and status labels of the equipment before use; do not use it if the clean hold time has passed.',
      sections: [
        {
          id: 'check',
          title: 'Status checks',
          fields: [
            { id: 'equipmentUnit', label: 'Equipment', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'equipmentClass' },
            { id: 'cleanLabel', label: 'Cleaning label present and shows clean', type: 'YES_NO', expected: true },
            { id: 'cleanedFor', label: 'Last product cleaned', type: 'TEXT' },
            { id: 'cleanedOn', label: 'Cleaned on', type: 'DATE_TIME' },
            { id: 'cleanHoldOk', label: 'Clean hold time not passed', type: 'YES_NO', expected: true },
            { id: 'calibrationOk', label: 'Calibration or qualification label in date', type: 'YES_NO', expected: true },
            { id: 'visuallyClean', label: 'Equipment visually clean and dry', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: { equipmentClasses: { equipmentClass: 'RMG-600L' } },
  },
  {
    definition: {
      code: 'CTRL-BALANCE-CHECK',
      version: 1,
      edition: 'generic',
      title: 'Balance daily check',
      category: 'CONTROL',
      roles: ['EQUIPMENT_STATUS_CHECK'],
      instructions: 'Level the balance, zero it, and weigh the low and high standard weights named for it; do not use it if a reading is outside its limit.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'weighBalance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
            { id: 'levelled', label: 'Level indicator centred', type: 'YES_NO', expected: true },
            { id: 'zeroed', label: 'Balance zeroed', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'readings',
          title: 'Standard weight readings',
          fields: [
            { id: 'lowWeightId', label: 'Low standard weight id', type: 'TEXT', maxLength: 30 },
            { id: 'lowReading', label: 'Low standard weight reading', type: 'NUMBER', unit: 'kg', decimals: 3, limitSlot: 'lowReading', critical: true },
            { id: 'highWeightId', label: 'High standard weight id', type: 'TEXT', maxLength: 30 },
            { id: 'highReading', label: 'High standard weight reading', type: 'NUMBER', unit: 'kg', decimals: 2, limitSlot: 'highReading', critical: true },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {
      limits: { lowReading: reg('kg', '0.999', '1.001'), highReading: reg('kg', '49.95', '50.05') },
      targets: { lowReading: '1.000', highReading: '50.00' },
      equipmentClasses: { balanceClass: 'FLOOR-BALANCE-300KG' },
    },
  },
  {
    definition: {
      code: 'CTRL-SAMPLING',
      version: 1,
      edition: 'generic',
      title: 'Sampling',
      category: 'CONTROL',
      roles: ['SAMPLING'],
      instructions: 'Take the stated number of units with a clean sampling tool, put them in a labelled sample container and send them with the request.',
      sections: [
        {
          id: 'sample',
          title: 'Sample',
          fields: [
            { id: 'purpose', label: 'Purpose', type: 'CHOICE', options: ['In-process testing', 'Release testing', 'Retained sample', 'Stability'] },
            { id: 'sample', label: 'Sample taken', type: 'SAMPLE', unitsSlot: 'sampleUnits' },
            { id: 'location', label: 'Sampling location', type: 'CHOICE', options: ['Top', 'Middle', 'Bottom', 'Composite'] },
            { id: 'sampleContainer', label: 'Sample container id', type: 'TEXT', maxLength: 40 },
            { id: 'labelled', label: 'Sample container labelled with product, batch, stage and date', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [{ meaning: 'PERFORMED', role: 'QA' }],
    },
    exampleUse: { counts: { sampleUnits: '20' } },
  },
  {
    definition: {
      code: 'CTRL-YIELD',
      version: 1,
      edition: 'generic',
      title: 'Stage yield',
      category: 'CONTROL',
      roles: ['YIELD_RECONCILIATION'],
      instructions: 'Weigh the stage output, the samples taken and the rejects; the yield is calculated against the theoretical quantity.',
      inputs: [{ id: 'theoretical', label: 'Theoretical quantity (batch size)', kind: 'BATCH_SIZE', unit: 'kg' }],
      sections: [
        {
          id: 'yield',
          title: 'Yield',
          fields: [
            { id: 'weighBalance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
            { id: 'output', label: 'Output weight', type: 'WEIGHING', unit: 'kg', limitSlot: 'output' },
            { id: 'samples', label: 'Samples taken', type: 'WEIGHING', unit: 'kg', limitSlot: 'samples' },
            { id: 'rejects', label: 'Rejects and recoverable loss', type: 'WEIGHING', unit: 'kg', limitSlot: 'rejects' },
            { id: 'yieldPct', label: 'Yield', type: 'CALC', expression: 'output / theoretical * 100 [%]', unit: '%', limitSlot: 'yield', critical: true },
            { id: 'accountedPct', label: 'Accounted for (output, samples, rejects)', type: 'CALC', expression: '(output + samples + rejects) / theoretical * 100 [%]', unit: '%', limitSlot: 'accounted', critical: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { output: reg('kg', '0', '210'), samples: reg('kg', '0', '2'), rejects: reg('kg', '0', '5'), yield: reg('%', '97.0', '100.5'), accounted: reg('%', '98.0', '101.0') },
      targets: { output: '196', samples: '0.5', rejects: '1.5' },
      equipmentClasses: { balanceClass: 'FLOOR-BALANCE-300KG' },
    },
    exampleInputs: { theoretical: { value: '200', unit: 'kg' } },
  },
  {
    definition: {
      code: 'CTRL-MATERIAL-RECON',
      version: 1,
      edition: 'generic',
      title: 'Material reconciliation',
      category: 'CONTROL',
      roles: ['YIELD_RECONCILIATION'],
      instructions: 'Account for the material issued for this batch: used, returned to store and rejected.',
      inputs: [{ id: 'issued', label: 'Quantity issued (formula line)', kind: 'FORMULA_LINE', unit: 'kg', slot: 'materialLine' }],
      sections: [
        {
          id: 'recon',
          title: 'Reconciliation',
          fields: [
            { id: 'used', label: 'Quantity used', type: 'WEIGHING', unit: 'kg', limitSlot: 'used' },
            { id: 'returned', label: 'Quantity returned to store', type: 'WEIGHING', unit: 'kg', limitSlot: 'returned' },
            { id: 'rejected', label: 'Quantity rejected or spilled', type: 'WEIGHING', unit: 'kg', limitSlot: 'rejected' },
            { id: 'reconciliation', label: 'Reconciliation', type: 'CALC', expression: '(used + returned + rejected) / issued * 100 [%]', unit: '%', limitSlot: 'reconciliation', critical: true },
            { id: 'explanation', label: 'Explanation of any difference', type: 'TEXT', required: false },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { used: reg('kg', '0', '10'), returned: reg('kg', '0', '10'), rejected: reg('kg', '0', '1'), reconciliation: reg('%', '99.0', '101.0') },
      targets: { used: '9.8', returned: '0.1', rejected: '0.05' },
      bomLines: { materialLine: 'L1' },
    },
    exampleInputs: { issued: { value: '10', unit: 'kg' } },
  },
  {
    definition: {
      code: 'CTRL-PRINTED-RECON',
      version: 1,
      edition: 'generic',
      title: 'Printed packaging material reconciliation',
      category: 'CONTROL',
      roles: ['YIELD_RECONCILIATION'],
      instructions: 'Count the printed material issued, used, damaged and returned; any difference is investigated before the batch is released.',
      sections: [
        {
          id: 'recon',
          title: 'Reconciliation',
          fields: [
            { id: 'material', label: 'Printed material', type: 'CHOICE', options: ['Labels', 'Cartons', 'Leaflets', 'Printed foil', 'Shipper labels'] },
            { id: 'materialLot', label: 'Printed material lot', type: 'TEXT', maxLength: 30 },
            { id: 'issued', label: 'Issued', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'issued' },
            { id: 'used', label: 'Used', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'used' },
            { id: 'damaged', label: 'Damaged and destroyed', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'damaged' },
            { id: 'returned', label: 'Returned to store', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'returned' },
            { id: 'reconciliation', label: 'Reconciliation', type: 'CALC', expression: '(used + damaged + returned) / issued * 100 [%]', unit: '%', limitSlot: 'reconciliation', critical: true },
            { id: 'coded', label: 'Damaged coded material destroyed under supervision', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { issued: reg('1', '0'), used: reg('1', '0'), damaged: reg('1', '0'), returned: reg('1', '0'), reconciliation: reg('%', '100.0', '100.0') },
      targets: { issued: '10500', used: '10120', damaged: '35', returned: '345' },
    },
  },
  {
    definition: {
      code: 'CTRL-STAGE-SIGNOFF',
      version: 1,
      edition: 'generic',
      title: 'Stage sign-off',
      category: 'CONTROL',
      roles: ['SIGN_OFF'],
      instructions: 'Confirm every step of the stage is recorded and every deviation of the stage is referenced before the next stage starts.',
      sections: [
        {
          id: 'signoff',
          title: 'Sign-off',
          fields: [
            { id: 'stage', label: 'Stage', type: 'TEXT', maxLength: 60 },
            { id: 'allRecorded', label: 'All steps of the stage recorded', type: 'YES_NO', expected: true },
            { id: 'deviations', label: 'Deviations raised in this stage', type: 'YES_NO' },
            { id: 'deviationRefs', label: 'Deviation numbers', type: 'TEXT', showWhen: { field: 'deviations', equals: true } },
            { id: 'outputContainers', label: 'Output containers', type: 'NUMBER', unit: '1', decimals: 0 },
          ],
        },
      ],
      signatures: [
        { meaning: 'PERFORMED', role: 'PRODUCTION_SUPERVISOR' },
        { meaning: 'CHECKED', role: 'QA' },
      ],
    },
    exampleUse: {},
  },
  {
    definition: {
      code: 'CTRL-DEVIATION-REF',
      version: 1,
      edition: 'generic',
      title: 'Deviation reference',
      category: 'CONTROL',
      roles: ['OBSERVATION'],
      instructions: 'Record the deviation number and what happened; QA is informed straight away.',
      sections: [
        {
          id: 'deviation',
          title: 'Deviation',
          fields: [
            { id: 'deviationNo', label: 'Deviation number', type: 'TEXT', maxLength: 30 },
            { id: 'deviationKind', label: 'Kind', type: 'CHOICE', options: ['Planned', 'Unplanned'] },
            { id: 'classification', label: 'Initial classification', type: 'CHOICE', options: ['Minor', 'Major', 'Critical'] },
            { id: 'description', label: 'What happened', type: 'TEXT' },
            { id: 'immediateAction', label: 'Immediate action taken', type: 'TEXT' },
            { id: 'qaInformed', label: 'QA informed', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, { meaning: 'CHECKED', role: 'PRODUCTION_SUPERVISOR' }],
    },
    exampleUse: {},
  },
  {
    definition: {
      code: 'CTRL-QA-VERIFY',
      version: 1,
      edition: 'generic',
      title: 'QA verification',
      category: 'CONTROL',
      roles: ['VERIFICATION'],
      instructions: 'QA checks the record of the stage on the floor before the batch moves on.',
      sections: [
        {
          id: 'verify',
          title: 'Verification',
          fields: [
            { id: 'scope', label: 'What was verified', type: 'TEXT' },
            { id: 'recordComplete', label: 'Record complete and legible', type: 'YES_NO', expected: true },
            { id: 'limitsMet', label: 'Recorded values within limits or covered by a deviation', type: 'YES_NO', expected: true },
            { id: 'observations', label: 'Observations raised', type: 'YES_NO' },
            { id: 'observationNote', label: 'Observations', type: 'TEXT', showWhen: { field: 'observations', equals: true } },
          ],
        },
      ],
      signatures: [
        { meaning: 'PERFORMED', role: 'PRODUCTION_SUPERVISOR' },
        { meaning: 'QA_APPROVED', role: 'QA' },
      ],
    },
    exampleUse: {},
  },
];
