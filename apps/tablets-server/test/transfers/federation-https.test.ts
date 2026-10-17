/**
 * The federated genealogy's transport rule (Phase 6 slice 6i, DI-13; Phase 6 mutation triage T7): in production this
 * server calls another installation over https only. The rule lives only in transfers/federation.ts (the database
 * keeps a peer's base URL as http or https and does not know the environment), so it is proved here on askPeer
 * with a stand-in for the database client and for fetch.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../src/platform/context.ts';
import { askPeer } from '../../src/features/transfers/federation.ts';

const keyFile = (() => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const file = join(mkdtempSync(join(tmpdir(), 'ebmr-fed-')), 'installation-key.json');
  writeFileSync(file, JSON.stringify({ installationCode: 'PUNE-01', privateKeyPkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') }));
  return file;
})();

/** A database client that issues a request to `baseUrl` and records the queries it is sent. */
function fakeDb(baseUrl: string) {
  const sent: { sql: string; params: unknown[] }[] = [];
  const nonce = randomUUID();
  const db = {
    query: (sql: string, params: unknown[] = []) => {
      sent.push({ sql, params });
      if (sql.includes('recipe.issue_federated_request')) return Promise.resolve({ rows: [{ r: { nonce, request: '{"format":"ebmr.federation-request.v1"}', baseUrl } }] });
      if (sql.includes('recipe.last_federated_excerpt')) return Promise.resolve({ rows: [{ id: null, payload: null }] });
      return Promise.resolve({ rows: [] });
    },
  };
  return { db: db as unknown as Parameters<typeof askPeer>[1], sent, nonce };
}

const appIn = (env: 'production' | 'development') =>
  ({ config: { env, installationKeyFile: keyFile, federationTimeoutS: 1 } }) as unknown as AppContext;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the federated genealogy calls another installation over https only in production (DI-13)', () => {
  it('[DI-13] [DI-31] production refuses a peer registered with an http address before anything is sent, and the refusal is logged', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('fetch must not be called')));
    vi.stubGlobal('fetch', fetchSpy);
    const { db, sent, nonce } = fakeDb('http://goa.example:8443');
    const a = await askPeer(appIn('production'), db, 'GOA-01', randomUUID(), 'FORWARD', '1700000000000000');
    expect(a.status).toBe('REFUSED');
    expect(a.detail).toMatch(/^EBMR-FED-021 GOA-01 is registered with an http address/);
    expect(fetchSpy).not.toHaveBeenCalled();
    const failure = sent.find((q) => q.sql.includes('recipe.record_federation_failure'));
    expect(failure?.params.slice(0, 2)).toEqual([nonce, 'REFUSED']);
  });

  it('[DI-13] production calls a peer registered with an https address, and development an http one', async () => {
    for (const [env, url] of [['production', 'https://goa.example:8443'], ['development', 'http://127.0.0.1:1']] as const) {
      const fetchSpy = vi.fn<(url: string) => Promise<Response>>(() => Promise.reject(new Error('no route to the peer')));
      vi.stubGlobal('fetch', fetchSpy);
      const { db } = fakeDb(url);
      const a = await askPeer(appIn(env), db, 'GOA-01', randomUUID(), 'FORWARD', '1700000000000000');
      expect(a.status).toBe('UNREACHABLE');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]![0]).toBe(`${url}/api/federation/genealogy`);
    }
  });
});
