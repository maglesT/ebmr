/**
 * The numerical libraries of slice 6A-1 (ADR 0020 point 7; D-6A-23): pinned exactly, recorded with every run
 * (RUNTIME_LIBRARIES equals package.json), and giving the published quantiles and a known decomposition. A quantile
 * refuses a probability outside (0, 1) or a non-positive parameter instead of returning NaN into a statistic.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_PACKAGE_VERSION,
  AnalyticsInputError,
  betaQuantile,
  chiSquareQuantile,
  fQuantile,
  Matrix,
  normalQuantile,
  RUNTIME_LIBRARIES,
  SingularValueDecomposition,
  tQuantile,
} from '../src/index.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; dependencies: Record<string, string> };

describe('the analytics libraries (runtime.ts, numeric/quantiles.ts, numeric/linalg.ts)', () => {
  it('[DI-52] the runtime a run records names the package version and every library at its exact pinned version', () => {
    expect(ANALYTICS_PACKAGE_VERSION).toBe(pkg.version);
    expect(RUNTIME_LIBRARIES).toEqual(pkg.dependencies);
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(name.startsWith('@stdlib/') || name === 'ml-matrix', name).toBe(true);
    }
  });

  it('gives the published quantiles of the normal, t, chi-square, F and beta distributions', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 12);
    expect(normalQuantile(0.5)).toBe(0);
    expect(tQuantile(0.975, 10)).toBeCloseTo(2.228138851986273, 10);
    expect(chiSquareQuantile(0.95, 2)).toBeCloseTo(5.991464547107979, 10);
    expect(fQuantile(0.95, 3, 10)).toBeCloseTo(3.708264819, 7);
    expect(betaQuantile(0.5, 2, 2)).toBeCloseTo(0.5, 12);
  });

  it('refuses a probability outside (0, 1) and a non-positive or non-finite parameter', () => {
    for (const p of [0, 1, -0.1, 1.1, Number.NaN]) expect(() => normalQuantile(p), String(p)).toThrow(AnalyticsInputError);
    expect(() => tQuantile(0.9, 0)).toThrow(/degrees of freedom/);
    expect(() => chiSquareQuantile(0.9, -1)).toThrow(/degrees of freedom/);
    expect(() => fQuantile(0.9, 1, Number.POSITIVE_INFINITY)).toThrow(/denominator/);
    expect(() => betaQuantile(0.9, 1, 0)).toThrow(/shape b/);
  });

  it('decomposes a known matrix', () => {
    const svd = new SingularValueDecomposition(new Matrix([[3, 0], [0, 4]]));
    expect(svd.diagonal.map((v) => Number(v.toFixed(12)))).toEqual([4, 3]);
  });
});
