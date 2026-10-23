/**
 * R3.1 (hosted-demo trials; D-7k-1): the tablet count the master implies at issue (batch size / target tablet weight), the
 * tolerance around it and the confirmation a count further away needs. The browser test of the issue form
 * (tools/e2e/specs/phase7/presenter-floor.spec.ts) shows the refusal and the confirmed issue on the real stack.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SignableAction } from '@ebmr/api-contract';
import { flow } from '@ebmr/recipe-core';
import { deviationPercent, expectedTabletCount, inputExpectations, unconfirmedCounts } from '../../src/features/execution/issue-expectations.ts';

const TEMPLATE = fileURLToPath(new URL('../../src/features/designer/templates/gb-t-01.mbr.json', import.meta.url));
const parsed = flow.parseMbr(JSON.parse(readFileSync(TEMPLATE, 'utf8')));
if (!parsed.ok) throw new Error('gb-t-01 does not parse');
const gbt01 = parsed.mbr;

describe('R3.1: the tablet count at issue against the master', () => {
  it('the master implies batch size / target tablet weight, rounded to a whole tablet', () => {
    // GB-T-01: BS-200K is 81.659 kg of tablets of 410.0 mg (the core, before the coat).
    expect(expectedTabletCount(gbt01, 'BS-200K')).toEqual({ value: '199168', basis: 'batch size 81.659 kg / target tablet weight 410.0 mg', tolerancePercent: '10' });
    expect(expectedTabletCount(gbt01, 'BS-NONE')).toBeNull();
    expect([...inputExpectations(gbt01, 'BS-200K').keys()]).toEqual(['tabletsPerBatch']);
  });

  it('a count within 10 % passes; one further away (a digit short) needs the issuer\'s reason', () => {
    const count = (value: string) => ({ tabletsPerBatch: { kind: 'COUNT', value } });
    expect(unconfirmedCounts(gbt01, 'BS-200K', count('200000'))).toEqual([]);
    expect(unconfirmedCounts(gbt01, 'BS-200K', count('219000'))).toEqual([]);
    const short = unconfirmedCounts(gbt01, 'BS-200K', count('20000'));
    expect(short.map((p) => [p.inputId, p.entered, p.expected.value, p.deviation])).toEqual([['tabletsPerBatch', '20000', '199168', '89.96']]);
    expect(unconfirmedCounts(gbt01, 'BS-200K', count('20000'), { tabletsPerBatch: '  ' })).toHaveLength(1);
    expect(unconfirmedCounts(gbt01, 'BS-200K', count('20000'), { tabletsPerBatch: 'Trial sub-batch of a tenth agreed with QA (CC-2026-114)' })).toEqual([]);
  });

  it('[PR-04] P7K-3: a count that is no whole number is refused, and no reason confirms it', () => {
    const reason = { tabletsPerBatch: 'Trial sub-batch agreed with QA' };
    for (const value of ['1e5', '2e5', '199168.0', '-199168', ' 199168', '0x30A00', 'abc', '']) {
      const problems = unconfirmedCounts(gbt01, 'BS-200K', { tabletsPerBatch: { kind: 'COUNT', value } }, reason);
      expect(problems.map((p) => [p.inputId, p.entered, p.malformed])).toEqual([['tabletsPerBatch', value, true]]);
    }
    expect(unconfirmedCounts(gbt01, 'BS-200K', { tabletsPerBatch: { kind: 'COUNT', value: 199168 } }, reason)[0]?.malformed).toBe(true);
    expect(unconfirmedCounts(gbt01, 'BS-200K', { tabletsPerBatch: { kind: 'COUNT', value: '199168' } }, reason)).toEqual([]);
  });

  it('[PR-04] P7K-3: the GMP_BATCH_ISSUE contract already refuses a COUNT that is no whole number', () => {
    const issue = (value: string) => ({ kind: 'GMP_BATCH_ISSUE', batchId: '00000000-0000-4000-8000-000000000001', reason: { code: 'ISSUE', text: 'Issue' }, variants: {}, inputs: { tabletsPerBatch: { kind: 'COUNT', value } } });
    expect(SignableAction.safeParse(issue('199168')).success).toBe(true);
    for (const value of ['1e5', '199168.0', '-1', ' 199168']) expect(SignableAction.safeParse(issue(value)).success).toBe(false);
  });

  it('deviation is exact decimal arithmetic', () => {
    expect(deviationPercent('110000', '100000')).toBe('10');
    expect(deviationPercent('110001', '100000')).toBe('10');
    expect(deviationPercent('1000000', '100000')).toBe('900');
    expect(deviationPercent('x', '100000')).toBeNull();
  });
});
