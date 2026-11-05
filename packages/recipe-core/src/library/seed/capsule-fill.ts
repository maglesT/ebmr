/**
 * Ready-made library blocks: liquid and semi-solid fill, and plate filling (Capsules edition plan
 * `docs/build-plan/capsules/plan.md`, slice C5). Data only, built from the fixed field types (no new field type).
 * - PROC-FILL-PREP prepares a liquid or semi-solid fill (oil solution, suspension, emulsion, SMEDDS, paste,
 *   thermosoftening mass), shared by hard capsules and soft gels. It records the critical time and temperature of
 *   mixing, the deaeration vacuum and the viscosity (Schedule M Part VIII 2.3 to 2.5: critical times and temperatures
 *   recorded). The fill's hold before filling (21 CFR 211.111 and 211.113) is the master's existing hold step, PROC-HOLD,
 *   with its maximum (lead audit, 5 November 2026).
 * - PROC-CAPS-FILL-LIQUID fills that fill into hard capsules. EU GMP 5.14 asks that the connection of the lines that
 *   carry product be checked, so the step records that the fill lines go to the right machine and hopper. The seal or
 *   leak check is its own step, IPC-CAPS-SEAL-LEAK.
 * - PROC-CAPS-FILL-PLATE fills capsules on a manual or semi-automatic plate filler.
 * The empty shells are the formula's per-unit shell line (C2); their lot is checked against that line (S6). See types.ts.
 *
 * Invented example values (a size 0 capsule, 450 mg liquid fill or 300 mg powder fill).
 */
import type { LimitSpec } from '../../limits/model.ts';
import type { SeedItem } from './types.ts';

const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const VERIFIER = { meaning: 'VERIFIED' as const, role: 'PRODUCTION_VERIFIER' };

/** A registered limit range from the product specification (inclusive bounds). */
const spec = (unit: string, low?: string, high?: string): LimitSpec => ({
  unit,
  ranges: [{ tier: 'REGISTERED', ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'SPEC-REF' } }],
});

/** The capsule sizes a filler takes (as capsules.ts). */
const SIZES = ['000', '00', '0', '1', '2', '3', '4', '5'];

/** The kinds of liquid or semi-solid fill. */
const FILL_TYPES = ['Oil solution', 'Suspension', 'Emulsion', 'SMEDDS', 'Paste', 'Thermosoftening'];

export const CAPSULE_FILL_SEEDS: readonly SeedItem[] = [
  {
    definition: {
      code: 'PROC-FILL-PREP',
      version: 1,
      title: 'Liquid or semi-solid fill preparation',
      category: 'PROCESS',
      instructions: 'Charge the dispensed materials into the vessel, mix or homogenise at the set temperature for the set time, deaerate under vacuum and check the viscosity. The fill\'s hold before filling is the master\'s hold step (PROC-HOLD) with its maximum.',
      sections: [
        {
          id: 'prepare',
          title: 'Mixing and homogenisation',
          fields: [
            // 21 CFR 211.186(b)(9), 211.188(b); EU GMP 4.18: the kind of fill the processing instructions name.
            { id: 'fillType', label: 'Fill type', type: 'CHOICE', options: FILL_TYPES },
            // 21 CFR 211.105(a), 211.188(b); EU GMP 4.20(e): the major equipment used.
            { id: 'vessel', label: 'Preparation vessel with mixer or homogeniser', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'vesselClass' },
            // Schedule M Part VIII 2.3; 21 CFR 211.111: the critical time and temperature of mixing, recorded.
            { id: 'mixTemp', label: 'Mixing temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'mixTemp', critical: true },
            { id: 'mixing', label: 'Mixing or homogenisation time', type: 'TIMER', durationUnit: 'min', limitSlot: 'mixTime', critical: true },
          ],
        },
        {
          id: 'check',
          title: 'Deaeration and viscosity',
          fields: [
            // 21 CFR 211.110(a), (b); EU GMP 4.18(e), 4.20(f): in-process controls of the fill with their limits.
            { id: 'vacuum', label: 'Deaeration vacuum (absolute pressure)', type: 'NUMBER', unit: 'mbar', decimals: 0, limitSlot: 'vacuum' },
            { id: 'viscometer', label: 'Viscometer', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'viscometerClass' },
            { id: 'viscosity', label: 'Viscosity', type: 'NUMBER', unit: 'mPa.s', decimals: 0, limitSlot: 'viscosity' },
          ],
        },
        {
          id: 'output',
          title: 'Output',
          fields: [
            // 21 CFR 211.105(a), 211.188(b), 211.103: the container and the weight of the intermediate (its yield).
            { id: 'container', label: 'Fill container (closed)', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
          ],
        },
      ],
      // 21 CFR 211.101(d), 211.188(b)(11); EU GMP 4.20(c): the person who performed and the person who checked.
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { mixTemp: spec('Cel', '40.0', '50.0'), mixTime: spec('min', '30', '120'), vacuum: spec('mbar', undefined, '100'), viscosity: spec('mPa.s', '200', '800') },
      targets: { mixTemp: '45.0', vacuum: '50', viscosity: '500' },
      equipmentClasses: { vesselClass: 'SS-VESSEL-HOMOGENISER', viscometerClass: 'VISCOMETER' },
    },
  },
  {
    definition: {
      code: 'PROC-CAPS-FILL-LIQUID',
      version: 1,
      title: 'Capsule filling, liquid or semi-solid fill (hard capsules)',
      category: 'PROCESS',
      instructions: 'Fit the change parts of the capsule size, load the empty shells, connect the fill container and check that its lines go to the right machine and hopper. Run at the set fill temperature; record the fill temperature and fill weight at each round and set aside any leaking capsule. The seal or leak test is its own step.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            // 21 CFR 211.105(a), 211.188(b); EU GMP 4.20(e): the major equipment and its change parts identified.
            { id: 'filler', label: 'Liquid capsule filling machine', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'fillerClass' },
            { id: 'capsuleSize', label: 'Capsule size (change parts fitted)', type: 'CHOICE', options: SIZES },
            // 21 CFR 211.101(b)-(d), 211.188(b); Schedule M 14.16-14.17: the shells' lot checked against the formula line.
            { id: 'shellLot', label: 'Empty capsule shells lot', type: 'MATERIAL_LOT', bomLineSlot: 'shellLine' },
            // 21 CFR 211.101(d), 211.188(b); EU GMP 4.20(d): the intermediate added.
            { id: 'fillIn', label: 'Fill container', type: 'CONTAINER', action: 'CONSUME' },
            // EU GMP 5.14: transfer lines checked as connected correctly.
            { id: 'linesConnected', label: 'Fill lines connected to the right machine and hopper', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'round',
          title: 'Filling round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
            // 21 CFR 211.110(a)(1), (b); EU GMP 4.20(f): in-process controls at each round (fill weight is capsule weight variation).
            { id: 'fillTemp', label: 'Fill temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'fillTemp' },
            { id: 'fillWeight', label: 'Average fill weight', type: 'NUMBER', unit: 'mg', decimals: 1, limitSlot: 'fillWeight', critical: true },
            { id: 'noLeakers', label: 'No leaking capsules', type: 'YES_NO', expected: true },
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
      // 21 CFR 211.101(d), 211.188(b)(11); EU GMP 4.20(c).
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { fillTemp: spec('Cel', '40.0', '50.0'), fillWeight: spec('mg', '427.5', '472.5') },
      targets: { fillTemp: '45.0', fillWeight: '450.0' },
      equipmentClasses: { fillerClass: 'CAPSULE-FILLER-LIQUID' },
      bomLines: { shellLine: 'L1' },
      intervals: { roundInterval: { value: '30', unit: 'min' } },
    },
  },
  {
    definition: {
      code: 'PROC-CAPS-FILL-PLATE',
      version: 1,
      title: 'Capsule plate filling (manual or semi-automatic)',
      category: 'PROCESS',
      instructions: 'Fit the plates of the capsule size, load and rectify the empty shells, spread the blend over the plate, then close and lock the capsules. Record the average fill weight at each round.',
      sections: [
        {
          id: 'setup',
          title: 'Set-up',
          fields: [
            // 21 CFR 211.105(a), 211.188(b); EU GMP 4.20(e): the equipment and its plates identified.
            { id: 'filler', label: 'Capsule plate filler', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'fillerClass' },
            { id: 'capsuleSize', label: 'Capsule size (plates fitted)', type: 'CHOICE', options: SIZES },
            // 21 CFR 211.101(b)-(d), 211.188(b); Schedule M 14.16-14.17: the shells' lot checked against the formula line.
            { id: 'shellLot', label: 'Empty capsule shells lot', type: 'MATERIAL_LOT', bomLineSlot: 'shellLine' },
            // 21 CFR 211.101(d), 211.188(b); EU GMP 4.20(d): the intermediate added.
            { id: 'blendIn', label: 'Blend container', type: 'CONTAINER', action: 'CONSUME' },
          ],
        },
        {
          id: 'round',
          title: 'Filling round',
          repeat: { kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' },
          fields: [
            // 21 CFR 211.110(a)(1), (b); Schedule M Part VIII 7.1: capsule weight variation; split or unlocked capsules removed.
            { id: 'fillWeight', label: 'Average fill weight', type: 'NUMBER', unit: 'mg', decimals: 1, limitSlot: 'fillWeight', critical: true },
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
      // 21 CFR 211.101(d), 211.188(b)(11); EU GMP 4.20(c).
      signatures: [OPERATOR, VERIFIER],
    },
    exampleUse: {
      limits: { fillWeight: spec('mg', '285.0', '315.0') },
      targets: { fillWeight: '300.0' },
      equipmentClasses: { fillerClass: 'CAPSULE-FILLER-PLATE' },
      bomLines: { shellLine: 'L1' },
      intervals: { roundInterval: { value: '30', unit: 'min' } },
    },
  },
];
