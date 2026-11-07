import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addPeriod, siteDate } from '../../src/records/calendar.ts';
import {
  combineEffectiveRetention,
  evaluateOwnRetention,
  normalizeRetentionInputs,
  type OwnRetention,
  type RetentionInputs,
} from '../../src/records/retention.ts';
import { RETENTION_RULE_SET, RETENTION_RULE_SET_2026_1, type RetentionKey, type RetentionRuleSet } from '../../src/records/retention-rules.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

const batch = (inputs: RetentionInputs) => evaluateOwnRetention('BATCH_RECORD', inputs);

describe('retention rules (outline 3.3.6)', () => {
  it('[DI-47] India only, Form 25, 24-month tablet made January 2026: kept five years from manufacture, not expiry plus one year', () => {
    const r = batch({ markets: ['IN'], licenceForm: 'FORM_25', manufactureDate: '2026-01-15', expiryDate: '2028-01-31' });
    expect(r.status).toBe('DATED');
    expect(r.retainUntil).toBe('2031-01-15');
    expect(r.governingRules).toEqual(['IN_FORM25_MANUFACTURE']);
    expect(r.evaluated.find((e) => e.ruleId === 'IN_SCHEDULE_M_EXPIRY')?.date).toBe('2029-01-31');
  });

  it('[DI-47] the same batch for the EU, certified March 2026: five years after QP certification governs', () => {
    const r = batch({ markets: ['IN', 'EU'], licenceForm: 'FORM_25', manufactureDate: '2026-01-15', expiryDate: '2028-01-31', euCertificationDate: '2026-03-10' });
    expect(r.retainUntil).toBe('2031-03-10');
    expect(r.governingRules).toEqual(['EU_QP_CERTIFICATION']);
  });

  it('[DI-47] 24-month shelf life certified 2026-01-10 gives 2031-01-10; with 60 months, expiry plus one year governs', () => {
    const short = batch({ markets: ['IN', 'EU', 'US'], manufactureDate: '2025-12-01', expiryDate: '2027-11-30', euCertificationDate: '2026-01-10' });
    expect(short.retainUntil).toBe('2031-01-10');
    const long = batch({ markets: ['IN', 'EU', 'US'], manufactureDate: '2025-12-01', expiryDate: '2030-11-30', euCertificationDate: '2026-01-10' });
    expect(long.retainUntil).toBe('2031-11-30');
    expect(long.governingRules).toEqual(['EU_EXPIRY', 'IN_SCHEDULE_M_EXPIRY', 'US_EXPIRY']);
  });

  it('[DI-47] an EU batch whose certification date has not been received stays open; the known minimum is still shown', () => {
    const r = batch({ markets: ['IN', 'EU'], manufactureDate: '2026-01-15', expiryDate: '2028-01-31' });
    expect(r.status).toBe('OPEN');
    expect(r.retainUntil).toBeNull();
    expect(r.openReasons).toEqual(['PENDING_EU_CERTIFICATION']);
    expect(r.latestDated).toBe('2029-01-31');
  });

  it('[DI-47] an EU batch never certified: the later of expiry plus one year and disposition plus five years', () => {
    const r = batch({ markets: ['IN', 'EU'], manufactureDate: '2026-01-15', expiryDate: '2028-01-31', euNeverCertified: true, dispositionDate: '2026-06-30' });
    expect(r.retainUntil).toBe('2031-06-30');
    expect(r.governingRules).toEqual(['EU_NEVER_CERTIFIED_DISPOSITION']);
  });

  it('[DI-47] US OTC product exempt from expiry dating: three years after distribution, open until distributed', () => {
    // The product carries no labelled expiry, and says so (a missing expiry date alone is an unknown input: F31).
    const undistributed = batch({ markets: ['IN', 'US'], licenceForm: 'FORM_28', manufactureDate: '2026-01-15', otcExpiryExempt: true, noLabelledExpiry: true });
    expect(undistributed.status).toBe('OPEN');
    expect(undistributed.openReasons).toEqual(['MISSING_INPUT:DISTRIBUTION']);
    const distributed = batch({
      markets: ['IN', 'US'],
      licenceForm: 'FORM_28',
      manufactureDate: '2026-01-15',
      otcExpiryExempt: true,
      noLabelledExpiry: true,
      distributionDate: '2027-02-01',
    });
    expect(distributed.retainUntil).toBe('2031-01-15');
    expect(distributed.evaluated.map((e) => e.ruleId)).toEqual(['IN_FORM28_MANUFACTURE', 'US_OTC_DISTRIBUTION']);
  });

  it('[DI-47][INV-22] Schedule M expiry plus one year applies whenever the product carries an expiry: an unknown expiry date keeps the batch OPEN (F31)', () => {
    // Form 25 without the expiry date: not manufacture + 5 years alone.
    const form25 = batch({ markets: ['IN'], licenceForm: 'FORM_25', manufactureDate: '2026-01-10' });
    expect(form25).toMatchObject({ status: 'OPEN', retainUntil: null, openReasons: ['MISSING_INPUT:EXPIRY'], latestDated: '2031-01-10' });
    expect(form25.evaluated.find((e) => e.ruleId === 'IN_SCHEDULE_M_EXPIRY')).toEqual({ ruleId: 'IN_SCHEDULE_M_EXPIRY', status: 'OPEN', date: null, reason: 'MISSING_INPUT:EXPIRY' });
    // Form 28 without the expiry date: open, not the no-expiry manufacture rule.
    const form28 = batch({ markets: ['IN'], licenceForm: 'FORM_28', manufactureDate: '2026-01-10' });
    expect(form28).toMatchObject({ status: 'OPEN', retainUntil: null, openReasons: ['MISSING_INPUT:EXPIRY'] });
    expect(form28.evaluated.map((e) => e.ruleId)).toEqual(['IN_FORM28_EXPIRY', 'IN_SCHEDULE_M_EXPIRY']);
    // Only the stated fact "no labelled expiry" switches to manufacture + 5 years, and it excludes an expiry date.
    const unlabelled = batch({ markets: ['IN'], licenceForm: 'FORM_28', manufactureDate: '2026-01-10', noLabelledExpiry: true });
    expect(unlabelled).toMatchObject({ status: 'DATED', retainUntil: '2031-01-10', governingRules: ['IN_FORM28_MANUFACTURE'] });
    expect(() => batch({ markets: ['IN'], noLabelledExpiry: true, expiryDate: '2028-01-31' })).toThrow('EBMR-REC-020 a batch without a labelled expiry has no expiry date');
  });

  it('[DI-47] Form 28 licence: test records two years after a labelled expiry', () => {
    const r = batch({ markets: ['IN'], licenceForm: 'FORM_28', manufactureDate: '2026-01-15', expiryDate: '2029-12-31' });
    expect(r.retainUntil).toBe('2031-12-31');
    expect(r.governingRules).toEqual(['IN_FORM28_EXPIRY']);
  });

  it('[DI-47] an aborted batch: the later of nominal expiry plus one year and abort date plus five years; EU pending does not keep it open', () => {
    const r = batch({ markets: ['IN', 'EU'], manufactureDate: '2026-01-15', expiryDate: '2031-01-31', abortCancelDate: '2026-01-20' });
    expect(r.status).toBe('DATED');
    expect(r.retainUntil).toBe('2032-01-31');
    const noNominalExpiry = batch({ markets: ['IN'], manufactureDate: '2026-01-15', abortCancelDate: '2026-01-20' });
    expect(noNominalExpiry.openReasons).toEqual(['MISSING_INPUT:EXPIRY']);
  });

  it('[DI-47] DSCSA records of US batches: six years after the transaction; no rule for an India-only record', () => {
    expect(evaluateOwnRetention('DSCSA_RECORD', { markets: ['IN', 'US'], lastTransactionDate: '2026-05-05' }).retainUntil).toBe('2032-05-05');
    expect(evaluateOwnRetention('DSCSA_RECORD', { markets: ['IN'], lastTransactionDate: '2026-05-05' }).status).toBe('NONE');
  });

  it('[DI-47] EU validation raw data: open while the authorisation is in force', () => {
    expect(evaluateOwnRetention('VALIDATION_RAW_DATA', { markets: ['IN', 'EU'] }).openReasons).toEqual(['MARKETING_AUTHORISATION_IN_FORCE']);
    expect(evaluateOwnRetention('VALIDATION_RAW_DATA', { markets: ['IN', 'EU'], maEndDate: '2040-01-01' }).retainUntil).toBe('2040-01-01');
  });

  it('[DI-47] a market set without India is refused; unknown inputs are refused', () => {
    expect(() => batch({ markets: ['US'], expiryDate: '2028-01-31' })).toThrow('EBMR-REC-020');
    expect(() => batch({ markets: ['IN'], expiry: '2028-01-31' } as unknown as RetentionInputs)).toThrow('EBMR-REC-020 unknown retention input expiry');
    expect(() => batch({ markets: ['IN'], expiryDate: '2028-02-30' })).toThrow('EBMR-REC-020');
  });

  it('[DI-47] calendar arithmetic never shortens a period and uses the site calendar day', () => {
    expect(addPeriod('2024-02-29', 1, 0)).toBe('2025-03-01');
    expect(addPeriod('2028-02-29', 4, 0)).toBe('2032-02-29');
    expect(addPeriod('2027-12-31', 1, 0)).toBe('2028-12-31');
    expect(siteDate(new Date('2026-01-31T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-02-01');
    expect(siteDate(new Date('2026-01-31T20:00:00Z'), 'Europe/Berlin')).toBe('2026-01-31');
  });
});

describe('retention of APIs with a retest date (AS-24)', () => {
  const RETEST = ['EU_GMP_II_RETEST_DISTRIBUTION', 'IN_SCHEDULE_M_RETEST_DISTRIBUTION'];
  const api = { licenceForm: null, manufactureDate: '2026-01-15', expiryDate: '2028-01-31', retestLabelled: true } as const;
  const retestRules = (r: OwnRetention) => r.evaluated.map((e) => e.ruleId).filter((id) => RETEST.includes(id));

  it('[AS-24][DI-47] an India API batch with a retest date shipped on D is kept to the later of expiry plus one year and D plus three years; not shipped it stays OPEN', () => {
    const unshipped = batch({ markets: ['IN'], ...api });
    expect(unshipped).toMatchObject({ status: 'OPEN', retainUntil: null, openReasons: ['MISSING_INPUT:DISTRIBUTION'], latestDated: '2029-01-31' });
    expect(unshipped.governingRules).toEqual(['IN_SCHEDULE_M_RETEST_DISTRIBUTION']);
    // Shipped late: distribution + 3 years governs.
    const late = batch({ markets: ['IN'], ...api, distributionDate: '2027-06-30' });
    expect(late).toMatchObject({ status: 'DATED', retainUntil: '2030-06-30', governingRules: ['IN_SCHEDULE_M_RETEST_DISTRIBUTION'] });
    expect(late.evaluated.find((e) => e.ruleId === 'IN_SCHEDULE_M_EXPIRY')?.date).toBe('2029-01-31');
    // Shipped early: the expiry + 1 year floor still governs.
    const early = batch({ markets: ['IN'], ...api, expiryDate: '2031-01-31', distributionDate: '2026-03-01' });
    expect(early).toMatchObject({ status: 'DATED', retainUntil: '2032-01-31', governingRules: ['IN_SCHEDULE_M_EXPIRY'] });
    expect(early.evaluated.find((e) => e.ruleId === 'IN_SCHEDULE_M_RETEST_DISTRIBUTION')?.date).toBe('2029-03-01');
  });

  it('[AS-24] an India-only API batch gets only the India retest-distribution rule', () => {
    expect(retestRules(batch({ markets: ['IN'], ...api, distributionDate: '2027-06-30' }))).toEqual(['IN_SCHEDULE_M_RETEST_DISTRIBUTION']);
  });

  it('[AS-24] an India and EU API batch gets both the India and the EU retest-distribution rules', () => {
    const r = batch({ markets: ['IN', 'EU'], ...api, euCertificationDate: '2026-02-10', distributionDate: '2028-06-30' });
    expect(retestRules(r)).toEqual(['EU_GMP_II_RETEST_DISTRIBUTION', 'IN_SCHEDULE_M_RETEST_DISTRIBUTION']);
    expect(r).toMatchObject({ status: 'DATED', retainUntil: '2031-06-30', governingRules: ['EU_GMP_II_RETEST_DISTRIBUTION', 'IN_SCHEDULE_M_RETEST_DISTRIBUTION'] });
  });

  it('[AS-24] a US API batch gets no US retest-distribution rule (ICH Q7 is guidance there), only India\'s', () => {
    const r = batch({ markets: ['IN', 'US'], ...api, distributionDate: '2027-06-30' });
    expect(retestRules(r)).toEqual(['IN_SCHEDULE_M_RETEST_DISTRIBUTION']);
    expect(RETENTION_RULE_SET.rules.filter((x) => RETEST.includes(x.ruleId)).map((x) => x.market).sort()).toEqual(['EU', 'IN']);
  });

  it('[AS-24][DI-47] a batch without a retest date is unchanged: for random inputs RET-2026.2 gives what RET-2026.1 gave', () => {
    const without = (r: OwnRetention) => ({ ...r, ruleSetVersion: '' });
    fc.assert(
      fc.property(keyArb, inputsArb, (key, inputs) => {
        const plain = { ...inputs, retestLabelled: false };
        expect(without(evaluateOwnRetention(key, plain))).toEqual(without(evaluateOwnRetention(key, plain, RETENTION_RULE_SET_2026_1)));
      }),
      { numRuns: 400 },
    );
  });
});

describe('retention dependency (pure)', () => {
  const own = (status: OwnRetention['status'], retainUntil: string | null, openReasons: string[] = []): OwnRetention => ({
    ruleSetVersion: 'T',
    status,
    retainUntil,
    latestDated: retainUntil,
    governingRules: [],
    openReasons,
    evaluated: [],
  });

  it('[DI-47][INV-22] a supporting record follows the latest dependant; any open dependant keeps it open', () => {
    const lot = { recordKey: 'component_lot:L1', own: own('NONE', null), hasDependants: true };
    const b1 = { recordKey: 'batch:B1', own: own('DATED', '2028-12-31'), hasDependants: false };
    const b2 = { recordKey: 'batch:B2', own: own('DATED', '2030-06-30'), hasDependants: false };
    expect(combineEffectiveRetention([lot, b1, b2])).toMatchObject({ status: 'DATED', retainUntil: '2030-06-30', governedBy: ['batch:B2'] });
    const b3 = { recordKey: 'batch:B3', own: own('OPEN', null, ['PENDING_EU_CERTIFICATION']), hasDependants: false };
    expect(combineEffectiveRetention([lot, b1, b2, b3])).toMatchObject({
      status: 'OPEN',
      retainUntil: null,
      openBecause: [{ recordKey: 'batch:B3', reasons: ['PENDING_EU_CERTIFICATION'] }],
    });
    // A supporting record nothing depends on (yet) and no own rule: never disposable by default.
    const unused = { ...lot, hasDependants: false };
    expect(combineEffectiveRetention([unused])).toMatchObject({ status: 'OPEN', openBecause: [{ recordKey: 'component_lot:L1', reasons: ['NO_RULE_APPLIES'] }] });
    // Defensive: a closure with no dated record at all is never DATED.
    expect(combineEffectiveRetention([lot])).toMatchObject({ status: 'OPEN', retainUntil: null });
  });

  it('[DI-47][INV-22] a PERMANENT record stays OPEN whatever depends on it (F32)', () => {
    const doc = { recordKey: 'component_lot:DOC', own: own('NONE', null), hasDependants: true, retentionKey: 'PERMANENT' as const };
    const ended = { recordKey: 'batch:OLD', own: own('DATED', '2011-01-31'), hasDependants: false, retentionKey: 'BATCH_RECORD' as const };
    expect(combineEffectiveRetention([doc, ended])).toMatchObject({
      status: 'OPEN',
      retainUntil: null,
      latestDated: '2011-01-31',
      governedBy: [],
      openBecause: [{ recordKey: 'component_lot:DOC', reasons: ['NO_RULE_APPLIES'] }],
    });
    // The same supporting record without the PERMANENT key follows its dependant.
    expect(combineEffectiveRetention([{ ...doc, retentionKey: 'SUPPORTING_RECORD' }, ended])).toMatchObject({ status: 'DATED', retainUntil: '2011-01-31' });
  });
});

// ---------------------------------------------------------------------------------------------
// The TypeScript and SQL copies must agree exactly.
// ---------------------------------------------------------------------------------------------

const dateArb = fc
  .record({ y: fc.integer({ min: 2000, max: 2060 }), m: fc.integer({ min: 1, max: 12 }), d: fc.integer({ min: 1, max: 31 }) })
  .map(({ y, m, d }) => {
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
  });
const maybe = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: null, freq: 3 });

const inputsArb: fc.Arbitrary<RetentionInputs> = fc
  .record({
    markets: fc.subarray(['US', 'EU'] as const).map((m) => ['IN' as const, ...m]),
    licenceForm: fc.constantFrom(null, 'FORM_25' as const, 'FORM_28' as const),
    manufactureDate: maybe(dateArb),
    expiryDate: maybe(dateArb),
    noLabelledExpiry: fc.boolean(),
    otcExpiryExempt: fc.boolean(),
    retestLabelled: fc.boolean(),
    distributionDate: maybe(dateArb),
    euCertificationDate: maybe(dateArb),
    euNeverCertified: fc.boolean(),
    dispositionDate: maybe(dateArb),
    abortCancelDate: maybe(dateArb),
    lastTransactionDate: maybe(dateArb),
    maEndDate: maybe(dateArb),
  })
  .map((r) => ({
    ...r,
    // Keep only combinations both copies accept (invalid ones are refused identically, tested below).
    euNeverCertified: r.euCertificationDate === null ? r.euNeverCertified : false,
    expiryDate: r.noLabelledExpiry || (r.expiryDate !== null && r.manufactureDate !== null && r.expiryDate < r.manufactureDate) ? null : r.expiryDate,
  }));
const keyArb = fc.constantFrom<RetentionKey>('BATCH_RECORD', 'SUPPORTING_RECORD', 'DSCSA_RECORD', 'VALIDATION_RAW_DATA', 'PERMANENT');

async function sqlEvaluate(key: RetentionKey, inputs: RetentionInputs, version: string | null = null): Promise<OwnRetention> {
  const { rows } = await db.app.query<{ r: OwnRetention }>(
    `select records.evaluate_retention(records.normalize_retention_inputs($1::jsonb) || jsonb_build_object('retentionKey', $2::text), $3) as r`,
    [JSON.stringify(inputs), key, version],
  );
  return rows[0]?.r as OwnRetention;
}

const sortedRules = (set: RetentionRuleSet) => [...set.rules].sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1));
async function dbRules(version: string) {
  const { rows } = await db.app.query<{
    rule_id: string; proposed_rule_key: string; retention_keys: string[]; market: string | null; predicate: Record<string, unknown>; anchor: string;
    period_years: number; period_months: number; open_reason: string | null; source: string; verification: string;
  }>('select * from records.retention_rule where rule_set_version = $1 order by rule_id collate "C"', [version]);
  return rows.map((r) => ({
    ruleId: r.rule_id, proposedRuleKey: r.proposed_rule_key, retentionKeys: r.retention_keys, market: r.market, predicate: r.predicate, anchor: r.anchor,
    period: { years: r.period_years, months: r.period_months }, openReason: r.open_reason, source: r.source, verification: r.verification,
  }));
}

describe('TypeScript and SQL retention agree', () => {
  it('[AS-24][DI-47] rule set RET-2026.1 is kept as published, and RET-2026.2 (current) is it plus the India and EU retest-distribution rows', async () => {
    expect(await dbRules(RETENTION_RULE_SET_2026_1.version)).toEqual(sortedRules(RETENTION_RULE_SET_2026_1));
    expect(await dbRules(RETENTION_RULE_SET.version)).toEqual(sortedRules(RETENTION_RULE_SET));
    const added = RETENTION_RULE_SET.rules.filter((r) => !RETENTION_RULE_SET_2026_1.rules.some((o) => o.ruleId === r.ruleId)).map((r) => r.ruleId);
    expect(added.sort()).toEqual(['EU_GMP_II_RETEST_DISTRIBUTION', 'IN_SCHEDULE_M_RETEST_DISTRIBUTION']);
    expect(RETENTION_RULE_SET.rules.slice(0, RETENTION_RULE_SET_2026_1.rules.length)).toEqual(RETENTION_RULE_SET_2026_1.rules);
    // Both rows came in under configuration change control as release versions (kernel 1196).
    const { rows } = await db.admin.query<{ item_key: string; basis: string }>(
      "select item_key, basis from platform.config_version where area = 'RETENTION_RULE' and source_row ->> 'rule_set_version' = 'RET-2026.2' and source_row ->> 'rule_id' like '%RETEST%' order by item_key",
    );
    expect(rows.map((r) => r.basis)).toEqual(['RELEASE', 'RELEASE']);
  });

  it('[AS-24][DI-47] for random inputs the SQL evaluation under RET-2026.1 still equals the TypeScript RET-2026.1 evaluation', async () => {
    await fc.assert(
      fc.asyncProperty(keyArb, inputsArb, async (key, inputs) => {
        expect(await sqlEvaluate(key, inputs, RETENTION_RULE_SET_2026_1.version)).toEqual(evaluateOwnRetention(key, inputs, RETENTION_RULE_SET_2026_1));
      }),
      { numRuns: 100 },
    );
  });

  it('[AS-24][DI-47] inputs stored before RET-2026.2 normalise to themselves: retestLabelled is written only when true, and only true or false is accepted', async () => {
    const norm = async (p: unknown) => (await db.app.query<{ n: Record<string, unknown> }>('select records.normalize_retention_inputs($1::jsonb) as n', [JSON.stringify(p)])).rows[0]?.n;
    const stored = await norm({ markets: ['IN', 'EU'], licenceForm: 'FORM_25', manufactureDate: '2026-01-15', expiryDate: '2028-01-31' });
    expect(stored).not.toHaveProperty('retestLabelled');
    expect(await norm(stored)).toEqual(stored);
    expect(await norm({ ...stored, retestLabelled: false })).toEqual(stored);
    expect(await norm({ ...stored, retestLabelled: true })).toEqual({ ...stored, retestLabelled: true });
    expect(normalizeRetentionInputs({ markets: ['IN'], retestLabelled: false })).not.toHaveProperty('retestLabelled');
    expect(normalizeRetentionInputs({ markets: ['IN'], retestLabelled: true })).toMatchObject({ retestLabelled: true });
    const bad = { markets: ['IN'], retestLabelled: 'yes' } as unknown as RetentionInputs;
    expect(() => normalizeRetentionInputs(bad)).toThrow('EBMR-REC-020 retestLabelled must be true or false');
    await expect(norm(bad)).rejects.toThrow('EBMR-REC-020 retestLabelled must be true or false');
  });

  it('[DI-47] the rule parameters in TypeScript and in records.retention_rule are identical', async () => {
    const { rows } = await db.app.query<{
      rule_id: string;
      proposed_rule_key: string;
      retention_keys: string[];
      market: string | null;
      predicate: Record<string, unknown>;
      anchor: string;
      period_years: number;
      period_months: number;
      open_reason: string | null;
      source: string;
      verification: string;
    }>('select * from records.retention_rule where rule_set_version = $1 order by rule_id', [RETENTION_RULE_SET.version]);
    const fromDb = rows.map((r) => ({
      ruleId: r.rule_id,
      proposedRuleKey: r.proposed_rule_key,
      retentionKeys: r.retention_keys,
      market: r.market,
      predicate: r.predicate,
      anchor: r.anchor,
      period: { years: r.period_years, months: r.period_months },
      openReason: r.open_reason,
      source: r.source,
      verification: r.verification,
    }));
    const fromTs = [...RETENTION_RULE_SET.rules].sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1));
    expect(fromDb).toEqual(fromTs);
    expect(await db.app.query<{ v: string }>('select records.current_retention_rule_set() as v').then((r) => r.rows[0]?.v)).toBe(RETENTION_RULE_SET.version);
  });

  it('[DI-47][INV-22] for random inputs the SQL evaluation (authoritative for purge) equals the TypeScript evaluation', async () => {
    await fc.assert(
      fc.asyncProperty(keyArb, inputsArb, async (key, inputs) => {
        expect(await sqlEvaluate(key, inputs)).toEqual(evaluateOwnRetention(key, inputs));
      }),
      { numRuns: 400 },
    );
  });

  it('[DI-47] both copies normalise inputs identically and refuse the same invalid inputs', async () => {
    await fc.assert(
      fc.asyncProperty(inputsArb, async (inputs) => {
        const { rows } = await db.app.query<{ n: unknown }>('select records.normalize_retention_inputs($1::jsonb) as n', [JSON.stringify(inputs)]);
        expect(rows[0]?.n).toEqual(normalizeRetentionInputs(inputs));
      }),
      { numRuns: 100 },
    );
    const invalid: RetentionInputs[] = [
      { markets: ['US'] },
      { markets: ['IN'], euCertificationDate: '2026-01-01', euNeverCertified: true },
      { markets: ['IN'], manufactureDate: '2026-02-01', expiryDate: '2026-01-01' },
      { markets: ['IN'], expiryDate: '2026-13-01' },
      { markets: ['IN'], noLabelledExpiry: true, expiryDate: '2027-01-31' },
    ];
    for (const inputs of invalid) {
      expect(() => normalizeRetentionInputs(inputs)).toThrow('EBMR-REC-020');
      await expect(db.app.query('select records.normalize_retention_inputs($1::jsonb)', [JSON.stringify(inputs)])).rejects.toThrow('EBMR-REC-020');
    }
  });

  it('[DI-47] SQL and TypeScript calendar arithmetic agree, including month ends and 29 February', async () => {
    await fc.assert(
      fc.asyncProperty(dateArb, fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 11 }), async (d, y, m) => {
        const { rows } = await db.app.query<{ r: string }>(`select to_char(records.add_period($1::date, $2, $3), 'YYYY-MM-DD') as r`, [d, y, m]);
        expect(rows[0]?.r).toBe(addPeriod(d, y, m));
      }),
      { numRuns: 300 },
    );
  });

  it('[DI-47] adding a market never shortens retention (tenants and markets can only lengthen it)', () => {
    fc.assert(
      fc.property(inputsArb, (inputs) => {
        const base = batch({ ...inputs, markets: ['IN'] });
        const wider = batch(inputs);
        if (base.status === 'DATED' && wider.status === 'DATED') expect((wider.retainUntil as string) >= (base.retainUntil as string)).toBe(true);
        if (base.status === 'OPEN') expect(wider.status).toBe('OPEN');
      }),
      { numRuns: 500 },
    );
  });
});
