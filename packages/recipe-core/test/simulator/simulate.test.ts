import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/simulator/simulate.ts';
import { clone, context, loadFixture } from '../flow/support.ts';

describe('automated simulation (outline 6.5)', () => {
  const granulation = loadFixture('tablet-granulation-compression');
  const report = simulate(granulation, context());

  it('[DI-04] the granulation fixture: every path enumerated, every step, decision, limit bound, guard, time constraint and calculation covered', () => {
    expect(report.problems).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.paths).toMatchObject({ exact: '600', enumerated: 600, boundHit: false, targeted: [] });
    for (const c of Object.values(report.coverage)) expect(c.missing).toEqual([]);
    expect(report.paths.withExceptions).toBeGreaterThan(0);
  });

  it('[DI-04] the output is deterministic: the same content gives the same report and report hash', () => {
    const again = simulate(clone(granulation), context());
    expect(again.reportHash).toBe(report.reportHash);
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
    expect(report.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('[PR-08] boundary values for every limit: on, just inside and just outside at the rounding boundary, and missing', () => {
    const lodHigh = report.limits.filter((v) => v.subject === 'lod' && v.tier === 'VALIDATED' && v.side === 'HIGH');
    expect(lodHigh.map((v) => [v.label, v.value, v.expected, v.actual])).toEqual([
      ['ON_LIMIT', '3.5', 'PASS', 'PASS'],
      ['JUST_INSIDE', '3.54', 'PASS', 'PASS'],
      ['JUST_OUTSIDE', '3.55', 'FAIL', 'FAIL'],
    ]);
    const missing = report.limits.filter((v) => v.subject === 'lod' && v.label === 'MISSING');
    expect(missing).toEqual([expect.objectContaining({ expected: 'EXCEPTION', actual: 'EXCEPTION', requirement: 'MISSING_VALUE_EXCEPTION' })]);
    expect(report.limits.every((v) => v.ok)).toBe(true);
  });

  it('[DI-34] boundary values for every guard select exactly one branch, and a missing value raises an exception', () => {
    const points = report.guards.filter((g) => g.alternative === 'ALT-OVERDRY');
    expect(points.filter((g) => g.point['lod'] !== null).map((g) => [g.point['lod'], g.selected])).toEqual([
      ['1.99', ['b-overdried']],
      ['2', ['b-dry-ok']],
      ['2.01', ['b-dry-ok']],
    ]);
    expect(points.find((g) => g.point['lod'] === null)).toMatchObject({ selected: [], ok: true });
  });

  it('[INV-20] boundary values for every time constraint: below and at the minimum, at and beyond the maximum', () => {
    const drymix = report.time.filter((t) => t.constraint === 'TC-DRYMIX');
    expect(drymix.map((t) => [t.label, t.actual, t.ok])).toEqual([
      ['NOT_STARTED', 'NOT_STARTED', true],
      ['BELOW_MIN', 'MIN_NOT_REACHED', true],
      ['AT_MIN', 'WITHIN', true],
      ['AT_MAX', 'WITHIN', true],
      ['ABOVE_MAX', 'MAX_BREACHED', true],
    ]);
  });

  it('[DI-04] calculations are checked against the golden inputs; a wrong confirmed result fails the simulation', () => {
    expect(report.golden.find((g) => g.calculation === 'adjustedApiQty')).toMatchObject({ status: 'PASS', expected: '8.741486 kg' });
    const wrong = clone(granulation);
    const g = wrong.goldenCases.find((x) => x.id === 'G-POTENCY');
    if (g) g.expected['adjustedApiQty'] = { value: '8.339', unit: 'kg' };
    const r = simulate(wrong, context());
    expect(r.passed).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/golden case G-POTENCY: adjustedApiQty fail/)]);
  });

  it('[DI-04] the packaging fixture simulates every path (4) with full coverage', () => {
    const p = simulate(loadFixture('tablet-blister-packaging'), context());
    expect(p.passed).toBe(true);
    expect(p.paths.exact).toBe('4');
    for (const c of Object.values(p.coverage)) expect(c.missing).toEqual([]);
  });
});
