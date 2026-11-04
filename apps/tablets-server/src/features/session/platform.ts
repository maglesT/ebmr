/**
 * Phase B slice 2: sign-on and re-authentication through the platform's core, on the platform build only
 * (docs/build-plan/phase-b/slice-2-design.md section 2; platform/auth/core-signon.ts).
 *
 *   GET /signin                 → core (code + PKCE)
 *   GET /sign?challenge=…[&challenge=…]
 *                               → core with prompt=login and max_age=0, for this session's own open challenges (DI-38)
 *   GET /cb                     ← core: the code exchanged and the ID token verified; the browser goes on to
 *                                 /platform-signon#proof=… (the fragment never reaches a server or a log)
 *
 * The proof is then posted with the login (POST /api/session/login, method PLATFORM) or the signing (credentials kind
 * PLATFORM). platformAuthEvent turns it into the kernel's own authentication event (iam.platform_auth_event, kernel 1400):
 * at sign-on the person's grants are first brought in line with the token's codes (iam.platform_sync_grants).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { identity } from '@ebmr/kernel';
import { SignonError, permissionOf, type ProofPurpose, type SignonProof } from '../../platform/auth/core-signon.ts';
import { requestTokenHash } from '../../platform/auth/session.ts';
import type { AppContext } from '../../platform/context.ts';
import { managedInPlatform } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';

export { managedInPlatform };
import { readChallenge } from '../esig/views.ts';

function signonRefused(reason: string, message: string, controls: string[] = ['DI-38']): Error {
  return refusal(401, {
    code: 'PLATFORM_SIGNON',
    kind: 'AUTH_FAILED',
    whatHappened: 'The sign-on through the platform was not accepted. Nothing was done.',
    why: `${message} (${reason}).`,
    controls,
    whatYouCanDo: ['Sign on through the platform again.'],
  });
}

function signonOf(app: AppContext) {
  const s = app.platform.signon;
  if (!app.platform.build || !s) throw managedInPlatform('Sign-on');
  return s;
}

function openProof(app: AppContext, proof: string, purpose: ProofPurpose): SignonProof {
  try {
    return signonOf(app).open(proof, purpose);
  } catch (e) {
    if (e instanceof SignonError) throw signonRefused(e.reason, e.message);
    throw new Error('the sign-on proof cannot be read', { cause: e });
  }
}

async function onAuthn<T>(app: AppContext, work: (q: (sql: string, params: unknown[]) => Promise<unknown>) => Promise<T>): Promise<T> {
  const db = app.pools.authn;
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    if (db.setRole) await client.query(`set local role ${db.setRole}`);
    const out = await work(async (sql, params) => (await client.query<{ r: unknown }>(sql, params)).rows[0]?.r);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

interface KernelAnswer {
  status: 'OK' | 'REFUSED';
  reason?: string;
  auth_event_id?: string;
  person_id?: string;
  account_id?: string;
}

export interface PlatformAuth {
  authEventId: string;
  personId: string;
  accountId: string;
}

/**
 * The proof as an authentication event of the kernel. LOGIN: the grants follow the token first (codes removed at core
 * are revoked now; PL-01, INV-11). SIGNATURE: the proof must have been made for this session and this challenge and carry
 * a code of the meaning (the kernel then checks the signer, the terminal and that core re-authenticated after the
 * challenge). `nonceUse` tells the uses of one proof apart (the second row of a two-row signing).
 */
export async function platformAuthEvent(
  app: AppContext,
  input: {
    proof: string;
    purpose: ProofPurpose;
    fingerprint: string;
    challengeId?: string;
    sessionTokenHash?: string;
    meaningPermissions?: readonly string[];
    nonceUse?: number;
  },
): Promise<PlatformAuth> {
  const p = openProof(app, input.proof, input.purpose);
  if (input.purpose === 'SIGNATURE') {
    if (p.sessionTokenHash !== input.sessionTokenHash || input.challengeId === undefined || !p.challengeIds.includes(input.challengeId)) {
      throw signonRefused('PROOF_FOR_ANOTHER_SIGNING', 'the re-authentication was made for another signing');
    }
    const held = new Set(p.codes.map(permissionOf));
    if (input.meaningPermissions && !input.meaningPermissions.some((m) => held.has(m))) {
      throw refusal(403, {
        code: 'EBMR-ESIG-040',
        kind: 'NOT_ALLOWED',
        whatHappened: 'The platform does not give you a code for this signature now. Nothing was signed.',
        why: `This signature needs one of ${input.meaningPermissions.join(', ')}.`,
        controls: ['DI-17', 'DI-38'],
        whoCanHelp: ['The platform administrator'],
      });
    }
  }
  // At sign-on, and again at every signing, the grants follow the token: a code removed at core counts from now on. One
  // transaction: the sync spends the proof's nonce first (a used proof changes nothing), then the event is made of it. A
  // refused sync still commits (the revocations and the spent nonce), and nothing more is made.
  const nonce = input.nonceUse ? `${p.nonce}:${input.nonceUse}` : p.nonce;
  let out: { sync: KernelAnswer; ev: KernelAnswer | null };
  try {
    out = await onAuthn<{ sync: KernelAnswer; ev: KernelAnswer | null }>(app, async (q) => {
      const sync = (await q('select iam.platform_sync_grants($1, $2, $3, $4, $5, $6, $7, $8) as r', [
        p.sub, p.login, p.name, p.codes, `core sign-on of ${p.login}`, input.fingerprint, input.purpose, nonce,
      ])) as KernelAnswer;
      if (sync.status !== 'OK') return { sync, ev: null };
      const ev = (await q('select iam.platform_auth_event($1, $2, $3, $4, to_timestamp($5::bigint), $6) as r', [
        p.sub, input.purpose, input.challengeId ?? null, input.fingerprint, String(p.authTime), nonce,
      ])) as KernelAnswer;
      return { sync, ev };
    });
  } catch (e) {
    if (identity.ebmrCode(e) === 'EBMR-IAM-091') throw signonRefused('PROOF_USED', 'the sign-on proof has already been used');
    throw e;
  }
  const { sync, ev } = out;
  if (sync.status !== 'OK') {
    throw refusal(403, {
      code: 'EBMR-IAM-302',
      kind: 'NOT_ALLOWED',
      whatHappened:
        sync.reason === 'ADMINISTRATION_AND_GMP'
          ? 'Your permissions for this application mix administration and GMP work, which it does not allow.'
          : 'The platform gives you no permission for this application.',
      why:
        sync.reason === 'ADMINISTRATION_AND_GMP'
          ? 'One person never holds administration and GMP work together (INV-11, DI-18). You hold no authority here until this is corrected.'
          : 'Only people with at least one permission for this application sign in here (PL-01).',
      controls: ['DI-16', 'DI-18'],
      whatYouCanDo: [
        sync.reason === 'ADMINISTRATION_AND_GMP'
          ? 'Ask your platform administrator to give these permissions to two different people.'
          : 'Ask your platform administrator for the permissions your work needs here.',
      ],
      whoCanHelp: ['The platform administrator'],
    });
  }
  if (!ev || ev.status !== 'OK' || !ev.auth_event_id || !ev.person_id || !ev.account_id) {
    throw signonRefused(ev?.reason ?? 'REFUSED', 'the platform sign-on cannot be used here');
  }
  return { authEventId: ev.auth_event_id, personId: ev.person_id, accountId: ev.account_id };
}

/** The open challenges of this session (the /sign route only re-authenticates for the session's own signings). */
async function ownOpenChallenges(app: AppContext, tokenHash: string, ids: string[]): Promise<boolean> {
  for (const id of ids) {
    const ch = await readChallenge(app.pools.app, tokenHash, id);
    if (!ch || ch.secondsLeft <= 0) return false;
  }
  return true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function toPage(reply: FastifyReply, fragment: Record<string, string>): FastifyReply {
  return reply.header('cache-control', 'no-store').redirect(`/platform-signon#${new URLSearchParams(fragment).toString()}`, 303);
}

/** The browser-facing routes' own limit per address (a sign-on start costs a pending entry at the server). */
const SIGNON_RATE_LIMIT = { rateLimit: { max: 120, timeWindow: '1 minute' } };
const SIGNON_COOKIE_MAX_AGE_S = 600;

/** The cookie binding a started sign-on to the browser that started it (one per purpose: a signing window beside a sign-in). */
function signonCookie(app: AppContext, purpose: ProofPurpose): string {
  const short = app.installation === 'GMP' ? 'gmp' : 'sbx';
  const name = purpose === 'LOGIN' ? 'signon' : 'sign';
  return app.config.https ? `__Host-ebmr-${short}-${name}` : `ebmr_${short}_${name}`;
}

const stateHash = (state: string): string => createHash('sha256').update(state).digest('hex');

/** The browser-facing routes (not under /api: they are top-level navigations to and from core). */
export function platformRoutes(scope: FastifyInstance, app: AppContext): void {
  if (!app.platform.build) return;
  const signon = signonOf(app);
  const failed = (reply: FastifyReply, e: unknown, purpose: ProofPurpose = 'LOGIN') => {
    if (e instanceof SignonError) return toPage(reply, { error: e.reason, purpose });
    app.log.warn({ error: (e as Error).message }, 'platform sign-on failed');
    return toPage(reply, { error: 'CORE_UNREACHABLE', purpose });
  };
  const toCore = (reply: FastifyReply, purpose: ProofPurpose, started: { url: string; state: string }) =>
    reply
      .setCookie(signonCookie(app, purpose), started.state, { path: '/', httpOnly: true, sameSite: 'lax', secure: app.config.https, maxAge: SIGNON_COOKIE_MAX_AGE_S })
      .header('cache-control', 'no-store')
      .redirect(started.url, 303);

  scope.get('/signin', { config: SIGNON_RATE_LIMIT }, async (_request, reply) => {
    try {
      return toCore(reply, 'LOGIN', signon.start({ purpose: 'LOGIN', challengeIds: [], sessionTokenHash: null }));
    } catch (e) {
      return failed(reply, e);
    }
  });

  scope.get<{ Querystring: { challenge?: string | string[] } }>('/sign', { config: SIGNON_RATE_LIMIT }, async (request, reply) => {
    const ids = [request.query.challenge ?? []].flat();
    const tokenHash = requestTokenHash(request, app.config);
    if (tokenHash === null || ids.length < 1 || ids.length > 2 || !ids.every((x) => UUID.test(x)) || !(await ownOpenChallenges(app, tokenHash, ids))) {
      return toPage(reply, { error: 'CHALLENGE_UNKNOWN', purpose: 'SIGNATURE' });
    }
    try {
      return toCore(reply, 'SIGNATURE', signon.start({ purpose: 'SIGNATURE', challengeIds: ids, sessionTokenHash: tokenHash }));
    } catch (e) {
      return failed(reply, e, 'SIGNATURE');
    }
  });

  scope.get<{ Querystring: { state?: string; code?: string; error?: string } }>('/cb', { config: SIGNON_RATE_LIMIT }, async (request, reply) => {
    const { state, code, error } = request.query;
    if (typeof state !== 'string' || typeof code !== 'string' || error !== undefined) return toPage(reply, { error: error === undefined ? 'CODE_MISSING' : 'CORE_REFUSED' });
    // Only the browser that started this sign-on may finish it (login CSRF: a /cb link of another person's sign-on).
    const bound = (['LOGIN', 'SIGNATURE'] as const).find((pp) => {
      const c = request.cookies[signonCookie(app, pp)];
      return typeof c === 'string' && c.length === state.length && timingSafeEqual(Buffer.from(stateHash(c)), Buffer.from(stateHash(state)));
    });
    if (!bound) return toPage(reply, { error: 'STATE_UNKNOWN' });
    reply.clearCookie(signonCookie(app, bound), { path: '/', httpOnly: true, sameSite: 'lax', secure: app.config.https });
    try {
      const { proof, claims } = await signon.finish(state, code);
      if (claims.purpose !== bound) return toPage(reply, { error: 'STATE_UNKNOWN', purpose: bound });
      return toPage(reply, { proof, purpose: claims.purpose });
    } catch (e) {
      return failed(reply, e, bound);
    }
  });
}
