/**
 * Cross-module wiring (kernel 0900, 0910): shared terminals need a current hardening attestation
 * before a session opens, identifiers quoted outside the database are protected against reuse after
 * a restore, and the platform's sample record is signed through the e-signature module (content
 * provider, signed-table registration, the state engine's SIGNATURE hook). The time-fault incident
 * wiring is proven in test/platform/drift-monitor.test.ts.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeHardeningAttestation } from '../../src/continuity/hardening.ts';
import { withCommand } from '../../src/db/command.ts';
import { registerDevice } from '../../src/identity/admin.ts';
import { authenticate } from '../../src/identity/authentication.ts';
import { openSession } from '../../src/identity/sessions.ts';
import { createAggregateState, transition } from '../../src/state/engine.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { attestDevice, SEED_SITE, seedActor, seedAdministration, seedAuthn, withReason, type SeededActor } from '../identity/seed.ts';
import { ensureSealKey, expectRefused, run, signStub, testActor } from '../esig/helpers.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
});
afterAll(async () => {
  await db.drop();
});

describe('shared terminals must be hardened (DI-13)', () => {
  it('[DI-13] a session on a shared kiosk without a hardening attestation (USB storage blocked, kiosk mode) is refused; with one it opens; after revocation it is refused again', async () => {
    const { admin } = await seedAdministration(db);
    const op = await seedActor(db, { withBadge: true, withPin: true, acknowledgeEsig: false });
    const fp = randomBytes(32).toString('hex');
    const deviceId = await withCommand(db.app, withReason(admin), (c) =>
      registerDevice(c, { code: `KSK-${randomBytes(3).toString('hex')}`, deviceClass: 'SHARED', site: SEED_SITE, fingerprint: fp, description: 'unhardened kiosk' }),
    );
    const login = async () => {
      const ev = await authenticate(seedAuthn(db), { method: 'PASSWORD', identifier: op.seed.loginName, secret: op.seed.password, deviceFingerprint: fp, purpose: 'LOGIN' });
      return openSession(db.app, ev.authEventId, fp);
    };
    await expect(login()).rejects.toThrow(/EBMR-CONT-041.*no hardening attestation/);

    const attestation = await attestDevice(db, deviceId, 'SHARED');
    const session = await login();
    expect(session.deviceId).toBe(deviceId);

    await withCommand(db.app, withReason(admin, 'MDM_NON_COMPLIANT', 'USB policy removed by an OS update'), (c) =>
      revokeHardeningAttestation(c, attestation, 'USB policy removed by an OS update'),
    );
    await expect(login()).rejects.toThrow(/EBMR-CONT-041.*revoked/);
  });
});

describe('identifiers protected against reuse after a restore (INV-27)', () => {
  it('[INV-27] incident and DI-investigation numbers, outbox message ids and state-history ids are registered as protected sequences', async () => {
    const { rows } = await db.admin.query<{ sequence_key: string }>('select sequence_key from continuity.protected_sequence order by 1');
    expect(rows.map((r) => r.sequence_key)).toEqual(
      expect.arrayContaining(['records.incident.incident_no', 'records.di_investigation.investigation_no', 'platform.outbox.id', 'platform.state_history.id']),
    );
    const { rows: unprotected } = await db.admin.query<{ sequence_name: string }>('select sequence_name from continuity.unprotected_sequences()');
    expect(unprotected.map((r) => r.sequence_name)).not.toEqual(
      expect.arrayContaining(['records.incident_incident_no_seq']),
    );
  });

  it('[INV-27] the scheduled invariant query finds no unprotected sequence on a correct installation', async () => {
    const { rows } = await db.admin.query<{ sequence_name: string }>('select sequence_name from continuity.unprotected_sequences()');
    expect(rows).toEqual([]);
    const { rows: internal } = await db.admin.query<{ owner_module: string }>(
      "select owner_module from continuity.protected_sequence where sequence_key = 'iam.authn_attempt.id'",
    );
    expect(internal).toEqual([{ owner_module: 'iam' }]);
  });
});

describe('the platform sample record signed through the e-signature module (0910)', () => {
  async function newRecord(author: SeededActor): Promise<string> {
    return run(db, author, async (c) => {
      const { rows } = await c.query<{ id: string }>("insert into platform.stub_record (title, body) values ('Cleaning SOP', 'Version 1 text') returning id");
      const id = rows[0]?.id ?? '';
      await createAggregateState(c, 'sample_record', { aggregateType: 'sample_record', aggregateId: id });
      return id;
    });
  }
  const fire = (actor: SeededActor, id: string, event: string, expectedVersion: number, signatureId?: string, reason?: { reasonCode: string; reasonText: string }) =>
    run(db, actor, (c) => transition(c, { machine: 'sample_record', aggregateType: 'sample_record', aggregateId: id, event, expectedVersion,
                                            ...(signatureId ? { payload: { signature_id: signatureId } } : {}) }), reason ?? {});
  const status = async (signatureId: string) =>
    (await db.admin.query<{ s: { status: string } }>('select esig.signature_state($1) as s', [signatureId])).rows[0]?.s.status;
  const inv09 = async (signatureId: string) =>
    (await db.admin.query("select 1 from esig.invariant_violations() where invariant = 'INV-09' and signature_id = $1", [signatureId])).rows;
  const contentHash = async (id: string) =>
    (await db.admin.query<{ h: string; v: string }>("select c ->> 'content_hash' as h, c ->> 'content_version' as v from esig.content_for_signing('sample_record', $1) c", [id])).rows[0];

  it('[INV-09][DI-37] a save that changes nothing keeps the signature valid; a change supersedes it, recording the content hash the record really has', async () => {
    const author = await testActor(db, { roleCode: 'MBR_AUTHOR' });
    const id = await newRecord(author);
    const sig = await signStub(db, author, id, { meaning: 'PREPARED', aggregateType: 'sample_record', expectedState: 'DRAFT' });
    const signed = await contentHash(id);
    const save = (sql: string) => run(db, author, (c) => c.query(sql, [id]), { reasonCode: 'REWORK', reasonText: 'draft saved' });
    // A save that changes nothing: the content version, the hash and the signature stay as they were.
    await save('update platform.stub_record set title = title, body = body where id = $1');
    expect(await contentHash(id)).toEqual(signed);
    expect(await status(sig.signatureId)).toBe('VALID');
    expect(await inv09(sig.signatureId)).toEqual([]);
    // A change: superseded in the same transaction, with the record's final content hash as evidence.
    await save("update platform.stub_record set body = 'Version 1 text, revised' where id = $1");
    const after = await contentHash(id);
    expect(after?.v).toBe('2');
    expect(await status(sig.signatureId)).toBe('SUPERSEDED_BY_CHANGE');
    const { rows: inval } = await db.admin.query<{ current_content_hash: string }>(
      'select current_content_hash from esig.signature_invalidation where signature_id = $1',
      [sig.signatureId],
    );
    expect(inval).toEqual([{ current_content_hash: after?.h }]);
    expect(await inv09(sig.signatureId)).toEqual([]);
  });

  it('[DI-37][INV-04] a signature from an earlier stay in the same state cannot authorise the transition after the record came back to that state', async () => {
    const author = await testActor(db, { roleCode: 'MBR_AUTHOR' });
    const checker = await testActor(db, { roleCode: 'MBR_CHECKER' });
    const qa = await testActor(db, { roleCode: 'QA_REVIEWER' });
    const id = await newRecord(author);
    await fire(author, id, 'SUBMIT', 1);
    // A CHECKED signature is applied in SUBMITTED, but the check is never fired: QA returns the record.
    const early = await signStub(db, checker, id, { meaning: 'CHECKED', aggregateType: 'sample_record', expectedState: 'SUBMITTED' });
    await fire(qa, id, 'RETURN', 2, undefined, { reasonCode: 'INCOMPLETE', reasonText: 'section 4 missing' });
    await fire(author, id, 'SUBMIT', 3);
    // Same state, same content, yet the unused signature belongs to the earlier submission.
    await expectRefused(fire(checker, id, 'CHECK', 4, early.signatureId), 'EBMR-PLAT-008', /applied before sample_record:.* entered state SUBMITTED at version 4/);
    // A CHECKED signature applied in the current stay is accepted. (The early signer still holds a
    // valid CHECKED signature of this content version, so the e-signature module lets them sign it only
    // once, EBMR-ESIG-042; another checker checks the resubmission.)
    await expectRefused(signStub(db, checker, id, { meaning: 'CHECKED', aggregateType: 'sample_record', expectedState: 'SUBMITTED' }), 'EBMR-ESIG-042');
    const second = await testActor(db, { roleCode: 'MBR_CHECKER' });
    const fresh = await signStub(db, second, id, { meaning: 'CHECKED', aggregateType: 'sample_record', expectedState: 'SUBMITTED' });
    expect(await fire(second, id, 'CHECK', 4, fresh.signatureId)).toMatchObject({ from: 'SUBMITTED', to: 'CHECKED' });
  });
});
