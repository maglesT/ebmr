/**
 * Review reproducer F34 (part b, the database side): a disposal approval can cite, as the archived
 * true copy of the record, a bundle built with buildTrueCopyBundle(..., { tables: [subset] }) that
 * leaves out a whole registered table of the aggregate type. records.register_true_copy (0440) checks
 * only that the head seq/hash exist, records.approve_purge only that the copy belongs to the record, and
 * records.purge (EBMR-REC-038) only that the copy's head equals the kept head. The purge then deletes
 * the rows of the omitted table and the chain events, and the tombstone records the subset bundle's
 * manifest SHA-256 as the true copy of the purged record. Rows of an omitted insert-only table exist in
 * the audit chain only as row_hash (0010 kernel.audit_row_change), so their values are gone for good.
 *
 * Scenario: batch B with a corrected entry (stub_b4.batch_entry, mutable) and two insert-only readings
 * (stub_b4.batch_reading) whose value 7.1234567 appears nowhere else. Its retention ended. QA builds a
 * true copy with tables ['stub_b4.batch_entry'] only (the offline verifier reports it VERIFIED), registers
 * it, signs and approves the disposal citing it; the retention job purges B.
 *
 * Safe behaviour asserted (DI-47 controlled disposal; INV-22 purge leaves a tombstone; the purge
 * comment "an archived true copy cited by the approval must cover exactly this head, so the archive is
 * complete at the moment of purge"): a copy that does not hold every registered table with rows of the
 * record is refused as the archive (at registration, approval or purge), the readings are still there
 * and no tombstone names that copy. A control batch archived with every table is approved and purged
 * through the same helpers, so a refusal of the subset copy cannot come from the test's setup.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import type { RetentionInputs } from '../../src/records/retention.ts';
import { createRetentionSchedule, purge } from '../../src/records/retention-store.ts';
import { buildTrueCopyBundle, registerTrueCopy, serializeBundle, verifyTrueCopyBundleText } from '../../src/records/true-copy.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import type { SeededActor } from '../identity/seed.ts';
import {
  again,
  approveDisposal,
  correctEntry,
  createStubTables,
  insertEntry,
  insertReading,
  recordType,
  registerType,
  scalar,
  signerActor,
  testActor,
  withReason,
} from '../records/helpers.ts';

let db: TestDatabase;
let operator: ActorContext;
let qa: ActorContext;
let qa2: SeededActor;
let retentionJob: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  await createStubTables(db);
  await registerType(db, recordType('BATCH_PROCESSING_RECORD'));
  operator = await testActor(db, { roleCode: 'OPERATOR' });
  qa = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'QA Reviewer' });
  qa2 = await signerActor(db, 'QA_REVIEWER', 'QA Manager');
  retentionJob = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'retention job' });
});
afterAll(async () => {
  await db.drop();
});

const PAST_BATCH: RetentionInputs = { markets: ['IN', 'US'], manufactureDate: '2008-01-10', expiryDate: '2010-01-31' };
const READING_VALUE = '7.1234567';
const UUID = /^[0-9a-f-]{36}$/;

async function batchWithRecords(): Promise<string> {
  const batch = randomUUID();
  const entry = await insertEntry(db, operator, batch, '12.503');
  await correctEntry(db, operator, entry, '12.530');
  await insertReading(db, operator, batch, READING_VALUE);
  await insertReading(db, operator, batch, '8.7654321');
  await withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'batch', batch, 'BATCH_PROCESSING_RECORD', PAST_BATCH));
  return batch;
}

const runPurge = (key: string) => withCommand(db.app, withReason(retentionJob, 'RETENTION_ENDED', 'approved disposal'), (c) => purge(c, key));

describe('F34 true copy cited by a disposal approval', () => {
  it('[F34][DI-47][INV-22] a true copy that leaves out a registered table holding rows of the record is not accepted as the archive of a purge', async () => {
    // Control: the same flow with a copy of every registered table is approved and purged.
    const control = await batchWithRecords();
    const controlKey = `batch:${control}`;
    const full = await buildTrueCopyBundle(db.app, { chainKey: controlKey });
    expect((JSON.parse(full.manifest) as { tables: string[] }).tables).toEqual(expect.arrayContaining(['stub_b4.batch_entry', 'stub_b4.batch_reading']));
    expect(verifyTrueCopyBundleText(serializeBundle(full)).ok).toBe(true);
    const fullCopy = await withCommand(db.app, again(qa2), (c) => registerTrueCopy(c, full, 'archive before disposal'));
    await approveDisposal(db, qa2, controlKey, 'retention ended; archived true copy verified', fullCopy);
    await expect(runPurge(controlKey)).resolves.toMatch(UUID);

    // The record under test: archived with the insert-only readings table left out.
    const batch = await batchWithRecords();
    const key = `batch:${batch}`;
    const subset = await buildTrueCopyBundle(db.app, { chainKey: key, tables: ['stub_b4.batch_entry'] });
    const subsetText = serializeBundle(subset);
    const offline = verifyTrueCopyBundleText(subsetText);
    // Facts about the subset bundle (not the defect): the offline verifier calls it verified, the chain
    // part holds the readings' INSERT events, but the reading values are nowhere in the bundle.
    expect(offline.ok).toBe(true);
    expect(subsetText).toContain('stub_b4.batch_reading');
    expect(subsetText).not.toContain(READING_VALUE);
    expect(await scalar<string>(db.app, 'select count(*)::text as v from stub_b4.batch_reading where batch_id = $1', [batch])).toBe('2');

    let refusal: string | undefined;
    let copyId: string | undefined;
    try {
      copyId = await withCommand(db.app, again(qa2), (c) => registerTrueCopy(c, subset, 'archive before disposal'));
      await approveDisposal(db, qa2, key, 'retention ended; archived true copy verified', copyId);
      await runPurge(key);
    } catch (error) {
      refusal = (error as Error).message;
    }

    const readingsLeft = await scalar<string>(db.app, 'select count(*)::text as v from stub_b4.batch_reading where batch_id = $1', [batch]);
    const { rows: tombstones } = await db.app.query<{ true_copy_id: string | null; true_copy_manifest_sha256: string | null; purged_tables: unknown }>(
      'select true_copy_id, true_copy_manifest_sha256, purged_tables from records.tombstone where record_key = $1',
      [key],
    );
    const outcome = {
      refused: refusal !== undefined,
      readingsLeft,
      tombstoneCitingTheSubsetCopy: tombstones.some((t) => t.true_copy_manifest_sha256 === subset.manifestSha256),
    };
    const detail =
      `purge of ${key} cited true copy ${copyId ?? '?'} (manifest tables ${JSON.stringify((JSON.parse(subset.manifest) as { tables: string[] }).tables)}, ` +
      `sha256 ${subset.manifestSha256}); refusal: ${refusal ?? 'none'}; tombstones: ${JSON.stringify(tombstones)}`;
    expect(outcome, detail).toEqual({ refused: true, readingsLeft: '2', tombstoneCitingTheSubsetCopy: false });
  });
});
