/**
 * The gateway listener's free text (review F30-F33, the same defect at the gateway; DI-20, DI-30, DI-31): U+0000 or a
 * UTF-16 surrogate without its other half.
 *  - The login's login name, service key and nonce: U+0000 reached a text parameter and the refusal's record, and a lone
 *    surrogate was written as U+FFFD by the driver, so the server looked up a name the gateway never sent. Now the login
 *    schema refuses such text: 400 SCHEMA, as any login not in the expected form, and the database never sees it.
 *  - A heartbeat's not-ready reason goes to the database as JSON, which refuses such text; the listener answered that
 *    500 INTERNAL. The database's refusal stays (it loses the heartbeat's receipt, so the watch's next tick is unclean
 *    and the manual path stays shut: decision X37); the answer is now 400 SCHEMA.
 * A reading's text members are patterns (its raw line is printable ASCII), so a reading needs no change.
 *
 * Round 2: the listener is a Fastify instance of its own, and it still read a JSON body through Fastify's replacing
 * decoder. Bytes that stand for no character were read as U+FFFD: a truncated sequence F0 9F 98 became one U+FFFD of the
 * same byte length, so a heartbeat's not-ready reason was recorded holding a character the gateway never sent, and a
 * login name holding it was looked up (and its refusal recorded) as U+FFFD; a shorter sequence (FF, F0 9F) changed the
 * length and was answered 500 INTERNAL. Now the listener decodes JSON bodies as strict UTF-8 (installStrictJsonBodies)
 * and answers every request Fastify cannot read 400 SCHEMA; a heartbeat with a bearer token whose bytes are not UTF-8
 * is lost (the next tick is unclean, the manual path stays shut).
 */
import { randomBytes, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ed25519PrivateKey, LoginRequest, loginProofMessage } from '@ebmr/integration-sdk/scale';
import { NOT_UTF8_BODY } from '../../src/platform/http/json-body.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { enrol, fakeGateway, gatewayKey, gatewayService, GW, post, type FakeGateway } from './support.ts';

let server: TestServer;
let gw: FakeGateway;
let base: string;

beforeAll(async () => {
  server = await startServer('SANDBOX');
  await enrol(server);
  gw = await fakeGateway(server);
  base = gw.base;
}, 180_000);
afterAll(async () => {
  await gw?.close();
  await server?.close();
});

/** A login as the enrolled gateway, its proof over what is sent, with `change` applied to the request. */
async function login(change: (body: Record<string, string>) => void): Promise<{ status: number; body: unknown }> {
  const key = gatewayKey(server);
  const service = gatewayService(server);
  const nonce = ((await post(base, '/gw/v1/nonce', {})).body as { nonce: string }).nonce;
  const body: Record<string, string> = { gatewayCode: GW, loginName: service.loginName, serviceKey: service.serviceKey, spki: key.publicKeySpki, nonce, sig: '', apiToken: randomBytes(32).toString('base64url') };
  change(body);
  body['sig'] = sign(null, loginProofMessage(body['nonce'] ?? '', GW, body['loginName'] ?? '', key.publicKeySpki), ed25519PrivateKey(key.privateKeyPkcs8)).toString('base64');
  return post(base, '/gw/v1/session', body);
}

const refusals = async (): Promise<number> => Number((await server.db.admin.query<{ n: string }>("select count(*)::text as n from tab.device_alarm where kind = 'GATEWAY_LOGIN_REFUSED'")).rows[0]?.n);

/** Where the bytes go in a body built as JSON text. */
const BYTES = '@@BYTES@@';

/**
 * Byte sequences that stand for no character. F0 9F 98 (a four-byte sequence cut short) is the one Fastify's replacing
 * reader turned into a single U+FFFD of the same byte length, so its Content-Length check passed and the text was read;
 * the others changed the length (FF, F0 9F, C3) or are a surrogate's encoding, which UTF-8 does not allow (ED A0 80).
 */
const NOT_UTF8: Buffer[] = [Buffer.from([0xf0, 0x9f, 0x98]), Buffer.from([0xff]), Buffer.from([0xf0, 0x9f]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xc3])];

/** POSTs `json` with BYTES replaced by `bytes`, exactly as they are (nothing re-encodes them), with `bearer` when given. */
async function postBytes(path: string, json: string, bytes: Buffer, bearer: string | null, contentType = 'application/json'): Promise<{ status: number; body: unknown }> {
  const [head, tail] = json.split(BYTES) as [string, string];
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: Buffer.concat([Buffer.from(head, 'utf8'), bytes, Buffer.from(tail ?? '', 'utf8')]),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
}

const heartbeatBody = (notReady: string) => ({
  gatewayTimeUs: '1790584618000000',
  devices: [{ deviceCode: 'TEST-BAL-01', state: 'OFFLINE', serial: 'SIM-0001', notReady }],
  journal: { lastSeq: gw.login.head.seq, ackedSeq: '0' },
});
const heartbeat = (notReady: string) => gw.post('/gw/v1/heartbeat', heartbeatBody(notReady));
const storedNotReady = async () =>
  (await server.db.admin.query<{ r: string | null }>("select h.not_ready as r from tab.instrument_heartbeat h join iam.device d on d.id = h.instrument_device_id where d.code = 'TEST-BAL-01'")).rows;
const uncleanTicks = async () => Number((await server.db.admin.query<{ n: string }>('select count(*)::text as n from tab.listener_tick where clean = false')).rows[0]?.n);

/** Waits (the listener ticks every 500 ms) until a tick that is not clean follows `before`; false when none came in 5 s. */
async function uncleanTickAfter(before: number): Promise<boolean> {
  const deadline = performance.now() + 5_000;
  while ((await uncleanTicks()) === before && performance.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return (await uncleanTicks()) > before;
}

const lastTick = async () => (await server.db.admin.query<{ s: number | null }>('select max(seq)::int as s from tab.listener_tick')).rows[0]?.s ?? 0;

/** Waits until four more ticks have been closed after tick `seq`, then counts those that are not clean. */
async function uncleanAfterFourTicks(seq: number): Promise<number> {
  const deadline = performance.now() + 10_000;
  while ((await lastTick()) < seq + 4 && performance.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  expect(await lastTick(), 'SETUP: the listener ticks').toBeGreaterThanOrEqual(seq + 4);
  return Number((await server.db.admin.query<{ n: string }>('select count(*)::text as n from tab.listener_tick where seq > $1 and clean = false', [seq])).rows[0]?.n);
}

/** Rows holding U+FFFD where the gateway's text is kept: heartbeats, their receipts, and the alarms of refused logins. */
async function replacementCharacters(): Promise<Record<string, number>> {
  const n = async (sql: string) => Number((await server.db.admin.query<{ n: string }>(sql, ['%\uFFFD%'])).rows[0]?.n);
  return {
    heartbeat: await n('select count(*)::text as n from tab.instrument_heartbeat where not_ready like $1'),
    receipt: await n('select count(*)::text as n from tab.heartbeat_receipt where devices::text like $1'),
    alarm: await n('select count(*)::text as n from tab.device_alarm where details::text like $1 or message like $1'),
  };
}

describe('the gateway listener refuses text no record can hold (review F30-F33)', () => {
  it('[DI-20][DI-31] a login name, service key or nonce holding U+0000 or a lone surrogate is refused 400 SCHEMA, never 500, and never looked up as U+FFFD', async () => {
    const before = await refusals();
    const cases: [string, (b: Record<string, string>) => void][] = [
      ['loginName NUL', (b) => void (b['loginName'] = `${b['loginName'] ?? ''}\u0000`)],
      ['loginName lone surrogate', (b) => void (b['loginName'] = `${b['loginName'] ?? ''}\udbff`)],
      ['serviceKey NUL', (b) => void (b['serviceKey'] = `\u0000${b['serviceKey'] ?? ''}`)],
      ['serviceKey lone surrogate', (b) => void (b['serviceKey'] = `${b['serviceKey'] ?? ''}\ud800`)],
      ['nonce NUL', (b) => void (b['nonce'] = `${b['nonce'] ?? ''}\u0000`)],
    ];
    for (const [what, change] of cases) {
      const r = await login(change);
      expect({ what, status: r.status, body: r.body }).toEqual({ what, status: 400, body: { error: { code: 'SCHEMA', message: 'the login request is not in the expected form', relogin: false } } });
    }
    // Refused before anything is looked up, as any login not in the expected form: no refusal is recorded for it.
    expect(await refusals()).toBe(before);
    // The same login with its own text is taken.
    expect((await login(() => undefined)).status).toBe(200);
  });

  it('[DI-30][DI-31][PR-20] a heartbeat whose not-ready reason holds U+0000 or a lone surrogate is refused by the database: answered 400 SCHEMA, its receipt lost (the next tick is unclean, so the manual path stays shut), the stored reason unchanged', async () => {
    expect((await heartbeat('journal full')).status).toBe(200);
    const before = await uncleanTicks();
    for (const reason of ['journal\u0000 full', 'journal \udbff full']) {
      const r = await heartbeat(reason);
      expect({ reason, status: r.status, body: r.body }).toEqual({
        reason,
        status: 400,
        body: { error: { code: 'SCHEMA', message: 'the request holds text no record can hold (U+0000, or half of a surrogate pair); nothing of it was stored', relogin: false } },
      });
    }
    // The lost receipts are on record: a tick that is not clean follows (the listener ticks every 500 ms).
    expect(await uncleanTickAfter(before)).toBe(true);
    expect(await storedNotReady()).toEqual([{ r: 'journal full' }]);
  });

  it('[DI-30][DI-31][PR-20] a heartbeat whose bytes are not UTF-8 (F0 9F 98 among them) is refused 400 SCHEMA before it is read, never recorded as U+FFFD; sent with the gateway token its arrival is lost, so the next tick is unclean (review F33 round 2)', async () => {
    expect((await heartbeat('journal full')).status).toBe(200);
    const json = JSON.stringify(heartbeatBody(`journal ${BYTES}! full`));
    // Without a bearer token it is no gateway's heartbeat (decision X37): refused the same, and nothing is lost.
    const mark = await lastTick();
    for (const bytes of NOT_UTF8) {
      const r = await postBytes('/gw/v1/heartbeat', json, bytes, null);
      expect({ bytes: bytes.toString('hex'), status: r.status, body: r.body }).toEqual({ bytes: bytes.toString('hex'), status: 400, body: { error: { code: 'SCHEMA', message: NOT_UTF8_BODY, relogin: false } } });
    }
    expect(await uncleanAfterFourTicks(mark)).toBe(0);
    // With the gateway's token it may be the gateway's heartbeat: lost.
    const before = await uncleanTicks();
    for (const bytes of NOT_UTF8) {
      const r = await postBytes('/gw/v1/heartbeat', json, bytes, gw.token);
      expect({ bytes: bytes.toString('hex'), status: r.status, body: r.body }).toEqual({ bytes: bytes.toString('hex'), status: 400, body: { error: { code: 'SCHEMA', message: NOT_UTF8_BODY, relogin: false } } });
    }
    expect(await uncleanTickAfter(before)).toBe(true);
    expect(await storedNotReady()).toEqual([{ r: 'journal full' }]);
    expect(await replacementCharacters()).toEqual({ heartbeat: 0, receipt: 0, alarm: 0 });
    // The same heartbeat in UTF-8 is taken, character for character.
    expect((await heartbeat('journal \u{1F600}! full')).status).toBe(200);
    expect(await storedNotReady()).toEqual([{ r: 'journal \u{1F600}! full' }]);
  });

  it('[DI-20][DI-31] a login whose bytes are not UTF-8 (F0 9F 98 in its login name, the proof signed over the U+FFFD the old reader made of them) is refused 400 SCHEMA before it is read: never looked up as U+FFFD, no refusal recorded (review F33 round 2)', async () => {
    const before = await refusals();
    const key = gatewayKey(server);
    const service = gatewayService(server);
    for (const bytes of NOT_UTF8) {
      const nonce = ((await post(base, '/gw/v1/nonce', {})).body as { nonce: string }).nonce;
      const sig = sign(null, loginProofMessage(nonce, GW, `${service.loginName}\ufffd`, key.publicKeySpki), ed25519PrivateKey(key.privateKeyPkcs8)).toString('base64');
      const json = JSON.stringify({ gatewayCode: GW, loginName: `${service.loginName}${BYTES}`, serviceKey: service.serviceKey, spki: key.publicKeySpki, nonce, sig, apiToken: randomBytes(32).toString('base64url') });
      const r = await postBytes('/gw/v1/session', json, bytes, null);
      expect({ bytes: bytes.toString('hex'), status: r.status, body: r.body }).toEqual({ bytes: bytes.toString('hex'), status: 400, body: { error: { code: 'SCHEMA', message: NOT_UTF8_BODY, relogin: false } } });
    }
    expect(await refusals()).toBe(before);
    expect(await replacementCharacters()).toEqual({ heartbeat: 0, receipt: 0, alarm: 0 });
  });

  it('[DI-20][DI-31] a request the listener cannot read (not JSON, a content type it does not read, over the body limit) is answered 400 SCHEMA, never 500 INTERNAL (review F33 round 2)', async () => {
    const cases: [string, Promise<{ status: number; body: unknown }>][] = [
      ['not JSON', postBytes('/gw/v1/heartbeat', `{"gatewayTimeUs": ${BYTES}`, Buffer.from('nope'), gw.token)],
      ['a content type the listener does not read', postBytes('/gw/v1/session', JSON.stringify({ loginName: BYTES }), Buffer.from('svc'), null, 'application/xml')],
      ['over the body limit', postBytes('/gw/v1/heartbeat', JSON.stringify(heartbeatBody(BYTES)), Buffer.alloc(1024 * 1024 + 1, 0x61), gw.token)],
    ];
    for (const [what, sent] of cases) {
      const r = await sent;
      expect({ what, status: r.status, code: (r.body as { error?: { code?: string } }).error?.code }).toEqual({ what, status: 400, code: 'SCHEMA' });
    }
  });

  it('[DI-20] the login schema itself refuses such text in its free text members; text a record can hold passes', () => {
    const valid = { gatewayCode: 'TEST-GW-01', loginName: 'svc-gw', serviceKey: 'k'.repeat(20), spki: 'AA', nonce: 'n'.repeat(16), sig: 'AA', apiToken: 'a'.repeat(43) };
    expect(LoginRequest.safeParse(valid).success).toBe(true);
    expect(LoginRequest.safeParse({ ...valid, loginName: 'svc-gw é 😀' }).success).toBe(true);
    for (const [member, text] of [
      ['loginName', 'svc\u0000gw'],
      ['loginName', 'svc\udc00'],
      ['serviceKey', 'key\ud83d'],
      ['nonce', `${'n'.repeat(16)}\u0000`],
    ] as const) {
      const r = LoginRequest.safeParse({ ...valid, [member]: text });
      expect(r.success, member).toBe(false);
      expect(r.error?.issues.map((i) => [i.path.join('.'), i.message]), member).toEqual([[member, 'holds U+0000 or a surrogate without its other half, which no record can hold']]);
    }
  });
});
