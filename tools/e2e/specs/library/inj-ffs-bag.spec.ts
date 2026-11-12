/**
 * Injectables edition I-4 (docs/build-plan/injectables/plan.md, section 6): form-fill-seal bags (large-volume infusion), terminally sterilised by moist heat, from the library to its approved,
 * IN-authorised master after its sandbox test batch (library/injectables-routes-acceptance.ts).
 */
import { defineInjectablesAcceptance } from './injectables-acceptance.ts';
import { routeProduct } from './injectables-routes-acceptance.ts';

defineInjectablesAcceptance(routeProduct('ffs-bag'));
