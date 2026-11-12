/**
 * Owner acceptance (session 12): a material on two BOM lines of one weighing step (a bilayer tablet's binder in each
 * layer) is weighed for each line on its own (D-2, recipe-core 1877). The weighing's "Material" choices name the line for
 * such a material, so the operator records each container against the right layer's line; a material on one line reads
 * as before.
 */
import { describe, expect, it } from 'vitest';
import type { flow } from '@ebmr/recipe-core';
import { bomLineOptions } from '../../src/features/execution/views.ts';

const mbr = {
  bom: [
    { id: 'BOM-L1-MET', material: 'MET', role: 'ACTIVE', quantity: { value: '25', unit: 'kg' } },
    { id: 'BOM-L1-PVP', material: 'PVP', role: 'EXCIPIENT', quantity: { value: '1', unit: 'kg' } },
    { id: 'BOM-L2-PVP', material: 'PVP', role: 'EXCIPIENT', quantity: { value: '0.3', unit: 'kg' } },
  ],
  references: [
    { id: 'MET', kind: 'MATERIAL', code: 'MAT-MET', version: '1', hash: 'a', title: 'Metformin hydrochloride' },
    { id: 'PVP', kind: 'MATERIAL', code: 'MAT-PVP', version: '1', hash: 'b', title: 'Povidone K30' },
  ],
} as unknown as Pick<flow.MbrContent, 'bom' | 'references'>;

describe('the weighing\'s material choices when a material is on two lines', () => {
  it('[PR-18][DI-33] each line of a material on two lines is a choice of its own that names the line; a material on one line reads as before', () => {
    expect(bomLineOptions(mbr, ['BOM-L1-MET', 'BOM-L1-PVP', 'BOM-L2-PVP'])).toEqual([
      { value: 'BOM-L1-MET', label: 'Metformin hydrochloride (MAT-MET)' },
      { value: 'BOM-L1-PVP', label: 'Line BOM-L1-PVP: Povidone K30 (MAT-PVP)' },
      { value: 'BOM-L2-PVP', label: 'Line BOM-L2-PVP: Povidone K30 (MAT-PVP)' },
    ]);
    // A step that consumes only one of the two lines has nothing to tell apart.
    expect(bomLineOptions(mbr, ['BOM-L2-PVP'])).toEqual([{ value: 'BOM-L2-PVP', label: 'Povidone K30 (MAT-PVP)' }]);
  });
});
