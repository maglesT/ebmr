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
import { refusal } from '../http/refusal.ts';

/** ROLE_WITHDRAWN (tablets 0400, review F36): the role the session works in is no longer granted to its account. */
export type SessionState = 'ACTIVE' | 'LOCKED' | 'IDLE_LOCKED' | 'ENDED' | 'EXPIRED' | 'UNKNOWN' | 'ROLE_WITHDRAWN';

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
  /** The declared role; null until chosen when the account holds several, and once it is withdrawn. */
  roleCode: string | null;
  /** The role the session declared, also when it is withdrawn (to say why the session ends). */
  declaredRole: string | null;
  roles: string[];
  state: SessionState;
  legalName: string;
  loginName: string;
  idleTimeoutSeconds: number;
  /** Per-entry attribution on this device (decision D8; C1's tab.attribution_method_for): NONE off the shop floor. */
  attributionMethod: 'NONE' | 'TAP' | 'TAP_PIN';
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

/**
 * How many cookies of this name the request carries, counted on the raw Cookie header(s) as the browser sent them (the
 * cookie parser keeps only the first). A name before the first `=` of each pair, as the parser reads it.
 */
export function cookieCount(headers: FastifyRequest['headers'], name: string): number {
  const raw: unknown = headers.cookie;
  const all: string[] = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  let count = 0;
  for (const header of all) {
    for (const pair of header.split(';')) {
      const eq = pair.indexOf('=');
      if (eq >= 0 && pair.slice(0, eq).trim() === name) count += 1;
    }
  }
  return count;
}

/**
 * The session token hash of a request, from this installation's cookie only. A request that carries the cookie more
 * than once (a copy another page of the host set, review F41) has no session: never the first value, nor any other.
 */
export function requestTokenHash(request: FastifyRequest, config: ServerConfig): string | null {
  if (cookieCount(request.headers, config.cookies.session) !== 1) return null;
  const token = request.cookies[config.cookies.session];
  return token && /^[A-Za-z0-9_-]{20,128}$/.test(token) ? tokenHash(token) : null;
}

export async function resolveSession(pool: pg.Pool, hash: string): Promise<ResolvedSession | null> {
  const { rows } = await pool.query<{ r: Record<string, unknown> | null; m: string | null }>(
    `select x.r, case when x.r is null then null else tab.attribution_method_for(x.r ->> 'device_class') end as m
       from (select tab.resolve_session($1) as r) x`,
    [hash],
  );
  const r = rows[0]?.r;
  if (!r) return null;
  const m = rows[0]?.m;
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
    declaredRole: opt('declared_role'),
    roles: Array.isArray(r['roles']) ? (r['roles'] as unknown[]).map(String) : [],
    state: str('state') as SessionState,
    legalName: str('legal_name'),
    loginName: str('login_name'),
    idleTimeoutSeconds: Number(r['idle_timeout_seconds']),
    // Fail towards the stricter prompt: an unknown answer on a shop-floor terminal asks for the PIN as well.
    attributionMethod: m === 'NONE' || m === 'TAP' || m === 'TAP_PIN' ? m : isShopFloor(str('device_class')) ? 'TAP_PIN' : 'NONE',
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
    attribution: shopFloor ? (session.attributionMethod === 'NONE' ? 'TAP' : session.attributionMethod) : 'NONE',
  };
}

/**
 * An account that holds no live role grant opens no session (review F36): the database would end it at its first
 * request anyway (tablets 0400, a session whose account holds no role is withdrawn), and it could read nothing.
 */
export function noRoleHeld(): Error {
  return refusal(403, {
    code: 'NO_ROLE',
    kind: 'NOT_ALLOWED',
    whatHappened: 'You hold no role on this installation now, so you cannot sign in.',
    why: 'The account has no approved role grant that is valid now (revoked, expired or not yet valid).',
    controls: ['DI-16'],
    whatYouCanDo: ['Ask for a role to be granted to you.'],
    whoCanHelp: ['The system administrator (role grants)'],
  });
}
