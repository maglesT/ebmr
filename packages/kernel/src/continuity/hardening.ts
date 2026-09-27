/**
 * Shop-floor device hardening attestation (control DI-13; build outline 4.1, 4.7).
 *
 * SHARED and GRADE_A_B devices (kiosks, panel PCs, cleanroom tablets) can be enrolled only while a
 * passing attestation is in force: USB mass storage blocked, kiosk mode enforced, malware protection
 * active, operating system patched within the SLA. The identity module's enrolment calls
 * assertDeviceHardened (wired by the lead).
 */
import type { Db } from './numbers.ts';

export type DeviceClass = 'PERSONAL' | 'SHARED' | 'GRADE_A_B' | 'SERVER';

export interface HardeningAttestationInput {
  deviceId: string;
  deviceClass: DeviceClass;
  usbMassStorageBlocked: boolean;
  kioskModeEnforced: boolean;
  malwareProtectionActive: boolean;
  osPatchWithinSla: boolean;
  osBuild?: string;
  method: 'MDM_COMPLIANCE_REPORT' | 'MANUAL_INSPECTION';
  evidenceRef: string;
  evidenceSha256?: string;
  /** Re-attestation interval, 30-365 days (default 180). */
  validityDays?: number;
}

export interface HardeningStatus {
  required: boolean;
  satisfied: boolean;
  attestationId: string | null;
  validUntil: Date | null;
  problem: string | null;
}

/** Record an attestation inside a command (the client has already called kernel.begin_command). */
export async function recordHardeningAttestation(client: Db, input: HardeningAttestationInput): Promise<string> {
  const { rows } = await client.query<{ id: string }>('select continuity.record_hardening_attestation($1::jsonb)::text as id', [
    JSON.stringify({
      device_id: input.deviceId,
      device_class: input.deviceClass,
      usb_mass_storage_blocked: input.usbMassStorageBlocked,
      kiosk_mode_enforced: input.kioskModeEnforced,
      malware_protection_active: input.malwareProtectionActive,
      os_patch_within_sla: input.osPatchWithinSla,
      os_build: input.osBuild ?? null,
      method: input.method,
      evidence_ref: input.evidenceRef,
      evidence_sha256: input.evidenceSha256 ?? null,
      validity_days: input.validityDays ?? null,
    }),
  ]);
  return rows[0]?.id ?? '';
}

export async function revokeHardeningAttestation(client: Db, attestationId: string, reason: string): Promise<void> {
  await client.query('select continuity.revoke_hardening_attestation($1, $2)', [attestationId, reason]);
}

/** Status now, or as of an ISO 8601 instant (for planning re-attestation). */
export async function deviceHardeningStatus(db: Db, deviceId: string, deviceClass: DeviceClass, at?: string): Promise<HardeningStatus> {
  const { rows } = await db.query<{ required: boolean; satisfied: boolean; attestation_id: string | null; valid_until: Date | null; problem: string | null }>(
    'select required, satisfied, attestation_id::text, valid_until, problem from continuity.device_hardening_status($1, $2, coalesce($3::timestamptz, clock_timestamp()))',
    [deviceId, deviceClass, at ?? null],
  );
  const r = rows[0];
  if (!r) throw new Error('device_hardening_status returned no row');
  return { required: r.required, satisfied: r.satisfied, attestationId: r.attestation_id, validUntil: r.valid_until, problem: r.problem };
}

/** Enrolment guard: rejects (EBMR-CONT-041) unless the device class needs no attestation or a valid one exists. */
export async function assertDeviceHardened(db: Db, deviceId: string, deviceClass: DeviceClass): Promise<void> {
  await db.query('select continuity.assert_device_hardened($1, $2)', [deviceId, deviceClass]);
}
