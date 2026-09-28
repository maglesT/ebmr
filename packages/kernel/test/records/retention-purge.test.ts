import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../../src/audit/verify.ts';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import { buildTrueCopyBundle, registerTrueCopy, verifyTrueCopyBundle } from '../../src/records/true-copy.ts';
import { raiseIncident } from '../../src/records/incidents.ts';
import { closeDiInvestigation, openDiInvestigation } from '../../src/records/investigations.ts';
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
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import type { SeededActor } from '../identity/seed.ts';
import {
  again,
  allowRetention,
  approveDisposal,
  correctEntry,
  createStubTables,
  disposalAggregate,
  insertEntry,
  insertReading,
  recordType,
  registerType,
  scalar,
  signerActor,
  signFor,
  testActor,
  withReason,
} from './helpers.ts';

let db: TestDatabase;
let operator: ActorContext;
let qa: ActorContext;
let qa2: SeededActor;
let retentionJob: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  await createStubTables(db);
  await registerType(db, recordType('BATCH_PROCESSING_RECORD'));
  await registerType(db, recordType('COMPONENT_LOT_RECORD', { retentionKey: 'SUPPORTING_RECORD' }));
  operator = await testActor(db, { roleCode: 'OPERATOR' });
  qa = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'QA Reviewer' });
  qa2 = await signerActor(db, 'QA_REVIEWER', 'QA Manager');
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

// QA's disposal approval carries a RECORD_DISPOSAL_APPROVED signature of the record at its retain-until (DI-37).
const approve = (key: string) => approveDisposal(db, qa2, key, 'retention ended; archived true copy verified');
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
    // The retention job holds no RECORD.LEGAL_HOLD (DI-17); the person-only rule (EBMR-REC-040) stays behind it.
    await expect(withCommand(db.app, again(retentionJob), (c) => releaseLegalHold(c, hold, 'claim settled'))).rejects.toThrow('EBMR-IAM-040');
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

  it('[INV-22][DI-47] the record as kept is sealed before deletion, and an archived true copy cited by the approval must cover it exactly', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    const tables = ['stub_b4.batch_entry', 'stub_b4.batch_reading'];
    const first = await buildTrueCopyBundle(db.app, { chainKey: key, tables });
    expect(verifyTrueCopyBundle(first).ok).toBe(true);
    const firstCopy = await withCommand(db.app, again(qa2), (c) => registerTrueCopy(c, first, 'archive before disposal'));
    await approveDisposal(db, qa2, key, 'retention ended; archive verified', firstCopy);
    // Something is added to the record after it was archived: the archive no longer covers it.
    await withCommand(db.app, again(operator), (c) => c.query("select kernel.audit_business_event($1, 'late remark')", [key]));
    await expect(runPurge(key)).rejects.toThrow(/EBMR-REC-038 .* archive it again/);
    const second = await buildTrueCopyBundle(db.app, { chainKey: key, tables });
    const secondCopy = await withCommand(db.app, again(qa2), (c) => registerTrueCopy(c, second, 'archive before disposal'));
    await approveDisposal(db, qa2, key, 'retention ended; archive verified', secondCopy);
    const tombstoneId = await runPurge(key);
    const { rows } = await db.app.query<{ kept_head_seq: string; kept_head_hash: Buffer; true_copy_id: string; true_copy_manifest_sha256: string; kept_checkpoint_id: string }>(
      'select kept_head_seq::text as kept_head_seq, kept_head_hash, true_copy_id, true_copy_manifest_sha256, kept_checkpoint_id::text as kept_checkpoint_id from records.tombstone where id = $1',
      [tombstoneId],
    );
    const manifest = JSON.parse(second.manifest) as { head: { seq: string; hash: string } };
    expect(rows[0]).toMatchObject({ kept_head_seq: manifest.head.seq, true_copy_id: secondCopy, true_copy_manifest_sha256: second.manifestSha256 });
    expect(rows[0]?.kept_head_hash.toString('hex')).toBe(manifest.head.hash);
    const cp = await db.app.query<{ seq: string; reason: string }>('select seq::text as seq, reason from kernel.audit_checkpoint where id = $1', [rows[0]?.kept_checkpoint_id]);
    expect(cp.rows[0]).toEqual({ seq: manifest.head.seq, reason: 'retention purge: record as kept' });
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

describe('disposal approval signatures', () => {
  it('[DI-47][DI-37] a disposal approval needs the approver\'s own RECORD_DISPOSAL_APPROVED signature of that record at its current retain-until and cited archive', async () => {
    const qa3 = await signerActor(db, 'QA_REVIEWER', 'QA Deputy');
    const batch = await batchWithRecords(PAST_BATCH);
    const other = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    const approveWith = (ctx: ActorContext, signature: string, trueCopy?: string) =>
      withCommand(db.app, again(ctx), (c) => approvePurge(c, key, signature, 'retention ended', trueCopy));
    const signature = await signFor(db, qa2, await disposalAggregate(db, key), 'RECORD_DISPOSAL_APPROVED', 'DISPOSABLE');
    await expect(approveWith(qa2, randomUUID())).rejects.toThrow(/EBMR-ESIG-070 .*does not exist/);
    await expect(approveWith(qa3, signature)).rejects.toThrow('EBMR-REC-039');
    const ofOther = await signFor(db, qa2, await disposalAggregate(db, `batch:${other}`), 'RECORD_DISPOSAL_APPROVED', 'DISPOSABLE');
    await expect(approveWith(qa2, ofOther)).rejects.toThrow(/EBMR-ESIG-070 .*never transferred/);
    // An approval that cites an archived true copy needs a signature that covers that copy.
    const copy = await withCommand(db.app, again(qa2), async (c) =>
      registerTrueCopy(c, await buildTrueCopyBundle(db.app, { chainKey: key, tables: ['stub_b4.batch_entry', 'stub_b4.batch_reading'] }), 'archive before disposal'),
    );
    await expect(approveWith(qa2, signature, copy)).rejects.toThrow('EBMR-ESIG-070');
    // When the retention moves, the signature given for the earlier retain-until no longer covers the approval.
    await withCommand(db.app, again(qa), (c) => updateRetentionInputs(c, key, { expiryDate: '2012-01-31' }, 'expiry corrected'));
    await expect(approveWith(qa2, signature)).rejects.toThrow('EBMR-ESIG-070');
    await expect(approveDisposal(db, qa2, key, 'retention ended at the corrected date', copy)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await expect(runPurge(key)).resolves.toMatch(/^[0-9a-f-]{36}$/);
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

  it('[INV-22] a temporary table cannot stand in for a catalog or records table inside the security-definer functions', async () => {
    // TEMP is revoked from PUBLIC (0001); grant it here to prove the second layer: pg_temp is searched last.
    await db.admin.query(`grant temporary on database ${db.name} to ebmr_app`);
    const client = await db.app.connect();
    try {
      await client.query('create temp table pg_timezone_names (name text)');
      await client.query("insert into pg_temp.pg_timezone_names values ('Mars/Olympus_Mons')");
      await client.query('create temp table retention_schedule (like records.retention_schedule)');
      await client.query('begin');
      await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(again(qa)))]);
      await expect(
        client.query("select records.create_retention_schedule('batch', $1, 'BATCH_PROCESSING_RECORD', $2::jsonb, 'Mars/Olympus_Mons')", [randomUUID(), JSON.stringify(FUTURE_BATCH)]),
      ).rejects.toThrow('EBMR-REC-020');
      await client.query('rollback');
    } finally {
      client.release(true);
      await db.admin.query(`revoke temporary on database ${db.name} from ebmr_app`);
    }
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

describe('Phase 1 exit: retention and purge hardening', () => {
  it('[INV-22][DI-47] only aggregate types a module declares can have a retention schedule, under a retention key it names (EBMR-REC-024; F29, F75)', async () => {
    await registerType(db, recordType('PERMANENT_LOT_FILE', { retentionKey: 'PERMANENT' }));
    const schedule = (type: string, id: string, recordTypeCode: string, inputs: RetentionInputs = PAST_BATCH) =>
      withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, type, id, recordTypeCode, inputs));
    // Records tied to a subject, kernel registers and the records module's own records are never disposed of on their own.
    for (const type of ['esig_signature', 'esig_challenge', 'state', 'incident', 'di_investigation', 'record_type', 'iam_policy', 'time_node', 'number_sequence']) {
      await expect(schedule(type, `x-${randomUUID()}`, 'BATCH_PROCESSING_RECORD'), type).rejects.toThrow(`EBMR-REC-024 ${type} records are not disposed of on their own`);
    }
    // A declared aggregate type only under the retention keys its module names; PERMANENT (longer) is always accepted.
    await expect(schedule('batch', randomUUID(), 'COMPONENT_LOT_RECORD', { markets: ['IN'] })).rejects.toThrow(
      'EBMR-REC-024 a record type with retention key SUPPORTING_RECORD cannot govern batch records',
    );
    await expect(schedule('component_lot', randomUUID(), 'BATCH_PROCESSING_RECORD')).rejects.toThrow('EBMR-REC-024 a record type with retention key BATCH_RECORD cannot govern component_lot records');
    await expect(schedule('component_lot', randomUUID(), 'PERMANENT_LOT_FILE', { markets: ['IN'] })).resolves.toMatch(/^[0-9a-f-]{36}$/);
    // The list is written only by module migrations: the application can neither write it nor call the declaration.
    await expect(withCommand(db.app, withReason(operator, 'ATTACK', 'x'), (c) => c.query("insert into records.retention_aggregate (aggregate_type, retention_keys, owning_module, note) values ('esig_stub', '{BATCH_RECORD}', 'x', 'x')"))).rejects.toThrow(/permission denied/);
    await expect(withCommand(db.app, withReason(operator, 'ATTACK', 'x'), (c) => c.query("select records.declare_retention_aggregate('esig_stub', '{BATCH_RECORD}', 'x', 'x')"))).rejects.toThrow(/permission denied/);
    // Even the owner cannot declare a record tied to a subject.
    await expect(allowRetention(db, 'esig_signature', ['BATCH_RECORD'])).rejects.toThrow(/violates check constraint/);
    expect(await scalar<string>(db.app, "select string_agg(aggregate_type, ',' order by aggregate_type) as v from records.retention_aggregate")).toBe('batch,component_lot');
  });

  it('[DI-47][INV-22] nobody who entered retention inputs of the record or of a record depending on it, or linked the dependency, approves its disposal (EBMR-REC-035, -033; F33)', async () => {
    const author = await signerActor(db, 'QA_REVIEWER', 'QA Reviewer who changed inputs');
    const lot = randomUUID();
    const lotKey = `component_lot:${lot}`;
    const batch = await batchWithRecords(PAST_BATCH);
    await withCommand(db.app, again(operator), (c) => c.query("insert into stub_b4.lot_record (lot_id, note) values ($1, 'received')", [lot]));
    await withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'component_lot', lot, 'COMPONENT_LOT_RECORD', { markets: ['IN'] }));
    // A different QA reviewer links the dependency that gives the lot its date, and corrects the batch's expiry.
    await withCommand(db.app, again(author), (c) => linkRetentionDependency(c, lotKey, `batch:${batch}`, 'COMPONENT_LOT_CONSUMED'));
    await withCommand(db.app, again(author), (c) => updateRetentionInputs(c, `batch:${batch}`, { expiryDate: '2010-02-28' }, 'expiry corrected'));
    expect((await retentionOf(db.app, 'component_lot', lot)).effective).toMatchObject({ status: 'DATED', retainUntil: '2011-02-28' });
    // 1. The signing path: the disposal content names the authors (entered_by), so esig refuses their
    //    RECORD_DISPOSAL_APPROVED signature (INV-03) before approve_purge is reached.
    await expect(approveDisposal(db, author, lotKey, 'retention ended')).rejects.toThrow(
      'EBMR-ESIG-044 INV-03: RECORD_DISPOSAL_APPROVED is never signed by a person who performed, entered data in or corrected the record',
    );
    await expect(approveDisposal(db, author, `batch:${batch}`, 'retention ended')).rejects.toThrow(
      'EBMR-ESIG-044 INV-03: RECORD_DISPOSAL_APPROVED is never signed by a person who performed, entered data in or corrected the record',
    );
    expect(await scalar<string>(db.app, 'select count(*)::text as v from records.purge_approval where record_key in ($1, $2)', [lotKey, `batch:${batch}`])).toBe('0');
    // 2. The database's own rule (EBMR-REC-035), with a signature that is itself independent: made
    //    before its signer became an author. Linking a dependant with an earlier date changes neither
    //    the record's content nor its retain-until, so the signature stays valid; approve_purge still
    //    refuses the signer, who now shaped the record's retention.
    const other = await batchWithRecords(PAST_BATCH);
    const early = await signFor(db, author, await disposalAggregate(db, `batch:${other}`), 'RECORD_DISPOSAL_APPROVED', 'DISPOSABLE');
    const dependant = await batchWithRecords({ ...PAST_BATCH, expiryDate: '2009-12-31' });
    await withCommand(db.app, again(author), (c) => linkRetentionDependency(c, `batch:${other}`, `batch:${dependant}`, 'REWORKED_INTO'));
    expect(await db.app.query<{ valid: boolean }>('select (esig.signature_state($1) ->> $2)::boolean as valid', [early, 'valid']).then((r) => r.rows[0]?.valid)).toBe(true);
    await expect(withCommand(db.app, again(author), (c) => approvePurge(c, `batch:${other}`, early, 'retention ended'))).rejects.toThrow(
      `EBMR-REC-035 the approver entered retention inputs or dependency links that decide when batch:${other}`,
    );
    expect(await scalar<string>(db.app, 'select count(*)::text as v from records.purge_approval where record_key = $1', [`batch:${other}`])).toBe('0');
    // An independent approver can; but once the approver changes an input of a dependant, the approval no longer counts for the purge.
    await approveDisposal(db, qa2, lotKey, 'retention ended; inputs reviewed');
    await withCommand(db.app, again(qa2), (c) => updateRetentionInputs(c, `batch:${batch}`, { distributionDate: '2009-05-01' }, 'distribution date recorded'));
    expect((await retentionOf(db.app, 'component_lot', lot)).effective).toMatchObject({ retainUntil: '2011-02-28' });
    await expect(runPurge(lotKey)).rejects.toThrow(/EBMR-REC-033 no QA disposal approval for .* by a person who entered none of its retention inputs/);
    expect(await scalar<string>(db.app, 'select count(*)::text as v from stub_b4.lot_record where lot_id = $1', [lot])).toBe('1');
  });

  it('[INV-22][DI-24] a purge needs a reason code and a reason text; white space is no reason (EBMR-REC-036)', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    await approve(key);
    for (const ctx of [withReason(retentionJob, 'RETENTION_ENDED'), withReason(retentionJob, 'RETENTION_ENDED', ' \t\n'), withReason(retentionJob, '\t', 'approved disposal')]) {
      await expect(withCommand(db.app, ctx, (c) => purge(c, key))).rejects.toThrow('EBMR-REC-036 a purge needs a reason code and a reason text');
    }
    expect(await scalar<string>(db.app, 'select count(*)::text as v from stub_b4.batch_entry where batch_id = $1', [batch])).toBe('1');
    await expect(runPurge(key)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[INV-22][DI-47][INV-08] the purge digest is the audit row hash whatever the session TimeZone, DateStyle, IntervalStyle, float and bytea output', async () => {
    await db.admin.query(`
      set role ebmr_owner;
      create table stub_b4.timed_reading (id uuid primary key default gen_random_uuid(), batch_id uuid not null, taken_at timestamptz not null,
        on_day date not null, span interval not null, ratio double precision not null, raw bytea not null);
      grant select, insert on stub_b4.timed_reading to ebmr_app;
      select kernel.register_audited_table('stub_b4.timed_reading', 'tz_batch', 'batch_id', true);
      reset role;`);
    await allowRetention(db, 'tz_batch', ['BATCH_RECORD']);
    // A session with settings the application might use: every rendering of the row differs from the default.
    const odd = new pg.Pool({
      connectionString: urlFor(db.name, { name: 'ebmr_app', password: 'ebmr_app' }),
      max: 1,
      options: '-c TimeZone=Pacific/Kiritimati -c DateStyle=SQL,DMY -c IntervalStyle=sql_standard -c extra_float_digits=-3 -c bytea_output=escape',
    });
    try {
      const batch = randomUUID();
      const key = `tz_batch:${batch}`;
      await withCommand(odd, again(operator), async (c) => {
        const insert = "insert into stub_b4.timed_reading (batch_id, taken_at, on_day, span, ratio, raw) values ($1, $2, '2026-01-02', interval '5 hours 30 minutes', 0.1::float8 + 0.2::float8, '\\x00ff'::bytea)";
        await c.query(insert, [batch, '2026-01-02T03:04:05.123456Z']);
        await c.query(insert, [batch, '2026-01-02T23:59:59.5Z']);
      });
      // The digest purge must give: SHA-256 over the sorted row hashes the audit trigger recorded.
      const { rows: hashes } = await db.app.query<{ h: string }>(
        "select payload -> 'body' ->> 'row_hash' as h from kernel.audit_event where chain_key = $1 and action = 'INSERT' order by 1",
        [key],
      );
      expect(hashes).toHaveLength(2);
      const expected = createHash('sha256').update(hashes.map((r) => r.h).join('\n')).digest('hex');
      await withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'tz_batch', batch, 'BATCH_PROCESSING_RECORD', PAST_BATCH));
      await approve(key);
      const tombstone = await withCommand(odd, withReason(retentionJob, 'RETENTION_ENDED', 'approved disposal'), (c) => purge(c, key));
      const { rows } = await db.app.query<{ purged_tables: { table: string; rowCount: number; rowsDigestSha256: string }[] }>(
        'select purged_tables from records.tombstone where id = $1',
        [tombstone],
      );
      expect(rows[0]?.purged_tables).toEqual([{ table: 'stub_b4.timed_reading', rowCount: 2, rowsDigestSha256: expected }]);
    } finally {
      await odd.end();
    }
  });

  it('[INV-22][DI-47] the insert-only guard of a table in the records schema is found, so such a record can be purged, and the guard is back afterwards (F36)', async () => {
    const guard = await scalar<string | null>(db.admin, "select records.insert_only_trigger('records.incident'::regclass) as v");
    expect(guard).toBe('aa_insert_only_records_incident');
    // A stand-in insert-only aggregate in the records schema (this test database only).
    await db.admin.query(`
      set role ebmr_owner;
      create table records.stub_note (id uuid primary key default gen_random_uuid(), note_id uuid not null, note text not null);
      select kernel.register_audited_table('records.stub_note', 'rs_note', 'note_id', true);
      reset role;`);
    await allowRetention(db, 'rs_note', ['BATCH_RECORD']);
    const note = randomUUID();
    const key = `rs_note:${note}`;
    await withCommand(db.admin, again(operator), (c) => c.query("insert into records.stub_note (note_id, note) values ($1, 'kept note')", [note]));
    await withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'rs_note', note, 'BATCH_PROCESSING_RECORD', PAST_BATCH));
    await approve(key);
    await expect(runPurge(key)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    expect(await scalar<string>(db.admin, 'select count(*)::text as v from records.stub_note where note_id = $1', [note])).toBe('0');
    const { rows } = await db.admin.query<{ tgenabled: string }>("select tgenabled from pg_trigger where tgname = 'aa_insert_only_records_stub_note'");
    expect(rows[0]?.tgenabled).toBe('O');
  });

  it('[INV-22] the invariant query reports a purge of an aggregate type no module declares, or of a PERMANENT record', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    await approve(key);
    const tombstone = await runPurge(key);
    const found = async () => (await inv22Violations(db.app)).filter((v) => v.detail === key).map((v) => v.check);
    expect(await found()).toEqual([]);
    // States no function produces, arranged by the superuser on the insert-only tombstone.
    await db.admin.query('alter table records.tombstone disable trigger user');
    try {
      await db.admin.query("update records.tombstone set aggregate_type = 'esig_signature' where id = $1", [tombstone]);
      expect(await found()).toContain('PURGED_UNDECLARED_AGGREGATE');
      await db.admin.query("update records.tombstone set aggregate_type = 'batch', retention_key = 'PERMANENT' where id = $1", [tombstone]);
      expect(await found()).toContain('PURGED_PERMANENT_RECORD');
      await db.admin.query("update records.tombstone set retention_key = 'BATCH_RECORD' where id = $1", [tombstone]);
    } finally {
      await db.admin.query('alter table records.tombstone enable trigger user');
    }
    expect(await found()).toEqual([]);
  });

  it('[INV-22][INV-08] an anchor taken after a purge verifies against the chain written again under the purged key, and a changed event is still reported (F37)', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    const before = await scalar<string>(db.app, 'select kernel.create_anchor()::text as v');
    await approve(key);
    await runPurge(key);
    // An incident linked to the purged batch writes a business entry: a new chain from genesis under the same key.
    await withCommand(db.app, again(operator), (c) =>
      raiseIncident(c, { source: 'OTHER', type: 'LATE_FINDING', severity: 'MINOR', title: 'finding on a disposed batch', links: [{ aggregateType: 'batch', aggregateId: batch }] }),
    );
    expect(await scalar<string>(db.app, 'select count(*)::text as v from kernel.audit_event where chain_key = $1', [key])).toBe('1');
    const after = await scalar<string>(db.app, 'select kernel.create_anchor()::text as v');
    const mine = async (anchor: string) => (await verifyAnchorPurgeAware(db.app, anchor)).filter((p) => p.includes(key));
    expect(await mine(before)).toEqual([]);
    expect(await mine(after)).toEqual([]);
    // Tampering with the new chain is still found.
    await db.admin.query("update kernel.audit_event set hash = sha256(convert_to('forged', 'UTF8')) where chain_key = $1 and seq = 1", [key]);
    expect(await mine(after)).toEqual([`chain ${key} at seq 1 differs from the anchor`]);
    expect(await mine(before)).toEqual([]);
  });

  it('[INV-22] retention ends on the site date: a schedule keeps the site zone, and a zone of the caller that differs is refused (F84)', async () => {
    const batch = randomUUID();
    await expect(
      withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'batch', batch, 'BATCH_PROCESSING_RECORD', FUTURE_BATCH, 'Pacific/Kiritimati')),
    ).rejects.toThrow("EBMR-REC-020 site zone 'Pacific/Kiritimati' is not the zone of this site (Asia/Kolkata)");
    await withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'batch', batch, 'BATCH_PROCESSING_RECORD', FUTURE_BATCH));
    expect((await retentionOf(db.app, 'batch', batch)).siteZone).toBe('Asia/Kolkata');
    // A command context declaring another zone never reaches the schedule: the identity module refuses the
    // context itself (EBMR-IAM-118). With the site policy in place records reads the zone from it, never
    // from the context (the default schedule above keeps the site zone).
    await expect(
      withCommand(db.app, { ...again(qa), siteZone: 'Pacific/Kiritimati' }, (c) => createRetentionSchedule(c, 'batch', randomUUID(), 'BATCH_PROCESSING_RECORD', FUTURE_BATCH)),
    ).rejects.toThrow('EBMR-IAM-118');
  });
});

describe('owner decision 0004: a hold voids the disposal approvals given before it', () => {
  // The signed disposal content carries the hold watermark (kernel 0720), so a hold supersedes the
  // signatures made before it (esig SUPERSEDED_BY_CHANGE). The new approval comes from another QA reviewer
  // here; the same reviewer may sign it again too (test/integration/authorization.test.ts).
  let qa3: SeededActor;
  beforeAll(async () => {
    qa3 = await signerActor(db, 'QA_REVIEWER', 'QA Deputy after the hold');
  });
  const approveAgain = (key: string) => approveDisposal(db, qa3, key, 'retention ended; hold released, inputs and archive reviewed again');
  const signatureOf = (approvalId: string) => scalar<string>(db.app, 'select approval_signature_id::text as v from records.purge_approval where id = $1', [approvalId]);
  const rows = (batch: string) => scalar<string>(db.app, 'select count(*)::text as v from stub_b4.batch_entry where batch_id = $1', [batch]);

  it('[DI-47][INV-22] an approval given before a legal hold no longer authorises the purge after the release, nor does its signature; a new approval does (EBMR-REC-041)', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    const before = await approve(key);
    const hold = await withCommand(db.app, again(qa), (c) => placeLegalHold(c, 'batch', batch, 'product liability claim', 'LEGAL-0004'));
    await expect(runPurge(key)).rejects.toThrow('EBMR-REC-032');
    await withCommand(db.app, again(qa), (c) => releaseLegalHold(c, hold, 'claim settled'));
    // The approval given before the hold is void, also after the release.
    await expect(runPurge(key)).rejects.toThrow(
      `EBMR-REC-041 the disposal approval ${before} of ${key} was given before the legal hold LEGAL-0004 was placed on ${key}; after a hold the disposal needs a new approval`,
    );
    // Its signature cannot carry a new approval either: the decision is taken again after the hold. The
    // hold changed the signed content, so the signature itself is superseded (a signature made while a
    // hold was in place is refused by EBMR-REC-041 instead).
    await expect(withCommand(db.app, again(qa2), async (c) => approvePurge(c, key, await signatureOf(before), 'retention ended'))).rejects.toThrow(
      /EBMR-ESIG-070 signature .* is SUPERSEDED_BY_CHANGE; the record must be signed again/,
    );
    expect(await rows(batch)).toBe('1');
    // A new approval, signed after the release and meeting every current rule, authorises the purge.
    const after = await approveAgain(key);
    expect(after).not.toBe(before);
    const tombstone = await runPurge(key);
    expect(await scalar<string>(db.app, 'select approval_id::text as v from records.tombstone where id = $1', [tombstone])).toBe(after);
    expect(await rows(batch)).toBe('0');
    expect((await inv22Violations(db.app)).filter((v) => v.detail.includes(batch))).toEqual([]);
  });

  it('[DI-47][INV-22] a legal hold on a record depending on it voids the approval of the supporting record (EBMR-REC-041)', async () => {
    const lot = randomUUID();
    const lotKey = `component_lot:${lot}`;
    const batch = await batchWithRecords(PAST_BATCH);
    await withCommand(db.app, again(operator), (c) => c.query("insert into stub_b4.lot_record (lot_id, note) values ($1, 'received')", [lot]));
    await withCommand(db.app, again(qa), async (c) => {
      await createRetentionSchedule(c, 'component_lot', lot, 'COMPONENT_LOT_RECORD', { markets: ['IN'] });
      await linkRetentionDependency(c, lotKey, `batch:${batch}`, 'COMPONENT_LOT_CONSUMED');
    });
    const before = await approve(lotKey);
    const hold = await withCommand(db.app, again(qa), (c) => placeLegalHold(c, 'batch', batch, 'regulatory inspection request', 'INSP-0004'));
    await withCommand(db.app, again(qa), (c) => releaseLegalHold(c, hold, 'inspection closed'));
    await expect(runPurge(lotKey)).rejects.toThrow(`EBMR-REC-041 the disposal approval ${before} of ${lotKey} was given before the legal hold INSP-0004 was placed on batch:${batch}`);
    expect(await scalar<string>(db.app, 'select count(*)::text as v from stub_b4.lot_record where lot_id = $1', [lot])).toBe('1');
    await approveAgain(lotKey);
    await expect(runPurge(lotKey)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DI-47][DI-50][INV-22] a DI-investigation hold voids the approval too; after the investigation closes a new approval authorises the purge (EBMR-REC-041)', async () => {
    const investigator = await testActor(db, { roleCode: 'CSV_DI_LEAD', legalName: 'DI investigator' });
    const from = await scalar<Date>(db.app, 'select clock_timestamp() as v');
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    const before = await approve(key);
    // The operator who wrote the batch is investigated: the batch is linked and held.
    const id = await withCommand(db.app, again(investigator), (c) =>
      openDiInvestigation(c, { subjectPersonId: operator.personId, windowFrom: from, windowTo: new Date(from.getTime() + 3_600_000), concern: 'entries made after the fact' }),
    );
    await expect(runPurge(key)).rejects.toThrow('EBMR-REC-032');
    const signature = await signFor(db, qa2, { type: 'di_investigation', id }, 'DI_INVESTIGATION_CLOSED', 'OPEN');
    await withCommand(db.app, again(qa2), (c) => closeDiInvestigation(c, id, { conclusion: 'no falsification', remediation: 'none required', approvalSignatureId: signature }));
    await expect(runPurge(key)).rejects.toThrow(`EBMR-REC-041 the disposal approval ${before} of ${key} was given before the di investigation hold`);
    await approveAgain(key);
    await expect(runPurge(key)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DI-47][INV-22] a hold placed and released before the approval does not void it; the approval records the holds it was given after', async () => {
    const batch = await batchWithRecords(PAST_BATCH);
    const key = `batch:${batch}`;
    const hold = await withCommand(db.app, again(qa), (c) => placeLegalHold(c, 'batch', batch, 'claim', 'LEGAL-EARLIER'));
    await withCommand(db.app, again(qa), (c) => releaseLegalHold(c, hold, 'claim withdrawn'));
    const approval = await approve(key);
    const { rows: marks } = await db.app.query<{ watermark: string; hold_no: string }>(
      'select a.hold_watermark::text as watermark, h.hold_no::text as hold_no from records.purge_approval a, records.retention_hold h where a.id = $1 and h.id = $2',
      [approval, hold],
    );
    expect(marks[0]?.watermark).toBe(marks[0]?.hold_no);
    await expect(runPurge(key)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });
});
