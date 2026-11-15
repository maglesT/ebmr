/**
 * Injectables edition I-2b (docs/build-plan/injectables/plan.md, section 6 row I-2): the aseptically filled vial
 * (library/injectables-aseptic-acceptance.ts) from the library to its released lot, and I-2c, the media fill of the same
 * RABS line. INV-23 (c) (tablets 1915): the line fills the aseptic batch only while its media fill is valid, so the media
 * fill runs first, as a firm runs it before the product (each half serial: the sandbox half, then the GMP half, which
 * takes its product, approved master and IN authorisation from it); the vial's GMP set-up then sets the line's APS
 * interval, approved by QA.
 */
import { test } from '../../fixtures/index.ts';
import { defineInjectablesAcceptance, defineInjectablesGmp } from './injectables-acceptance.ts';
import { ASEPTIC_VIAL, MEDIA_FILL } from './injectables-aseptic-acceptance.ts';

test.describe('the media fill of the RABS vial line', () => {
  defineInjectablesAcceptance(MEDIA_FILL);
  defineInjectablesGmp(MEDIA_FILL);
});
test.describe('the aseptic vial on the line', () => {
  defineInjectablesAcceptance(ASEPTIC_VIAL);
  defineInjectablesGmp(ASEPTIC_VIAL);
});
