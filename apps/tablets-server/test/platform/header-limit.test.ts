/**
 * The listening server accepts request headers up to MAX_HEADER_BYTES, so a disposition proposal of the longest
 * allowed justification (4000 Devanagari characters, base64url in the esig content query) reaches the route; larger
 * headers are still refused before any route runs. Listening on 'localhost' binds every address the name resolves to,
 * each with that limit.
 */
import dns from 'node:dns';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_HEADER_BYTES, NODE_KEEP_ALIVE_TIMEOUT_MS, NODE_REQUEST_TIMEOUT_MS } from '../../src/app.ts';
import { startServer, type TestServer } from '../support/harness.ts';

let server: TestServer;
let base: string;
beforeAll(async () => {
  server = await startServer('SANDBOX');
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const address = server.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await server.close();
});

describe('request header limit', () => {
  it('a query as long as the longest disposition proposal reaches the route', async () => {
    const justification = 'क'.repeat(4000);
    const proposal = Buffer.from(JSON.stringify({ outcome: 'ACCEPT', justification }), 'utf8').toString('base64url');
    // Plus about 1 KiB that a browser adds (user agent, cookie, accept and sec-fetch headers): over node's 16 KiB default.
    const browserHeaders = 'b'.repeat(1024);
    expect(proposal.length + browserHeaders.length).toBeGreaterThan(16 * 1024);
    const res = await fetch(`${base}/api/meta?probe=${proposal}`, { headers: { 'x-browser-headers': browserHeaders } });
    expect(res.status).not.toBe(431);
  });

  it('headers beyond the limit are refused before any route runs', async () => {
    const res = await fetch(`${base}/api/meta?probe=${'a'.repeat(MAX_HEADER_BYTES + 1024)}`);
    expect(res.status).toBe(431);
  });
});

/** The longest disposition proposal's query plus about 1 KiB of browser headers, over node's 16 KiB default. */
async function longProposalStatus(base: string): Promise<number> {
  const proposal = Buffer.from(JSON.stringify({ outcome: 'ACCEPT', justification: 'क'.repeat(4000) }), 'utf8').toString('base64url');
  const res = await fetch(`${base}/api/meta?probe=${proposal}`, { headers: { 'x-browser-headers': 'b'.repeat(1024) } });
  return res.status;
}

describe('listening on localhost', () => {
  it('answers on every address localhost resolves to, not only the first, each with the raised header limit', async () => {
    // A host where localhost resolves to another loopback address first (::1 on GitHub's runners; 127.0.0.2 here, which
    // any Linux host can bind): the E2E stack and the health checks reach the server on 127.0.0.1.
    const resolved = [
      { address: '127.0.0.2', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    const s = await startServer('SANDBOX');
    const original = dns.lookup;
    const real = dns.lookup.bind(dns);
    const fake = (hostname: string, options: unknown, callback?: unknown): void => {
      const cb = (typeof options === 'function' ? options : callback) as (err: Error | null, ...rest: unknown[]) => void;
      const opts = (typeof options === 'object' && options !== null ? options : {}) as { all?: boolean };
      if (hostname !== 'localhost') {
        real(hostname, opts, cb as never);
        return;
      }
      const [first] = resolved;
      if (opts.all === true) process.nextTick(cb, null, resolved);
      else process.nextTick(cb, null, first?.address, first?.family);
    };
    dns.lookup = fake as typeof dns.lookup;
    try {
      await s.app.listen({ host: 'localhost', port: 0 });
    } finally {
      dns.lookup = original;
    }
    try {
      const address = s.app.server.address();
      if (address === null || typeof address === 'string') throw new Error('no TCP address');
      expect(address.address).toBe('127.0.0.2');
      // The server keeps node's whole-request, header and keep-alive limits (Fastify's defaults would loosen two).
      expect(s.app.server.requestTimeout).toBe(NODE_REQUEST_TIMEOUT_MS);
      expect(s.app.server.headersTimeout).toBe(60_000);
      expect(s.app.server.keepAliveTimeout).toBe(NODE_KEEP_ALIVE_TIMEOUT_MS);
      for (const host of ['127.0.0.2', '127.0.0.1']) {
        const base = `http://${host}:${address.port}`;
        expect((await fetch(`${base}/api/meta`)).status, host).toBe(200);
        expect(await longProposalStatus(base), host).not.toBe(431);
        expect((await fetch(`${base}/api/meta?probe=${'a'.repeat(MAX_HEADER_BYTES + 1024)}`)).status, host).toBe(431);
      }
    } finally {
      await s.close();
    }
  });
});
