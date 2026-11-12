/**
 * Injectables edition I-5 (docs/build-plan/injectables/plan.md, section 6: each method runs in the sandbox): the I-1 vial
 * with the deterministic 100 % container closure integrity test after capping (INJ-CCIT-100, in place of the sampled
 * INJ-CCI) and the automated visual inspection (INJ-AVI, in place of the manual booth), built from the library on screen and
 * its sandbox test batch run to Execution complete, approved and IN-authorised by the I-1 acceptance
 * (`defineInjectablesAcceptance`, the product passed as data). Unit accountability reads the units rejected at closing from
 * the integrity test's total (the capping rejects and the leakers) and the units accepted from the inspection. A master
 * for India: the EU-market challenge block (INJ-AVI-CHALLENGE-EU) is left out.
 * DEMO-ONLY data; every code is unique per run.
 */
import { productBlock } from './library-support.ts';
import { INJECTABLES, unit, VIAL_COUNTS, type Injectable } from './injectables-acceptance.ts';

/**
 * The counts that add up: 10,000 filled, 20 rejected at the line, 40 at capping; 9,800 tested for integrity with 10
 * leakers; 9,790 inspected with 80 rejects (9,710 accepted); 120 sampled and 20 documented losses.
 */
const COUNTS = {
  ccit: { test: { tested: '9800', leakRejects: '10' } },
  inspect: { counts: { inspected: '9790', particles: '20', container: '30', fill: '25', closure: '5' } },
} as const;

/** A calculated value as the entry list shows it: the label, the exact value (no decimals or zeros only) and its unit. */
const calc = (label: string, value: string): RegExp => new RegExp(`${label.replace(/[()]/g, '\\$&')} ${value}(\\.0+)? \\{unit\\} \\(calculated`);

const found = INJECTABLES.find((x) => x.key === 'vial');
if (!found) throw new Error('the I-1 vial is not in the acceptance');
// The sandbox half only (plan section 6): the vial's GMP data is not carried over.
const vial: Injectable = Object.fromEntries(Object.entries(found).filter(([k]) => k !== 'gmp')) as unknown as Injectable;

const steps: Injectable['steps'] = vial.steps.flatMap((b): Injectable['steps'] => {
  switch (b.def.code) {
    // The 100 % integrity test follows capping and reads its rejects; the sampled test is not used.
    case 'INJ-CAPPING':
      // The counts typed from the report are checked by a second person; 9,790 passed and 50 rejected in all (40 at
      // capping, read from that step, and 10 leakers).
      return [b, {
        ...productBlock('INJ-CCIT-100', 'CCI-TESTER'),
        values: COUNTS.ccit,
        expect: { verified: true, entries: [calc('Units passed', '9790'), calc('Units rejected at closing and at the integrity test', '50')] },
      }];
    case 'INJ-CCI':
      return [];
    case 'INJ-VISUAL-INSPECT':
      return [{
        ...productBlock('INJ-AVI', 'AVI-MACHINE'),
        values: COUNTS.inspect,
        expect: { verified: true, entries: [calc('Units rejected', '80'), calc('Units accepted', '9710')] },
      }];
    // The closing rejects from the integrity test's total, the units accepted and rejected at inspection from INJ-AVI.
    case 'INJ-UNIT-ACCOUNT':
      // 150 rejected (20 at the line, 50 at closing and the integrity test, 80 at inspection): the integrity test's total
      // is the one read; nothing is unaccounted for.
      return [{
        ...productBlock('INJ-UNIT-ACCOUNT', {}, undefined, { capping: 'INJ-CCIT-100', inspection: 'INJ-AVI' }),
        values: VIAL_COUNTS.account,
        expect: { entries: [calc('Units rejected (line, closing and inspection)', '150'), calc('Units not accounted for', '0')] },
      }];
    default:
      return [b];
  }
});

export const INSPECTION_VIAL: Injectable = {
  ...vial,
  key: 'inspection-vial',
  prefix: 'LIA10',
  name: 'Libinj 10 mg/2 mL, solution for injection in vials, automated inspection and 100 % integrity test (library)',
  plant: [
    ...vial.plant.filter((u) => u.classCode !== 'INSPECTION-BOOTH'),
    unit('CCI-TESTER', 'Container closure integrity tester (deterministic, in-line)', 'TEST-CCIT-01', 'Integrity tester'),
    unit('AVI-MACHINE', 'Automated visual inspection machine', 'TEST-AVI-01', 'Inspection machine'),
  ],
  steps,
};
