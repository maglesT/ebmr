/**
 * Sign-on through the platform's core (Phase B slice 2; docs/build-plan/phase-b/slice-2-design.md section 2). Only on the
 * platform build (iam.platform_build(), kernel 1400).
 *
 *   1. GET /signin (sign-in) or GET /sign?challenge=… (re-authentication for a signature, prompt=login and max_age=0) sends
 *      the browser to core's authorization endpoint with PKCE (S256), a state and a nonce held here for 10 minutes.
 *   2. GET /cb exchanges the code at core's token endpoint (a confidential client: client id and secret in the
 *      Authorization header, plus the PKCE verifier), checks the ID token of that answer (issuer, audience, expiry, the
 *      nonce, auth_time), reads the person from core's user-info endpoint (sub, name, permissions; the same sub), and turns
 *      it into a short proof (HMAC-SHA256 under a key derived from the installation's nonce key): who (sub, login,
 *      name), the token's codes, auth_time, the purpose, the challenges it was asked for, and a one-time nonce.
 *   3. The page posts the proof: to POST /api/session/login (LOGIN) or with the signing (SIGNATURE). The server checks it
 *      here (MAC, expiry, purpose) and the kernel uses its nonce once (iam.platform_auth_event).
 *
 * Core's endpoints are fixed under its issuer (databsee apps/hello): <issuer>/auth, <issuer>/token and <issuer>/me. The ID
 * token comes straight from core's token endpoint over TLS to this authenticated client, so its signature is not checked
 * again here (OpenID Connect Core 3.1.3.7, point 6); its issuer, audience, expiry and nonce are.
 *
 * The proof travels in the URL fragment of /platform-signon, which the browser never sends to a server or a log. It
 * carries no secret: it is the server's own statement of what core said, valid for PROOF_TTL_S seconds and one use.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { moment } from '../clock.ts';

/** How long a proof made at /cb may be used (it is used within seconds by the page that received it). */
export const PROOF_TTL_S = 120;
/** How long a sign-on started at /signin or /sign may take at core. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** Clock skew accepted between core and this server. */
const SKEW_S = 60;
const MAX_PENDING = 10_000;

export interface CoreSignonConfig {
  /** Core's issuer URL (https://<domain>/oidc); its endpoints are <issuer>/auth, <issuer>/token and <issuer>/me. */
  issuer: string;
  clientId: string;
  /** Core's client secret (OIDC_CLIENT_SECRET); null only for a public client (PKCE only). */
  clientSecret: string | null;
  /** https://<host>/cb, as registered at core. */
  redirectUri: string;
  /** The ID-token claim holding the person's codes (core: `permissions`, the product's own codes such as 'ebmr.step.execute'). */
  codesClaim: string;
}

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type ProofPurpose = 'LOGIN' | 'SIGNATURE';

export interface PendingSignon {
  purpose: ProofPurpose;
  verifier: string;
  nonce: string;
  /** SIGNATURE: the challenges the re-authentication is for, and the session that asked. */
  challengeIds: string[];
  sessionTokenHash: string | null;
}

/** What /cb proves to the page, and the page hands back. */
export interface SignonProof {
  v: 1;
  purpose: ProofPurpose;
  /** Core's subject: the employee id. */
  sub: string;
  login: string;
  name: string;
  codes: string[];
  /** When core authenticated the person (seconds since the epoch, as in the ID token). */
  authTime: number;
  challengeIds: string[];
  sessionTokenHash: string | null;
  /** One-time nonce, used once by the kernel. */
  nonce: string;
  /** Expiry of the proof (seconds since the epoch). */
  exp: number;
}

export class SignonError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

const b64url = (b: Buffer): string => b.toString('base64url');
const nowS = (): number => Math.floor(moment().wallMs / 1000);

interface Endpoints {
  authorization: string;
  token: string;
  userinfo: string;
}

export class CoreSignon {
  private readonly endpoints: Endpoints;
  private readonly pending = new Map<string, PendingSignon & { at: number }>();
  private readonly proofKey: Buffer;

  constructor(
    readonly config: CoreSignonConfig,
    nonceKey: string,
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init),
  ) {
    this.proofKey = createHmac('sha256', nonceKey).update('ebmr platform sign-on proof v1').digest();
    const base = config.issuer.replace(/\/+$/, '');
    this.endpoints = { authorization: `${base}/auth`, token: `${base}/token`, userinfo: `${base}/me` };
  }

  /** Step 1: where to send the browser, and the state it comes back with. */
  start(p: Omit<PendingSignon, 'verifier' | 'nonce'>): string {
    const now = moment().wallMs;
    for (const [k, v] of this.pending) if (now - v.at > PENDING_TTL_MS) this.pending.delete(k);
    if (this.pending.size >= MAX_PENDING) throw new SignonError('BUSY', 'too many sign-ons are under way; try again in a minute');
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(24));
    this.pending.set(state, { ...p, verifier, nonce, at: now });
    const u = new URL(this.endpoints.authorization);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.config.clientId);
    u.searchParams.set('redirect_uri', this.config.redirectUri);
    u.searchParams.set('scope', 'openid profile permissions');
    u.searchParams.set('state', state);
    u.searchParams.set('nonce', nonce);
    u.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
    u.searchParams.set('code_challenge_method', 'S256');
    if (p.purpose === 'SIGNATURE') {
      // DI-38 / PL-05: core asks for the user ID and the password again, whatever session it holds.
      u.searchParams.set('prompt', 'login');
      u.searchParams.set('max_age', '0');
    }
    return u.toString();
  }

  /** Step 2: the code core returned, exchanged and verified; the proof for the page. */
  async finish(state: string, code: string): Promise<{ proof: string; claims: SignonProof }> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || moment().wallMs - p.at > PENDING_TTL_MS) throw new SignonError('STATE_UNKNOWN', 'this sign-on is not known here or took too long');
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri, code_verifier: p.verifier, client_id: this.config.clientId });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (this.config.clientSecret !== null) {
      headers['authorization'] = `Basic ${Buffer.from(`${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`).toString('base64')}`;
    }
    const res = await this.fetchFn(this.endpoints.token, { method: 'POST', headers, body: body.toString() });
    if (!res.ok) throw new SignonError('CODE_REFUSED', `core refused the code (${res.status})`);
    const tokens = (await res.json()) as { id_token?: unknown; access_token?: unknown };
    if (typeof tokens.id_token !== 'string' || typeof tokens.access_token !== 'string') throw new SignonError('TOKEN_INVALID', 'core returned no ID token or access token');
    const idc = this.checkIdToken(tokens.id_token, p.nonce);
    const me = await this.fetchFn(this.endpoints.userinfo, { headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' } });
    if (!me.ok) throw new SignonError('TOKEN_INVALID', `core's user information answered ${me.status}`);
    const info = (await me.json()) as Record<string, unknown>;
    if (info['sub'] !== idc['sub']) throw new SignonError('TOKEN_INVALID', "core's user information names another person than the ID token");
    const c: Record<string, unknown> = { ...idc, ...info };
    const authTime = idc['auth_time'] ?? info['auth_time'];
    if (typeof authTime !== 'number' || !Number.isInteger(authTime)) throw new SignonError('TOKEN_INVALID', 'the ID token carries no auth_time');
    if (p.purpose === 'SIGNATURE' && nowS() - authTime > SKEW_S) {
      // DI-38: a signature needs a fresh re-authentication (max_age=0); the kernel also checks it against the challenge.
      throw new SignonError('NOT_REAUTHENTICATED', 'core did not ask for the password again');
    }
    const codes = c[this.config.codesClaim];
    const sub = c['sub'];
    // Core's login, when it gives one; otherwise its employee id (both are never reused, PL-03).
    const login = typeof c['preferred_username'] === 'string' ? c['preferred_username'] : sub;
    const name = c['name'];
    if (typeof sub !== 'string' || sub === '' || typeof login !== 'string' || typeof name !== 'string') {
      throw new SignonError('TOKEN_INVALID', 'the ID token names no subject, login or name');
    }
    if (!Array.isArray(codes) || !codes.every((x): x is string => typeof x === 'string')) {
      throw new SignonError('TOKEN_INVALID', `the ID token carries no ${this.config.codesClaim} list`);
    }
    const claims: SignonProof = {
      v: 1,
      purpose: p.purpose,
      sub,
      login,
      name,
      codes: codes.filter((x) => x.startsWith('ebmr.')).sort(),
      authTime,
      challengeIds: p.challengeIds,
      sessionTokenHash: p.sessionTokenHash,
      nonce: b64url(randomBytes(24)),
      exp: nowS() + PROOF_TTL_S,
    };
    return { proof: this.seal(claims), claims };
  }

  /** The ID token of core's token answer: issuer, audience, expiry and nonce (its signature: see the header). */
  private checkIdToken(token: string, nonce: string): Record<string, unknown> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new SignonError('TOKEN_INVALID', 'the ID token is not a JWT');
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new SignonError('TOKEN_INVALID', 'the ID token cannot be read');
    }
    const now = nowS();
    const aud = claims['aud'];
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (claims['iss'] !== this.config.issuer) throw new SignonError('TOKEN_INVALID', 'the ID token comes from another issuer');
    if (!audiences.includes(this.config.clientId) || (audiences.length > 1 && claims['azp'] !== this.config.clientId)) {
      throw new SignonError('TOKEN_INVALID', 'the ID token is for another application');
    }
    if (typeof claims['exp'] !== 'number' || claims['exp'] + SKEW_S < now) throw new SignonError('TOKEN_INVALID', 'the ID token has expired');
    if (typeof claims['iat'] === 'number' && claims['iat'] - SKEW_S > now) throw new SignonError('TOKEN_INVALID', 'the ID token was issued in the future');
    if (claims['nonce'] !== nonce) throw new SignonError('TOKEN_INVALID', 'the ID token answers another sign-on');
    return claims;
  }

  private mac(payload: string): string {
    return b64url(createHmac('sha256', this.proofKey).update(payload).digest());
  }

  private seal(claims: SignonProof): string {
    const payload = b64url(Buffer.from(JSON.stringify(claims)));
    return `${payload}.${this.mac(payload)}`;
  }

  /** Step 3: the proof the page hands back, checked (MAC, expiry, purpose); its nonce is then used once by the kernel. */
  open(proof: string, purpose: ProofPurpose): SignonProof {
    const [payload = '', mac = '', extra] = proof.split('.');
    const want = Buffer.from(this.mac(payload));
    const got = Buffer.from(mac);
    if (extra !== undefined || got.length !== want.length || !timingSafeEqual(got, want)) throw new SignonError('PROOF_INVALID', 'the sign-on proof is not this server\'s');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SignonProof;
    if (claims.v !== 1 || claims.purpose !== purpose) throw new SignonError('PROOF_INVALID', `the sign-on proof was not made for ${purpose === 'LOGIN' ? 'signing in' : 'a signature'}`);
    if (claims.exp < nowS()) throw new SignonError('PROOF_EXPIRED', 'the sign-on proof has expired');
    return claims;
  }
}

/** 'ebmr.step.execute' → 'STEP.EXECUTE' (the kernel's iam.platform_code_to_permission, for the server's own checks). */
export function permissionOf(code: string): string | null {
  return /^ebmr\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(code) ? code.slice(5).toUpperCase() : null;
}
