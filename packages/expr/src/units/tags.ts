/**
 * Semantic tags (ADR 0005 decision 2; outline 6.4): what a percentage or count means. Two values
 * with the same UCUM unit can still be incommensurable: % LOD and % yield are both "%", but adding
 * them is meaningless, so it is refused at design time.
 *
 * Rules (checked by lang/checker.ts):
 * - + - comparisons, min/max, conditional branches and aggregates need equal tags. A literal
 *   constant (e.g. 100 [%]) is tag-neutral and takes the tag of the other operand.
 * - x and / with an untagged dimensionless factor keep the tag (2 x LOD is still an LOD);
 *   T / T gives an untagged ratio; any other product or quotient is untagged.
 * - A calculation output declared with a tag accepts an expression with that tag, a neutral literal
 *   or an untagged result (the declaration states the meaning); a different tag is refused.
 * - A library parameter that requires a tag accepts only that tag or a neutral literal.
 * - "% w/v" is not dimensionless: it means grams per 100 mL, so a value declared in % with tag w/v
 *   is read as g/dL (5 % w/v x 100 mL = 5 g).
 */
import type { Unit } from './unit.ts';

export const TAGS = ['none', 'w/w', 'w/v', 'label_claim', 'lod', 'yield', 'rsd', 'count'] as const;
export type Tag = (typeof TAGS)[number];

export const TAG_LABEL: Readonly<Record<Tag, string>> = {
  none: 'an untagged value',
  'w/w': '% w/w',
  'w/v': '% w/v',
  label_claim: '% label claim',
  lod: '% LOD',
  yield: '% yield',
  rsd: '% RSD',
  count: 'a count',
};

export function isTag(x: unknown): x is Tag {
  return typeof x === 'string' && (TAGS as readonly string[]).includes(x);
}

/** Why a tag cannot be attached to a unit, or undefined when it can. */
export function tagUnitProblem(tag: Tag, unit: Unit): string | undefined {
  switch (tag) {
    case 'none':
      return undefined;
    case 'w/v':
      return unit.dimensionKey === 'm-3.g1' && unit.scale === 'LINEAR' ? undefined : '% w/v is a mass per volume (grams per 100 mL); declare it in % or a mass-per-volume unit';
    case 'count':
      return unit.dimensionKey === '' && unit.bareNumber ? undefined : 'a count is a plain number of items ("1" or an annotation such as {tbl})';
    default:
      return unit.dimensionKey === '' && unit.scale === 'LINEAR' ? undefined : `${TAG_LABEL[tag]} is a dimensionless fraction (for example %)`;
  }
}
