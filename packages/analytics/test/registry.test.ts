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
      // A report view or row function, or (slice 6A-7, kernel 1282) a view of the analytics schema on the role's allow-list.
      expect(m.inputs.every((i) => /^report\.[a-z_]+_v[1-9]\d*(\(.*\))?$/.test(i) || /^analytics\.[a-z_]+_v[1-9]\d*$/.test(i)), m.id).toBe(true);
      expect(m.intendedUse, m.id).toMatch(/advisory/);
    }
  });

  it('the default parameters fit their schema, carry the plan defaults and hash reproducibly; a wrong or missing parameter is named', () => {
    for (const id of METHOD_IDS) expect(parameterProblems(id, defaultParameters(id)), id).toEqual([]);
    expect(defaultParameters('DRIFT.TREND')).toEqual({ slopeWindow: 10, slopeAlpha: 0.05, projectBatches: 5, ewmaLambda: 0.2, ewmaL: 2.7 });
    expect(defaultParameters('MSPC.PCA')).toEqual({ maxComponents: 5, varianceTarget: 0.9, limitConfidence: 0.99, minReferenceBatches: 15, maxReferenceBatches: 100, scoredBatches: 50 });
    expect((defaultParameters('REVIEW.PRIORITY')['weights'] as Record<string, number>)['DEVIATION']).toBe(4);
    expect(sha256Hex(canonicalText(defaultParameters('SPC.IMR')))).toBe(sha256Hex(canonicalText({ chartBatches: 100, phaseOneBatches: 20, rules: ['NELSON_1', 'NELSON_2', 'NELSON_3', 'NELSON_5'] })));
    expect(parameterProblems('SPC.IMR', { rules: ['NELSON_4'], phaseOneBatches: 20.5, extra: 1 })).toEqual([
      'extra is not a parameter of SPC.IMR',
      'rules is not a non-empty list of distinct values of NELSON_1, NELSON_2, NELSON_3, NELSON_5',
      'phaseOneBatches is not an integer',
      'chartBatches is missing',
    ]);
    expect(parameterProblems('CAP.INDEX', { minBatches: 10 })).toEqual(['minBatches is outside 25 to 1000', 'confidence is missing']);
    expect(parameterProblems('REVIEW.PRIORITY', { ...defaultParameters('REVIEW.PRIORITY'), caps: { NEAR_LIMIT: 5 } })).toEqual([
      'caps names exactly NEAR_LIMIT, CORRECTION, STEP_DURATION',
    ]);
  });

  // Mutation campaign at the Phase 7 exit (D-P7-1 item 4): each method's inputs, and each rule of the parameter schema.
  it('[DI-51][DI-52] each method names the inputs it reads', () => {
    expect(Object.fromEntries(Object.values(METHODS).map((m) => [m.id, m.inputs]))).toEqual({
      'SPC.IMR': ['report.cpp_value_v1', 'report.batch_fact_v1', 'report.analytics_reference_v1'],
      'SPC.XBAR_S': ['report.cpp_value_v1', 'report.batch_fact_v1', 'report.analytics_reference_v1'],
      'CAP.INDEX': ['report.cpp_value_v1', 'report.batch_fact_v1'],
      'DRIFT.TREND': ['report.cpp_value_v1', 'report.batch_fact_v1'],
      'RATE.DEVIATION': ['report.deviation_fact_v1', 'report.step_use_v1', 'report.step_shift_v1', 'report.batch_fact_v1'],
      'MSPC.PCA': ['report.cpp_value_v1', 'report.batch_fact_v1', 'report.deviation_fact_v1', 'report.analytics_reference_v1'],
      'ATA.RULES': ['report.audit_fact_v1', 'report.auth_fact_v1', 'report.manual_digit_v1'],
      'ATA.BASELINE': ['report.audit_fact_v1', 'report.auth_fact_v1'],
      'REVIEW.PRIORITY': ['report.review_fact_v1', 'report.cpp_value_v1', 'report.step_use_v1', 'report.batch_fact_v1', 'report.audit_fact_v1', 'analytics.audit_key_verdict_v1'],
      'GBP.DTW_BAND': ['report.series_ref_v1', 'report.series_samples_v1(uuid,text,text)'],
    });
  });

  it('[DI-52] a parameter outside its kind, range, choices or terms is named, each rule on its own', () => {
    const cap = defaultParameters('CAP.INDEX');
    const drift = defaultParameters('DRIFT.TREND');
    const rate = defaultParameters('RATE.DEVIATION');
    const review = defaultParameters('REVIEW.PRIORITY');
    // Numbers and integers: the type, finiteness, integrality and both ends of the range (the ends themselves fit).
    expect(parameterProblems('CAP.INDEX', { ...cap, minBatches: '30' })).toEqual(['minBatches is not an integer']);
    expect(parameterProblems('CAP.INDEX', { ...cap, minBatches: Number.POSITIVE_INFINITY })).toEqual(['minBatches is not an integer']);
    expect(parameterProblems('DRIFT.TREND', { ...drift, slopeAlpha: Number.NaN })).toEqual(['slopeAlpha is not a number']);
    expect(parameterProblems('DRIFT.TREND', { ...drift, slopeAlpha: '0.05' })).toEqual(['slopeAlpha is not a number']);
    expect(parameterProblems('DRIFT.TREND', { ...drift, ewmaLambda: 0.25 })).toEqual([]);
    expect(parameterProblems('CAP.INDEX', { ...cap, minBatches: 1000 })).toEqual([]);
    expect(parameterProblems('CAP.INDEX', { ...cap, minBatches: 25 })).toEqual([]);
    expect(parameterProblems('CAP.INDEX', { ...cap, minBatches: 1001 })).toEqual(['minBatches is outside 25 to 1000']);
    // Choices: a list, not empty, of known values only, each once.
    const choice = 'groupings is not a non-empty list of distinct values of STEP, EQUIPMENT, ROOM, MATERIAL_LOT, SUPPLIER, SHIFT';
    for (const bad of ['STEP', [], ['STEP', 7], ['STEP', 'BENCH'], ['STEP', 'STEP']]) expect(parameterProblems('RATE.DEVIATION', { ...rate, groupings: bad }), JSON.stringify(bad)).toEqual([choice]);
    expect(parameterProblems('RATE.DEVIATION', { ...rate, groupings: ['ROOM'] })).toEqual([]);
    // Weights: a map (not null, not a list) of exactly the terms, each a finite number of at least 0.
    const weights = 'caps is not a map of NEAR_LIMIT, CORRECTION, STEP_DURATION';
    for (const bad of [null, [5, 5, 3], 5]) expect(parameterProblems('REVIEW.PRIORITY', { ...review, caps: bad }), JSON.stringify(bad)).toEqual([weights]);
    expect(parameterProblems('REVIEW.PRIORITY', { ...review, caps: { NEAR_LIMIT: -1, CORRECTION: '5', STEP_DURATION: Number.POSITIVE_INFINITY } })).toEqual([
      'caps.NEAR_LIMIT is not a number of at least 0', 'caps.CORRECTION is not a number of at least 0', 'caps.STEP_DURATION is not a number of at least 0',
    ]);
    expect(parameterProblems('REVIEW.PRIORITY', { ...review, caps: { NEAR_LIMIT: 0, CORRECTION: 2.5, STEP_DURATION: 3 } })).toEqual([]);
  });
});

