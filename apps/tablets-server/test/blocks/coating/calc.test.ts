/**
 * Phase 3 slice 3d (builder A): the pure calculations of the coating blocks (C-16 weight gain, sample means) and the
 * attribute sampling scheme of TB-20 (ISO 2859-1 single sampling, held as data with its source). The database's copy is
 * compared with these in db-guards.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { cmp, compareGain, fixedText, meanMg, roundHalfAway, sumText, toMg, weightGain } from '../../../src/blocks/coating/calc.ts';
import { AQL_SCHEME, codeLetter, expandedPlans, planOf } from '../../../src/blocks/coating/aql.ts';

describe('coating calculations (C-16)', () => {
  it('[IN-37][PR-29] the weight gain follows C-16 exactly: the worked example (cores 250.0 mg to 257.5 mg is 3.0 %), from sample totals, rounded half away from zero to 4 decimals', () => {
    expect(weightGain('25750', 100n, '250.000000')).toBe('3.0000');
    expect(weightGain('5150.0', 20n, '250.060000')).toBe('2.9753');
    // 1/3 % exactly representable? (250 x 1.00333.. ) -> 0.3333 and a tie rounded away from zero.
    expect(weightGain('250.5', 1n, '250')).toBe('0.2000');
    expect(weightGain('25000.005', 100n, '250')).toBe('0.0000');
    expect(weightGain('2500.0125', 10n, '250')).toBe('0.0005');
    expect(weightGain('249.5', 1n, '250')).toBe('-0.2000');
    expect(roundHalfAway(-5n, 10n)).toBe(-1n);
    expect(roundHalfAway(5n, 10n)).toBe(1n);
    expect(roundHalfAway(4n, 10n)).toBe(0n);
  });

  it('[IN-37][PR-08] the minimum and maximum weight gain are judged on the exact ratio, never on the rounded value', () => {
    // 3.00004 % rounds to 3.0000 but is above a maximum of 3.0.
    expect(weightGain('25750.01', 100n, '250')).toBe('3.0000');
    expect(compareGain('25750.01', 100n, '250', '3.0')).toBe(1);
    expect(compareGain('25750', 100n, '250', '3.0')).toBe(0);
    expect(compareGain('25749.99', 100n, '250', '3.0')).toBe(-1);
  });

  it('[PR-29][DI-29] a sample mean is the exact total over the count, 6 decimals; g are converted to mg exactly', () => {
    expect(meanMg(toMg('5.0012', 'g'), 20n)).toBe('250.060000');
    expect(meanMg('1000', 3n)).toBe('333.333333');
    expect(meanMg('2000', 3n)).toBe('666.666667');
    expect(toMg('0.25', 'g')).toBe('250');
    expect(sumText(['250.1', '249.95', '250'])).toBe('750.05');
    expect(fixedText(-12n, 4)).toBe('-0.0012');
    expect(cmp('2.50', '2.5')).toBe(0);
  });
});

describe('the AQL sampling scheme (TB-20; D-S3-2)', () => {
  it('[PR-29][DI-10] the scheme carries its source, effective date and confidence; Table I gives the code letter by lot size and level', () => {
    expect(AQL_SCHEME.source).toMatch(/ISO 2859-1/);
    expect(AQL_SCHEME.confidence).toBe('MEDIUM');
    expect(codeLetter(1n, 'II')).toBeUndefined();
    expect(codeLetter(8n, 'III')).toBe('B');
    expect(codeLetter(3201n, 'II')).toBe('L');
    expect(codeLetter(10000n, 'II')).toBe('L');
    expect(codeLetter(10001n, 'II')).toBe('M');
    expect(codeLetter(199680n, 'II')).toBe('P');
    expect(codeLetter(2_000_000n, 'II')).toBe('Q');
    expect(codeLetter(2_000_000n, 'I')).toBe('N');
  });

  it('[PR-29][DI-10] Table II-A (normal) and II-B (tightened): the published plans, the arrows followed to the first plan below or above', () => {
    const p = (s: 'NORMAL' | 'TIGHTENED', l: string, a: string) => {
      const x = planOf(s, l, a);
      return x ? `${x.letter} ${x.n} ${x.ac}/${x.re}` : 'none';
    };
    expect(p('NORMAL', 'L', '1.0')).toBe('L 200 5/6');
    expect(p('NORMAL', 'K', '1.0')).toBe('K 125 3/4');
    expect(p('NORMAL', 'K', '2.5')).toBe('K 125 7/8');
    expect(p('NORMAL', 'K', '0.10')).toBe('K 125 0/1');
    expect(p('NORMAL', 'K', '0.15')).toBe('J 80 0/1');
    expect(p('NORMAL', 'K', '0.25')).toBe('L 200 1/2');
    expect(p('NORMAL', 'A', '0.65')).toBe('F 20 0/1');
    expect(p('NORMAL', 'R', '4.0')).toBe('M 315 21/22');
    expect(p('TIGHTENED', 'K', '1.0')).toBe('K 125 2/3');
    expect(p('TIGHTENED', 'L', '1.0')).toBe('L 200 3/4');
    expect(p('TIGHTENED', 'K', '4.0')).toBe('K 125 8/9');
    expect(p('NORMAL', 'K', '0.003')).toBe('none');
    // Every supported cell resolves to a plan, and tightened is never looser than normal at the same sample size.
    const all = expandedPlans();
    expect(all.filter((x) => !x.plan)).toEqual([]);
    for (const t of all.filter((x) => x.severity === 'TIGHTENED')) {
      const n = all.find((x) => x.severity === 'NORMAL' && x.letter === t.letter && x.aql === t.aql)?.plan;
      if (n && t.plan && n.n === t.plan.n) expect(t.plan.ac <= n.ac, `${t.letter} ${t.aql}`).toBe(true);
    }
  });
});
