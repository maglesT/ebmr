/**
 * Per-entry attribution on SHARED and GRADE_A_B terminals (INV-40, DI-14, DI-20; plan section 5; decision D8).
 * Module C1 (replaces the spine's stub).
 *
 * bindRoutes calls resolveAttribution for every FRESH_ON_SHARED route on a shop-floor terminal. In order:
 *  1. no attribution: 428 TAP_REQUIRED ("Tap your badge");
 *  2. at most 30 taps a minute per terminal and badge (429; the kernel lockout stays authoritative);
 *  3. the device proof inside the attribution, verified over the request itself: method, path and the body
 *     without its `attribution` member (a fresh single-use nonce, the terminal's enrolled key). The proven
 *     terminal must be the session's own terminal;
 *  4. the attribution method of the terminal class (tab.attribution_method_for): TAP (default) or TAP_PIN,
 *     which also needs the PIN (428 TAP_PIN_REQUIRED without it);
 *  5. the authentication service: BADGE_TAP (or BADGE_PIN) with purpose COMMAND on the authentication pool, so
 *     a refused or failed attempt is recorded and counts toward lockout whatever happens next;
 *  6. the tapper must be the session's own person and account, otherwise 409 SWITCH_USER with the tapper's
 *     name (the screen offers "Switch to <name>?"); the event made for that other person is never used;
 *  7. the event goes into the ActorContext, and kernel.begin_command consumes it (same person, same terminal,
 *     at most the class's freshness window old, single use: INV-40).
 * The attribution, its PIN and its proof are excluded from request hashes and logs (bind.ts, logging.ts).
 */
import { createHash } from 'node:crypto';
import type { Attribution } from '@ebmr/api-contract';
import { identity } from '@ebmr/kernel';
import type { AppContext } from '../context.ts';
import { refusal } from '../http/refusal.ts';
import type { ResolvedSession } from './session.ts';

export interface AttributionInput {
  app: AppContext;
  session: ResolvedSession;
  attribution: Attribution | undefined;
  method: string;
  /** URL path without the query string. */
  path: string;
  /** The request body (the attribution member is excluded from the proof and the request hash). */
  body: unknown;
}

export interface AttributionResult {
  /** The BADGE_TAP authentication event the command consumes (ActorContext.authEventId). */
  authEventId: string;
}

export type AttributionMethod = 'TAP' | 'TAP_PIN' | 'NONE';

// ---------------------------------------------------------------------------------------------
// Tap rate limit: 30 a minute per terminal and badge (plan section 5 said 10; raised so a fast operator working a
// checklist is not refused, decision C0-9). A monotonic clock, never a GMP time.

export const TAP_LIMIT = { max: 30, windowMs: 60_000 } as const;

export class TapRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number = TAP_LIMIT.max,
    private readonly windowMs: number = TAP_LIMIT.windowMs,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Counts one attempt; false when the limit for this key is already reached within the window. */
  take(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(t);
    return true;
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) if (v.every((x) => t - x >= this.windowMs)) this.hits.delete(k);
  }
}

const limiters = new WeakMap<AppContext, TapRateLimiter>();

/** The tap limiter of one server (one per AppContext, so parallel test servers do not share counts). */
export function tapLimiter(app: AppContext): TapRateLimiter {
  let l = limiters.get(app);
  if (!l) {
    l = new TapRateLimiter();
    limiters.set(app, l);
  }
  return l;
}

/** The key of a tap attempt: the terminal and a hash of the badge UID (the UID itself is not kept as a key). */
export function tapKey(deviceId: string, badgeUid: string): string {
  return `${deviceId}|${createHash('sha256').update(badgeUid.trim(), 'utf8').digest('hex')}`;
}

export function tapRateLimited(): Error {
  return refusal(
    429,
    {
      code: 'RATE_LIMITED',
      kind: 'LOCKED',
      whatHappened: 'Too many badge taps in a short time.',
      why: `At most ${TAP_LIMIT.max} badge taps a minute are accepted per terminal and badge.`,
      controls: ['DI-19'],
      whatYouCanDo: ['Wait a minute and try again.'],
      whoCanHelp: ['Your supervisor'],
    },
    true,
  );
}

// ---------------------------------------------------------------------------------------------

/** The attribution method of a terminal class now (TAP unless the class is set to TAP_PIN; NONE off the floor). */
export async function attributionMethodFor(app: AppContext, deviceClass: string): Promise<AttributionMethod> {
  const { rows } = await app.pools.app.query<{ m: string }>('select tab.attribution_method_for($1) as m', [deviceClass]);
  const m = rows[0]?.m;
  return m === 'TAP_PIN' ? 'TAP_PIN' : m === 'TAP' ? 'TAP' : 'NONE';
}

/** A person as the SWITCH_USER refusal names them. */
export async function personNames(app: AppContext, personId: string, accountId: string): Promise<{ legalName: string; loginName: string }> {
  const { rows } = await app.pools.app.query<{ legal_name: string; login_name: string }>(
    'select p.legal_name, a.login_name from iam.person p join iam.account a on a.person_id = p.id where p.id = $1 and a.id = $2',
    [personId, accountId],
  );
  return { legalName: rows[0]?.legal_name ?? 'another person', loginName: rows[0]?.login_name ?? '' };
}

/** 409 SWITCH_USER: the badge belongs to another person than the one signed in (plan section 5). */
export function switchUserRefusal(session: ResolvedSession, other: { legalName: string; loginName: string }, what: string): Error {
  return refusal(409, {
    code: 'SWITCH_USER',
    kind: 'SWITCH_USER',
    whatHappened: `This badge belongs to ${other.legalName}, but ${session.legalName} is signed in here.`,
    why: `${what} is attributed only to the person signed in on this terminal (INV-40).`,
    controls: ['DI-14'],
    whatYouCanDo: [`Switch to ${other.legalName} with badge and PIN, or let ${session.legalName} tap their own badge.`],
    whoCanHelp: [],
    details: { switchToLegalName: other.legalName, switchToLoginName: other.loginName },
  });
}

export function tapRequired(): Error {
  return refusal(428, {
    code: 'TAP_REQUIRED',
    kind: 'NOT_ALLOWED',
    whatHappened: 'Tap your badge to confirm it is you.',
    why: 'Every entry on a shared terminal is confirmed by a fresh badge tap of the signed-in person (INV-40).',
    controls: ['DI-14'],
    whatYouCanDo: ['Tap your badge on the reader, then send again.'],
  });
}

function pinRequired(deviceClass: string): Error {
  return refusal(428, {
    code: 'TAP_PIN_REQUIRED',
    kind: 'NOT_ALLOWED',
    whatHappened: 'Tap your badge and enter your PIN to confirm it is you.',
    why: `On ${deviceClass} terminals every entry is confirmed by badge and PIN (TAP_PIN, decision D8).`,
    controls: ['DI-14'],
    whatYouCanDo: ['Tap your badge, enter your PIN, then send again.'],
  });
}

/**
 * A refused or failed badge authentication in plain language. The reason (unknown badge, inactive, locked
 * account) stays in the authentication log and the security alert; the screen never says which (DI-19).
 */
export function tapNotAccepted(error: unknown, withPin: boolean): unknown {
  if (!(error instanceof identity.AuthenticationFailedError)) return error;
  const locked = error.locked || error.reason === 'ACCOUNT_LOCKED';
  if (locked) {
    return refusal(423, {
      code: 'AUTH_LOCKED',
      kind: 'LOCKED',
      whatHappened: 'The account is locked after too many failed attempts.',
      why: 'The account of this badge is locked.',
      controls: ['DI-19'],
      whatYouCanDo: ['Ask for the account to be unlocked; do not keep trying.'],
      whoCanHelp: ['The system administrator'],
    });
  }
  return refusal(
    401,
    {
      code: 'EBMR-IAM-140',
      kind: 'AUTH_FAILED',
      whatHappened: withPin ? 'The badge or PIN was not accepted.' : 'The badge was not accepted.',
      why: withPin
        ? 'The badge is unknown or not active here, or the PIN is not correct. Failed attempts count toward the account lock.'
        : 'The badge is unknown or not active, or its account cannot act on this terminal.',
      controls: ['DI-14', 'DI-19'],
      whatYouCanDo: withPin ? ['Tap your own badge and enter your PIN again.'] : ['Tap your own badge again.'],
      whoCanHelp: ['Your supervisor', 'The system administrator (badges and accounts)'],
    },
    true,
  );
}

export function otherTerminal(): Error {
  return refusal(403, {
    code: 'DEVICE_PROOF',
    kind: 'NOT_ALLOWED',
    whatHappened: 'This confirmation was made on another terminal than the one you are signed in on.',
    why: 'A badge tap attributes an entry only on the terminal of the session (DI-20).',
    controls: ['DI-20'],
    whatYouCanDo: ['Reload the page on this terminal and try again.'],
    whoCanHelp: ['The system administrator (device enrolment)'],
    details: { reason: 'OTHER_TERMINAL' },
  });
}

/**
 * Authenticates a badge tap (or badge and PIN) of the session's own person on the session's terminal, purpose
 * COMMAND. Used for attribution and by keep-alive (`plainTapOnly`). `subject` is what the device proof covers.
 */
export async function authenticateTap(
  app: AppContext,
  session: ResolvedSession,
  tap: { badgeUid: string; pin?: string | undefined; proof: Attribution['proof'] },
  subject: { method: string; path: string; body: unknown },
  what: string,
  opts: { plainTapOnly?: boolean } = {},
): Promise<identity.AuthenticationEvent> {
  if (!tapLimiter(app).take(tapKey(session.deviceId, tap.badgeUid))) throw tapRateLimited();
  const { fingerprint, device } = await app.devices.identify(tap.proof, subject);
  if (device.deviceId !== session.deviceId) throw otherTerminal();
  // Keep-alive only extends the session (kernel: a badge tap); TAP_PIN applies to entries.
  const method = opts.plainTapOnly ? 'TAP' : await attributionMethodFor(app, session.deviceClass);
  if (method === 'TAP_PIN' && !tap.pin) throw pinRequired(session.deviceClass);
  let ev: identity.AuthenticationEvent;
  try {
    ev = await identity.authenticate(app.pools.authn, {
      method: method === 'TAP_PIN' ? 'BADGE_PIN' : 'BADGE_TAP',
      identifier: tap.badgeUid,
      ...(method === 'TAP_PIN' ? { secret: tap.pin ?? '' } : {}),
      deviceFingerprint: fingerprint,
      purpose: 'COMMAND',
    });
  } catch (error) {
    throw tapNotAccepted(error, method === 'TAP_PIN');
  }
  if (ev.personId !== session.personId || ev.accountId !== session.accountId) {
    throw switchUserRefusal(session, await personNames(app, ev.personId, ev.accountId), what);
  }
  return ev;
}

export async function resolveAttribution(input: AttributionInput): Promise<AttributionResult> {
  const { app, session, attribution } = input;
  if (!attribution) throw tapRequired();
  const ev = await authenticateTap(app, session, attribution, { method: input.method, path: input.path, body: input.body }, 'An entry');
  return { authEventId: ev.authEventId };
}
