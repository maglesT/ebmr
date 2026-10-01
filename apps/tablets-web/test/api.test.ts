/**
 * The web API layer (plan section 4): the fixture fetch answers contract routes from the example views through
 * the same typed client, and device proofs verify with the same message the server checks.
 */
import { describe, expect, it } from 'vitest';
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
      expect([first.nonce, first.spki, second.nonce]).toEqual(['nonce-served-000000001', spki, 'nonce-served-000000002']);
    } finally {
      setTransport(browserFetch);
    }
  });
});
