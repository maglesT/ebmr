/**
 * bindRoutes (plan section 4, "Server binding"): registers a namespace of the frozen contract with a handler
 * per route. The mapped Handlers type makes a missing handler a compile error; the zod type provider validates
 * requests and responses (so drift fails the server tests); routes of the other installation are not
 * registered at all (they answer 404 there).
 *
 * Every route passes the same gates, in this order:
 *  1. (global hooks) correlation id, X-Ebmr-Installation, no-store, exact Origin and Sec-Fetch-Site on non-GET;
 *  2. session: 401 without a live session, 423 when locked, 409 until the role is chosen (SESSION routes);
 *  3. CSRF token bound to the session token (non-GET SESSION routes);
 *  4. Idempotency-Key (REQUIRED routes): 428 when missing;
 *  5. attribution (FRESH_ON_SHARED routes on SHARED and GRADE_A_B terminals): the C1 hook, 428 without a tap;
 *  6. the handler, with a typed context.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler, preHandlerHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import type { ActorContext } from '@ebmr/kernel';
import { RefusalEnvelope, type AnyRoute, type Attribution, type RouteBody, type RouteNamespace, type RouteParams, type RouteQuery, type RouteResponse } from '@ebmr/api-contract';
import { actorFrom } from '../auth/actor.ts';
import { resolveAttribution } from '../auth/attribution.ts';
import { isShopFloor, requestTokenHash, resolveSession, type ResolvedSession } from '../auth/session.ts';
import type { AppContext } from '../context.ts';
import { refusal } from './refusal.ts';

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
  requireSession(): ResolvedSession;
  /** The ActorContext of this request (with the badge-tap event on shared terminals). */
  actor(extras?: { reasonCode?: string; reasonText?: string }): ActorContext & { deviceId: string };
  /** Route-level role gate on the declared role (403 otherwise). */
  requireRole(...roles: string[]): void;
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

export interface BindOptions {
  /** Per route name. Auth, tap and unlock 10/min per IP and identifier; sign 20/min per session (plan section 5). */
  rateLimits?: Readonly<Record<string, RateLimitSpec>>;
}

/** Routes that work while the session is locked (to show the lock, unlock, switch or leave). */
const ALLOWED_WHEN_LOCKED = new Set(['session.get', 'session.logout', 'access.lock', 'access.unlock', 'access.switchUser']);
/** Routes that work before the role is chosen. */
const ALLOWED_WITHOUT_ROLE = new Set(['session.get', 'session.chooseRole', 'session.logout', 'access.lock', 'access.unlock', 'access.switchUser', 'access.keepAlive']);
/** Body members never part of a request hash, a log line or a proof subject. */
const SECRET_MEMBERS = ['attribution', 'credentials', 'proof', 'secret', 'pin', 'password', 'newSecret', 'currentSecret', 'changeTicket'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function noSession(): Error {
  return refusal(401, {
    code: 'NO_SESSION',
    kind: 'NOT_ALLOWED',
    whatHappened: 'You are not signed in on this installation.',
    whatYouCanDo: ['Sign in again.'],
  });
}

export function bindRoutes<NS extends RouteNamespace>(scope: FastifyInstance, app: AppContext, ns: NS, handlers: Handlers<NS>, opts: BindOptions = {}): string[] {
  const typed = scope.withTypeProvider<ZodTypeProvider>();
  const registered: string[] = [];
  for (const [name, route] of Object.entries(ns) as [string, AnyRoute][]) {
    if (route.installation !== 'ANY' && route.installation !== app.installation) continue;
    const handler = (handlers as Record<string, Handler<AnyRoute>>)[name];
    if (!handler) throw new Error(`no handler for route ${route.id}`);
    const nonGet = route.method !== 'GET';
    const preHandlers: (preHandlerHookHandler | onRequestHookHandler)[] = [];

    preHandlers.push(async (request) => {
      const session = await sessionOf(app, request);
      if (route.auth !== 'SESSION') return;
      if (!session || session.state === 'ENDED' || session.state === 'EXPIRED' || session.state === 'UNKNOWN') throw noSession();
      if ((session.state === 'LOCKED' || session.state === 'IDLE_LOCKED') && !ALLOWED_WHEN_LOCKED.has(route.id)) {
        throw refusal(423, {
          code: 'SESSION_LOCKED',
          kind: 'LOCKED',
          whatHappened: 'This session is locked.',
          why: session.state === 'IDLE_LOCKED' ? 'The terminal was idle longer than the lock time.' : 'The session was locked.',
          controls: ['DI-38'],
          whatYouCanDo: ['Unlock it with your own credentials, or sign in as another person.'],
        });
      }
      if (session.roleCode === null && !ALLOWED_WITHOUT_ROLE.has(route.id)) {
        throw refusal(409, {
          code: 'ROLE_CHOICE_REQUIRED',
          kind: 'NOT_ALLOWED',
          whatHappened: 'Choose the role you are working in before you continue.',
          whatYouCanDo: ['Pick one of your roles.'],
          details: { roles: session.roles.join(',') },
        });
      }
    });
    if (nonGet && route.auth === 'SESSION') preHandlers.push(scope.csrfProtection as unknown as preHandlerHookHandler);
    preHandlers.push(async (request) => {
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
          body: withoutSecrets(body),
        });
        request.ebmrAuthEventId = result.authEventId;
      }
    });

    const rl = opts.rateLimits?.[name];
    typed.route({
      method: route.method,
      url: route.path,
      schema: {
        params: route.params,
        querystring: route.query,
        ...(route.body && nonGet ? { body: route.body } : {}),
        ...(route.stream ? {} : { response: { 200: route.response, '4xx': RefusalEnvelope, '5xx': RefusalEnvelope } }),
      },
      ...(rl
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
      preHandler: preHandlers as preHandlerHookHandler[],
      handler: async (request, reply) => {
        const session = request.ebmrSession ?? null;
        const correlationId = String(request.id);
        const ctx: HandlerContext<AnyRoute> = {
          route,
          params: request.params,
          query: request.query,
          body: request.body as RouteBody<AnyRoute>,
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
            return actorFrom(session, app.config.siteZone, {
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
        const result = await handler(ctx);
        if (reply.sent) return reply;
        return result;
      },
    });
    app.boundRoutes.set(route.id, { method: route.method, path: route.path, installation: app.installation });
    registered.push(route.id);
  }
  return registered;
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
