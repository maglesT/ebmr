/**
 * How the database reads the unit of a weighed quantity as a mass (recipe-core sql/0323 recipe.mass_unit_class; Phase 2
 * exit follow-up COMPOUND-UNIT; INV-25, PR-19, DI-30).
 *
 * Since 0323 the database decides from the MBR which quantity of its step a weighing counts into, as the blocks do
 * (blocks/generic common.ts massItems): a G-07 container into one of the mass quantities the step records, a G-22 output
 * container into the first one. It reads a unit as a mass when it is gram with a metric prefix and the exponent 1, an
 * annotation allowed (MASS); any other single unit, or a unit that is no text or longer than 120 characters, as no mass
 * (OTHER). A compound unit (written with ".", "/" or parentheses) or one with two annotations it does not read (UNKNOWN),
 * and where that matters it fails closed: it refuses every output container of a G-22 step that records such a quantity
 * before its first mass quantity, and every container a G-07 step weighs into a mass written so, although the
 * expression language, and so the engine, reads "kg/1" as a mass and "g/mL" as none. The validator warns the author
 * before such an MBR can be approved (DATA-WEIGHED-UNITS); test/execution/weighed-units-sql.test.ts compares this
 * mirror with the database's own answer.
 */

export type DatabaseMassClass = 'MASS' | 'OTHER' | 'UNKNOWN';

/** recipe.mass_unit_class: gram with a metric prefix, the exponent 1, at most one annotation. */
const MASS_UNIT = /^(Y|Z|E|P|T|G|M|k|h|da|d|c|m|u|n|p|f|a|z|y)?g(\+?0*1)?(\{[!-z|~]*\})?$/u;
/** recipe.mass_unit_class: one unit without ".", "/" or parentheses, at most one annotation; or an annotation alone. */
const SINGLE_UNIT = /^([^./(){}]+(\{[^{}]*\})?|\{[^{}]*\})$/u;

/** How the database (0323) reads `unit`, the unit member of a parameter as stored in the MBR, as a mass. */
export function databaseMassClass(unit: unknown): DatabaseMassClass {
  if (typeof unit !== 'string') return 'OTHER';
  const length = [...unit].length;
  if (length < 1 || length > 120) return 'OTHER';
  if (MASS_UNIT.test(unit)) return 'MASS';
  if (SINGLE_UNIT.test(unit)) return 'OTHER';
  return 'UNKNOWN';
}
