/**
 * The typed client (plan section 4): headers, attribution, response parsing, refusals and the installation check.
 */
import { describe, expect, it } from 'vitest';
import { createApiClient, describeCallError, routes, type FetchLike } from '../src/index.ts';
import { EXAMPLES } from '../src/examples.ts';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(status: number, json: unknown, installation: string | null, seen: Seen[]): FetchLike {
  return (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    return Promise.resolve({
      status,
      headers: { get: (name: string) => (name.toLowerCase() === 'x-ebmr-installation' ? installation : null) },
      text: () => Promise.resolve(json === undefined ? '' : JSON.stringify(json)),
    });
  };
}

describe('api client', () => {
  it('builds the path, sends CSRF, idempotency key and attribution on a FRESH_ON_SHARED command, and parses the response', async () => {
    const seen: Seen[] = [];
    const step = EXAMPLES['step-g04-parameters'].data;
    const client = createApiClient({
      fetch: fakeFetch(200, { accepted: true, version: 8, step }, 'SANDBOX', seen),
      installation: () => 'SANDBOX',
      csrfToken: () => 'csrf-1',
    });
    const runId = '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
    const attribution = { method: 'BADGE_TAP' as const, badgeUid: '04A1B2C3', proof: { spki: 'AAAA', nonce: 'n'.repeat(22), sig: 'BBBB' } };
    const result = await client.call(routes.execution.command, {
      params: { runId },
      body: { expectedVersion: 7, intent: { type: 'START_STEP', stepKey: 'p-blend@' } },
      idempotencyKey: '11111111-2222-4333-8444-555555555555',
      attribution,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.version).toBe(8);
    expect(seen[0]?.url).toBe(`/api/test-runs/${runId}/commands`);
    expect(seen[0]?.headers).toMatchObject({ 'x-csrf-token': 'csrf-1', 'idempotency-key': '11111111-2222-4333-8444-555555555555', 'content-type': 'application/json' });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ expectedVersion: 7, intent: { type: 'START_STEP', stepKey: 'p-blend@' }, attribution });
  });

  it('GET requests carry neither body nor CSRF token; query strings are encoded', async () => {
    const seen: Seen[] = [];
    const client = createApiClient({ fetch: fakeFetch(200, { events: [], nextCursor: null }, 'GMP', seen), installation: () => 'GMP', csrfToken: () => 'x' });
    const result = await client.call(routes.audit.events, { query: { chainKey: 'batch:a b', limit: '50' } });
    expect(result.ok).toBe(true);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/audit/events?chainKey=batch%3Aa%20b&limit=50' });
    expect(seen[0]?.body).toBeUndefined();
    expect(seen[0]?.headers['x-csrf-token']).toBeUndefined();
  });

  it('returns the refusal envelope of a non-2xx answer', async () => {
    const envelope = {
      refusal: { code: 'ENG-STALE', kind: 'STALE', whatHappened: 'Someone else changed this batch.', why: 'expected version 7, found 8', controls: [], whatYouCanDo: ['Reload the step.'], whoCanHelp: [] },
      correlationId: 'c-9',
      retryable: false,
    };
    const client = createApiClient({ fetch: fakeFetch(409, envelope, 'SANDBOX', []), installation: () => 'SANDBOX' });
    const result = await client.call(routes.execution.run, { params: { runId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e' } });
    expect(result).toEqual({ ok: false, error: { kind: 'REFUSAL', status: 409, envelope } });
    if (!result.ok) expect(describeCallError(result.error)).toBe('Someone else changed this batch.');
  });

  it('[DI-05] refuses an answer from the other installation and reports it once', async () => {
    const reports: string[] = [];
    const client = createApiClient({
      fetch: fakeFetch(200, EXAMPLES['meta-gmp'].data, 'GMP', []),
      installation: () => 'SANDBOX',
      onInstallationMismatch: (e, a) => reports.push(`${e}->${String(a)}`),
    });
    const a = await client.call(routes.meta.get);
    const b = await client.call(routes.meta.get);
    expect(a).toEqual({ ok: false, error: { kind: 'INSTALLATION_MISMATCH', expected: 'SANDBOX', actual: 'GMP' } });
    expect(b.ok).toBe(false);
    expect(reports).toEqual(['SANDBOX->GMP']);
  });

  it('a response that does not match the schema is a protocol error, not data', async () => {
    const client = createApiClient({ fetch: fakeFetch(200, { installation: 'GMP' }, 'GMP', []), installation: () => 'GMP' });
    const result = await client.call(routes.meta.get);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('PROTOCOL');
  });

  it('a network failure is reported as such', async () => {
    const client = createApiClient({ fetch: () => Promise.reject(new Error('socket hang up')) });
    expect(await client.call(routes.meta.get)).toEqual({ ok: false, error: { kind: 'NETWORK', message: 'socket hang up' } });
  });
});
