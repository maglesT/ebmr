/**
 * bindRoutes (plan section 4, "Server binding"): registers a namespace of the frozen contract with a handler
 * per route. The mapped Handlers type makes a missing handler a compile error; the zod type provider validates
 * requests and responses (so drift fails the server tests); routes of the other installation are not
 * registered at all (they answer 404 there).
 *
 * Every route passes the same gates, in this order:
 *  1. (global hooks) correlation id, X-Ebmr-Installation, no-store, exact Origin and Sec-Fetch-Site on non-GET;
 *     a route counted `by: 'DEVICE'` then passes its rate limit, before the session lookup and the handler;
 *  2. session: 401 without a live session, 423 when locked, 409 until the role is chosen (SESSION routes);
 *  3. CSRF token bound to the session token (non-GET SESSION routes);
 *  4. Idempotency-Key (REQUIRED routes): 428 when missing;
 *  5. attribution (FRESH_ON_SHARED routes on SHARED and GRADE_A_B terminals): the C1 hook, 428 without a tap;
 *  6. the handler, with a typed context.
 */
import { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler, preHandlerHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import type { ActorContext } from '@ebmr/kernel';
import { RefusalEnvelope, type AnyRoute, type Attribution, type RouteBody, type RouteNamespace, type RouteParams, type RouteQuery, type RouteResponse } from '@ebmr/api-contract';
import { actorFrom } from '../auth/actor.ts';
import { resolveAttribution } from '../auth/attribution.ts';
import { spkiFingerprint } from '../auth/device-proof.ts';
import { isShopFloor, requestTokenHash, resolveSession, type ResolvedSession } from '../auth/session.ts';
import type { AppContext } from '../context.ts';
import { inCommandScope } from '../db/commands.ts';
import { HttpRefusal, refusal } from './refusal.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** The resolved session: undefined until looked up, null when there is none. */
    ebmrSession?: ResolvedSession | null;
    /** The badge-tap authentication event of this request (FRESH_ON_SHARED on shared terminals). */
    ebmrAuthEventId?: string;
  }
}

export interface HandlerContext<R extends AnyRoute> {
  route: R;
  params: RouteParams<R>;
  query: RouteQuery<R>;
  body: RouteBody<R>;
  request: FastifyRequest;
  reply: FastifyReply;
  app: AppContext;
  correlationId: string;
  /** The session; always present on SESSION routes. */
  session: ResolvedSession | null;
  requireSession: () => ResolvedSession;
  /** The ActorContext of this request (with the badge-tap event on shared terminals). */
  actor: (extras?: { reasonCode?: string; reasonText?: string }) => ActorContext & { deviceId: string };
  /** Route-level role gate on the declared role (403 otherwise). */
  requireRole: (...roles: string[]) => void;
  idempotencyKey: string | null;
  /** SHA-256 of the route id, params, query and body without attribution, credentials, proofs or secrets. */
  requestHash: string;
}

export type Handler<R extends AnyRoute> = (ctx: HandlerContext<R>) => Promise<RouteResponse<R>>;
export type Handlers<NS extends RouteNamespace> = { [K in keyof NS]: Handler<NS[K]> };

export interface RateLimitSpec {
  max: number;
  timeWindow: string;
  /** What, besides the client address, a request is counted by. */
  by?: 'IP_AND_IDENTIFIER' | 'SESSION';
}

/**
 * The device nonce (decision 0004 X22-X27, X34), counted per terminal key and client address, under a count shared by
 * the unproven requests of the address and a ceiling per address. The request names the key the nonce is for (`spki`;
 * the nonce is bound to it, nonces.ts) and may show a proof ticket (`lastNonce`): the nonce of this key's last
 * successful device proof as an active browser terminal, which counts once (DeviceIdentityProvider.takeProofTicket).
 * With a ticket, in order:
 *  1. `max` per key and address (TERMINAL): a terminal past its own count is refused without costing the address's
 *     allowance or a query, so one noisy terminal's own requests cannot starve the others behind the same address;
 *  2. `addressMax` per address (ADDRESS), for every request that got past its first count;
 *  3. the key must still be enrolled to an ACTIVE browser terminal (a plain read, no alert); if it is not, the request
 *     is unproven after all and counts toward `unprovenMax` too (UNPROVEN).
 * Without one (none, used, unknown, expired, or another key's), the request is unproven, whatever key it names:
 *  1. refused (TERMINAL) at once, counting nothing, when the key's own count is already full;
 *  2. `unprovenMax` per address (UNPROVEN), shared by every unproven request of the address: together they get no more
 *     room than the whole address had before, and take at most `unprovenMax` of its `addressMax`;
 *  3. `addressMax` per address (ADDRESS);
 *  4. `max` per key and address (TERMINAL): every nonce bound to a key counts here, with a ticket or without, so
 *     whoever holds one terminal's private key gets no more than `max` usable nonces a minute from one address.
 *     The price (X34): unproven requests that name a terminal's public key fill that terminal's count, and a full
 *     `unprovenMax` refuses every request of the address without a ticket, so a caller at the address that holds no
 *     private key can keep terminals from getting a nonce while it keeps asking (it gets none they can use).
 * A key enters the per-key count only with a ticket (a successful proof, so an enrolled private key) or past steps 2
 * and 3, so invented keys cannot push another terminal's count out of memory. An IPv6 address is counted by its /64
 * network (the rate-limit plugin's default grouping). The answer carries the x-ratelimit-* headers of the fullest count
 * it passed, or of the count that refused it with Retry-After; a refusal is logged at warn.
 */
export interface DeviceRateLimitSpec {
  by: 'DEVICE';
  timeWindow: string;
  max: number;
  unprovenMax: number;
  addressMax: number;
}

export interface BindOptions {
  /**
   * Per route name. Auth, tap and unlock 10/min per IP and identifier; sign 20/min per session (plan section 5); the
   * device nonce per terminal and address under a ceiling per address (DeviceRateLimitSpec).
   */
  rateLimits?: Readonly<Record<string, RateLimitSpec | DeviceRateLimitSpec>>;
}

/** Routes that work while the session is locked (to show the lock, unlock, switch or leave). */
const ALLOWED_WHEN_LOCKED = new Set(['session.get', 'session.logout', 'access.lock', 'access.unlock', 'access.switchUser']);
/** Routes that work before the role is chosen. */
const ALLOWED_WITHOUT_ROLE = new Set(['session.get', 'session.chooseRole', 'session.logout', 'access.lock', 'access.unlock', 'access.switchUser', 'access.keepAlive']);
/**
 * Phase 4 slice 4b: a session in the EU importer QP's read-only role (EU_QP_READER, kernel 1160) reaches only its own
 * package routes and the session routes; the database scopes those reads to the one lot of a live access (DI-14).
 */
const QP_READER_ROLE = 'EU_QP_READER';
const ALLOWED_FOR_QP_READER = new Set([...ALLOWED_WITHOUT_ROLE, 'qpPackage.readerPackages', 'qpPackage.readerFile']);
/**
 * Phase 6 slice 6f (IN-30): a session of an account holding the contract giver's reviewer role (CONTRACT_GIVER_REVIEWER,
 * read permissions only) reaches only its own batch routes and the session routes; the database scopes those reads to
 * the batches of the loan licence a live access names and logs each record opened.
 */
const CONTRACT_GIVER_ROLE = 'CONTRACT_GIVER_REVIEWER';
const ALLOWED_FOR_CONTRACT_GIVER = new Set([...ALLOWED_WITHOUT_ROLE, 'contractGiver.batches', 'contractGiver.batch']);
/** Body members never part of a request hash, a log line or a proof subject. */
const SECRET_MEMBERS = ['attribution', 'credentials', 'proof', 'secret', 'pin', 'password', 'newSecret', 'currentSecret', 'changeTicket'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The body a device proof covers (decision D8): exactly the request body without its `attribution` member. */
export function withoutAttribution(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
  return Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([k]) => k !== 'attribution'));
}

export function withoutSecrets(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body ?? null;
  return Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([k]) => !SECRET_MEMBERS.includes(k)));
}

export function requestHashOf(routeId: string, params: unknown, query: unknown, body: unknown): string {
  return sha256Hex(canonicalJson({ route: routeId, params: params ?? {}, query: query ?? {}, body: withoutSecrets(body) }));
}

export const pathOf = (request: FastifyRequest): string => request.url.split('?')[0] ?? request.url;

/** Looks the session up once per request (cookie of this installation only). */
export async function sessionOf(app: AppContext, request: FastifyRequest): Promise<ResolvedSession | null> {
  if (request.ebmrSession !== undefined) return request.ebmrSession;
  const hash = requestTokenHash(request, app.config);
  request.ebmrSession = hash ? await resolveSession(app.pools.app, hash) : null;
  return request.ebmrSession;
}

/** The counts of a device nonce: the terminal key's own, the address's ceiling, the one the unproven requests share. */
type DeviceLimit = 'TERMINAL' | 'ADDRESS' | 'UNPROVEN';

/** `limit` names the count that was full. */
function tooManyNonceRequests(limit: DeviceLimit, why: string): Error {
  return refusal(
    429,
    {
      code: 'RATE_LIMITED',
      kind: 'LOCKED',
      whatHappened: 'Too many requests in a short time.',
      why,
      controls: ['DI-19', 'DI-20'],
      whatYouCanDo: ['Wait a minute and try again.'],
      whoCanHelp: ['The system administrator, if it happens again'],
      details: { limit },
    },
    true,
  );
}

interface CountResult {
  max: number;
  remaining: number;
  ttlInSeconds: number;
}

/** The headers the rate-limit plugin sends (x-ratelimit-*; Retry-After on a refusal). */
function rateHeaders(reply: FastifyReply, result: CountResult, refused: boolean): void {
  void reply.header('x-ratelimit-limit', result.max);
  void reply.header('x-ratelimit-remaining', refused ? 0 : result.remaining);
  void reply.header('x-ratelimit-reset', result.ttlInSeconds);
  if (refused) void reply.header('retry-after', result.ttlInSeconds);
}

/** The rate-limit gate of a route counted `by: 'DEVICE'` (see DeviceRateLimitSpec for the order of the checks). */
function deviceRateGate(scope: FastifyInstance, app: AppContext, routeId: string, rl: DeviceRateLimitSpec): preHandlerAsyncHookHandler {
  // The body is validated before the preHandler hooks run: `spki` is there.
  const claims = new WeakMap<FastifyRequest, { address: string; fingerprint: string }>();
  const claimOf = (request: FastifyRequest): { address: string; fingerprint: string } => {
    let claim = claims.get(request);
    if (!claim) {
      claim = { address: normalizeIP(request.ip), fingerprint: spkiFingerprint((request.body as { spki: string }).spki) };
      claims.set(request, claim);
    }
    return claim;
  };
  const counts: Record<DeviceLimit, ReturnType<FastifyInstance['createRateLimit']>> = {
    TERMINAL: scope.createRateLimit({ max: rl.max, timeWindow: rl.timeWindow, keyGenerator: (r) => `${routeId}|${claimOf(r).address}|key|${claimOf(r).fingerprint}` }),
    ADDRESS: scope.createRateLimit({ max: rl.addressMax, timeWindow: rl.timeWindow, keyGenerator: (r) => `${routeId}|${claimOf(r).address}` }),
    UNPROVEN: scope.createRateLimit({ max: rl.unprovenMax, timeWindow: rl.timeWindow, keyGenerator: (r) => `${routeId}|${claimOf(r).address}|unproven` }),
  };
  const why: Record<DeviceLimit, string> = {
    TERMINAL: `More than ${rl.max} device nonces were asked for with this terminal's key from this network address within ${rl.timeWindow}.`,
    ADDRESS: `More than ${rl.addressMax} device nonces were asked for from this network address within ${rl.timeWindow}.`,
    UNPROVEN: `Requests that did not show the nonce of their terminal's last device proof asked for more than ${rl.unprovenMax} device nonces from this network address within ${rl.timeWindow}.`,
  };
  return async (request, reply) => {
    const body = request.body as { spki: string; lastNonce?: string };
    const refuse = (limit: DeviceLimit, result: CountResult): never => {
      rateHeaders(reply, result, true);
      const { address, fingerprint } = claimOf(request);
      request.log.warn({ limit, address, keyFingerprint: fingerprint, correlationId: String(request.id) }, 'device nonce refused: rate limit');
      throw tooManyNonceRequests(limit, why[limit]);
    };
    const passed: CountResult[] = [];
    const count = async (limit: DeviceLimit): Promise<void> => {
      const result = await counts[limit](request);
      if (result.isAllowed) return;
      if (result.isExceeded) refuse(limit, result);
      passed.push(result);
    };
    if (body.lastNonce !== undefined && app.devices.takeProofTicket(body.spki, body.lastNonce)) {
      await count('TERMINAL');
      await count('ADDRESS');
      if ((await app.devices.enrolledTerminal(body.spki)) === null) await count('UNPROVEN');
    } else {
      const own = await counts.TERMINAL(request, { increment: false });
      if (!own.isAllowed && own.remaining === 0) refuse('TERMINAL', own);
      await count('UNPROVEN');
      await count('ADDRESS');
      await count('TERMINAL');
    }
    const fullest = passed.reduce<CountResult | undefined>((a, b) => (a === undefined || b.remaining < a.remaining ? b : a), undefined);
    if (fullest) rateHeaders(reply, fullest, false);
  };
}

function noSession(): Error {
  return refusal(401, {
    code: 'NO_SESSION',
    kind: 'NOT_ALLOWED',
    whatHappened: 'You are not signed in on this installation.',
    whatYouCanDo: ['Sign in again.'],
  });
}

/** NO_SESSION, saying why: the session's role was withdrawn, and the session has ended (F36). */
function roleWithdrawn(session: ResolvedSession): Error {
  return refusal(401, {
    code: 'NO_SESSION',
    kind: 'NOT_ALLOWED',
    whatHappened: 'You are not signed in on this installation: the session ended because its role is no longer granted to you.',
    why:
      session.declaredRole === null
        ? 'The account holds no role now.'
        : `The role ${session.declaredRole} this session worked in was revoked or has expired.`,
    controls: ['DI-16', 'DI-38'],
    whatYouCanDo: ['Sign in again, in a role you hold.'],
    whoCanHelp: ['The system administrator (role grants)'],
  });
}

/**
 * The page's own terminal key (the SHA-256 hex of the SPKI of the key it signs device proofs with) and the person the
 * page's session started with, sent by the SPA on every request (review F41, round 4; ADR 0017 item 4).
 */
export const TERMINAL_KEY_HEADER = 'x-ebmr-terminal-key';
export const PAGE_PERSON_HEADER = 'x-ebmr-page-person';

const headerValue = (request: FastifyRequest, name: string): string | undefined => {
  const v = request.headers[name];
  return v === undefined ? undefined : Array.isArray(v) ? v.join(',') : v;
};

/**
 * F41 round 4 (DI-13, DI-14, DI-38): cookies ignore ports, so a page on another port of the host can set this
 * installation's session cookie when the browser holds none (another person's live session), and another tab's sign-in
 * replaces it while a page works. A request whose page names its terminal key or the person its session started with
 * is served as nobody when the cookie's session was opened on another terminal (SESSION_OTHER_TERMINAL) or is another
 * person's (SESSION_CHANGED); the refusal, or null when the session is the page's (or the request names neither, as a
 * tool's does). The facts come from the database (tab.resolve_session, tablets 0550); the page is the server's to check,
 * as the Origin, the CSRF token and a doubled cookie are.
 */
export function pageBindingRefusal(request: FastifyRequest, session: ResolvedSession | null): Error | null {
  if (!session) return null;
  const key = headerValue(request, TERMINAL_KEY_HEADER);
  if (key !== undefined && key !== session.deviceFingerprint) {
    return refusal(401, {
      code: 'SESSION_OTHER_TERMINAL',
      kind: 'NOT_ALLOWED',
      whatHappened: 'The sign-in this browser sent was opened on another terminal, so the request was not served.',
      why: 'The session cookie belongs to a session of another terminal; another page of this computer may have set it.',
      controls: ['DI-13', 'DI-14', 'DI-38'],
      whatYouCanDo: ['Sign in again on this terminal.', 'If it happens again, close the pages of other addresses of this computer, then clear the cookies of this site.'],
      whoCanHelp: ['The system administrator'],
    });
  }
  const person = headerValue(request, PAGE_PERSON_HEADER);
  if (person !== undefined && person !== session.personId) {
    return refusal(401, {
      code: 'SESSION_CHANGED',
      kind: 'NOT_ALLOWED',
      whatHappened: 'The sign-in this browser sent is another person\'s than the one this page was signed in as, so the request was not served.',
      why: 'Another tab signed in as someone else, or another page of this computer set the sign-in cookie.',
      controls: ['DI-13', 'DI-14', 'DI-38'],
      whatYouCanDo: ['Start the page again: it then shows who is signed in on this browser now.'],
    });
  }
  return null;
}

/**
 * The session gate of a route of `auth: 'SESSION'` (DI-16, DI-38): throws the refusal a request of route `routeId` gets
 * with `session` (no session, a session ended, expired, locked or without a role), or returns the session it may serve.
 * DI-16 (tablets 0400, review F36): a session whose role was revoked or has expired ends here, on every route (reads,
 * keep-alive, unlock and session.get included); the person signs in again in a role they hold. Also asked again by an
 * open stream (devices.live), so a stream follows its session as each new request does (SSE-SESSION).
 */
export async function admitSession(app: AppContext, routeId: string, session: ResolvedSession | null): Promise<ResolvedSession> {
  if (session?.state === 'ROLE_WITHDRAWN') {
    await app.pools.app.query('select tab.end_withdrawn_session($1)', [session.tokenHash]);
    throw roleWithdrawn(session);
  }
  if (!session || session.state === 'ENDED' || session.state === 'EXPIRED' || session.state === 'UNKNOWN') throw noSession();
  if ((session.state === 'LOCKED' || session.state === 'IDLE_LOCKED') && !ALLOWED_WHEN_LOCKED.has(routeId)) {
    throw refusal(423, {
      code: 'SESSION_LOCKED',
      kind: 'LOCKED',
      whatHappened: 'This session is locked.',
      why: session.state === 'IDLE_LOCKED' ? 'The terminal was idle longer than the lock time.' : 'The session was locked.',
      controls: ['DI-38'],
      whatYouCanDo: ['Unlock it with your own credentials, or sign in as another person.'],
    });
  }
  // Review 4b-1: any session of an account holding the QP role, whatever role it chose (the database keeps that role the
  // account's only one while a QP access is live).
  if ((session.roleCode === QP_READER_ROLE || session.roles.includes(QP_READER_ROLE)) && !ALLOWED_FOR_QP_READER.has(routeId)) {
    throw refusal(403, {
      code: 'QP_READER_SCOPE',
      kind: 'NOT_ALLOWED',
      whatHappened: 'This account reads the QP batch package of its lot only.',
      why: 'A QP account is read-only and scoped to the lot its access names.',
      controls: ['DI-14', 'DI-17'],
      whatYouCanDo: ['Open the package list.'],
    });
  }
  if ((session.roleCode === CONTRACT_GIVER_ROLE || session.roles.includes(CONTRACT_GIVER_ROLE)) && !ALLOWED_FOR_CONTRACT_GIVER.has(routeId)) {
    throw refusal(403, {
      code: 'CONTRACT_GIVER_SCOPE',
      kind: 'NOT_ALLOWED',
      whatHappened: 'This account reads the records of its contract giver\'s batches only.',
      why: 'The contract giver\'s reviewer is read-only and scoped to the batches of the loan licence its access names (IN-30).',
      controls: ['IN-30', 'DI-17'],
      whatYouCanDo: ['Open the batch list.'],
    });
  }
  if (session.roleCode === null && !ALLOWED_WITHOUT_ROLE.has(routeId)) {
    throw refusal(409, {
      code: 'ROLE_CHOICE_REQUIRED',
      kind: 'NOT_ALLOWED',
      whatHappened: 'Choose the role you are working in before you continue.',
      whatYouCanDo: ['Pick one of your roles.'],
      details: { roles: session.roles.join(',') },
    });
  }
  return session;
}

export function bindRoutes<NS extends RouteNamespace>(scope: FastifyInstance, app: AppContext, ns: NS, handlers: Handlers<NS>, opts: BindOptions = {}): string[] {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const registered: string[] = [];
  for (const [name, route] of Object.entries(ns)) {
    if (route.installation !== 'ANY' && route.installation !== app.installation) continue;
    const handler = (handlers as Record<string, Handler<AnyRoute>>)[name];
    if (!handler) throw new Error(`no handler for route ${route.id}`);
    const nonGet = route.method !== 'GET';
    const preHandlers: (preHandlerHookHandler | preHandlerAsyncHookHandler)[] = [];
    const rl = opts.rateLimits?.[name];
    if (rl?.by === 'DEVICE') preHandlers.push(deviceRateGate(scope, app, route.id, rl));

    const sessionGate: preHandlerAsyncHookHandler = async (request) => {
      const session = await sessionOf(app, request);
      if (route.auth !== 'SESSION') return;
      // F41 round 4: a session the page did not start with is served as nobody, and nothing of it is touched.
      const foreign = pageBindingRefusal(request, session);
      if (foreign) {
        request.ebmrSession = null;
        throw foreign;
      }
      if (session?.state === 'ROLE_WITHDRAWN') request.ebmrSession = null;
      await admitSession(app, route.id, session);
    };
    preHandlers.push(sessionGate);
    if (nonGet && route.auth === 'SESSION') preHandlers.push((request, reply, done) => scope.csrfProtection(request, reply, done));
    const commandGate: preHandlerAsyncHookHandler = async (request) => {
      if (route.idempotency === 'REQUIRED') {
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || !UUID.test(key)) {
          throw refusal(428, {
            code: 'IDEMPOTENCY_KEY_REQUIRED',
            kind: 'INVALID_INPUT',
            whatHappened: 'The request had no idempotency key, so it was not run.',
            whatYouCanDo: ['Reload the page and try again.'],
          });
        }
      }
      const session = request.ebmrSession;
      if (route.attribution === 'FRESH_ON_SHARED' && session && isShopFloor(session.deviceClass)) {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const result = await resolveAttribution({
          app,
          session,
          attribution: body['attribution'] as Attribution | undefined,
          method: request.method,
          path: pathOf(request),
          body: withoutAttribution(body),
        });
        request.ebmrAuthEventId = result.authEventId;
      }
    };
    preHandlers.push(commandGate);

    typed.route({
      method: route.method,
      url: route.path,
      schema: {
        params: route.params,
        querystring: route.query,
        ...(route.body && nonGet ? { body: route.body } : {}),
        ...(route.stream ? {} : { response: { 200: route.response, '4xx': RefusalEnvelope, '5xx': RefusalEnvelope } }),
      },
      ...(rl && rl.by !== 'DEVICE'
        ? {
            config: {
              rateLimit: {
                max: rl.max,
                timeWindow: rl.timeWindow,
                keyGenerator: (request: FastifyRequest) => {
                  if (rl.by === 'SESSION') return `${route.id}|${requestTokenHash(request, app.config) ?? request.ip}`;
                  const body = (request.body ?? {}) as Record<string, unknown>;
                  const who = typeof body['identifier'] === 'string' ? body['identifier'] : typeof body['badgeUid'] === 'string' ? body['badgeUid'] : '';
                  return `${route.id}|${request.ip}|${who.toLowerCase()}`;
                },
              },
            },
          }
        : {}),
      preHandler: preHandlers,
      handler: async (request, reply) => {
        const session = request.ebmrSession ?? null;
        const correlationId = String(request.id);
        const ctx: HandlerContext<AnyRoute> = {
          route,
          params: request.params,
          query: request.query,
          body: request.body,
          request,
          reply,
          app,
          correlationId,
          session,
          requireSession() {
            if (!session) throw noSession();
            return session;
          },
          actor(extras = {}) {
            if (!session) throw noSession();
            return actorFrom(session, app.siteZone.current(), {
              correlationId,
              ...(request.ebmrAuthEventId ? { authEventId: request.ebmrAuthEventId } : {}),
              ...extras,
            });
          },
          requireRole(...roles) {
            if (!session?.roleCode || !roles.includes(session.roleCode)) {
              throw refusal(403, {
                code: 'ROLE_NOT_ALLOWED',
                kind: 'NOT_ALLOWED',
                whatHappened: 'Your role cannot use this function.',
                why: `This function is for ${roles.join(', ')}; you are working as ${session?.roleCode ?? 'no role'}.`,
                whatYouCanDo: ['Ask a person in one of those roles.'],
              });
            }
          },
          idempotencyKey: typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : null,
          requestHash: requestHashOf(route.id, request.params, request.query, request.body),
        };
        // O-T13-1: a failure after the request's command committed is not "nothing was saved" (savedNotShown). A
        // refusal the handler throws on purpose after a commit (the e-signature's recorded refusal) stays as it is.
        const { scope, outcome } = await inCommandScope(() => handler(ctx));
        if (!outcome.ok) {
          if (scope.committed && !reply.sent && !(outcome.error instanceof HttpRefusal)) {
            request.log.error({ err: outcome.error, correlationId, commandId: scope.commandId }, 'the command committed; its answer could not be built');
            throw savedNotShown(scope.commandId);
          }
          throw outcome.error;
        }
        if (reply.sent) return reply;
        return outcome.value;
      },
    });
    app.boundRoutes.set(route.id, { method: route.method, path: route.path, installation: app.installation });
    registered.push(route.id);
  }
  return registered;
}

/**
 * The answer when a route's command committed and only the answer after it failed (O-T13-1): the request was saved
 * (or answered from its stored result), so the screen must not say "nothing was saved". It names the command by its
 * idempotency key; a resend with that key returns the stored result. Status 500 (the answer is missing), not retryable:
 * the person reloads instead of entering it again.
 */
export function savedNotShown(commandId: string | null): HttpRefusal {
  return refusal(500, {
    code: 'SAVED_NOT_SHOWN',
    kind: 'STALE',
    whatHappened: 'Saved; the result could not be shown. Reload the screen to see it.',
    why: `The action was saved${commandId ? ` (command ${commandId})` : ''}; reading its result afterwards failed, and the error is logged under the correlation id.`,
    whatYouCanDo: ['Reload the screen; do not enter it again.', 'If the record does not show the action after a reload, quote the command id and the correlation id.'],
    whoCanHelp: ['The system administrator (quote the command id and the correlation id)'],
    ...(commandId ? { details: { commandId } } : {}),
  });
}

/**
 * For stub feature files: binds every route of a namespace to a 501 "not available yet" answer, so the route
 * inventory is complete before the owning module lands.
 */
export function bindStubRoutes<NS extends RouteNamespace>(scope: FastifyInstance, app: AppContext, ns: NS, owner: string): string[] {
  const handlers = Object.fromEntries(
    Object.keys(ns).map((name) => [
      name,
      () =>
        Promise.reject(
          refusal(501, {
            code: 'NOT_IMPLEMENTED',
            kind: 'NOT_ENABLED',
            whatHappened: 'This function is not available yet.',
            why: `It arrives with module ${owner}.`,
            whatYouCanDo: ['Use another path for now.'],
          }),
        ),
    ]),
  ) as unknown as Handlers<NS>;
  return bindRoutes(scope, app, ns, handlers);
}
