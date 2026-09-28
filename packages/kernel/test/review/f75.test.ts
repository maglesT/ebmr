/**
 * Review reproducer F75: records.create_retention_schedule (0420) accepts any aggregate type except the
 * five retention-machinery types, with any approved record type, and nothing binds a record type to the
 * aggregate types it governs. The retention inputs (dates, market set) are the caller's claim. The
 * disposal-approval content (0720 records.record_disposal_content) shows neither the inputs nor who
 * entered them, so the QA reviewer who invented the dates signs RECORD_DISPOSAL_APPROVED himself.
 * records.purge (0440) then deletes, from every audited table registered with that aggregate type
 * (disabling the insert-only guards), every row whose aggregate column equals the id, and the chain.
 *
 * The batch-number register (site services 0600) is registered as aggregate type batch_number_register
 * with aggregate column site_code. A schedule for batch_number_register:PLANT1 therefore lets a QA
 * reviewer plus the retention job erase every allocation, void and rule of site PLANT1, after which a
 * batch number already issued is accepted again (INV-27: a number is allocated once, ever).
 *
 * Scenario:
 *   1. BATCH_ISSUER registers PLANT1-0001 at PLANT1; a second registration is refused (EBMR-SITE-013).
 *   2. QA_REVIEWER creates a retention schedule for aggregate batch_number_register / PLANT1 under an
 *      approved batch record type, with a manufacture date in 2000 (retain-until in the past).
 *   3. The same QA_REVIEWER signs RECORD_DISPOSAL_APPROVED for it and calls records.approve_purge.
 *   4. The retention job (SERVICE_ACCOUNT, reason code set) calls records.purge.
 *   5. BATCH_ISSUER registers PLANT1-0001 again.
 *
 * Safe behaviour asserted (INV-27, IN-18, DI-47, INV-22): whichever of steps 2-4 refuses, the
 * batch-number register of PLANT1 is untouched (the allocation is still there, no tombstone exists for
 * the register) and PLANT1-0001 is still refused as already allocated. Any refusal on the way is
 * acceptable; only an erased register (and a reissued number) fails the test. Non-EBMR errors (test
 * mistakes) are rethrown so they cannot pass for a refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import type { RetentionInputs } from '../../src/records/retention.ts';
import { createRetentionSchedule, purge } from '../../src/records/retention-store.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import type { SeededActor } from '../identity/seed.ts';
import { again, approveDisposal, recordType, registerType, scalar, signerActor, testActor, withReason } from '../records/helpers.ts';

const SITE = 'PLANT1';
const ZONE = 'Asia/Kolkata';
const NUMBER = 'PLANT1-0001';
const REGISTER_KEY = `batch_number_register:${SITE}`;
// Invented, unverified retention inputs: a batch "manufactured" in 2000 (retain-until long past).
const INVENTED: RetentionInputs = { markets: ['IN'], licenceForm: 'FORM_25', manufactureDate: '2000-01-01' };

let db: TestDatabase;
let issuer: ActorContext;
let qa: SeededActor;
let retentionJob: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  // Any approved record type with retention key BATCH_RECORD.
  await registerType(db, recordType('BATCH_PROCESSING_RECORD'));
  issuer = await testActor(db, { roleCode: 'BATCH_ISSUER', legalName: 'Batch Issuer' });
  qa = await signerActor(db, 'QA_REVIEWER', 'QA Reviewer');
  retentionJob = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'retention job' });
});
afterAll(async () => {
  await db.drop();
});

const registerNumber = () =>
  withCommand(db.app, again(issuer), async (c) => {
    const { rows } = await c.query<{ id: string }>('select site.register_external_batch_number($1::jsonb)::text as id', [
      JSON.stringify({
        batch_number: NUMBER,
        site_code: SITE,
        site_zone: ZONE,
        product_code: 'ATV10',
        product_name: 'Atorvastatin Tablets IP 10 mg',
        edition: 'TABLETS',
        batch_size: '200000',
        batch_size_unit: '{tbl}',
        external_reference: 'SAP PO 4711',
      }),
    ]);
    return rows[0]?.id ?? '';
  });

/** Runs one attack step; an EBMR refusal is logged (safe), anything else is a test mistake and rethrown. */
async function attempt(log: string[], step: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    const r = await fn();
    log.push(`${step}: ACCEPTED ${JSON.stringify(r)}`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/EBMR-[A-Z]+-\d+/.test(msg)) throw e;
    log.push(`${step}: refused (${msg})`);
    return false;
  }
}

describe('F75 retention purge of a kernel control register', () => {
  it('[INV-27][IN-18][DI-47][INV-22] a QA reviewer plus the retention job cannot erase the batch-number register and reissue a batch number', async () => {
    // 1. The number is in the register and is never issued again.
    const allocationId = await registerNumber();
    expect(allocationId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(registerNumber()).rejects.toThrow('EBMR-SITE-013');
    expect(await scalar<string>(db.admin, 'select count(*)::text as v from site.batch_number_allocation where site_code = $1', [SITE])).toBe('1');

    const log: string[] = [];
    // 2. The QA reviewer creates a retention schedule for the site register with invented inputs.
    await attempt(log, 'create_retention_schedule(batch_number_register, PLANT1)', () =>
      withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'batch_number_register', SITE, 'BATCH_PROCESSING_RECORD', INVENTED)),
    );
    // 3. The same QA reviewer signs the disposal approval and approves the purge.
    await attempt(log, 'approve_purge (signed by the same QA reviewer)', () => approveDisposal(db, qa, REGISTER_KEY, 'retention ended'));
    // 4. The retention job purges.
    await attempt(log, 'purge (retention job)', () =>
      withCommand(db.app, withReason(retentionJob, 'RETENTION_ENDED', 'approved disposal'), (c) => purge(c, REGISTER_KEY)),
    );
    const trace = log.join('\n');

    // Safe behaviour: the register of PLANT1 is untouched and the number is still refused (soft, so every
    // broken guarantee is reported).
    expect.soft(
      await scalar<string>(db.admin, 'select count(*)::text as v from site.batch_number_allocation where id = $1', [allocationId]),
      `allocation ${NUMBER} erased from the batch-number register:\n${trace}`,
    ).toBe('1');
    expect.soft(
      await scalar<string>(db.admin, 'select count(*)::text as v from records.tombstone where record_key = $1', [REGISTER_KEY]),
      `batch-number register purged:\n${trace}`,
    ).toBe('0');
    // 5. INV-27: the number is never issued again.
    await expect.soft(registerNumber(), `batch number ${NUMBER} reissued after the purge:\n${trace}`).rejects.toThrow('EBMR-SITE-013');
  });
});
