/**
 * Rules of the library blocks (decision 0026), written once (ADR 0023). Each names the hand-written copies it will
 * replace; until a family is switched over (ADR 0023 decision 5) those copies stay in force and these definitions are
 * checked against them.
 */
import { and, lit, not, or, path, present, same, type FieldRule, type Node, type Predicate } from './vocabulary.ts';

/**
 * Field visibility (family 6.1). A field is shown when it has no `showWhen`, or when the entry's value of the field
 * `showWhen.field` equals `showWhen.equals`. Hand-written copies: recipe-core library/block-version.ts `shown`, and the
 * guard recipe.library_limits_problem (1862; reads the stored data).
 */
export const FIELD_SHOWN: Predicate = {
  name: 'library_field_shown',
  version: 1,
  doc: 'A field without showWhen is shown; one with showWhen is shown when the named field of the entry holds the given value.',
  inputs: ['field', 'values'],
  body: or(not(present(path('field', 'showWhen'))), same(path('values', path('field', 'showWhen', 'field')), path('field', 'showWhen', 'equals'))),
};

const isType = (t: string): Node => same(path('field', 'type'), lit(t));
const value = path('values', path('field', 'id'));

/**
 * A yes/no answer other than the expected one (family 6.2): a shown YES_NO field with an `expected` answer, answered
 * otherwise, requires LIB_UNEXPECTED_ANSWER, critical when the field says `unexpectedCritical`. Hand-written copy:
 * recipe-core library/block-version.ts (the "Values against limits, expected answers and allowed choices" loop); the
 * database requires it from #261 on.
 */
export const UNEXPECTED_ANSWER: FieldRule = {
  name: 'library_unexpected_answer',
  version: 1,
  doc: 'A shown yes/no field with an expected answer, answered otherwise, requires LIB_UNEXPECTED_ANSWER.',
  applies: and(isType('YES_NO'), present(path('field', 'expected')), FIELD_SHOWN.body, present(value)),
  breached: not(same(value, path('field', 'expected'))),
  raise: [
    { when: same(path('field', 'unexpectedCritical'), lit(true)), then: { type: 'LIB_UNEXPECTED_ANSWER', severity: 'CRITICAL', category: 'OUT_OF_LIMIT', controls: ['PR-29'] } },
    { then: { type: 'LIB_UNEXPECTED_ANSWER', severity: 'ACTION', category: 'OUT_OF_LIMIT', controls: ['PR-29'] } },
  ],
};
