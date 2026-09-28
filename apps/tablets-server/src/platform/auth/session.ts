/**
 * The opaque session cookie (fix for the cookie collision, J1-1/J2-1; plan section 2):
 *  - a random 256-bit token per login, never the kernel session id (that id appears in audit payloads);
 *  - the database keeps only its SHA-256 (tab.bind_session, tab.resolve_session, tab.unbind_session);
 *  - one cookie name per installation (ebmr_gmp_sid / ebmr_sbx_sid, __Host- on https), HttpOnly,
 *    SameSite=Strict, Path=/, Secure on https.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { SessionView } from '@ebmr/api-contract';
import type { ServerConfig } from '../../config.ts';

export type SessionState = 'ACTIVE' | 'LOCKED' | 'IDLE_LOCKED' | 'ENDED' | 'EXPIRED' | 'UNKNOWN';

export interface ResolvedSession {
  tokenHash: string;
  sessionId: string;
  personId: string;
  accountId: string;
  deviceId: string;
  deviceCode: string;
  deviceClass: 'PERSONAL' | 'SHARED' | 'GRADE_A_B' | 'SERVER' | 'INSTRUMENT';
  siteCode: string;
  roomCode: string | null;
  lineCode: string | null;
  /** The declared role; null until chosen when the account holds several. */
  roleCode: string | null;
  roles: string[];
  state: SessionState;
  legalName: string;
  loginName: string;
  idleTimeoutSeconds: number;
}

export const tokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
export const newSessionToken = (): string => randomBytes(32).toString('base64url');

export function sessionCookieOptions(config: ServerConfig) {
  return { httpOnly: true, sameSite: 'strict' as const, path: '/', secure: config.https };
}

export function setSessionCookie(reply: FastifyReply, config: ServerConfig, token: string): void {
  void reply.setCookie(config.cookies.session, token, sessionCookieOptions(config));
}

export function clearSessionCookie(reply: FastifyReply, config: ServerConfig): void {
  void reply.clearCookie(config.cookies.session, sessionCookieOptions(config));
}

/** The session token hash of a request, from this installation's cookie only. */
export function requestTokenHash(request: FastifyRequest, config: ServerConfig): string | null {
  const token = request.cookies[config.cookies.session];
  return token && /^[A-Za-z0-9_-]{20,128}$/.test(token) ? tokenHash(token) : null;
}

export async function resolveSession(pool: pg.Pool, hash: string): Promise<ResolvedSession | null> {
  const { rows } = await pool.query<{ r: Record<string, unknown> | null }>('select tab.resolve_session($1) as r', [hash]);
  const r = rows[0]?.r;
  if (!r) return null;
  const str = (k: string): string => {
    const v = r[k];
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
  };
  const opt = (k: string): string | null => {
    const v = r[k];
    return typeof v === 'string' ? v : null;
  };
  return {
    tokenHash: hash,
    sessionId: str('session_id'),
    personId: str('person_id'),
    accountId: str('account_id'),
    deviceId: str('device_id'),
    deviceCode: str('device_code'),
    deviceClass: str('device_class') as ResolvedSession['deviceClass'],
    siteCode: str('site_code'),
    roomCode: opt('room_code'),
    lineCode: opt('line_code'),
    roleCode: opt('role_code'),
    roles: Array.isArray(r['roles']) ? (r['roles'] as unknown[]).map(String) : [],
    state: str('state') as SessionState,
    legalName: str('legal_name'),
    loginName: str('login_name'),
    idleTimeoutSeconds: Number(r['idle_timeout_seconds']),
  };
}

export function isShopFloor(deviceClass: string): boolean {
  return deviceClass === 'SHARED' || deviceClass === 'GRADE_A_B';
}

/** SessionView for the browser (plan section 5). */
export function sessionView(session: ResolvedSession, config: ServerConfig, csrfToken: string): SessionView {
  const shopFloor = isShopFloor(session.deviceClass);
  return {
    person: { personId: session.personId, legalName: session.legalName, loginName: session.loginName, role: session.roleCode ?? '' },
    roles: session.roles,
    role: session.roleCode,
    roleChoiceRequired: session.roleCode === null,
    device: {
      deviceCode: session.deviceCode,
      deviceClass: session.deviceClass,
      siteCode: session.siteCode,
      roomCode: session.roomCode,
      lineCode: session.lineCode,
      density: shopFloor ? 'FLOOR' : 'OFFICE',
      loginMethods: shopFloor ? ['BADGE_PIN'] : ['PASSWORD'],
    },
    installation: config.installation,
    locked: session.state === 'LOCKED' || session.state === 'IDLE_LOCKED',
    idleTimeoutSeconds: session.idleTimeoutSeconds,
    csrfToken,
    attribution: shopFloor ? 'TAP' : 'NONE',
  };
}
