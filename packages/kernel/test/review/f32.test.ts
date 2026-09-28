/**
 * Review reproducer F32: a record whose record type has retention key PERMANENT ("kept for the life of
 * the installation (no rule applies, so retention stays OPEN)", retention-rules.ts:25) gets own status
 * NONE, because no retention rule lists PERMANENT. records.compute_effective_retention (0420 line 440,
 * mirror combineEffectiveRetention in retention.ts) treats a NONE node as OPEN only while it has no
 * dependants. As soon as any record is linked as depending on the PERMANENT record, the PERMANENT record
 * takes the latest retain-until of its dependants, becomes DATED, and approve_purge / purge accept it.
 *
 * Safe behaviour asserted (retention-rules.ts:25 PERMANENT; DI-47; INV-22 "nothing is purged unless its
 * retention has ended"): a PERMANENT record stays OPEN whatever depends on it, disposal approval and
 * purge are refused, and its rows are still there.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import type { RetentionInputs } from '../../src/records/retention.ts';
import { createRetentionSchedule, linkRetentionDependency, purge, retentionOf } from '../../src/records/retention-store.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import type { SeededActor } from '../identity/seed.ts';
import { again, approveDisposal, createStubTables, recordType, registerType, scalar, signerActor, testActor, withReason } from '../records/helpers.ts';

let db: TestDatabase;
let operator: ActorContext;
let qa: ActorContext;
let qa2: SeededActor;
let retentionJob: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  await createStubTables(db);
  await registerType(db, recordType('BATCH_PROCESSING_RECORD'));
  await registerType(db, recordType('PERM_DOC', { retentionKey: 'PERMANENT' }));
  operator = await testActor(db, { roleCode: 'OPERATOR' });
  qa = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'QA Reviewer' });
  qa2 = await signerActor(db, 'QA_REVIEWER', 'QA Manager');
  retentionJob = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'retention job' });
});
afterAll(async () => {
  await db.drop();
});

const PAST_BATCH: RetentionInputs = { markets: ['IN', 'US'], manufactureDate: '2008-01-10', expiryDate: '2010-01-31' };

/** Runs a step and reports whether it was refused (and with what), instead of throwing. */
async function outcome(step: () => Promise<unknown>): Promise<string> {
  try {
    await step();
    return 'ACCEPTED';
  } catch (e) {
    const m = /EBMR-[A-Z]+-\d+/.exec((e as Error).message);
    return `REFUSED ${m ? m[0] : (e as Error).message}`;
  }
}

describe('F32 PERMANENT retention with dependants', () => {
  it('[DI-47][INV-22] a PERMANENT record stays OPEN and cannot be approved for disposal or purged once a record depends on it', async () => {
    const doc = randomUUID();
    const batch = randomUUID();
    const docKey = `component_lot:${doc}`;
    await withCommand(db.app, again(operator), (c) => c.query("insert into stub_b4.lot_record (lot_id, note) values ($1, 'permanent document')", [doc]));
    await withCommand(db.app, again(qa), async (c) => {
      await createRetentionSchedule(c, 'component_lot', doc, 'PERM_DOC', { markets: ['IN'] });
      await createRetentionSchedule(c, 'batch', batch, 'BATCH_PROCESSING_RECORD', PAST_BATCH);
    });

    // Sanity: before any dependency, the PERMANENT record is OPEN (no rule applies) and the batch ended on 2011-01-31.
    const before = await retentionOf(db.app, 'component_lot', doc);
    expect(before.retentionKey).toBe('PERMANENT');
    expect(before.own.status).toBe('NONE');
    expect(before.effective).toMatchObject({ status: 'OPEN', openBecause: [{ recordKey: docKey, reasons: ['NO_RULE_APPLIES'] }] });
    expect((await retentionOf(db.app, 'batch', batch)).effective).toMatchObject({ status: 'DATED', retainUntil: '2011-01-31' });

    // A batch that ended long ago is linked as depending on the PERMANENT record.
    await withCommand(db.app, again(qa), (c) => linkRetentionDependency(c, docKey, `batch:${batch}`, 'USED_BY'));

    const after = await retentionOf(db.app, 'component_lot', doc);
    const approval = await outcome(() => approveDisposal(db, qa2, docKey, 'retention ended'));
    const purged = await outcome(() =>
      withCommand(db.app, withReason(retentionJob, 'RETENTION_ENDED', 'approved disposal'), (c) => purge(c, docKey)),
    );
    const rowsLeft = await scalar<string>(db.app, 'select count(*)::text as v from stub_b4.lot_record where lot_id = $1', [doc]);
    const tombstones = await scalar<string>(db.app, 'select count(*)::text as v from records.tombstone where record_key = $1', [docKey]);

    expect({
      effectiveStatus: after.effective.status,
      effectiveRetainUntil: after.effective.retainUntil,
      approval,
      purged,
      rowsLeft,
      tombstones,
    }).toEqual({
      effectiveStatus: 'OPEN',
      effectiveRetainUntil: null,
      approval: 'REFUSED EBMR-REC-030',
      purged: expect.stringMatching(/^REFUSED EBMR-REC-03\d$/),
      rowsLeft: '1',
      tombstones: '0',
    });
  });
});
