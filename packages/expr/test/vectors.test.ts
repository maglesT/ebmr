/**
 * Boundary test-vector generation (brief A1 item 7; ADR 0005 decision 8; outline 6.4, 6.5, L-65):
 * typical, at-limit, just inside and just outside at the rounding boundary, and absent inputs, each
 * with an expected outcome the author confirms, returned as data with plain-language descriptions.
 */
import { describe, expect, it } from 'vitest';
import { generateCalculationVectors, limitBoundaryValues, runCalculationVectors } from '../src/evidence/vectors.ts';
import { compile, type CompiledExpression } from '../src/lang/compile.ts';
import type { InputDeclarations, OutputDeclaration } from '../src/lang/types.ts';
import type { Limit } from '../src/rounding/rounding.ts';

function program(source: string, inputs: InputDeclarations, output?: OutputDeclaration): CompiledExpression {
  const r = compile(source, { inputs, ...(output === undefined ? {} : { output }) });
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('; '));
  return r.program;
}

const YIELD_LIMIT: Limit = { low: { value: '98.0' }, high: { value: '100.5' }, unit: '%' };

describe('limit boundary values', () => {
  it('[DI-33] USP 95.0-105.0: typical, on-limit, 94.95 just inside, 94.94 just outside, 105.04 / 105.05, and missing', () => {
    const v = limitBoundaryValues({ low: { value: '95.0' }, high: { value: '105.0' } }, 'USP_HALF_UP_AT_LIMIT_DECIMALS');
    expect(v.map((x) => [x.label, x.side ?? '', x.value, x.expected])).toEqual([
      ['TYPICAL', '', '100', 'PASS'],
      ['ON_LIMIT', 'LOW', '95', 'PASS'],
      ['JUST_INSIDE', 'LOW', '94.95', 'PASS'],
      ['JUST_OUTSIDE', 'LOW', '94.94', 'FAIL'],
      ['ON_LIMIT', 'HIGH', '105', 'PASS'],
      ['JUST_INSIDE', 'HIGH', '105.04', 'PASS'],
      ['JUST_OUTSIDE', 'HIGH', '105.05', 'FAIL'],
      ['MISSING', '', null, 'MISSING_VALUE'],
    ]);
    expect(v[2]?.description).toBe('Just inside the lower limit 95.0 at the rounding boundary: 94.95 rounds to 95.0 and passes (USP rounding to the limit decimals)');
    expect(v[7]?.description).toMatch(/a missing value never passes/);
  });

  it('[DI-33] Ph. Eur. figures and strict bounds move the threshold', () => {
    const ep = limitBoundaryValues({ low: { value: '100' } }, 'PH_EUR_SIG_FIGS');
    expect(ep.filter((x) => x.label.startsWith('JUST')).map((x) => [x.label, x.value, x.rounded])).toEqual([
      ['JUST_INSIDE', '99.95', '100'],
      ['JUST_OUTSIDE', '99.94', '99.9'],
    ]);
    const strict = limitBoundaryValues({ high: { value: '0.5', inclusive: false } }, 'USP_HALF_UP_AT_LIMIT_DECIMALS');
    expect(strict.map((x) => [x.label, x.value, x.expected])).toEqual([
      ['ON_LIMIT', '0.5', 'FAIL'],
      ['JUST_INSIDE', '0.44', 'PASS'],
      ['JUST_OUTSIDE', '0.45', 'FAIL'],
      ['MISSING', null, 'MISSING_VALUE'],
    ]);
  });
});

describe('calculation vectors', () => {
  const y = program('yield(actual, theoretical)', { actual: { unit: 'kg' }, theoretical: { unit: 'kg' } });
  const baseline = { actual: { value: '50.300', source: 'typical batch' }, theoretical: { value: '51.200', source: 'typical batch' } };

  it('[DI-33] generates typical, at-limit, rounding-boundary and absent-input vectors with expected outcomes pending the author', () => {
    const set = generateCalculationVectors(y, { limit: YIELD_LIMIT, ruleSet: 'USP_HALF_UP_AT_LIMIT_DECIMALS', baseline, driver: { path: 'actual', min: '40', max: '60' } });
    expect(set.notGenerated).toEqual([]);
    expect(set.vectors.map((v) => [v.id, v.expected.outcome])).toEqual([
      ['TYPICAL', 'PASS'],
      ['ON_LIMIT_LOW', 'PASS'],
      ['JUST_INSIDE_LOW', 'PASS'],
      ['JUST_OUTSIDE_LOW', 'FAIL'],
      ['ON_LIMIT_HIGH', 'PASS'],
      ['JUST_INSIDE_HIGH', 'PASS'],
      ['JUST_OUTSIDE_HIGH', 'FAIL'],
      ['ABSENT_INPUT_1', 'ERROR'],
      ['ABSENT_INPUT_2', 'ERROR'],
    ]);
    expect(set.vectors.every((v) => v.confirmation === 'PENDING_AUTHOR_CONFIRMATION' && v.description.length > 20)).toBe(true);
    const inside = set.vectors.find((v) => v.id === 'JUST_INSIDE_LOW');
    const outside = set.vectors.find((v) => v.id === 'JUST_OUTSIDE_LOW');
    // Raw results straddle the rounding threshold 97.95: the inside one rounds up to 98.0.
    expect(inside?.expected.roundedOutput).toBe('98.0');
    expect(Number(inside?.expected.rawOutput)).toBeLessThan(98);
    expect(outside?.expected.roundedOutput).toBe('97.9');
    const absent = set.vectors.filter((v) => v.category === 'ABSENT_INPUT');
    expect(absent.map((v) => [v.expected.errorCode, v.expected.errorPath])).toEqual([
      ['MISSING_INPUT', 'actual'],
      ['MISSING_INPUT', 'theoretical'],
    ]);
    expect(absent[0]?.inputs['actual']).toBeUndefined();
  });

  it('[DI-33] reports vectors it cannot reach instead of inventing them', () => {
    const noDriver = generateCalculationVectors(y, { limit: YIELD_LIMIT, ruleSet: 'USP_HALF_UP_AT_LIMIT_DECIMALS', baseline });
    expect(noDriver.vectors.map((v) => v.category)).toEqual(['TYPICAL', 'ABSENT_INPUT', 'ABSENT_INPUT']);
    expect(noDriver.notGenerated).toHaveLength(6);
    expect(noDriver.notGenerated[0]?.reason).toBe('no driver input was given');
    const narrow = generateCalculationVectors(y, { limit: YIELD_LIMIT, ruleSet: 'USP_HALF_UP_AT_LIMIT_DECIMALS', baseline, driver: { path: 'actual', min: '50.5', max: '50.6' } });
    expect(narrow.notGenerated.length).toBeGreaterThan(0);
    expect(narrow.notGenerated.every((n) => /cannot reach .* with actual between 50.5 and 50.6/.test(n.reason))).toBe(true);
  });

  it('[DI-33] re-running the vectors after a value-only change shows which expected outcomes changed (delta verification)', () => {
    const set = generateCalculationVectors(y, { limit: YIELD_LIMIT, ruleSet: 'USP_HALF_UP_AT_LIMIT_DECIMALS', baseline, driver: { path: 'actual', min: '40', max: '60' } });
    expect(runCalculationVectors(y, set, { limit: YIELD_LIMIT, ruleSet: 'USP_HALF_UP_AT_LIMIT_DECIMALS', baseline })).toEqual({ passed: true, failures: [] });
    const tighter: Limit = { low: { value: '98.5' }, high: { value: '100.5' }, unit: '%' };
    const r = runCalculationVectors(y, set, { limit: tighter, ruleSet: 'USP_HALF_UP_AT_LIMIT_DECIMALS', baseline });
    expect(r.passed).toBe(false);
    expect(r.failures.map((f) => f.id)).toEqual(['ON_LIMIT_LOW', 'JUST_INSIDE_LOW']);
  });

  it('works for a decreasing result and a Ph. Eur. rule set', () => {
    const lod = program('assay_as_is_dried(a, l)', { a: { unit: '%', tag: 'w/w' }, l: { unit: '%', tag: 'lod' } });
    const set = generateCalculationVectors(lod, {
      limit: { low: { value: '98.0' }, unit: '%' },
      ruleSet: 'PH_EUR_SIG_FIGS',
      baseline: { a: { value: '99.5', source: 'x' }, l: { value: '0.5', source: 'x' } },
      driver: { path: 'l', min: '0', max: '5' },
    });
    expect(set.notGenerated).toEqual([]);
    expect(set.vectors.filter((v) => v.category !== 'ABSENT_INPUT').map((v) => [v.id, v.expected.outcome, v.expected.roundedOutput])).toEqual([
      ['TYPICAL', 'PASS', '99.0'],
      ['ON_LIMIT_LOW', 'PASS', '98.0'],
      ['JUST_INSIDE_LOW', 'PASS', '98.0'],
      ['JUST_OUTSIDE_LOW', 'FAIL', '97.9'],
    ]);
  });
});
