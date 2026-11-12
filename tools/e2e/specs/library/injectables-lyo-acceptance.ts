/**
 * Injectables edition I-3 (docs/build-plan/injectables/plan.md, section 6 row I-3): a lyophilised vial, from the library
 * to its released lot, through the same acceptance as the I-1 products (library/injectables-acceptance.ts): the product
 * is data passed to `defineInjectablesAcceptance` and `defineInjectablesGmp`, with no change to the product's code.
 * It is the aseptic vial of I-2b (library/injectables-aseptic-acceptance.ts) with the lyophilisation (INJ-LYO) between
 * filling and capping:
 *  - the solution is compounded, sterile filtered and filled into part-stoppered vials on the RABS line in the Grade B
 *    room, as the aseptic vial's (the fill weights are the solution's);
 *  - every filled tray is consumed into its numbered lyophiliser load; each load's cycle values are typed from its
 *    printout, the stoppers are seated in the chamber, and the lyophilised load is registered;
 *  - the sterility samples are taken from the lyophilised units, then capping, inspection, container closure integrity,
 *    the EM counts after incubation and the unit accountability (the filled and rejected counts of filling and capping).
 * The lyophilised loads are the batch's output containers (the GMP half's generic output, #205). DEMO-ONLY data; every
 * code is unique per run.
 */
import { unit, type Injectable } from './injectables-acceptance.ts';
import { ASEPTIC_VIAL } from './injectables-aseptic-acceptance.ts';
import { productBlock } from './library-support.ts';

const LYO = productBlock('INJ-LYO', 'LYOPHILISER');

/** The aseptic vial's steps with the lyophilisation after the filling-time EM sampling, before the sterility samples. */
const steps = (): Injectable['steps'] => {
  const at = ASEPTIC_VIAL.steps.findIndex((b) => b.def.code === 'INJ-EM');
  const next = ASEPTIC_VIAL.steps[at + 1];
  if (at < 0 || next?.def.code !== 'INJ-STERILITY-SAMPLE') throw new Error('the aseptic vial no longer samples EM during filling before the sterility samples');
  return [...ASEPTIC_VIAL.steps.slice(0, at + 1), LYO, ...ASEPTIC_VIAL.steps.slice(at + 1)];
};

const gmp = ASEPTIC_VIAL.gmp;
if (!gmp) throw new Error('the aseptic vial has no GMP half');
// The lyophilised loads hold the units the aseptic vial's inspection accepts (its counts are the same).
const outputUnits = gmp.outputUnits;
if (outputUnits === undefined) throw new Error('the aseptic vial has no output units');

export const LYO_VIAL: Injectable = {
  key: 'lyo-vial',
  prefix: 'LLV20',
  name: 'Libinj 20 mg, powder for solution for injection in vials, lyophilised (library)',
  strength: '20 mg',
  dosageForm: 'Injection',
  targetMg: '62',
  // The solids per vial: the active, mannitol as the bulking agent (the compensating excipient) and the buffer.
  materials: [
    { id: 'api', name: 'Libinj lyo active', mgPerUnit: '20', tare: '0.200', gross: '1.200' },
    { id: 'mann', name: 'Mannitol (bulking agent)', mgPerUnit: '40', tare: '0.200', gross: '2.200' },
    { id: 'buf', name: 'Sodium dihydrogen phosphate dihydrate (buffer)', mgPerUnit: '2', tare: '0.050', gross: '0.150' },
  ],
  plant: [...ASEPTIC_VIAL.plant, unit('LYOPHILISER', 'Lyophiliser (freeze dryer)', 'TEST-LYO-01', 'Lyophiliser')],
  components: ASEPTIC_VIAL.components,
  steps: steps(),
  gmp: {
    plant: [...gmp.plant, unit('LYOPHILISER', 'Lyophiliser (freeze dryer)', 'LYO-01', 'Lyophiliser')],
    // The lyophilised loads are the output: 10,000 filled, less 20 rejected at the line, 40 at capping, 120 sampled, 20
    // lost and 80 rejected at inspection.
    outputStage: 'LYOPHILISATION',
    outputUnits,
  },
};
