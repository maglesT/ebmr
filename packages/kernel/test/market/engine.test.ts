/**
 * The pure resolution engine: every comparison method, predicate branches, effective dates and
 * refusals (build outline 3.3.1, 3.3.2; ADR 0008; IN-52; INV-28). No database.
 */
import { describe, expect, it } from 'vitest';
import { compareDecimal, isCanonicalDecimal } from '../../src/market/decimal.ts';
import { resolve } from '../../src/market/resolve.ts';
import { snapshotFromDocument } from '../../src/market/snapshot.ts';
import { isAtLeastAsStrict, isSameValue } from '../../src/market/strictness.ts';
import type { RuleKeyDoc, RuleRowDoc, RuleTableDocument, RuleTableSnapshot } from '../../src/market/types.ts';
import { validateRuleTableDocument } from '../../src/market/validate.ts';
import { seedDocument } from './helpers.ts';

const kernel = snapshotFromDocument(seedDocument('kernel'));
const tablets = snapshotFromDocument(seedDocument('tablets'));
const sterile = snapshotFromDocument(seedDocument('sterile'));
const ALL = ['IN', 'US', 'EU'];

function row(partial: Partial<RuleRowDoc> & Pick<RuleRowDoc, 'ref' | 'key' | 'market' | 'value' | 'unit'>): RuleRowDoc {
  return { floor: 'HARD', source: 'test', verification: 'P', effectiveFrom: '2024-01-01', ...partial };
}
function table(keys: RuleKeyDoc[], rows: RuleRowDoc[]): RuleTableSnapshot {
  const doc: RuleTableDocument = { table: 'kernel', version: 1, keys, rows };
  return snapshotFromDocument(doc);
}

describe('comparison methods', () => {
  it('[IN-52] SMALLER_STRICTER takes the smallest value and names the market that requires it', () => {
    const t = table(
      [{ key: 'kernel.t.interval', title: 't', method: 'SMALLER_STRICTER', valueType: 'DECIMAL', unit: 'min', indiaGoverns: true }],
      [row({ ref: 'a', key: 'kernel.t.interval', market: 'IN', value: '30', unit: 'min' }), row({ ref: 'b', key: 'kernel.t.interval', market: 'EU', value: '7.5', unit: 'min' })],
    );
    const r = resolve(t, { key: 'kernel.t.interval', marketSet: ['IN', 'EU'], asOf: '2026-01-01' });
    expect(r.value).toBe('7.5');
    expect(r.governingMarkets).toEqual(['EU']);
    expect(resolve(t, { key: 'kernel.t.interval', marketSet: ['IN'], asOf: '2026-01-01' }).value).toBe('30');
  });

  it('[IN-52] LARGER_STRICTER takes the largest value; equal values govern together', () => {
    const r = resolve(kernel, { key: 'kernel.retention.batchRecord.monthsAfterExpiry', marketSet: ALL, asOf: '2026-01-15' });
    expect(r.value).toBe('12');
    expect(r.governingMarkets).toEqual(['EU', 'IN', 'US']);
    expect(r.floorType).toBe('HARD');
  });

  it('[IN-52] ORDERED takes the highest rank in the ordered list', () => {
    const r = resolve(kernel, { key: 'kernel.auditTrailReview.timing', marketSet: ['IN', 'EU'], asOf: '2026-01-15' });
    expect(r.value).toBe('BEFORE_BATCH_RELEASE');
    expect(r.governingMarkets).toEqual(['IN']);
    expect(r.floorType).toBe('DESIGN');
    expect(r.hardFloor).toBe('PERIODIC');
  });

  it('[IN-52] REQUIRED_IF_ANY is required when any market requires it', () => {
    const inOnly = resolve(kernel, { key: 'kernel.referenceSamples.yearlyVisualExamination', marketSet: ['IN'], asOf: '2026-01-15' });
    expect(inOnly.value).toBe(false);
    const withUs = resolve(kernel, { key: 'kernel.referenceSamples.yearlyVisualExamination', marketSet: ['IN', 'US'], asOf: '2026-01-15' });
    expect(withUs.value).toBe(true);
    expect(withUs.governingMarkets).toEqual(['US']);
  });

  it('[IN-52] SET_UNION returns the union and names the market(s) behind each element', () => {
    const r = resolve(kernel, { key: 'kernel.release.requiredAuthorities', marketSet: ALL, asOf: '2026-01-15' });
    expect(r.value).toEqual(['AUTHORISED_PERSON_RELEASE', 'EU_QP_CERTIFICATION', 'HEAD_OF_QC_APPROVAL', 'QUALITY_UNIT_RECORD_REVIEW']);
    expect(r.components?.map((c) => [c.value, c.markets])).toEqual([
      ['AUTHORISED_PERSON_RELEASE', ['IN']],
      ['EU_QP_CERTIFICATION', ['EU']],
      ['HEAD_OF_QC_APPROVAL', ['IN']],
      ['QUALITY_UNIT_RECORD_REVIEW', ['US']],
    ]);
    expect(resolve(kernel, { key: 'kernel.release.requiredAuthorities', marketSet: ['IN'], asOf: '2026-01-15' }).value).toEqual([
      'AUTHORISED_PERSON_RELEASE',
      'HEAD_OF_QC_APPROVAL',
    ]);
  });

  it('[IN-52] ALL_APPLY keeps every compendial criterion, each with its governing market; all must pass', () => {
    const r = resolve(tablets, { key: 'tablets.uniformity.acceptanceCriteria', marketSet: ALL, asOf: '2026-01-15' });
    expect(r.components?.map((c) => [(c.value as { id: string }).id, c.markets])).toEqual([
      ['IP_UNIFORMITY_OF_WEIGHT_BANDS', ['IN']],
      ['PH_EUR_2_9_40_UNIFORMITY_OF_DOSAGE_UNITS', ['EU']],
      ['USP_905_UNIFORMITY_OF_DOSAGE_UNITS', ['US']],
    ]);
    expect(r.governingMarkets).toEqual(['EU', 'IN', 'US']);
    const inOnly = resolve(tablets, { key: 'tablets.uniformity.acceptanceCriteria', marketSet: ['IN'], asOf: '2026-01-15' });
    expect((inOnly.value as { id: string }[]).map((c) => c.id)).toEqual(['IP_UNIFORMITY_OF_WEIGHT_BANDS']);
  });

  it('[IN-52][INV-28] ALL_APPLY compares criteria by their whole definition: a criterion that keeps its id but changes its content is not at least as strict', () => {
    const ip = { id: 'IP_UNIFORMITY_OF_WEIGHT_BANDS', stage: 'IN_PROCESS', bands: [{ deviationPercent: '10' }, { deviationPercent: '7.5' }] };
    const usp = { id: 'USP_905', plan: 'L1' };
    const weakened = { ...ip, bands: [{ deviationPercent: '50' }] };
    const reordered = { bands: ip.bands, stage: ip.stage, id: ip.id }; // same definition, keys in another order
    expect(isAtLeastAsStrict('ALL_APPLY', null, [ip, usp], [ip])).toBe(true);
    expect(isAtLeastAsStrict('ALL_APPLY', null, [reordered], [ip])).toBe(true);
    expect(isAtLeastAsStrict('ALL_APPLY', null, [weakened, usp], [ip])).toBe(false);
    expect(isAtLeastAsStrict('ALL_APPLY', null, [{ ...ip, bands: [{ deviationPercent: '1' }] }], [ip])).toBe(false);
    expect(isAtLeastAsStrict('ALL_APPLY', null, [usp], [ip])).toBe(false);
    expect(isAtLeastAsStrict('ALL_APPLY', null, [ip], [ip, usp])).toBe(false);
  });

  it('[IN-52][INV-28] the same value: a set (SET_UNION, ALL_APPLY) is the same in any order, criteria compared whole; any other value is the same JSON (isSameValue; lead TODO T9)', () => {
    const ip = { id: 'IP_UNIFORMITY_OF_WEIGHT_BANDS', stage: 'IN_PROCESS', bands: [{ deviationPercent: '10' }, { deviationPercent: '7.5' }] };
    const usp = { id: 'USP_905', plan: 'L1' };
    const ipRewritten = { bands: ip.bands, stage: ip.stage, id: ip.id };
    expect(isSameValue('ALL_APPLY', null, [ip, usp], [usp, ipRewritten])).toBe(true);
    expect(isSameValue('ALL_APPLY', null, [ip, usp], [ip])).toBe(false);
    expect(isSameValue('ALL_APPLY', null, [ip], [ip, usp])).toBe(false);
    expect(isSameValue('ALL_APPLY', null, [{ ...ip, bands: [{ deviationPercent: '50' }] }], [ip])).toBe(false);
    expect(isSameValue('SET_UNION', null, ['A', 'B'], ['B', 'A'])).toBe(true);
    expect(isSameValue('SET_UNION', null, ['A', 'B'], ['A'])).toBe(false);
    expect(isSameValue('SET_UNION', null, ['A'], ['A', 'B'])).toBe(false);
    expect(isSameValue('SMALLER_STRICTER', null, '5', '5')).toBe(true);
    expect(isSameValue('SMALLER_STRICTER', null, '5', '6')).toBe(false);
    expect(isSameValue('LARGER_STRICTER', null, '6', '5')).toBe(false);
    expect(isSameValue('ORDERED', ['LOW', 'HIGH'], 'HIGH', 'HIGH')).toBe(true);
    expect(isSameValue('ORDERED', ['LOW', 'HIGH'], 'HIGH', 'LOW')).toBe(false);
    expect(isSameValue('REQUIRED_IF_ANY', null, true, false)).toBe(false);
    expect(isSameValue('REQUIRED_IF_ANY', null, false, false)).toBe(true);
    expect(() => isSameValue('NOT_COMPARABLE', null, 'A', 'A')).toThrow(/^EBMR-MKT-046 NOT_COMPARABLE values cannot be ranked$/);
  });

  it('[IN-52] a NOT_COMPARABLE key is resolved only by its stated method (per destination, with a decision reference)', () => {
    const req = { key: 'kernel.label.manufacturingDate', marketSet: ALL, asOf: '2026-01-15' };
    expect(() => resolve(kernel, req)).toThrow('EBMR-MKT-046');
    expect(() => resolve(kernel, { ...req, stated: { method: 'PER_DESTINATION', destination: 'US' } })).toThrow('EBMR-MKT-047');
    expect(() => resolve(kernel, { ...req, marketSet: ['IN'], stated: { method: 'PER_DESTINATION', destination: 'US', decisionRef: 'RA-1' } })).toThrow('EBMR-MKT-047');
    const us = resolve(kernel, { ...req, stated: { method: 'PER_DESTINATION', destination: 'US', decisionRef: 'RA-2026-014' } });
    expect(us.value).toBe('NOT_REQUIRED');
    expect(us.governingMarkets).toEqual(['US']);
    expect(us.stated).toEqual({ method: 'PER_DESTINATION', destination: 'US', decisionRef: 'RA-2026-014' });
    const domestic = resolve(kernel, { ...req, stated: { method: 'PER_DESTINATION', destination: 'IN', decisionRef: 'RA-2026-014' } });
    expect(domestic.value).toBe('MANDATORY_UNCODED');
  });

  it('[IN-52] a key India does not govern is simply not applicable when no market in the set has a row', () => {
    const r = resolve(kernel, { key: 'kernel.retention.batchRecord.monthsAfterQpCertification', marketSet: ['IN', 'US'], asOf: '2026-01-15' });
    expect(r.applicable).toBe(false);
    expect(r.value).toBeNull();
    const eu = resolve(kernel, { key: 'kernel.retention.batchRecord.monthsAfterQpCertification', marketSet: ['IN', 'EU'], asOf: '2026-01-15' });
    expect(eu.value).toBe('60');
    expect(eu.governingMarkets).toEqual(['EU']);
  });
});

describe('predicates and effective dates', () => {
  it('[IN-52] the predicate branch is recorded: test-record retention under a Form 25 and a Form 28 licence', () => {
    const base = { key: 'kernel.retention.testRecord.monthsAfterExpiry', marketSet: ['IN'], asOf: '2026-01-15' };
    const f25 = resolve(kernel, { ...base, predicates: { licenceForm: 'FORM_25', expiryLabelled: true } });
    expect(f25.value).toBe('12');
    expect(f25.predicateBranch).toEqual({ IN: {} });
    expect(f25.contributions[0]?.rowRef).toBe('B-01.IN.testRecord.afterExpiry');
    const f28 = resolve(kernel, { ...base, predicates: { licenceForm: 'FORM_28', expiryLabelled: true } });
    expect(f28.value).toBe('24');
    expect(f28.predicateBranch).toEqual({ IN: { licenceForm: 'FORM_28', expiryLabelled: true } });
    expect(f28.contributions[0]?.rowRef).toBe('B-01.IN.testRecord.afterExpiry.form28');
    const mfg = { ...base, key: 'kernel.retention.testRecord.monthsAfterManufacture' };
    expect(resolve(kernel, { ...mfg, predicates: { licenceForm: 'FORM_25', expiryLabelled: true } }).predicateBranch).toEqual({ IN: { licenceForm: 'FORM_25' } });
    expect(resolve(kernel, { ...mfg, predicates: { licenceForm: 'FORM_28', expiryLabelled: false } }).value).toBe('60');
  });

  it('[IN-52] a missing predicate the rows need is refused, never defaulted', () => {
    expect(() => resolve(kernel, { key: 'kernel.retention.testRecord.monthsAfterExpiry', marketSet: ['IN'], asOf: '2026-01-15' })).toThrow('EBMR-MKT-042');
    expect(() =>
      resolve(kernel, { key: 'kernel.retention.testRecord.monthsAfterExpiry', marketSet: ['IN'], asOf: '2026-01-15', predicates: { licenceForm: 'FORM_99', expiryLabelled: true } }),
    ).toThrow('EBMR-MKT-043');
  });

  it('[IN-52] the row in force on the as-of date is used; the effective-to date is exclusive', () => {
    const t = table(
      [{ key: 'kernel.t.window', title: 't', method: 'SMALLER_STRICTER', valueType: 'DECIMAL', unit: 'mo', indiaGoverns: true }],
      [
        row({ ref: 'old', key: 'kernel.t.window', market: 'IN', value: '12', unit: 'mo', effectiveTo: '2026-07-01' }),
        row({ ref: 'new', key: 'kernel.t.window', market: 'IN', value: '6', unit: 'mo', effectiveFrom: '2026-07-01' }),
        row({ ref: 'eu', key: 'kernel.t.window', market: 'EU', value: '9', unit: 'mo', effectiveFrom: '2025-01-01' }),
      ],
    );
    const at = (asOf: string, marketSet = ['IN', 'EU']) => resolve(t, { key: 'kernel.t.window', marketSet, asOf });
    expect(at('2026-06-30').value).toBe('9');
    expect(at('2026-06-30').governingMarkets).toEqual(['EU']);
    expect(at('2026-07-01').value).toBe('6');
    expect(at('2026-07-01').contributions.find((c) => c.market === 'IN')?.rowRef).toBe('new');
    expect(at('2024-12-31', ['IN']).value).toBe('12');
  });

  it('[IN-52][INV-28] a date with no India row for a key India governs is refused (fail closed)', () => {
    expect(() => resolve(kernel, { key: 'kernel.selfInspection.maxIntervalMonths', marketSet: ['IN'], asOf: '2020-01-01' })).toThrow('EBMR-MKT-045');
  });

  it('[INV-28] a market set without India is refused, and so are unknown or repeated markets', () => {
    const req = { key: 'kernel.selfInspection.maxIntervalMonths', asOf: '2026-01-15' };
    expect(() => resolve(kernel, { ...req, marketSet: ['US', 'EU'] })).toThrow('EBMR-MKT-001');
    expect(() => resolve(kernel, { ...req, marketSet: [] })).toThrow('EBMR-MKT-001');
    expect(() => resolve(kernel, { ...req, marketSet: ['IN', 'UK'] })).toThrow('EBMR-MKT-001');
    expect(() => resolve(kernel, { ...req, marketSet: ['IN', 'IN'] })).toThrow('EBMR-MKT-001');
    expect(() => resolve(kernel, { ...req, marketSet: ['IN'], asOf: '2026-02-30' })).toThrow('EBMR-MKT-002');
  });
});

describe('floors and India-first results from table B', () => {
  it('[IN-52][INV-28] a numerically stricter India value wins even for an EU batch (Grade B in operation, 5 micrometre)', () => {
    const r = resolve(sterile, { key: 'sterile.particles.gradeB.inOperation.max5_0um', marketSet: ['IN', 'EU'], asOf: '2026-01-15' });
    expect(r.value).toBe('2900');
    expect(r.governingMarkets).toEqual(['IN']);
  });

  it('[IN-52] the hard floor under a DESIGN value is reported (HEPA A/B: 6 months by design, 12 binding in India)', () => {
    const r = resolve(sterile, { key: 'sterile.hepa.gradeAB.leakTestMaxInterval', marketSet: ['IN'], asOf: '2026-01-15' });
    expect(r.value).toBe('6');
    expect(r.floorType).toBe('DESIGN');
    expect(r.hardFloor).toBe('12');
    const eu = resolve(sterile, { key: 'sterile.hepa.gradeAB.leakTestMaxInterval', marketSet: ['IN', 'EU'], asOf: '2026-01-15' });
    expect(eu.hardFloor).toBe('6');
    expect(eu.floorType).toBe('HARD');
  });

  it('[IN-52] APS acceptance is "any contaminated unit fails" in every profile (Decision 2)', () => {
    for (const marketSet of [['IN'], ['IN', 'US'], ['IN', 'EU'], ALL]) {
      expect(resolve(sterile, { key: 'sterile.aps.acceptance', marketSet, asOf: '2026-01-15' }).value).toBe('ANY_CONTAMINATED_UNIT_FAILS');
    }
  });
});

describe('exact decimals', () => {
  it('[IN-52] decimals compare exactly as scaled integers, never as binary floating point', () => {
    expect(compareDecimal('0.3', '0.30000000000000004')).toBe(-1);
    expect(compareDecimal('7.5', '10')).toBe(-1);
    expect(compareDecimal('3520000', '29300')).toBe(1);
    expect(compareDecimal('-0.5', '0')).toBe(-1);
    expect(compareDecimal('123456789012345678901234567890.1', '123456789012345678901234567890.01')).toBe(1);
    expect(isCanonicalDecimal('7.50')).toBe(false);
    expect(isCanonicalDecimal('07')).toBe(false);
    expect(isCanonicalDecimal('1e3')).toBe(false);
    expect(isCanonicalDecimal('-0')).toBe(false);
    expect(() => compareDecimal('7.50', '1')).toThrow('EBMR-MKT-020');
  });

  it('[IN-52] the validator refuses a JSON number anywhere in a value, including inside ALL_APPLY criteria', () => {
    const doc = seedDocument('tablets');
    const bad = { ...doc, rows: doc.rows.map((r) => (r.ref === 'B-14.IN.ipBands' ? { ...r, value: [{ id: 'IP_BANDS', percent: 5 }] as unknown as RuleRowDoc['value'] } : r)) };
    expect(validateRuleTableDocument(bad).map((p) => p.code)).toContain('EBMR-MKT-020');
  });
});
