/**
 * Ready-made library blocks of the API edition (`substance`; API plan `docs/build-plan/api/plan.md`, A1): catalogue v1
 * for a one-step synthesis to a packed API (A1b; the group `substance` of SEED_GROUPS). They are library data like the
 * capsule blocks: each renders in the one generic library-step form on the floor, with no screen of its own. In the
 * order a synthesis uses them:
 *   - API-DISP: dispensing a starting material, reagent or solvent by weight, each container against its bill-of-
 *     materials line and labelled as a sub-divided container (material, control number, quantity, retest date);
 *   - API-CHARGE: charging the dispensed containers into the cleaned, inerted reactor, each lot checked as its line;
 *   - API-REACT: the reaction, its temperature and time as critical process parameters, checked at each round;
 *   - API-IPC-COMPLETE: the completion check, repeated until the remaining starting material is within its limit;
 *   - API-CRYST: crystallisation (seeding, cooling to the final temperature, ageing);
 *   - API-FILTER: isolation on a Nutsche filter or a centrifuge (chosen in the step), washing, the wet cake;
 *   - API-DRY: tray drying with the loss-on-drying loop (until the LOD passes), the mass lost worked out in the step;
 *   - API-YIELD: the actual yield against the batch size and the molar yield against the key starting material's
 *     formula line; a result outside its limits raises an exception, explained and investigated as a deviation;
 *   - API-LABEL-CHECK: line clearance of earlier labels, the label content checked against the master before use and
 *     a specimen label kept with the record;
 *   - API-PACK: packing into drums or bags (below).
 * A calculation reads only values of its own step, the batch size, formula lines or the lot assay (no earlier-step
 * value: the lead's rule for A1b).
 *
 * API-PACK: packing the finished API into drums or bags and labelling them (ICH Q7 / EU GMP Part II chapter 9, Revised
 * Schedule M Part XII, packaging and labelling). The release items read:
 *   - `container` entries (one per drum or bag): `netMass` in kg, summed against the quantity posted with the
 *     finished lot (E.POSTED_QUANTITY);
 *   - the `recon` entry: the label reconciliation (E.RECONCILIATION_LABELS; a result outside its limit raises
 *     LIB_LIMIT_BREACH, which blocks release until resolved);
 *   - the `exam` entry: the examination of the packed and labelled containers at the end of packing
 *     (E.PACK_EXAMINATION).
 * Changing a section or field id here needs the same change in that migration's successor.
 *
 * Invented example values (a 50 kg batch in two 25 kg drums). Requirements are paraphrased, never quoted.
 */
import type { LimitSpec } from '../../limits/model.ts';
import type { SeedItem } from './types.ts';

const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const VERIFIER = { meaning: 'VERIFIED' as const, role: 'PRODUCTION_VERIFIER' };

const reg = (unit: string, low?: string, high?: string): LimitSpec => ({
  unit,
  ranges: [{ tier: 'REGISTERED', ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'SPEC-REF' } }],
});

export const API_PACK: SeedItem = {
  definition: {
    code: 'API-PACK',
    version: 1,
    title: 'Pack the API into drums or bags and label them',
    category: 'PACKAGING',
    edition: 'substance',
    instructions:
      'Fill each drum or bag (inner liners tied, outer container closed and sealed), weigh it, label it with the product, batch, net quantity, retest or expiry date and storage conditions, then reconcile the labels and examine every packed container.',
    sections: [
      {
        id: 'container',
        title: 'Container filled and labelled',
        repeat: { kind: 'COUNT', countSlot: 'containers' },
        fields: [
          { id: 'containerType', label: 'Container', type: 'CHOICE', options: ['Drum', 'Bag'] },
          { id: 'containerNo', label: 'Container number', type: 'TEXT', pattern: '[A-Z0-9-]{1,20}' },
          { id: 'netMass', label: 'Net mass', type: 'NUMBER', unit: 'kg', decimals: 3, limitSlot: 'netMass', critical: true },
          { id: 'sealed', label: 'Liners tied and container sealed', type: 'YES_NO', expected: true },
          { id: 'labelOk', label: 'Label correct (product, batch, net quantity, retest or expiry date, storage)', type: 'YES_NO', expected: true },
        ],
      },
      {
        id: 'recon',
        title: 'Label reconciliation',
        fields: [
          { id: 'issued', label: 'Labels issued', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'issued' },
          { id: 'used', label: 'Labels applied', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'used' },
          { id: 'destroyed', label: 'Batch-coded labels destroyed', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'destroyed' },
          { id: 'returned', label: 'Uncoded labels returned', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'returned' },
          { id: 'labelRecon', label: 'Labels accounted for', type: 'CALC', expression: '(used + destroyed + returned) / issued * 100 [%]', unit: '%', limitSlot: 'labelRecon', critical: true },
        ],
      },
      {
        id: 'exam',
        title: 'Examination of the packed containers',
        fields: [
          { id: 'examined', label: 'Containers examined', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'examined' },
          { id: 'allCorrect', label: 'Every container examined is correctly sealed and labelled', type: 'YES_NO', expected: true },
        ],
      },
    ],
    signatures: [OPERATOR, VERIFIER],
  },
  exampleUse: {
    limits: {
      netMass: reg('kg', '24.950', '25.050'), labelRecon: reg('%', '100.0', '100.0'),
      issued: reg('1', '0'), used: reg('1', '0'), destroyed: reg('1', '0'), returned: reg('1', '0'), examined: reg('1', '1'),
    },
    // Two drums: 4 labels issued (one per drum and its inner liner), 4 applied.
    targets: { netMass: '25.000', issued: '4', used: '4', destroyed: '0', returned: '0', examined: '2' },
    counts: { containers: '2' },
  },
};

const SIGNED = [OPERATOR, VERIFIER];

export const API_DISP: SeedItem = {
  definition: {
    code: 'API-DISP',
    version: 1,
    title: 'Dispensing of a starting material, reagent or solvent',
    category: 'PROCESS',
    edition: 'substance',
    instructions:
      'Check the balance, then weigh each container of the material named by its bill-of-materials line. Label each dispensed container with the material, its control number, the quantity and the retest date, and keep it closed until charging. A second person witnesses the weighing.',
    sections: [
      {
        id: 'setup',
        title: 'Set-up',
        fields: [
          { id: 'weighBalance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
          { id: 'dailyCheck', label: 'Balance daily check done and within limits', type: 'YES_NO', expected: true },
          { id: 'booth', label: 'Dispensing booth extraction on', type: 'YES_NO', expected: true },
        ],
      },
      {
        id: 'weigh',
        title: 'Weigh per container',
        repeat: { kind: 'PER_CONTAINER' },
        fields: [
          { id: 'lot', label: 'Material lot (released, within its retest date)', type: 'MATERIAL_LOT', bomLineSlot: 'materialLine' },
          { id: 'container', label: 'Dispensed container', type: 'CONTAINER', action: 'REGISTER' },
          { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg', bomLine: true, limitSlot: 'net' },
          { id: 'labelled', label: 'Container labelled (material, control number, quantity, retest date) and closed', type: 'YES_NO', expected: true },
        ],
      },
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    limits: { net: reg('kg', '39.800', '40.200') },
    targets: { net: '40.000' },
    equipmentClasses: { balanceClass: 'FLOOR-BALANCE-150KG' },
    bomLines: { materialLine: 'L1' },
  },
};

export const API_CHARGE: SeedItem = {
  definition: {
    code: 'API-CHARGE',
    version: 1,
    title: 'Charging the reactor',
    category: 'PROCESS',
    edition: 'substance',
    instructions:
      'Confirm the reactor is clean and labelled for this batch, inert it with nitrogen, then charge each dispensed container in the order of the master. Check each lot against its bill-of-materials line before it goes in.',
    sections: [
      {
        id: 'setup',
        title: 'Reactor ready',
        fields: [
          { id: 'reactor', label: 'Reactor', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'reactorClass' },
          { id: 'clean', label: 'Reactor clean, its status label shows this product and batch', type: 'YES_NO', expected: true },
          { id: 'inerted', label: 'Reactor inerted with nitrogen', type: 'YES_NO', expected: true },
          { id: 'oxygen', label: 'Oxygen in the head space', type: 'NUMBER', unit: '%', decimals: 1, limitSlot: 'oxygen', critical: true },
        ],
      },
      {
        id: 'charge',
        title: 'Charge per container',
        repeat: { kind: 'PER_CONTAINER' },
        fields: [
          { id: 'lot', label: 'Material lot', type: 'MATERIAL_LOT', bomLineSlot: 'materialLine' },
          { id: 'container', label: 'Dispensed container charged', type: 'CONTAINER', action: 'CONSUME' },
          { id: 'massTemp', label: 'Reactor content temperature at charging', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'chargeTemp', critical: true },
          { id: 'emptied', label: 'Container emptied completely', type: 'YES_NO', expected: true },
        ],
      },
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    limits: { oxygen: reg('%', undefined, '2.0'), chargeTemp: reg('Cel', '20.0', '30.0') },
    targets: { oxygen: '1.0', chargeTemp: '25.0' },
    equipmentClasses: { reactorClass: 'GLR-2000L' },
    bomLines: { materialLine: 'L1' },
  },
};

export const API_REACT: SeedItem = {
  definition: {
    code: 'API-REACT',
    version: 1,
    title: 'Reaction (temperature and time)',
    category: 'PROCESS',
    edition: 'substance',
    instructions:
      'Bring the reaction mass to the reaction temperature, start the reaction time and hold the temperature and agitation within their limits; record them at each round. The completion check is its own step.',
    sections: [
      {
        id: 'start',
        title: 'Start of reaction',
        fields: [
          { id: 'reactor', label: 'Reactor', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'reactorClass' },
          { id: 'reactionTemp', label: 'Reaction temperature reached', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'reactionTemp', critical: true },
          { id: 'reactionTime', label: 'Reaction time', type: 'TIMER', durationUnit: 'min', limitSlot: 'reactionTime', critical: true },
        ],
      },
      {
        id: 'round',
        title: 'Reaction round',
        repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
        fields: [
          { id: 'roundTemp', label: 'Reaction mass temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'roundTemp', critical: true },
          { id: 'agitation', label: 'Agitator speed', type: 'NUMBER', unit: '/min', decimals: 0, limitSlot: 'agitation' },
        ],
      },
      {
        id: 'end',
        title: 'End of reaction',
        fields: [{ id: 'endTemp', label: 'Reaction mass temperature at the end', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'endTemp', critical: true }],
      },
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    limits: { reactionTemp: reg('Cel', '60.0', '65.0'), reactionTime: reg('min', '45', '360'), roundTemp: reg('Cel', '60.0', '65.0'), endTemp: reg('Cel', '60.0', '65.0'), agitation: reg('/min', '80', '120') },
    targets: { reactionTemp: '62.5', roundTemp: '62.5', endTemp: '62.5', agitation: '100' },
    equipmentClasses: { reactorClass: 'GLR-2000L' },
    intervals: { roundInterval: { value: '30', unit: 'min' } },
  },
};

export const API_IPC_COMPLETE: SeedItem = {
  definition: {
    code: 'API-IPC-COMPLETE',
    version: 1,
    title: 'Reaction completion check',
    category: 'TEST_IPC',
    edition: 'substance',
    instructions:
      'Take a sample of the reaction mass and test it by the approved method. While the remaining starting material is above its limit, continue the reaction and sample again, up to the number of checks the master allows.',
    sections: [
      {
        id: 'check',
        title: 'Completion sample',
        repeat: { kind: 'UNTIL_PASS', untilField: 'remaining', maxRepeatsSlot: 'maxChecks' },
        fields: [
          { id: 'sample', label: 'Reaction mass sample', type: 'SAMPLE', unitsSlot: 'sampleUnits', purpose: 'Reaction completion' },
          { id: 'instrument', label: 'Instrument (HPLC or GC)', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'instrumentClass' },
          { id: 'remaining', label: 'Starting material remaining (area %)', type: 'NUMBER', unit: '%', decimals: 2, limitSlot: 'remaining', critical: true },
        ],
      },
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    limits: { remaining: reg('%', '0.00', '0.50') },
    targets: { remaining: '0.20' },
    equipmentClasses: { instrumentClass: 'HPLC' },
    counts: { maxChecks: '6', sampleUnits: '1' },
  },
};

export const API_CRYST: SeedItem = {
  definition: {
    code: 'API-CRYST',
    version: 1,
    title: 'Crystallisation (seeding, cooling, ageing)',
    category: 'PROCESS',
    edition: 'substance',
    instructions:
      'At the seeding temperature add the seed, cool to the final temperature at the rate of the master, then age the slurry for the ageing time before isolation.',
    sections: [
      {
        id: 'seed',
        title: 'Seeding',
        fields: [
          { id: 'crystalliser', label: 'Crystalliser', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'crystalliserClass' },
          { id: 'seedTemp', label: 'Temperature at seeding', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'seedTemp', critical: true },
          { id: 'seedQty', label: 'Seed added', type: 'WEIGHING', unit: 'kg', limitSlot: 'seedQty' },
        ],
      },
      {
        id: 'cool',
        title: 'Cooling and ageing',
        fields: [
          { id: 'coolTime', label: 'Cooling time', type: 'NUMBER', unit: 'h', decimals: 1, limitSlot: 'coolTime', critical: true },
          { id: 'finalTemp', label: 'Final temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'finalTemp', critical: true },
          { id: 'ageing', label: 'Ageing time', type: 'TIMER', durationUnit: 'min', limitSlot: 'ageing', critical: true },
          { id: 'slurry', label: 'Crystals formed, slurry stirrable', type: 'YES_NO', expected: true },
        ],
      },
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    limits: { seedTemp: reg('Cel', '45.0', '50.0'), seedQty: reg('kg', '0.040', '0.060'), coolTime: reg('h', '3.0', '5.0'), finalTemp: reg('Cel', '0.0', '5.0'), ageing: reg('min', '60', '240') },
    targets: { seedTemp: '47.5', seedQty: '0.050', coolTime: '4.0', finalTemp: '2.5' },
    equipmentClasses: { crystalliserClass: 'GLR-2000L' },
  },
};

export const API_FILTER: SeedItem = {
  definition: {
    code: 'API-FILTER',
    version: 1,
    title: 'Isolation: Nutsche filter or centrifuge, washing',
    category: 'PROCESS',
    edition: 'substance',
    instructions:
      'Record which isolation equipment is used. Check the filter cloth, filter or spin the slurry, wash the cake with the solvent of the master the number of times it gives, then unload the wet cake into labelled containers. Collect the mother liquor in a labelled container.',
    sections: [
      {
        id: 'setup',
        title: 'Set-up',
        fields: [
          { id: 'filterType', label: 'Isolation equipment', type: 'CHOICE', options: ['Nutsche filter', 'Centrifuge'] },
          { id: 'filter', label: 'Filter or centrifuge', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'filterClass' },
          { id: 'cloth', label: 'Filter cloth intact and of the grade the master names', type: 'YES_NO', expected: true },
          { id: 'vacuum', label: 'Vacuum under the cloth', type: 'NUMBER', unit: 'kPa', decimals: 0, limitSlot: 'vacuum', critical: true, showWhen: { field: 'filterType', equals: 'Nutsche filter' } },
          { id: 'spin', label: 'Centrifuge speed', type: 'NUMBER', unit: '/min', decimals: 0, limitSlot: 'spin', critical: true, showWhen: { field: 'filterType', equals: 'Centrifuge' } },
        ],
      },
      {
        id: 'wash',
        title: 'Cake wash',
        repeat: { kind: 'COUNT', countSlot: 'washes' },
        fields: [
          { id: 'washLot', label: 'Wash solvent lot', type: 'MATERIAL_LOT', bomLineSlot: 'washLine' },
          { id: 'washVolume', label: 'Wash volume', type: 'NUMBER', unit: 'L', decimals: 1, limitSlot: 'washVolume', critical: true },
        ],
      },
      {
        id: 'output',
        title: 'Wet cake',
        fields: [
          { id: 'motherLiquor', label: 'Mother liquor collected in a labelled container', type: 'YES_NO', expected: true },
          { id: 'container', label: 'Wet cake container', type: 'CONTAINER', action: 'REGISTER' },
          { id: 'wetMass', label: 'Wet cake net weight', type: 'WEIGHING', unit: 'kg', limitSlot: 'wetMass' },
        ],
      },
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    limits: { vacuum: reg('kPa', '-90', '-60'), spin: reg('/min', '800', '1200'), washVolume: reg('L', '45.0', '55.0'), wetMass: reg('kg', '50.000', '70.000') },
    targets: { vacuum: '-75', spin: '1000', washVolume: '50.0', wetMass: '60.000' },
    equipmentClasses: { filterClass: 'NUTSCHE-1M2' },
    bomLines: { washLine: 'L2' },
    counts: { washes: '2' },
  },
};

export const API_DRY: SeedItem = {
  definition: {
    code: 'API-DRY',
    version: 1,
    title: 'Tray drying to the loss on drying',
    category: 'PROCESS',
    edition: 'substance',
    instructions:
      'Weigh the wet cake onto the trays, dry at the set temperature and rake at the stated times. Test the loss on drying and dry on until it is within its limit, up to the number of checks the master allows. Unload and weigh the dry material.',
    sections: [
      {
        id: 'setup',
        title: 'Loading',
        fields: [
          { id: 'dryer', label: 'Tray dryer', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'dryerClass' },
          { id: 'wetIn', label: 'Wet cake container', type: 'CONTAINER', action: 'CONSUME' },
          { id: 'wetMass', label: 'Wet cake loaded', type: 'WEIGHING', unit: 'kg', limitSlot: 'wetMass' },
          { id: 'trays', label: 'Number of trays loaded', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'trays' },
          { id: 'dryerTemp', label: 'Dryer temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'dryerTemp', critical: true },
          { id: 'drying', label: 'Drying time', type: 'TIMER', durationUnit: 'min', limitSlot: 'dryingTime', critical: true },
        ],
      },
      {
        id: 'lodLoop',
        title: 'Raking and LOD check',
        repeat: { kind: 'UNTIL_PASS', untilField: 'lod', maxRepeatsSlot: 'maxLodChecks' },
        fields: [
          { id: 'raked', label: 'Material raked', type: 'YES_NO', expected: true },
          { id: 'sample', label: 'LOD sample', type: 'SAMPLE', unitsSlot: 'lodSampleUnits', purpose: 'Loss on drying' },
          { id: 'lod', label: 'Loss on drying', type: 'NUMBER', unit: '%', decimals: 2, limitSlot: 'lod', critical: true },
        ],
      },
      {
        id: 'output',
        title: 'Dry material',
        fields: [
          { id: 'container', label: 'Dry material container', type: 'CONTAINER', action: 'REGISTER' },
          { id: 'dryMass', label: 'Dry material net weight', type: 'WEIGHING', unit: 'kg', limitSlot: 'dryMass' },
          { id: 'massLost', label: 'Mass lost on drying', type: 'CALC', expression: '(wetMass - dryMass) / wetMass * 100 [%]', unit: '%', limitSlot: 'massLost' },
        ],
      },
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    limits: {
      wetMass: reg('kg', '50.000', '70.000'), trays: reg('1', '8', '16'), dryerTemp: reg('Cel', '55.0', '65.0'), dryingTime: reg('min', '60', '900'),
      lod: reg('%', '0.00', '0.50'), dryMass: reg('kg', '40.000', '52.000'), massLost: reg('%', '10.0', '30.0'),
    },
    targets: { wetMass: '60.000', trays: '12', dryerTemp: '60.0', lod: '0.30', dryMass: '48.000' },
    equipmentClasses: { dryerClass: 'TRAY-DRYER' },
    counts: { maxLodChecks: '8', lodSampleUnits: '1' },
  },
};

export const API_YIELD: SeedItem = {
  definition: {
    code: 'API-YIELD',
    version: 1,
    title: 'Yield of the API',
    category: 'CONTROL',
    edition: 'substance',
    roles: ['YIELD_RECONCILIATION'],
    instructions:
      'Weigh the dry API, the samples taken and the recoverable losses. The actual yield is worked out against the batch size and the molar yield against the key starting material of the formula; a yield outside its limits is explained and investigated as a deviation.',
    inputs: [
      { id: 'batchSize', label: 'Batch size (expected output)', kind: 'BATCH_SIZE', unit: 'kg' },
      { id: 'ksmQty', label: 'Key starting material charged (formula line)', kind: 'FORMULA_LINE', unit: 'kg', slot: 'ksmLine' },
    ],
    sections: [
      {
        id: 'yield',
        title: 'Yield',
        fields: [
          { id: 'weighBalance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
          { id: 'output', label: 'Dry API weight', type: 'WEIGHING', unit: 'kg', limitSlot: 'output' },
          { id: 'samples', label: 'Samples taken', type: 'WEIGHING', unit: 'kg', limitSlot: 'samples' },
          { id: 'losses', label: 'Recoverable losses (sweepings, filter residue)', type: 'WEIGHING', unit: 'kg', limitSlot: 'losses' },
          { id: 'mwKsm', label: 'Molar mass of the key starting material', type: 'NUMBER', unit: 'g/mol', decimals: 2, limitSlot: 'mwKsm' },
          { id: 'mwApi', label: 'Molar mass of the API', type: 'NUMBER', unit: 'g/mol', decimals: 2, limitSlot: 'mwApi' },
          { id: 'actualYield', label: 'Actual yield against the batch size', type: 'CALC', expression: 'output / batchSize * 100 [%]', unit: '%', limitSlot: 'actualYield', critical: true },
          { id: 'molarYield', label: 'Molar yield against the key starting material', type: 'CALC', expression: 'output * mwKsm / (ksmQty * mwApi) * 100 [%]', unit: '%', limitSlot: 'molarYield', critical: true },
          { id: 'accounted', label: 'Accounted for (output, samples, losses)', type: 'CALC', expression: '(output + samples + losses) / batchSize * 100 [%]', unit: '%', limitSlot: 'accounted' },
        ],
      },
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    limits: {
      output: reg('kg', '0', '55.000'), samples: reg('kg', '0', '0.500'), losses: reg('kg', '0', '2.000'),
      mwKsm: reg('g/mol', '200.00', '200.00'), mwApi: reg('g/mol', '250.00', '250.00'),
      actualYield: reg('%', '85.0', '102.0'), molarYield: reg('%', '85.0', '102.0'), accounted: reg('%', '90.0', '103.0'),
    },
    // 40 kg of the key starting material (MW 200) gives at most 50 kg of the API (MW 250): 48 kg is 96 %.
    targets: { output: '48.000', samples: '0.200', losses: '0.800', mwKsm: '200.00', mwApi: '250.00' },
    equipmentClasses: { balanceClass: 'FLOOR-BALANCE-150KG' },
    bomLines: { ksmLine: 'L1' },
  },
  exampleInputs: { batchSize: { value: '50', unit: 'kg' }, ksmQty: { value: '40', unit: 'kg' } },
};

export const API_LABEL_CHECK: SeedItem = {
  definition: {
    code: 'API-LABEL-CHECK',
    version: 1,
    title: 'Label line check before packing',
    category: 'CONTROL',
    edition: 'substance',
    roles: ['CLEARANCE', 'VERIFICATION'],
    instructions:
      'Before packing, clear the area of every label of an earlier batch, then check one issued label against the master: product name, batch number, net quantity, retest or expiry date and storage conditions, and for a container leaving the site the manufacturer and the transport conditions. Attach a specimen label to the record.',
    sections: [
      {
        id: 'clearance',
        title: 'Line clearance',
        fields: [
          { id: 'area', label: 'Packing area', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'areaClass' },
          { id: 'noOldLabels', label: 'No label, container or material of an earlier batch left in the area', type: 'YES_NO', expected: true },
        ],
      },
      {
        id: 'label',
        title: 'Label checked against the master',
        fields: [
          { id: 'labelsIssued', label: 'Labels issued for the batch', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'labelsIssued' },
          { id: 'batchOnLabel', label: 'Batch number printed on the label', type: 'TEXT', pattern: '[A-Z0-9/-]{1,30}' },
          { id: 'name', label: 'Product name as the master', type: 'YES_NO', expected: true },
          { id: 'quantity', label: 'Net quantity field present', type: 'YES_NO', expected: true },
          { id: 'dates', label: 'Retest or expiry date as the lot\'s', type: 'YES_NO', expected: true },
          { id: 'storage', label: 'Storage conditions as the master', type: 'YES_NO', expected: true },
          { id: 'shipped', label: 'Manufacturer name and address and transport conditions present (containers leaving the site)', type: 'YES_NO', expected: true },
          { id: 'specimen', label: 'Specimen label attached to the record', type: 'YES_NO', expected: true },
        ],
      },
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    limits: { labelsIssued: reg('1', '1', '20') },
    targets: { labelsIssued: '4' },
    equipmentClasses: { areaClass: 'PACKING-ROOM' },
  },
};

/** Catalogue v1 of the API edition (A1b), in the order a one-step synthesis uses them. */
export const SUBSTANCE_SEEDS: readonly SeedItem[] = [API_DISP, API_CHARGE, API_REACT, API_IPC_COMPLETE, API_CRYST, API_FILTER, API_DRY, API_YIELD, API_LABEL_CHECK, API_PACK];
