/**
 * The library rules as written once (ADR 0023). Until their family is switched over, the hand-written copies stay in
 * force; these tests pin the definitions' meaning, case by case, to the engine's (recipe-core library/block-version.ts).
 */
import { describe, expect, it } from 'vitest';
import { fieldRuleRaise, holds } from '../src/interpret.ts';
import { lit } from '../src/vocabulary.ts';
import { FIELD_SHOWN, UNEXPECTED_ANSWER } from '../src/library.ts';

describe('library rules', () => {
  it('[meta] visibility: no showWhen is shown; with one, shown only when the named value equals the given one (an unanswered controlling field hides it)', () => {
    const f = { id: 'reason', type: 'TEXT', showWhen: { field: 'ok', equals: false } };
    expect(holds(FIELD_SHOWN.body, { field: { id: 'x', type: 'TEXT' }, values: {} })).toBe(true);
    expect(holds(FIELD_SHOWN.body, { field: f, values: { ok: false } })).toBe(true);
    expect(holds(FIELD_SHOWN.body, { field: f, values: { ok: true } })).toBe(false);
    expect(holds(FIELD_SHOWN.body, { field: f, values: {} })).toBe(false);
    // The engine compares with ===: a string "false" is not the boolean false.
    expect(holds(FIELD_SHOWN.body, { field: f, values: { ok: 'false' } })).toBe(false);
  });

  it('[meta] expected answer: a shown yes/no field answered against its expected answer requires LIB_UNEXPECTED_ANSWER, critical when the field says so', () => {
    const field = { id: 'clean', type: 'YES_NO', expected: true };
    expect(fieldRuleRaise(UNEXPECTED_ANSWER, { field, values: { clean: true } })).toBeUndefined();
    expect(fieldRuleRaise(UNEXPECTED_ANSWER, { field, values: { clean: false } })).toEqual({ type: 'LIB_UNEXPECTED_ANSWER', severity: 'ACTION', category: 'OUT_OF_LIMIT', controls: ['PR-29'] });
    expect(fieldRuleRaise(UNEXPECTED_ANSWER, { field: { ...field, unexpectedCritical: true }, values: { clean: false } })?.severity).toBe('CRITICAL');
    // Unanswered, no expected answer, another type, or hidden: nothing required.
    expect(fieldRuleRaise(UNEXPECTED_ANSWER, { field, values: {} })).toBeUndefined();
    expect(fieldRuleRaise(UNEXPECTED_ANSWER, { field: { id: 'clean', type: 'YES_NO' }, values: { clean: false } })).toBeUndefined();
    expect(fieldRuleRaise(UNEXPECTED_ANSWER, { field: { ...field, type: 'CHOICE' }, values: { clean: false } })).toBeUndefined();
    const hidden = { ...field, showWhen: { field: 'used', equals: true } };
    expect(fieldRuleRaise(UNEXPECTED_ANSWER, { field: hidden, values: { used: false, clean: false } })).toBeUndefined();
    expect(fieldRuleRaise(UNEXPECTED_ANSWER, { field: hidden, values: { used: true, clean: false } })?.type).toBe('LIB_UNEXPECTED_ANSWER');
  });

  it('[meta] a field rule requires nothing when no entry of its raise list holds (every entry has a `when`)', () => {
    const first = UNEXPECTED_ANSWER.raise[0];
    if (first === undefined) throw new Error('UNEXPECTED_ANSWER has no raise entry');
    const onlyWhen = { ...UNEXPECTED_ANSWER, raise: [{ when: lit(false), then: first.then }] };
    expect(fieldRuleRaise(onlyWhen, { field: { id: 'clean', type: 'YES_NO', expected: true }, values: { clean: false } })).toBeUndefined();
    expect(fieldRuleRaise({ ...onlyWhen, raise: [{ when: lit(true), then: first.then }] }, { field: { id: 'clean', type: 'YES_NO', expected: true }, values: { clean: false } })).toEqual(first.then);
  });
});
