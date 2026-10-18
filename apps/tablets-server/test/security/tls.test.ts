/**
 * TLS settings of the adapters' mutual TLS (slice 7d; ASVS V9.1, V9.2; DI-13, DI-31): the client the adapters use
 * (mtlsFetch, slice 7a) negotiates TLS 1.2 or later with its system and refuses a system that offers only an older
 * protocol, refuses plain http once it holds TLS material, and never falls back to the system trust store. The peer's
 * CA and name are proven in equipment-data/feed-signature.test.ts; the server's own https rules (production refuses an
 * http origin, __Host- cookies and HSTS on https) in platform/startup.test.ts and security/session-and-headers.test.ts.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mtlsFetch } from '../../src/features/integrations/adapters/transport.ts';
import { testCa, testCertificate, type TestCa, type TestCertificate } from '../support/test-pki.ts';

let systemCa: TestCa;
let clientCa: TestCa;
let serverCert: TestCertificate;
let clientCert: TestCertificate;
const servers: Server[] = [];

async function system(opts: { minVersion?: 'TLSv1' | 'TLSv1.2'; maxVersion?: 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3'; ciphers?: string }): Promise<{ url: string; protocols: string[] }> {
  const protocols: string[] = [];
  const s = createServer(
    { cert: readFileSync(serverCert.cert), key: readFileSync(serverCert.key), ca: readFileSync(clientCa.cert), requestCert: true, rejectUnauthorized: true, ...opts },
    (req, res) => {
      protocols.push((req.socket as TLSSocket).getProtocol() ?? '');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    },
  );
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  servers.push(s);
  return { url: `https://localhost:${String((s.address() as AddressInfo).port)}/feed`, protocols };
}

beforeAll(() => {
  systemCa = testCa('TLS-SYSTEM');
  clientCa = testCa('TLS-EBMR');
  serverCert = testCertificate(systemCa, 'localhost', 'serverAuth', { dns: ['localhost'], ip: ['127.0.0.1'] });
  clientCert = testCertificate(clientCa, 'ADAPTER-TLS', 'clientAuth');
});

afterAll(async () => {
  for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
});

describe('TLS settings of the adapters (slice 7d)', () => {
  const tls = () => ({ ca: systemCa.cert, cert: clientCert.cert, key: clientCert.key });

  it('[DI-13][DI-31] the adapters negotiate TLS 1.2 or later; a system that offers only TLS 1.1 or older is refused', async () => {
    const modern = await system({});
    const ok = await mtlsFetch(tls())(modern.url);
    expect(ok.status).toBe(200);
    expect(['TLSv1.2', 'TLSv1.3']).toContain(modern.protocols[0]);
    const twelve = await system({ maxVersion: 'TLSv1.2' });
    expect((await mtlsFetch(tls())(twelve.url)).status).toBe(200);
    expect(twelve.protocols).toEqual(['TLSv1.2']);
    // A system that offers only TLS 1.1 (with the ciphers it needs allowed, so it can offer them at all).
    const old = await system({ minVersion: 'TLSv1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT@SECLEVEL=0' });
    await expect(mtlsFetch(tls())(old.url)).rejects.toThrow(/protocol|version|handshake|alert|SSL/i);
    expect(old.protocols).toEqual([]);
  });

  it('[DI-13][DI-31] an adapter that holds TLS material speaks https only, and a system certificate from the public trust store does not do', async () => {
    await expect(mtlsFetch(tls())('http://127.0.0.1:9/feed')).rejects.toThrow(/EBMR-INT-034/);
    // The pinned CA is the client's only trust: the same system under a CA the client was not given is refused.
    const otherCa = testCa('TLS-OTHER');
    const s = await system({});
    await expect(mtlsFetch({ ca: otherCa.cert, cert: clientCert.cert, key: clientCert.key })(s.url)).rejects.toThrow(/self[- ]signed|unable to verify|certificate/i);
    expect(s.protocols).toEqual([]);
  });
});
