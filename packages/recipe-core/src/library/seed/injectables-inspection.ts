/**
 * Ready-made library blocks of the Injectables edition, slice I-5: automated visual inspection and deterministic 100 %
 * container closure integrity testing (injectables plan v2, section 4; lead design approval, 12 November 2026). Rapid
 * microbiological methods are an option of the release tests (TEST-INJ-RELEASE in `injectables.ts`), not a block here.
 * Every block is data built from the existing field types and belongs to the `injectables` edition.
 *
 * Clauses (cited by number and paraphrased, never quoted):
 *  - Schedule M (SM) Part II 10.8: every filled parenteral container is inspected; a method other than visual is
 *    validated, its equipment checked at intervals, and the results recorded. The interval check is the machine's due
 *    date in the equipment register (the EQUIPMENT field refuses an overdue machine; 21 CFR 211.68(a) likewise), so no
 *    per-batch challenge is asked in the base block (lead, 12 November 2026).
 *  - EU GMP Annex 1 (A1) 8.32: an automated inspection machine is challenged with representative defects before start-up
 *    and at intervals through the batch: EU market only, in its own block (INJ-AVI-CHALLENGE-EU), as INJ-INSPECT-LIGHT.
 *  - A1 8.22, 8.23: fusion-closed units are integrity tested 100 % by a validated method; other closures by a justified
 *    sample (INJ-CCI). Which block a master uses is the master's choice: no refusal is added.
 *  - SM Part I 5.4.6 (every market) and 21 CFR 211.68(b): critical values typed by hand from a machine report get an
 *    additional accuracy check, so the counts typed from the report carry a CHECKED signature (lead, Q2).
 *  - 21 CFR 211.188(b), 211.192: every unit is accounted for; the 100 % integrity test's rejects reach the unit
 *    accountability (INJ-UNIT-ACCOUNT) through its total with the closing rejects.
 *
 * Kept out, no binding clause: an AQL after automated inspection (a firm that samples adds its own block), a limit on
 * the leak reject rate, a per-batch challenge of the integrity tester, a method field (the machine's class names it).
 *
 * Invented example values.
 */
import type { LimitSpec } from '../../limits/model.ts';
import type { SeedItem } from './types.ts';

const EDITION = 'injectables' as const;
const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const CHECKER = { meaning: 'CHECKED' as const, role: 'PRODUCTION_VERIFIER' };

/** A validated process range (inclusive bounds). */
const pv = (unit: string, low: string, high: string): LimitSpec => ({
  unit,
  ranges: [{ tier: 'VALIDATED', low: { value: low, inclusive: true }, high: { value: high, inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'PV-REF' } }],
});

/** Units counted (containers): a plain count. */
const UNITS = '{unit}';

export const INJECTABLE_INSPECTION_SEEDS: readonly SeedItem[] = [
  {
    // INJ-22 (automated): SM 10.8; SM 5.4.6 and 211.68(b) (counts typed from the machine report, checked). The defect
    // categories, the reject rate and its validated limit are those of the manual block INJ-VISUAL-INSPECT, so unit
    // accountability reads both alike.
    definition: {
      code: 'INJ-AVI',
      version: 1,
      title: '100 % automated visual inspection',
      category: 'CONTROL',
      edition: EDITION,
      roles: ['OBSERVATION'],
      description: 'INJ-22, automated. Every unit inspected by the validated inspection machine: the counts by defect category typed from the machine report and checked by a second person, the reject rate against its limit, and the units accepted.',
      instructions: 'Run the batch through the inspection machine. Type the counts from the machine report, attach the report, and have a second person check the counts against it.',
      sections: [
        {
          id: 'setup',
          title: 'Machine',
          fields: [{ id: 'machine', label: 'Inspection machine', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'aviClass' }],
        },
        {
          id: 'counts',
          title: 'Inspection (from the machine report)',
          fields: [
            { id: 'inspected', label: 'Units inspected', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'inspected' },
            { id: 'particles', label: 'Rejected: visible particles', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'particles' },
            { id: 'container', label: 'Rejected: container defects (cracks, glass, cosmetic)', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'containerDefects' },
            { id: 'fill', label: 'Rejected: fill level', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'fillDefects' },
            { id: 'closure', label: 'Rejected: closure or seal', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'closureDefects' },
            { id: 'rejected', label: 'Units rejected', type: 'CALC', expression: 'particles + container + fill + closure', unit: UNITS },
            { id: 'rejectRate', label: 'Reject rate', type: 'CALC', expression: 'rejected / inspected * 100 [%]', unit: '%', limitSlot: 'rejectRate', critical: true },
            { id: 'accepted', label: 'Units accepted', type: 'CALC', expression: 'inspected - rejected', unit: UNITS },
            { id: 'reportAttached', label: 'Machine report attached to the record', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {
      equipmentClasses: { aviClass: 'AVI-MACHINE' },
      limits: {
        inspected: pv(UNITS, '1', '100000'),
        particles: pv(UNITS, '0', '100000'),
        containerDefects: pv(UNITS, '0', '100000'),
        fillDefects: pv(UNITS, '0', '100000'),
        closureDefects: pv(UNITS, '0', '100000'),
        rejectRate: pv('%', '0', '2.0'),
      },
      targets: { inspected: '10000', particles: '20', containerDefects: '30', fillDefects: '25', closureDefects: '5' },
    },
  },
  {
    // INJ-22 (automated, EU): A1 8.32 (the machine challenged with representative defects before start-up and at
    // intervals through the batch). EU market only: SM 10.8's check at intervals is the machine's due date (lead,
    // 12 November 2026). Signed by the operator alone, as INJ-INSPECT-LIGHT: nothing is typed from a report.
    definition: {
      code: 'INJ-AVI-CHALLENGE-EU',
      version: 1,
      title: 'Inspection machine challenge (EU market)',
      category: 'CONTROL',
      edition: EDITION,
      markets: ['EU'],
      description: 'INJ-22, automated, EU market. The inspection machine challenged with the defect test set before start-up and at the intervals of the formulation through the batch.',
      instructions: 'Run the defect test set through the machine before start-up and at each interval of the formulation, and record whether every defect was rejected.',
      sections: [
        {
          id: 'challenge',
          title: 'Challenge',
          repeat: { kind: 'COUNT', countSlot: 'challengeCount' },
          fields: [
            { id: 'point', label: 'When', type: 'CHOICE', options: ['Before start-up', 'During the batch'] },
            { id: 'allRejected', label: 'Every defect of the test set was rejected', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR],
    },
    exampleUse: { counts: { challengeCount: '3' } },
  },
  {
    // INJ-23 (deterministic, 100 % in-line): A1 8.22 (fusion-closed units 100 % by a validated method; the master's
    // choice of block, no refusal); SM 5.4.6 and 211.68(b) (counts typed from the machine report, checked); 211.188(b)
    // and 211.192 (the leak rejects are accounted for through totalRejects, which INJ-UNIT-ACCOUNT reads as the closing
    // rejects). A leaker is a routine reject, not a batch failure (unlike a failure in INJ-CCI's sample).
    definition: {
      code: 'INJ-CCIT-100',
      version: 1,
      title: '100 % container closure integrity test (deterministic, in-line)',
      category: 'CONTROL',
      edition: EDITION,
      description: 'INJ-23, deterministic 100 %. Every unit tested by the validated integrity tester: the units tested and the leakers rejected typed from the machine report and checked by a second person, the units passed, and the rejects at closing and at the integrity test added up for the unit accountability.',
      instructions: 'Run every unit through the integrity tester. Type the counts from the machine report, attach the report, and have a second person check the counts against it.',
      inputs: [{ id: 'closingRejects', label: 'Units rejected at closing (from capping or sealing)', kind: 'STEP_VALUE', unit: UNITS, slot: 'closingRejectsSource' }],
      sections: [
        {
          id: 'test',
          title: 'Integrity test (from the machine report)',
          fields: [
            { id: 'tester', label: 'Integrity tester', type: 'EQUIPMENT', kind: 'EQUIPMENT', classSlot: 'cciClass' },
            { id: 'tested', label: 'Units tested', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'tested' },
            { id: 'leakRejects', label: 'Units rejected as leaking', type: 'NUMBER', unit: UNITS, decimals: 0, limitSlot: 'leakRejects' },
            { id: 'passed', label: 'Units passed', type: 'CALC', expression: 'tested - leakRejects', unit: UNITS },
            { id: 'totalRejects', label: 'Units rejected at closing and at the integrity test', type: 'CALC', expression: 'closingRejects + leakRejects', unit: UNITS },
            { id: 'reportAttached', label: 'Machine report attached to the record', type: 'YES_NO', expected: true },
          ],
        },
      ],
      signatures: [OPERATOR, CHECKER],
    },
    exampleUse: {
      equipmentClasses: { cciClass: 'CCI-TESTER' },
      limits: { tested: pv(UNITS, '1', '100000'), leakRejects: pv(UNITS, '0', '100000') },
      targets: { tested: '10000', leakRejects: '10' },
      stepValues: { closingRejectsSource: { step: 'capping', field: 'totalRejects' } },
    },
    exampleInputs: { closingRejects: { value: '40', unit: UNITS } },
  },
];
