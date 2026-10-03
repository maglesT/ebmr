/**
 * Critic finding SSE-SESSION (Phase 2 exit follow-ups, uncovered item [8]; DI-38, DI-16): the live display stream of a
 * scale (GET /api/devices/scales/:code/live, server-sent events) was checked against the session once, when it opened.
 * It ended only when the browser closed it or the site's time zone changed, so it went on sending the scale's display
 * to a terminal whose session was locked (by the person or by the idle time), signed out, switched to another person,
 * or whose role had been withdrawn, for as long as the page kept it open. The web lets the stream go at a lock or a
 * sign-out (F61/F62), but nothing on the server made it.
 *
 * Now the stream asks the request gate again (admitSession, the gate every request passes) every
 * LIVE_SESSION_RECHECK_MS, and ends with an `end` event naming the refusal a new request would get: SESSION_LOCKED, or
 * NO_SESSION (signed out, or the role withdrawn, which also ends the session as a request does, saying why). A stream whose session still serves it
 * keeps running.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { passwordActor, personaOf } from '@ebmr/test-kit';
import { tokenHash } from '../../src/platform/auth/session.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';
import { enrol, fakeGateway, type FakeGateway } from './support.ts';

let server: TestServer;
let gw: FakeGateway;
let api: Server;
let port = 0;

/** The gateway API's live display of TEST-BAL-01: a sample every 100 ms. */
async function startFakeGatewayApi(): Promise<{ server: Server; url: string }> {
  const s = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${gw.apiToken}` || req.method !== 'GET' || !req.url?.endsWith('/live')) {
      res.writeHead(404).end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const tick = () => res.write(`data: ${JSON.stringify({ deviceCode: 'TEST-BAL-01', value: '1.250', unit: 'kg', stable: true, status: 'OK' })}\n\n`);
    tick();
    const t = setInterval(tick, 100);
    res.once('close', () => clearInterval(t));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const a = s.address();
  return { server: s, url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}` };
}

const reason = <T extends ActorContext>(ctx: T): T => ({ ...ctx, reasonCode: 'TEST_SETUP', reasonText: 'SSE-SESSION test set-up', correlationId: randomUUID() });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const cookieOf = (b: TestBrowser): string => [...b.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

interface OpenStream {
  /** Everything received so far. */
  text(): string;
  /** Resolves with true once the server ended the stream, false when it is still open after `ms`. */
  endedWithin(ms: number): Promise<boolean>;
  close(): void;
}

/** A browser's live display of TEST-BAL-01 on a real connection (the reply is hijacked), read as it arrives. */
async function openLive(b: TestBrowser): Promise<OpenStream> {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/devices/scales/TEST-BAL-01/live`, { headers: { cookie: cookieOf(b), accept: 'text/event-stream' }, signal: controller.signal });
  expect(res.status).toBe(200);
  if (!res.body) throw new Error('no event stream');
  const reader = res.body.getReader();
  let text = '';
  let done = false;
  const pump = (async () => {
    try {
      for (;;) {
        const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
    } catch {
      // aborted by the test
    }
    done = true;
  })();
  // The relay is running: a sample of the scale arrived.
  for (let i = 0; i < 50 && !text.includes('"value":"1.250"'); i += 1) await sleep(50);
  expect(text).toContain('"value":"1.250"');
  return {
    text: () => text,
    endedWithin: (ms) => Promise.race([pump.then(() => true), sleep(ms).then(() => done)]),
    close: () => controller.abort(),
  };
}

/** The refusal the server named in its `end` event, or null when it sent none. */
const endOf = (text: string): { code: string; whatHappened?: string; why?: string } | null => {
  const m = /event: end\ndata: (\{[^\n]*\})/.exec(text);
  return m?.[1] ? (JSON.parse(m[1]) as { code: string; whatHappened?: string; why?: string }) : null;
};
const endCode = (text: string): string | null => endOf(text)?.code ?? null;

/** Three times the server's re-check interval (LIVE_SESSION_RECHECK_MS, 2 s): room for a loaded machine. */
const WAIT_MS = 6_000;

beforeAll(async () => {
  const fake = await startFakeGatewayApi();
  api = fake.server;
  server = await startServer('SANDBOX', { env: { EBMR_GATEWAY_URL: fake.url } });
  await enrol(server);
  gw = await fakeGateway(server);
  expect((await gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' }])).status).toBe(200);
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const address = server.app.server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

afterAll(async () => {
  await gw?.close();
  await server?.close();
  api?.closeAllConnections();
  await new Promise<void>((r) => api?.close(() => r()));
});

describe('SSE-SESSION: an open live display follows its session as each new request does', () => {
  it('[DI-38] a stream whose session still serves it keeps running past several re-checks', async () => {
    const op = await server.asPersona('operator1');
    const live = await openLive(op);
    try {
      expect(await live.endedWithin(WAIT_MS)).toBe(false);
      const before = live.text().length;
      await sleep(300);
      expect(live.text().length).toBeGreaterThan(before);
      expect(endCode(live.text())).toBeNull();
    } finally {
      live.close();
    }
  });

  it('[DI-38] the person locks the kiosk: the stream ends (SESSION_LOCKED), and opening it again is refused (423)', async () => {
    const op = await server.asPersona('operator1');
    const live = await openLive(op);
    try {
      expect((await op.call(routes.access.lock, { body: {} })).ok).toBe(true);
      expect(await live.endedWithin(WAIT_MS)).toBe(true);
      expect(endCode(live.text())).toBe('SESSION_LOCKED');
      const again = await op.inject({ method: 'GET', url: '/api/devices/scales/TEST-BAL-01/live', headers: { accept: 'text/event-stream' } });
      expect(again.statusCode).toBe(423);
    } finally {
      live.close();
    }
  });

  it('[DI-38] the kiosk is idle longer than the lock time: the stream ends (SESSION_LOCKED)', async () => {
    const op = await server.asPersona('operator1');
    const live = await openLive(op);
    try {
      // The last activity of the session lies further back than its idle timeout (the idle lock, as time makes it).
      const c = await server.db.admin.connect();
      try {
        await c.query('begin');
        await c.query('set local session_replication_role = replica');
        const r = await c.query(
          `update iam.session_activity a set last_activity_at = clock_timestamp() - interval '1 day'
             from tab.session_binding b where b.session_id = a.session_id and b.token_hash = $1`,
          [tokenHash(op.cookies.get(server.config.cookies.session) ?? '')],
        );
        expect(r.rowCount).toBe(1);
        await c.query('commit');
      } finally {
        c.release();
      }
      expect(await live.endedWithin(WAIT_MS)).toBe(true);
      expect(endCode(live.text())).toBe('SESSION_LOCKED');
    } finally {
      live.close();
    }
  });

  it('[DI-38] the person signs out: the stream ends (NO_SESSION), and opening it again is refused (401)', async () => {
    const op = await server.asPersona('operator1');
    const cookie = cookieOf(op);
    const live = await openLive(op);
    try {
      expect((await op.call(routes.session.logout, { body: {} })).ok).toBe(true);
      expect(await live.endedWithin(WAIT_MS)).toBe(true);
      expect(endCode(live.text())).toBe('NO_SESSION');
      const again = await server.app.inject({ method: 'GET', url: '/api/devices/scales/TEST-BAL-01/live', headers: { cookie, accept: 'text/event-stream' } });
      expect(again.statusCode).toBe(401);
    } finally {
      live.close();
    }
  });

  it('[DI-16][DI-38] the role the session works in is withdrawn: the stream ends (NO_SESSION, the role revoked) and the session with it', async () => {
    // A QA person of the shop floor watches the scale of DISP-1; the administrator revokes their QA_SHOP_FLOOR grant.
    const qa = await server.asPersona('qa1', 'TEST-KIOSK-DISP-1');
    const live = await openLive(qa);
    try {
      const { rows } = await server.db.app.query<{ id: string }>(
        "select id from iam.role_grant where account_id = $1 and role_code = 'QA_SHOP_FLOOR' and status = 'APPROVED' and revoked_at is null",
        [personaOf(server.seed, 'qa1').accountId],
      );
      expect(rows).toHaveLength(1);
      const admin = await passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint);
      await withCommand(server.db.app, reason(admin), (c) => identity.revokeRoleGrant(c, rows[0]?.id ?? '', 'SSE-SESSION test: access withdrawn'));
      expect(await live.endedWithin(WAIT_MS)).toBe(true);
      // The refusal a request in the withdrawn role gets (F36): NO_SESSION, saying the role was revoked.
      expect(endOf(live.text())).toMatchObject({ code: 'NO_SESSION', why: 'The role QA_SHOP_FLOOR this session worked in was revoked or has expired.' });
      // The session ended, as a request in the withdrawn role ends it (tablets 0400).
      const { rows: ended } = await server.db.admin.query<{ ended: boolean }>(
        'select s.ended_at is not null as ended from tab.session_binding b join iam.session s on s.id = b.session_id where b.token_hash = $1',
        [tokenHash(qa.cookies.get(server.config.cookies.session) ?? '')],
      );
      expect(ended).toEqual([{ ended: true }]);
    } finally {
      live.close();
    }
  });
});
