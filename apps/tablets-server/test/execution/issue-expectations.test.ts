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
import { rtdProcessingContent } from '../../src/cli/demo-route-masters-ds.ts';

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

  it('[PR-04] slice 7m: a bilayer master implies its count from the full tablet (the last layer), not the first layer\'s own weight', () => {
    // Route D: BS-200K is 81.659 kg; layer L1 alone weighs 336.3 mg, the full bilayer tablet (layer T) 408.3 mg.
    const routeD = rtdProcessingContent('RTD-DC-TEST');
    expect(expectedTabletCount(routeD, 'BS-200K')).toEqual({ value: '199998', basis: 'batch size 81.659 kg / target tablet weight 408.3 mg', tolerancePercent: '10' });
    expect(unconfirmedCounts(routeD, 'BS-200K', { tabletsPerBatch: { kind: 'COUNT', value: '200000' } })).toEqual([]);
  });

  it('[PR-01][PR-04] decision 0026 S11b: a master from a formula records its unit mass, so each batch size gives its own count exactly (it wins over a compression target that includes a coat); the parser keeps it and refuses a zero', () => {
    // Two sizes from a formula of 556 mg a tablet: 55.6 kg for 1,00,000 and 27.800 kg for 50,000; a coat after the formula
    // (a compression target of 570 mg) does not change the count.
    const fromFormula = { ...gbt01, header: { ...gbt01.header, unitMassMg: '556', batchSizes: [{ id: 'BS-100000U', quantity: { value: '55.6', unit: 'kg' } }, { id: 'BS-50000U', quantity: { value: '27.800', unit: 'kg' } }] } };
    expect(expectedTabletCount(fromFormula, 'BS-100000U')).toEqual({ value: '100000', basis: 'batch size 55.6 kg / the formula\'s unit mass 556 mg', tolerancePercent: '10' });
    expect(expectedTabletCount(fromFormula, 'BS-50000U')?.value).toBe('50000');
    // The further size's count typed for the reference size (or the reverse) is refused without a reason.
    expect(unconfirmedCounts(fromFormula, 'BS-100000U', { tabletsPerBatch: { kind: 'COUNT', value: '50000' } }).map((p) => [p.expected.value, p.deviation])).toEqual([['100000', '50']]);
    expect(unconfirmedCounts(fromFormula, 'BS-50000U', { tabletsPerBatch: { kind: 'COUNT', value: '50000' } })).toEqual([]);
    // Capsules edition C2: a capsule master counts capsules; its input may be named for capsules, and the problem says so.
    expect(unconfirmedCounts(fromFormula, 'BS-100000U', { tabletsPerBatch: { kind: 'COUNT', value: '50000' } })[0]?.unit).toBe('tablet');
    const capsules = { ...fromFormula, header: { ...fromFormula.header, product: { ...gbt01.header.product, dosageForm: 'Hard gelatin capsule' } }, inputs: [{ id: 'capsulesPerBatch', name: 'Batch size in capsules', source: 'BATCH_HEADER' as const, valueType: 'COUNT' as const }] };
    expect(unconfirmedCounts(capsules, 'BS-100000U', { capsulesPerBatch: { kind: 'COUNT', value: '50000' } }).map((p) => [p.inputId, p.unit, p.deviation])).toEqual([['capsulesPerBatch', 'capsule', '50']]);
    const raw = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as { header: Record<string, unknown> };
    const withMass = (v: string) => flow.parseMbr({ ...raw, header: { ...raw.header, unitMassMg: v } });
    const kept = withMass('556.25');
    expect(kept.ok && kept.mbr.header.unitMassMg).toBe('556.25');
    for (const bad of ['0', '0.000', '-5', '5e2', 'abc']) expect(withMass(bad).ok).toBe(false);
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
    expect(deviationPercent('5', '0')).toBeNull();
  });

  it('[PR-01][PR-04] only a COUNT named for tablets is checked; a size that is no mass, a master with no positive unit mass or target, or a malformed procedure give no expectation, never a wrong one', () => {
    const inputs = [
      { id: 'operators', name: 'Operators on the line', valueType: 'COUNT' },
      { id: 'tabletMass', name: 'Tablet mass', valueType: 'DECIMAL' },
      { id: 'tabletsPerBatch', name: 'Units per batch', valueType: 'COUNT' },
      { id: 'coreCount', name: 'Number of TABLETS (cores)', valueType: 'COUNT' },
    ];
    const master = (procedure: unknown, sizes = [{ id: 'S', quantity: { value: '40', unit: 'kg' } }], unitMassMg?: string) => ({ header: { batchSizes: sizes, ...(unitMassMg === undefined ? {} : { unitMassMg }) }, inputs, procedure });
    const flat = master({ steps: [{ a: null }, { targetWeightMg: '400' }] });
    expect([...inputExpectations(flat, 'S').entries()].map(([k, v]) => [k, v.value])).toEqual([['tabletsPerBatch', '100000'], ['coreCount', '100000']]);
    expect(inputExpectations(flat, 'NONE').size).toBe(0);
    // A target that is no decimal is skipped for the next one; a recorded unit mass that is no decimal falls back to it.
    expect(expectedTabletCount(master({ targetWeightMg: 'abc', next: { targetWeightMg: '400' } }), 'S')?.value).toBe('100000');
    expect(expectedTabletCount(master({ targetWeightMg: '400' }, undefined, 'abc'), 'S')?.basis).toBe('batch size 40 kg / target tablet weight 400 mg');
    // A bilayer run with no usable full-tablet weight on its last layer reads the next target.
    for (const layers of [[null], [{ weight: null }], [{ weight: {} }], [{ weight: { targetWeightMg: 'abc' } }]]) {
      expect(expectedTabletCount(master({ layers, targetWeightMg: '400' }), 'S')?.value).toBe('100000');
    }
    expect(expectedTabletCount(master({ steps: [] }), 'S')).toBeNull();
    expect(expectedTabletCount(master({ targetWeightMg: '400' }, [{ id: 'S', quantity: { value: '40', unit: 'L' } }]), 'S')).toBeNull();
    expect(expectedTabletCount(master({ targetWeightMg: '0' }), 'S')).toBeNull();
    expect(expectedTabletCount(master({ targetWeightMg: '-400' }), 'S')).toBeNull();
    // Problems name the input as the master does; an input not entered is not checked; an expected count of zero judges nothing.
    const named = unconfirmedCounts(flat, 'S', { tabletsPerBatch: { kind: 'COUNT', value: '5' }, coreCount: { kind: 'COUNT', value: '1e5' } });
    expect(named.map((p) => [p.inputId, p.name, p.malformed ?? false])).toEqual([['tabletsPerBatch', 'Units per batch', false], ['coreCount', 'Number of TABLETS (cores)', true]]);
    expect(unconfirmedCounts(flat, 'S', {})).toEqual([]);
    const tiny = master({ targetWeightMg: '400' }, [{ id: 'S', quantity: { value: '0.1', unit: 'mg' } }]);
    expect(expectedTabletCount(tiny, 'S')?.value).toBe('0');
    expect(unconfirmedCounts(tiny, 'S', { tabletsPerBatch: { kind: 'COUNT', value: '5' } })).toEqual([]);
  });
});
