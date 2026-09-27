/**
 * Detection of forged, copied or transplanted signatures (DI-37 catalog test; ADR 0012 decision 8
 * "detected" bypass class), seal-key agility, INV-27 (signature IDs are never reused) and the DI-13
 * non-repudiation evidence package.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerSealKey, retireSealKey } from '../../src/esig/catalogue.ts';
import { evidencePackage, verifySignatures } from '../../src/esig/integrity.ts';
import { createSealKeyRing, generateEd25519SealKey } from '../../src/esig/keys.ts';
import { assertSignature, signatureState } from '../../src/esig/signing.ts';
import { seedAdministration } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import {
  TEST_KEY_ID,
  asSuperuserTransaction,
  correctStub,
  createStub,
  dbCount,
  ensureSealKey,
  expectPermissionDenied,
  expectRefused,
  run,
  signStub,
  testActor,
  testKeyRing,
} from './helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
});

afterAll(async () => {
  await db.drop();
});

/** Runs SQL as a superuser with every trigger (including foreign-key checks) off: an attacker with database control. */
async function asAttacker(sql: string, params: unknown[] = []): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('set session_replication_role = replica');
    await c.query(sql, params);
  } finally {
    await c.query('set session_replication_role = origin');
    c.release();
  }
}

const problemsOf = async (signatureId: string): Promise<string[]> =>
  (await verifySignatures(db.app, testKeyRing)).filter((p) => p.signatureId === signatureId).map((p) => p.problem.split(':')[0] ?? p.problem);

describe('the integrity job', () => {
  it('[DI-37][INV-10] valid, co-signed and superseded signatures raise no integrity problem', async () => {
    const op = await testActor(db);
    const verifier = await testActor(db, { roleCode: 'VERIFIER' });
    const id = await createStub(db, op);
    await signStub(db, op, id, { meaning: 'PERFORMED' });
    await signStub(db, verifier, id, { meaning: 'VERIFIED' });
    await correctStub(db, op, id, '11.0');
    await signStub(db, op, id, { meaning: 'PERFORMED' });
    const kiosk = await testActor(db, { deviceClass: 'SHARED', withPin: true });
    const kioskVerifier = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'SHARED', withPin: true });
    const k = await createStub(db, kiosk);
    await signStub(db, kiosk, k, { meaning: 'VERIFIED', signer: kioskVerifier, method: 'BADGE_PIN' });
    expect(await verifySignatures(db.app, testKeyRing)).toEqual([]);
    expect((await db.app.query('select * from esig.invariant_violations()')).rows).toEqual([]);
  });

  it('[DI-37] copy a signature row to another record in a test database: the integrity check fails', async () => {
    const op = await testActor(db);
    const a = await createStub(db, op, { value: '5.00' });
    const b = await createStub(db, op, { value: '5.00' }); // identical content: only the record differs
    const sig = await signStub(db, op, a, { meaning: 'PERFORMED' });
    const copy = randomUUID();
    await asAttacker(`
      insert into esig.signature
      select $2::uuid, aggregate_type, $3, 'esig_stub:' || $3, content_version, content_hash, meaning_code, meaning_version, meaning_title,
             meaning_text, signer_person, signer_account, signer_login, signer_legal_name, signer_role_code, signer_role_name, session_id,
             session_person, cosignature, device_id, gen_random_uuid(), auth_method, components_used, components_required,
             authority_evaluation_id, delegation_id, gen_random_uuid(), correlation_id, site_zone, utc_offset, witness,
             jsonb_set(manifestation, '{record,aggregate_id}', to_jsonb($3::text)), manifestation_text, recorded_at
      from esig.signature where id = $1;
      insert into esig.signature_seal select $2::uuid, 'esig_stub:' || $3, key_id, algorithm, payload_sha256, seal, recorded_at
      from esig.signature_seal where signature_id = $1;`.replace(/\$([123])/g, (_m, n: string) => `'${[sig.signatureId, copy, b][Number(n) - 1]}'`));
    const problems = await problemsOf(copy);
    expect(problems).toEqual(expect.arrayContaining([
      'ID_NOT_REGISTERED', 'SEAL_PAYLOAD_MISMATCH', 'MANIFESTATION_MISMATCH', 'CHALLENGE_MISMATCH', 'AUTH_EVENT_MISMATCH',
      'AUDIT_EVENT_MISSING', 'CONTENT_CHANGED_WITHOUT_INVALIDATION', 'SEAL_INVALID',
    ]));
    // No path accepts the copy as B's signature, and the original stays valid.
    expect((await signatureState(db.app, copy)).valid).toBe(false);
    await expectRefused(assertSignature(db.app, copy, 'PERFORMED', 'esig_stub', b), 'EBMR-ESIG-070');
    await expectRefused(assertSignature(db.app, sig.signatureId, 'PERFORMED', 'esig_stub', b), 'EBMR-ESIG-070', /never transferred/);
    expect((await signatureState(db.app, sig.signatureId)).valid).toBe(true);
    const inv = await db.app.query<{ invariant: string }>('select invariant from esig.invariant_violations() where signature_id = $1', [copy]);
    expect(inv.rows.map((r) => r.invariant).sort()).toEqual(['INV-09', 'INV-10', 'INV-27']);
  });

  it('[DI-37] a signature moved to another record, even with its seal digest recomputed, is caught by the seal check', async () => {
    const op = await testActor(db);
    const a = await createStub(db, op);
    const b = await createStub(db, op);
    const sig = await signStub(db, op, a, { meaning: 'PERFORMED' });
    await asAttacker(`update esig.signature set aggregate_id = '${b}', aggregate_ref = 'esig_stub:${b}',
                        manifestation = jsonb_set(manifestation, '{record,aggregate_id}', to_jsonb('${b}'::text)),
                        content_hash = (select esig.content_hash_of('esig_stub', '${b}', esig.provide('esig_stub', '${b}')))
                      where id = '${sig.signatureId}'`);
    // The attacker also recomputes everything the database can recompute without the key.
    await asAttacker(`update esig.signature_seal set aggregate_ref = 'esig_stub:${b}', payload_sha256 = esig.sha256_hex(esig.seal_payload(signature_id))
                      where signature_id = '${sig.signatureId}'`);
    const problems = await problemsOf(sig.signatureId);
    expect(problems).toContain('SEAL_INVALID');
    expect(problems).toContain('CHALLENGE_MISMATCH');
    expect(problems).toContain('AUDIT_EVENT_MISSING');
    expect(problems).not.toContain('SEAL_PAYLOAD_MISMATCH');
  });

  it('[INV-10] a seal made with a key outside the trusted key ring is reported', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const rogue = generateEd25519SealKey('rogue-ed25519-1');
    const { admin } = await seedAdministration(db);
    await run(db, admin, (c) => registerSealKey(c, rogue, 'key registered by someone else'));
    const sig = await signStub(db, op, id, { meaning: 'PERFORMED', key: rogue });
    expect(await problemsOf(sig.signatureId)).toEqual(['SEAL_KEY_UNTRUSTED']);
  });
});

describe('INV-27: signature IDs are never reused', () => {
  it('[INV-27] signature IDs are random version-4 UUIDs chosen by the database, never by a caller, and each is registered for good', async () => {
    const op = await testActor(db);
    const sigs = [];
    for (let i = 0; i < 3; i += 1) sigs.push(await signStub(db, op, await createStub(db, op), { meaning: 'PERFORMED' }));
    for (const s of sigs) {
      expect(s.signatureId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(await dbCount(db, 'select 1 from esig.signature_id_register where signature_id = $1', [s.signatureId])).toBe(1);
    }
    // No sequence or default can hand out an ID: the insert guard draws a fresh one from the strong random generator.
    const col = await db.admin.query<{ d: string | null; ident: string }>(
      "select column_default as d, is_identity as ident from information_schema.columns where table_schema = 'esig' and table_name = 'signature' and column_name = 'id'");
    expect(col.rows[0]).toEqual({ d: null, ident: 'NO' });
  });

  it('[INV-27] bypass: an issued ID can never be freed or issued again, not even by the table owner', async () => {
    const op = await testActor(db);
    const sig = await signStub(db, op, await createStub(db, op), { meaning: 'PERFORMED' });
    await expectPermissionDenied(db.app.query('delete from esig.signature_id_register where signature_id = $1', [sig.signatureId]));
    await expectPermissionDenied(db.app.query('insert into esig.signature_id_register (signature_id) values ($1)', [randomUUID()]));
    await asSuperuserTransaction(db, async (c) => {
      await c.query('set local role ebmr_owner');
      await c.query('savepoint s');
      await expectRefused(c.query('delete from esig.signature_id_register where signature_id = $1', [sig.signatureId]), 'EBMR-ESIG-001');
      await c.query('rollback to savepoint s');
      await expect(c.query('insert into esig.signature_id_register (signature_id) values ($1)', [sig.signatureId])).rejects.toThrow(/duplicate key/);
    });
    // Even if the signature row were removed (a purge), its ID stays in the register and cannot be issued again.
    await asAttacker(`delete from esig.signature_seal where signature_id = '${sig.signatureId}'; delete from esig.signature where id = '${sig.signatureId}'`);
    expect(await dbCount(db, 'select 1 from esig.signature_id_register where signature_id = $1', [sig.signatureId])).toBe(1);
    await asSuperuserTransaction(db, async (c) => {
      await expect(c.query('insert into esig.signature_id_register (signature_id) values ($1)', [sig.signatureId])).rejects.toThrow(/duplicate key/);
    });
  });
});

describe('DI-13: non-repudiation evidence package', () => {
  it('[DI-13] for a sampled signature the evidence package can be produced: identity verification, authentication event, manifestation, audit trail and seal', async () => {
    const verifier = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'SHARED', withPin: true, legalName: 'Evidence Verifier' });
    const kiosk = await testActor(db, { deviceClass: 'SHARED', withPin: true });
    const id = await createStub(db, kiosk);
    await signStub(db, kiosk, id, { meaning: 'PERFORMED', method: 'BADGE_PIN' });
    const sig = await signStub(db, kiosk, id, { meaning: 'VERIFIED', signer: verifier, method: 'BADGE_PIN' });
    const { package: p, sealVerification, problems } = await evidencePackage(db.app, sig.signatureId, testKeyRing);
    expect(problems).toEqual([]);
    expect(sealVerification).toMatchObject({ result: 'VALID', keyId: TEST_KEY_ID, algorithm: 'HMAC-SHA256' });
    expect(p['format']).toBe('ebmr-esig-evidence-v1');
    expect(p['signature']).toMatchObject({ id: sig.signatureId, signer_person: verifier.personId, meaning_code: 'VERIFIED', cosignature: true });
    expect(p['manifestation']).toMatchObject({ printed_name: 'Evidence Verifier', meaning_code: 'VERIFIED', site_zone: 'Asia/Kolkata' });
    expect(p['status']).toMatchObject({ status: 'VALID', valid: true });
    expect(p['authentication_event']).toMatchObject({
      person_id: verifier.personId, method: 'BADGE_PIN', components: ['BADGE', 'PIN'], purpose: 'SIGNATURE', credential_kinds: ['PIN'],
      device: { id: kiosk.deviceId, class: 'SHARED' },
    });
    expect((p['authentication_event'] as { uses: { use: string }[] }).uses.map((u) => u.use)).toEqual(['SIGNATURE']);
    expect(p['identity_verification']).toMatchObject({ method: 'IN_PERSON_DOCUMENT', purpose: 'INITIAL' });
    expect(p['signer_as_at_signing']).toMatchObject({ legal_name: 'Evidence Verifier', person_id: verifier.personId });
    expect(p['authority_evaluation']).toMatchObject({ allowed: true, permission_code: 'STEP.VERIFY', person_id: verifier.personId });
    expect((p['segregation_evaluations'] as { rule_code: string; allowed: boolean }[]).map((s) => [s.rule_code, s.allowed])).toEqual([['INV-03', true]]);
    expect(p['seal']).toMatchObject({ key_id: TEST_KEY_ID, payload_matches: true });
    const audit = p['audit_trail'] as Record<string, { chain_key: string; events: { action: string; table: string | null }[]; verification_problems: unknown[] }>;
    expect(audit['record_chain']?.chain_key).toBe(`esig_stub:${id}`);
    expect(audit['record_chain']?.verification_problems).toEqual([]);
    expect(audit['record_chain']?.events.map((e) => e.action)).toEqual(['INSERT', 'BUSINESS', 'BUSINESS']);
    expect(audit['signature_chain']?.verification_problems).toEqual([]);
    expect(audit['signature_chain']?.events.map((e) => e.table)).toEqual(['esig.signature', 'esig.signature_seal', 'esig.signature', 'esig.signature_seal']);
    // Without secrets: no password, verifier hash or badge UID, and no field that could hold a secret.
    const text = JSON.stringify(p);
    for (const secret of [verifier.seed.password, verifier.seed.badgeUid ?? 'no-badge', '$argon2id$']) expect(text).not.toContain(secret);
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    walk(p);
    expect(keys.filter((k) => /secret|verifier$|password|pin$|uid_hash/i.test(k))).toEqual([]);
  });

  it('[DI-13] the package of a superseded signature shows the invalidation and the change that caused it', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const sig = await signStub(db, op, id, { meaning: 'PERFORMED' });
    await correctStub(db, op, id, '9.9');
    const { package: p, problems } = await evidencePackage(db.app, sig.signatureId, testKeyRing);
    expect(problems).toEqual([]);
    expect(p['status']).toMatchObject({ status: 'SUPERSEDED_BY_CHANGE', valid: false });
    expect(p['invalidation']).toMatchObject({ reason: 'SUPERSEDED_BY_CHANGE', person_id: op.personId });
    await expectRefused(db.app.query('select esig.evidence_package($1)', [randomUUID()]), 'EBMR-ESIG-070');
  });
});

// Runs last: it retires the shared test key.
describe('seal-key agility', () => {
  it('[DI-37] Ed25519 and HMAC seals verify side by side; a retired key seals nothing new, its old seals still verify', async () => {
    const op = await testActor(db);
    const ed = generateEd25519SealKey('site1-ed25519-2026');
    const { admin } = await seedAdministration(db);
    await run(db, admin, (c) => registerSealKey(c, ed, 'site signing key 2026 (demo)'));
    const ring = createSealKeyRing([{ keyId: 'site1-ed25519-2026', algorithm: 'ED25519', publicKeyPem: ed.publicKeyPem }]);
    const edSig = await signStub(db, op, await createStub(db, op), { meaning: 'PERFORMED', key: ed });
    const pkg = await evidencePackage(db.app, edSig.signatureId, ring);
    expect(pkg.sealVerification).toMatchObject({ keyId: 'site1-ed25519-2026', algorithm: 'ED25519', result: 'VALID' });
    const oldHmac = await signStub(db, op, await createStub(db, op), { meaning: 'PERFORMED' });
    await run(db, admin, (c) => retireSealKey(c, TEST_KEY_ID, 'rotation to Ed25519'), { reasonCode: 'KEY_ROTATION' });
    await expectRefused(signStub(db, op, await createStub(db, op), { meaning: 'PERFORMED' }), 'EBMR-ESIG-063');
    expect((await evidencePackage(db.app, oldHmac.signatureId, testKeyRing)).sealVerification?.result).toBe('VALID');
    expect((await evidencePackage(db.app, oldHmac.signatureId, testKeyRing)).package['seal']).toMatchObject({ key: { retired: true } });
  });
});
