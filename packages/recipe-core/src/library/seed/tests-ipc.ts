/**
 * Ready-made library blocks: in-process tests (decision 0026, S8). See types.ts.
 *
 * Invented example values. A reference limit paraphrases a common compendial value in its note and quotes no text.
 */
import type { LimitSpec } from '../../limits/model.ts';
import type { SeedItem } from './types.ts';

const IPC = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };

/** A registered limit range from the product specification (inclusive bounds). */
const spec = (unit: string, low?: string, high?: string): LimitSpec => ({
  unit,
  ranges: [{ tier: 'REGISTERED', ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'SPEC-REF' } }],
});

export const IPC_TEST_SEEDS: readonly SeedItem[] = [
  {
    definition: {
      code: 'IPC-AVG-WEIGHT',
      version: 1,
      title: 'Average weight (compression rounds)',
      category: 'TEST_IPC',
      instructions: 'At each round, take the tablets the formulation names from the running press and weigh them one by one.',
      sections: [
        { id: 'setup', title: 'Set-up', fields: [{ id: 'balance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' }] },
        {
          id: 'round',
          title: 'IPC round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'checkInterval' },
          fields: [
            {
              id: 'weights',
              label: 'Individual tablet weights',
              type: 'TEST_RESULT',
              unit: 'mg',
              replicatesSlot: 'tabletsPerRound',
              statistics: [
                { statistic: 'MEAN', limitSlot: 'meanWeight' },
                { statistic: 'INDIVIDUAL', limitSlot: 'individualWeight' },
              ],
            },
          ],
        },
      ],
      signatures: [IPC],
    },
    exampleUse: {
      limits: { meanWeight: spec('mg', '245.0', '255.0'), individualWeight: spec('mg', '237.5', '262.5') },
      equipmentClasses: { balanceClass: 'ANALYTICAL-BALANCE' },
      counts: { tabletsPerRound: '10' },
      intervals: { checkInterval: { value: '30', unit: 'min' } },
    },
  },
  {
    definition: {
      code: 'IPC-WEIGHT-UNIFORMITY',
      version: 1,
      title: 'Uniformity of weight',
      category: 'TEST_IPC',
      instructions: 'Weigh the tablets the formulation names one by one. The individual limits are the product limits around the average weight.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'balance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
            {
              id: 'weights',
              label: 'Individual tablet weights',
              type: 'TEST_RESULT',
              unit: 'mg',
              replicatesSlot: 'tablets',
              statistics: [
                { statistic: 'MEAN', limitSlot: 'meanWeight' },
                { statistic: 'INDIVIDUAL', limitSlot: 'individualWeight' },
                { statistic: 'RSD', limitSlot: 'weightRsd' },
              ],
            },
          ],
        },
      ],
      signatures: [IPC],
    },
    exampleUse: {
      limits: { meanWeight: spec('mg', '245.0', '255.0'), individualWeight: spec('mg', '237.5', '262.5'), weightRsd: spec('%', undefined, '2.0') },
      equipmentClasses: { balanceClass: 'ANALYTICAL-BALANCE' },
      counts: { tablets: '20' },
    },
  },
  {
    definition: {
      code: 'IPC-HARDNESS',
      version: 1,
      title: 'Hardness (breaking force)',
      category: 'TEST_IPC',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'tester', label: 'Hardness tester', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'testerClass' },
            {
              id: 'force',
              label: 'Breaking force of each tablet',
              type: 'TEST_RESULT',
              unit: 'N',
              replicatesSlot: 'tablets',
              statistics: [
                { statistic: 'MEAN', limitSlot: 'meanForce' },
                { statistic: 'MIN', limitSlot: 'minForce' },
                { statistic: 'MAX', limitSlot: 'maxForce' },
              ],
            },
          ],
        },
      ],
      signatures: [IPC],
    },
    exampleUse: {
      limits: { meanForce: spec('N', '80', '120'), minForce: spec('N', '60'), maxForce: spec('N', undefined, '150') },
      equipmentClasses: { testerClass: 'HARDNESS-TESTER' },
      counts: { tablets: '10' },
    },
  },
  {
    definition: {
      code: 'IPC-THICKNESS',
      version: 1,
      title: 'Thickness',
      category: 'TEST_IPC',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'gauge', label: 'Thickness gauge', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'gaugeClass' },
            {
              id: 'thickness',
              label: 'Thickness of each tablet',
              type: 'TEST_RESULT',
              unit: 'mm',
              replicatesSlot: 'tablets',
              statistics: [
                { statistic: 'MEAN', limitSlot: 'meanThickness' },
                { statistic: 'INDIVIDUAL', limitSlot: 'individualThickness' },
              ],
            },
          ],
        },
      ],
      signatures: [IPC],
    },
    exampleUse: {
      limits: { meanThickness: spec('mm', '4.10', '4.30'), individualThickness: spec('mm', '4.00', '4.40') },
      equipmentClasses: { gaugeClass: 'VERNIER-CALIPER' },
      counts: { tablets: '10' },
    },
  },
  {
    definition: {
      code: 'IPC-DIAMETER',
      version: 1,
      title: 'Diameter',
      category: 'TEST_IPC',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'gauge', label: 'Gauge', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'gaugeClass' },
            {
              id: 'diameter',
              label: 'Diameter of each tablet',
              type: 'TEST_RESULT',
              unit: 'mm',
              replicatesSlot: 'tablets',
              statistics: [
                { statistic: 'MEAN', limitSlot: 'meanDiameter' },
                { statistic: 'INDIVIDUAL', limitSlot: 'individualDiameter' },
              ],
            },
          ],
        },
      ],
      signatures: [IPC],
    },
    exampleUse: {
      limits: { meanDiameter: spec('mm', '9.95', '10.05'), individualDiameter: spec('mm', '9.90', '10.10') },
      equipmentClasses: { gaugeClass: 'VERNIER-CALIPER' },
      counts: { tablets: '10' },
    },
  },
  {
    definition: {
      code: 'IPC-FRIABILITY',
      version: 1,
      title: 'Friability',
      category: 'TEST_IPC',
      instructions: 'Dedust the tablets, weigh them, tumble them for the number of revolutions given, dedust and weigh again.',
      sections: [
        {
          id: 'run',
          title: 'Run',
          fields: [
            { id: 'drum', label: 'Friabilator', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'friabilatorClass' },
            { id: 'revolutions', label: 'Drum revolutions', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'revolutions', critical: true },
            { id: 'w0', label: 'Weight before', type: 'NUMBER', unit: 'g', decimals: 3 },
            { id: 'w1', label: 'Weight after', type: 'NUMBER', unit: 'g', decimals: 3 },
            { id: 'loss', label: 'Weight loss', type: 'CALC', expression: '(w0 - w1) / w0 * 100 [%]', unit: '%', limitSlot: 'loss', critical: true },
            { id: 'cracked', label: 'Any tablet cracked, capped or broken', type: 'YES_NO', expected: false },
          ],
        },
      ],
      signatures: [IPC],
      referenceLimits: { loss: { unit: '%', high: '1.0', note: 'A common compendial maximum loss for uncoated tablets' } },
    },
    exampleUse: {
      limits: { revolutions: spec('1', '100', '100'), loss: spec('%', undefined, '0.8') },
      targets: { revolutions: '100' },
      equipmentClasses: { friabilatorClass: 'FRIABILATOR' },
    },
  },
  {
    definition: {
      code: 'IPC-DT-WATER',
      version: 1,
      title: 'Disintegration time',
      category: 'TEST_IPC',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'apparatus', label: 'Disintegration apparatus', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'apparatusClass' },
            { id: 'mediumTemp', label: 'Medium temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'mediumTemp', critical: true },
            {
              id: 'time',
              label: 'Time for each tablet to disintegrate',
              type: 'TEST_RESULT',
              unit: 'min',
              replicatesSlot: 'tablets',
              statistics: [{ statistic: 'MAX', limitSlot: 'maxTime' }],
            },
          ],
        },
      ],
      signatures: [IPC],
      referenceLimits: { maxTime: { unit: 'min', high: '15', note: 'A common compendial maximum for uncoated tablets; coated tablets commonly allow longer, recorded as a reason' } },
    },
    exampleUse: {
      limits: { mediumTemp: spec('Cel', '35.0', '39.0'), maxTime: spec('min', undefined, '10') },
      targets: { mediumTemp: '37.0' },
      equipmentClasses: { apparatusClass: 'DT-APPARATUS' },
      counts: { tablets: '6' },
    },
  },
  {
    definition: {
      code: 'IPC-DT-ENTERIC',
      version: 1,
      title: 'Disintegration of enteric-coated tablets (acid, then buffer)',
      category: 'TEST_IPC',
      instructions: 'Run the tablets in the acid medium for the time given, then examine them; move them to the buffer and time disintegration there.',
      sections: [
        {
          id: 'acid',
          title: 'Acid stage',
          fields: [
            { id: 'apparatus', label: 'Disintegration apparatus', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'apparatusClass' },
            { id: 'acidTemp', label: 'Acid medium temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'acidTemp', critical: true },
            { id: 'acidDuration', label: 'Time in acid', type: 'NUMBER', unit: 'min', decimals: 0, limitSlot: 'acidDuration', critical: true },
            { id: 'acidIntact', label: 'Every tablet intact after the acid stage (no disintegration, cracks or softening)', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'buffer',
          title: 'Buffer stage',
          fields: [
            { id: 'bufferTemp', label: 'Buffer temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'bufferTemp', critical: true },
            {
              id: 'bufferTime',
              label: 'Time for each tablet to disintegrate in buffer',
              type: 'TEST_RESULT',
              unit: 'min',
              replicatesSlot: 'tablets',
              statistics: [{ statistic: 'MAX', limitSlot: 'bufferMaxTime' }],
            },
          ],
        },
      ],
      signatures: [IPC],
    },
    exampleUse: {
      limits: { acidTemp: spec('Cel', '35.0', '39.0'), acidDuration: spec('min', '120', '125'), bufferTemp: spec('Cel', '35.0', '39.0'), bufferMaxTime: spec('min', undefined, '60') },
      targets: { acidTemp: '37.0', acidDuration: '120', bufferTemp: '37.0' },
      equipmentClasses: { apparatusClass: 'DT-APPARATUS' },
      counts: { tablets: '6' },
    },
  },
  {
    definition: {
      code: 'IPC-LOD',
      version: 1,
      title: 'Loss on drying',
      category: 'TEST_IPC',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'analyser', label: 'Moisture analyser', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'analyserClass' },
            { id: 'sampleMass', label: 'Sample mass', type: 'NUMBER', unit: 'g', decimals: 3 },
            { id: 'dryingTemp', label: 'Drying temperature', type: 'NUMBER', unit: 'Cel', decimals: 0, limitSlot: 'dryingTemp', critical: true },
            { id: 'lod', label: 'Loss on drying', type: 'NUMBER', unit: '%', decimals: 2, limitSlot: 'lod', critical: true },
          ],
        },
      ],
      signatures: [IPC],
    },
    exampleUse: {
      limits: { dryingTemp: spec('Cel', '103', '107'), lod: spec('%', '1.50', '3.00') },
      targets: { dryingTemp: '105' },
      equipmentClasses: { analyserClass: 'MOISTURE-ANALYSER' },
    },
  },
  {
    definition: {
      code: 'IPC-BLEND-UNIFORMITY',
      version: 1,
      title: 'Blend uniformity',
      category: 'TEST_IPC',
      instructions: 'Take one sample from each blender location in the sampling plan; record each result as % of the label claim, in the order of the plan.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'samples', label: 'Blend samples taken', type: 'SAMPLE', unitsSlot: 'samplesTaken', purpose: 'Blend uniformity' },
            {
              id: 'content',
              label: 'Content at each location',
              type: 'TEST_RESULT',
              unit: '%',
              replicatesSlot: 'locations',
              statistics: [
                { statistic: 'MEAN', limitSlot: 'meanContent' },
                { statistic: 'INDIVIDUAL', limitSlot: 'individualContent' },
                { statistic: 'RSD', limitSlot: 'contentRsd' },
              ],
            },
          ],
        },
      ],
      signatures: [IPC],
    },
    exampleUse: {
      limits: { meanContent: spec('%', '95.0', '105.0'), individualContent: spec('%', '90.0', '110.0'), contentRsd: spec('%', undefined, '5.0') },
      counts: { samplesTaken: '10', locations: '10' },
    },
  },
  {
    definition: {
      code: 'IPC-BULK-TAPPED-DENSITY',
      version: 1,
      title: 'Bulk and tapped density',
      category: 'TEST_IPC',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'tapper', label: 'Tapped density tester', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'tapperClass' },
            { id: 'mass', label: 'Sample mass', type: 'NUMBER', unit: 'g', decimals: 2 },
            { id: 'bulkVolume', label: 'Untapped (bulk) volume', type: 'NUMBER', unit: 'mL', decimals: 1 },
            { id: 'taps', label: 'Number of taps', type: 'NUMBER', unit: '1', decimals: 0 },
            { id: 'tappedVolume', label: 'Tapped volume', type: 'NUMBER', unit: 'mL', decimals: 1 },
            { id: 'bulkDensity', label: 'Bulk density', type: 'CALC', expression: 'mass / bulkVolume', unit: 'g/mL' },
            { id: 'tappedDensity', label: 'Tapped density', type: 'CALC', expression: 'mass / tappedVolume', unit: 'g/mL' },
            { id: 'carrIndex', label: 'Compressibility (Carr) index', type: 'CALC', expression: '(tappedDensity - bulkDensity) / tappedDensity * 100 [%]', unit: '%', limitSlot: 'carrIndex', critical: true },
            { id: 'hausnerRatio', label: 'Hausner ratio', type: 'CALC', expression: 'tappedDensity / bulkDensity', unit: '1' },
          ],
        },
      ],
      signatures: [IPC],
    },
    exampleUse: {
      limits: { carrIndex: spec('%', undefined, '20') },
      equipmentClasses: { tapperClass: 'TAPPED-DENSITY-TESTER' },
    },
  },
  {
    definition: {
      code: 'IPC-SIEVE-ANALYSIS',
      version: 1,
      title: 'Sieve analysis (particle size distribution)',
      category: 'TEST_IPC',
      instructions: 'Shake the sample through the sieve stack; record the % retained on each sieve and in the pan, in the order the formulation lists them.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            { id: 'shaker', label: 'Sieve shaker', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'shakerClass' },
            { id: 'sampleMass', label: 'Sample mass', type: 'NUMBER', unit: 'g', decimals: 1 },
            { id: 'shakeTime', label: 'Shaking time', type: 'NUMBER', unit: 'min', decimals: 0, limitSlot: 'shakeTime', critical: true },
            {
              id: 'retained',
              label: 'Retained on each sieve',
              type: 'TEST_RESULT',
              unit: '%',
              replicatesSlot: 'replicates',
              statistics: [{ statistic: 'MEAN', limitSlot: 'retained' }],
              perPoint: true,
            },
          ],
        },
      ],
      signatures: [IPC],
    },
    exampleUse: {
      limits: { shakeTime: spec('min', '10', '10') },
      targets: { shakeTime: '10' },
      equipmentClasses: { shakerClass: 'SIEVE-SHAKER' },
      counts: { replicates: '1' },
      points: {
        retained: [
          { id: 's850', label: '850 um sieve', limits: spec('%', undefined, '5.0') },
          { id: 's425', label: '425 um sieve', limits: spec('%', '5.0', '30.0') },
          { id: 's250', label: '250 um sieve', limits: spec('%', '15.0', '40.0') },
          { id: 's150', label: '150 um sieve', limits: spec('%', '10.0', '35.0') },
          { id: 'pan', label: 'Pan (fines)', limits: spec('%', undefined, '20.0') },
        ],
      },
    },
  },
  {
    definition: {
      code: 'IPC-APPEARANCE',
      version: 1,
      title: 'Tablet appearance',
      category: 'TEST_IPC',
      roles: ['IPC', 'OBSERVATION'],
      sections: [
        {
          id: 'check',
          title: 'Check',
          fields: [
            { id: 'sample', label: 'Tablets examined', type: 'SAMPLE', unitsSlot: 'tabletsExamined' },
            { id: 'appearance', label: 'Appearance against the description', type: 'CHOICE', options: ['Complies', 'Does not comply'], notAllowed: ['Does not comply'] },
            { id: 'defects', label: 'Chipping, capping, sticking or picking seen', type: 'YES_NO', expected: false },
            { id: 'defectNote', label: 'What was seen', type: 'TEXT', showWhen: { field: 'defects', equals: true } },
            { id: 'embossing', label: 'Embossing or break line clear', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [IPC],
    },
    exampleUse: { counts: { tabletsExamined: '20' } },
  },
  {
    definition: {
      code: 'IPC-COAT-WEIGHT-GAIN',
      version: 1,
      title: 'Coating weight gain check',
      category: 'TEST_IPC',
      instructions: 'Weigh the same number of core and coated tablets and record the average weight of each.',
      sections: [
        {
          id: 'check',
          title: 'Check',
          fields: [
            { id: 'balance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
            { id: 'coreWeight', label: 'Average core tablet weight', type: 'NUMBER', unit: 'mg', decimals: 1, limitSlot: 'coreWeight' },
            { id: 'coatedWeight', label: 'Average coated tablet weight', type: 'NUMBER', unit: 'mg', decimals: 1, limitSlot: 'coatedWeight' },
            { id: 'weightGain', label: 'Weight gain', type: 'CALC', expression: '(coatedWeight - coreWeight) / coreWeight * 100 [%]', unit: '%', limitSlot: 'weightGain', critical: true },
          ],
        },
      ],
      signatures: [IPC],
    },
    exampleUse: {
      limits: { coreWeight: spec('mg', '245.0', '255.0'), coatedWeight: spec('mg', '250.0', '265.0'), weightGain: spec('%', '2.5', '3.5') },
      targets: { coreWeight: '250.0', coatedWeight: '257.5' },
      equipmentClasses: { balanceClass: 'ANALYTICAL-BALANCE' },
    },
  },
];
