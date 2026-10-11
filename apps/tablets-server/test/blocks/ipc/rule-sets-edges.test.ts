/**
 * The compendial rule sets (tablets spec E.2 to E.5, DI-10) at their edges: the UTC date of an instant (before 1970,
 * at day and era boundaries, leap days), which version of a code binds on a date (effective from inclusive, to
 * exclusive, the latest version), the order of the sets, not-applicable records from their date, shared procedures and
 * recorded references. Versions and end dates are exercised with temporary rows appended to the shipped table and
 * removed after. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NOT_APPLICABLE, recorded, resolveRuleSets, RULE_SETS, ruleSetProblem, shared, uncoveredMarkets, utcDate, type RuleSet } from '../../../src/blocks/ipc/rule-sets.ts';

const DAY = 86_400_000_000n;
const base = RULE_SETS.find((r) => r.code === 'IP-FRIABILITY') as RuleSet;
const added: RuleSet[] = [];
const add = (r: Partial<RuleSet>): void => {
  const row = { ...base, ...r } as RuleSet;
  (RULE_SETS as RuleSet[]).push(row);
  added.push(row);
};
afterEach(() => {
  for (const r of added.splice(0)) (RULE_SETS as RuleSet[]).splice((RULE_SETS as RuleSet[]).indexOf(r), 1);
});

describe('rule sets', () => {
  it('[DI-10] the UTC date of an instant, before and after 1970, at day boundaries, leap days and century years', () => {
    expect(utcDate(0n)).toBe('1970-01-01');
    expect(utcDate(DAY - 1n)).toBe('1970-01-01');
    expect(utcDate(DAY)).toBe('1970-01-02');
    expect(utcDate(-1n)).toBe('1969-12-31');
    expect(utcDate(-DAY)).toBe('1969-12-31');
    expect(utcDate(-DAY - 1n)).toBe('1969-12-30');
    expect(utcDate(951_782_400_000_000n)).toBe('2000-02-29');
    expect(utcDate(951_868_800_000_000n)).toBe('2000-03-01');
    expect(utcDate(4_107_456_000_000_000n)).toBe('2100-02-28');
    expect(utcDate(4_107_542_400_000_000n)).toBe('2100-03-01');
    expect(utcDate(1_798_761_600_000_000n)).toBe('2027-01-01');
    expect(utcDate(-62_135_596_800_000_000n)).toBe('0001-01-01');
    expect(utcDate(-12_219_292_800_000_000n)).toBe('1582-10-15');
  });

  it('[DI-10][IN-34] a code binds from its effective date (inclusive) to its end date (exclusive), in its latest version, sorted by code; no tablet type binds nothing', () => {
    add({ code: 'ZZ-FRIABILITY', version: 1, effectiveFrom: '2030-01-01', effectiveTo: '2031-01-01' });
    add({ code: 'ZZ-FRIABILITY', version: 3, effectiveFrom: '2030-06-01' });
    add({ code: 'ZZ-FRIABILITY', version: 2, effectiveFrom: '2030-03-01' });
    add({ code: 'AA-FRIABILITY', version: 1, effectiveFrom: '2030-01-01' });
    const at = (date: string) => resolveRuleSets('FRIABILITY', ['IN'], 'UNCOATED', date).map((r) => `${r.code}@${r.version}`);
    expect(at('2029-12-31')).toEqual(['IP-FRIABILITY@1']);
    expect(at('2030-01-01')).toEqual(['AA-FRIABILITY@1', 'IP-FRIABILITY@1', 'ZZ-FRIABILITY@1']);
    expect(at('2030-03-01')).toEqual(['AA-FRIABILITY@1', 'IP-FRIABILITY@1', 'ZZ-FRIABILITY@2']);
    expect(at('2030-06-01')).toEqual(['AA-FRIABILITY@1', 'IP-FRIABILITY@1', 'ZZ-FRIABILITY@3']);
    expect(resolveRuleSets('FRIABILITY', ['IN'], undefined, '2030-06-01')).toEqual([]);
  });

  it('[DI-10] an end date is exclusive: the set no longer binds on it', () => {
    add({ code: 'ZZ-FRIABILITY', version: 1, effectiveFrom: '2030-01-01', effectiveTo: '2030-02-01' });
    const at = (date: string) => resolveRuleSets('FRIABILITY', ['IN'], 'UNCOATED', date).map((r) => r.code);
    expect(at('2030-01-31')).toContain('ZZ-FRIABILITY');
    expect(at('2030-02-01')).not.toContain('ZZ-FRIABILITY');
  });

  it('[DI-10][IN-34] a market is covered by a set or by a not-applicable record effective on the date; procedures must agree; recorded references resolve to shipped versions only', () => {
    const na = NOT_APPLICABLE.find((n) => n.test === 'UNIFORMITY_OF_WEIGHT' && n.market === 'US');
    expect(na?.effectiveFrom).toBe('2023-12-28');
    expect(uncoveredMarkets('UNIFORMITY_OF_WEIGHT', ['IN', 'US'], 'UNCOATED', '2023-12-28')).toEqual([]);
    expect(uncoveredMarkets('UNIFORMITY_OF_WEIGHT', ['IN', 'US'], 'UNCOATED', '2023-12-27')).toEqual(['IN', 'US']);
    expect(uncoveredMarkets('FRIABILITY', ['ZZ', 'EU'], 'UNCOATED', '2030-01-01')).toEqual(['ZZ']);
    expect(ruleSetProblem('FRIABILITY', [], ['ZZ', 'YY'], 'UNCOATED', '2030-01-01')).toBe('no rule set covers UNCOATED tablets for market YY, ZZ, and no record says none applies');
    expect(ruleSetProblem('FRIABILITY', [base, { ...base, params: { ...(base.params as object), rotations: 50, repeatRuns: 2 } as never }], ['IN'], 'UNCOATED', '2030-01-01')).toBe('the bound rule sets give different procedures (rotations, repeatRuns)');
    expect(ruleSetProblem('FRIABILITY', [], ['IN'], 'UNCOATED', '2030-01-01')).toBeUndefined();
    expect(shared([], 'rotations')).toBeUndefined();
    expect(shared([base, base], 'rotations')).toBe(100);
    expect(recorded([{ code: 'IP-FRIABILITY', version: 1 }, { code: 'IP-FRIABILITY', version: 2 }, { code: 'NONE', version: 1 }]).map((r) => r.code)).toEqual(['IP-FRIABILITY']);
    expect(recorded('x')).toEqual([]);
  });
});
