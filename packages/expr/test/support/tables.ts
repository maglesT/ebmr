/** Acceptance tables used by the expr tests. */
import type { AcceptanceTable } from '../../src/library/acceptance-tables.ts';

/** Illustrative Ph. Eur. 2.9.5 band table (tablets spec E.2; values to be verified by QA before GMP use). */
export const PH_EUR_295_BANDS: AcceptanceTable = {
  id: 'ph-eur-2.9.5-band',
  version: 'test-1',
  title: 'Uniformity of mass: permitted deviation by average mass (uncoated and film-coated tablets)',
  source: 'Ph. Eur. 2.9.5 as summarised in tablets spec E.2 (illustrative, unverified)',
  key: { unit: 'mg' },
  result: { unit: '%' },
  rows: [
    { to: { value: '80', inclusive: true }, result: '10' },
    { from: { value: '80', inclusive: false }, to: { value: '250', inclusive: false }, result: '7.5' },
    { from: { value: '250', inclusive: true }, result: '5' },
  ],
};
