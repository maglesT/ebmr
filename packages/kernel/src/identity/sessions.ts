/**
 * Devices and server-side sessions (DI-20, DI-38 session rules; outline 4.7; ADR 0006 item 8).
 *
 * The device is identified by the SHA-256 fingerprint of its enrolled key or client certificate,
 * which the TLS layer presents; class, site and room come from the registry, never from the client.
 * Sessions are opened from a LOGIN authentication event on the same device, lock after the idle
 * timeout of their device class (kiosks: default 5 minutes), end at the absolute timeout, and a
 * login on a shop-floor device ends the person's other shop-floor session.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { IdentityError } from './errors.ts';

type Queryable = pg.Pool | pg.PoolClient;

const text = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);

export type DeviceClass = 'PERSONAL' | 'SHARED' | 'GRADE_A_B' | 'SERVER' | 'INSTRUMENT';

export interface DeviceInfo {
  deviceId: string;
  code: string;
  deviceClass: DeviceClass;
  siteCode: string;
  roomCode: string | null;
  lineCode: string | null;
}

export interface SessionInfo {
  sessionId: string;
  personId: string;
  accountId: string;
  deviceId: string;
  deviceClass: DeviceClass;
  siteCode: string;
  roomCode: string | null;
  idleTimeoutSeconds: number;
  absoluteTimeoutSeconds: number;
}

export type SessionState = 'ACTIVE' | 'LOCKED' | 'IDLE_LOCKED' | 'ENDED' | 'EXPIRED' | 'UNKNOWN';

/** SHA-256 fingerprint (lower-case hex) of a DER-encoded certificate or public key. */
export function deviceFingerprint(der: Uint8Array): string {
  return createHash('sha256').update(der).digest('hex');
}

/** Resolve the device behind a TLS fingerprint. Unknown or blocked devices are refused (and alerted). */
export async function resolveDevice(db: Queryable, fingerprint: string): Promise<DeviceInfo> {
  const { rows } = await db.query<{ r: Record<string, string | boolean | null> }>('select iam.resolve_device($1) as r', [fingerprint]);
  const r = rows[0]?.r;
  if (!r || r['accepted'] !== true) {
    throw new IdentityError(text(r?.['code'], 'EBMR-IAM-070'), `device refused (${text(r?.['reason'], 'UNREGISTERED_DEVICE')})`);
  }
  return {
    deviceId: String(r['device_id']),
    code: String(r['code']),
    deviceClass: r['device_class'] as DeviceClass,
    siteCode: String(r['site_code']),
    roomCode: (r['room_code'] as string | null) ?? null,
    lineCode: (r['line_code'] as string | null) ?? null,
  };
}

/** DI-20 location binding: refuse (and alert) data from a device registered to another room or line. */
export async function assertDeviceLocation(db: Queryable, deviceId: string, room: string | null, line: string | null = null): Promise<void> {
  const { rows } = await db.query<{ r: Record<string, unknown> }>('select iam.check_device_location($1, $2, $3) as r', [deviceId, room, line]);
  const r = rows[0]?.r;
  if (!r || r['accepted'] !== true) {
    throw new IdentityError(text(r?.['code'], 'EBMR-IAM-073'), `device refused for this location (${text(r?.['reason'], 'UNKNOWN')})`);
  }
}

export async function openSession(db: Queryable, authEventId: string, fingerprint: string): Promise<SessionInfo> {
  const { rows } = await db.query<{ r: Record<string, string | number | null> }>('select iam.open_session($1, $2) as r', [authEventId, fingerprint]);
  const r = rows[0]?.r;
  if (!r) throw new IdentityError('EBMR-IAM-080', 'no session was opened');
  return {
    sessionId: String(r['session_id']),
    personId: String(r['person_id']),
    accountId: String(r['account_id']),
    deviceId: String(r['device_id']),
    deviceClass: r['device_class'] as DeviceClass,
    siteCode: String(r['site_code']),
    roomCode: (r['room_code'] as string | null) ?? null,
    idleTimeoutSeconds: Number(r['idle_timeout_seconds']),
    absoluteTimeoutSeconds: Number(r['absolute_timeout_seconds']),
  };
}

export async function sessionState(db: Queryable, sessionId: string): Promise<SessionState> {
  const { rows } = await db.query<{ s: SessionState }>('select iam.session_state($1) as s', [sessionId]);
  return rows[0]?.s ?? 'UNKNOWN';
}

export async function lockSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query('select iam.lock_session($1)', [sessionId]);
}

/** Unlock with a fresh SESSION_UNLOCK authentication of the session's own person on the same device. */
export async function unlockSession(db: Queryable, sessionId: string, authEventId: string): Promise<void> {
  await db.query('select iam.unlock_session($1, $2)', [sessionId, authEventId]);
}

/** Extend before the idle lock; shop-floor devices need a badge tap (COMMAND authentication event). */
export async function keepSessionAlive(db: Queryable, sessionId: string, authEventId?: string): Promise<void> {
  await db.query('select iam.keep_session_alive($1, $2)', [sessionId, authEventId ?? null]);
}

export async function endSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query('select iam.end_session($1)', [sessionId]);
}
