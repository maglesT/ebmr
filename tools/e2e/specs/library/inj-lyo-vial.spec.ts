/**
 * Injectables edition I-3 (docs/build-plan/injectables/plan.md, section 6 row I-3): the lyophilised vial
 * (library/injectables-lyo-acceptance.ts) from the library to its released lot. The sandbox half runs first in this
 * serial file; the GMP half takes its product, approved master and IN authorisation from it.
 */
import { defineInjectablesAcceptance, defineInjectablesGmp } from './injectables-acceptance.ts';
import { LYO_VIAL } from './injectables-lyo-acceptance.ts';

defineInjectablesAcceptance(LYO_VIAL);
defineInjectablesGmp(LYO_VIAL);
