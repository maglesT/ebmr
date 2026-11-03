/**
 * Ready-made library blocks: hard capsules (decision 0026, owner direction 2 November 2026, within the eleven slices).
 * Filling (the filler, the capsule size, the empty shells' lot, the fill weight and machine speed at each round),
 * polishing and sorting, and the capsule's own in-process tests (fill weight variation, locked length, appearance,
 * disintegration), and a capsule dissolution test (QC's, with sinkers). The empty capsule shells are a material like any
 * other: their lot is named in the filling step and checked against the lot register (S6). See types.ts.
 *
 * Invented example values (a size 0 capsule, 300 mg fill). A reference limit paraphrases a common compendial value in
 * its note and quotes no text.
 */
import type { LimitSpec } from '../../limits/model.ts';
import type { SeedItem } from './types.ts';

const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const VERIFIER = { meaning: 'VERIFIED' as const, role: 'PRODUCTION_VERIFIER' };
const QC = [
  { meaning: 'PERFORMED' as const, role: 'QC_ANALYST' },
  { meaning: 'VERIFIED' as const, role: 'QC_REVIEWER' },
];

/** A registered limit range from the product specification (inclusive bounds). */
const spec = (unit: string, low?: string, high?: string): LimitSpec => ({
  unit,
  ranges: [{ tier: 'REGISTERED', ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'SPEC-REF' } }],
});

/** The capsule sizes a filler takes (change parts per size). */
const SIZES = ['000', '00', '0', '1', '2', '3', '4'];

export const CAPSULE_SEEDS: readonly SeedItem[] = [
  {
    definition: {
      code: 'PROC-CAPS-FILL',
      version: 1,
      title: 'Capsule filling (hard capsules)',
      category: 'PROCESS',
      instructions: 'Fit the change parts of the capsule size, load the empty shells and the blend, and run at the set speed. Record the fill weight and speed at each round; the weight tests are their own steps.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'filler', label: 'Capsule filling machine', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'fillerClass' },
            { id: 'capsuleSize', label: 'Capsule size (change parts fitted)', type: 'CHOICE', options: SIZES },
            { id: 'shellLot', label: 'Empty capsule shells lot', type: 'MATERIAL_LOT' },
            { id: 'shellsInspected', label: 'Shells of the right colour and print, free of dents and splits', type: 'YES_NO', expected: true },
            { id: 'blendIn', label: 'Blend container', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'round',
          title: 'Filling round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
            { id: 'fillWeight', label: 'Average fill weight', type: 'NUMBER', unit: 'mg', decimals: 1, limitSlot: 'fillWeight', critical: true },
            { id: 'speed', label: 'Machine speed', type: 'NUMBER', unit: '/h', decimals: 0, limitSlot: 'speed' },
            { id: 'locked', label: 'Capsules closed and locked, none split', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            { id: 'container', label: 'Filled capsules container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
            { id: 'rejects', label: 'Rejected capsules', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { fillWeight: spec('mg', '285.0', '315.0'), speed: spec('/h', '60000', '90000') },
      targets: { fillWeight: '300.0', speed: '75000' },
      equipmentClasses: { fillerClass: 'CAPSULE-FILLER-AUTO' },
      intervals: { roundInterval: { value: '30', unit: 'min' } },
    },
  },
  {
    definition: {
      code: 'PROC-CAPS-POLISH',
      version: 1,
      title: 'Capsule polishing and sorting',
      category: 'PROCESS',
      instructions: 'Polish the filled capsules and run them through the sorter, which rejects empty, light and split capsules. Challenge the sorter before the run.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'polisher', label: 'Polishing and sorting machine', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'polisherClass' },
            { id: 'sorterChallenged', label: 'Sorter challenge passed (empty and split test capsules rejected)', type: 'YES_NO', expected: true },
            { id: 'filledIn', label: 'Filled capsules container', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            { id: 'appearance', label: 'Polished capsules clean and glossy', type: 'YES_NO', expected: true },
            { id: 'container', label: 'Polished capsules container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
            { id: 'rejects', label: 'Sorted-out capsules', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { polisherClass: 'CAPSULE-POLISHER' },
    },
  },
  {
    definition: {
      code: 'IPC-CAPS-FILL-WEIGHT',
      version: 1,
      title: 'Fill weight variation (capsules)',
      category: 'TEST_IPC',
      instructions: 'Weigh the filled capsules the formulation names one by one. The limits are the product limits on the filled-capsule weight.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'weighBalance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
            {
              id: 'weights',
              label: 'Individual filled-capsule weights',
              type: 'TEST_RESULT',
              unit: 'mg',
              replicatesSlot: 'capsules',
              statistics: [
                { statistic: 'MEAN', limitSlot: 'meanWeight' },
                { statistic: 'INDIVIDUAL', limitSlot: 'individualWeight' },
              ],
            },
          ],
        },
      ],
      signatures: [OPERATOR],
    },
    exampleUse: {
      limits: { meanWeight: spec('mg', '385.0', '407.0'), individualWeight: spec('mg', '370.0', '422.0') },
      equipmentClasses: { balanceClass: 'ANALYTICAL-BALANCE' },
      counts: { capsules: '20' },
    },
  },
  {
    definition: {
      code: 'IPC-CAPS-LOCK-LENGTH',
      version: 1,
      title: 'Locked length (capsules)',
      category: 'TEST_IPC',
      instructions: 'Measure the locked length of the capsules the formulation names. Too short: the capsule is crushed; too long: it may open.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'gauge', label: 'Length gauge', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'gaugeClass' },
            {
              id: 'length',
              label: 'Locked length of each capsule',
              type: 'TEST_RESULT',
              unit: 'mm',
              replicatesSlot: 'capsules',
              statistics: [
                { statistic: 'MIN', limitSlot: 'minLength' },
                { statistic: 'MAX', limitSlot: 'maxLength' },
              ],
            },
          ],
        },
      ],
      signatures: [OPERATOR],
    },
    exampleUse: {
      limits: { minLength: spec('mm', '21.30', '22.10'), maxLength: spec('mm', '21.30', '22.10') },
      equipmentClasses: { gaugeClass: 'LENGTH-GAUGE' },
      counts: { capsules: '10' },
    },
  },
  {
    definition: {
      code: 'IPC-CAPS-APPEARANCE',
      version: 1,
      title: 'Appearance (capsules)',
      category: 'TEST_IPC',
      instructions: 'Examine the sample of filled capsules: shell colour and print, closure, dents, splits and powder on the surface.',
      sections: [
        {
          id: 'test',
          title: 'Examination',
          fields: [
            { id: 'sample', label: 'Capsules examined', type: 'SAMPLE', unitsSlot: 'capsules', purpose: 'Appearance' },
            { id: 'colourPrint', label: 'Colour and print as the specification', type: 'YES_NO', expected: true },
            { id: 'closed', label: 'All capsules closed, none split or dented', type: 'YES_NO', expected: true },
            { id: 'clean', label: 'No powder on the surface', type: 'YES_NO', expected: true },
            { id: 'defects', label: 'Defective capsules found', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'defects', critical: true },
          ],
        },
      ],
      signatures: [OPERATOR],
    },
    exampleUse: {
      limits: { defects: spec('1', '0', '0') },
      counts: { capsules: '50' },
    },
  },
  {
    definition: {
      code: 'IPC-CAPS-DT',
      version: 1,
      title: 'Disintegration time (capsules)',
      category: 'TEST_IPC',
      instructions: 'Run the capsules with discs if the method says so; a capsule whose shell fragments remain is disintegrated.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'apparatus', label: 'Disintegration apparatus', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'apparatusClass' },
            { id: 'discs', label: 'Discs used as the method says', type: 'YES_NO', expected: true },
            { id: 'mediumTemp', label: 'Medium temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'mediumTemp', critical: true },
            {
              id: 'time',
              label: 'Time for each capsule to disintegrate',
              type: 'TEST_RESULT',
              unit: 'min',
              replicatesSlot: 'capsules',
              statistics: [{ statistic: 'MAX', limitSlot: 'maxTime' }],
            },
          ],
        },
      ],
      signatures: [OPERATOR],
      referenceLimits: { maxTime: { unit: 'min', high: '30', note: 'A common compendial maximum for hard capsules' } },
    },
    exampleUse: {
      limits: { mediumTemp: spec('Cel', '35.0', '39.0'), maxTime: spec('min', undefined, '15') },
      targets: { mediumTemp: '37.0' },
      equipmentClasses: { apparatusClass: 'DT-APPARATUS' },
      counts: { capsules: '6' },
    },
  },
];

/** QC's release test of a capsule product (QC roles: not on the floor; see the role gap in decision 0026). */
export const CAPSULE_RELEASE_SEEDS: readonly SeedItem[] = [
  {
    definition: {
      code: 'REL-CAPS-DISSO',
      version: 1,
      title: 'Dissolution (capsules, with sinkers)',
      category: 'TEST_RELEASE',
      instructions: 'Use the sinkers the method names so the capsules do not float. Record the amount released from each unit at the time point.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'method', label: 'Test method and version', type: 'TEXT' },
            { id: 'apparatus', label: 'Dissolution apparatus', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'apparatusClass' },
            { id: 'sinkers', label: 'Sinkers used as the method says', type: 'YES_NO', expected: true },
            { id: 'mediumTemp', label: 'Medium temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'mediumTemp', critical: true },
            { id: 'speed', label: 'Rotation speed', type: 'NUMBER', unit: '/min', decimals: 0, limitSlot: 'speed', critical: true },
            {
              id: 'released',
              label: 'Released from each unit (% of label claim)',
              type: 'TEST_RESULT',
              unit: '%',
              replicatesSlot: 'vessels',
              statistics: [
                { statistic: 'INDIVIDUAL', limitSlot: 'releasedIndividual' },
                { statistic: 'MEAN', limitSlot: 'releasedMean' },
              ],
            },
          ],
        },
      ],
      signatures: QC,
    },
    exampleUse: {
      limits: { mediumTemp: spec('Cel', '36.5', '37.5'), speed: spec('/min', '98', '102'), releasedIndividual: spec('%', '80'), releasedMean: spec('%', '80') },
      targets: { mediumTemp: '37.0', speed: '100' },
      equipmentClasses: { apparatusClass: 'DISSOLUTION-BASKET' },
      counts: { vessels: '6' },
    },
  },
];
