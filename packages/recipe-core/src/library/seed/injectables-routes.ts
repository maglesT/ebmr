/**
 * Ready-made library blocks of the Injectables edition, slice I-4: other containers and routes (injectables plan v2,
 * section 4.3 and section 6 row I-4; `docs/build-plan/injectables/plan.md`). As in slices I-1 to I-3, every block is
 * data built from the existing field types and belongs to the `injectables` edition.
 *
 * Binding clauses, checked against the official texts (session 11, 10 November 2026) and paraphrased:
 *  - 21 CFR 211.100 (written procedures followed and recorded), 211.110(a) (in-process controls of fill and of each
 *    container's closure), 211.113(b) (validated aseptic and sterilisation processes), 211.188(b) (each significant step
 *    and the equipment and component lots used); 211.68(b) for values typed from a device or certificate (CHECKED).
 *  - Revised Schedule M, Part II 4.11 (each operation in its grade; suspensions and emulsions not filtered later are
 *    prepared and filled in Grade A with a Grade B background) and 6.11.1.8-6.11.1.13 (radiation: the dose measured
 *    with dosimeters read soon after exposure and the readings part of the batch record, each package carrying a
 *    radiation indicator, irradiated and non-irradiated goods kept apart, the total dose given within a set period).
 *  - EU GMP Annex 1, EU-market batches only, in their own blocks (owner Q0): 8.101-8.103 (form-fill-seal critical
 *    process parameters: forming and sealing settings, a batch-specific seal-strength test), 8.115-8.117 (blow-fill-seal:
 *    extrusion and mould temperatures, a batch-specific wall-thickness test). Radiation: Annex 1 8.71 points to EU GMP
 *    Annex 12 (ionising radiation, checked against the official text), whose batch-record items are INJ-RADIATION-EU:
 *    12.29 (containers packed to the validated loading pattern), 12.42 (containers sent, irradiated and returned
 *    reconciled, any discrepancy resolved), 12.43 (the plant certifies each container's dose range: the base block's
 *    doses come from that certificate) and 12.44 (the plant's records of the batch checked and signed by its nominated
 *    person). The plant's own dosimetry and source or beam records (12.35-12.41) stay the plant's.
 *
 * Not new blocks (plan section 1: the existing block does the job):
 *  - RTU nested syringes, cartridges and vials (INJ-27): supplier-sterilised components, recorded by INJ-SUPPLIER-STERILE
 *    (its lot on the formula line, method, certificate, packs intact); for the EU market the transfer into Grade A
 *    (Annex 1 8.47-8.48) is INJ-ASEPTIC-TRANSFER.
 *  - Dual-chamber products: INJ-FILL twice (diluent and drug), INJ-LYO for the in-device drying, INJ-PLUNGER.
 *  - The fill weight of individual units is IPC-INJ-FILL-WEIGHT; container closure integrity is INJ-CCI.
 *
 * The output of every filling block is registered as containers with the same field ids as INJ-FILL (`end.filled`,
 * `end.rejects`, `tray.units`), so unit accountability (INJ-UNIT-ACCOUNT) reads them by its step-value slots.
 *
 * Invented example values (DEMO-ONLY): the firm sets every limit, count and class in its formulation.
 */
import type { LimitSpec } from '../../limits/model.ts';
import type { SeedItem } from './types.ts';

const EDITION = 'injectables' as const;
const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const CHECKER = { meaning: 'CHECKED' as const, role: 'PRODUCTION_VERIFIER' };
const VERIFIER = { meaning: 'VERIFIED' as const, role: 'PRODUCTION_VERIFIER' };

/** A limit range (inclusive bounds) from a source: the validation report for a process value, the registration for a
 *  product value. */
const limit = (kind: 'VALIDATION_REPORT' | 'REGISTRATION', unit: string, low?: string, high?: string): LimitSpec => ({
  unit,
  ranges: [{ tier: kind === 'REGISTRATION' ? 'REGISTERED' : 'VALIDATED', ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind, ref: kind === 'REGISTRATION' ? 'SPEC-REF' : 'PV-REF' } }],
});
const pv = (unit: string, low?: string, high?: string): LimitSpec => limit('VALIDATION_REPORT', unit, low, high);
const spec = (unit: string, low?: string, high?: string): LimitSpec => limit('REGISTRATION', unit, low, high);

/** Units counted (containers): a plain count. */
const UNITS = '{unit}';

/** The output section of a filling block: each tray, basket or carrier of filled units registered as a container. */
const OUTPUT = {
  id: 'tray',
  title: 'Filled tray or basket',
  repeat: { kind: 'PER_CONTAINER' as const },
  fields: [
    { id: 'trayOut', label: 'Filled tray or basket', type: 'CONTAINER' as const, action: 'REGISTER' as const },
    { id: 'units', label: 'Units in it', type: 'NUMBER' as const, unit: UNITS, decimals: 0 },
  ],
};

export const INJECTABLE_ROUTE_SEEDS: readonly SeedItem[] = [
  {
    // INJ-16: 211.100, 211.110(a), 211.113(b); SM Part II 4.11 (Grade A/B for a suspension or emulsion not filtered later).
    definition: {
      code: 'INJ-HOMOGENISE',
      version: 1,
      title: 'Homogenisation of a suspension or emulsion',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-16. A bulk that cannot be filtered (suspension, emulsion, liposomes): the homogeniser in its room, its speed and time against the validated settings, and the particle size of the bulk against its limits.',
      instructions: 'Homogenise at the validated speed for the validated time. Take the particle-size sample from the bulk and record each result.',
      sections: [
        {
          id: 'homogenisation',
          title: 'Homogenisation',
          fields: [
            { id: 'homogeniser', label: 'Homogeniser', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'homogeniserClass' },
            { id: 'room', label: 'Room', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'roomClass' },
            { id: 'speed', label: 'Homogeniser speed', type: 'NUMBER', unit: '/min', decimals: 0, limitSlot: 'speed', critical: true },
            { id: 'time', label: 'Homogenisation time', type: 'TIMER', durationUnit: 'min', limitSlot: 'time', critical: true },
          ],
        },
        {
          id: 'particleSize',
          title: 'Particle size',
          fields: [
            {
              id: 'size',
              label: 'Particle size (median) of each sample',
              type: 'TEST_RESULT',
              unit: 'um',
              replicatesSlot: 'sizeReplicates',
              statistics: [
                { statistic: 'MEAN', limitSlot: 'sizeMean' },
                { statistic: 'INDIVIDUAL', limitSlot: 'sizeIndividual' },
              ],
            },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { homogeniserClass: 'HIGH-PRESSURE-HOMOGENISER', roomClass: 'ROOM-GRADE-B' },
      limits: { speed: pv('/min', '2800', '3200'), time: pv('min', '20'), sizeMean: spec('um', '0.10', '0.30'), sizeIndividual: spec('um', '0.05', '0.40') },
      targets: { speed: '3000', sizeMean: '0.20', sizeIndividual: '0.20' },
      counts: { sizeReplicates: '3' },
    },
  },
  {
    // INJ-31: 211.100, 211.110(a), 211.113(b); SM Part II 4.11. The powder is a formula line, dispensed by the master's
    // dispensing stage; the individual fill weights are IPC-INJ-FILL-WEIGHT.
    definition: {
      code: 'INJ-POWDER-FILL',
      version: 1,
      title: 'Sterile powder filling and stoppering',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-31. The powder filling line in its room, the mean fill weight at each round against its limits, the closures, and the filled trays registered as containers.',
      instructions: 'Set the line for the format. Weigh filled units at each round. Register each filled tray as a container.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'line', label: 'Powder filling line', type: 'EQUIPMENT', kind: 'LINE', classSlot: 'lineClass' },
            { id: 'room', label: 'Filling room', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'roomClass' },
            { id: 'weighBalance', label: 'Balance for the fill weights', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
          ],
        },
        {
          id: 'round',
          title: 'Filling round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
            { id: 'fillWeight', label: 'Mean fill weight of the units weighed', type: 'NUMBER', unit: 'mg', decimals: 1, limitSlot: 'fillWeight', critical: true },
            { id: 'closures', label: 'Units closed correctly', type: 'YES_NO', expected: true },
          ],
        },
        OUTPUT,
        {
          id: 'end',
          title: 'End of filling',
          fields: [
            { id: 'filled', label: 'Units filled', type: 'NUMBER', unit: UNITS, decimals: 0 },
            { id: 'rejects', label: 'Units rejected at the line', type: 'NUMBER', unit: UNITS, decimals: 0 },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { lineClass: 'POWDER-FILLING-LINE', roomClass: 'ROOM-GRADE-B', balanceClass: 'ANALYTICAL-BALANCE' },
      limits: { fillWeight: spec('mg', '485.0', '515.0') },
      targets: { fillWeight: '500.0' },
      intervals: { roundInterval: { value: '30', unit: 'min' } },
    },
  },
  {
    // INJ-28: 211.100, 211.110(a), 211.188(b). The plunger or middle-stopper lot named where it is used (as the stopper
    // and seal lots are, lead 6 November 2026), verified by a second person.
    definition: {
      code: 'INJ-PLUNGER',
      version: 1,
      title: 'Plunger or middle-stopper placement (syringes, cartridges)',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-28. The placement machine and the plunger or middle-stopper lot (released by QC; checked by a second person), the position of each unit checked at each round against its limits, and the rejects.',
      instructions: 'Place the plungers or middle stoppers. At each round measure the position of the units the formulation names.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'placer', label: 'Plunger or stopper placement machine', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'placerClass' },
            { id: 'plungerLot', label: 'Plunger or middle-stopper lot', type: 'MATERIAL_LOT' },
          ],
        },
        {
          id: 'round',
          title: 'Placement round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
            {
              id: 'position',
              label: 'Position of each unit',
              type: 'TEST_RESULT',
              unit: 'mm',
              replicatesSlot: 'positionUnits',
              statistics: [{ statistic: 'INDIVIDUAL', limitSlot: 'position' }],
            },
            { id: 'rejects', label: 'Units rejected since the last round', type: 'NUMBER', unit: UNITS, decimals: 0 },
          ],
        },
        {
          id: 'end',
          title: 'End of placement',
          fields: [{ id: 'totalRejects', label: 'Units rejected at placement', type: 'CALC', expression: 'sum(rejects)', unit: UNITS }],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { placerClass: 'PLUNGER-PLACER' },
      limits: { position: spec('mm', '4.0', '6.0') },
      counts: { positionUnits: '5' },
      intervals: { roundInterval: { value: '30', unit: 'min' } },
    },
  },
  {
    // INJ-29: 211.100, 211.110(a), 211.188(b); SM Part XIII (FFS lines: their own areas); SM Part II 4.11.
    definition: {
      code: 'INJ-FFS',
      version: 1,
      title: 'Form-fill-seal (bags and bottles)',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-29. The form-fill-seal machine in its room and the film lot (released by QC; checked by a second person), the mean fill weight and the seals at each round, the rejects, and the filled units registered as containers.',
      instructions: 'Set the machine to the validated settings. At each round weigh the units the formulation names and examine the seals.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'machine', label: 'Form-fill-seal machine', type: 'EQUIPMENT', kind: 'LINE', classSlot: 'machineClass' },
            { id: 'room', label: 'Room', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'roomClass' },
            { id: 'filmLot', label: 'Film lot', type: 'MATERIAL_LOT' },
          ],
        },
        {
          id: 'round',
          title: 'Filling round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
            { id: 'fillWeight', label: 'Mean fill weight of the units weighed', type: 'NUMBER', unit: 'g', decimals: 1, limitSlot: 'fillWeight', critical: true },
            { id: 'sealsOk', label: 'Seals complete, no leak', type: 'YES_NO', expected: true },
            { id: 'roundRejects', label: 'Units rejected since the last round', type: 'NUMBER', unit: UNITS, decimals: 0 },
          ],
        },
        OUTPUT,
        {
          id: 'end',
          title: 'End of filling',
          fields: [
            { id: 'filled', label: 'Units filled', type: 'NUMBER', unit: UNITS, decimals: 0 },
            { id: 'rejects', label: 'Units rejected at the machine', type: 'CALC', expression: 'sum(roundRejects)', unit: UNITS },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { machineClass: 'FFS-MACHINE', roomClass: 'ROOM-GRADE-C' },
      limits: { fillWeight: spec('g', '100.0', '106.0') },
      targets: { fillWeight: '103.0' },
      intervals: { roundInterval: { value: '30', unit: 'min' } },
    },
  },
  {
    // INJ-29, EU market: A1 8.101-8.103.
    definition: {
      code: 'INJ-FFS-EU',
      version: 1,
      title: 'Form-fill-seal settings and seal strength, EU market',
      category: 'PROCESS',
      edition: EDITION,
      markets: ['EU'],
      description: 'INJ-29, EU market. The forming and sealing settings of the batch against the validated values and the batch\'s seal-strength test.',
      instructions: 'Read the settings from the machine display or printout. A second person checks them. Test the seal strength of the units the formulation names.',
      sections: [
        {
          id: 'settings',
          title: 'Settings',
          fields: [
            { id: 'formingTemp', label: 'Forming temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'formingTemp', critical: true },
            { id: 'sealingTemp', label: 'Sealing temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'sealingTemp', critical: true },
            { id: 'sealingTime', label: 'Sealing time', type: 'NUMBER', unit: 's', decimals: 1, limitSlot: 'sealingTime', critical: true },
          ],
        },
        {
          id: 'sealStrength',
          title: 'Seal strength',
          fields: [
            {
              id: 'strength',
              label: 'Seal strength of each unit',
              type: 'TEST_RESULT',
              unit: 'N',
              replicatesSlot: 'strengthUnits',
              statistics: [{ statistic: 'INDIVIDUAL', limitSlot: 'strength' }],
            },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {
      limits: { formingTemp: pv('Cel', '130.0', '150.0'), sealingTemp: pv('Cel', '160.0', '180.0'), sealingTime: pv('s', '1.0', '2.0'), strength: spec('N', '20') },
      targets: { formingTemp: '140.0', sealingTemp: '170.0', sealingTime: '1.5', strength: '30' },
      counts: { strengthUnits: '5' },
    },
  },
  {
    // INJ-30: 211.100, 211.110(a), 211.188(b); SM Part XIII (BFS lines: their own areas); SM Part II 4.11.
    definition: {
      code: 'INJ-BFS',
      version: 1,
      title: 'Blow-fill-seal',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-30. The blow-fill-seal machine in its room and the polymer lot (released by QC; checked by a second person), the mean fill weight and the seals at each round, the rejects, and the filled units registered as containers.',
      instructions: 'Set the machine to the validated settings. At each round weigh the units the formulation names and examine the seals.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            { id: 'machine', label: 'Blow-fill-seal machine', type: 'EQUIPMENT', kind: 'LINE', classSlot: 'machineClass' },
            { id: 'room', label: 'Room', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'roomClass' },
            { id: 'polymerLot', label: 'Polymer granulate lot', type: 'MATERIAL_LOT' },
          ],
        },
        {
          id: 'round',
          title: 'Filling round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
            { id: 'fillWeight', label: 'Mean fill weight of the units weighed', type: 'NUMBER', unit: 'g', decimals: 2, limitSlot: 'fillWeight', critical: true },
            { id: 'sealsOk', label: 'Units sealed, flash removed cleanly, no leak', type: 'YES_NO', expected: true },
            { id: 'roundRejects', label: 'Units rejected since the last round', type: 'NUMBER', unit: UNITS, decimals: 0 },
          ],
        },
        OUTPUT,
        {
          id: 'end',
          title: 'End of filling',
          fields: [
            { id: 'filled', label: 'Units filled', type: 'NUMBER', unit: UNITS, decimals: 0 },
            { id: 'rejects', label: 'Units rejected at the machine', type: 'CALC', expression: 'sum(roundRejects)', unit: UNITS },
          ],
        },
      ],
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { machineClass: 'BFS-MACHINE', roomClass: 'ROOM-GRADE-C' },
      limits: { fillWeight: spec('g', '5.05', '5.25') },
      targets: { fillWeight: '5.15' },
      intervals: { roundInterval: { value: '30', unit: 'min' } },
    },
  },
  {
    // INJ-30, EU market: A1 8.115-8.117.
    definition: {
      code: 'INJ-BFS-EU',
      version: 1,
      title: 'Blow-fill-seal settings and wall thickness, EU market',
      category: 'PROCESS',
      edition: EDITION,
      markets: ['EU'],
      description: 'INJ-30, EU market. The extrusion and mould temperatures of the batch against the validated values and the batch\'s wall-thickness test at the container\'s critical points.',
      instructions: 'Read the settings from the machine display or printout. A second person checks them. Measure the wall thickness of the units the formulation names at the critical points.',
      sections: [
        {
          id: 'settings',
          title: 'Settings',
          fields: [
            { id: 'extrusionTemp', label: 'Extrusion temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'extrusionTemp', critical: true },
            { id: 'mouldTemp', label: 'Mould temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'mouldTemp', critical: true },
          ],
        },
        {
          id: 'wallThickness',
          title: 'Wall thickness',
          fields: [
            {
              id: 'thickness',
              label: 'Wall thickness of each unit at the critical points (thinnest reading)',
              type: 'TEST_RESULT',
              unit: 'mm',
              replicatesSlot: 'thicknessUnits',
              statistics: [{ statistic: 'INDIVIDUAL', limitSlot: 'thickness' }],
            },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {
      limits: { extrusionTemp: pv('Cel', '170.0', '190.0'), mouldTemp: pv('Cel', '10.0', '20.0'), thickness: spec('mm', '0.40') },
      targets: { extrusionTemp: '180.0', mouldTemp: '15.0', thickness: '0.50' },
      counts: { thicknessUnits: '5' },
    },
  },
  {
    // INJ-21 variant (terminal radiation of product): 211.113(b), 211.188(b), 211.68(b); SM Part II 6.11.1.8-6.11.1.13.
    definition: {
      code: 'INJ-RADIATION',
      version: 1,
      title: 'Terminal sterilisation by radiation (per load)',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-21 (radiation). Gamma or electron-beam sterilisation of the filled product, usually by a contract steriliser: every filled tray consumed into its numbered load; for each load the certificate, the lowest and highest dose measured by the dosimeters (typed from the certificate, checked by a second person), the dosimeters read after exposure, the indicators on the packages, the dose given within the set period, and the irradiated load registered.',
      instructions: 'Send each load with its loading pattern. When it returns, keep it apart from non-irradiated goods, check the indicator on every package, and type the doses from the certificate and attach it. A second person checks the typed values against the certificate.',
      sections: [
        {
          id: 'setup',
          title: 'Steriliser',
          fields: [
            { id: 'method', label: 'Radiation', type: 'CHOICE', options: ['Gamma', 'Electron beam'] },
            { id: 'facility', label: 'Irradiation facility (contract steriliser)', type: 'TEXT', maxLength: 80 },
          ],
        },
        {
          id: 'tray',
          title: 'Tray loaded',
          repeat: { kind: 'PER_CONTAINER' },
          fields: [
            { id: 'trayIn', label: 'Filled tray', type: 'CONTAINER', action: 'CONSUME' },
            { id: 'trayLoad', label: 'Load it is placed in (load number)', type: 'TEXT', maxLength: 20 },
          ],
        },
        {
          id: 'load',
          title: 'Load',
          repeat: { kind: 'PER_CONTAINER' },
          fields: [
            { id: 'certificate', label: 'Irradiation certificate (reference)', type: 'TEXT', maxLength: 60 },
            { id: 'minDose', label: 'Lowest dose measured', type: 'NUMBER', unit: 'kGy', decimals: 1, limitSlot: 'minDose', critical: true },
            { id: 'maxDose', label: 'Highest dose measured', type: 'NUMBER', unit: 'kGy', decimals: 1, limitSlot: 'maxDose', critical: true },
            { id: 'dosimetersRead', label: 'Dosimeters read soon after exposure, within their calibration', type: 'YES_NO', expected: true },
            { id: 'withinPeriod', label: 'Total dose given within the set period', type: 'YES_NO', expected: true },
            { id: 'indicators', label: 'Radiation indicator changed on every package', type: 'YES_NO', expected: true },
            { id: 'loadOut', label: 'Irradiated load', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'certificateAttached', label: 'Certificate attached to the record', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {
      limits: { minDose: pv('kGy', '25.0'), maxDose: pv('kGy', undefined, '40.0') },
      targets: { minDose: '27.0', maxDose: '35.0' },
    },
  },
  {
    // INJ-21 (radiation), EU market: EU GMP Annex 12, 12.29, 12.42-12.44.
    definition: {
      code: 'INJ-RADIATION-EU',
      version: 1,
      title: 'Radiation sterilisation records, EU market',
      category: 'PROCESS',
      edition: EDITION,
      markets: ['EU'],
      description: 'INJ-21 (radiation), EU market. For each load: the containers packed to the validated loading pattern, the containers sent, irradiated and returned reconciled with the plant\'s documents, and the plant\'s records of the load checked and signed by its nominated person.',
      instructions: 'Check the plant\'s certificate and records of each load against the containers sent and returned. Report and resolve any discrepancy before signing.',
      sections: [
        {
          id: 'load',
          title: 'Load',
          repeat: { kind: 'PER_CONTAINER' },
          fields: [
            { id: 'loadNumber', label: 'Load number', type: 'TEXT', maxLength: 20 },
            { id: 'loadingPattern', label: 'Containers packed to the validated loading pattern', type: 'YES_NO', expected: true },
            { id: 'reconciled', label: 'Containers sent, irradiated and returned reconciled with the plant\'s documents', type: 'YES_NO', expected: true },
            { id: 'plantRecordsSigned', label: 'Plant\'s records of the load checked and signed by its nominated person', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {},
  },
];
