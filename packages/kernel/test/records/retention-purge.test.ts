import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../../src/audit/verify.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import type { RetentionInputs } from '../../src/records/retention.ts';
import {
  approvePurge,
  createRetentionSchedule,
  inv22Violations,
  linkRetentionDependency,
  openBlockers,
  placeLegalHold,
  purge,
  releaseLegalHold,
  retentionOf,
  updateRetentionInputs,
  verifyAnchorPurgeAware,
  verifyChainPurgeAware,
} from '../../src/records/retention-store.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { again, correctEntry, createStubTables, insertEntry, insertReading, recordType, registerType, scalar, testActor, withReason } from './helpers.ts';

let db: TestDatabase;
let operator: ActorContext;
let qa: ActorContext;
let qa2: ActorContext;
let retentionJob: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  await createStubTables(db);
  await registerType(db, recordType('BATCH_PROCESSING_RECORD'));
  await registerType(db, recordType('COMPONENT_LOT_RECORD', { retentionKey: 'SUPPORTING_RECORD' }));
  operator = await testActor(db, { roleCode: 'OPERATOR' });
  qa = await testActor(db, { roleCode: 'QA', legalName: 'QA Reviewer' });
  qa2 = await testActor(db, { roleCode: 'QA', legalName: 'QA Manager' });
  retentionJob = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'retention job' });
});
afterAll(async () => {
  await db.drop();
});

/** A batch with one corrected entry and one insert-only reading, plus its retention schedule. */
async function batchWithRecords(inputs: RetentionInputs): Promise<string> {
  const batch = randomUUID();
  const entry = await insertEntry(db, operator, batch, '12.503');
  await correctEntry(db, operator, entry, '12.530');
  await insertReading(db, operator, batch, '7.10');
  await withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'batch', batch, 'BATCH_PROCESSING_RECORD', inputs));
  return batch;
}

const PAST_BATCH: RetentionInputs = { markets: ['IN', 'US'], manufactureDate: '2008-01-10', expiryDate: '2010-01-31' };
const FUTURE_BATCH: RetentionInputs = { markets: ['IN', 'US'], manufactureDate: '2026-01-10', expiryDate: '2028-01-31' };

/** Violations about this module's objects (other modules' grants are reported, not asserted here). */
const mine = (v: { check: string; detail: string }) => v.check !== 'APP_CAN_DELETE_GMP_ROWS' || /^(records|stub_b4)\./.test(v.detail);

const approve = (key: string) => withCommand(db.app, again(qa2), (c) => approvePurge(c, key, randomUUID(), 'retention ended; archived true copy verified'));
const runPurge = (key: string) => withCommand(db.app, withReason(retentionJob, 'RETENTION_ENDED', 'approved disposal'), (c) => purge(c, key));

describe('DI-47 retention end and deletion', () => {
  it('[DI-47][INV-22] deleting a batch record before its retention end is blocked: no direct delete, no approval, no purge', async () => {
    const batch = await batchWithRecords(FUTURE_BATCH);
    await expect(withCommand(db.app, withReason(operator, 'MISTAKE'), (c) => c.query('delete from stub_b4.batch_entry where batch_id = $1', [batch]))).rejects.toThrow(
      /permission denied/,
    );
    await expect(approve(`batch:${batch}`)).rejects.toThrow(/EBMR-REC-031 batch:.* must be kept until 2029-01-31/);
    await expect(runPurge(`batch:${batch}`)).rejects.toThrow('EBMR-REC-031');
    expect(await scalar<string>(db.app, 'select count(*)::text as v from stub_b4.batch_entry where batch_id = $1', [batch])).toBe('1');
    const status = await retentionOf(db.app, 'batch', batch);
    expect(status.effective).toMatchObject({ status: 'DATED', retainUntil: '2029-01-31', governedBy: [`batch:${batch}`] });
    expect(status.refusals.map((r) => r.code)).toEqual(['EBMR-REC-031']);
  });

  it('[DI-47][INV-22] a component lot used in two batches with different expiries follows the later one, and moves when a dependant changes', async () => {
    const b1 = randomUUID();
    const b2 = randomUUID();
    const lot = randomUUID();
    await withCommand(db.app, again(qa), async (c) => {
      await createRetentionSchedule(c, 'batch', b1, 'BATCH_PROCESSING_RECORD', { markets: ['IN', 'US'], manufactureDate: '2026-01-10', expiryDate: '2027-12-31' });
      await createRetentionSchedule(c, 'batch', b2, 'BATCH_PROCESSING_RECORD', { markets: ['IN'], manufactureDate: '2026-02-10', expiryDate: '2029-06-30' });
      await createRetentionSchedule(c, 'component_lot', lot, 'COMPONENT_LOT_RECORD', { markets: ['IN'] });
    });
    // Not used yet: nothing gives it a date, so it is kept (never disposable by default).
    expect((await retentionOf(db.app, 'component_lot', lot)).effective).toMatchObject({ status: 'OPEN', openBecause: [{ reasons: ['NO_RULE_APPLIES'] }] });
    await withCommand(db.app, again(qa), async (c) => {
      await linkRetentionDependency(c, `component_lot:${lot}`, `batch:${b1}`, 'COMPONENT_LOT_CONSUMED');
      await linkRetentionDependency(c, `component_lot:${lot}`, `batch:${b2}`, 'COMPONENT_LOT_CONSUMED');
    });
    expect((await retentionOf(db.app, 'component_lot', lot)).effective).toMatchObject({ status: 'DATED', retainUntil: '2030-06-30', governedBy: [`batch:${b2}`] });

    // The first batch's expiry is corrected to later than the second: the lot follows it, and the
    // stored evaluation of the lot was refreshed in the same transaction.
    await withCommand(db.app, again(qa), (c) => updateRetentionInputs(c, `batch:${b1}`, { expiryDate: '2030-12-31' }, 'expiry corrected after stability data'));
    expect((await retentionOf(db.app, 'component_lot', lot)).effective).toMatchObject({ retainUntil: '2031-12-31', governedBy: [`batch:${b1}`] });
    const { rows } = await db.app.query<{ effective_retain_until: string; cause: string }>(
      "select to_char(e.effective_retain_until, 'YYYY-MM-DD') as effective_retain_until, e.cause from records.retention_evaluation e where e.record_key = $1 order by e.id",
      [`component_lot:${lot}`],
    );
    expect(rows.map((r) => [r.effective_retain_until, r.cause])).toEqual([
      [null, 'CREATED'],
      ['2028-12-31', 'DEPENDENCY_LINKED'],
      ['2030-06-30', 'DEPENDENCY_LINKED'],
      ['2031-12-31', 'DEPENDANT_CHANGED'],
    ]);
    // A cycle is refused.
    await expect(withCommand(db.app, again(qa), (c) => linkRetentionDependency(c, `batch:${b1}`, `component_lot:${lot}`, 'X'))).rejects.toThrow('EBMR-REC-022');
  });

  it('[DI-47] an EU batch whose certification date has not been received shows retention "open" until the date arrives', async () => {
    const batch = randomUUID();
    await withCommand(db.app, again(qa), (c) =>
      createRetentionSchedule(c, 'batch', batch, 'BATCH_PROCESSING_RECORD', { markets: ['IN', 'EU'], manufactureDate: '2026-01-15', expiryDate: '2028-01-31' }),
    );
    const { rows } = await db.app.query<{ effective_status: string; effective_retain_until: string | null; effective: { openBecause: unknown } }>(
      'select effective_status, effective_retain_until, effective from records.retention_current where record_key = $1',
      [`batch:${batch}`],
    );
    expect(rows[0]).toMatchObject({ effective_status: 'OPEN', effective_retain_until: null });
    expect(rows[0]?.effective.openBecause).toEqual([{ recordKey: `batch:${batch}`, reasons: ['PENDING_EU_CERTIFICATION'] }]);
    await expect(approve(`batch:${batch}`)).rejects.toThrow('EBMR-REC-030');
    const after = await withCommand(db.app, again(qa), (c) =>
      updateRetentionInputs(c, `batch:${batch}`, { euCertificationDate: '2026-03-10' }, 'QP certification message received'),
    );
    expect(after).toMatchObject({ status: 'DATED', retainUntil: '2031-03-10' });
  });

  it('[DI-47] retention inputs are validated (India always in the market set) and every change needs a reason', async () => {
    const batch = randomUUID();
    await expect(
      withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'batch', batch, 'BATCH_PROCESSING_RECORD', { markets: ['US'], expiryDate: '2028-01-31' })),
    ).rejects.toThrow('EBMR-REC-020');
    await expect(withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'batch', batch, 'NOT_A_TYPE', FUTURE_BATCH))).rejects.toThrow('EBMR-REC-013');
    await withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'batch', batch, 'BATCH_PROCESSING_RECORD', FUTURE_BATCH));
    await expect(withCommand(db.app, again(qa), (c) => updateRetentionInputs(c, `batch:${batch}`, { expiryDate: '2029-01-31' }, ' '))).rejects.toThrow('EBMR-REC-020');
  });
});

describe('holds', () => {
  it('[DI-47][INV-22] a legal hold blocks approval and purge after retention ended; releasing it allows disposal', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    const hold = await withCommand(db.app, again(qa), (c) => placeLegalHold(c, 'batch', batch, 'product liability claim', 'LEGAL-2026-07'));
    expect((await openBlockers(db.app, 'batch', batch)).map((b) => [b.kind, b.blocksDisposition, b.blocksDisposal])).toEqual([['HOLD', false, true]]);
    await expect(approve(key)).rejects.toThrow('EBMR-REC-032');
    await expect(withCommand(db.app, again(retentionJob), (c) => releaseLegalHold(c, hold, 'claim settled'))).rejects.toThrow('EBMR-REC-040');
    await withCommand(db.app, again(qa), (c) => releaseLegalHold(c, hold, 'claim settled'));
    await expect(withCommand(db.app, again(qa), (c) => releaseLegalHold(c, hold, 'again'))).rejects.toThrow('EBMR-REC-040');
    await approve(key);
    await runPurge(key);
    // The hold and its release stay (insert-only), and the invariant query sees no purge under hold.
    expect(await scalar<string>(db.app, 'select count(*)::text as v from records.retention_hold_release where hold_id = $1', [hold])).toBe('1');
    expect((await inv22Violations(db.app)).filter((v) => v.check === 'PURGED_WHILE_ON_HOLD')).toEqual([]);
  });

  it('[INV-22] a hold on a dependant keeps the supporting record too; a supporting record is never purged before its dependants retain-until', async () => {
    const lot = randomUUID();
    const oldBatch = await batchWithRecords(PAST_BATCH);
    const currentBatch = randomUUID();
    await withCommand(db.app, again(operator), (c) => c.query("insert into stub_b4.lot_record (lot_id, note) values ($1, 'received')", [lot]));
    await withCommand(db.app, again(qa), async (c) => {
      await createRetentionSchedule(c, 'component_lot', lot, 'COMPONENT_LOT_RECORD', { markets: ['IN'] });
      await createRetentionSchedule(c, 'batch', currentBatch, 'BATCH_PROCESSING_RECORD', FUTURE_BATCH);
      await linkRetentionDependency(c, `component_lot:${lot}`, `batch:${oldBatch}`, 'COMPONENT_LOT_CONSUMED');
    });
    const hold = await withCommand(db.app, again(qa), (c) => placeLegalHold(c, 'batch', oldBatch, 'regulatory inspection request'));
    await expect(approve(`component_lot:${lot}`)).rejects.toThrow(new RegExp(`EBMR-REC-032 HOLD .* of dependant batch:${oldBatch}`));
    await withCommand(db.app, again(qa), (c) => releaseLegalHold(c, hold, 'inspection closed'));
    await withCommand(db.app, again(qa), (c) => linkRetentionDependency(c, `component_lot:${lot}`, `batch:${currentBatch}`, 'COMPONENT_LOT_CONSUMED'));
    await expect(approve(`component_lot:${lot}`)).rejects.toThrow(new RegExp(`EBMR-REC-031 component_lot:${lot} must be kept until 2029-01-31.*batch:${currentBatch}`));
    await expect(runPurge(`component_lot:${lot}`)).rejects.toThrow('EBMR-REC-031');
  });

  it('[DI-47] placing and releasing a hold is written into the held record audit trail', async () => {
    const batch = randomUUID();
    const hold = await withCommand(db.app, again(qa), (c) => placeLegalHold(c, 'batch', batch, 'litigation hold'));
    await withCommand(db.app, again(qa), (c) => releaseLegalHold(c, hold, 'litigation ended'));
    const { rows } = await db.app.query<{ message: string }>(
      "select payload -> 'body' ->> 'message' as message from kernel.audit_event where chain_key = $1 and action = 'BUSINESS' order by seq",
      [`batch:${batch}`],
    );
    expect(rows.map((r) => r.message)).toEqual(['legal hold placed: litigation hold', 'legal hold released: litigation ended']);
  });
});

describe('controlled purge', () => {
  it('[INV-22][DI-47] purge after retain-until leaves a tombstone and a checkpoint, removes rows and chain, and every other chain still verifies', async () => {
    const other = await batchWithRecords(FUTURE_BATCH);
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    await withCommand(db.app, again(operator), (c) => c.query("select kernel.audit_business_event($1, 'weighing recorded, 12.503 kg')", [key]));
    const eventsBefore = await db.app.query<{ seq: string; hash: Buffer }>('select seq::text as seq, hash from kernel.audit_event where chain_key = $1 order by seq', [key]);
    const anchorId = await scalar<string>(db.app, 'select kernel.create_anchor()::text as v');

    // Without approval, and without a reason, purge is refused.
    await expect(runPurge(key)).rejects.toThrow('EBMR-REC-033');
    const approvalId = await approve(key);
    await expect(withCommand(db.app, again(retentionJob), (c) => purge(c, key))).rejects.toThrow('EBMR-REC-036');

    const tombstoneId = await runPurge(key);
    expect(await scalar<string>(db.app, 'select count(*)::text as v from stub_b4.batch_entry where batch_id = $1', [batch])).toBe('0');
    expect(await scalar<string>(db.app, 'select count(*)::text as v from stub_b4.batch_reading where batch_id = $1', [batch])).toBe('0');
    expect(await scalar<string>(db.app, 'select count(*)::text as v from kernel.audit_event where chain_key = $1', [key])).toBe('0');

    const { rows } = await db.app.query<{
      retain_until: string;
      purged_tables: { table: string; rowCount: number; rowsDigestSha256: string }[];
      chain_event_count: string;
      chain_event_hashes: Buffer[];
      approval_id: string;
      approved_by_person: string;
      executed_by_person: string;
      executed_by_source: string;
      reason_code: string;
      checkpoint_id: string;
    }>(
      "select to_char(retain_until, 'YYYY-MM-DD') as retain_until, purged_tables, chain_event_count::text as chain_event_count, chain_event_hashes, approval_id, approved_by_person, executed_by_person, executed_by_source, reason_code, checkpoint_id::text as checkpoint_id from records.tombstone where id = $1",
      [tombstoneId],
    );
    const t = rows[0];
    expect(t?.retain_until).toBe('2011-01-31');
    expect(t?.approval_id).toBe(approvalId);
    expect(t?.approved_by_person).toBe(qa2.personId);
    expect(t).toMatchObject({ executed_by_person: retentionJob.personId, executed_by_source: 'SYSTEM', reason_code: 'RETENTION_ENDED' });
    expect(t?.purged_tables.map((p) => [p.table, p.rowCount])).toEqual([
      ['stub_b4.batch_entry', 1],
      ['stub_b4.batch_reading', 1],
    ]);
    expect(t?.purged_tables.every((p) => /^[0-9a-f]{64}$/.test(p.rowsDigestSha256))).toBe(true);
    // The tombstone keeps every event hash: those present before the purge, then the audited deletions,
    // the purge entry and nothing else.
    const hashes = t?.chain_event_hashes ?? [];
    expect(hashes.slice(0, eventsBefore.rows.length).map((h) => h.toString('hex'))).toEqual(eventsBefore.rows.map((e) => e.hash.toString('hex')));
    expect(Number(t?.chain_event_count)).toBe(eventsBefore.rows.length + 3);
    const checkpoint = await db.app.query<{ seq: string; reason: string }>('select seq::text as seq, reason from kernel.audit_checkpoint where id = $1', [t?.checkpoint_id]);
    expect(checkpoint.rows[0]).toEqual({ seq: t?.chain_event_count, reason: 'retention purge' });

    // Remaining chains verify; the purged chain verifies against its tombstone; anchors too.
    expect(await verifyChain(db.app, `batch:${other}`)).toEqual([]);
    expect(await verifyChainPurgeAware(db.app, key)).toEqual([]);
    expect(await verifyChainPurgeAware(db.app, `batch:${other}`)).toEqual([]);
    const kernelAnchor = await db.app.query<{ problem: string }>('select problem from kernel.verify_anchor($1)', [anchorId]);
    expect(kernelAnchor.rows.map((r) => r.problem)).toContain(`chain ${key} at seq ${eventsBefore.rows.length} differs from the anchor`);
    expect((await verifyAnchorPurgeAware(db.app, anchorId)).filter((p) => p.includes(key) || p.includes(`batch:${other}`))).toEqual([]);

    // The retention status shows the purge; a second purge or a new hold is refused.
    expect((await retentionOf(db.app, 'batch', batch)).purged).toBe(true);
    await expect(runPurge(key)).rejects.toThrow('EBMR-REC-023');
    await expect(withCommand(db.app, again(qa), (c) => placeLegalHold(c, 'batch', batch, 'too late'))).rejects.toThrow('EBMR-REC-040');
    // The insert-only guard was disabled only inside the purge transaction and is back.
    const { rows: guard } = await db.admin.query<{ tgenabled: string }>(
      "select tgenabled from pg_trigger where tgname = 'aa_insert_only_stub_b4_batch_reading'",
    );
    expect(guard[0]?.tgenabled).toBe('O');
    const { rows: ddl } = await db.app.query<{ n: string }>("select count(*)::text as n from kernel.ddl_log where object_identity = 'stub_b4.batch_reading'");
    expect(Number(ddl[0]?.n)).toBeGreaterThanOrEqual(2);
    expect((await inv22Violations(db.app)).filter(mine)).toEqual([]);
  });

  it('[INV-22] an approval given for an earlier retain-until does not cover a changed retention', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    await approve(key);
    await withCommand(db.app, again(qa), (c) => updateRetentionInputs(c, key, { expiryDate: '2012-01-31' }, 'expiry corrected'));
    await expect(runPurge(key)).rejects.toThrow(/EBMR-REC-033 .* 2013-01-31/);
    await approve(key);
    await expect(runPurge(key)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[INV-22] a record whose audit chain does not verify is not purged', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    await approve(key);
    await db.admin.query("update kernel.audit_event set payload = jsonb_set(payload, '{source}', '\"API\"') where chain_key = $1 and seq = 1", [key]);
    await expect(runPurge(key)).rejects.toThrow('EBMR-REC-034');
    expect(await scalar<string>(db.app, 'select count(*)::text as v from stub_b4.batch_entry where batch_id = $1', [batch])).toBe('1');
  });

  it('[INV-22] retention that is open is never purged, and a disposal approval needs a person', async () => {
    const batch = await batchWithRecords({ markets: ['IN', 'EU'], manufactureDate: '2008-01-10', expiryDate: '2010-01-31' });
    await expect(approve(`batch:${batch}`)).rejects.toThrow('EBMR-REC-030');
    await expect(runPurge(`batch:${batch}`)).rejects.toThrow('EBMR-REC-030');
    const past = await batchWithRecords(PAST_BATCH);
    await expect(withCommand(db.app, again(retentionJob), (c) => approvePurge(c, `batch:${past}`, randomUUID(), 'auto'))).rejects.toThrow('EBMR-REC-035');
  });
});

describe('INV-22 bypass attempts through the application role', () => {
  it('[INV-22][INV-07] every records table is audited and insert-only, and the application role cannot write any of them', async () => {
    const { rows } = await db.admin.query<{ table_name: string; registered: boolean; insert_only: boolean | null; app_writes: boolean }>(`
      select c.oid::regclass::text as table_name, a.table_name is not null as registered, a.insert_only,
             has_table_privilege('ebmr_app', c.oid, 'INSERT') or has_table_privilege('ebmr_app', c.oid, 'UPDATE')
             or has_table_privilege('ebmr_app', c.oid, 'DELETE') or has_table_privilege('ebmr_app', c.oid, 'TRUNCATE') as app_writes
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        left join kernel.audited_table a on a.table_name = c.oid
       where n.nspname = 'records' and c.relkind = 'r' order by 1`);
    // The blocker epoch is a derived concurrency counter, not a record (every change that bumps it is audited elsewhere).
    const gmp = rows.filter((r) => r.table_name !== 'records.blocker_epoch');
    expect(gmp.length).toBeGreaterThanOrEqual(20);
    expect(gmp.filter((r) => !r.registered || !r.insert_only).map((r) => r.table_name)).toEqual([]);
    expect(rows.filter((r) => r.app_writes).map((r) => r.table_name)).toEqual([]);
  });

  it('[INV-22] the application role cannot delete, update or truncate GMP rows, audit events, tombstones or holds directly', async () => {
    const batch = await batchWithRecords(FUTURE_BATCH);
    const attempts = [
      ['delete from stub_b4.batch_entry where batch_id = $1', [batch]],
      ['delete from stub_b4.batch_reading where batch_id = $1', [batch]],
      ['truncate stub_b4.batch_entry', []],
      ['delete from kernel.audit_event where chain_key = $1', [`batch:${batch}`]],
      ['delete from kernel.audit_chain_head where chain_key = $1', [`batch:${batch}`]],
      ['delete from records.retention_hold', []],
      ['delete from records.retention_schedule', []],
      ["update records.retention_evaluation set effective_retain_until = '2000-01-01'", []],
      ["insert into records.retention_evaluation (schedule_id, record_key, input_version, rule_set_version, own, effective, effective_status, effective_retain_until, cause) select id, record_key, 1, 'RET-2026.1', '{}', '{}', 'DATED', '2000-01-01', 'INPUT_CHANGED' from records.retention_schedule limit 1", []],
      ["insert into records.retention_input (schedule_id, record_key, input_version, inputs, change_reason, entered_by_person) select id, record_key, 99, '{\"markets\":[\"IN\"]}', 'x', gen_random_uuid() from records.retention_schedule limit 1", []],
      ["insert into records.retention_hold_release (hold_id, record_key, reason, released_by_person) select id, record_key, 'x', gen_random_uuid() from records.retention_hold limit 1", []],
      ["insert into records.purge_approval (schedule_id, record_key, approved_by_person, approval_signature_id, reason, retain_until) select id, record_key, gen_random_uuid(), gen_random_uuid(), 'x', '2000-01-01' from records.retention_schedule limit 1", []],
      ["insert into records.tombstone (record_key) values ('batch:x')", []],
      ["insert into records.retention_rule (rule_set_version, rule_id, proposed_rule_key, retention_keys, anchor, period_years, period_months, source, verification) values ('RET-2026.1', 'SHORT', 'k', '{BATCH_RECORD}', 'EXPIRY', 0, 0, 's', 'DESIGN')", []],
      ['alter table stub_b4.batch_reading disable trigger aa_insert_only_stub_b4_batch_reading', []],
    ] as const;
    for (const [sql, params] of attempts) {
      await expect(
        withCommand(db.app, withReason(operator, 'ATTACK'), (c) => c.query(sql, [...params])),
        sql,
      ).rejects.toThrow(/permission denied|must be owner/);
    }
    expect(await scalar<string>(db.app, 'select count(*)::text as v from stub_b4.batch_entry where batch_id = $1', [batch])).toBe('1');
  });

  it('[INV-22] the internal retention and purge helpers cannot be called by the application role', async () => {
    const calls = [
      "select records.refresh_retention(gen_random_uuid(), 'CREATED')",
      "select records.add_hold('LEGAL', 'batch', 'x', 'r', null, null)",
      'select records.own_retention(gen_random_uuid())',
      "select records.bump_blocker_epoch('batch', 'x')",
      "select records.insert_only_trigger('stub_b4.batch_reading')",
      "select records.end_hold(h, 'x') from records.retention_hold h limit 1",
    ];
    for (const sql of calls) {
      await expect(withCommand(db.app, withReason(operator, 'ATTACK'), (c) => c.query(sql)), sql).rejects.toThrow(/permission denied/);
    }
  });

  it('[INV-22] even with a DELETE grant, an insert-only GMP row cannot be deleted outside the purge function', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    await db.admin.query('grant delete on stub_b4.batch_reading to ebmr_app');
    try {
      await expect(
        withCommand(db.app, withReason(operator, 'ATTACK'), (c) => c.query('delete from stub_b4.batch_reading where batch_id = $1', [batch])),
      ).rejects.toThrow('EBMR-AUDIT-004');
      // The invariant query reports the dangerous grant.
      expect((await inv22Violations(db.app)).filter((v) => v.check === 'APP_CAN_DELETE_GMP_ROWS').map((v) => v.detail)).toContain('stub_b4.batch_reading');
    } finally {
      await db.admin.query('revoke delete on stub_b4.batch_reading from ebmr_app');
    }
  });

  it('[INV-22] the invariant query finds rows written to a purged record and a tombstone without its checkpoint', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    await approve(key);
    await runPurge(key);
    expect((await inv22Violations(db.app)).filter((v) => v.detail.includes(batch))).toEqual([]);
    await insertEntry(db, operator, batch, '1.0');
    const found = (await inv22Violations(db.app)).filter((v) => v.detail.includes(batch)).map((v) => v.check);
    expect(found).toEqual(expect.arrayContaining(['WRITE_AFTER_PURGE', 'ROWS_REMAIN_AFTER_PURGE']));
    await db.admin.query('delete from kernel.audit_checkpoint where chain_key = $1', [key]);
    expect((await inv22Violations(db.app)).filter((v) => v.detail.includes(batch)).map((v) => v.check)).toContain('PURGE_WITHOUT_CHECKPOINT');
    expect((await verifyChainPurgeAware(db.app, key)).map((p) => p.problem)).toContain('purged chain: checkpoint missing or different from the tombstone');
  });
});
