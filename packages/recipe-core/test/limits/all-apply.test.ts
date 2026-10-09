import { describe, expect, it } from 'vitest';
import { evaluateAllApply, samplingShortfalls, samplingUnion } from '../../src/limits/all-apply.ts';
import type { AcceptanceScheme } from '../../src/limits/model.ts';
import { expr } from '../flow/support.ts';

/** Two markets' criteria that cannot be ranked: each applies with its own statistic, rounding and sampling. */
const scheme: AcceptanceScheme = {
  id: 'AS',
  title: 'Weight: IP band and in-house RSD',
  method: 'ALL_APPLY',
  criteria: [
    {
      id: 'IP',
      title: 'IP average weight band',
      governingMarkets: ['IN'],
      pharmacopoeia: { code: 'IP', edition: '2026' },
      statistic: 'mean',
      unit: 'mg',
      range: { tier: 'REGISTERED', low: { value: '237.5', inclusive: true }, high: { value: '262.5', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'PHARMACOPOEIA', ref: 'IP' } },
      sampling: [
        { point: 'start', purpose: 'weight', units: 20, destructive: false },
        { point: 'end', purpose: 'weight', units: 20, destructive: false },
      ],
    },
    {
      id: 'EU',
      title: 'Ph. Eur. RSD (significant figures)',
      governingMarkets: ['EU'],
      pharmacopoeia: { code: 'Ph. Eur.', edition: '11' },
      statistic: 'rsd',
      unit: '%',
      range: { tier: 'REGISTERED', high: { value: '2.0', inclusive: true }, rounding: 'PH_EUR_SIG_FIGS', source: { kind: 'PHARMACOPOEIA', ref: 'EP' } },
      sampling: [
        { point: 'start', purpose: 'weight', units: 10, destructive: false },
        { point: 'start', purpose: 'assay', units: 10, destructive: true },
      ],
    },
  ],
};

describe('ALL_APPLY acceptance schemes (outline 3.3.1)', () => {
  it('[PR-08] the sampling plan is the union of what each criterion needs', () => {
    expect(samplingUnion(scheme)).toEqual([
      { point: 'end', purpose: 'weight', units: 20, destructive: false },
      { point: 'start', purpose: 'assay', units: 10, destructive: true },
      { point: 'start', purpose: 'weight', units: 20, destructive: false },
    ]);
  });

  it('[PR-08] a plan that misses what one criterion needs is reported with that criterion', () => {
    const gaps = samplingShortfalls(scheme, [
      { point: 'start', purpose: 'weight', units: 20, destructive: false },
      { point: 'end', purpose: 'weight', units: 20, destructive: false },
    ]);
    expect(gaps).toEqual([{ point: 'start', purpose: 'assay', needed: 10, planned: 0, criteria: ['EU'] }]);
  });

  it('[PR-08] every criterion is evaluated on its own, with its own rounding; the result passes only if every criterion passes', () => {
    const ok = evaluateAllApply(
      scheme,
      new Map([
        ['mean', { value: '250.1', unit: 'mg' }],
        ['rsd', { value: '2.04', unit: '%' }],
      ]),
      expr,
    );
    expect(ok.pass).toBe(true);
    expect(ok.criteria.find((c) => c.criterion === 'EU')?.evaluation.tiers[0]?.high?.rounded).toBe('2.0');
    const fail = evaluateAllApply(
      scheme,
      new Map([
        ['mean', { value: '250.1', unit: 'mg' }],
        ['rsd', { value: '2.05', unit: '%' }],
      ]),
      expr,
    );
    expect(fail.pass).toBe(false);
    expect(fail.criteria.map((c) => [c.criterion, c.pass, c.governingMarkets])).toEqual([
      ['IP', true, ['IN']],
      ['EU', false, ['EU']],
    ]);
  });

  it('[PR-08] a missing statistic fails its criterion and the scheme', () => {
    const r = evaluateAllApply(scheme, new Map([['mean', { value: '250.1', unit: 'mg' }]]), expr);
    expect(r.pass).toBe(false);
    expect(r.criteria.find((c) => c.criterion === 'EU')?.evaluation.requirement).toBe('MISSING_VALUE_EXCEPTION');
  });
});
