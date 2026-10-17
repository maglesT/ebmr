/**
 * The method registry (interfaces slice-6A-0-interfaces.md sections 1 and 4): one entry per method id, the plan's
 * output kinds and flag rules, parameters at the plan's defaults that fit their own schema, and no method changes GMP
 * data (PR-60 is proven on the catalogue route in slice 6A-1).
 */
import { describe, expect, it } from 'vitest';
import { canonicalText, defaultParameters, METHOD_IDS, METHODS, OUTPUT_KINDS, parameterProblems, sha256Hex } from '../src/index.ts';

describe('method registry (registry.ts)', () => {
  it('has one entry per method id with the output kinds and flag rules of the interface notes, none changing GMP data', () => {
    expect(Object.keys(METHODS).sort()).toEqual([...METHOD_IDS].sort());
    const table = Object.fromEntries(Object.values(METHODS).map((m) => [m.id, { slice: m.slice, outputs: m.outputKinds, rules: m.flagRules }]));
    expect(table).toEqual({
      'SPC.IMR': { slice: '6A-2', outputs: ['CONTROL_CHART', 'MODEL_CANDIDATE'], rules: ['NELSON_1', 'NELSON_2', 'NELSON_3', 'NELSON_5'] },
      'SPC.XBAR_S': { slice: '6A-2', outputs: ['CONTROL_CHART', 'MODEL_CANDIDATE'], rules: ['NELSON_1', 'NELSON_2', 'NELSON_3', 'NELSON_5'] },
      'CAP.INDEX': { slice: '6A-2', outputs: ['CAPABILITY'], rules: [] },
      'DRIFT.TREND': { slice: '6A-2', outputs: ['DRIFT'], rules: ['DRIFT_SLOPE', 'DRIFT_EWMA'] },
      'RATE.DEVIATION': { slice: '6A-2', outputs: ['RATE_COMPARISON'], rules: ['RATE_ABOVE'] },
      'MSPC.PCA': { slice: '6A-3', outputs: ['MODEL_CANDIDATE', 'MSPC_SCORE'], rules: ['T2_ABOVE', 'Q_ABOVE'] },
      'ATA.RULES': {
        slice: '6A-4',
        outputs: ['AUDIT_RULE_HIT'],
        rules: ['LATE_ENTRY', 'BACK_DATED', 'CORRECTIONS_HIGH', 'TWO_TERMINALS', 'TOO_REGULAR', 'REPEAT_UNTIL_PASS', 'OFF_HOURS_CONFIG'],
      },
      'ATA.BASELINE': { slice: '6A-4', outputs: ['AUDIT_BASELINE'], rules: ['BASELINE_Z'] },
      'REVIEW.PRIORITY': { slice: '6A-5', outputs: ['REVIEW_PRIORITY'], rules: [] },
      'GBP.DTW_BAND': { slice: '6A-6', outputs: ['MODEL_CANDIDATE', 'PROFILE_DISTANCE'], rules: ['OUT_OF_BAND', 'DTW_DISTANCE'] },
    });
    for (const m of Object.values(METHODS)) {
      expect(m.changesGmpData, m.id).toBe(false);
      expect(m.outputKinds.every((k) => OUTPUT_KINDS.includes(k)), m.id).toBe(true);
      expect(m.inputs.every((i) => /^report\.[a-z_]+_v[1-9]\d*(\(.*\))?$/.test(i)), m.id).toBe(true);
      expect(m.intendedUse, m.id).toMatch(/advisory/);
    }
  });

  it('the default parameters fit their schema, carry the plan defaults and hash reproducibly; a wrong or missing parameter is named', () => {
    for (const id of METHOD_IDS) expect(parameterProblems(id, defaultParameters(id)), id).toEqual([]);
    expect(defaultParameters('DRIFT.TREND')).toEqual({ slopeWindow: 10, slopeAlpha: 0.05, projectBatches: 5, ewmaLambda: 0.2, ewmaL: 2.7 });
    expect(defaultParameters('MSPC.PCA')).toEqual({ maxComponents: 5, varianceTarget: 0.9, limitConfidence: 0.99, minReferenceBatches: 15, maxReferenceBatches: 100, scoredBatches: 50 });
    expect((defaultParameters('REVIEW.PRIORITY')['weights'] as Record<string, number>)['DEVIATION']).toBe(4);
    expect(sha256Hex(canonicalText(defaultParameters('SPC.IMR')))).toBe(sha256Hex(canonicalText({ phaseOneBatches: 20, rules: ['NELSON_1', 'NELSON_2', 'NELSON_3', 'NELSON_5'] })));
    expect(parameterProblems('SPC.IMR', { rules: ['NELSON_4'], phaseOneBatches: 20.5, extra: 1 })).toEqual([
      'extra is not a parameter of SPC.IMR',
      'rules is not a non-empty list of distinct values of NELSON_1, NELSON_2, NELSON_3, NELSON_5',
      'phaseOneBatches is not an integer',
    ]);
    expect(parameterProblems('CAP.INDEX', { minBatches: 10 })).toEqual(['minBatches is outside 25 to 1000', 'confidence is missing']);
    expect(parameterProblems('REVIEW.PRIORITY', { ...defaultParameters('REVIEW.PRIORITY'), caps: { NEAR_LIMIT: 5 } })).toEqual([
      'caps names exactly NEAR_LIMIT, CORRECTION, STEP_DURATION',
    ]);
  });
});
