/**
 * Ready-made library blocks: hard capsules (decision 0026; Capsules edition plan `docs/build-plan/capsules/plan.md`,
 * approved 4 November 2026). Capsule products are library data in the oral-solid build: these blocks load with the rest
 * of the catalogue (the 3 November deferral, R3-CAT-4, is lifted).
 * Filling (the filler and its filling principle, the capsule size, the empty shells' lot, the fill weight and machine
 * speed at each round), polishing and sorting, and the capsule's own in-process tests (fill weight variation, locked
 * length, appearance, disintegration), and a capsule dissolution test (QC's, with sinkers). The empty capsule shells are
 * a material like any other: their lot is named in the filling step and checked against the lot register (S6). See
 * types.ts.
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
const SIZES = ['000', '00', '0', '1', '2', '3', '4', '5'];

/** How an automatic filler doses powder or granules (the equipment class names the machine). */
const FILLING_PRINCIPLES = ['Dosator', 'Tamping / dosing disc', 'Vacuum', 'Auger'];

export const CAPSULE_SEEDS: readonly SeedItem[] = [
  {
    definition: {
      code: 'PROC-CAPS-FILL',
      version: 1,
      title: 'Capsule filling (hard capsules)',
      category: 'PROCESS',
      instructions: 'Fit the change parts of the capsule size, record the filler\'s filling principle (dosator, tamping disc, vacuum or auger), load the empty shells and the blend, and run at the set speed. Record the fill weight and speed at each round; the weight tests are their own steps.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            // 21 CFR 211.105(a), 211.188(b); EU GMP 4.20(e): the major equipment, its filling principle and change parts identified.
            { id: 'filler', label: 'Capsule filling machine', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'fillerClass' },
            { id: 'fillingPrinciple', label: 'Filling principle', type: 'CHOICE', options: FILLING_PRINCIPLES },
            { id: 'capsuleSize', label: 'Capsule size (change parts fitted)', type: 'CHOICE', options: SIZES },
            // 21 CFR 211.101(b)-(d), 211.188(b); Schedule M 14.16-14.17 and Part VIII 5: the shells' lot checked against the formula line, and the shells checked as the right ones.
            { id: 'shellLot', label: 'Empty capsule shells lot', type: 'MATERIAL_LOT', bomLineSlot: 'shellLine' },
            { id: 'shellsInspected', label: 'Shells of the right colour and print, free of dents and splits', type: 'YES_NO', expected: true },
            // 21 CFR 211.101(d), 211.188(b); EU GMP 4.20(d): the intermediate added.
            { id: 'blendIn', label: 'Blend container', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'round',
          title: 'Filling round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
            // 21 CFR 211.110(a)(1), (b); EU GMP 4.20(f); Schedule M Part VIII 7.1: in-process controls at each round (capsule weight variation; split capsules removed).
            { id: 'fillWeight', label: 'Average fill weight', type: 'NUMBER', unit: 'mg', decimals: 1, limitSlot: 'fillWeight', critical: true },
            { id: 'speed', label: 'Machine speed', type: 'NUMBER', unit: '/h', decimals: 0, limitSlot: 'speed' },
            { id: 'locked', label: 'Capsules closed and locked, none split', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            // 21 CFR 211.105(a), 211.188(b), 211.103: the container, the weights and the rejects (the yield's inputs).
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
      bomLines: { shellLine: 'L1' },
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
      title: 'Disintegration or rupture time (capsules)',
      category: 'TEST_IPC',
      instructions: 'Run the test the specification names. Disintegration: with discs if the method says so; a capsule whose shell fragments remain is disintegrated. Rupture (soft gels): the time at which the shell ruptures.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            // 21 CFR 211.110(a)(2), (b) (C7): disintegration time, or the rupture test where the registered specification of a
            // soft gel names it; the limits are the specification's in either case.
            { id: 'testKind', label: 'Test', type: 'CHOICE', options: ['Disintegration', 'Rupture'] },
            { id: 'apparatus', label: 'Disintegration apparatus', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'apparatusClass' },
            { id: 'discs', label: 'Discs used as the method says', type: 'YES_NO', expected: true },
            { id: 'mediumTemp', label: 'Medium temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'mediumTemp', critical: true },
            {
              id: 'time',
              label: 'Time for each capsule to disintegrate or rupture',
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
  // C3, post-fill (Capsules edition plan, section 3.1): 100 % checkweighing, visual inspection and sorting, printing
  // (held for QC approval at the master's hold point before packaging, Schedule M Part VIII 6), banding or sealing (an OTC
  // two-piece hard capsule, 21 CFR 211.132) and the seal integrity check. Each is shared by hard capsules and soft gels.
  {
    definition: {
      code: 'PROC-CAPS-CHECKWEIGH',
      version: 1,
      title: 'Capsule checkweighing (100 % weight sorting)',
      category: 'PROCESS',
      instructions: 'Set the checkweigher\'s reject limits to the master\'s and pass every capsule through it. Light and heavy capsules go to the reject bin.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            // 21 CFR 211.105(a), 211.68(a), 211.188(b); EU GMP 4.20(e): the automatic equipment and the reject limits it was set to.
            { id: 'checkweigher', label: 'Capsule checkweigher', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'checkweigherClass' },
            { id: 'rejectLow', label: 'Lower reject limit set', type: 'NUMBER', unit: 'mg', decimals: 1, limitSlot: 'rejectLow' },
            { id: 'rejectHigh', label: 'Upper reject limit set', type: 'NUMBER', unit: 'mg', decimals: 1, limitSlot: 'rejectHigh' },
            // 21 CFR 211.188(b); EU GMP 4.20(d): the intermediate taken in.
            { id: 'capsulesIn', label: 'Capsules container in', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            // 21 CFR 211.105(a), 211.188(b), 211.103: the container, the weights and the rejects (the yield's inputs).
            { id: 'container', label: 'Accepted capsules container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
            { id: 'rejects', label: 'Weight-rejected capsules', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      // 21 CFR 211.101(d), 211.188(b)(11); EU GMP 4.20(c).
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { rejectLow: spec('mg', '370.0', '376.0'), rejectHigh: spec('mg', '416.0', '422.0') },
      targets: { rejectLow: '373.0', rejectHigh: '419.0' },
      equipmentClasses: { checkweigherClass: 'CAPSULE-CHECKWEIGHER' },
    },
  },
  {
    definition: {
      code: 'PROC-CAPS-INSPECT',
      version: 1,
      title: 'Visual inspection and sorting (capsules)',
      category: 'PROCESS',
      instructions: 'Inspect every capsule on the inspection belt or camera inspector and remove the defective ones: dents, splits, leakers, misshapen, double-capped and empty capsules and foreign capsules. A second person checks the removal independently.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            // 21 CFR 211.105(a), 211.188(b); EU GMP 4.20(e): the equipment used.
            { id: 'inspector', label: 'Inspection machine or belt', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'inspectorClass' },
            // 21 CFR 211.188(b); EU GMP 4.20(d): the intermediate taken in.
            { id: 'capsulesIn', label: 'Capsules container in', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            // Schedule M Part VIII 7.1: rogue and defective capsules removed, with an independent recorded check (the verifier); 21 CFR 211.103 for the weights.
            { id: 'defectsRemoved', label: 'Defective and foreign capsules removed', type: 'YES_NO', expected: true },
            { id: 'container', label: 'Inspected capsules container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
            { id: 'rejects', label: 'Rejected capsules', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      // Schedule M Part VIII 7.1; 21 CFR 211.188(b)(11); EU GMP 4.20(c): the operator and the independent check.
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { inspectorClass: 'CAPSULE-INSPECTOR' },
    },
  },
  {
    definition: {
      code: 'PROC-CAPS-PRINT',
      version: 1,
      title: 'Capsule printing',
      category: 'PROCESS',
      instructions: 'Print in a segregated area with an approved edible ink. Check the print at each round against the master\'s text. The printed capsules are held until QC approves them at the hold point before packaging.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            // 21 CFR 211.105(a), 211.188(b); EU GMP 4.20(e): the major equipment used.
            { id: 'printer', label: 'Capsule printing machine', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'printerClass' },
            // Schedule M Part VIII 6.1: printing segregated, with edible inks; EU GMP 5.9.
            { id: 'segregated', label: 'Printing area segregated and cleared of other print', type: 'YES_NO', expected: true },
            { id: 'ink', label: 'Edible ink (name and lot)', type: 'TEXT' },
            { id: 'inkApproved', label: 'Ink is the master\'s approved edible ink', type: 'YES_NO', expected: true },
            // 21 CFR 211.188(b); EU GMP 4.20(d): the intermediate taken in.
            { id: 'capsulesIn', label: 'Capsules container in', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'round',
          title: 'Print check',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'checkInterval' },
          fields: [
            // 21 CFR 211.110(a); EU GMP 5.54: the print checked at each round.
            { id: 'legible', label: 'Print legible, complete and as the master\'s text', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            // 21 CFR 211.105(a), 211.188(b), 211.103: the container, the weights and the misprints (the yield's inputs).
            { id: 'container', label: 'Printed capsules container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
            { id: 'rejects', label: 'Misprinted capsules', type: 'WEIGHING', unit: 'kg' },
            // Schedule M Part VIII 6.2: printed capsules wait for QC approval before packaging (the master's hold point, D-C3-2).
            { id: 'heldForQc', label: 'Printed capsules labelled as held for QC approval', type: 'YES_NO', expected: true },
          ],
        },
      ],
      // 21 CFR 211.101(d), 211.188(b)(11); EU GMP 4.20(c).
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      equipmentClasses: { printerClass: 'CAPSULE-PRINTER' },
      intervals: { checkInterval: { value: '30', unit: 'min' } },
    },
  },
  {
    definition: {
      code: 'PROC-CAPS-BAND',
      version: 1,
      title: 'Capsule banding and sealing',
      category: 'PROCESS',
      instructions: 'Use the band or sealing solution within the hold the master sets (its hold step). Band or seal every capsule and check the bands at each round. An OTC two-piece hard capsule must be sealed (tamper evident); the seal integrity test is its own step.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            // 21 CFR 211.105(a), 211.188(b); EU GMP 4.20(e): the major equipment used.
            { id: 'bander', label: 'Banding or sealing machine', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'banderClass' },
            // 21 CFR 211.132(b)(2): an OTC two-piece hard capsule sealed with a tamper-evident technology, named here.
            { id: 'technology', label: 'Sealing technology', type: 'CHOICE', options: ['Gelatin band', 'HPMC band', 'Liquid fusion sealing'] },
            // 21 CFR 211.110(a), (b); Schedule M Part VIII 2.5: the band solution used under its limits.
            { id: 'solutionTemp', label: 'Band solution temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'solutionTemp' },
            // 21 CFR 211.188(b); EU GMP 4.20(d): the intermediate taken in.
            { id: 'capsulesIn', label: 'Capsules container in', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'round',
          title: 'Banding round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
            // 21 CFR 211.110(a), 211.132(b)(2): the seal checked at each round.
            { id: 'bandIntact', label: 'Bands complete, even and closed on the capsules examined', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            // 21 CFR 211.105(a), 211.188(b), 211.103: the container, the weights and the rejects (the yield's inputs).
            { id: 'container', label: 'Banded capsules container', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
            { id: 'rejects', label: 'Rejected capsules', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      // 21 CFR 211.101(d), 211.188(b)(11); EU GMP 4.20(c).
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { solutionTemp: spec('Cel', '45.0', '55.0') },
      targets: { solutionTemp: '50.0' },
      equipmentClasses: { banderClass: 'CAPSULE-BANDER' },
      intervals: { roundInterval: { value: '30', unit: 'min' } },
    },
  },
  {
    definition: {
      code: 'IPC-CAPS-SEAL-LEAK',
      version: 1,
      title: 'Seal integrity and leakers (capsules)',
      category: 'TEST_IPC',
      instructions: 'Test the sample the formulation names for leaks (banded or sealed hard capsules, soft gels). Any leaker fails the check: the capsules are held and a deviation is raised.',
      sections: [
        {
          id: 'test',
          title: 'Test',
          fields: [
            // 21 CFR 211.188(b); EU GMP 4.20(e): the equipment used.
            { id: 'tester', label: 'Leak tester', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'testerClass' },
            // 21 CFR 211.110(a), (b), 211.132(b)(2); Schedule M Part VIII 7.4: the seal integrity check with its registered limit (D-C3-1).
            { id: 'tested', label: 'Capsules tested', type: 'SAMPLE', unitsSlot: 'capsules', purpose: 'Seal integrity' },
            { id: 'leakers', label: 'Leaking or unsealed capsules', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'leakers', critical: true },
          ],
        },
      ],
      // 21 CFR 211.188(b)(11); EU GMP 4.20(c).
      signatures: [OPERATOR],
    },
    exampleUse: {
      limits: { leakers: spec('1', '0', '0') },
      equipmentClasses: { testerClass: 'LEAK-TESTER' },
      counts: { capsules: '50' },
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
