/**
 * Review reproducer F30: a DI investigation of a person whose only act on a record is a signature
 * (verifier, witness, reviewer, approver) never links, holds or blocks the record that was signed.
 *
 *   - records.person_activity (0430) takes the aggregate from split_part(chain_key, ':', 1) of the
 *     person's row-level audit events. A signature row is audited on chain
 *     'esig_signature:<type>:<id>' and its challenge on 'esig_challenge:<type>:<id>' (0220), so the
 *     scope says aggregate 'esig_signature' / 'esig_challenge', never '<type>' / '<id>'.
 *   - records.link_investigation_scope (0430) links and holds 'esig_signature:esig_stub:<id>', not
 *     'esig_stub:<id>'.
 *   - records.open_blockers (0440) blocks '<type>:<id>' only when linked, or when the person has
 *     INSERT/UPDATE/DELETE events on chain '<type>:<id>' in the window; the signer's only event on
 *     that chain is a BUSINESS entry ("signed VERIFIED by ..."), which is filtered out.
 *
 * Safe behaviour asserted (DI-50 behaviour: "Linked records and audit trails go on hold until the
 * investigation closes: no archive purge and no disposal"; catalog_test: "The linked batches cannot be
 * disposed of until the investigation closes"): once an investigation is opened for the verifier over
 * a window in which the verifier signed two entries (one at their own terminal, one as a co-signature
 * at the performer's terminal), each signed entry is linked to the investigation, held, blocked for
 * disposition, and its disposal cannot be approved while the investigation is open.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { investigationScope, openDiInvestigation } from '../../src/records/investigations.ts';
import type { RetentionInputs } from '../../src/records/retention.ts';
import { createRetentionSchedule, openBlockers } from '../../src/records/retention-store.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import type { SeededActor } from '../identity/seed.ts';
import { createStub, ensureSealKey, signStub, testActor as esigActor } from '../esig/helpers.ts';
import { again, allowRetention, approveDisposal, recordType, registerType, signerActor, testActor } from '../records/helpers.ts';

let db: TestDatabase;
let performer: SeededActor;
let verifier: SeededActor;
let investigator: ActorContext;
let qa: SeededActor;

const now = async (): Promise<Date> => (await db.app.query<{ t: Date }>('select clock_timestamp() as t')).rows[0]?.t as Date;
const plusHours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
  await registerType(db, recordType('BATCH_PROCESSING_RECORD'));
  // Setup correction (fix of F29/F75): only aggregate types their module declares for retention can
  // have a schedule. The stub entry stands in for a step record, so this test database declares it.
  await allowRetention(db, 'esig_stub', ['BATCH_RECORD']);
  // Shop-floor terminals with badge and PIN, so the verifier can also co-sign at the performer's terminal.
  performer = await esigActor(db, { deviceClass: 'SHARED', withPin: true, legalName: 'Performer' });
  verifier = await esigActor(db, { roleCode: 'VERIFIER', deviceClass: 'SHARED', withPin: true, legalName: 'Verifier under investigation' });
  investigator = await testActor(db, { roleCode: 'CSV_DI_LEAD', legalName: 'DI investigator' });
  qa = await signerActor(db, 'QA_REVIEWER', 'Head of QA');
});

afterAll(async () => {
  await db.drop();
});

// Retention that ended long ago: India only, expiry 2010-01-31, so kept until 2011-01-31.
const PAST: RetentionInputs = { markets: ['IN'], manufactureDate: '2008-01-10', expiryDate: '2010-01-31' };

describe('F30: a DI investigation holds and blocks the records the person signed', () => {
  it('[DI-50] records whose only involvement of the person is a signature (own terminal or co-signature) are linked, held and blocked', async () => {
    const from = await now();

    // Entry 1: the performer records and signs PERFORMED; the verifier signs VERIFIED at their own terminal.
    const stub1 = await createStub(db, performer, { value: '12.503' });
    await signStub(db, performer, stub1, { meaning: 'PERFORMED', method: 'BADGE_PIN' });
    await signStub(db, verifier, stub1, { meaning: 'VERIFIED', method: 'BADGE_PIN' });

    // Entry 2: the performer records and signs PERFORMED; the verifier co-signs VERIFIED at the performer's terminal.
    const stub2 = await createStub(db, performer, { value: '7.10' });
    await signStub(db, performer, stub2, { meaning: 'PERFORMED', method: 'BADGE_PIN' });
    const cosig = await signStub(db, performer, stub2, { meaning: 'VERIFIED', signer: verifier, method: 'BADGE_PIN' });
    expect(cosig.cosignature).toBe(true);

    // Preconditions: both VERIFIED signatures are the verifier's, and the verifier never wrote the entries' rows.
    const { rows: sigs } = await db.admin.query<{ aggregate_ref: string }>(
      "select aggregate_ref from esig.signature where signer_person = $1 and meaning_code = 'VERIFIED' order by aggregate_ref",
      [verifier.personId],
    );
    expect(sigs.map((r) => r.aggregate_ref).sort()).toEqual([`esig_stub:${stub1}`, `esig_stub:${stub2}`].sort());
    const { rows: direct } = await db.admin.query<{ n: string }>(
      "select count(*)::text as n from kernel.audit_event where chain_key in ($1, $2) and action in ('INSERT','UPDATE','DELETE') and payload -> 'actor' ->> 'person_id' = $3",
      [`esig_stub:${stub1}`, `esig_stub:${stub2}`, verifier.personId],
    );
    expect(direct[0]?.n).toBe('0');

    // The investigator opens a DI investigation of the verifier over the window.
    const id = await withCommand(db.app, again(investigator), (c) =>
      openDiInvestigation(c, {
        subjectPersonId: verifier.personId,
        windowFrom: from,
        windowTo: plusHours(from, 1),
        concern: 'verifications signed without witnessing the weighing',
        qmsReference: 'QMS-INV-F30',
      }),
    );

    // The scoping report does see the verifier's signatures (so the window and person are right).
    const scope = await investigationScope(db.app, id);
    expect(scope.some((s) => s.tableName === 'esig.signature')).toBe(true);

    // Safe behaviour: the signed entries themselves are linked, held and blocked while the investigation is open.
    const { rows: links } = await db.app.query<{ record_key: string }>(
      'select record_key from records.di_investigation_link where investigation_id = $1 order by record_key',
      [id],
    );
    const { rows: holds } = await db.app.query<{ record_key: string }>(
      'select record_key from records.active_hold where investigation_id = $1 order by record_key',
      [id],
    );
    const blockerKinds = async (stub: string) =>
      (await openBlockers(db.app, 'esig_stub', stub))
        .filter((b) => b.blocksDisposition)
        .map((b) => b.kind)
        .sort();

    // Disposal of a signed entry whose retention has ended must be refused while the investigation is open.
    await withCommand(db.app, again(qa), (c) => createRetentionSchedule(c, 'esig_stub', stub1, 'BATCH_PROCESSING_RECORD', PAST));
    let disposal: string;
    try {
      await approveDisposal(db, qa, `esig_stub:${stub1}`, 'retention ended');
      disposal = 'APPROVED during the open investigation';
    } catch (error) {
      disposal = error instanceof Error ? error.message : String(error);
    }

    const observed = {
      scopeAggregates: [...new Set(scope.map((s) => `${s.aggregateType}:${s.aggregateId}`))].sort(),
      links: links.map((r) => r.record_key),
      holds: holds.map((r) => r.record_key),
      blockers: { stub1: await blockerKinds(stub1), stub2: await blockerKinds(stub2) },
      disposal,
    };
    expect(observed).toMatchObject({
      links: expect.arrayContaining([`esig_stub:${stub1}`, `esig_stub:${stub2}`]),
      holds: expect.arrayContaining([`esig_stub:${stub1}`, `esig_stub:${stub2}`]),
      blockers: { stub1: ['DI_INVESTIGATION', 'HOLD'], stub2: ['DI_INVESTIGATION', 'HOLD'] },
      disposal: expect.stringContaining('EBMR-REC-032'),
    });
  });
});
