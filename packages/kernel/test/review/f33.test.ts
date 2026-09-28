/**
 * Review reproducer F33: one QA reviewer can shorten a record's retention by rewriting its retention
 * inputs (records.update_retention_inputs, 0420) and then give the disposal approval for the shortened
 * date (RECORD_DISPOSAL_APPROVED signature + records.approve_purge, 0440 / 0720). The purge itself then
 * runs under the unattended retention job, so no second person ever looks at the record.
 *
 * Scenario: an EU batch {markets:[IN,EU], expiryDate:2010-01-31} with no QP certification date is OPEN
 * (PENDING_EU_CERTIFICATION). QA reviewer X drops EU from the market set with a reason only, which
 * makes the batch DATED 2011-01-31, then signs and approves its disposal. The retention job purges it.
 *
 * Safe behaviour asserted (DI-47 "Tenants may lengthen retention, never shorten it" and "No user ...
 * can delete a record during retention"; INV-22; DI-37 independence of the disposal approval): the
 * person who changed the inputs that ended an OPEN retention cannot also approve its disposal on their
 * own, so the approval is refused (either the shortening change was refused / held for an independent
 * approval and the record stays OPEN, or approve_purge / the signature refuses X), the purge is refused,
 * and every row of the batch is still there with no tombstone.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import type { RetentionInputs } from '../../src/records/retention.ts';
import { createRetentionSchedule, purge, retentionOf, updateRetentionInputs } from '../../src/records/retention-store.ts';
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
let reviewerX: SeededActor;
let retentionJob: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  await createStubTables(db);
  await registerType(db, recordType('BATCH_PROCESSING_RECORD'));
  operator = await testActor(db, { roleCode: 'OPERATOR' });
  qa = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'QA Reviewer' });
  reviewerX = await signerActor(db, 'QA_REVIEWER', 'QA Reviewer X');
  retentionJob = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'retention job' });
});
afterAll(async () => {
  await db.drop();
});

// An exported EU batch that expired long ago but whose QP certification date was never received.
const EU_BATCH_PENDING_CERT: RetentionInputs = { markets: ['IN', 'EU'], manufactureDate: '2008-01-10', expiryDate: '2010-01-31' };

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

const rowCount = async (batch: string): Promise<string> =>
  scalar<string>(
    db.app,
    'select ((select count(*) from stub_b4.batch_entry where batch_id = $1) + (select count(*) from stub_b4.batch_reading where batch_id = $1))::text as v',
    [batch],
  );

describe('F33 one QA reviewer shortens retention and approves the disposal alone', () => {
  it('[DI-47][INV-22] the person who ended an OPEN retention by changing its inputs cannot alone approve the disposal, and the batch is not purged', async () => {
    const batch = randomUUID();
    const key = `batch:${batch}`;
    const entry = await insertEntry(db, operator, batch, '12.503');
    await correctEntry(db, operator, entry, '12.530');
    await insertReading(db, operator, batch, '7.10');
    // The schedule is created by another QA reviewer (not X).
    await withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'batch', batch, 'BATCH_PROCESSING_RECORD', EU_BATCH_PENDING_CERT));

    // Sanity: the batch is OPEN because the EU certification date is pending; nothing may be disposed of.
    const before = await retentionOf(db.app, 'batch', batch);
    expect(before.effective).toMatchObject({ status: 'OPEN', openBecause: [{ recordKey: key, reasons: ['PENDING_EU_CERTIFICATION'] }] });
    const rowsBefore = await rowCount(batch);
    expect(rowsBefore).toBe('2');

    // QA reviewer X removes EU from the market set, with a reason only.
    const inputChange = await outcome(() =>
      withCommand(db.app, again(reviewerX), (c) => updateRetentionInputs(c, key, { markets: ['IN'] }, 'market set corrected')),
    );
    const afterChange = await retentionOf(db.app, 'batch', batch);

    // The same X signs RECORD_DISPOSAL_APPROVED for the record at its (new) retain-until and approves the purge.
    const approval = await outcome(() => approveDisposal(db, reviewerX, key, 'retention ended'));

    // The unattended retention job purges it.
    const purged = await outcome(() => withCommand(db.app, withReason(retentionJob, 'RETENTION_ENDED', 'approved disposal'), (c) => purge(c, key)));

    const rowsLeft = await rowCount(batch);
    const tombstones = await scalar<string>(db.app, 'select count(*)::text as v from records.tombstone where record_key = $1', [key]);
    const chainEvents = await scalar<string>(db.app, 'select count(*)::text as v from kernel.audit_event where chain_key = $1', [key]);

    expect({
      inputChange,
      effectiveAfterChange: `${afterChange.effective.status} ${afterChange.effective.retainUntil ?? 'open'}`,
      approval: approval.startsWith('REFUSED') ? 'REFUSED' : approval,
      purged: purged.startsWith('REFUSED') ? 'REFUSED' : purged,
      rowsLeft,
      tombstones,
      chainKept: Number(chainEvents) > 0,
    }).toEqual({
      inputChange: expect.any(String),
      effectiveAfterChange: expect.any(String),
      approval: 'REFUSED',
      purged: 'REFUSED',
      rowsLeft: rowsBefore,
      tombstones: '0',
      chainKept: true,
    });
  });
});
