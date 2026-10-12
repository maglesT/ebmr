/**
 * The G-21 reconciliation count (SQL mutation group "packaging-g21-rules", recipe-core 0581, recipe.g21_counted): the
 * quantity of a coded printed material that the reconciliations of a batch count as one part (issued, used, destroyed,
 * returned), over the G-21 steps that code it, and with a destruction step named, over those that name it. The
 * function is immutable and is called directly with an MBR content and an engine state as data.
 *
 * Controls: PR-42, PR-37, INV-25.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

const item = (id: string, material: string, unit = 'pcs', coded = true) => ({ id, material, unit, coded });
const g21 = (id: string, items: unknown[], destructionStep?: string) => ({
  kind: 'phase', id, name: id, block: { type: 'G-21', version: '1' }, config: { items, ...(destructionStep ? { destructionStep } : {}) },
});
const CONTENT = {
  procedure: {
    kind: 'sequence', id: 'root', children: [
      g21('P1', [item('carton', 'MAT-CARTON'), item('leaflet', 'MAT-LEAF', 'pcs', false)], 'P-DESTROY'),
      g21('P2', [item('carton', 'MAT-CARTON')]),
      { kind: 'phase', id: 'P3', name: 'P3', block: { type: 'G-20', version: '1' }, config: { items: [item('carton', 'MAT-CARTON')] } },
    ],
  },
};
const rec = (stepKey: string, itemId: string, used: string, kind = 'RECONCILIATION') => ({ stepKey, kind, data: { item: itemId, used } });
const STATE = {
  steps: { K1: { step: 'P1' }, K2: { step: 'P2' }, K3: { step: 'P3' } },
  entries: {
    'EN-1': rec('K1', 'carton', '100'),
    'EN-2': rec('K2', 'carton', '40'),
    'EN-3': rec('K1', 'leaflet', '7'),
    'EN-4': rec('K3', 'carton', '1000'),
    'EN-5': rec('K1', 'carton', '5000', 'PRINT_COUNT'),
    'EN-6': rec('K1', 'carton', 'many'),
  },
};

const counted = async (material: string, unit: string, dest: string | null): Promise<string> =>
  (await db.admin.query<{ n: string }>('select recipe.g21_counted($1::jsonb, $2::jsonb, $3, $4, $5, $6)::text as n', [
    JSON.stringify(CONTENT), JSON.stringify(STATE), material, unit, 'used', dest,
  ])).rows[0]?.n ?? '';

describe('recipe.g21_counted', () => {
  it('[PR-42][INV-25] counts the reconciliations of G-21 steps that code the material in that unit, nothing else', async () => {
    // EN-1 and EN-2 only: not the uncoded leaflet, not a G-20 step, not another kind of entry, not a value that is no decimal.
    expect(await counted('MAT-CARTON', 'pcs', null)).toBe('140');
    expect(await counted('MAT-CARTON', 'kg', null)).toBe('0');
    expect(await counted('MAT-LEAF', 'pcs', null)).toBe('0');
    expect(await counted('MAT-OTHER', 'pcs', null)).toBe('0');
  });

  it('[PR-37] with a destruction step named, only the G-21 steps that name it', async () => {
    expect(await counted('MAT-CARTON', 'pcs', 'P-DESTROY')).toBe('100');
    expect(await counted('MAT-CARTON', 'pcs', 'P-OTHER')).toBe('0');
  });
});
