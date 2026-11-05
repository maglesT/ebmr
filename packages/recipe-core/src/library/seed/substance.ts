/**
 * Ready-made library blocks of the API edition (`substance`; API plan `docs/build-plan/api/plan.md`, A1). A1a ships
 * the pack block only: it is the block that completes an API packaging record (recipe.packaging_completion_block,
 * editions/substance/sql 5000). The rest of catalogue v1 arrives with A1b, which also adds the group to SEED_GROUPS.
 *
 * API-PACK: the finished API into drums or bags, one container entry each (a container registered, its net mass, its
 * closure and its label checked). The labels themselves are issued and reconciled by the existing printed-materials
 * block (G-21) of the packaging master, not here.
 *
 * Invented example values (a 50 kg batch in two 25 kg drums).
 */
import type { LimitSpec } from '../../limits/model.ts';
import type { SeedItem } from './types.ts';

const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const VERIFIER = { meaning: 'VERIFIED' as const, role: 'PRODUCTION_VERIFIER' };

const reg = (unit: string, low: string, high: string): LimitSpec => ({
  unit,
  ranges: [{ tier: 'REGISTERED', low: { value: low, inclusive: true }, high: { value: high, inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'SPEC-REF' } }],
});

export const API_PACK: SeedItem = {
  definition: {
    code: 'API-PACK',
    version: 1,
    title: 'Pack the API into drums or bags',
    category: 'PACKAGING',
    edition: 'substance',
    instructions: 'Fill each drum or bag (inner liners tied, outer container closed and sealed), weigh it and label it with the product, batch, net quantity, retest or expiry date and storage conditions.',
    sections: [
      {
        id: 'container',
        title: 'Container filled and labelled',
        repeat: { kind: 'COUNT', countSlot: 'containers' },
        fields: [
          { id: 'container', label: 'Drum or bag', type: 'CONTAINER', action: 'REGISTER' },
          { id: 'netMass', label: 'Net mass', type: 'NUMBER', unit: 'kg', decimals: 3, limitSlot: 'netMass', critical: true },
          { id: 'sealed', label: 'Liners tied and container sealed', type: 'YES_NO', expected: true },
          { id: 'labelOk', label: 'Label correct (product, batch, net quantity, retest or expiry date, storage)', type: 'YES_NO', expected: true },
        ],
      },
    ],
    signatures: [OPERATOR, VERIFIER],
  },
  exampleUse: {
    limits: { netMass: reg('kg', '24.950', '25.050') },
    targets: { netMass: '25.000' },
    counts: { containers: '2' },
  },
};

/** The API edition's blocks shipped so far (A1a: the pack block). */
export const SUBSTANCE_SEEDS: readonly SeedItem[] = [API_PACK];
