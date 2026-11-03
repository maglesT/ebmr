/**
 * Ready-made library blocks: release tests (decision 0026, S8). See types.ts.
 *
 * Invented example values. A reference limit paraphrases a common compendial value in its note and quotes no text.
 */
import type { LimitSpec } from '../../limits/model.ts';
import type { FieldDef } from '../model.ts';
import type { SeedItem } from './types.ts';

const QC = [
  { meaning: 'PERFORMED' as const, role: 'QC_ANALYST' },
  { meaning: 'VERIFIED' as const, role: 'QC_REVIEWER' },
];

/** A registered limit range from the product specification (inclusive bounds). */
const spec = (unit: string, low?: string, high?: string): LimitSpec => ({
  unit,
  ranges: [{ tier: 'REGISTERED', ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'SPEC-REF' } }],
});

/** Method, instrument and system suitability: the head of every chromatographic or instrumental test. */
const methodHead = (instrumentLabel: string): FieldDef[] => [
  { id: 'method', label: 'Test method and version', type: 'TEXT' },
  { id: 'instrument', label: instrumentLabel, type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'instrumentClass' },
  { id: 'suitability', label: 'System suitability met', type: 'YES_NO', expected: true },
];

/** Dissolution conditions: apparatus, medium temperature and speed (CPPs of the test). */
const dissolutionHead: FieldDef[] = [
  { id: 'method', label: 'Test method and version', type: 'TEXT' },
  { id: 'apparatus', label: 'Dissolution apparatus', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'apparatusClass' },
  { id: 'mediumTemp', label: 'Medium temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'mediumTemp', critical: true },
  { id: 'speed', label: 'Paddle or basket speed', type: 'NUMBER', unit: '/min', decimals: 0, limitSlot: 'speed', critical: true },
];
const dissolutionConditions = {
  limits: { mediumTemp: spec('Cel', '36.5', '37.5'), speed: spec('/min', '48', '52') },
  targets: { mediumTemp: '37.0', speed: '50' },
};

export const RELEASE_TEST_SEEDS: readonly SeedItem[] = [
  {
    definition: {
      code: 'REL-ASSAY',
      version: 1,
      title: 'Assay',
      category: 'TEST_RELEASE',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            ...methodHead('Chromatograph'),
            {
              id: 'assay',
              label: 'Assay of each preparation (% of label claim)',
              type: 'TEST_RESULT',
              unit: '%',
              replicatesSlot: 'preparations',
              statistics: [
                { statistic: 'MEAN', limitSlot: 'assayMean' },
                { statistic: 'RSD', limitSlot: 'assayRsd' },
              ],
            },
          ],
        },
      ],
      signatures: QC,
    },
    exampleUse: {
      limits: { assayMean: spec('%', '95.0', '105.0'), assayRsd: spec('%', undefined, '2.0') },
      equipmentClasses: { instrumentClass: 'HPLC' },
      counts: { preparations: '2' },
    },
  },
  {
    definition: {
      code: 'REL-DISSO-SINGLE',
      version: 1,
      title: 'Dissolution (single time point)',
      category: 'TEST_RELEASE',
      instructions: 'Record the amount released from each unit at the time point of the method. A further stage, if needed, is a new test record.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            ...dissolutionHead,
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
      limits: { ...dissolutionConditions.limits, releasedIndividual: spec('%', '85'), releasedMean: spec('%', '85') },
      targets: dissolutionConditions.targets,
      equipmentClasses: { apparatusClass: 'DISSOLUTION-PADDLE' },
      counts: { vessels: '6' },
    },
  },
  {
    definition: {
      code: 'REL-DISSO-PROFILE',
      version: 1,
      title: 'Dissolution profile',
      category: 'TEST_RELEASE',
      instructions: 'Record the amount released from each unit at each time point the formulation lists.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            ...dissolutionHead,
            {
              id: 'released',
              label: 'Released (% of label claim)',
              type: 'TEST_RESULT',
              unit: '%',
              replicatesSlot: 'vessels',
              statistics: [
                { statistic: 'INDIVIDUAL', limitSlot: 'individual' },
                { statistic: 'MEAN', limitSlot: 'mean' },
              ],
              perPoint: true,
            },
          ],
        },
      ],
      signatures: QC,
    },
    exampleUse: {
      ...dissolutionConditions,
      equipmentClasses: { apparatusClass: 'DISSOLUTION-BASKET' },
      counts: { vessels: '6' },
      points: {
        released: [
          { id: 'h1', label: '1 h', limits: spec('%', '20', '40') },
          { id: 'h4', label: '4 h', limits: spec('%', '45', '70') },
          { id: 'h8', label: '8 h', limits: spec('%', '80') },
        ],
      },
    },
  },
  {
    definition: {
      code: 'REL-DISSO-TWO-STAGE',
      version: 1,
      title: 'Dissolution, acid stage then buffer stage',
      category: 'TEST_RELEASE',
      instructions: 'Run the units in the acid medium, sample, then change to the buffer medium and sample. Each stage has its own limits.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            ...dissolutionHead,
            {
              id: 'released',
              label: 'Released at each stage (% of label claim)',
              type: 'TEST_RESULT',
              unit: '%',
              replicatesSlot: 'vessels',
              statistics: [
                { statistic: 'INDIVIDUAL', limitSlot: 'individual' },
                { statistic: 'MEAN', limitSlot: 'mean' },
              ],
              perPoint: true,
            },
          ],
        },
      ],
      signatures: QC,
    },
    exampleUse: {
      ...dissolutionConditions,
      equipmentClasses: { apparatusClass: 'DISSOLUTION-PADDLE' },
      counts: { vessels: '6' },
      points: {
        released: [
          { id: 'acid', label: 'Acid stage, 2 h', limits: spec('%', undefined, '10') },
          { id: 'buffer', label: 'Buffer stage, 45 min', limits: spec('%', '80') },
        ],
      },
    },
  },
  {
    definition: {
      code: 'REL-CONTENT-UNIFORMITY',
      version: 1,
      title: 'Content uniformity',
      category: 'TEST_RELEASE',
      instructions: 'First stage only: assay 10 units separately and record each result as % of the label claim. The acceptance value here holds for 10 units; a second stage (further units, another constant) is not this block.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            ...methodHead('Chromatograph'),
            {
              id: 'content',
              label: 'Content of each unit (% of label claim)',
              type: 'TEST_RESULT',
              unit: '%',
              replicatesSlot: 'units',
              statistics: [
                { statistic: 'MEAN', limitSlot: 'contentMean' },
                { statistic: 'INDIVIDUAL', limitSlot: 'contentIndividual' },
                { statistic: 'RSD', limitSlot: 'contentRsd' },
              ],
            },
            { id: 'unitMean', label: 'Mean content', type: 'CALC', expression: 'mean(content)', unit: '%' },
            { id: 'unitSd', label: 'Standard deviation of content', type: 'CALC', expression: 'sd(content)', unit: '%' },
            { id: 'tenUnits', label: 'First stage: 10 units tested (1 yes, 0 no)', help: 'The acceptance value below is the first-stage one, defined for exactly 10 units; another number of units gives 0, which is out of limits.', type: 'CALC', expression: 'count(content) == 10 ? 1 : 0', unit: '1', limitSlot: 'tenUnits', critical: true },
            {
              id: 'acceptanceValue',
              label: 'Acceptance value (first stage, 10 units)',
              help: 'First stage only: distance of the mean from the 98.5 to 101.5 % window plus 2.4 times the standard deviation; valid for exactly 10 units and a target content of 100 %.',
              type: 'CALC',
              expression: 'abs(min(max(unitMean, 98.5 [%]), 101.5 [%]) - unitMean) + 2.4 * unitSd',
              unit: '%',
              limitSlot: 'acceptanceValue',
              critical: true,
            },
          ],
        },
      ],
      signatures: QC,
      referenceLimits: {
        acceptanceValue: { unit: '%', high: '15.0', note: 'A common compendial maximum acceptance value at the first stage' },
        tenUnits: { unit: '1', low: '1', high: '1', note: 'The first-stage acceptance value (constant 2.4, maximum 15.0) is defined for 10 units' },
      },
    },
    exampleUse: {
      limits: { contentMean: spec('%', '95.0', '105.0'), contentIndividual: spec('%', '85.0', '115.0'), contentRsd: spec('%', undefined, '6.0'), acceptanceValue: spec('%', undefined, '15.0'), tenUnits: spec('1', '1', '1') },
      equipmentClasses: { instrumentClass: 'HPLC' },
      counts: { units: '10' },
    },
  },
  {
    definition: {
      code: 'REL-UNIFORMITY-OF-MASS',
      version: 1,
      title: 'Uniformity of mass',
      category: 'TEST_RELEASE',
      instructions: 'Weigh the units one by one. The individual limits are the product limits around the average mass.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'weighBalance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
            {
              id: 'mass',
              label: 'Mass of each unit',
              type: 'TEST_RESULT',
              unit: 'mg',
              replicatesSlot: 'units',
              statistics: [
                { statistic: 'MEAN', limitSlot: 'meanMass' },
                { statistic: 'INDIVIDUAL', limitSlot: 'individualMass' },
              ],
            },
          ],
        },
      ],
      signatures: QC,
    },
    exampleUse: {
      limits: { meanMass: spec('mg', '245.0', '255.0'), individualMass: spec('mg', '237.5', '262.5') },
      equipmentClasses: { balanceClass: 'ANALYTICAL-BALANCE' },
      counts: { units: '20' },
    },
  },
  {
    definition: {
      code: 'REL-RELATED-SUBSTANCES',
      version: 1,
      title: 'Related substances',
      category: 'TEST_RELEASE',
      instructions: 'Report each named impurity, the largest unknown impurity and the total of all impurities above the reporting threshold.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            ...methodHead('Chromatograph'),
            { id: 'impurityA', label: 'Named impurity A', type: 'NUMBER', unit: '%', decimals: 2, limitSlot: 'impurityA', critical: true },
            { id: 'impurityB', label: 'Named impurity B', type: 'NUMBER', unit: '%', decimals: 2, limitSlot: 'impurityB', critical: true },
            { id: 'largestUnknown', label: 'Largest unknown impurity', type: 'NUMBER', unit: '%', decimals: 2, limitSlot: 'largestUnknown', critical: true },
            { id: 'total', label: 'Total impurities', type: 'NUMBER', unit: '%', decimals: 2, limitSlot: 'total', critical: true },
          ],
        },
      ],
      signatures: QC,
    },
    exampleUse: {
      limits: { impurityA: spec('%', undefined, '0.50'), impurityB: spec('%', undefined, '0.30'), largestUnknown: spec('%', undefined, '0.20'), total: spec('%', undefined, '1.00') },
      equipmentClasses: { instrumentClass: 'HPLC' },
    },
  },
  {
    definition: {
      code: 'REL-WATER-KF',
      version: 1,
      title: 'Water content (Karl Fischer)',
      category: 'TEST_RELEASE',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            ...methodHead('Karl Fischer titrator'),
            { id: 'sampleMass', label: 'Sample mass', type: 'NUMBER', unit: 'g', decimals: 4 },
            { id: 'water', label: 'Water content', type: 'NUMBER', unit: '%', decimals: 2, limitSlot: 'water', critical: true },
          ],
        },
      ],
      signatures: QC,
    },
    exampleUse: { limits: { water: spec('%', undefined, '5.00') }, equipmentClasses: { instrumentClass: 'KF-TITRATOR' } },
  },
  {
    definition: {
      code: 'REL-MICROBIAL-LIMITS',
      version: 1,
      title: 'Microbial limits',
      category: 'TEST_RELEASE',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'method', label: 'Test method and version', type: 'TEXT' },
            { id: 'incubator', label: 'Incubator', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'incubatorClass' },
            { id: 'tamc', label: 'Total aerobic microbial count', type: 'NUMBER', unit: '{CFU}/g', decimals: 0, limitSlot: 'tamc', critical: true },
            { id: 'tymc', label: 'Total combined yeasts and moulds count', type: 'NUMBER', unit: '{CFU}/g', decimals: 0, limitSlot: 'tymc', critical: true },
            { id: 'eColiAbsent', label: 'Escherichia coli absent in the quantity tested', type: 'YES_NO', expected: true },
            { id: 'controlsValid', label: 'Positive and negative controls valid', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: QC,
      referenceLimits: {
        tamc: { unit: '{CFU}/g', high: '1000', note: 'A common compendial acceptance for non-aqueous oral preparations (ten to the third per gram)' },
        tymc: { unit: '{CFU}/g', high: '100', note: 'A common compendial acceptance for non-aqueous oral preparations (ten to the second per gram)' },
      },
    },
    exampleUse: { limits: { tamc: spec('{CFU}/g', undefined, '1000'), tymc: spec('{CFU}/g', undefined, '100') }, equipmentClasses: { incubatorClass: 'INCUBATOR' } },
  },
  {
    definition: {
      code: 'REL-IDENTIFICATION',
      version: 1,
      title: 'Identification',
      category: 'TEST_RELEASE',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'technique', label: 'Technique', type: 'CHOICE', options: ['Infrared spectrum', 'Retention time', 'Ultraviolet spectrum', 'Chemical test'] },
            { id: 'method', label: 'Test method and version', type: 'TEXT' },
            { id: 'instrument', label: 'Instrument', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'instrumentClass' },
            { id: 'result', label: 'Result against the reference standard', type: 'CHOICE', options: ['Complies', 'Does not comply'], notAllowed: ['Does not comply'] },
          ],
        },
      ],
      signatures: QC,
    },
    exampleUse: { equipmentClasses: { instrumentClass: 'FTIR' } },
  },
  {
    definition: {
      code: 'REL-RESIDUAL-SOLVENTS',
      version: 1,
      title: 'Residual solvents',
      category: 'TEST_RELEASE',
      instructions: 'Record the solvents the formulation names; a solvent not used in the process is not tested unless the method asks for it.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            ...methodHead('Gas chromatograph'),
            { id: 'solvent1Name', label: 'First solvent', type: 'TEXT' },
            { id: 'solvent1', label: 'First solvent content', type: 'NUMBER', unit: '[ppm]', decimals: 0, limitSlot: 'solvent1', critical: true },
            { id: 'secondSolvent', label: 'A second solvent is tested', type: 'YES_NO' },
            { id: 'solvent2Name', label: 'Second solvent', type: 'TEXT', showWhen: { field: 'secondSolvent', equals: true } },
            { id: 'solvent2', label: 'Second solvent content', type: 'NUMBER', unit: '[ppm]', decimals: 0, limitSlot: 'solvent2', critical: true, showWhen: { field: 'secondSolvent', equals: true } },
          ],
        },
      ],
      signatures: QC,
    },
    exampleUse: { limits: { solvent1: spec('[ppm]', undefined, '3000'), solvent2: spec('[ppm]', undefined, '5000') }, equipmentClasses: { instrumentClass: 'GC-HEADSPACE' } },
  },
];
