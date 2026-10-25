/**
 * The P3 rabeprazole batch's floor plan and reservations (Phase 7 slices 7r and 7s): shared by the own-p3 group, which
 * builds the product on screen (own-product-p3.spec.ts), and the p3-demo group, which runs the presenter's batch from the
 * demo set-up's seeded product (p3-demo.spec.ts).
 */
import type { ProcessPlan } from './own-product-floor.ts';

/** The floor's quantities: 125 mg cores; the seal coat 2.0 %, the enteric coat 9.0 %, the top coat 3.0 %, each on its own start. */
export function rabeprazolePlan(lots: (id: string) => string, api: string, toolingSet: RegExp): ProcessPlan {
  const layer = (slug: string, recipe: string, suspensionKg: string, usedKg: string, coreTotal: string, coatedTotal: string): ProcessPlan['coating']['layers'][number] =>
    slug === ''
      ? { susp: 'p-susp', cores: 'p-cores', coat: 'p-coat', loop: 'L-COAT', recipe, suspensionKg, usedKg, coreTotal, coatedTotal }
      : { susp: `p-susp-${slug}`, cores: `p-cores-${slug}`, coat: `p-coat-${slug}`, loop: `L-COAT-${slug.toUpperCase()}`, recipe, suspensionKg, usedKg, coreTotal, coatedTotal };
  return {
    // TB-01 on the declared form, the lot's assay 99.40 % and water 0.60 %: 3 kg over the assay; the cellulose gives way.
    api: { material: api, lot: lots('api'), kg: '3.037' },
    compensating: { material: 'MAT-MCC-101', lot: lots('mcc'), kg: '4.464' },
    others: [
      ['MAT-LAC-MH', '9.000', lots('lac')], ['MAT-PVP-K30', '0.900', lots('pvp')], ['MAT-IPA', '0.900', lots('ipa')], ['MAT-CCS', '0.900', lots('ccs')],
      ['MAT-SIO2', '0.150', lots('sio')], ['MAT-MGST', '0.300', lots('mgs')], ['MAT-ECS-01', '2.800', lots('fcs')],
    ],
    binderKg: '1.800',
    granules: { in: '17.300', out: '17.250', oversize: '0.050' },
    blendLubricantKg: '0.300',
    blendNet: '18.500',
    toolingSet,
    sweep: ['124.8', '125.4', '125.9', '124.6'],
    sideNet: '9.200',
    sideGroup: { L: '2501.0', R: '2499.0' },
    coresGroup: '2502.0',
    physical: [{ thickness: '5.10', hardness: '95' }, { thickness: '5.12', hardness: '98' }, { thickness: '5.08', hardness: '92' }],
    friability: { tablets: '52', initial: '6.510', final: '6.495' },
    strokes: '148500',
    compYield: { good: '18.400', residue: '0.100', rejects: '0.050' },
    coating: {
      panKg: '18.400',
      layers: [
        layer('seal', 'RCP-RTW-COAT', '2.500', '2.300', '2.5000', '2.5500'),
        layer('', 'RCP-RTW-COAT', '9.000', '8.500', '2.5500', '2.7795'),
        layer('top', 'RCP-RTW-COAT', '3.500', '3.200', '2.7795', '2.8629'),
      ],
      coatedNet: '21.070',
      disintegration: 'GASTRO_RESISTANT',
    },
    inspection: {
      inspected: { count: '147100', mass: '21.070' },
      accepted: { count: '146300', mass: '20.955' },
      defects: [['CHIPPED', '500'], ['COLOUR-SPOT', '300']],
      destroyed: { count: '300', mass: '0.043' },
      residue: { count: '500', mass: '0.072' },
      bulkUnits: '1000',
    },
  };
}

/** What stores reserve of each lot: the active with room for its potency adjustment (3.037 kg), the cellulose to its range's top. */
export const RESERVE: Record<string, string> = { api: '3.100', mcc: '5.000', lac: '9.000', pvp: '0.900', ipa: '0.900', ccs: '0.900', sio: '0.150', mgs: '0.300', fcs: '2.800' };
