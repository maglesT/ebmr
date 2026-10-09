/**
 * Unit and tag rules shared by the static checker and the evaluator, so both apply exactly the
 * same semantics (see units/tags.ts for the tag rules in plain words).
 */
import { TAG_LABEL, type Tag } from '../units/tags.ts';
import { describeDimension, type Unit } from '../units/unit.ts';

/** The common tag of two operands that must agree; undefined when they conflict. */
export function unifyTags(a: Tag | null, b: Tag | null): Tag | null | undefined {
  if (a === null) return b;
  if (b === null) return a;
  return a === b ? a : undefined;
}

function tagged(t: Tag | null): t is Tag {
  return t !== null && t !== 'none';
}

function untaggedScalar(unit: Unit, tag: Tag | null): boolean {
  return unit.dimensionKey === '' && unit.scale === 'LINEAR' && !tagged(tag);
}

/** Tag of a product or quotient. */
export function productTag(aUnit: Unit, aTag: Tag | null, bUnit: Unit, bTag: Tag | null, op: '*' | '/'): Tag | null {
  if (aTag === null && bTag === null) return null;
  if (tagged(aTag) && !tagged(bTag) && untaggedScalar(bUnit, bTag)) return aTag;
  if (op === '*' && tagged(bTag) && !tagged(aTag) && untaggedScalar(aUnit, aTag)) return bTag;
  return 'none';
}

/**
 * A plain number next to a percentage-like unit (100 - W where W is in %) is almost always a
 * mistake: in UCUM 100 - 4.6 % is 99.954. Such additions and comparisons are refused.
 */
export function barePercentConflict(a: Unit, b: Unit): boolean {
  const pct = (u: Unit): boolean => u.dimensionKey === '' && !u.bareNumber && !(u.factor.num === u.factor.den);
  return (a.bareNumber && pct(b)) || (b.bareNumber && pct(a));
}

export function describeTag(tag: Tag | null): string {
  return tag === null ? 'a constant' : TAG_LABEL[tag];
}

/** "% LOD", "mass (kg)", "a plain number". */
export function describeQuantity(unit: Unit, tag: Tag | null): string {
  if (tag !== null && tag !== 'none') return TAG_LABEL[tag];
  return unit.bareNumber ? 'a plain number' : `${describeDimension(unit)} (${unit.code})`;
}
