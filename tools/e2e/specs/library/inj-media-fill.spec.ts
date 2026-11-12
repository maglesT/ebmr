/**
 * Injectables edition I-2c (docs/build-plan/injectables/plan.md, section 6 row I-2): the media fill (aseptic process
 * simulation) of the RABS vial line (library/injectables-aseptic-acceptance.ts), the sandbox half only: built on screen
 * from the catalogue with the sterile medium in place of the product, its test batch run through incubation and reading
 * to Execution complete. Its GMP run waits for the process-simulation mark (B), which keeps a media fill out of the
 * licence, the finished-lot posting, packaging and shipping.
 */
import { defineInjectablesAcceptance } from './injectables-acceptance.ts';
import { MEDIA_FILL } from './injectables-aseptic-acceptance.ts';

defineInjectablesAcceptance(MEDIA_FILL);
