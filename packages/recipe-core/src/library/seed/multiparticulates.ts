/**
 * Ready-made library blocks: multiparticulates in hard capsules (Capsules edition plan `docs/build-plan/capsules/plan.md`,
 * slice C4): extrusion-spheronisation, drug layering on inert cores, fluid-bed pellet coating (seal, delayed release or
 * sustained release) and multi-station filling (pellets, mini-tablets, powder, a tablet or a capsule in one capsule).
 * Drying, sieving and mini-tablet compression reuse the existing blocks (PROC-FBD, PROC-SIFT, PROC-COMPRESS); a pellet
 * coat's suspension is made with COAT-SUSPENSION-PREP, and the coating material is a per-batch formula line (a coat on
 * capsules or pellets is never the per-unit COATING line, which is the shells, C2). Two-stage dissolution is the
 * existing release test REL-DISSO-TWO-STAGE. See types.ts.
 *
 * Invented example values; the product's own values are the formulation's.
 */
import type { LimitSpec } from '../../limits/model.ts';
import type { SeedItem } from './types.ts';

const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const VERIFIER = { meaning: 'VERIFIED' as const, role: 'PRODUCTION_VERIFIER' };

/** A validated process range (inclusive bounds). */
const val = (unit: string, low?: string, high?: string): LimitSpec => ({
  unit,
  ranges: [{ tier: 'REGISTERED', ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'PV-REF' } }],
});

/** The capsule sizes a filler takes (as capsules.ts). */
const SIZES = ['000', '00', '0', '1', '2', '3', '4', '5'];

/** What a dosing station of a multi-station filler doses. */
const STATION_CONTENTS = ['Pellets or beads', 'Mini-tablets', 'Powder or granules', 'Tablet', 'Capsule'];

export const MULTIPARTICULATE_SEEDS: readonly SeedItem[] = [
  {
    definition: {
      code: 'PROC-EXTRUDE-SPHERONISE',
      version: 1,
      title: 'Extrusion and spheronisation',
      category: 'PROCESS',
      instructions: 'Extrude the wet mass through the screen the formulation names at the set speed, then spheronise the charges in turn at the set speed, within the set total time. Dry the wet pellets and sieve them to the size fraction in their own steps.',
      sections: [
        {
          id: 'extrude',
          title: 'Extrusion',
          fields: [
            { id: 'extruder', label: 'Extruder', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'extruderClass' },
            { id: 'screen', label: 'Extruder screen opening (as the formulation names it)', type: 'TEXT' },
            { id: 'screenIntact', label: 'Screen intact before and after use', type: 'YES_NO', expected: true },
            { id: 'wetMassIn', label: 'Wet mass container', type: 'CONTAINER', action: 'CONSUME' },
            { id: 'extruderSpeed', label: 'Extruder speed', type: 'NUMBER', unit: '/min', decimals: 0, limitSlot: 'extruderSpeed', critical: true },
          ],
        },
        {
          id: 'spheronise',
          title: 'Spheronisation',
          fields: [
            { id: 'spheroniser', label: 'Spheroniser', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'spheroniserClass' },
            { id: 'plateSpeed', label: 'Friction plate speed', type: 'NUMBER', unit: '/min', decimals: 0, limitSlot: 'plateSpeed', critical: true },
            { id: 'spheronising', label: 'Spheronisation time (all charges)', type: 'TIMER', durationUnit: 'min', limitSlot: 'spheronisingTime', critical: true },
            { id: 'container', label: 'Wet pellets container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { extruderSpeed: val('/min', '40', '60'), plateSpeed: val('/min', '800', '1200'), spheronisingTime: val('min', '30', '90') },
      targets: { extruderSpeed: '50', plateSpeed: '1000' },
      equipmentClasses: { extruderClass: 'EXTRUDER', spheroniserClass: 'SPHERONISER' },
    },
  },
  {
    definition: {
      code: 'PROC-PELLET-LAYER',
      version: 1,
      title: 'Drug layering on inert cores (fluid bed)',
      category: 'PROCESS',
      instructions: 'Load the inert cores into the fluid-bed (bottom-spray) processor with its product-dedicated filter bags, and layer the drug solution, suspension or powder at the set rate while holding the product temperature. Dry in the processor at the end.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'processor', label: 'Fluid bed processor (bottom spray)', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'processorClass' },
            { id: 'filterBags', label: 'Filter bags dedicated to this product and intact', type: 'YES_NO', expected: true },
            { id: 'method', label: 'Layering method', type: 'CHOICE', options: ['Solution', 'Suspension', 'Powder'] },
            { id: 'coresLot', label: 'Inert cores lot', type: 'MATERIAL_LOT', bomLineSlot: 'coresLine' },
            { id: 'coresQty', label: 'Inert cores loaded', type: 'WEIGHING', unit: 'kg', limitSlot: 'coresQty' },
            { id: 'layeringIn', label: 'Drug layering liquid or powder container', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'round',
          title: 'Layering parameters',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
            { id: 'inletTemp', label: 'Inlet air temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'inletTemp', critical: true },
            { id: 'productTemp', label: 'Product temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'productTemp', critical: true },
            { id: 'sprayRate', label: 'Spray rate', type: 'NUMBER', unit: 'g/min', decimals: 0, limitSlot: 'sprayRate', critical: true },
            { id: 'atomisingAir', label: 'Atomising air pressure', type: 'NUMBER', unit: 'bar', decimals: 1, limitSlot: 'atomisingAir', critical: true },
          ],
        },
        {
          id: 'finish',
          title: 'Drying and discharge',
          fields: [
            { id: 'dryingTemp', label: 'Product temperature at the end of drying', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'dryingTemp', critical: true },
            { id: 'drying', label: 'Drying time in the processor', type: 'TIMER', durationUnit: 'min', limitSlot: 'dryingTime', critical: true },
            { id: 'container', label: 'Drug-layered pellets container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: {
        coresQty: val('kg', '19.90', '20.10'),
        inletTemp: val('Cel', '50.0', '65.0'),
        productTemp: val('Cel', '38.0', '45.0'),
        sprayRate: val('g/min', '40', '120'),
        atomisingAir: val('bar', '1.5', '2.5'),
        dryingTemp: val('Cel', '38.0', '45.0'),
        dryingTime: val('min', '30', '90'),
      },
      targets: { coresQty: '20.00', inletTemp: '58.0', productTemp: '41.0', sprayRate: '80', atomisingAir: '2.0', dryingTemp: '41.0' },
      equipmentClasses: { processorClass: 'FBP-WURSTER' },
      bomLines: { coresLine: 'L1' },
      intervals: { roundInterval: { value: '15', unit: 'min' } },
    },
  },
  {
    definition: {
      code: 'COAT-PELLET-FB',
      version: 1,
      title: 'Pellet coating (fluid bed)',
      category: 'COATING',
      roles: ['PARAMETER_RECORD', 'IPC'],
      instructions: 'Coat the pellets in the fluid-bed (bottom-spray) processor with the suspension of the layer the formulation names (seal, delayed-release or sustained-release). Record the parameters at each round, check the weight gain until it reaches its limits, then cure at the set temperature for the set time.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'processor', label: 'Fluid bed processor (bottom spray)', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'processorClass' },
            { id: 'filterBags', label: 'Filter bags dedicated to this product and intact', type: 'YES_NO', expected: true },
            { id: 'layer', label: 'Coat applied', type: 'CHOICE', options: ['Seal coat', 'Delayed-release (enteric) coat', 'Sustained-release coat', 'Top coat'] },
            { id: 'pelletsIn', label: 'Pellets container', type: 'CONTAINER', action: 'CONSUME' },
            { id: 'suspensionIn', label: 'Coating suspension container', type: 'CONTAINER', action: 'CONSUME' },
            { id: 'coreMass', label: 'Mass of 100 pellets before coating', type: 'NUMBER', unit: 'mg', decimals: 1, limitSlot: 'coreMass' },
          ],
        },
        {
          id: 'round',
          title: 'Spray parameters',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
            { id: 'inletTemp', label: 'Inlet air temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'inletTemp', critical: true },
            { id: 'productTemp', label: 'Product temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'productTemp', critical: true },
            { id: 'sprayRate', label: 'Spray rate', type: 'NUMBER', unit: 'g/min', decimals: 0, limitSlot: 'sprayRate', critical: true },
            { id: 'atomisingAir', label: 'Atomising air pressure', type: 'NUMBER', unit: 'bar', decimals: 1, limitSlot: 'atomisingAir', critical: true },
          ],
        },
        {
          id: 'gainCheck',
          title: 'Weight-gain check',
          repeat: { kind: 'UNTIL_PASS', untilField: 'weightGain', maxRepeatsSlot: 'maxGainChecks' },
          fields: [
            { id: 'coatedMass', label: 'Mass of 100 coated pellets', type: 'NUMBER', unit: 'mg', decimals: 1, limitSlot: 'coatedMass', help: 'The limits guard the reading itself; the weight gain decides whether spraying stops.' },
            { id: 'weightGain', label: 'Weight gain', type: 'CALC', expression: '(coatedMass - coreMass) / coreMass * 100 [%]', unit: '%', limitSlot: 'weightGain', critical: true },
          ],
        },
        {
          id: 'finish',
          title: 'Curing and discharge',
          fields: [
            { id: 'curingTemp', label: 'Curing product temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'curingTemp', critical: true },
            { id: 'curing', label: 'Curing time', type: 'TIMER', durationUnit: 'min', limitSlot: 'curingTime', critical: true },
            { id: 'container', label: 'Coated pellets container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: {
        coreMass: val('mg', '18.0', '22.0'),
        inletTemp: val('Cel', '40.0', '55.0'),
        productTemp: val('Cel', '30.0', '38.0'),
        sprayRate: val('g/min', '30', '90'),
        atomisingAir: val('bar', '1.5', '2.5'),
        coatedMass: val('mg', '18.0', '28.0'),
        weightGain: val('%', '18.0', '22.0'),
        curingTemp: val('Cel', '38.0', '42.0'),
        curingTime: val('min', '30', '120'),
      },
      targets: { coreMass: '20.0', inletTemp: '48.0', productTemp: '34.0', sprayRate: '60', atomisingAir: '2.0', coatedMass: '24.0', curingTemp: '40.0' },
      equipmentClasses: { processorClass: 'FBP-WURSTER' },
      counts: { maxGainChecks: '6' },
      intervals: { roundInterval: { value: '15', unit: 'min' } },
    },
  },
  {
    definition: {
      code: 'PROC-CAPS-FILL-MULTI',
      version: 1,
      title: 'Capsule filling, multi-station (pellets, mini-tablets, combinations)',
      category: 'PROCESS',
      instructions: 'Fit the change parts of the capsule size and set each dosing station to the fill the formulation gives (pellets or powder by mass, mini-tablets, a tablet or a capsule by count). Record what each station doses and its input. The capsule\'s fill weight is checked in its own step (IPC-CAPS-FILL-WEIGHT).',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'filler', label: 'Capsule filling machine', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'fillerClass' },
            { id: 'capsuleSize', label: 'Capsule size (change parts fitted)', type: 'CHOICE', options: SIZES },
            { id: 'shellLot', label: 'Empty capsule shells lot', type: 'MATERIAL_LOT', bomLineSlot: 'shellLine' },
            { id: 'shellsInspected', label: 'Shells of the right colour and print, free of dents and splits', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'station',
          title: 'Dosing station',
          repeat: { kind: 'COUNT', countSlot: 'stations' },
          fields: [
            { id: 'content', label: 'Station doses', type: 'CHOICE', options: STATION_CONTENTS },
            { id: 'stationIn', label: 'Station input container', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'round',
          title: 'Filling round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
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
      equipmentClasses: { fillerClass: 'CAPSULE-FILLER-MULTI' },
      bomLines: { shellLine: 'L1' },
      counts: { stations: '2' },
      intervals: { roundInterval: { value: '30', unit: 'min' } },
    },
  },
];
