/**
 * Route definitions (Phase 2 apps plan section 4, "Routes"). One definition serves the server (bindRoutes with
 * the zod type provider: requests and responses are validated), the browser client (createApiClient) and the
 * coverage test (every route id registered exactly once, in the right installation).
 */
import { z } from 'zod';
import { Empty } from './common.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
/** Which server installation serves the route. ANY: both. */
export type RouteInstallation = 'GMP' | 'SANDBOX' | 'ANY';
/** NONE: no session needed (meta, device nonce, login). SESSION: a live, unlocked session. */
export type RouteAuth = 'NONE' | 'SESSION';
/** FRESH_ON_SHARED: on SHARED and GRADE_A_B devices the body carries a fresh badge tap (INV-40). */
export type RouteAttribution = 'NONE' | 'FRESH_ON_SHARED';
/** REQUIRED: the request carries an Idempotency-Key (UUID) and runs as one idempotent command; 428 without it. */
export type RouteIdempotency = 'REQUIRED' | 'NONE';

export interface RouteDef<
  Params extends z.ZodType = z.ZodType,
  Query extends z.ZodType = z.ZodType,
  Body extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  /** `<namespace>.<name>`, unique across the contract. */
  readonly id: string;
  readonly method: HttpMethod;
  /** Fastify path with `:param` segments, always under /api. */
  readonly path: string;
  readonly installation: RouteInstallation;
  readonly auth: RouteAuth;
  /** The route changes state (GMP data or the session). */
  readonly mutating: boolean;
  readonly attribution: RouteAttribution;
  readonly idempotency: RouteIdempotency;
  /** SSE routes stream `text/event-stream`; `response` then describes one event's data. */
  readonly stream?: 'SSE';
  readonly summary: string;
  readonly params: Params;
  readonly query: Query;
  /** Absent (undefined) for GET routes. */
  readonly body: Body | undefined;
  readonly response: Res;
}

export type AnyRoute = RouteDef<z.ZodType, z.ZodType, z.ZodType, z.ZodType>;

export interface RouteSpec<Params extends z.ZodType, Query extends z.ZodType, Body extends z.ZodType, Res extends z.ZodType> {
  id: string;
  method: HttpMethod;
  path: string;
  installation: RouteInstallation;
  auth: RouteAuth;
  mutating: boolean;
  attribution?: RouteAttribution;
  idempotency?: RouteIdempotency;
  stream?: 'SSE';
  summary: string;
  params?: Params;
  query?: Query;
  body?: Body;
  response: Res;
}

/**
 * Defines one route. Defaults: attribution NONE; idempotency REQUIRED for mutating SESSION routes, otherwise NONE.
 * A path parameter needs a params schema member and vice versa (checked here, at definition time).
 */
export function defineRoute<
  Res extends z.ZodType,
  Params extends z.ZodType = typeof Empty,
  Query extends z.ZodType = typeof Empty,
  Body extends z.ZodType = typeof Empty,
>(spec: RouteSpec<Params, Query, Body, Res>): RouteDef<Params, Query, Body, Res> {
  if (!spec.path.startsWith('/api/')) throw new Error(`route ${spec.id}: path ${spec.path} must start with /api/`);
  const names = [...spec.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1] ?? '');
  const params = (spec.params ?? Empty) as Params;
  const shape = params instanceof z.ZodObject ? Object.keys((params as unknown as z.ZodObject).shape) : [];
  if (names.length !== shape.length || names.some((n) => !shape.includes(n))) {
    throw new Error(`route ${spec.id}: path parameters [${names.join(', ')}] do not match the params schema [${shape.join(', ')}]`);
  }
  if (spec.method === 'GET' && spec.body) throw new Error(`route ${spec.id}: a GET route has no body`);
  if (spec.attribution === 'FRESH_ON_SHARED') {
    const body = spec.body as unknown;
    if (!(body instanceof z.ZodObject) || !('attribution' in body.shape)) {
      throw new Error(`route ${spec.id}: a FRESH_ON_SHARED route body must be built with withAttribution()`);
    }
  }
  const body = spec.method === 'GET' ? undefined : ((spec.body ?? Empty) as Body);
  return {
    id: spec.id,
    method: spec.method,
    path: spec.path,
    installation: spec.installation,
    auth: spec.auth,
    mutating: spec.mutating,
    attribution: spec.attribution ?? 'NONE',
    idempotency: spec.idempotency ?? (spec.mutating && spec.auth === 'SESSION' ? 'REQUIRED' : 'NONE'),
    ...(spec.stream ? { stream: spec.stream } : {}),
    summary: spec.summary,
    params,
    query: (spec.query ?? Empty) as Query,
    body,
    response: spec.response,
  };
}

/** Types a handler and a caller see for a route. */
export type RouteParams<R extends AnyRoute> = z.output<R['params']>;
export type RouteQuery<R extends AnyRoute> = z.output<R['query']>;
export type RouteBody<R extends AnyRoute> = NonNullable<R['body']> extends z.ZodType ? z.output<NonNullable<R['body']>> : undefined;
export type RouteResponse<R extends AnyRoute> = z.output<R['response']>;
export type RouteParamsInput<R extends AnyRoute> = z.input<R['params']>;
export type RouteQueryInput<R extends AnyRoute> = z.input<R['query']>;
export type RouteBodyInput<R extends AnyRoute> = NonNullable<R['body']> extends z.ZodType ? z.input<NonNullable<R['body']>> : undefined;

/** A namespace: route name -> route. */
export type RouteNamespace = Readonly<Record<string, AnyRoute>>;

/** Every route of a table of namespaces, flattened. */
export function allRoutes(table: Readonly<Record<string, RouteNamespace>>): AnyRoute[] {
  return Object.values(table).flatMap((ns) => Object.values(ns));
}

/** Fills `:param` segments (URI-encoded). */
export function buildPath(path: string, params: Readonly<Record<string, unknown>> | undefined): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, name: string) => {
    const v = params?.[name];
    if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`missing path parameter ${name} for ${path}`);
    return encodeURIComponent(String(v));
  });
}
