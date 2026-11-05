/**
 * Ready-made library blocks: soft gelatin capsules, part I (Capsules edition plan `docs/build-plan/capsules/plan.md`,
 * section 3.3, slice C6): gel mass preparation, rotary die encapsulation, drying to the end point, and the soft gel's own
 * in-process tests (fill and shell weight per capsule, seal thickness, hardness). Fill preparation is PROC-FILL-PREP
 * (C5); inspection, printing, polishing and packing are the shared capsule blocks (C3). See types.ts.
 *
 * Every field carries a binding clause (21 CFR 211, EU GMP Part I chapters 4 and 5, Schedule M incl. Part VIII), named
 * in a comment per group. Holds that end in a later step (the gel mass, the fill) are not timed in these blocks: they are
 * the master's HOLD time constraint or its PROC-HOLD step (21 CFR 211.111; D-C3-6). No washing block: section 4 of the
 * plan maps no binding clause to washing (D-C6-1).
 *
 * Invented example values (an oval soft gel, 500 mg fill); the product's own values are the formulation's.
 */
import type { LimitSpec } from '../../limits/model.ts';
import type { SeedItem } from './types.ts';

const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const VERIFIER = { meaning: 'VERIFIED' as const, role: 'PRODUCTION_VERIFIER' };

/** A registered limit range (inclusive bounds): the product specification or the validated process. */
const reg = (unit: string, low?: string, high?: string): LimitSpec => ({
  unit,
  ranges: [{ tier: 'REGISTERED', ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'SPEC-REF' } }],
});

export const SOFTGEL_SEEDS: readonly SeedItem[] = [
  {
    definition: {
      code: 'SG-GEL-MASS',
      version: 1,
      title: 'Gel mass preparation (soft gels)',
      category: 'PROCESS',
      instructions: 'Charge the dispensed plasticiser, water and colourants, then the gelatin (or the non-animal gelling agent the formulation names), into the melting tank. Melt and mix at the set temperature for the set time, deaerate under vacuum for the set time, check the viscosity and discharge into the heated receivers. The gel mass is held in the hold step the master sets before encapsulation.',
      sections: [
        {
          id: 'charge',
          title: 'Charging',
          fields: [
            // 21 CFR 211.105(a), 211.188(b); EU GMP 4.20(e): the major equipment used.
            { id: 'vessel', label: 'Gel mass melting tank', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'vesselClass' },
            // 21 CFR 211.101(b)-(d), 211.188(b); EU GMP 4.20(d); Schedule M 14.16-14.17: the gelatin lot checked against the lot register; the other components' lots are named where they are dispensed (PROC-DISP).
            { id: 'gelatinLot', label: 'Gelatin (gelling agent) lot', type: 'MATERIAL_LOT', bomLineSlot: 'gelatinLine' },
            { id: 'componentsIn', label: 'Dispensed plasticiser, water and colourants container', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'melt',
          title: 'Melting and mixing',
          fields: [
            // Schedule M Part VIII 2.3: critical time and temperature of each mixing operation, in the master and recorded.
            { id: 'meltTemp', label: 'Gel mass temperature during mixing', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'meltTemp', critical: true },
            { id: 'mixing', label: 'Melting and mixing time', type: 'TIMER', durationUnit: 'min', limitSlot: 'mixingTime', critical: true },
          ],
        },
        {
          id: 'deaerate',
          title: 'Deaeration',
          fields: [
            // Schedule M Part VIII 2.3: the critical operating parameters of the mixing (the vacuum is applied in the mixing tank), with its time.
            { id: 'vacuum', label: 'Vacuum during deaeration (absolute pressure)', type: 'NUMBER', unit: 'mbar', decimals: 0, limitSlot: 'vacuum', critical: true },
            { id: 'deaeration', label: 'Deaeration time', type: 'TIMER', durationUnit: 'min', limitSlot: 'deaerationTime', critical: true },
          ],
        },
        {
          id: 'output',
          title: 'Viscosity and discharge',
          fields: [
            // 21 CFR 211.110(a), (b); EU GMP 4.20(f): an in-process control of the gel mass with its limits.
            { id: 'viscosity', label: 'Gel mass viscosity', type: 'NUMBER', unit: 'mPa.s', decimals: 0, limitSlot: 'viscosity', critical: true },
            // 21 CFR 211.105(a), 211.188(b), 211.103: the container and the weight of the intermediate (its yield).
            { id: 'container', label: 'Gel mass receiver', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      // 21 CFR 211.101(d), 211.188(b)(11); EU GMP 4.20(c): the person who performed and the person who checked.
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { meltTemp: reg('Cel', '60.0', '75.0'), mixingTime: reg('min', '45', '180'), vacuum: reg('mbar', undefined, '100'), deaerationTime: reg('min', '30', '180'), viscosity: reg('mPa.s', '8000', '14000') },
      targets: { meltTemp: '70.0', vacuum: '50', viscosity: '11000' },
      equipmentClasses: { vesselClass: 'GEL-MELTING-TANK' },
      bomLines: { gelatinLine: 'L1' },
    },
  },
  {
    definition: {
      code: 'SG-ENCAP-ROTARY',
      version: 1,
      title: 'Rotary die encapsulation (soft gels)',
      category: 'PROCESS',
      instructions: 'Fit the die rolls the formulation names, connect the heated gel mass lines to the spreader boxes and the fill line to the hopper, and run the encapsulator. At each round, measure the ribbon thickness and the wedge temperature and weigh capsules for the fill and shell weight. The tumble and tray drying are their own step.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            // 21 CFR 211.105(a), 211.188(b); EU GMP 4.20(e): the major equipment and its change parts identified.
            { id: 'encapsulator', label: 'Rotary die encapsulation machine', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'encapsulatorClass' },
            { id: 'dieSet', label: 'Die rolls fitted (identification, as the formulation names the die)', type: 'TEXT' },
            // 21 CFR 211.101(d), 211.188(b); EU GMP 4.20(d): the intermediates added.
            { id: 'gelMassIn', label: 'Gel mass receiver', type: 'CONTAINER', action: 'CONSUME' },
            { id: 'fillIn', label: 'Fill material container', type: 'CONTAINER', action: 'CONSUME' },
            // EU GMP 5.14: transfer lines checked as connected correctly.
            { id: 'linesConnected', label: 'Gel mass and fill lines connected to this machine\'s spreader boxes and hopper', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'round',
          title: 'Encapsulation round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
            // 21 CFR 211.110(a), (b); EU GMP 4.18(e), 4.20(f): in-process controls of the process steps that cause variability
            // (ribbon and seal formation), with their limits. Fill and shell weight per capsule are IPC-SG-FILL-SHELL's (211.110(a)(1)).
            { id: 'ribbonThickness', label: 'Gel ribbon thickness', type: 'NUMBER', unit: 'mm', decimals: 2, limitSlot: 'ribbonThickness', critical: true },
            { id: 'wedgeTemp', label: 'Wedge temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'wedgeTemp', critical: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            // 21 CFR 211.105(a), 211.188(b), 211.103: the container, the weights and the rejects (the yield's inputs).
            { id: 'container', label: 'Wet capsules container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
            { id: 'rejects', label: 'Rejected capsules', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      // 21 CFR 211.101(d), 211.188(b)(11); EU GMP 4.20(c).
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { ribbonThickness: reg('mm', '0.76', '0.84'), wedgeTemp: reg('Cel', '36.0', '40.0') },
      targets: { ribbonThickness: '0.80', wedgeTemp: '38.0' },
      equipmentClasses: { encapsulatorClass: 'SOFTGEL-ENCAPSULATOR-ROTARY' },
      intervals: { roundInterval: { value: '30', unit: 'min' } },
    },
  },
  {
    definition: {
      code: 'SG-DRY',
      version: 1,
      title: 'Soft gel drying to the end point',
      category: 'PROCESS',
      instructions: 'Tumble dry the wet capsules at the set air temperature for the set time, then spread them on trays in the drying tunnel or room. Check the room temperature, relative humidity and capsule hardness until the hardness reaches its end point, then record the total tray drying time.',
      sections: [
        {
          id: 'tumble',
          title: 'Tumble drying',
          fields: [
            // 21 CFR 211.105(a), 211.188(b); EU GMP 4.20(e): the major equipment used.
            { id: 'tumbleDryer', label: 'Tumble dryer', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'tumbleDryerClass' },
            // 21 CFR 211.188(b); EU GMP 4.20(d): the intermediate taken in.
            { id: 'capsulesIn', label: 'Wet capsules container', type: 'CONTAINER', action: 'CONSUME' },
            // Schedule M Part VIII 2.3: critical time and temperature of each drying operation, in the master and recorded.
            { id: 'airTemp', label: 'Tumble dryer air temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'airTemp', critical: true },
            { id: 'tumbling', label: 'Tumble drying time', type: 'TIMER', durationUnit: 'min', limitSlot: 'tumblingTime', critical: true },
          ],
        },
        {
          id: 'trays',
          title: 'Tray drying',
          fields: [
            // 21 CFR 211.105(a), 211.188(b); EU GMP 4.20(e): where the drying runs.
            { id: 'tunnel', label: 'Drying tunnel or room', type: 'EQUIPMENT', kind: 'ROOM', classSlot: 'tunnelClass' },
            // Schedule M Part VIII 2.3: the critical drying time, timed (started when the trays go in, stopped at the passing end-point check).
            { id: 'dryingTime', label: 'Tray drying time (to the passing end-point check)', type: 'TIMER', durationUnit: 'h', limitSlot: 'dryingTime', critical: true },
          ],
        },
        {
          id: 'endPoint',
          title: 'Drying conditions and end-point check',
          repeat: { kind: 'UNTIL_PASS', untilField: 'hardness', maxRepeatsSlot: 'maxEndPointChecks' },
          fields: [
            // Schedule M Part VIII 2.3: the critical operating parameters of the drying (temperature; the humidity drives it).
            { id: 'roomTemp', label: 'Drying room temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'roomTemp', critical: true },
            { id: 'roomRh', label: 'Drying room relative humidity', type: 'NUMBER', unit: '%', decimals: 0, limitSlot: 'roomRh', critical: true },
            // 21 CFR 211.110(a), (b): the in-process control that ends the drying.
            { id: 'hardness', label: 'Capsule hardness (mean of the capsules checked)', type: 'NUMBER', unit: 'N', decimals: 1, limitSlot: 'hardness', critical: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            // 21 CFR 211.105(a), 211.188(b), 211.103: the container and the weight (the yield's input).
            { id: 'container', label: 'Dried capsules container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      // 21 CFR 211.188(b)(11); EU GMP 4.20(c).
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: {
        airTemp: reg('Cel', '20.0', '30.0'),
        tumblingTime: reg('min', '30', '240'),
        roomTemp: reg('Cel', '20.0', '25.0'),
        roomRh: reg('%', '20', '35'),
        hardness: reg('N', '8.0', '12.0'),
        dryingTime: reg('h', undefined, '96'),
      },
      targets: { airTemp: '25.0', roomTemp: '22.0', roomRh: '28', hardness: '10.0' },
      equipmentClasses: { tumbleDryerClass: 'SOFTGEL-TUMBLE-DRYER', tunnelClass: 'SOFTGEL-DRYING-TUNNEL' },
      counts: { maxEndPointChecks: '10' },
    },
  },
  {
    definition: {
      code: 'IPC-SG-FILL-SHELL',
      version: 1,
      title: 'Fill and shell weight per capsule (soft gels)',
      category: 'TEST_IPC',
      instructions: 'For each capsule the formulation names: weigh it whole, cut it open, wash out the fill with the solvent the method names, dry and weigh the shell. The fill weight is the gross weight less the shell weight.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            // 21 CFR 211.188(b); EU GMP 4.20(e): the equipment used.
            { id: 'weighBalance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
          ],
        },
        {
          id: 'capsule',
          title: 'Capsule',
          repeat: { kind: 'COUNT', countSlot: 'capsules' },
          fields: [
            // 21 CFR 211.110(a)(1), (b): capsule weight variation. The gross weight is the CALC's input (its limits guard
            // the reading); the shell weight and the fill weight per capsule are judged against the product limits.
            { id: 'gross', label: 'Gross weight of the capsule', type: 'NUMBER', unit: 'mg', decimals: 1, limitSlot: 'gross', help: 'The limits guard the reading itself; the fill weight is judged below.' },
            { id: 'shell', label: 'Shell weight', type: 'NUMBER', unit: 'mg', decimals: 1, limitSlot: 'shellWeight', critical: true },
            { id: 'fill', label: 'Fill weight', type: 'CALC', expression: 'gross - shell', unit: 'mg', limitSlot: 'individualFill', critical: true },
          ],
        },
        {
          id: 'summary',
          title: 'Mean fill weight',
          fields: [
            // 21 CFR 211.110(a)(1), (b): the mean fill weight against its limits.
            { id: 'meanFill', label: 'Mean fill weight', type: 'CALC', expression: 'mean(fill)', unit: 'mg', limitSlot: 'meanFill', critical: true },
          ],
        },
      ],
      signatures: [OPERATOR],
    },
    exampleUse: {
      limits: { gross: reg('mg', '700.0', '900.0'), shellWeight: reg('mg', '290.0', '330.0'), individualFill: reg('mg', '475.0', '525.0'), meanFill: reg('mg', '490.0', '510.0') },
      targets: { gross: '810.0', shellWeight: '310.0' },
      equipmentClasses: { balanceClass: 'ANALYTICAL-BALANCE' },
      counts: { capsules: '10' },
    },
  },
  {
    definition: {
      code: 'IPC-SG-SEAL-THICKNESS',
      version: 1,
      title: 'Seal thickness (soft gels)',
      category: 'TEST_IPC',
      instructions: 'Cut the capsules the formulation names across the seam and measure the seal thickness of each under the measuring microscope or gauge.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            // 21 CFR 211.188(b); EU GMP 4.20(e): the instrument used.
            { id: 'gauge', label: 'Measuring microscope or gauge', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'gaugeClass' },
            // 21 CFR 211.110(a), (b); EU GMP 4.20(f): an in-process control of the sealing with its limit.
            {
              id: 'seal',
              label: 'Seal thickness of each capsule',
              type: 'TEST_RESULT',
              unit: 'mm',
              replicatesSlot: 'capsules',
              statistics: [{ statistic: 'MIN', limitSlot: 'minSeal' }],
            },
          ],
        },
      ],
      signatures: [OPERATOR],
    },
    exampleUse: {
      limits: { minSeal: reg('mm', '0.40') },
      equipmentClasses: { gaugeClass: 'MEASURING-MICROSCOPE' },
      counts: { capsules: '10' },
    },
  },
  {
    definition: {
      code: 'IPC-SG-HARDNESS',
      version: 1,
      title: 'Hardness (soft gels)',
      category: 'TEST_IPC',
      instructions: 'Measure the hardness of each capsule the formulation names on the soft gel hardness tester.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            // 21 CFR 211.188(b); EU GMP 4.20(e): the instrument used.
            { id: 'tester', label: 'Soft gel hardness tester', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'testerClass' },
            // 21 CFR 211.110(a), (b); EU GMP 4.20(f): an in-process control of the dried capsules with its limits.
            {
              id: 'hardness',
              label: 'Hardness of each capsule',
              type: 'TEST_RESULT',
              unit: 'N',
              replicatesSlot: 'capsules',
              statistics: [
                { statistic: 'MEAN', limitSlot: 'meanHardness' },
                { statistic: 'INDIVIDUAL', limitSlot: 'individualHardness' },
              ],
            },
          ],
        },
      ],
      signatures: [OPERATOR],
    },
    exampleUse: {
      limits: { meanHardness: reg('N', '8.0', '12.0'), individualHardness: reg('N', '7.0', '13.0') },
      equipmentClasses: { testerClass: 'SOFTGEL-HARDNESS-TESTER' },
      counts: { capsules: '10' },
    },
  },
];
