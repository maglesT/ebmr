/**
 * A stand-in for the platform's core in server tests (Phase B slice 2), with core's fixed endpoints (databsee apps/hello):
 * <issuer>/auth, a token endpoint that checks the client secret (Basic) and PKCE and answers with an ID token and an access
 * token, and <issuer>/me with the person's sub, name, login and permissions. The browser's trip to core is the test reading the authorization URL: core "signs the person in" by
 * remembering the URL's state, nonce and code challenge and handing back a code.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as rsaSign } from 'node:crypto';
import type { TestBrowser } from './harness.ts';

export const CORE_ISSUER = 'https://platform.test/oidc';
export const CORE_SECRET = 'core-client-secret-for-tests';
export const CORE_CLIENT = 'ebmr';

export interface CorePerson {
  sub: string;
  login: string;
  name: string;
  codes: string[];
}

interface Issued {
  person: CorePerson;
  nonce: string;
  challenge: string;
  authTime: number;
}

/** Wall-clock seconds (test fixture; core's own clock). */
const nowS = (): number => Math.floor((performance.timeOrigin + performance.now()) / 1000);

export class FakeCore {
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly codes = new Map<string, Issued>();
  private readonly access = new Map<string, Issued>();
  /** Overrides of the next ID token's claims (attacks). */
  tamper: Record<string, unknown> | null = null;
  /** Seconds to subtract from auth_time (a stale or pre-challenge re-authentication). */
  authTimeShiftS = 0;

  readonly env = {
    EBMR_OIDC_ISSUER: CORE_ISSUER,
    EBMR_OIDC_CLIENT_ID: CORE_CLIENT,
    EBMR_OIDC_CLIENT_SECRET: CORE_SECRET,
    EBMR_OIDC_REDIRECT_URI: 'http://localhost:3001/cb',
  };

  readonly fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const answer = (status: number, body: unknown) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });
    if (url === `${CORE_ISSUER}/token` && init?.method === 'POST') {
      const basic = `Basic ${Buffer.from(`${CORE_CLIENT}:${CORE_SECRET}`).toString('base64')}`;
      if (init.headers?.['authorization'] !== basic) return answer(401, { error: 'invalid_client' });
      const form = new URLSearchParams(init.body ?? '');
      const issued = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (!issued || createHash('sha256').update(verifier).digest('base64url') !== issued.challenge) return answer(400, { error: 'invalid_grant' });
      const accessToken = randomBytes(16).toString('hex');
      this.access.set(accessToken, issued);
      return answer(200, { id_token: this.idToken(issued), access_token: accessToken, token_type: 'Bearer' });
    }
    if (url === `${CORE_ISSUER}/me`) {
      const issued = this.access.get((init?.headers?.['authorization'] ?? '').replace(/^Bearer /, ''));
      if (!issued) return answer(401, {});
      return answer(200, { sub: issued.person.sub, name: issued.person.name, preferred_username: issued.person.login, permissions: issued.person.codes });
    }
    return answer(404, {});
  };

  private idToken(i: Issued): string {
    const now = nowS();
    const claims = {
      iss: CORE_ISSUER,
      aud: CORE_CLIENT,
      sub: i.person.sub,
      nonce: i.nonce,
      auth_time: i.authTime,
      iat: now,
      exp: now + 300,
      ...this.tamper,
    };
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const body = enc(claims);
    return `${head}.${body}.${rsaSign('sha256', Buffer.from(`${head}.${body}`), this.keys.privateKey).toString('base64url')}`;
  }

  /** The person signs in at core on the page `authorizeUrl` sent them to; the code core gives back. */
  login(authorizeUrl: string, person: CorePerson): { state: string; code: string; params: URLSearchParams } {
    const u = new URL(authorizeUrl);
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, {
      person,
      nonce: u.searchParams.get('nonce') ?? '',
      challenge: u.searchParams.get('code_challenge') ?? '',
      authTime: nowS() - this.authTimeShiftS,
    });
    return { state: u.searchParams.get('state') ?? '', code, params: u.searchParams };
  }

  /**
   * The whole round trip from a browser: GET `start` (/signin or /sign?…), sign in at core, GET /cb; the fragment the
   * page receives (proof and purpose, or error).
   */
  async roundTrip(b: TestBrowser, start: string, person: CorePerson): Promise<{ proof?: string; error?: string; params?: URLSearchParams }> {
    const first = await b.inject({ method: 'GET', url: start });
    const location = String(first.headers['location'] ?? '');
    if (!location.startsWith(CORE_ISSUER)) return fragmentOf(location);
    const { state, code, params } = this.login(location, person);
    const back = await b.inject({ method: 'GET', url: `/cb?state=${encodeURIComponent(state)}&code=${code}` });
    return { ...fragmentOf(String(back.headers['location'] ?? '')), params };
  }
}

function fragmentOf(location: string): { proof?: string; error?: string } {
  const f = new URLSearchParams(location.split('#')[1] ?? '');
  const proof = f.get('proof');
  const error = f.get('error');
  return { ...(proof ? { proof } : {}), ...(error ? { error } : {}) };
}
