/**
 * Injectables edition I-5 (docs/build-plan/injectables/plan.md, section 6): the vial with the deterministic 100 % container
 * closure integrity test and the automated visual inspection, from the library to its approved, IN-authorised master after
 * its sandbox test batch (library/injectables-inspection-acceptance.ts).
 */
import { defineInjectablesAcceptance } from './injectables-acceptance.ts';
import { INSPECTION_VIAL } from './injectables-inspection-acceptance.ts';

defineInjectablesAcceptance(INSPECTION_VIAL);
