/**
 * External anchors against the live chains, and the chain-verification alarm.
 *
 * - A record purged at the end of its retention (DI-47) leaves the anchors taken during its life
 *   verifiable: the external anchor check and the start-up check read the purged chain's tombstone,
 *   so a lawful purge is never a permanent ANCHOR_MISMATCH (INV-08).
 * - When a restore is recorded, only history the restored chain no longer has is DISCARDABLE: not an
 *   anchored entry that is still there with another hash, not an anchor older than the restore point,
 *   not an anchor this very server exported (INV-08, DI-45).
 * - A break found by the scheduled chain verification is a CRITICAL continuity alarm that a person
 *   acknowledges (DI-23).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportAnchor, runIntegrityVerification, verifyExternalAnchors } from '../../src/continuity/anchors.ts';
import type { ExternalAnchor, FileLedger } from '../../src/continuity/ledger.ts';
import { checkAgainstLedger } from '../../src/continuity/restore.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createRetentionSchedule, purge } from '../../src/records/retention-store.ts';
import type { SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { again, approveDisposal, correctEntry, createStubTables, insertEntry, insertReading, recordType, registerType, withReason } from '../records/helpers.ts';
import { signerActor, tempDir, tempLedger, testActor } from './helpers.ts';

const dir = tempDir('anchors');
afterAll(() => dir.cleanup());

describe('external anchors and a lawful purge', () => {
  let db: TestDatabase;
  let ledger: FileLedger;
  let operator: ActorContext;
  let keeper: ActorContext;
  let approver: SeededActor;
  let retentionJob: ActorContext;

  beforeAll(async () => {
    db = await createTestDatabase();
    ledger = tempLedger('anchors-purge', dir.path);
    await createStubTables(db);
    await registerType(db, recordType('BATCH_PROCESSING_RECORD'));
    operator = await testActor(db, { roleCode: 'OPERATOR' });
    keeper = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Retention Keeper' });
    approver = await signerActor(db, 'QA_REVIEWER', 'QA Manager');
    retentionJob = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'retention job' });
  }, 60_000);
  afterAll(async () => {
    await db?.drop();
  });

  it('[INV-08][DI-47][DI-45] an anchor taken during a record\'s retention still matches after the record is purged; the start-up check stays clean', async () => {
    // A batch record with a corrected entry and an insert-only reading, whose retention has ended.
    const batch = randomUUID();
    const key = `batch:${batch}`;
    const entry = await insertEntry(db, operator, batch, '12.503');
    await correctEntry(db, operator, entry, '12.530');
    await insertReading(db, operator, batch, '7.10');
    await withCommand(db.app, again(keeper), (c) =>
      createRetentionSchedule(c, 'batch', batch, 'BATCH_PROCESSING_RECORD', { markets: ['IN', 'US'], manufactureDate: '2008-01-10', expiryDate: '2010-01-31' }),
    );
    const during = await exportAnchor(db.app, ledger);
    const anchoredHead = during.heads.find((h) => h.chain_key === key);
    expect(anchoredHead?.seq).toBeGreaterThanOrEqual(3);
    expect((await checkAgainstLedger(db.app, ledger)).ok).toBe(true);

    // The approved disposal: the record's rows and its chain events go, its tombstone keeps the hashes.
    await approveDisposal(db, approver, key, 'retention ended');
    await withCommand(db.app, withReason(retentionJob, 'RETENTION_ENDED', 'approved disposal'), (c) => purge(c, key));
    expect((await db.app.query('select 1 from kernel.audit_event where chain_key = $1', [key])).rowCount).toBe(0);

    // The anchor from before the purge still matches (the head is the tombstone's), and so does one
    // taken after a new entry started the chain again from genesis under the same key.
    await withCommand(db.app, again(operator), (c) => c.query("select kernel.audit_business_event($1, 'label reconciliation noted after disposal')", [key]));
    const after = await exportAnchor(db.app, ledger);
    expect(after.heads.find((h) => h.chain_key === key)?.seq).toBe(1);
    const verified = await verifyExternalAnchors(db.app, ledger);
    expect(verified.filter((v) => v.anchorId === during.anchor_id || v.anchorId === after.anchor_id).map((v) => v.status)).toEqual(['MATCH', 'MATCH']);
    const check = await checkAgainstLedger(db.app, ledger);
    expect(check.findings.filter((f) => f.severity === 'ERROR')).toEqual([]);
    expect(check.ok).toBe(true);
    const cmp = await db.app.query<{ status: string }>('select status from continuity.compare_external_anchors($1::jsonb)', [JSON.stringify([during])]);
    expect(cmp.rows.map((r) => r.status)).toEqual(['MATCH']);

    // The tombstone does not hide a changed hash: an external copy that anchored another hash for the
    // purged chain is still a problem.
    const heads = during.heads.map((h) => (h.chain_key === key ? { ...h, hash_hex: 'ab'.repeat(32) } : h));
    const root = (await db.app.query<{ r: string }>("select encode(kernel.merkle_root($1::jsonb), 'hex') as r", [JSON.stringify(heads)])).rows[0]?.r ?? '';
    const forged: ExternalAnchor = { ...during, heads, merkle_root_hex: root };
    const problems = await db.app.query<{ problem: string }>('select problem from continuity.external_anchor_problems($1::jsonb)', [JSON.stringify(forged)]);
    expect(problems.rows.map((r) => r.problem)).toContain(`chain ${key} at seq ${anchoredHead?.seq} differs from external anchor ${during.anchor_id}`);
  });
});

describe('which differences a restore event may discard', () => {
  let db: TestDatabase;
  let ops: ActorContext;
  const chain = `batch:${randomUUID()}`;

  beforeAll(async () => {
    db = await createTestDatabase();
    ops = await testActor(db, { roleCode: 'SERVICE_ACCOUNT', source: 'SYSTEM' });
    // The chain ends at seq 2 in this database.
    for (const v of ['1', '2']) {
      await withCommand(db.app, again(ops), (c) => c.query('insert into testgmp.sample (batch_id, value) values ($1, $2)', [chain.slice('batch:'.length), v]));
    }
  });
  afterAll(async () => {
    await db?.drop();
  });

  /** An external anchor this database does not hold, anchoring `chain` at `seq` with a hash it never had. */
  async function externalAnchor(seq: number, createdAt: string, extra: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const heads = [{ chain_key: chain, seq, hash_hex: randomBytes(32).toString('hex') }];
    const root = (await db.app.query<{ r: string }>("select encode(kernel.merkle_root($1::jsonb), 'hex') as r", [JSON.stringify(heads)])).rows[0]?.r ?? '';
    return { anchor_id: String(900_000_000 + seq), created_at: createdAt, merkle_root_hex: root, head_count: 1, heads, ...extra };
  }
  async function classify(anchor: Record<string, unknown>, restorePoint: string | null): Promise<string | undefined> {
    const { rows } = await db.app.query<{ status: string }>('select status from continuity.compare_external_anchors($1::jsonb, $2::timestamptz)', [
      JSON.stringify([anchor]),
      restorePoint,
    ]);
    return rows[0]?.status;
  }

  it('[INV-08][DI-45] history beyond where the restored chain ends, anchored after the restore point, is discardable', async () => {
    const lost = await externalAnchor(3, '2026-03-02T10:00:00.000000Z');
    expect(await classify(lost, '2026-03-02T09:00:00Z')).toBe('DISCARDABLE');
    expect(await classify(lost, null)).toBe('DISCARDABLE');
  });

  it('[INV-08][DI-45] an anchored entry still present with another hash, an anchor older than the restore point, or one this server exported is never discardable (F57)', async () => {
    // Changed, not lost: the chain still has seq 2.
    expect(await classify(await externalAnchor(2, '2026-03-02T10:00:00.000000Z'), '2026-03-02T09:00:00Z')).toBe('UNEXPLAINED');
    // Created before the restore point: it would be in the restored database.
    expect(await classify(await externalAnchor(3, '2026-03-02T08:00:00.000000Z'), '2026-03-02T09:00:00Z')).toBe('UNEXPLAINED');
    // Exported by this running server (same incarnation, same server start): nothing it anchored was
    // lost by a restore, whatever the event claims.
    const here = await db.app.query<{ i: string; s: string }>('select continuity.current_incarnation() as i, continuity.utc_text(pg_postmaster_start_time()) as s');
    const own = await externalAnchor(3, '2026-03-02T10:00:00.000000Z', { incarnation: here.rows[0]?.i ?? '', server_started_at: here.rows[0]?.s ?? '' });
    expect(await classify(own, '2026-03-02T09:00:00Z')).toBe('UNEXPLAINED');
  });
});

describe('chain verification alarm (DI-23)', () => {
  let db: TestDatabase;
  let job: ActorContext;

  beforeAll(async () => {
    db = await createTestDatabase();
    job = await testActor(db, { roleCode: 'SERVICE_ACCOUNT', source: 'SYSTEM', legalName: 'integrity verification job' });
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('[DI-23] a break found by the scheduled verification is a CRITICAL continuity alarm naming the entry, raised once per run and acknowledged by a person', async () => {
    const batch = randomUUID();
    await withCommand(db.app, again(job), (c) => c.query("insert into testgmp.sample (batch_id, value) values ($1, '12.5')", [batch]));
    const clean = await runIntegrityVerification(db.app, again(job));
    expect(clean).toMatchObject({ problemCount: 0, alarmsRaised: 0 });

    // A superuser rewrites a recorded value without the triggers (the hash no longer matches).
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query("update kernel.audit_event set payload = jsonb_set(payload, '{body,new,value}', '99') where chain_key = $1 and seq = 1", [`batch:${batch}`]);
      await c.query('commit');
    } finally {
      c.release();
    }

    const broken = await runIntegrityVerification(db.app, again(job));
    expect(broken.problemCount).toBeGreaterThanOrEqual(1);
    expect(broken.alarmsRaised).toBe(1);
    const alarms = await db.app.query<{ id: string; severity: string; subject: string; run: string }>(
      "select id::text, severity, subject, details ->> 'verification_run_id' as run from continuity.open_alarm where alarm_code = 'AUDIT_CHAIN_BROKEN'",
    );
    expect(alarms.rows).toEqual([{ id: expect.any(String) as string, severity: 'CRITICAL', subject: expect.stringContaining(`chain batch:${batch} at seq 1`) as string, run: broken.runId }]);

    // Each run is alarmed once: routing again raises nothing new; the next run is a new alarm.
    expect((await withCommand(db.app, again(job), (x) => x.query<{ n: number }>('select continuity.raise_integrity_alarms() as n'))).rows[0]?.n).toBe(0);
    expect((await runIntegrityVerification(db.app, again(job))).alarmsRaised).toBe(1);

    // Only the system service account routes the alarms; a person at a terminal cannot.
    const admin = await testActor(db, { roleCode: 'SYSTEM_ADMINISTRATOR' });
    await expect(withCommand(db.app, again(admin), (x) => x.query('select continuity.raise_integrity_alarms()'))).rejects.toThrow('EBMR-CONT-033');

    // A person acknowledges the alarm with a comment; it is no longer open, and nothing is deleted.
    const first = alarms.rows[0]?.id ?? '';
    await withCommand(db.app, again(admin), (x) => x.query('select continuity.acknowledge_alarm($1, $2)', [first, 'DI incident INC-2026-0107 opened; chain under investigation']));
    const open = await db.app.query<{ id: string }>("select id::text from continuity.open_alarm where alarm_code = 'AUDIT_CHAIN_BROKEN'");
    expect(open.rows.map((r) => r.id)).not.toContain(first);
    expect(open.rows).toHaveLength(1);
    expect((await db.app.query("select 1 from continuity.alarm where alarm_code = 'AUDIT_CHAIN_BROKEN'")).rowCount).toBe(2);
  });
});
