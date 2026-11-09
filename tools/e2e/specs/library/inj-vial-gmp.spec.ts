/**
 * Injectables edition I-1c2 P4a (docs/build-plan/injectables/resume.md): the vial from the library to its GMP processing
 * batch released for packing (H-PACK). The sandbox half (library/injectables-acceptance.ts, I-1c1) runs first in this
 * serial file: the GMP half takes its product, approved master and IN authorisation from it.
 */
import { defineInjectablesAcceptance, defineInjectablesGmp } from './injectables-acceptance.ts';

defineInjectablesAcceptance('vial');
defineInjectablesGmp('vial');
