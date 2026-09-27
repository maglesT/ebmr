import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertDeviceHardened,
  deviceHardeningStatus,
  recordHardeningAttestation,
  revokeHardeningAttestation,
  type HardeningAttestationInput,
} from '../../src/continuity/hardening.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { testActor } from './helpers.ts';

let db: TestDatabase;
let it_admin: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  it_admin = await testActor(db, { roleCode: 'IT_SECURITY', legalName: 'IT Security Officer' });
});
afterAll(async () => {
  await db.drop();
});

function attestation(deviceId: string, over: Partial<HardeningAttestationInput> = {}): HardeningAttestationInput {
  return {
    deviceId,
    deviceClass: 'SHARED',
    usbMassStorageBlocked: true,
    kioskModeEnforced: true,
    malwareProtectionActive: true,
    osPatchWithinSla: true,
    osBuild: '10.0.19045.4529',
    method: 'MDM_COMPLIANCE_REPORT',
    evidenceRef: 'MDM-2026-09-27-KIOSK',
    evidenceSha256: 'a'.repeat(64),
    ...over,
  };
}
const attest = (input: HardeningAttestationInput) => withCommand(db.app, it_admin, (c) => recordHardeningAttestation(c, input));
// Enrolment is modelled by the guard the identity module will call before enrolling a device.
const enrol = (deviceId: string, deviceClass: HardeningAttestationInput['deviceClass']) => assertDeviceHardened(db.app, deviceId, deviceClass);

describe('kiosk hardening before enrolment', () => {
  it('[DI-13] a SHARED or GRADE_A_B device without a hardening attestation cannot be enrolled', async () => {
    await expect(enrol(randomUUID(), 'SHARED')).rejects.toThrow('EBMR-CONT-041');
    await expect(enrol(randomUUID(), 'GRADE_A_B')).rejects.toThrow('EBMR-CONT-041');
    // Personal and server devices are not kiosks.
    await expect(enrol(randomUUID(), 'PERSONAL')).resolves.toBeUndefined();
  });

  it('[DI-13] USB storage on a kiosk is blocked: an attestation that finds USB mass storage enabled fails and blocks enrolment', async () => {
    const kiosk = randomUUID();
    await attest(attestation(kiosk, { usbMassStorageBlocked: false }));
    expect(await deviceHardeningStatus(db.app, kiosk, 'SHARED')).toMatchObject({ required: true, satisfied: false, problem: 'the latest hardening attestation failed' });
    await expect(enrol(kiosk, 'SHARED')).rejects.toThrow(/EBMR-CONT-041 .*failed/);

    await attest(attestation(kiosk));
    await expect(enrol(kiosk, 'SHARED')).resolves.toBeUndefined();
    const row = await db.app.query<{ result: string; usb_mass_storage_blocked: boolean }>(
      'select result, usb_mass_storage_blocked from continuity.device_hardening_attestation where device_id = $1 order by recorded_at',
      [kiosk],
    );
    expect(row.rows).toEqual([
      { result: 'FAIL', usb_mass_storage_blocked: false },
      { result: 'PASS', usb_mass_storage_blocked: true },
    ]);
  });

  it('[DI-13] kiosk mode, malware protection and patch level are required on grade A/B terminals', async () => {
    for (const gap of [{ kioskModeEnforced: false }, { malwareProtectionActive: false }, { osPatchWithinSla: false }]) {
      const terminal = randomUUID();
      await attest(attestation(terminal, { deviceClass: 'GRADE_A_B', ...gap }));
      await expect(enrol(terminal, 'GRADE_A_B')).rejects.toThrow('EBMR-CONT-041');
    }
    // An attestation for another class does not count.
    const terminal = randomUUID();
    await attest(attestation(terminal, { deviceClass: 'SHARED' }));
    await expect(enrol(terminal, 'GRADE_A_B')).rejects.toThrow('EBMR-CONT-041');
  });

  it('[DI-13] a newer failing attestation, a revocation or expiry ends the permission to enrol', async () => {
    const kiosk = randomUUID();
    await attest(attestation(kiosk, { validityDays: 30 }));
    await expect(enrol(kiosk, 'SHARED')).resolves.toBeUndefined();
    const in31days = (await db.app.query<{ t: string }>("select (clock_timestamp() + interval '31 days')::text as t")).rows[0]?.t ?? '';
    expect(await deviceHardeningStatus(db.app, kiosk, 'SHARED', in31days)).toMatchObject({ satisfied: false, problem: 'the latest hardening attestation has expired' });

    const revoked = randomUUID();
    const id = await attest(attestation(revoked));
    await withCommand(db.app, it_admin, (c) => revokeHardeningAttestation(c, id, 'USB policy removed by a local administrator'));
    await expect(enrol(revoked, 'SHARED')).rejects.toThrow(/revoked/);

    const regressed = randomUUID();
    await attest(attestation(regressed));
    await attest(attestation(regressed, { usbMassStorageBlocked: false, method: 'MANUAL_INSPECTION', evidenceRef: 'INSPECTION-77' }));
    await expect(enrol(regressed, 'SHARED')).rejects.toThrow(/failed/);
  });

  it('[DI-13] attestations are recorded only through the attestation function, with a bounded re-attestation interval', async () => {
    await expect(attest(attestation(randomUUID(), { validityDays: 10 }))).rejects.toThrow('EBMR-CONT-040');
    await expect(attest(attestation(randomUUID(), { validityDays: 400 }))).rejects.toThrow('EBMR-CONT-040');
    await expect(attest(attestation(randomUUID(), { evidenceRef: ' ' }))).rejects.toThrow('EBMR-CONT-040');
    await expect(
      db.app.query(
        `insert into continuity.device_hardening_attestation (device_id, device_class, usb_mass_storage_blocked, kiosk_mode_enforced, malware_protection_active,
           os_patch_within_sla, method, evidence_ref, result, valid_until, attested_by_person_id, attested_by_account_id, correlation_id)
         values (gen_random_uuid(), 'SHARED', true, true, true, true, 'MANUAL_INSPECTION', 'x', 'PASS', now() + interval '1 year', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
      ),
    ).rejects.toThrow(/permission denied/);
    // Without a declared actor nothing is recorded.
    await expect(recordHardeningAttestation(db.app, attestation(randomUUID()))).rejects.toThrow('EBMR-CONT-001');
  });
});
