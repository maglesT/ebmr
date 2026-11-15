/**
 * How a decimal reaches an order comparison (`lt`, `lte`, `gt`, `gte`). GMP decimals must reach the rules as strings: a
 * JSON number has already been rounded to a double by JSON.parse before the interpreter reads it through
 * `Dec.parse(String(n))` (the lead's advisory on #267). Families 6.1 and 6.2 compare only with `same`, on yes/no and
 * choice values, so no definition orders a decimal yet and the choice is left open:
 * - UNSETTLED: no catalogued definition may use an order comparison (test/policy.test.ts fails otherwise);
 * - REFUSE: both backends refuse a JSON number in a decimal position;
 * - FLAG: a rule that orders a value must also require that it is a decimal string (for example an `isDecimal` node).
 * It is decided at family 6.3 (limits), the first that orders a decimal.
 */
export type DecimalInputPolicy = 'UNSETTLED' | 'REFUSE' | 'FLAG';

export const DECIMAL_INPUT_POLICY: DecimalInputPolicy = 'UNSETTLED';
