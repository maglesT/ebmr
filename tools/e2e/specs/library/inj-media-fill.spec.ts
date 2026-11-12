/**
 * Injectables edition I-2c and I-2d (docs/build-plan/injectables/plan.md, section 6 row I-2): the media fill (aseptic
 * process simulation) of the RABS vial line (library/injectables-aseptic-acceptance.ts). The sandbox half builds it on
 * screen from the catalogue with the sterile medium in place of the product and marks the master a process simulation
 * (recipe-core 1896); its test batch runs through incubation and reading to Execution complete. The GMP half issues the
 * batch with no product licence, runs it on the kiosks and ends at QA's review of the record: nothing of it is packed,
 * posted as a lot or shipped.
 */
import { defineInjectablesAcceptance, defineInjectablesGmp } from './injectables-acceptance.ts';
import { MEDIA_FILL } from './injectables-aseptic-acceptance.ts';

defineInjectablesAcceptance(MEDIA_FILL);
defineInjectablesGmp(MEDIA_FILL);
