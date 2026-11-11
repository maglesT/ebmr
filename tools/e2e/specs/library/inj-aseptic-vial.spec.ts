/**
 * Injectables edition I-2b (docs/build-plan/injectables/plan.md, section 6 row I-2): the aseptically filled vial
 * (library/injectables-aseptic-acceptance.ts) from the library to its released lot. The sandbox half runs first in this
 * serial file; the GMP half takes its product, approved master and IN authorisation from it.
 */
import { defineInjectablesAcceptance, defineInjectablesGmp } from './injectables-acceptance.ts';
import { ASEPTIC_VIAL } from './injectables-aseptic-acceptance.ts';

defineInjectablesAcceptance(ASEPTIC_VIAL);
defineInjectablesGmp(ASEPTIC_VIAL);
