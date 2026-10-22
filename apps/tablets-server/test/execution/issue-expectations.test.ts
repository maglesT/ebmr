/**
 * R3.1 (hosted-demo trials; D-7k-1): the tablet count the master implies at issue (batch size / target tablet weight), the
 * tolerance around it and the confirmation a count further away needs. The browser test of the issue form
 * (tools/e2e/specs/phase7/presenter-floor.spec.ts) shows the refusal and the confirmed issue on the real stack.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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

  it('deviation is exact decimal arithmetic', () => {
    expect(deviationPercent('110000', '100000')).toBe('10');
    expect(deviationPercent('110001', '100000')).toBe('10');
    expect(deviationPercent('1000000', '100000')).toBe('900');
    expect(deviationPercent('x', '100000')).toBeNull();
  });
});
