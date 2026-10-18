/**
 * A browser of the load driver over real HTTP (slice 7d): the same contract client and device proofs as the server
 * tests' TestBrowser (apps/tablets-server/test/support/harness.ts), but on a TCP connection to the server process, from
 * its own loopback address (127.0.0.x, one per terminal), so each terminal's rate limits are its own as on a site LAN,
 * with keep-alive. Every call is timed and reported to the recorder by route id.
 */
import { randomUUID } from 'node:crypto';
import { Agent, request } from 'node:http';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { createApiClient, routes, type AnyRoute, type CallInput, type DeviceProof, type FetchLike, type Result, type RouteResponse } from '@ebmr/api-contract';
import { signDeviceProof, type DeviceKey } from '@ebmr/test-kit';
import type { Recorder } from './metrics.ts';

/** Device nonces a terminal asks for in a minute at most: under the server's limit of 120 per terminal key and address. */
const NONCES_PER_MINUTE = 110;

export interface NetBrowser {
  terminal: string;
  cookies: Map<string, string>;
  csrf: string | undefined;
  call<R extends AnyRoute>(route: R, input?: CallInput<R>): Promise<Result<RouteResponse<R>>>;
  proof(method: string, path: string, body: Record<string, unknown>): Promise<DeviceProof>;
  close(): void;
}

function parseSetCookie(header: string | string[] | undefined, jar: Map<string, string>): void {
  for (const line of header === undefined ? [] : Array.isArray(header) ? header : [header]) {
    const [pair = ''] = line.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === '' || /max-age=0/i.test(line) || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
}

export interface NetBrowserOptions {
  /** The server's origin (EBMR_PUBLIC_ORIGIN) and where it listens. */
  origin: string;
  host: string;
  port: number;
  /** The loopback address this terminal connects from. */
  localAddress: string;
  terminal: string;
  key: DeviceKey | null;
  installation: 'GMP' | 'SANDBOX';
  recorder: Recorder;
  /** What the recorder files this browser's calls under (FLOOR, OFFICE, ISSUER, REVIEW...). */
  actor: string;
}

export function netBrowser(o: NetBrowserOptions): NetBrowser {
  const agent = new Agent({ keepAlive: true, maxSockets: 4 });
  const jar = new Map<string, string>();
  const state = { csrf: undefined as string | undefined, lastNonce: undefined as string | undefined };
  /** When the last device nonces were asked for: a kiosk stays under the server's 120 a minute per terminal and address. */
  const nonceTimes: number[] = [];
  // A keep-alive socket the server closed while it sat idle fails at its next use (ECONNRESET on a reused socket,
  // before the server read the request): sent once more on a fresh socket, as Node's documentation advises.
  const fetchLike: FetchLike = (url, init) => send(url, init, true);
  const send = (url: string, init: Parameters<FetchLike>[1], retry: boolean): ReturnType<FetchLike> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...init.headers, ...(jar.size ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) };
      if (init.body !== undefined) headers['content-length'] = String(Buffer.byteLength(init.body));
      const req = request({ host: o.host, port: o.port, localAddress: o.localAddress, agent, method: init.method, path: url, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          parseSetCookie(res.headers['set-cookie'], jar);
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: { get: (n: string) => (res.headers[n.toLowerCase()] as string | undefined) ?? null }, text: () => Promise.resolve(text) });
        });
        res.on('error', reject);
      });
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (retry && req.reusedSocket && error.code === 'ECONNRESET') send(url, init, false).then(resolve, reject);
        else reject(error);
      });
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
  const client = createApiClient({
    fetch: fetchLike,
    installation: () => o.installation,
    csrfToken: () => state.csrf,
    headers: () => ({ origin: o.origin, 'sec-fetch-site': 'same-origin' }),
    newIdempotencyKey: () => randomUUID(),
  });
  const browser: NetBrowser = {
    terminal: o.terminal,
    cookies: jar,
    get csrf() {
      return state.csrf;
    },
    set csrf(v) {
      state.csrf = v;
    },
    async call(route, input) {
      const t0 = process.hrtime.bigint();
      const result = await client.call(route, input);
      o.recorder.request(o.actor, route, t0, result.ok ? 200 : result.error.kind === 'REFUSAL' ? result.error.status : 0, result.ok ? null : result.error.kind === 'REFUSAL' ? result.error.envelope.refusal.code : result.error.kind);
      if (result.ok && result.value && typeof result.value === 'object' && 'csrfToken' in result.value) state.csrf = (result.value as { csrfToken: string }).csrfToken;
      return result;
    },
    async proof(method, path, body) {
      if (!o.key) throw new Error(`terminal ${o.terminal} has no browser key`);
      const spki = o.key.publicKeySpki;
      for (;;) {
        const now = performance.now();
        while (nonceTimes.length > 0 && (nonceTimes[0] ?? 0) < now - 60_000) nonceTimes.shift();
        if (nonceTimes.length < NONCES_PER_MINUTE) break;
        await new Promise((r) => setTimeout(r, (nonceTimes[0] ?? now) + 60_000 - now + 5));
      }
      nonceTimes.push(performance.now());
      const r = await browser.call(routes.session.deviceNonce, { body: { spki, ...(state.lastNonce !== undefined ? { lastNonce: state.lastNonce } : {}) } });
      if (!r.ok) throw new Error(`no nonce for ${o.terminal}: ${JSON.stringify(r.error)}`);
      state.lastNonce = r.value.nonce;
      return { spki, nonce: r.value.nonce, sig: signDeviceProof(o.key, `${r.value.nonce}|${method.toUpperCase()}|${path}|${sha256Hex(canonicalJson(body))}`) };
    },
    close: () => agent.destroy(),
  };
  return browser;
}
