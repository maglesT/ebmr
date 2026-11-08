/**
 * D-8 (owner's item 21): a stage's yield on the author's own calculation, with limits the author set and their source
 * (21 CFR 211.160(b): scientifically sound specifications, so each range records where it comes from). The content is
 * edited as the designer's ops edit it (UPDATE_CALCULATION, UPDATE_YIELD, SET_LIMIT_SOURCE, SET_LIMIT_BOUND). It passes
 * the validator in every edition; the engine computes the yield and judges it against the new limits (YIELD_OUT_OF_LIMITS outside them).
 */
import { describe, expect, it } from 'vitest';
import type { MbrContent } from '../../src/flow/model.ts';
import { clone, errors, loadFixture, validate } from '../flow/support.ts';
import { autopilot, define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS, GRANULATION_SCENARIO, Run } from '../engine/support.ts';

function edited(low: string, high: string): MbrContent {
  const m = clone(loadFixture('tablet-granulation-compression'));
  const calc = m.calculations.find((c) => c.id === 'blendYield');
  const y = m.yieldCheckpoints.find((k) => k.id === 'Y-BLEND');
  const range = y?.limits?.ranges.find((r) => r.tier === 'VALIDATED');
  if (!calc || !y || !range) throw new Error('SETUP: no blend yield');
  calc.name = 'Lubricated blend yield (author)';
  y.name = 'Lubricated blend yield';
  range.low = { value: low, inclusive: true };
  range.high = { value: high, inclusive: true };
  range.source = { kind: 'VALIDATION_REPORT', ref: 'VR-COMP' };
  return m;
}

describe('a yield on the author\'s own calculation and limits (D-8)', () => {
  it('[PR-31][INV-34][PR-08] the edited yield, its limits and their source pass the validator in every edition', () => {
    for (const edition of ['tablets', 'injectables', 'substance'] as const) {
      const m = edited('97.0', '101.0');
      m.header.edition = edition;
      const base = clone(loadFixture('tablet-granulation-compression'));
      base.header.edition = edition;
      expect(errors(validate(m)).map((f) => f.key).sort()).toEqual(errors(validate(base)).map((f) => f.key).sort());
    }
  });

  it('[PR-03][PR-31] a formula the author breaks (an unknown value) is refused by the validator\'s existing expression check, naming the calculation; nothing new refuses it', () => {
    const m = edited('97.0', '101.0');
    const calc = m.calculations.find((c) => c.id === 'blendYield');
    if (calc) calc.expression = 'yield(blendNett, blendTheoretical)';
    const found = errors(validate(m)).filter((f) => f.subject === 'blendYield' || f.message.includes('blendNett'));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.rule.startsWith('DATA-'))).toBe(true);
  });

  it('[PR-31][PR-08] the engine computes the yield and judges it against the author\'s limits: inside them the batch completes, outside them the yield step raises a yield out of limits and the batch waits for it', () => {
    const run = (m: MbrContent): { end: string; yields: string[] } => {
      const r = Run.issue(define(m, { justifications: FIXTURE_JUSTIFICATIONS }), { inputs: FIXTURE_INPUTS['tablet-granulation-compression'] });
      const end = autopilot(r, GRANULATION_SCENARIO);
      return { end, yields: r.exceptions('YIELD_OUT_OF_LIMITS').map((e) => e.source.stepKey ?? '') };
    };
    expect(run(edited('90.0', '101.0'))).toEqual({ end: 'COMPLETE', yields: [] });
    const out = run(edited('100.4', '100.5'));
    expect(out.yields).toEqual([expect.stringMatching(/^p-blend-yield@/)]);
    expect(out.end).not.toBe('COMPLETE');
  });
});
