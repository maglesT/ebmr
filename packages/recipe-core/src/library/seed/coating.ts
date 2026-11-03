/**
 * Ready-made library blocks: coating (decision 0026, S8). See types.ts.
 *
 * Invented example values; the product's own values are the formulation's.
 */
import type { LimitSpec } from '../../limits/model.ts';
import type { BlockDefinition, FieldDef } from '../model.ts';
import type { SeedItem } from './types.ts';

const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const VERIFIER = { meaning: 'VERIFIED' as const, role: 'PRODUCTION_VERIFIER' };

/** A validated process range (inclusive bounds). */
const val = (unit: string, low?: string, high?: string): LimitSpec => ({
  unit,
  ranges: [{ tier: 'REGISTERED', ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'PV-REF' } }],
});

/** The spray parameters recorded at each round of a pan-coating step (all CPPs). */
const sprayParameters: FieldDef[] = [
  { id: 'inletTemp', label: 'Inlet air temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'inletTemp', critical: true },
  { id: 'exhaustTemp', label: 'Exhaust air temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'exhaustTemp', critical: true },
  { id: 'bedTemp', label: 'Tablet bed temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'bedTemp', critical: true },
  { id: 'sprayRate', label: 'Spray rate', type: 'NUMBER', unit: 'g/min', decimals: 0, limitSlot: 'sprayRate', critical: true },
  { id: 'panSpeed', label: 'Pan speed', type: 'NUMBER', unit: '/min', decimals: 1, limitSlot: 'panSpeed', critical: true },
  { id: 'atomisingAir', label: 'Atomising air pressure', type: 'NUMBER', unit: 'bar', decimals: 1, limitSlot: 'atomisingAir', critical: true },
];

/**
 * A pan-coating step: set-up, the spray parameters at each round, then a weight-gain check repeated until the gain is
 * inside its limits (spraying continues between checks), with a maximum number of checks.
 */
function panCoat(code: string, title: string, layer: string): BlockDefinition {
  return {
    code,
    version: 1,
    title,
    category: 'COATING',
    roles: ['PARAMETER_RECORD', 'IPC'],
    instructions: `Pre-warm the core tablets, then spray the ${layer} suspension. Record the parameters at each round; check the weight gain until it reaches its limits.`,
    sections: [
      {
        id: 'setup',
        title: 'Set-up',
        fields: [
          { id: 'coater', label: 'Coating pan', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'coaterClass' },
          { id: 'suspensionLot', label: `${layer[0]?.toUpperCase() ?? ''}${layer.slice(1)} suspension container`, type: 'CONTAINER', action: 'CONSUME' },
          { id: 'coreQty', label: 'Quantity of tablets loaded', type: 'WEIGHING', unit: 'kg' },
          { id: 'coreWeight', label: 'Average tablet weight before coating', type: 'NUMBER', unit: 'mg', decimals: 1, limitSlot: 'coreWeight' },
          { id: 'spraying', label: 'Spraying time', type: 'TIMER', durationUnit: 'min' },
        ],
      },
      { id: 'round', title: 'Spray parameters', repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' }, fields: sprayParameters },
      {
        id: 'gainCheck',
        title: 'Weight-gain check',
        repeat: { kind: 'UNTIL_PASS', untilField: 'weightGain', maxRepeatsSlot: 'maxGainChecks' },
        fields: [
          { id: 'coatedWeight', label: 'Average coated tablet weight', type: 'NUMBER', unit: 'mg', decimals: 1, limitSlot: 'coatedWeight', help: 'The limits guard the reading itself; the weight gain decides whether spraying stops.' },
          { id: 'weightGain', label: 'Weight gain', type: 'CALC', expression: '(coatedWeight - coreWeight) / coreWeight * 100 [%]', unit: '%', limitSlot: 'weightGain', critical: true },
        ],
      },
      {
        id: 'finish',
        title: 'Finish',
        fields: [
          { id: 'appearance', label: 'Coated tablets smooth and even in colour', type: 'YES_NO', expected: true },
          { id: 'coatedQty', label: 'Quantity of coated tablets', type: 'WEIGHING', unit: 'kg' },
        ],
      },
    ],
    signatures: [OPERATOR, VERIFIER],
  };
}

/** Example spray-parameter limits and targets shared by the pan-coating examples. */
const sprayExample = {
  limits: {
    inletTemp: val('Cel', '50.0', '65.0'),
    exhaustTemp: val('Cel', '38.0', '48.0'),
    bedTemp: val('Cel', '38.0', '45.0'),
    sprayRate: val('g/min', '80', '160'),
    panSpeed: val('/min', '4.0', '12.0'),
    atomisingAir: val('bar', '1.5', '2.5'),
  },
  targets: { inletTemp: '58.0', exhaustTemp: '43.0', bedTemp: '41.0', sprayRate: '120', panSpeed: '8.0', atomisingAir: '2.0' },
};

function panCoatExample(gainLow: string, gainHigh: string, coatedTarget: string): SeedItem['exampleUse'] {
  return {
    limits: { ...sprayExample.limits, coreWeight: val('mg', '245.0', '255.0'), coatedWeight: val('mg', '245.0', '275.0'), weightGain: val('%', gainLow, gainHigh) },
    targets: { ...sprayExample.targets, coreWeight: '250.0', coatedWeight: coatedTarget },
    equipmentClasses: { coaterClass: 'AUTO-COATER' },
    counts: { maxGainChecks: '6' },
    intervals: { roundInterval: { value: '15', unit: 'min' } },
  };
}

export const COATING_SEEDS: readonly SeedItem[] = [
  {
    definition: {
      code: 'COAT-SUSPENSION-PREP',
      version: 1,
      title: 'Coating suspension preparation',
      category: 'COATING',
      instructions: 'Add the coating material to the water under stirring; stir for the time given and check the viscosity before use.',
      sections: [
        {
          id: 'prepare',
          title: 'Prepare',
          fields: [
            { id: 'vessel', label: 'Preparation vessel with stirrer', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'vesselClass' },
            { id: 'coatingLot', label: 'Coating material lot', type: 'MATERIAL_LOT', bomLineSlot: 'coatingLine' },
            { id: 'water', label: 'Purified water', type: 'WEIGHING', unit: 'kg', limitSlot: 'waterQty' },
            { id: 'powder', label: 'Coating material', type: 'WEIGHING', unit: 'kg', limitSlot: 'powderQty' },
            { id: 'solids', label: 'Solids content', type: 'CALC', expression: 'powder / (powder + water) * 100 [%]', unit: '%', limitSlot: 'solids', critical: true },
            { id: 'stirring', label: 'Stirring time', type: 'TIMER', durationUnit: 'min', limitSlot: 'stirTime', critical: true },
          ],
        },
        {
          id: 'check',
          title: 'Check',
          fields: [
            { id: 'viscometer', label: 'Viscometer', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'viscometerClass' },
            { id: 'viscosity', label: 'Viscosity', type: 'NUMBER', unit: 'mPa.s', decimals: 0, limitSlot: 'viscosity', critical: true },
            { id: 'lumpFree', label: 'Suspension free of lumps after screening', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { waterQty: val('kg', '43.5', '44.5'), powderQty: val('kg', '5.95', '6.05'), solids: val('%', '11.5', '12.5'), stirTime: val('min', '45', '120'), viscosity: val('mPa.s', '50', '250') },
      targets: { waterQty: '44.0', powderQty: '6.00' },
      equipmentClasses: { vesselClass: 'SS-VESSEL-STIRRER', viscometerClass: 'VISCOMETER' },
      bomLines: { coatingLine: 'L1' },
    },
  },
  { definition: panCoat('COAT-SEAL', 'Seal coating', 'seal coat'), exampleUse: panCoatExample('1.0', '2.0', '253.75') },
  { definition: panCoat('COAT-FILM', 'Film coating', 'film coat'), exampleUse: panCoatExample('2.5', '3.5', '257.5') },
  { definition: panCoat('COAT-ENTERIC', 'Functional (enteric) coating', 'enteric coat'), exampleUse: panCoatExample('8.0', '10.0', '272.5') },
  { definition: panCoat('COAT-TOP', 'Top coating', 'top coat'), exampleUse: panCoatExample('0.5', '1.5', '252.5') },
  {
    definition: {
      code: 'COAT-SUGAR-PHASE',
      version: 1,
      title: 'Sugar coating (by phase)',
      category: 'COATING',
      instructions: 'Record one entry for each phase in the order the formulation lists (sealing, sub-coating, smoothing, colouring); dry between coats.',
      sections: [
        { id: 'setup', title: 'Set-up', fields: [{ id: 'pan', label: 'Sugar coating pan', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'panClass' }] },
        {
          id: 'phase',
          title: 'Phase',
          repeat: { kind: 'COUNT', countSlot: 'phaseCount' },
          fields: [
            { id: 'phaseName', label: 'Phase', type: 'CHOICE', options: ['Sealing', 'Sub-coating', 'Smoothing', 'Colouring'] },
            { id: 'syrupContainer', label: 'Syrup or suspension container', type: 'CONTAINER', action: 'CONSUME' },
            { id: 'coatsApplied', label: 'Coats applied', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'coatsApplied' },
            { id: 'dryingAirTemp', label: 'Drying air temperature', type: 'NUMBER', unit: 'Cel', decimals: 0, limitSlot: 'dryingAirTemp', critical: true },
            { id: 'weightAfter', label: 'Average tablet weight after the phase', type: 'NUMBER', unit: 'mg', decimals: 1 },
            { id: 'phaseOk', label: 'Surface even, no twins or chipping', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { coatsApplied: val('1', '1', '30'), dryingAirTemp: val('Cel', '30', '50') },
      equipmentClasses: { panClass: 'SUGAR-COATING-PAN' },
      counts: { phaseCount: '4' },
    },
  },
  {
    definition: {
      code: 'COAT-POLISH',
      version: 1,
      title: 'Polishing',
      category: 'COATING',
      sections: [
        {
          id: 'polish',
          title: 'Polish',
          fields: [
            { id: 'pan', label: 'Polishing pan', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'panClass' },
            { id: 'waxLot', label: 'Polishing agent lot', type: 'MATERIAL_LOT', bomLineSlot: 'waxLine' },
            { id: 'waxQty', label: 'Polishing agent', type: 'WEIGHING', unit: 'g', limitSlot: 'waxQty' },
            { id: 'panSpeed', label: 'Pan speed', type: 'NUMBER', unit: '/min', decimals: 1, limitSlot: 'panSpeed', critical: true },
            { id: 'polishing', label: 'Polishing time', type: 'TIMER', durationUnit: 'min', limitSlot: 'polishTime', critical: true },
            { id: 'gloss', label: 'Tablets evenly glossy', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { waxQty: val('g', '48', '52'), panSpeed: val('/min', '4.0', '10.0'), polishTime: val('min', '30', '120') },
      targets: { waxQty: '50', panSpeed: '6.0' },
      equipmentClasses: { panClass: 'POLISHING-PAN' },
      bomLines: { waxLine: 'L1' },
    },
  },
  {
    definition: {
      code: 'COAT-INSPECTION',
      version: 1,
      title: 'Coated tablet inspection',
      category: 'COATING',
      roles: ['IPC', 'OBSERVATION'],
      instructions: 'Examine the tablets the formulation names and count each kind of defect.',
      sections: [
        {
          id: 'inspect',
          title: 'Inspect',
          fields: [
            { id: 'sample', label: 'Tablets inspected', type: 'SAMPLE', unitsSlot: 'tabletsInspected' },
            { id: 'criticalDefects', label: 'Critical defects (foreign tablet, foreign matter)', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'criticalDefects', critical: true },
            { id: 'majorDefects', label: 'Major defects (twins, peeling, broken)', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'majorDefects', critical: true },
            { id: 'minorDefects', label: 'Minor defects (colour variation, logo bridging, rough surface)', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'minorDefects', critical: true },
            { id: 'outcome', label: 'Outcome', type: 'CHOICE', options: ['Accepted', 'Accepted after sorting', 'Rejected'], notAllowed: ['Rejected'] },
            { id: 'sortingRef', label: 'Sorting record', type: 'TEXT', showWhen: { field: 'outcome', equals: 'Accepted after sorting' } },
          ],
        },
      ],
      signatures: [{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }, VERIFIER],
    },
    exampleUse: {
      limits: { criticalDefects: val('1', undefined, '0'), majorDefects: val('1', undefined, '2'), minorDefects: val('1', undefined, '10') },
      counts: { tabletsInspected: '500' },
    },
  },
];
