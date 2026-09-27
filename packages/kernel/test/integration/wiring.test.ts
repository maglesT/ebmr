/**
 * Cross-module wiring (kernel 0900): shared terminals need a current hardening attestation before a
 * session opens, and identifiers quoted outside the database are protected against reuse after a
 * restore. The time-fault incident wiring is proven in test/platform/drift-monitor.test.ts.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeHardeningAttestation } from '../../src/continuity/hardening.ts';
import { withCommand } from '../../src/db/command.ts';
import { registerDevice } from '../../src/identity/admin.ts';
import { authenticate } from '../../src/identity/authentication.ts';
import { openSession } from '../../src/identity/sessions.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { attestDevice, SEED_SITE, seedActor, seedAdministration, seedAuthn, withReason } from '../identity/seed.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
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
});
