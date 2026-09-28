/**
 * Typed client (Phase 2 apps plan section 4, "Client"): `createApiClient({fetch}).call(route, input)` returns
 * a Result, never throws for an HTTP refusal. It adds X-CSRF-Token and Idempotency-Key, parses the response
 * with the route's own schema and checks X-Ebmr-Installation against the installation the app started on.
 * Browser-safe; the server tests drive app.inject through the same client.
 *
 * Secrets never enter caches: the client keeps no response, and callers must not put credential-bearing
 * requests in TanStack Query.
 */
import { z } from 'zod';
import { RefusalEnvelope, type Attribution, type InstallationKind } from './common.ts';
import { buildPath, type AnyRoute, type RouteBodyInput, type RouteParamsInput, type RouteQueryInput, type RouteResponse } from './route.ts';

export const INSTALLATION_HEADER = 'x-ebmr-installation';
export const CSRF_HEADER = 'x-csrf-token';
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const CORRELATION_HEADER = 'x-correlation-id';

type HasKeys<T> = [keyof T] extends [never] ? false : true;
type Slot<Name extends string, T> = T extends undefined ? { [K in Name]?: undefined } : HasKeys<T> extends true ? ({} extends T ? { [K in Name]?: T } : { [K in Name]: T }) : { [K in Name]?: T };

export type CallInput<R extends AnyRoute> = Slot<'params', RouteParamsInput<R>> &
  Slot<'query', RouteQueryInput<R>> &
  Slot<'body', RouteBodyInput<R>> & {
    /** Required by REQUIRED routes; the same key on a resend (decision D1). Generated when absent. */
    idempotencyKey?: string;
    /** Merged into the body of FRESH_ON_SHARED routes. */
    attribution?: Attribution;
    signal?: AbortSignal;
  };

export type CallError =
  | { kind: 'REFUSAL'; status: number; envelope: RefusalEnvelope }
  | { kind: 'NETWORK'; message: string }
  | { kind: 'PROTOCOL'; status: number; message: string }
  | { kind: 'INSTALLATION_MISMATCH'; expected: InstallationKind; actual: string | null };

export type Result<T, E = CallError> = { ok: true; value: T; status: number } | { ok: false; error: E };

/** A fetch function: the browser's, a fixture fetch, or app.inject wrapped by the server test harness. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; credentials?: 'same-origin' }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface ApiClientOptions {
  fetch: FetchLike;
  /** Prefix for paths, '' for same origin. */
  baseUrl?: string;
  /** The installation the app started on (from /api/meta); every response must carry it. */
  installation?: () => InstallationKind | undefined;
  /** The session's CSRF token, sent on every non-GET request. */
  csrfToken?: () => string | undefined;
  /** Extra headers (the server test harness sets Origin and Sec-Fetch-Site here). */
  headers?: () => Record<string, string>;
  /** Called once when a response comes from the other installation; the SPA stops. */
  onInstallationMismatch?: (expected: InstallationKind, actual: string | null) => void;
  newIdempotencyKey?: () => string;
}

export interface ApiClient {
  call<R extends AnyRoute>(route: R, input?: CallInput<R>): Promise<Result<RouteResponse<R>>>;
  /** The URL a route resolves to (for EventSource and links). */
  url<R extends AnyRoute>(route: R, input?: Pick<CallInput<R>, 'params' | 'query'>): string;
}

function queryString(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v as string | number | boolean))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function randomKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!c?.randomUUID) throw new Error('crypto.randomUUID is not available to generate an idempotency key');
  return c.randomUUID();
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const base = options.baseUrl ?? '';
  let mismatchReported = false;

  const url = <R extends AnyRoute>(route: R, input?: Pick<CallInput<R>, 'params' | 'query'>): string =>
    `${base}${buildPath(route.path, input?.params as Record<string, unknown> | undefined)}${queryString(input?.query as Record<string, unknown> | undefined)}`;

  async function call<R extends AnyRoute>(route: R, input?: CallInput<R>): Promise<Result<RouteResponse<R>>> {
    const headers: Record<string, string> = { accept: 'application/json', ...(options.headers?.() ?? {}) };
    let body: string | undefined;
    if (route.method !== 'GET') {
      const payload: Record<string, unknown> = { ...((input?.body as Record<string, unknown> | undefined) ?? {}) };
      if (route.attribution === 'FRESH_ON_SHARED' && input?.attribution) payload['attribution'] = input.attribution;
      body = JSON.stringify(payload);
      headers['content-type'] = 'application/json';
      const csrf = options.csrfToken?.();
      if (csrf) headers[CSRF_HEADER] = csrf;
      if (route.idempotency === 'REQUIRED') headers[IDEMPOTENCY_HEADER] = input?.idempotencyKey ?? (options.newIdempotencyKey ?? randomKey)();
    }
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await options.fetch(url(route, input as Pick<CallInput<R>, 'params' | 'query'> | undefined), {
        method: route.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(input?.signal ? { signal: input.signal } : {}),
        credentials: 'same-origin',
      });
    } catch (error) {
      return { ok: false, error: { kind: 'NETWORK', message: error instanceof Error ? error.message : String(error) } };
    }
    const expected = options.installation?.();
    const actual = response.headers.get(INSTALLATION_HEADER);
    if (expected !== undefined && actual !== expected) {
      if (!mismatchReported) {
        mismatchReported = true;
        options.onInstallationMismatch?.(expected, actual);
      }
      return { ok: false, error: { kind: 'INSTALLATION_MISMATCH', expected, actual } };
    }
    let json: unknown;
    try {
      const text = await response.text();
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      return { ok: false, error: { kind: 'PROTOCOL', status: response.status, message: 'the response is not JSON' } };
    }
    if (response.status >= 200 && response.status < 300) {
      const parsed = (route.response as z.ZodType).safeParse(json);
      if (!parsed.success) {
        return { ok: false, error: { kind: 'PROTOCOL', status: response.status, message: `the response does not match ${route.id}: ${z.prettifyError(parsed.error)}` } };
      }
      return { ok: true, value: parsed.data as RouteResponse<R>, status: response.status };
    }
    const envelope = RefusalEnvelope.safeParse(json);
    if (!envelope.success) return { ok: false, error: { kind: 'PROTOCOL', status: response.status, message: `status ${response.status} without a refusal envelope` } };
    return { ok: false, error: { kind: 'REFUSAL', status: response.status, envelope: envelope.data } };
  }

  return { call, url };
}

/** A plain-language line for any call error (screens show the full refusal panel for REFUSAL). */
export function describeCallError(error: CallError): string {
  switch (error.kind) {
    case 'REFUSAL':
      return error.envelope.refusal.whatHappened;
    case 'NETWORK':
      return 'The server could not be reached. Nothing was saved by this attempt unless the record shows it.';
    case 'PROTOCOL':
      return `The server answered in an unexpected way (${error.message}).`;
    case 'INSTALLATION_MISMATCH':
      return `This screen belongs to the ${error.expected} installation, but the answer came from ${error.actual ?? 'an unknown installation'}. Reload the page.`;
  }
}
