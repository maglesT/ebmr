/**
 * Slice 7u (R10 #11; owner demo of 25 October 2026): the granulation yield showed as
 * "99.1322337796678351818860985000862 %" with the limit line "pass low 99.1 high 99.1". A computed value is shown at the
 * precision of its limits (the decimals the limits are written to, USP rounding; significant figures for Ph. Eur.),
 * three decimals at most without a limit, and the verdict names the limit it was judged against. Display only: the
 * stored value and the stored evaluation keep the engine's text.
 */
import { describe, expect, it } from 'vitest';
import type { engine, flow } from '@ebmr/recipe-core';
import { detailWords, limitPrecision, shownAt, verdictText } from '../../src/features/execution/views.ts';

const yieldLimits: flow.LimitSpec = {
  unit: '%',
  ranges: [{ tier: 'VALIDATED', rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR-RAB' }, low: { value: '97.0', inclusive: true }, high: { value: '101.0', inclusive: true } }],
};

const stored: engine.DataValue = { kind: 'DECIMAL', value: '99.1322337796678351818860985000862', unit: '%' };

describe('a computed value and its verdict as shown (R10 #11)', () => {
  it('[PR-31][DI-33] a yield is shown at the decimals of its limits; the stored value is unchanged', () => {
    expect(limitPrecision(yieldLimits)).toEqual({ decimals: 1 });
    expect(shownAt(stored, limitPrecision(yieldLimits))).toBe('99.1 %');
    expect(stored.value).toBe('99.1322337796678351818860985000862');
    // Without a limit: three decimals at most; a value already at that precision is shown as stored.
    expect(shownAt(stored, limitPrecision(undefined))).toBe('99.132 %');
    expect(shownAt({ kind: 'DECIMAL', value: '3.037', unit: 'kg' }, limitPrecision(undefined))).toBeUndefined();
    // Half up at the limit's decimals.
    expect(shownAt({ kind: 'DECIMAL', value: '96.95', unit: '%' }, limitPrecision(yieldLimits))).toBe('97.0 %');
    const sig = { ...yieldLimits, ranges: yieldLimits.ranges.map((r) => ({ ...r, rounding: 'PH_EUR_SIG_FIGS' as const })) } as flow.LimitSpec;
    expect(shownAt(stored, limitPrecision(sig))).toBe('99.13 %');
  });

  it('[PR-31][PR-08] the verdict names the limit it was judged against, not "pass low 99.1 high 99.1"', () => {
    const ev = { requirement: 'LIMITS', detail: ['VALIDATED: pass low 99.1 high 99.1'], languageVersion: '1' } as unknown as engine.StoredEvaluation;
    expect(verdictText(ev, false, yieldLimits, '%')).toBe('Within limits (validated 97.0 to 101.0 %: 99.1 as compared)');
    const out = { requirement: 'LIMITS', breached: 'VALIDATED', detail: ['VALIDATED: FAIL low 96.4 (outside) high 96.4'], languageVersion: '1' } as unknown as engine.StoredEvaluation;
    expect(verdictText(out, false, yieldLimits, '%')).toBe('Outside the validated limit: validated 97.0 to 101.0 %: 96.4 as compared, outside');
    // A limit with one bound, and a tier the spec does not hold (the engine's text is kept).
    const low = { unit: '%', ranges: [{ ...yieldLimits.ranges[0], high: undefined }] } as unknown as flow.LimitSpec;
    expect(detailWords('VALIDATED: pass low 98.5', low, '%')).toBe('validated at least 97.0 %: 98.5 as compared');
    expect(detailWords('ALERT: pass low 98.5', yieldLimits, '%')).toBe('ALERT: pass low 98.5');
  });
});
