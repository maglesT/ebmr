/**
 * Injectables edition I-3 (docs/build-plan/injectables/plan.md, section 6 row I-3): the lyophilised vial
 * (library/injectables-lyo-acceptance.ts) from the library to its released lot. It fills aseptically on the aseptic
 * vial's RABS line, which fills only while its media fill is valid (INV-23 (c), tablets 1915): the line's media fill
 * (library/injectables-aseptic-acceptance.ts MEDIA_FILL) runs first, as a firm runs it before the product, and the vial's
 * GMP set-up sets the line's APS interval, approved by QA. Each half is serial: the sandbox half first; the GMP half takes
 * its product, approved master and IN authorisation from it.
 */
import { test } from '../../fixtures/index.ts';
import { defineInjectablesAcceptance, defineInjectablesGmp } from './injectables-acceptance.ts';
import { MEDIA_FILL } from './injectables-aseptic-acceptance.ts';
import { LYO_VIAL } from './injectables-lyo-acceptance.ts';

test.describe('the media fill of the RABS vial line', () => {
  defineInjectablesAcceptance(MEDIA_FILL);
  defineInjectablesGmp(MEDIA_FILL);
});
test.describe('the lyophilised vial on the line', () => {
  defineInjectablesAcceptance(LYO_VIAL);
  defineInjectablesGmp(LYO_VIAL);
});
