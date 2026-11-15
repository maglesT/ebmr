/**
 * The TypeScript backend's meaning of each node (ADR 0023): ABSENT is its own value, JSON null is a value, decimals are
 * exact, and a truth value is true only when it is JSON true. The conformance suite (conformance.test.ts) runs such cases
 * through PostgreSQL 16.
 */
import { describe, expect, it } from 'vitest';
import { ABSENT, evaluate, holds, type Inputs } from '../src/interpret.ts';
import { and, lit, not, or, path, present, same, type Node } from '../src/vocabulary.ts';

const ord = (op: 'lt' | 'lte' | 'gt' | 'gte', a: Node, b: Node): Node => ({ op, a, b });
const inList = (value: Node, list: Node): Node => ({ op: 'in', value, list });
const I: Inputs = { v: { a: '1.0', b: 1, n: null, t: true, f: false, s: 'x', arr: ['p', 'q'], obj: { k: '2.50' } }, key: 'a' };

describe('the vocabulary, interpreted', () => {
  it('[meta] a path reads JSON values; a missing key, a step into a scalar or a missing input is ABSENT, and JSON null is a value', () => {
    expect(evaluate(path('v', 'a'), I)).toBe('1.0');
    expect(evaluate(path('v', 'obj', 'k'), I)).toBe('2.50');
    expect(evaluate(path('v', 'n'), I)).toBeNull();
    expect(evaluate(path('v', 'missing'), I)).toBe(ABSENT);
    expect(evaluate(path('v', 's', 'deeper'), I)).toBe(ABSENT);
    expect(evaluate(path('nope', 'a'), I)).toBe(ABSENT);
    // An input given as undefined is not there either (an optional argument left out).
    expect(evaluate(path('u'), { ...I, u: undefined })).toBe(ABSENT);
    expect(evaluate(path('u', 'a'), { ...I, u: undefined })).toBe(ABSENT);
    // A root is an own key of the inputs: an inherited name is no input.
    expect(evaluate(path('constructor'), I)).toBe(ABSENT);
    expect(evaluate(path('toString', 'a'), I)).toBe(ABSENT);
    // A computed step: the key read from another input.
    expect(evaluate(path('v', path('key')), I)).toBe('1.0');
    expect(evaluate(path('v', path('nope')), I)).toBe(ABSENT);
    expect(holds(present(path('v', 'n')), I)).toBe(true);
    expect(holds(present(path('v', 'missing')), I)).toBe(false);
  });

  it('[meta] same is "is not distinct from": ABSENT equals only ABSENT; null, booleans and strings exactly; numbers and objects as jsonb compares them', () => {
    expect(holds(same(path('v', 'missing'), path('v', 'other')), I)).toBe(true);
    expect(holds(same(path('v', 'missing'), lit(null)), I)).toBe(false);
    expect(holds(same(path('v', 'n'), lit(null)), I)).toBe(true);
    expect(holds(same(path('v', 't'), lit(true)), I)).toBe(true);
    expect(holds(same(path('v', 't'), lit('true')), I)).toBe(false);
    // A decimal string is text to `same` (jsonb '"1.0"' is not '"1"'); exact order is the job of lt/lte/gt/gte.
    expect(holds(same(path('v', 'a'), lit('1')), I)).toBe(false);
    expect(holds(same({ op: 'lit', value: '2.50' }, path('v', 'obj', 'k')), I)).toBe(true);
  });

  it('[meta] order is exact decimal order on strings and numbers, and false (never an error) when a side is ABSENT or not a decimal', () => {
    expect(holds(ord('gte', path('v', 'a'), path('v', 'b')), I)).toBe(true); // '1.0' >= 1
    expect(holds(ord('gt', path('v', 'a'), path('v', 'b')), I)).toBe(false);
    expect(holds(ord('lt', lit('0.1000000000000000000000000000000001'), lit('0.1000000000000000000000000000000002')), I)).toBe(true);
    expect(holds(ord('lt', path('v', 'missing'), lit('1')), I)).toBe(false);
    expect(holds(ord('gte', path('v', 'missing'), lit('1')), I)).toBe(false);
    expect(holds(ord('lt', path('v', 's'), lit('1')), I)).toBe(false);
  });

  it('[meta] logic treats only JSON true as true; membership is false for ABSENT or a non-array', () => {
    expect(holds(and(lit(true), path('v', 't')), I)).toBe(true);
    expect(holds(and(lit(true), path('v', 's')), I)).toBe(false);
    expect(holds(or(path('v', 'missing'), path('v', 'f')), I)).toBe(false);
    expect(holds(not(path('v', 'missing')), I)).toBe(true);
    expect(holds(and(), I)).toBe(true);
    expect(holds(or(), I)).toBe(false);
    expect(holds(inList(lit('q'), path('v', 'arr')), I)).toBe(true);
    expect(holds(inList(lit('z'), path('v', 'arr')), I)).toBe(false);
    expect(holds(inList(path('v', 'missing'), path('v', 'arr')), I)).toBe(false);
    expect(holds(inList(lit('q'), path('v', 's')), I)).toBe(false);
  });
});
