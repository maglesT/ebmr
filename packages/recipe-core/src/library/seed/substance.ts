/**
 * Ready-made library blocks of the API edition (`substance`; API plan `docs/build-plan/api/plan.md`, A1). A1a ships
 * the pack block only, because the edition's release items read its sections and fields (editions/substance/sql 5000,
 * substance.grel_edition_items) and it is the block that completes an API packaging record
 * (recipe.packaging_completion_block). The rest of catalogue v1 (dispensing, charge, reaction, completion IPC,
 * crystallisation, filtration, drying, yield, label check) arrives with A1b, which also adds the group to SEED_GROUPS.
 *
 * API-PACK: packing the finished API into drums or bags and labelling them (ICH Q7 / EU GMP Part II chapter 9, Revised
 * Schedule M Part XII, packaging and labelling). The release items read:
 *   - `container` entries (one per drum or bag): `netMass` in kg, summed against the quantity posted with the
 *     finished lot (E.POSTED_QUANTITY);
 *   - the `recon` entry: the label reconciliation (E.RECONCILIATION_LABELS; a result outside its limit raises
 *     LIB_LIMIT_BREACH, which blocks release until resolved);
 *   - the `exam` entry: the examination of the packed and labelled containers at the end of packing
 *     (E.PACK_EXAMINATION).
 * Changing a section or field id here needs the same change in that migration's successor.
 *
 * Invented example values (a 50 kg batch in two 25 kg drums).
 */
import type { LimitSpec } from '../../limits/model.ts';
import type { SeedItem } from './types.ts';

const OPERATOR = { meaning: 'PERFORMED' as const, role: 'PRODUCTION_OPERATOR' };
const VERIFIER = { meaning: 'VERIFIED' as const, role: 'PRODUCTION_VERIFIER' };

const reg = (unit: string, low?: string, high?: string): LimitSpec => ({
  unit,
  ranges: [{ tier: 'REGISTERED', ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'SPEC-REF' } }],
});

export const API_PACK: SeedItem = {
  definition: {
    code: 'API-PACK',
    version: 1,
    title: 'Pack the API into drums or bags and label them',
    category: 'PACKAGING',
    edition: 'substance',
    instructions:
      'Fill each drum or bag (inner liners tied, outer container closed and sealed), weigh it, label it with the product, batch, net quantity, retest or expiry date and storage conditions, then reconcile the labels and examine every packed container.',
    sections: [
      {
        id: 'container',
        title: 'Container filled and labelled',
        repeat: { kind: 'COUNT', countSlot: 'containers' },
        fields: [
          { id: 'containerType', label: 'Container', type: 'CHOICE', options: ['Drum', 'Bag'] },
          { id: 'containerNo', label: 'Container number', type: 'TEXT', pattern: '[A-Z0-9-]{1,20}' },
          { id: 'netMass', label: 'Net mass', type: 'NUMBER', unit: 'kg', decimals: 3, limitSlot: 'netMass', critical: true },
          { id: 'sealed', label: 'Liners tied and container sealed', type: 'YES_NO', expected: true },
          { id: 'labelOk', label: 'Label correct (product, batch, net quantity, retest or expiry date, storage)', type: 'YES_NO', expected: true },
        ],
      },
      {
        id: 'recon',
        title: 'Label reconciliation',
        fields: [
          { id: 'issued', label: 'Labels issued', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'issued' },
          { id: 'used', label: 'Labels applied', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'used' },
          { id: 'destroyed', label: 'Batch-coded labels destroyed', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'destroyed' },
          { id: 'returned', label: 'Uncoded labels returned', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'returned' },
          { id: 'labelRecon', label: 'Labels accounted for', type: 'CALC', expression: '(used + destroyed + returned) / issued * 100 [%]', unit: '%', limitSlot: 'labelRecon', critical: true },
        ],
      },
      {
        id: 'exam',
        title: 'Examination of the packed containers',
        fields: [
          { id: 'examined', label: 'Containers examined', type: 'NUMBER', unit: '1', decimals: 0, limitSlot: 'examined' },
          { id: 'allCorrect', label: 'Every container examined is correctly sealed and labelled', type: 'YES_NO', expected: true },
        ],
      },
    ],
    signatures: [OPERATOR, VERIFIER],
  },
  exampleUse: {
    limits: {
      netMass: reg('kg', '24.950', '25.050'), labelRecon: reg('%', '100.0', '100.0'),
      issued: reg('1', '0'), used: reg('1', '0'), destroyed: reg('1', '0'), returned: reg('1', '0'), examined: reg('1', '1'),
    },
    // Two drums: 4 labels issued (one per drum and its inner liner), 4 applied.
    targets: { netMass: '25.000', issued: '4', used: '4', destroyed: '0', returned: '0', examined: '2' },
    counts: { containers: '2' },
  },
};

/** The API edition's blocks shipped so far (A1a: the pack block). */
export const SUBSTANCE_SEEDS: readonly SeedItem[] = [API_PACK];
