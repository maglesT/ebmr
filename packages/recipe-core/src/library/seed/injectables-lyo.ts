/**
 * Ready-made library blocks of the Injectables edition, slice I-3: lyophilisation (injectables plan v2, section 4.3 row
 * "Lyophilisation (loading, cycle, unloading)", block INJ-17; `docs/build-plan/injectables/plan.md`). As in slices I-1
 * and I-2, every block is data built from the existing field types and belongs to the `injectables` edition.
 *
 * Binding clauses, checked against the official texts (session 11, 10 November 2026) and paraphrased:
 *  - 21 CFR 211.113(b): an aseptic or sterilisation process is validated and the batch is made by it, so the record
 *    names the lyophiliser, the validated load and programme, and the cycle values that show the programme ran;
 *    211.188(b): the batch record documents each significant step and the equipment used; 211.68(b): values typed from
 *    a device printout are checked by a second person (CHECKED signature; there is no device gateway, plan Q2).
 *  - Revised Schedule M, Part II 4.11: each operation in its grade. The room and line classes come from the
 *    formulation (the filling block names the Grade A line in its Grade B room); nothing here repeats them.
 *  - EU GMP Annex 1, EU-market batches only, in their own block INJ-LYO-EU (owner Q0; lead, 6 November 2026):
 *    8.124 (the vent filter's integrity result is part of batch release; the chamber's air leakage checked at the start
 *    of every cycle against its specified maximum), 8.122-8.123 (the lyophiliser sterilised as its design and loading
 *    mode require: the record names the sterilisation cycle before each load, itself recorded by INJ-SIP), 8.125 (trays
 *    checked for damage), 8.126 (transfer of partially closed containers under Grade A by a stated means, sterile
 *    loading utensils) and 10.6(iii) (sterility samples from the different lyophilisation loads).
 *
 * Choices kept to the binding minimum (plan sections 1 and 8a):
 *  - The loads are containers, as for terminal sterilisation (INJ-21): each filled tray is consumed into its numbered
 *    load and each load registers its lyophilised output, so every unit's load is in the genealogy.
 *  - The cycle values are those the plan names (shelf temperatures, chamber pressure, phase durations) typed from the
 *    printout; the limits are the firm's validated cycle, set in the formulation. A comparison with a historian's
 *    full trace is not built: no binding clause asks for it (ST-59's SCADA cycle record is MODIFY, control decisions).
 *  - Time limits (filling to loading, the exposure of part-stoppered vials, the lyophiliser's sterilisation to use) are
 *    the master's time constraints on trusted time, not typed times (lead, I-1; LIB-CALC-DATE-TIME).
 *  - The air leakage is the chamber's pressure rise over the leak test's validated time, as the printout gives it: the
 *    unit catalogue has pressures and no leak-rate unit, and a new unit is not needed to record the test.
 *
 * Invented example values (DEMO-ONLY): the firm sets every limit, count and class in its formulation.
 */
import type { LimitSpec } from '../../limits/model.ts';
import type { SeedItem } from './types.ts';

const EDITION = 'injectables' as const;
const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const CHECKER = { meaning: 'CHECKED' as const, role: 'PRODUCTION_VERIFIER' };

/** A validated process range (inclusive bounds) from the validation report. */
const pv = (unit: string, low?: string, high?: string): LimitSpec => ({
  unit,
  ranges: [{ tier: 'VALIDATED', ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'PV-REF' } }],
});

/** The validated loads of a lyophiliser (the formulation's load is one of them). */
const LYO_LOADS = ['Full load (validated maximum)', 'Partial load (validated minimum)'];

/** The means of moving partially closed containers to the lyophiliser under Grade A (Annex 1 8.126(ii)). */
const TRANSFER_MEANS = ['Conveyor under Grade A', 'Clean-air transfer cart', 'Portable unidirectional airflow unit', 'Trays closed in Grade A, not opened in Grade B'];

export const INJECTABLE_LYO_SEEDS: readonly SeedItem[] = [
  {
    // INJ-17: 211.113(b), 211.188(b), 211.68(b); SM Part II 4.11. The EU-market items are INJ-LYO-EU.
    definition: {
      code: 'INJ-LYO',
      version: 1,
      title: 'Lyophilisation (loading, cycle, unloading)',
      category: 'PROCESS',
      edition: EDITION,
      description: 'INJ-17. The lyophiliser and its validated load; every filled tray consumed into its numbered load; for each load the programme and the cycle values typed from the printout (checked by a second person), the stoppers seated in the chamber, and the lyophilised load registered.',
      instructions: 'Load the part-stoppered trays to the validated pattern. For each load, read the values from its cycle printout and attach it, check that the stoppers were fully seated before the chamber was opened, and register the lyophilised load.',
      sections: [
        {
          id: 'setup',
          title: 'Lyophiliser',
          fields: [
            { id: 'lyophiliser', label: 'Lyophiliser', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'lyophiliserClass' },
            { id: 'loadPattern', label: 'Load (validated pattern)', type: 'CHOICE', options: LYO_LOADS },
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
            { id: 'programme', label: 'Cycle programme (name and version, from the printout)', type: 'TEXT', maxLength: 40 },
            { id: 'cycleNumber', label: 'Cycle number (from the printout)', type: 'TEXT', maxLength: 40 },
            { id: 'freezeShelfTemp', label: 'Freezing: shelf temperature in the hold', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'freezeShelfTemp', critical: true },
            { id: 'primaryShelfTemp', label: 'Primary drying: shelf temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'primaryShelfTemp', critical: true },
            { id: 'primaryPressure', label: 'Primary drying: chamber pressure', type: 'NUMBER', unit: 'Pa', decimals: 1, limitSlot: 'primaryPressure', critical: true },
            { id: 'primaryTime', label: 'Primary drying: duration', type: 'NUMBER', unit: 'h', decimals: 1, limitSlot: 'primaryTime', critical: true },
            { id: 'secondaryShelfTemp', label: 'Secondary drying: shelf temperature', type: 'NUMBER', unit: 'Cel', decimals: 1, limitSlot: 'secondaryShelfTemp', critical: true },
            { id: 'secondaryTime', label: 'Secondary drying: duration', type: 'NUMBER', unit: 'h', decimals: 1, limitSlot: 'secondaryTime', critical: true },
            { id: 'stoppered', label: 'Stoppers fully seated before the chamber was opened', type: 'YES_NO', expected: true },
            { id: 'cyclePassed', label: 'Cycle passed (no alarm on the printout)', type: 'YES_NO', expected: true },
            { id: 'loadOut', label: 'Lyophilised load', type: 'CONTAINER', action: 'REGISTER' },
            { id: 'printoutAttached', label: 'Printout attached to the record', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {
      equipmentClasses: { lyophiliserClass: 'LYOPHILISER' },
      limits: {
        freezeShelfTemp: pv('Cel', '-45.0', '-40.0'),
        primaryShelfTemp: pv('Cel', '-25.0', '-15.0'),
        primaryPressure: pv('Pa', '8.0', '12.0'),
        primaryTime: pv('h', '30.0', '40.0'),
        secondaryShelfTemp: pv('Cel', '25.0', '35.0'),
        secondaryTime: pv('h', '6.0', '10.0'),
      },
      targets: { freezeShelfTemp: '-42.0', primaryShelfTemp: '-20.0', primaryPressure: '10.0', primaryTime: '35.0', secondaryShelfTemp: '30.0', secondaryTime: '8.0' },
    },
  },
  {
    // INJ-17, EU market: A1 8.122-8.126, 10.6(iii).
    definition: {
      code: 'INJ-LYO-EU',
      version: 1,
      title: 'Lyophilisation, EU market (vent filter, leak test, transfer, per-load samples)',
      category: 'PROCESS',
      edition: EDITION,
      markets: ['EU'],
      description: 'INJ-17, EU market. The trays and loading utensils, the Grade A transfer means, the vent filter\'s sterilisation and integrity result; for each load the lyophiliser\'s sterilisation cycle before it, the leak test at the start of the cycle against the firm\'s maximum, and the load\'s sterility samples.',
      instructions: 'Read the vent-filter and leak-test values from the printouts and attach them. A second person checks the typed values against the printouts. Take each load\'s sterility samples as the formulation states.',
      sections: [
        {
          id: 'loading',
          title: 'Loading',
          fields: [
            { id: 'traysChecked', label: 'Trays checked: none misshapen or damaged', type: 'YES_NO', expected: true },
            { id: 'transferMeans', label: 'Transfer of the part-stoppered vials under Grade A', type: 'CHOICE', options: TRANSFER_MEANS },
            { id: 'utensilsSterile', label: 'Loading and unloading utensils sterile', type: 'YES_NO', expected: true },
          ],
        },
        {
          id: 'ventFilter',
          title: 'Vent filter',
          fields: [
            { id: 'ventFilterSterilised', label: 'Vent filter sterilised before this use', type: 'YES_NO', expected: true },
            { id: 'ventMethod', label: 'Integrity test method (of the formulation)', type: 'CHOICE', options: ['Bubble point', 'Diffusion'] },
            { id: 'ventBubblePoint', label: 'Vent filter bubble point', type: 'NUMBER', unit: 'bar', decimals: 2, limitSlot: 'ventBubblePoint', critical: true, showWhen: { field: 'ventMethod', equals: 'Bubble point' } },
            { id: 'ventDiffusion', label: 'Vent filter diffusion', type: 'NUMBER', unit: 'mL/min', decimals: 1, limitSlot: 'ventDiffusion', critical: true, showWhen: { field: 'ventMethod', equals: 'Diffusion' } },
          ],
        },
        {
          id: 'load',
          title: 'Load',
          repeat: { kind: 'PER_CONTAINER' },
          fields: [
            { id: 'loadNumber', label: 'Load number', type: 'TEXT', maxLength: 20 },
            { id: 'sterilisationCycle', label: 'Sterilisation cycle of the lyophiliser before this load (cycle number)', type: 'TEXT', maxLength: 40 },
            { id: 'leakRise', label: 'Leak test at the start of the cycle: pressure rise over the test time', type: 'NUMBER', unit: 'Pa', decimals: 1, limitSlot: 'leakRise', critical: true },
            { id: 'sterilitySample', label: 'Sterility samples of the load', type: 'SAMPLE', unitsSlot: 'loadSterilitySamples', purpose: 'Sterility test, per lyophilisation load' },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {
      limits: { ventBubblePoint: pv('bar', '1.10'), ventDiffusion: pv('mL/min', undefined, '15.0'), leakRise: pv('Pa', undefined, '2.0') },
      targets: { ventBubblePoint: '1.30', ventDiffusion: '8.0', leakRise: '1.0' },
      counts: { loadSterilitySamples: '20' },
    },
  },
];
