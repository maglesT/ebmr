/**
 * Batch retention keys (Phase 4 slice 6b; kernel 1172 and the retention engine of kernel 0420/0440; IN-08, PR-59, DI-47,
 * DI-46; default D-6-5). The batch facts go through batchRetentionInputs into the database engine as the application role;
 * deletion requests are answered and logged by records.request_disposal, which deletes nothing.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { batchRetentionInputs, requestDisposal, type BatchRetentionFacts } from '../../src/records/batch-retention.ts';
import { createRetentionSchedule, linkRetentionDependency, retentionOf, updateRetentionInputs } from '../../src/records/retention-store.ts';
import { expectPermissionDenied, expectRefused } from '../identity/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { again, createStubTables, insertEntry, recordType, registerType, testActor } from './helpers.ts';

let db: TestDatabase;
let operator: ActorContext;
let qa: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  await createStubTables(db);
  await registerType(db, recordType('BATCH_RECORD_6B'));
  operator = await testActor(db, { roleCode: 'OPERATOR' });
  qa = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'QA Reviewer' });
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const base: BatchRetentionFacts = {
  markets: ['IN'], licenceForm: 'FORM_25', manufactureDate: '2026-01-15', expiryDate: '2027-12-31', outcome: 'COMPLETED', abortCancelDate: null, eu: null,
};

async function scheduled(facts: BatchRetentionFacts): Promise<string> {
  const batch = randomUUID();
  await insertEntry(db, operator, batch, '1.000');
  await withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'batch', batch, 'BATCH_RECORD_6B', batchRetentionInputs(facts)));
  return batch;
}

const effective = async (batch: string) => (await retentionOf(db.app, 'batch', batch)).effective;
const rules = async (batch: string): Promise<string[]> => (await retentionOf(db.app, 'batch', batch)).own.governingRules;

describe('batch retention keys (D-6-5)', () => {
  it('[IN-08] a 24-month tablet made in January 2026 for India only is kept to January 2031 (five years from manufacture beat expiry + 1 year)', async () => {
    const batch = await scheduled(base);
    const e = await effective(batch);
    expect(e.status).toBe('DATED');
    expect(e.retainUntil).toBe('2031-01-15');
    expect(await rules(batch)).toContain('IN_FORM25_MANUFACTURE');
  });

  it('[IN-08] the same batch for the EU, certified in March 2026, is kept to March 2031; before the certification it is open', async () => {
    const batch = await scheduled({ ...base, markets: ['IN', 'EU'], eu: { state: 'PENDING' } });
    expect((await effective(batch)).status).toBe('OPEN');
    await withCommand(db.app, again(qa), (c) => updateRetentionInputs(c, `batch:${batch}`, { euCertificationDate: '2026-03-20' }, 'QP certification received'));
    const e = await effective(batch);
    expect(e.retainUntil).toBe('2031-03-20');
    expect(await rules(batch)).toContain('EU_QP_CERTIFICATION');
  });

  it('[PR-59] a 24-month batch certified on 2026-01-10 is kept to 2031-01-10; with a 60-month shelf life expiry + 1 year governs', async () => {
    const short = await scheduled({ ...base, licenceForm: null, manufactureDate: '2025-12-01', expiryDate: '2027-11-30', markets: ['IN', 'EU'], eu: { state: 'CERTIFIED', date: '2026-01-10' } });
    expect((await effective(short)).retainUntil).toBe('2031-01-10');
    const long = await scheduled({ ...base, licenceForm: null, manufactureDate: '2025-12-01', expiryDate: '2030-11-30', markets: ['IN', 'EU'], eu: { state: 'CERTIFIED', date: '2026-01-10' } });
    const e = await effective(long);
    expect(e.retainUntil).toBe('2031-11-30');
    expect((await rules(long)).some((r) => r.endsWith('EXPIRY'))).toBe(true);
  });

  it('[PR-59][DI-47] deleting a batch before its date is refused and logged; the request deletes nothing', async () => {
    const batch = await scheduled(base);
    const answer = await withCommand(db.app, again(qa), (c) => requestDisposal(c, 'batch', batch, 'space on the archive server'));
    expect(answer.outcome).toBe('REFUSED');
    expect(answer.retainUntil).toBe('2031-01-15');
    expect(answer.refusals.map((r) => r.code)).toContain('EBMR-REC-031');
    const { rows } = await db.app.query<{ outcome: string; reason: string }>('select outcome, reason from records.disposal_request where record_key = $1', [`batch:${batch}`]);
    expect(rows).toEqual([{ outcome: 'REFUSED', reason: 'space on the archive server' }]);
    const left = await db.app.query<{ n: number }>('select count(*)::int as n from stub_b4.batch_entry where batch_id = $1', [batch]);
    expect(left.rows[0]?.n).toBe(1);
    const unknown = await withCommand(db.app, again(qa), (c) => requestDisposal(c, 'batch', randomUUID(), 'tidy up'));
    expect(unknown.outcome).toBe('REFUSED');
    expect(unknown.refusals[0]?.code).toBe('EBMR-REC-021');
    await expectRefused(withCommand(db.app, again(qa), (c) => requestDisposal(c, 'batch', batch, ' ')), 'EBMR-REC-130');
    await expectRefused(withCommand(db.app, again(operator), (c) => requestDisposal(c, 'batch', batch, 'x')), 'EBMR-IAM-040');
    await expectPermissionDenied(db.app.query("insert into records.disposal_request (record_key, outcome, refusals, reason, person_id, account_id, correlation_id) values ('batch:x', 'ELIGIBLE', '[]', 'r', $1, $1, $1)", [randomUUID()]));
  });

  it('[DI-47] an EU batch finally rejected is no longer open: kept for the later of expiry + 1 year and the disposition + 5 years', async () => {
    const batch = await scheduled({ ...base, licenceForm: null, markets: ['IN', 'EU'], eu: { state: 'FINALLY_REJECTED', date: '2026-06-30' } });
    const e = await effective(batch);
    expect(e.status).toBe('DATED');
    expect(e.retainUntil).toBe('2031-06-30');
  });

  it('[DI-47][DI-46] an aborted batch is kept like a completed one, and the record a kept batch depends on inherits the longer period', async () => {
    const aborted = await scheduled({ ...base, outcome: 'ABORTED', abortCancelDate: '2026-02-01' });
    const a = await effective(aborted);
    expect(a.status).toBe('DATED');
    expect(a.retainUntil! >= '2031-01-15').toBe(true);
    // The processing record supports a packaging record certified later: it follows the packaging record.
    const processing = await scheduled(base);
    const packaging = await scheduled({ ...base, licenceForm: null, markets: ['IN', 'EU'], eu: { state: 'CERTIFIED', date: '2026-09-01' } });
    await withCommand(db.app, again(qa), (c) => linkRetentionDependency(c, `batch:${processing}`, `batch:${packaging}`, 'BULK_PACKED_INTO'));
    expect((await effective(processing)).retainUntil).toBe('2031-09-01');
  });

  it('[IN-08] the batch inputs always carry India, and only an EU batch carries its certification or final rejection', () => {
    expect(batchRetentionInputs({ ...base, markets: ['US'] }).markets).toEqual(['IN', 'US']);
    expect(batchRetentionInputs({ ...base, eu: { state: 'CERTIFIED', date: '2026-03-01' } }).euCertificationDate).toBeUndefined();
    expect(batchRetentionInputs({ ...base, markets: ['EU'], eu: { state: 'FINALLY_REJECTED', date: '2026-03-01' } })).toMatchObject({ euNeverCertified: true, dispositionDate: '2026-03-01' });
    expect(batchRetentionInputs({ ...base, outcome: 'CANCELLED', abortCancelDate: '2026-01-20' }).abortCancelDate).toBe('2026-01-20');
    expect(batchRetentionInputs(base).abortCancelDate).toBeUndefined();
  });

  it('[AS-24] only a retest-dated batch carries the retest flag and, once shipped, its distribution date; any other batch\'s inputs are as before', () => {
    expect(batchRetentionInputs({ ...base, retestLabelled: true })).toMatchObject({ retestLabelled: true });
    expect(batchRetentionInputs({ ...base, retestLabelled: true }).distributionDate).toBeUndefined();
    expect(batchRetentionInputs({ ...base, retestLabelled: true, distributionDate: '2026-05-04' })).toMatchObject({ retestLabelled: true, distributionDate: '2026-05-04' });
    expect(batchRetentionInputs({ ...base, retestLabelled: false, distributionDate: '2026-05-04' })).toEqual(batchRetentionInputs(base));
    expect(Object.keys(batchRetentionInputs({ ...base, distributionDate: '2026-05-04' })).sort()).toEqual(['expiryDate', 'licenceForm', 'manufactureDate', 'markets']);
  });

  it('[AS-24][DI-47] a retest-dated India API batch stays OPEN until it ships, then is kept to the later of expiry + 1 year and shipment + 3 years; re-sending the same facts adds no input version', async () => {
    const api: BatchRetentionFacts = { ...base, licenceForm: null, expiryDate: '2028-01-31', retestLabelled: true };
    const batch = await scheduled(api);
    expect(await effective(batch)).toMatchObject({ status: 'OPEN', openBecause: [{ recordKey: `batch:${batch}`, reasons: ['MISSING_INPUT:DISTRIBUTION'] }] });
    await withCommand(db.app, again(qa), (c) => updateRetentionInputs(c, `batch:${batch}`, batchRetentionInputs({ ...api, distributionDate: '2027-06-30' }), 'batch shipped'));
    expect(await effective(batch)).toMatchObject({ status: 'DATED', retainUntil: '2030-06-30' });
    expect(await rules(batch)).toEqual(['IN_SCHEDULE_M_RETEST_DISTRIBUTION']);
    const versions = async () => (await db.admin.query<{ n: number }>('select max(input_version)::int as n from records.retention_input where record_key = $1', [`batch:${batch}`])).rows[0]?.n;
    expect(await versions()).toBe(2);
    await withCommand(db.app, again(qa), (c) => updateRetentionInputs(c, `batch:${batch}`, batchRetentionInputs({ ...api, distributionDate: '2027-06-30' }), 'sync again'));
    expect(await versions()).toBe(2);
  });

  it('[AS-24][DI-47] a batch without a retest date keeps its stored inputs and its date: no new input version, the same retain-until as under RET-2026.1', async () => {
    const batch = await scheduled(base);
    const stored = (await db.admin.query<{ i: Record<string, unknown> }>('select inputs as i from records.retention_input where record_key = $1', [`batch:${batch}`])).rows[0]?.i;
    expect(stored).not.toHaveProperty('retestLabelled');
    await withCommand(db.app, again(qa), (c) => updateRetentionInputs(c, `batch:${batch}`, batchRetentionInputs({ ...base, distributionDate: '2026-05-04' }), 'sync after shipment'));
    expect((await db.admin.query<{ n: number }>('select count(*)::int as n from records.retention_input where record_key = $1', [`batch:${batch}`])).rows[0]?.n).toBe(1);
    const old = (await db.admin.query<{ r: { retainUntil: string } }>(
      "select records.evaluate_retention(inputs || '{\"retentionKey\": \"BATCH_RECORD\"}', 'RET-2026.1') as r from records.retention_input where record_key = $1", [`batch:${batch}`])).rows[0]?.r;
    expect((await effective(batch)).retainUntil).toBe(old?.retainUntil);
    expect(old?.retainUntil).toBe('2031-01-15');
  });
});
