/**
 * Evaluation (brief A1 item 4; ADR 0005 decision 5): explicit, typed errors with the input path;
 * never a silent zero or NaN; inputs as decimal strings with units and sources; conversions
 * recorded; derived inputs only from computed results (INV-25).
 */
import { describe, expect, it } from 'vitest';
import { evaluate, tryEvaluate } from '../src/evidence/record.ts';
import { compile, type CompiledExpression } from '../src/lang/compile.ts';
import { ExprEvaluationError } from '../src/lang/errors.ts';
import type { InputValues } from '../src/lang/evaluator.ts';
import type { InputDeclarations, OutputDeclaration } from '../src/lang/types.ts';

function program(source: string, inputs: InputDeclarations, output?: OutputDeclaration, name?: string): CompiledExpression {
  const r = compile(source, { inputs, ...(output === undefined ? {} : { output }), ...(name === undefined ? {} : { name }) });
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('; '));
  return r.program;
}

function fails(p: CompiledExpression, values: InputValues): ExprEvaluationError {
  const r = tryEvaluate(p, values);
  if (r.ok) throw new Error(`expected an error, got ${r.record.output.value}`);
  return r.error;
}

const q = (value: string, unit?: string): InputValues[string] => ({ value, ...(unit === undefined ? {} : { unit }), source: 'test entry' });

describe('explicit errors', () => {
  const p = program('a / b', { a: { unit: 'kg' }, b: { unit: '1' } }, { unit: 'kg' });

  it('[DI-33] a missing input raises MISSING_INPUT naming the input, never a silent zero', () => {
    const e = fails(p, { a: q('1') });
    expect(e.code).toBe('MISSING_INPUT');
    expect(e.path).toBe('b');
    expect(e.message).toMatch(/"b" is missing.*\(MISSING_INPUT, DI-33\)$/);
    expect(fails(p, { a: q('1'), b: undefined }).code).toBe('MISSING_INPUT');
    expect(() => evaluate(p, {})).toThrow(ExprEvaluationError);
  });

  it('[DI-33] a division by zero raises DIVISION_BY_ZERO naming the divisor input', () => {
    const e = fails(p, { a: q('1'), b: q('0') });
    expect(e).toMatchObject({ code: 'DIVISION_BY_ZERO', path: 'b', paths: ['b'] });
    const p2 = program('a / (b - c)', { a: { unit: '1' }, b: { unit: '1' }, c: { unit: '1' } });
    expect(fails(p2, { a: q('1'), b: q('2'), c: q('2') }).paths).toEqual(['b', 'c']);
  });

  it('[DI-33] out-of-domain values raise DOMAIN_ERROR with the input path (sd of fewer than 2 values, negative LOD)', () => {
    const sd = program('sd(w)', { w: { kind: 'series', unit: 'mg', maxLength: 20 } });
    const e = fails(sd, { w: { values: ['250.1'], source: 'balance' } });
    expect(e).toMatchObject({ code: 'DOMAIN_ERROR', path: 'w', fn: 'sd' });
    expect(e.message).toMatch(/at least 2 values; the series has 1/);
    const lod = program('assay_as_is_dried(a, l)', { a: { unit: '%', tag: 'w/w' }, l: { unit: '%', tag: 'lod' } });
    expect(fails(lod, { a: q('99.5'), l: q('-0.1') })).toMatchObject({ code: 'DOMAIN_ERROR', path: 'l' });
    expect(fails(lod, { a: q('99.5'), l: q('100') })).toMatchObject({ code: 'DOMAIN_ERROR', path: 'l' });
    const mean = program('mean(w)', { w: { kind: 'series', unit: 'mg', maxLength: 20 } });
    expect(fails(mean, { w: { values: [], source: 'balance' } })).toMatchObject({ code: 'EMPTY_SERIES', path: 'w' });
  });

  it('[DI-33] a JavaScript number is refused at the boundary: GMP values are decimal strings', () => {
    const e = fails(p, { a: { value: 0.1 as unknown as string, source: 'x' }, b: q('1') });
    expect(e).toMatchObject({ code: 'INVALID_INPUT', path: 'a' });
    expect(e.message).toMatch(/never a JavaScript number/);
    expect(fails(p, { a: q('1.2.3'), b: q('1') })).toMatchObject({ code: 'INVALID_INPUT', path: 'a' });
  });

  it('refuses malformed input values explicitly', () => {
    expect(fails(p, { a: q('1', 'mL'), b: q('1') })).toMatchObject({ code: 'INVALID_INPUT', path: 'a' });
    expect(fails(p, { a: { value: '1', source: '' }, b: q('1') })).toMatchObject({ code: 'INVALID_INPUT', path: 'a' });
    expect(fails(p, { a: q('1'), b: q('1'), c: q('1') })).toMatchObject({ code: 'INVALID_INPUT', path: 'c' });
    const tagged = program('l * 1', { l: { unit: '%', tag: 'lod' } });
    expect(fails(tagged, { l: { value: '1', tag: 'yield', source: 'x' } })).toMatchObject({ code: 'INVALID_INPUT', path: 'l' });
    const s = program('sum(w)', { w: { kind: 'series', unit: 'mg', maxLength: 3 } });
    expect(fails(s, { w: { values: ['1', '2', '3', '4'], source: 'x' } })).toMatchObject({ code: 'SERIES_TOO_LONG', path: 'w' });
    const cat = program('c == "FILM"', { c: { kind: 'category', values: ['FILM', 'NONE'] } }, { kind: 'boolean' });
    expect(fails(cat, { c: { category: 'SUGAR', source: 'x' } })).toMatchObject({ code: 'INVALID_INPUT', path: 'c' });
    const inst = program('duration(a, b)', { a: { kind: 'instant' }, b: { kind: 'instant' } });
    expect(fails(inst, { a: { instant: '2026-02-30T00:00:00Z', source: 'x' }, b: { instant: '2026-03-01T00:00:00Z', source: 'x' } })).toMatchObject({ code: 'INVALID_INPUT', path: 'a' });
    expect(fails(inst, { a: { instant: '2026-03-01T00:00:00', source: 'x' }, b: { instant: '2026-03-01T00:00:00Z', source: 'x' } })).toMatchObject({ code: 'INVALID_INPUT', path: 'a' });
  });

  it('an input read only in the branch not taken is not needed', () => {
    const c = program('ok ? a : b', { ok: { kind: 'boolean' }, a: { unit: 'kg' }, b: { unit: 'kg' } });
    expect(evaluate(c, { ok: { boolean: true, source: 'x' }, a: q('2') }).output.value).toBe('2');
    expect(fails(c, { ok: { boolean: false, source: 'x' }, a: q('2') })).toMatchObject({ code: 'MISSING_INPUT', path: 'b' });
    const sc = program('ok || a > 1 [kg]', { ok: { kind: 'boolean' }, a: { unit: 'kg' } }, { kind: 'boolean' });
    expect(evaluate(sc, { ok: { boolean: true, source: 'x' } }).output.value).toBe('true');
  });
});

describe('units at run time', () => {
  it('[DI-33] converts inputs given in another unit exactly and records the conversion factor', () => {
    const p = program('a + b', { a: { unit: 'kg' }, b: { unit: 'kg' } }, { unit: 'g' });
    const r = evaluate(p, { a: q('50.000'), b: q('1200', 'g') });
    expect(r.output).toEqual({ kind: 'quantity', value: '51200', unit: 'g', tag: 'none' });
    expect(r.conversions).toEqual([
      { at: 'input b', from: 'g', to: 'kg', factor: '0.001', exact: true },
      { at: 'output', from: 'kg', to: 'g', factor: '1000', exact: true },
    ]);
    expect(r.inputs.find((i) => i.path === 'b')).toMatchObject({ value: '1200', unit: 'g', source: 'test entry' });
  });

  it('[DI-33] adds different units of the same kind exactly (right operand converted to the left unit)', () => {
    const p = program('a + b', { a: { unit: 'kg' }, b: { unit: 'mg' } });
    const r = evaluate(p, { a: q('1'), b: q('1') });
    expect(r.output.value).toBe('1.000001');
    expect(r.conversions[0]).toMatchObject({ from: 'mg', to: 'kg', factor: '0.000001', exact: true });
  });

  it('[DI-33] handles absolute temperatures explicitly (difference in K, offsets applied)', () => {
    const p = program('t1 - t2', { t1: { unit: 'Cel' }, t2: { unit: '[degF]' } });
    expect(evaluate(p, { t1: q('121.1'), t2: q('212') }).output).toMatchObject({ value: '21.1', unit: 'K' });
    const p2 = program('t + d', { t: { unit: '[degF]' }, d: { unit: 'K' } });
    expect(evaluate(p2, { t: q('32'), d: q('10') }).output).toMatchObject({ value: '50', unit: '[degF]' });
    const p3 = program('t >= 121.0 [Cel]', { t: { unit: '[degF]' } }, { kind: 'boolean' });
    expect(evaluate(p3, { t: q('249.8') }).output.value).toBe('true');
    expect(evaluate(p3, { t: q('249.79') }).output.value).toBe('false');
  });

  it('a conditional gives its result in the unit of its first branch', () => {
    const p = program('ok ? a : b', { ok: { kind: 'boolean' }, a: { unit: 'kg' }, b: { unit: 'g' } });
    expect(evaluate(p, { ok: { boolean: false, source: 'x' }, a: q('1'), b: q('250') }).output).toMatchObject({ value: '0.25', unit: 'kg' });
  });

  it('% w/v values are read as grams per 100 mL', () => {
    const p = program('c * v', { c: { unit: '%', tag: 'w/v' }, v: { unit: 'mL' } }, { unit: 'g' });
    expect(evaluate(p, { c: q('5'), v: q('100') }).output.value).toBe('5');
  });

  it('comparisons are exact across units (no rounding)', () => {
    const p = program('a == b', { a: { unit: '[psi]' }, b: { unit: 'Pa' } }, { kind: 'boolean' });
    expect(evaluate(p, { a: q('1'), b: q('6894.757293168361336722673445346891') }).output.value).toBe('false');
    const p2 = program('a == b', { a: { unit: 'kg' }, b: { unit: 'g' } }, { kind: 'boolean' });
    expect(evaluate(p2, { a: q('1.5'), b: q('1500') }).output.value).toBe('true');
  });
});

describe('derived inputs (INV-25)', () => {
  const theoretical = program('sum(parts)', { parts: { kind: 'series', unit: 'kg', maxLength: 10 } }, { unit: 'kg' }, 'theoretical');
  const yieldCalc = program('yield(actual, theoretical)', { actual: { unit: 'kg' }, theoretical: { unit: 'kg', source: 'DERIVED' } }, { unit: '%', tag: 'yield' }, 'stage_yield');
  const t = evaluate(theoretical, { parts: { values: ['50.000', '1.200'], source: 'dispensing' } });

  it('[INV-25] a derived input takes the computed result of its calculation, recorded by content hash', () => {
    const r = evaluate(yieldCalc, { actual: q('50.300'), theoretical: { derived: t } });
    expect(r.output).toEqual({ kind: 'quantity', value: '98.2421875', unit: '%', tag: 'yield' });
    expect(r.inputs.find((i) => i.path === 'theoretical')).toMatchObject({ derivedFrom: t.contentHash, value: '51.2', source: 'calculation theoretical' });
  });

  it('[INV-25] a derived input given as a typed value is refused', () => {
    const e = fails(yieldCalc, { actual: q('50.300'), theoretical: q('51.200') });
    expect(e).toMatchObject({ code: 'DERIVED_VALUE_TYPED', path: 'theoretical' });
    expect(e.message).toMatch(/never be typed \(INV-25\)/);
  });

  it('[INV-25] a computed result altered after the fact is refused as a derived input', () => {
    const forged = { ...t, output: { ...t.output, value: '52.000' } };
    expect(fails(yieldCalc, { actual: q('50.300'), theoretical: { derived: forged } })).toMatchObject({ code: 'DERIVED_RECORD_INVALID', path: 'theoretical' });
  });

  it('[INV-25] a recorded input cannot be fed a computed result instead of its recorded value', () => {
    expect(fails(yieldCalc, { actual: { derived: t }, theoretical: { derived: t } })).toMatchObject({ code: 'INVALID_INPUT', path: 'actual' });
  });
});

describe('instants and durations', () => {
  it('computes exact durations between instants in any zone', () => {
    const p = program('duration(done, used)', { done: { kind: 'instant' }, used: { kind: 'instant' } }, { unit: 'h' });
    const r = evaluate(p, { done: { instant: '2026-09-28T08:00:00Z', source: 'server' }, used: { instant: '2026-09-30T20:30:00+05:30', source: 'server' } });
    expect(r.output).toMatchObject({ value: '55', unit: 'h' });
    const us = evaluate(program('duration(a, b)', { a: { kind: 'instant' }, b: { kind: 'instant' } }), {
      a: { instant: '2026-01-01T00:00:00.000001Z', source: 'x' },
      b: { instant: '2026-01-01T00:00:01Z', source: 'x' },
    });
    expect(us.output).toMatchObject({ value: '0.999999', unit: 's' });
  });

  it('refuses an end before the start', () => {
    const p = program('duration(a, b)', { a: { kind: 'instant' }, b: { kind: 'instant' } });
    expect(fails(p, { a: { instant: '2026-01-02T00:00:00Z', source: 'x' }, b: { instant: '2026-01-01T00:00:00Z', source: 'x' } })).toMatchObject({ code: 'DOMAIN_ERROR', path: 'b' });
  });
});
