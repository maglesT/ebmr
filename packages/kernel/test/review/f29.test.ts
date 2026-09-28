/**
 * Review reproducer F29: a retention schedule can be put on any aggregate type, so the e-signatures
 * of a record can be scheduled, approved for disposal and purged on their own while the record they
 * sign is still retained.
 *
 *   - records.create_retention_schedule (0420) refuses only the retention machinery
 *     ('retention', 'retention_rule_set', 'record_hold', 'tombstone', 'true_copy'); the record type
 *     code is not tied to the aggregate type and the retention inputs are free.
 *   - records.purge (0440) deletes, for the schedule's aggregate type, the rows of every registered
 *     table (kernel.audited_table), disabling each insert-only guard. esig.signature,
 *     esig.signature_seal and esig.signature_invalidation are registered under aggregate type
 *     'esig_signature' keyed on aggregate_ref ('<type>:<id>' of the signed record) (0220).
 *
 * Safe behaviour asserted (outline 3.3.6 "audit trails and signatures follow their record", DI-47
 * "signature records at least as long as their subject record", Part 11.70): the signatures of a
 * record that is still retained survive any attempt to schedule, approve and purge them on their
 * own. Whether the refusal comes at scheduling, at the disposal approval or at the purge does not
 * matter; losing the signatures does.
 *
 * Two subjects, both still present and not scheduled for disposal themselves:
 *   1. a signed stub entry (esig_stub, the stand-in for steps and logbook entries), with a PERFORMED
 *      and a VERIFIED signature;
 *   2. the approval signature (RECORD_TYPE_APPROVED) of a record-type version in force in the
 *      record register (records.record_type_approval.approval_signature_id).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import type { RetentionInputs } from '../../src/records/retention.ts';
import { createRetentionSchedule, purge } from '../../src/records/retention-store.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import type { SeededActor } from '../identity/seed.ts';
import { createStub, ensureSealKey, signStub, testActor as esigActor } from '../esig/helpers.ts';
import { again, approveDisposal, recordType, registerType, signerActor, testActor, withReason } from '../records/helpers.ts';

let db: TestDatabase;
let qa: ActorContext;
let qa2: SeededActor;
let retentionJob: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
  await registerType(db, recordType('BATCH_PROCESSING_RECORD'));
  await registerType(db, recordType('F29_SIGNED_REGISTER_TYPE', { retentionKey: 'SUPPORTING_RECORD' }));
  // One QA reviewer holding RECORD.RETENTION_MANAGE and RECORD.DISPOSAL_APPROVE, and the retention job (RECORD.PURGE).
  qa = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'QA Reviewer' });
  qa2 = await signerActor(db, 'QA_REVIEWER', 'QA Manager');
  retentionJob = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'retention job' });
});

afterAll(async () => {
  await db.drop();
});

// Retention that ended long ago: India only, expiry 2010-01-31, so kept until 2011-01-31.
const PAST: RetentionInputs = { markets: ['IN'], manufactureDate: '2008-01-10', expiryDate: '2010-01-31' };

interface Attempt {
  scheduled: boolean;
  approved: boolean;
  purged: boolean;
  refusal: string | null;
}

/**
 * Schedules 'esig_signature:<subjectRef>' on its own, approves its disposal (a RECORD_DISPOSAL_APPROVED
 * signature by the QA reviewer, then records.approve_purge) and runs the retention job's purge.
 * Any refusal stops the attempt and is returned.
 */
async function purgeSignaturesOf(subjectRef: string): Promise<Attempt> {
  const attempt: Attempt = { scheduled: false, approved: false, purged: false, refusal: null };
  const key = `esig_signature:${subjectRef}`;
  try {
    await withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'esig_signature', subjectRef, 'BATCH_PROCESSING_RECORD', PAST));
    attempt.scheduled = true;
    await approveDisposal(db, qa2, key, 'retention ended; signature records no longer needed');
    attempt.approved = true;
    await withCommand(db.app, withReason(retentionJob, 'RETENTION_ENDED', 'approved disposal'), (c) => purge(c, key));
    attempt.purged = true;
  } catch (error) {
    attempt.refusal = error instanceof Error ? error.message : String(error);
  }
  return attempt;
}

const count = async (sql: string, params: unknown[]): Promise<number> => {
  const { rows } = await db.admin.query<{ n: string }>(`select count(*)::text as n from (${sql}) x`, params);
  return Number(rows[0]?.n ?? '0');
};

describe('F29: signatures follow their record; they cannot be scheduled and purged on their own', () => {
  it('[DI-47][INV-22][DI-37] the signatures of a retained record survive a schedule, disposal approval and purge aimed at esig_signature:<record>', async () => {
    // --- Subject 1: a signed stub entry, PERFORMED by the operator and VERIFIED by an independent verifier.
    const operator = await esigActor(db);
    const verifier = await esigActor(db, { roleCode: 'VERIFIER' });
    const stub = await createStub(db, operator);
    await signStub(db, operator, stub, { meaning: 'PERFORMED' });
    await signStub(db, verifier, stub, { meaning: 'VERIFIED' });
    const stubRef = `esig_stub:${stub}`;
    const stubSignatures = () => count('select 1 from esig.signature where aggregate_ref = $1', [stubRef]);
    const stubSeals = () => count('select 1 from esig.signature_seal where aggregate_ref = $1', [stubRef]);
    const shownSignatures = async () => (await db.app.query('select * from esig.record_signatures($1, $2)', ['esig_stub', stub])).rowCount ?? 0;
    const stubExists = () => count('select 1 from esig.stub_signable where id = $1', [stub]);
    expect({ signatures: await stubSignatures(), seals: await stubSeals(), shown: await shownSignatures(), stubRow: await stubExists() }).toEqual({
      signatures: 2,
      seals: 2,
      shown: 2,
      stubRow: 1,
    });

    // --- Subject 2: the approval signature of a record-type version in force in the register.
    const { rows: reg } = await db.app.query<{ version: string; approval_signature_id: string }>(
      "select version::text as version, approval_signature_id::text as approval_signature_id from records.record_register where code = 'F29_SIGNED_REGISTER_TYPE'",
    );
    const version = reg[0]?.version ?? '';
    const approvalSignature = reg[0]?.approval_signature_id ?? '';
    const registerRef = `record_type_version:F29_SIGNED_REGISTER_TYPE:${version}`;
    const approvalSignatureRows = () => count('select 1 from esig.signature where id = $1 and aggregate_ref = $2', [approvalSignature, registerRef]);
    expect(await approvalSignatureRows()).toBe(1);

    // --- The attack: schedule the signatures on their own, approve their disposal, purge them.
    const onStub = await purgeSignaturesOf(stubRef);
    const onRegister = await purgeSignaturesOf(registerRef);

    // The signed records are still there (nothing scheduled them for disposal) ...
    expect(await stubExists()).toBe(1);
    expect(await count("select 1 from records.record_register where code = 'F29_SIGNED_REGISTER_TYPE'", [])).toBe(1);

    // ... so their signatures must still be there too, whatever step refused the attempt.
    expect({
      stub: { attempt: onStub, signatures: await stubSignatures(), seals: await stubSeals(), shown: await shownSignatures() },
      register: { attempt: onRegister, approvalSignatureRows: await approvalSignatureRows() },
    }).toMatchObject({
      stub: { attempt: { purged: false }, signatures: 2, seals: 2, shown: 2 },
      register: { attempt: { purged: false }, approvalSignatureRows: 1 },
    });
  });
});
