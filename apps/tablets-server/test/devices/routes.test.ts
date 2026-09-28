/**
 * Browser routes of the devices namespace (module C5): scale status, the capture trigger through the gateway, the
 * live display relay, and the separation of the gateway identity from everything a browser can do (DI-31).
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClientEntry, ClientIntent, routes } from '@ebmr/api-contract';
import { identity } from '@ebmr/kernel';
import { asAdmin, terminalOf } from '@ebmr/test-kit';
import { CaptureRequest, spkiFingerprint, type CaptureResponse } from '@ebmr/integration-sdk/scale';
import { startServer, type TestServer } from '../support/harness.ts';
import { withActorCommand } from '../../src/platform/db/commands.ts';
import { enrol, fakeGateway, gatewayKey, gatewayService, loginAt, operatorActor, type FakeGateway } from './support.ts';

let server: TestServer;
let gw: FakeGateway;
let api: Server;
/** What the fake gateway API answers next (null: take a stable reading and upload it). */
let nextAnswer: ((purpose: 'TARE' | 'GROSS' | 'CHECK') => Promise<CaptureResponse>) | null = null;
const seenTokens: string[] = [];

async function startFakeGatewayApi(): Promise<{ server: Server; url: string }> {
  const s = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      seenTokens.push((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (req.headers.authorization !== `Bearer ${gw.apiToken}`) {
        res.writeHead(401).end('{}');
        return;
      }
      if (req.method === 'GET' && req.url?.endsWith('/live')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const tick = () => res.write(`data: ${JSON.stringify({ deviceCode: 'TEST-BAL-01', value: '1.250', unit: 'kg', stable: true, status: 'OK' })}\n\n`);
        tick();
        const t = setInterval(tick, 100);
        res.once('close', () => clearInterval(t));
        return;
      }
      const body = CaptureRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      let answer: CaptureResponse;
      if (nextAnswer) answer = await nextAnswer(body.purpose);
      else {
        const reading = gw.next({ value: '12.503', raw: 'S S     12.503 kg', purpose: body.purpose });
        const up = await gw.uplink([{ reading }]);
        answer = { outcome: 'CAPTURED', reading, uplinked: up.body.refused === null };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    })();
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const a = s.address();
  return { server: s, url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}` };
}

async function heartbeat(state = 'ONLINE', serial: string | null = 'SIM-0001') {
  const r = await gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state, serial }]);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

beforeAll(async () => {
  const fake = await startFakeGatewayApi();
  api = fake.server;
  server = await startServer('SANDBOX', { env: { EBMR_GATEWAY_URL: fake.url } });
  await enrol(server);
  gw = await fakeGateway(server);
});

afterAll(async () => {
  await gw?.close();
  await server?.close();
  api?.closeAllConnections();
  await new Promise<void>((r) => api?.close(() => r()));
});

describe('scale status', () => {
  it('[DI-20] UNKNOWN before the first heartbeat, ONLINE after it, OFFLINE after a gap over 10 s; the port answers the same', async () => {
    const op = await server.asPersona('operator1');
    let res = await op.call(routes.devices.scales, { query: {} });
    expect(res.ok && res.value.scales).toEqual([
      { deviceCode: 'TEST-BAL-01', roomCode: 'DISP-1', status: 'UNKNOWN', lastHeartbeat: null, gatewayCode: 'TEST-GW-01', resolution: '0.001', unit: 'kg' },
    ]);
    await heartbeat();
    res = await op.call(routes.devices.scales, { query: {} });
    expect(res.ok && res.value.scales[0]?.status).toBe('ONLINE');
    expect(res.ok && res.value.scales[0]?.lastHeartbeat?.text).toMatch(/\(Asia\/Kolkata\)$/);
    expect(await server.built.ctx.deviceReadings.scaleStatus('DISP-1')).toMatchObject({ deviceCode: 'TEST-BAL-01', status: 'ONLINE' });
    expect(await server.built.ctx.deviceReadings.scaleStatus('BLEND-1')).toBeNull();
    expect(await server.built.ctx.deviceReadings.scaleStatus(null)).toBeNull();
    await asAdmin(server.database, (c) => c.query("update tab.instrument_heartbeat set reported_at = clock_timestamp() - interval '11 seconds'"));
    expect(await server.built.ctx.deviceReadings.scaleStatus('DISP-1')).toMatchObject({ status: 'OFFLINE' });
    await heartbeat();
    expect(await server.built.ctx.deviceReadings.scaleStatus('DISP-1')).toMatchObject({ status: 'ONLINE' });
  });

  it('[DI-20] a heartbeat with another serial shows the scale OFFLINE and raises an alert once', async () => {
    const before = await asAdmin(server.database, (c) => c.query<{ n: string }>(`select count(*)::text as n from iam.security_alert where kind = 'UNREGISTERED_DEVICE' and details ->> 'reason' = 'SERIAL_MISMATCH'`));
    await heartbeat('ONLINE', 'SIM-9999');
    await heartbeat('ONLINE', 'SIM-9999');
    expect(await server.built.ctx.deviceReadings.scaleStatus('DISP-1')).toMatchObject({ status: 'OFFLINE' });
    const after = await asAdmin(server.database, (c) => c.query<{ n: string }>(`select count(*)::text as n from iam.security_alert where kind = 'UNREGISTERED_DEVICE' and details ->> 'reason' = 'SERIAL_MISMATCH'`));
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n) + 1);
    const alarm = await server.db.app.query("select 1 from tab.device_alarm where kind = 'SERIAL_MISMATCH' and device_code = 'TEST-BAL-01'");
    expect(alarm.rowCount).toBeGreaterThanOrEqual(1);
    await heartbeat();
  });
});

describe('capture', () => {
  it('[DI-32] a capture returns the reading as the server stored it: device, raw line, value, source time and trust', async () => {
    await heartbeat();
    const op = await server.asPersona('operator1');
    const res = await op.call(routes.devices.capture, { params: { code: 'TEST-BAL-01' }, body: { purpose: 'GROSS' } });
    expect(res.ok, JSON.stringify(res.ok ? null : res.error)).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatchObject({ deviceCode: 'TEST-BAL-01', gatewayCode: 'TEST-GW-01', value: '12.503', unit: 'kg', stable: true, status: 'OK', raw: 'S S     12.503 kg', trust: 'DEVICE_UNSYNCED', purpose: 'GROSS' });
    expect(res.value.recordedAt.text).toMatch(/\(Asia\/Kolkata\)$/);
    // The server called the gateway with the API token the gateway handed over, never with its credential.
    expect(seenTokens.at(-1)).toBe(gw.apiToken);
    expect(seenTokens).not.toContain(gatewayService(server).serviceKey);
    // The claim by id gives the same facts (C3's committing entry).
    const actor = await operatorActor(server);
    const claimed = await withActorCommand(server.db.app, actor, (c) =>
      server.built.ctx.deviceReadings.claim(c, { readingIds: [res.value.readingId], room: 'DISP-1', maxAgeUs: 120_000_000n, purpose: 'GROSS' }),
    );
    expect(claimed[0]).toMatchObject({ value: '12.503', raw: 'S S     12.503 kg', deviceCode: 'TEST-BAL-01' });
  });

  it('[DI-20] a terminal in another room cannot trigger or watch this scale', async () => {
    await heartbeat();
    const op2 = await server.asPersona('operator2');
    const res = await op2.call(routes.devices.capture, { params: { code: 'TEST-BAL-01' }, body: { purpose: 'GROSS' } });
    expect(!res.ok && res.error.kind === 'REFUSAL' && res.error.envelope.refusal.code).toBe('SCALE_NOT_IN_ROOM');
    const live = await op2.inject({ method: 'GET', url: '/api/devices/scales/TEST-BAL-01/live' });
    expect(live.statusCode).toBe(403);
  });

  it('with the scale offline the capture is refused with the manual two-person path', async () => {
    await asAdmin(server.database, (c) => c.query("update tab.instrument_heartbeat set reported_at = clock_timestamp() - interval '30 seconds'"));
    const op = await server.asPersona('operator1');
    const res = await op.call(routes.devices.capture, { params: { code: 'TEST-BAL-01' }, body: { purpose: 'TARE' } });
    expect(res.ok).toBe(false);
    if (res.ok || res.error.kind !== 'REFUSAL') return;
    expect(res.error.status).toBe(503);
    expect(res.error.envelope.refusal).toMatchObject({ code: 'SCALE_OFFLINE', whatHappened: 'Scale offline: manual entry needs a second person.' });
    await heartbeat();
  });

  it('a gateway failure is answered with plain guidance and the reading id of what was recorded', async () => {
    await heartbeat();
    nextAnswer = async (purpose) => {
      const reading = gw.next({ value: '4.321', raw: 'S D      4.321 kg', stable: false, status: 'UNSTABLE', purpose });
      await gw.uplink([{ reading }]);
      return { outcome: 'FAILED', error: 'NOT_STABLE_WITHIN_TIMEOUT', message: 'TEST-BAL-01 did not settle within 10 s', reading, uplinked: true };
    };
    try {
      const op = await server.asPersona('operator1');
      const res = await op.call(routes.devices.capture, { params: { code: 'TEST-BAL-01' }, body: { purpose: 'GROSS' } });
      expect(!res.ok && res.error.kind === 'REFUSAL' && res.error.envelope.refusal).toMatchObject({ code: 'CAPTURE_FAILED', why: 'TEST-BAL-01 did not settle within 10 s' });
      if (!res.ok && res.error.kind === 'REFUSAL') expect(res.error.envelope.refusal.details?.['readingId']).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      nextAnswer = null;
    }
  });

  it('[DI-28] a reading the gateway kept but could not upload is not reported as captured', async () => {
    await heartbeat();
    nextAnswer = (purpose) => Promise.resolve({ outcome: 'CAPTURED', reading: gw.next({ purpose }), uplinked: false });
    try {
      const op = await server.asPersona('operator1');
      const res = await op.call(routes.devices.capture, { params: { code: 'TEST-BAL-01' }, body: { purpose: 'GROSS' } });
      expect(!res.ok && res.error.kind === 'REFUSAL' && res.error.envelope.refusal.code).toBe('READING_NOT_RECEIVED');
    } finally {
      nextAnswer = null;
      // The fake chain cursor moved past a reading that was never uploaded: start a fresh fake gateway.
      await gw.close();
      gw = await fakeGateway(server);
    }
  });

  it('the live display is relayed as server-sent events ("live, not recorded")', async () => {
    await heartbeat();
    const op = await server.asPersona('operator1');
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const address = server.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/devices/scales/TEST-BAL-01/live`, {
      headers: { cookie: [...op.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '), accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('x-ebmr-installation')).toBe('SANDBOX');
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('"value":"1.250"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(text).toContain('"deviceCode":"TEST-BAL-01"');
    expect(text).toContain('"value":"1.250"');
  });
});

describe('the gateway identity is separate from everything a browser can do', () => {
  it('[DI-31] its bearer token is not a browser session: as a cookie or a bearer on a browser route it is refused', async () => {
    const b = server.browser('TEST-KIOSK-DISP-1');
    b.cookies.set(server.config.cookies.session, gw.token);
    const asCookie = await b.inject({ method: 'GET', url: '/api/devices/scales' });
    expect(asCookie.statusCode).toBe(401);
    const asBearer = await server.browser('TEST-KIOSK-DISP-1').inject({ method: 'GET', url: '/api/devices/scales', headers: { authorization: `Bearer ${gw.token}` } });
    expect(asBearer.statusCode).toBe(401);
    // And no gateway route answers on the browser port.
    const onBrowserPort = await server.app.inject({ method: 'POST', url: '/gw/v1/nonce', payload: {} });
    expect(onBrowserPort.statusCode).toBe(404);
  });

  it('[DI-31] it cannot log in through the browser login (refused and alerted as interactive use of a service account)', async () => {
    const service = gatewayService(server);
    const b = server.browser('TEST-PC-01');
    const body = { method: 'PASSWORD' as const, identifier: service.loginName, secret: service.serviceKey };
    const res = await b.call(routes.session.login, { body: { ...body, proof: await b.proof('POST', '/api/session/login', body) } });
    expect(res.ok).toBe(false);
    const alerts = await asAdmin(server.database, (c) =>
      c.query<{ n: string }>(`select count(*)::text as n from iam.security_alert where kind = 'SERVICE_ACCOUNT_INTERACTIVE_USE' and account_id = $1`, [service.accountId]),
    );
    expect(Number(alerts.rows[0]?.n)).toBeGreaterThanOrEqual(1);
    // The application role cannot even read the gateway's token hashes.
    await expect(server.db.app.query('select token_hash from tab.gateway_session')).rejects.toThrow(/permission denied/);
  });

  it('[DI-31] a gateway session can never be bound to a browser cookie, even right after its login (EBMR-TAB-016)', async () => {
    const fresh = await loginAt(gw.base, server, { apiToken: gw.apiToken });
    expect(fresh.status).toBe(200);
    const token = (fresh.body as { token: string }).token;
    const { rows } = await asAdmin(server.database, (c) =>
      c.query<{ session_id: string }>("select session_id from tab.gateway_session where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')", [token]),
    );
    expect(rows).toHaveLength(1);
    await expect(server.db.app.query("select tab.bind_session($1, repeat('a', 64), null)", [rows[0]?.session_id])).rejects.toThrow(/EBMR-TAB-016/);
  });

  it('[DI-31] it can never sign: its SERVICE_KEY authenticates for a login only, and the kernel says it cannot sign', async () => {
    const service = gatewayService(server);
    const fingerprint = spkiFingerprint(gatewayKey(server).publicKeySpki);
    expect(terminalOf(server.seed, 'TEST-GW-01').fingerprint).toBe(fingerprint);
    await expect(
      identity.authenticate(server.db.authn, { method: 'SERVICE_KEY', identifier: service.loginName, secret: service.serviceKey, deviceFingerprint: fingerprint, purpose: 'SIGNATURE', challengeId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow();
    const { rows } = await server.db.app.query<{ r: { can_sign: boolean; reasons: string[] } }>('select iam.can_sign($1) as r', [service.accountId]);
    expect(rows[0]?.r.can_sign).toBe(false);
    expect(rows[0]?.r.reasons).toContain('ACCOUNT_KIND_CANNOT_SIGN');
  });

  it('[DI-32] the browser cannot supply a device value: entries carry reading ids or manual values only (schema)', () => {
    const base = { kind: 'CONTAINER_WEIGHING', item: 'disp', bomLine: 'BOM-API', lotCode: 'TEST-LOT-1' };
    expect(ClientEntry.safeParse({ ...base, tareReadingId: '0b4f3c1e-1111-4222-8333-444455556666' }).success).toBe(true);
    for (const extra of [{ gross: '9.992' }, { source: 'DEVICE' }, { balance: 'TEST-BAL-01' }, { deviceCode: 'TEST-BAL-01' }, { raw: 'S S 9.992 kg' }, { tare: { value: '1.000', device: 'TEST-BAL-01' } }]) {
      expect(ClientEntry.safeParse({ ...base, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(ClientEntry.safeParse({ ...base, tareReadingId: '9.992' }).success).toBe(false);
    const record = { type: 'RECORD_DATA', stepKey: 'p-1@', item: 'disp', value: { kind: 'DECIMAL', value: '9.992', unit: 'kg' } };
    expect(ClientIntent.safeParse({ ...record, source: { mode: 'MANUAL' } }).success).toBe(true);
    expect(ClientIntent.safeParse({ ...record, source: { mode: 'DEVICE', device: 'TEST-BAL-01', raw: 'S S 9.992 kg' } }).success).toBe(false);
  });
});
