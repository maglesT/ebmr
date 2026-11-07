/**
 * Ready-made library blocks of the API edition (`substance`; API plan `docs/build-plan/api/plan.md`, A1): catalogue v1
 * for a one-step synthesis to a packed API (A1b; the group `substance` of SEED_GROUPS). They are library data like the
 * capsule blocks: each renders in the one generic library-step form on the floor, with no screen of its own. In the
 * order a synthesis uses them:
 *   - API-DISP: dispensing a starting material, reagent or solvent by weight, each container against its bill-of-
 *     materials line and labelled as a sub-divided container (material, control number, quantity, retest date);
 *   - API-CHARGE: charging the dispensed containers into the clean reactor, each lot checked as its line;
 *   - API-REACT: the reaction: its temperature against limits at each round, its time a critical time limit;
 *   - API-IPC-COMPLETE: the completion check, repeated until the remaining starting material is within its limit;
 *   - API-CRYST: crystallisation (the seed lot of the formula, cooling to the final temperature, ageing);
 *   - API-FILTER and API-CENTRIFUGE: isolation, one block per type (the master names the equipment class), washing,
 *     the wet cake and the mother liquor as registered containers;
 *   - API-DRY: tray drying with the loss-on-drying loop (until the LOD passes);
 *   - API-YIELD: the actual yield against the expected yield (the batch size); a result outside its limits raises an
 *     exception, explained and investigated as a deviation;
 *   - API-LABEL-CHECK: line clearance of earlier labels and the label content checked against the master before use
 *     (the specimen label in the record is the G-21 step's, which does not close without it: EBMR-LBL-060);
 *   - API-PACK: packing into drums or bags (below).
 * A calculation reads only values of its own step, the batch size, formula lines or the lot assay (no earlier-step
 * value: the lead's rule for A1b). Each field names the binding clause it records (SM Part XII; ICH Q7, which is EU GMP
 * Part II); `critical` only where a clause names the parameter: the time limits (Q7 8.20), the in-process results
 * (8.30) and the yield (8.14) (lead audit of #143).
 *
 * API-PACK: the finished API into drums or bags, one container entry each (a container registered, its net mass, its
 * closure and its label checked). The labels themselves are issued and reconciled by the existing printed-materials
 * block (G-21) of the packaging master, not here.
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
    title: 'Pack the API into drums or bags',
    category: 'PACKAGING',
    edition: 'substance',
    instructions: 'Fill each drum or bag (inner liners tied, outer container closed and sealed), weigh it and label it with the product, batch, net quantity, retest or expiry date and storage conditions.',
    sections: [
      {
        id: 'container',
        title: 'Container filled and labelled',
        repeat: { kind: 'COUNT', countSlot: 'containers' },
        fields: [
          // SM Part XII 6.5.3; Q7 (EU GMP II) 6.52: the package of the batch.
          { id: 'container', label: 'Drum or bag', type: 'CONTAINER', action: 'REGISTER' },
          // SM Part XII 9.4.4; Q7 9.43: the quantity of contents the label states.
          { id: 'netMass', label: 'Net mass', type: 'NUMBER', unit: 'kg', decimals: 3, limitSlot: 'netMass' },
          // SM Part XII 9.4.7; Q7 9.46: a container leaving the manufacturer's control is sealed so a breach shows.
          { id: 'sealed', label: 'Liners tied and container sealed', type: 'YES_NO', expected: true },
          // SM Part XII 9.4.6; Q7 9.45: each packed and labelled container examined for the correct label.
          { id: 'labelOk', label: 'Label correct (product, batch, net quantity, retest or expiry date, storage)', type: 'YES_NO', expected: true },
        ],
      },
    ],
    signatures: [OPERATOR, VERIFIER],
  },
  exampleUse: {
    limits: { netMass: reg('kg', '24.950', '25.050') },
    targets: { netMass: '25.000' },
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
      'Weigh each container of the material named by its bill-of-materials line on the balance. Label each dispensed container with the material, its control number, the quantity and the retest date, and keep it closed until charging. A second person witnesses the weighing.',
    sections: [
      {
        id: 'setup',
        title: 'Set-up',
        fields: [
          // SM Part XII 8.1.1, 5.3.1; Q7 8.10, 5.30: a weighing device of suitable accuracy, calibrated.
          { id: 'weighBalance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
        ],
      },
      {
        id: 'weigh',
        title: 'Weigh per container',
        repeat: { kind: 'PER_CONTAINER' },
        fields: [
          // SM Part XII 6.5.3, 7.5; Q7 6.52, 7.50: each input lot identified, used only within its retest date.
          { id: 'lot', label: 'Material lot (released, within its retest date)', type: 'MATERIAL_LOT', bomLineSlot: 'materialLine' },
          // SM Part XII 8.1.2; Q7 8.11: the sub-divided container identified.
          { id: 'container', label: 'Dispensed container', type: 'CONTAINER', action: 'REGISTER' },
          // SM Part XII 8.1.3, 6.5.3; Q7 8.12, 6.52: the critical weighing, witnessed, and its quantity.
          { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg', bomLine: true, limitSlot: 'net' },
          // SM Part XII 8.1.2; Q7 8.11: the sub-divided container shows the material, control number, quantity and retest date.
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
      'Confirm the reactor is clean and labelled for this batch and its head space within the oxygen limit, then charge each dispensed container in the order of the master. Check each lot against its bill-of-materials line before it goes in.',
    sections: [
      {
        id: 'setup',
        title: 'Reactor ready',
        fields: [
          // SM Part XII 6.5.3; Q7 6.52: the major equipment used.
          { id: 'reactor', label: 'Reactor', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'reactorClass' },
          // SM Part XII 5.2.7, 8.1.7; Q7 5.26, 8.16: the equipment's cleanliness and processing status shown.
          { id: 'clean', label: 'Reactor clean, its status label shows this product and batch', type: 'YES_NO', expected: true },
          // SM Part XII 6.4.2, 6.5.3; Q7 6.41, 6.52: a process parameter of the master, its actual result recorded.
          { id: 'oxygen', label: 'Oxygen in the head space', type: 'NUMBER', unit: '%', decimals: 1, limitSlot: 'oxygen' },
        ],
      },
      {
        id: 'charge',
        title: 'Charge per container',
        repeat: { kind: 'PER_CONTAINER' },
        fields: [
          // SM Part XII 8.1.4, 6.5.3; Q7 8.13, 6.52: the material checked as the batch record names it before use.
          { id: 'lot', label: 'Material lot', type: 'MATERIAL_LOT', bomLineSlot: 'materialLine' },
          // SM Part XII 6.5.3; Q7 6.52: the input charged.
          { id: 'container', label: 'Dispensed container charged', type: 'CONTAINER', action: 'CONSUME' },
          // SM Part XII 6.4.2, 6.5.3; Q7 6.41, 6.52: a process parameter of the master, its actual result recorded.
          { id: 'massTemp', label: 'Reactor content temperature at charging', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'chargeTemp' },
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
      'Bring the reaction mass to the reaction temperature, start the reaction time and hold the temperature within its limits; record it at each round. The completion check is its own step.',
    sections: [
      {
        id: 'start',
        title: 'Start of reaction',
        fields: [
          // SM Part XII 6.5.3; Q7 6.52: the major equipment used.
          { id: 'reactor', label: 'Reactor', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'reactorClass' },
          // SM Part XII 6.4.2, 6.5.3; Q7 6.41, 6.52: a process parameter of the master, its actual result recorded.
          { id: 'reactionTemp', label: 'Reaction temperature reached', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'reactionTemp' },
          // SM Part XII 8.2.1; Q7 8.20: a time limit of the master, met or the deviation evaluated.
          { id: 'reactionTime', label: 'Reaction time', type: 'TIMER', durationUnit: 'min', limitSlot: 'reactionTime', critical: true },
        ],
      },
      {
        id: 'round',
        title: 'Reaction round',
        repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
        fields: [
          // SM Part XII 6.4.2, 6.5.3; Q7 6.41, 6.52: the process parameter at each round.
          { id: 'roundTemp', label: 'Reaction mass temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'roundTemp' },
        ],
      },
      {
        id: 'end',
        title: 'End of reaction',
        fields: [
          // SM Part XII 6.4.2, 6.5.3; Q7 6.41, 6.52: the process parameter at the end.
          { id: 'endTemp', label: 'Reaction mass temperature at the end', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'endTemp' },
        ],
      },
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    limits: { reactionTemp: reg('Cel', '60.0', '65.0'), reactionTime: reg('min', '45', '360'), roundTemp: reg('Cel', '60.0', '65.0'), endTemp: reg('Cel', '60.0', '65.0') },
    targets: { reactionTemp: '62.5', roundTemp: '62.5', endTemp: '62.5' },
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
          // SM Part XII 6.5.3, 8.3.1; Q7 6.52, 8.30: the in-process sample taken.
          { id: 'sample', label: 'Reaction mass sample', type: 'SAMPLE', unitsSlot: 'sampleUnits', purpose: 'Reaction completion' },
          // SM Part XII 5.3.1; Q7 5.30: the instrument used, calibrated.
          { id: 'instrument', label: 'Instrument (HPLC or GC)', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'instrumentClass' },
          // SM Part XII 8.3.1, 8.3.3; Q7 8.30, 8.32: the in-process control result against its QU-approved criterion.
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
      'At the seeding temperature add the seed of the bill of materials, cool to the final temperature, then age the slurry for the ageing time before isolation.',
    sections: [
      {
        id: 'seed',
        title: 'Seeding',
        fields: [
          // SM Part XII 6.5.3; Q7 6.52: the major equipment used.
          { id: 'crystalliser', label: 'Crystalliser', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'crystalliserClass' },
          // SM Part XII 6.4.2, 6.5.3; Q7 6.41, 6.52: a process parameter of the master, its actual result recorded.
          { id: 'seedTemp', label: 'Temperature at seeding', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'seedTemp' },
          // SM Part XII 6.5.3; Q7 6.52: the lot of each input.
          { id: 'seedLot', label: 'Seed lot', type: 'MATERIAL_LOT', bomLineSlot: 'seedLine' },
          // SM Part XII 6.5.3; Q7 6.52: the quantity of each input.
          { id: 'seedQty', label: 'Seed added', type: 'WEIGHING', unit: 'kg' },
        ],
      },
      {
        id: 'cool',
        title: 'Cooling and ageing',
        fields: [
          // SM Part XII 6.4.2, 6.5.3; Q7 6.41, 6.52: a process parameter of the master, its actual result recorded.
          { id: 'finalTemp', label: 'Final temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'finalTemp' },
          // SM Part XII 8.2.1; Q7 8.20: a time limit of the master, met or the deviation evaluated.
          { id: 'ageing', label: 'Ageing time', type: 'TIMER', durationUnit: 'min', limitSlot: 'ageing', critical: true },
        ],
      },
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    limits: { seedTemp: reg('Cel', '45.0', '50.0'), finalTemp: reg('Cel', '0.0', '5.0'), ageing: reg('min', '60', '240') },
    targets: { seedTemp: '47.5', finalTemp: '2.5' },
    equipmentClasses: { crystalliserClass: 'GLR-2000L' },
    bomLines: { seedLine: 'L3' },
  },
};

/** The isolation blocks share their wash and output sections; each block is one isolation type (the master's filterClass). */
const washSection = {
  id: 'wash',
  title: 'Cake wash',
  repeat: { kind: 'COUNT' as const, countSlot: 'washes' },
  fields: [
    // SM Part XII 6.5.3; Q7 6.52: the lot of each input.
    { id: 'washLot', label: 'Wash solvent lot', type: 'MATERIAL_LOT' as const, bomLineSlot: 'washLine' },
    // SM Part XII 6.4.2, 6.5.3; Q7 6.41, 6.52: the quantity of each input, against the master.
    { id: 'washVolume', label: 'Wash volume', type: 'NUMBER' as const, unit: 'L', decimals: 1, limitSlot: 'washVolume' },
  ],
};
const isolatedSection = {
  id: 'output',
  title: 'Wet cake and mother liquor',
  fields: [
    // SM Part XII 14.4.1; Q7 14.40: the mother liquor kept, identified, for any recovery under an approved procedure.
    { id: 'motherLiquor', label: 'Mother liquor container', type: 'CONTAINER' as const, action: 'REGISTER' as const },
    // SM Part XII 6.5.3; Q7 6.52: the output of the step.
    { id: 'container', label: 'Wet cake container', type: 'CONTAINER' as const, action: 'REGISTER' as const },
    // SM Part XII 6.5.3; Q7 6.52: the quantity of the output.
    { id: 'wetMass', label: 'Wet cake net weight', type: 'WEIGHING' as const, unit: 'kg' },
  ],
};

export const API_FILTER: SeedItem = {
  definition: {
    code: 'API-FILTER',
    version: 1,
    title: 'Isolation on a Nutsche filter, washing',
    category: 'PROCESS',
    edition: 'substance',
    instructions:
      'Filter the slurry under vacuum, wash the cake with the solvent of the master the number of times it gives, then unload the wet cake into a labelled container. Collect the mother liquor in a labelled container.',
    sections: [
      {
        id: 'setup',
        title: 'Set-up',
        fields: [
          // SM Part XII 6.5.3; Q7 6.52: the major equipment used.
          { id: 'filter', label: 'Nutsche filter', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'filterClass' },
          // SM Part XII 6.4.2, 6.5.3; Q7 6.41, 6.52: a process parameter of the master, its actual result recorded.
          { id: 'vacuum', label: 'Vacuum under the cloth', type: 'NUMBER', unit: 'kPa', decimals: 0, limitSlot: 'vacuum' },
        ],
      },
      washSection,
      isolatedSection,
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    limits: { vacuum: reg('kPa', '-90', '-60'), washVolume: reg('L', '45.0', '55.0') },
    targets: { vacuum: '-75', washVolume: '50.0' },
    equipmentClasses: { filterClass: 'NUTSCHE-1M2' },
    bomLines: { washLine: 'L2' },
    counts: { washes: '2' },
  },
};

export const API_CENTRIFUGE: SeedItem = {
  definition: {
    code: 'API-CENTRIFUGE',
    version: 1,
    title: 'Isolation in a centrifuge, washing',
    category: 'PROCESS',
    edition: 'substance',
    instructions:
      'Spin the slurry at the speed of the master, wash the cake with the solvent of the master the number of times it gives, then unload the wet cake into a labelled container. Collect the mother liquor in a labelled container.',
    sections: [
      {
        id: 'setup',
        title: 'Set-up',
        fields: [
          // SM Part XII 6.5.3; Q7 6.52: the major equipment used.
          { id: 'centrifuge', label: 'Centrifuge', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'centrifugeClass' },
          // SM Part XII 6.4.2, 6.5.3; Q7 6.41, 6.52: a process parameter of the master, its actual result recorded.
          { id: 'spin', label: 'Centrifuge speed', type: 'NUMBER', unit: '/min', decimals: 0, limitSlot: 'spin' },
        ],
      },
      washSection,
      isolatedSection,
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    limits: { spin: reg('/min', '800', '1200'), washVolume: reg('L', '45.0', '55.0') },
    targets: { spin: '1000', washVolume: '50.0' },
    equipmentClasses: { centrifugeClass: 'CENTRIFUGE-48IN' },
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
      'Load the wet cake onto the trays and dry at the set temperature. Test the loss on drying and dry on until it is within its limit, up to the number of checks the master allows. Unload and weigh the dry material.',
    sections: [
      {
        id: 'setup',
        title: 'Loading',
        fields: [
          // SM Part XII 6.5.3; Q7 6.52: the major equipment used.
          { id: 'dryer', label: 'Tray dryer', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'dryerClass' },
          // SM Part XII 6.5.3; Q7 6.52: the input of the step.
          { id: 'wetIn', label: 'Wet cake container', type: 'CONTAINER', action: 'CONSUME' },
          // SM Part XII 6.5.3; Q7 6.52: the quantity of the input.
          { id: 'wetMass', label: 'Wet cake loaded', type: 'WEIGHING', unit: 'kg' },
          // SM Part XII 6.4.2, 6.5.3; Q7 6.41, 6.52: a process parameter of the master, its actual result recorded.
          { id: 'dryerTemp', label: 'Dryer temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'dryerTemp' },
          // SM Part XII 8.2.1; Q7 8.20: a time limit of the master, met or the deviation evaluated.
          { id: 'drying', label: 'Drying time', type: 'TIMER', durationUnit: 'min', limitSlot: 'dryingTime', critical: true },
        ],
      },
      {
        id: 'lodLoop',
        title: 'LOD check',
        repeat: { kind: 'UNTIL_PASS', untilField: 'lod', maxRepeatsSlot: 'maxLodChecks' },
        fields: [
          // SM Part XII 6.5.3, 8.3.1; Q7 6.52, 8.30: the in-process sample taken.
          { id: 'sample', label: 'LOD sample', type: 'SAMPLE', unitsSlot: 'lodSampleUnits', purpose: 'Loss on drying' },
          // SM Part XII 8.3.1, 8.3.3; Q7 8.30, 8.32: the in-process control result against its QU-approved criterion.
          { id: 'lod', label: 'Loss on drying', type: 'NUMBER', unit: '%', decimals: 2, limitSlot: 'lod', critical: true },
        ],
      },
      {
        id: 'output',
        title: 'Dry material',
        fields: [
          // SM Part XII 6.5.3; Q7 6.52: the output of the step.
          { id: 'container', label: 'Dry material container', type: 'CONTAINER', action: 'REGISTER' },
          // SM Part XII 6.5.3; Q7 6.52: the quantity of the output.
          { id: 'dryMass', label: 'Dry material net weight', type: 'WEIGHING', unit: 'kg' },
        ],
      },
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    limits: { dryerTemp: reg('Cel', '55.0', '65.0'), dryingTime: reg('min', '60', '900'), lod: reg('%', '0.00', '0.50') },
    targets: { dryerTemp: '60.0', lod: '0.30' },
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
      'Weigh the dry API. The actual yield is worked out against the expected yield (the batch size); a yield outside its limits is explained and investigated as a deviation.',
    inputs: [
      // SM Part XII 8.1.5; Q7 8.14: the expected yield the actual one is compared with.
      { id: 'batchSize', label: 'Batch size (expected output)', kind: 'BATCH_SIZE', unit: 'kg' },
    ],
    sections: [
      {
        id: 'yield',
        title: 'Yield',
        fields: [
          // SM Part XII 8.1.1, 5.3.1; Q7 8.10, 5.30: a weighing device of suitable accuracy, calibrated.
          { id: 'weighBalance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
          // SM Part XII 6.5.3; Q7 6.52: the actual output.
          { id: 'output', label: 'Dry API weight', type: 'WEIGHING', unit: 'kg' },
          // SM Part XII 8.1.5, 8.1.6; Q7 8.14, 8.15: the actual against the expected yield; outside its range, a deviation.
          { id: 'actualYield', label: 'Actual yield against the batch size', type: 'CALC', expression: 'output / batchSize * 100 [%]', unit: '%', limitSlot: 'actualYield', critical: true },
        ],
      },
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    limits: { actualYield: reg('%', '85.0', '102.0') },
    equipmentClasses: { balanceClass: 'FLOOR-BALANCE-150KG' },
  },
  // A weighing with no limit slot runs nominally at 1 kg, so the example batch is 1 kg (100 %); 0.80 kg would be 80 %.
  exampleInputs: { batchSize: { value: '1', unit: 'kg' } },
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
      'Before packing, clear the area of every label of an earlier batch, then check one issued label against the master: product name, batch number, net quantity, retest or expiry date and storage conditions, and for a container leaving the site the manufacturer and the transport conditions. The labels are issued, reconciled and kept as a specimen in the record by the printed-materials step (G-21).',
    sections: [
      {
        id: 'clearance',
        title: 'Line clearance',
        fields: [
          // SM Part XII 9.4.5; Q7 9.44: the packaging and labelling area inspected immediately before use.
          { id: 'area', label: 'Packing area', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'areaClass' },
          // SM Part XII 9.4.5; Q7 9.44: no material not needed for this operation left in the area.
          { id: 'noOldLabels', label: 'No label, container or material of an earlier batch left in the area', type: 'YES_NO', expected: true },
        ],
      },
      {
        id: 'label',
        title: 'Label checked against the master',
        fields: [
          // SM Part XII 9.4.3; Q7 9.42: the label shows the batch number.
          { id: 'batchOnLabel', label: 'Batch number as the batch\'s', type: 'YES_NO', expected: true },
          // SM Part XII 9.4.3; Q7 9.42: the label shows the name of the material.
          { id: 'name', label: 'Product name as the master', type: 'YES_NO', expected: true },
          // SM Part XII 9.4.4; Q7 9.43: the quantity of contents.
          { id: 'quantity', label: 'Net quantity field present', type: 'YES_NO', expected: true },
          // SM Part XII 9.4.4, 11.5.2; Q7 9.43, 11.61: the retest or expiry date.
          { id: 'dates', label: 'Retest or expiry date as the lot\'s', type: 'YES_NO', expected: true },
          // SM Part XII 9.4.3; Q7 9.42: the storage conditions.
          { id: 'storage', label: 'Storage conditions as the master', type: 'YES_NO', expected: true },
          // SM Part XII 9.4.4; Q7 9.43: outside the manufacturer's control, the manufacturer's name and address and transport conditions.
          { id: 'shipped', label: 'Manufacturer name and address and transport conditions present (containers leaving the site)', type: 'YES_NO', expected: true },
        ],
      },
    ],
    signatures: SIGNED,
  },
  exampleUse: {
    equipmentClasses: { areaClass: 'PACKING-ROOM' },
  },
};

/** Catalogue v1 of the API edition (A1b), in the order a one-step synthesis uses them; the isolation is one block per type. */
export const SUBSTANCE_SEEDS: readonly SeedItem[] = [API_DISP, API_CHARGE, API_REACT, API_IPC_COMPLETE, API_CRYST, API_FILTER, API_CENTRIFUGE, API_DRY, API_YIELD, API_LABEL_CHECK, API_PACK];
