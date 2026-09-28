import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluateLimits, LimitEvaluationError, TIER_REQUIREMENTS } from '../../src/limits/evaluate.ts';
import type { LimitRange, LimitSpec, LimitTier } from '../../src/limits/model.ts';
import { checkLimitSpec, checkNestingAfterRounding } from '../../src/limits/nesting.ts';
import { expr } from '../flow/support.ts';

const range = (tier: LimitTier, low: string, high: string, rounding: LimitRange['rounding'] = 'USP_HALF_UP_AT_LIMIT_DECIMALS'): LimitRange => ({
  tier,
  low: { value: low, inclusive: true },
  high: { value: high, inclusive: true },
  rounding,
  source: { kind: tier === 'REGISTERED' ? 'REGISTRATION' : tier === 'VALIDATED' ? 'VALIDATION_REPORT' : 'COMPANY_STANDARD', ref: 'R' },
});

/** Assay: registered 95.0-105.0, internal action 97.0-103.0, alert 98.0-102.0. */
const assay: LimitSpec = { unit: '%', ranges: [range('REGISTERED', '95.0', '105.0'), range('INTERNAL_ACTION', '97.0', '103.0'), range('ALERT', '98.0', '102.0')] };

const at = (v: string, spec: LimitSpec = assay) => evaluateLimits(spec, { value: v, unit: spec.unit }, expr);

describe('limit tiers (PR-08; outline 5.2.4)', () => {
  it('[PR-08] the tier table: inside all tiers nothing is required', () => {
    const r = at('100.0');
    expect(r).toMatchObject({ breached: undefined, breachedTiers: [], requirement: 'NONE', deviationRequired: false, registrationRelevant: false });
  });

  it('[PR-08] the tier table: an alert breach needs an exception-register item only', () => {
    expect(at('97.5')).toMatchObject({ breached: 'ALERT', requirement: 'REGISTER_ITEM', deviationRequired: false, dependentStepsBlockedUntilDeviation: false });
  });

  it('[PR-08] the tier table: an internal action breach stops the dependent step until a deviation is opened', () => {
    expect(at('96.0')).toMatchObject({ breached: 'INTERNAL_ACTION', breachedTiers: ['INTERNAL_ACTION', 'ALERT'], requirement: 'STOP_UNTIL_DEVIATION', deviationRequired: true, dependentStepsBlockedUntilDeviation: true, currentStepMayContinueWithDeviation: false, registrationRelevant: false });
    const lenient = evaluateLimits({ ...assay, actionBreach: 'CONTINUE_CURRENT_STEP_WITH_DEVIATION' }, { value: '96.0', unit: '%' }, expr);
    expect(lenient.currentStepMayContinueWithDeviation).toBe(true);
    expect(lenient.dependentStepsBlockedUntilDeviation).toBe(true);
  });

  it('[PR-08] a value outside a registered limit requires a registration-relevant deviation that only QA dispositions, shown on the release screen; the operator cannot clear it', () => {
    const r = at('94.0');
    expect(r).toMatchObject({
      breached: 'REGISTERED',
      requirement: 'REGISTRATION_RELEVANT_DEVIATION',
      deviationRequired: true,
      registrationRelevant: true,
      qaOnlyDisposition: true,
      onReleaseScreen: true,
      stageSignOffBlockedUntilQaClassification: true,
      operatorMayClear: false,
    });
    // An internal-action "continue" setting never softens a registered breach.
    expect(evaluateLimits({ ...assay, actionBreach: 'CONTINUE_CURRENT_STEP_WITH_DEVIATION' }, { value: '94.0', unit: '%' }, expr).currentStepMayContinueWithDeviation).toBe(false);
  });

  it('[PR-08] a validated range (CPP proven acceptable range) breach is treated like a registered one', () => {
    const cpp: LimitSpec = { unit: 'Cel', ranges: [range('VALIDATED', '55.0', '65.0')] };
    expect(at('66.0', cpp)).toMatchObject({ breached: 'VALIDATED', requirement: 'REGISTRATION_RELEVANT_DEVIATION', registrationRelevant: true });
  });

  it('[PR-08] a missing value is an exception, never a pass', () => {
    expect(evaluateLimits(assay, undefined, expr)).toMatchObject({ requirement: 'MISSING_VALUE_EXCEPTION', value: undefined, breached: undefined });
  });

  it('[PR-08] the value is stored exactly as acquired; rounding only decides the comparison (USP: raw 94.95 passes 95.0, 94.94 fails)', () => {
    const pass = at('94.95');
    expect(pass.value).toBe('94.95');
    expect(pass.breachedTiers).not.toContain('REGISTERED');
    expect(pass.tiers.find((t) => t.tier === 'REGISTERED')?.low?.rounded).toBe('95.0');
    expect(at('94.94').breached).toBe('REGISTERED');
  });

  it('[PR-08] strict bounds are respected after rounding', () => {
    const strict: LimitSpec = { unit: '%', ranges: [{ ...range('REGISTERED', '0', '1.0'), high: { value: '1.0', inclusive: false } }] };
    expect(at('0.99', strict).breached).toBe('REGISTERED');
    expect(at('0.94', strict).breached).toBeUndefined();
  });

  it('[PR-08] a value captured in another unit is converted exactly before comparison; an incommensurable unit is an error', () => {
    const mass: LimitSpec = { unit: 'kg', ranges: [range('INTERNAL_ACTION', '49.50', '50.50')] };
    expect(evaluateLimits(mass, { value: '50100', unit: 'g' }, expr)).toMatchObject({ value: '50.1', capturedValue: '50100', capturedUnit: 'g', breached: undefined });
    expect(() => evaluateLimits(mass, { value: '1', unit: 'mL' }, expr)).toThrow(LimitEvaluationError);
  });

  it('[PR-08] each tier rounds with its own rule (Ph. Eur. significant figures, USP decimals)', () => {
    const mixed: LimitSpec = { unit: '%', ranges: [range('REGISTERED', '0.50', '1.0', 'PH_EUR_SIG_FIGS'), range('INTERNAL_ACTION', '0.60', '0.90')] };
    const r = at('0.995', mixed);
    expect(r.tiers.find((t) => t.tier === 'REGISTERED')?.high?.rounded).toBe('1.0');
    expect(r.breached).toBe('INTERNAL_ACTION');
  });

  it('[PR-08] the tier table is data for renderers and reviewers', () => {
    expect(TIER_REQUIREMENTS.ALERT.requirement).toBe('REGISTER_ITEM');
    expect(TIER_REQUIREMENTS.INTERNAL_ACTION.requirement).toBe('STOP_UNTIL_DEVIATION');
    expect(TIER_REQUIREMENTS.REGISTERED.requirement).toBe('REGISTRATION_RELEVANT_DEVIATION');
  });

  it('[PR-08] property: moving a value outward never makes the breach less severe', () => {
    const severity = { NONE: 0, REGISTER_ITEM: 1, STOP_UNTIL_DEVIATION: 2, REGISTRATION_RELEVANT_DEVIATION: 3, MISSING_VALUE_EXCEPTION: 9 } as const;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50_000 }), fc.integer({ min: 0, max: 50_000 }), (a, b) => {
        const [near, far] = a <= b ? [a, b] : [b, a];
        const value = (d: number): string => `${Math.floor((100_000 + d) / 1000)}.${String((100_000 + d) % 1000).padStart(3, '0')}`;
        return severity[at(value(near)).requirement] <= severity[at(value(far)).requirement];
      }),
      { numRuns: 300 },
    );
  });
});

describe('limit nesting (alert inside internal action inside registered/validated)', () => {
  it('[PR-08] properly nested tiers pass, before and after rounding', () => {
    expect(checkLimitSpec(assay)).toEqual([]);
    expect(checkNestingAfterRounding(assay, expr)).toEqual([]);
  });

  it('[PR-08] an internal action range reaching outside the registered limit is refused', () => {
    const bad: LimitSpec = { unit: '%', ranges: [range('REGISTERED', '95.0', '105.0'), range('INTERNAL_ACTION', '94.0', '103.0')] };
    expect(checkLimitSpec(bad).map((p) => p.code)).toEqual(['NOT_NESTED']);
  });

  it('[PR-08] an inclusive inner bound on an exclusive outer bound is not nested', () => {
    const outer = { ...range('REGISTERED', '95.0', '105.0'), low: { value: '95.0', inclusive: false } };
    expect(checkLimitSpec({ unit: '%', ranges: [outer, range('ALERT', '95.0', '100.0')] }).map((p) => p.code)).toEqual(['NOT_NESTED']);
  });

  it('[PR-08] an inner tier that accepts, after its own rounding, a value the outer tier rejects is refused', () => {
    const leaky: LimitSpec = { unit: '%', ranges: [range('REGISTERED', '95.0', '105.0'), range('INTERNAL_ACTION', '95', '105')] };
    expect(checkLimitSpec(leaky)).toEqual([]);
    expect(checkNestingAfterRounding(leaky, expr).map((p) => p.code)).toEqual(['NOT_NESTED_AFTER_ROUNDING']);
  });

  it('[PR-08] empty ranges, missing bounds and duplicate tiers are refused', () => {
    expect(checkLimitSpec({ unit: '%', ranges: [range('ALERT', '5', '4')] }).map((p) => p.code)).toEqual(['EMPTY_RANGE']);
    expect(checkLimitSpec({ unit: '%', ranges: [{ tier: 'ALERT', rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'COMPANY_STANDARD', ref: 'R' } }] }).map((p) => p.code)).toEqual(['NO_BOUND']);
    expect(checkLimitSpec({ unit: '%', ranges: [range('ALERT', '1', '2'), range('ALERT', '1', '2')] }).map((p) => p.code)).toEqual(['DUPLICATE_TIER']);
    expect(checkLimitSpec({ unit: '%', ranges: [] }).map((p) => p.code)).toEqual(['NO_RANGES']);
  });
});
