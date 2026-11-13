/**
 * Injectables edition I-4 (docs/build-plan/injectables/plan.md, section 6): an oil-in-water emulsion in vials, terminally sterilised by moist heat, with high-pressure homogenisation, from the library to its approved,
 * IN-authorised master after its sandbox test batch (library/injectables-routes-acceptance.ts).
 */
import { defineInjectablesAcceptance } from './injectables-acceptance.ts';
import { routeProduct } from './injectables-routes-acceptance.ts';

defineInjectablesAcceptance(routeProduct('emulsion-vial'));
