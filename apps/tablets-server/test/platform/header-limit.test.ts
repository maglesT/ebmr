/**
 * The listening server accepts request headers up to MAX_HEADER_BYTES, so a disposition proposal of the longest
 * allowed justification (4000 Devanagari characters, base64url in the esig content query) reaches the route; larger
 * headers are still refused before any route runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_HEADER_BYTES } from '../../src/app.ts';
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
