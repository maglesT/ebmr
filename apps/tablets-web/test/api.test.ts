/**
 * The web API layer (plan section 4): the fixture fetch answers contract routes from the example views through
 * the same typed client, and device proofs verify with the same message the server checks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, DeviceNonceRequest, routes, type FetchLike } from '@ebmr/api-contract';
import { browserFetch, deviceProof, setTransport } from '../src/api/client.ts';
import { createFixtureFetch } from '../src/api/fixture-fetch.ts';
import { fixturesFromExamples } from '../src/api/examples.ts';
import { proofMessage, signProof } from '../src/device/proof.ts';
import { base64ToBytes, bytesToBase64 } from '../src/device/base64.ts';

describe('fixture fetch (C4 works against it before the sandbox server exists)', () => {
  const client = createApiClient({ fetch: createFixtureFetch(fixturesFromExamples('SANDBOX'), { installation: 'SANDBOX' }), installation: () => 'SANDBOX' });

  it('[DI-05] serves step screens by step key, parsed by the contract schemas, with the sandbox watermark', async () => {
    const r = await client.call(routes.execution.step, { params: { runId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', stepKey: 'p-disp-api@' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.step.block).toBe('G-07@1');
      expect(r.value.run.watermark.text).toBe('TEST, NOT GMP');
    }
    const meta = await client.call(routes.meta.get);
    expect(meta.ok && meta.value.installation).toBe('SANDBOX');
  });

  it('answers an unknown route with a refusal envelope', async () => {
    const r = await client.call(routes.execution.lot, { params: { code: 'TEST-L1' } });
    expect(!r.ok && r.error.kind === 'REFUSAL' && r.error.status).toBe(404);
  });
});

describe('device proofs', () => {
  it('[DI-20] a WebCrypto P-256 signature over nonce|METHOD|path|body hash verifies with the public key', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const spki = bytesToBase64(await crypto.subtle.exportKey('spki', pair.publicKey));
    const proof = await signProof({ privateKey: pair.privateKey, publicKeySpki: spki, label: 'T' }, 'nonce-123456789012', 'post', '/api/session/login', { b: 1, a: 'x' });
    expect(proof.spki).toBe(spki);
    const message = proofMessage('nonce-123456789012', 'POST', '/api/session/login', { a: 'x', b: 1 });
    expect(message.startsWith('nonce-123456789012|POST|/api/session/login|')).toBe(true);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, base64ToBytes(proof.sig), new TextEncoder().encode(message));
    expect(ok).toBe(true);
  });

  it('[DI-19][DI-20] the nonce request names the terminal key and, from the second on, the nonce of its last proof (its proof ticket), and the proof signs the nonce served', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const spki = bytesToBase64(await crypto.subtle.exportKey('spki', pair.publicKey));
    const key = { privateKey: pair.privateKey, publicKeySpki: spki, label: 'T' };
    const sent: { path: string; body: unknown }[] = [];
    let served = 0;
    const transport: FetchLike = (url, init) => {
      sent.push({ path: new URL(url, 'http://test.local').pathname, body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown) });
      served += 1;
      return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify({ nonce: `nonce-served-00000000${served}`, expiresInSeconds: 60 })) });
    };
    setTransport(transport);
    try {
      const first = await deviceProof(key, 'POST', '/api/session/login', { a: 1 });
      const second = await deviceProof(key, 'POST', '/api/session/unlock', { b: 2 });
      expect(sent).toEqual([
        { path: routes.session.deviceNonce.path, body: { spki } },
        { path: routes.session.deviceNonce.path, body: { spki, lastNonce: 'nonce-served-000000001' } },
      ]);
      for (const s of sent) expect(DeviceNonceRequest.safeParse(s.body).success).toBe(true);
      if (!first.ok || !second.ok) throw new Error('no device proof');
      expect([first.proof.nonce, first.proof.spki, second.proof.nonce]).toEqual(['nonce-served-000000001', spki, 'nonce-served-000000002']);
    } finally {
      setTransport(browserFetch);
    }
  });
});

// Review F41: the server refuses a request that carried this installation's cookie twice (a copy another page of
// the host set) and removes the copy; the page sends that request once more, never more often.
describe('a request refused as COOKIE_DUPLICATED', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const refused = () => new Response(JSON.stringify({ refusal: { code: 'COOKIE_DUPLICATED' } }), { status: 401 });
  const ok = () => new Response('{"ok":true}', { status: 200 });

  it('[DI-13][DI-38] is sent once more, with the same method, headers and body, and the second answer is the answer', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const answers = [refused(), ok()];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(answers.shift());
    });
    const res = await browserFetch('/api/session/keep-alive', { method: 'POST', headers: { 'x-csrf-token': 't' }, body: '{}' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(calls.map((c) => [c.url, c.init.method, c.init.body, c.init.headers])).toEqual([
      ['/api/session/keep-alive', 'POST', '{}', { 'x-csrf-token': 't' }],
      ['/api/session/keep-alive', 'POST', '{}', { 'x-csrf-token': 't' }],
    ]);
  });

  it('[DI-13] is retried only once, and no other refusal is retried', async () => {
    let n = 0;
    vi.stubGlobal('fetch', () => {
      n += 1;
      return Promise.resolve(refused());
    });
    const twice = await browserFetch('/api/session', { method: 'GET', headers: {} });
    expect(twice.status).toBe(401);
    expect(JSON.parse(await twice.text())).toEqual({ refusal: { code: 'COOKIE_DUPLICATED' } });
    expect(n).toBe(2);
    n = 0;
    vi.stubGlobal('fetch', () => {
      n += 1;
      return Promise.resolve(new Response(JSON.stringify({ refusal: { code: 'NO_SESSION' } }), { status: 401 }));
    });
    expect((await browserFetch('/api/session', { method: 'GET', headers: {} })).status).toBe(401);
    expect(n).toBe(1);
  });
});
