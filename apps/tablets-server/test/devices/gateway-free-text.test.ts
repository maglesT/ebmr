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
 */
import { randomBytes, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ed25519PrivateKey, LoginRequest, loginProofMessage } from '@ebmr/integration-sdk/scale';
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
    const heartbeat = (notReady: string) =>
      gw.post('/gw/v1/heartbeat', { gatewayTimeUs: '1790584618000000', devices: [{ deviceCode: 'TEST-BAL-01', state: 'OFFLINE', serial: 'SIM-0001', notReady }], journal: { lastSeq: gw.login.head.seq, ackedSeq: '0' } });
    expect((await heartbeat('journal full')).status).toBe(200);
    const stored = async () => (await server.db.admin.query<{ r: string | null }>("select h.not_ready as r from tab.instrument_heartbeat h join iam.device d on d.id = h.instrument_device_id where d.code = 'TEST-BAL-01'")).rows;
    const unclean = async () => Number((await server.db.admin.query<{ n: string }>('select count(*)::text as n from tab.listener_tick where clean = false')).rows[0]?.n);
    const before = await unclean();
    for (const reason of ['journal\u0000 full', 'journal \udbff full']) {
      const r = await heartbeat(reason);
      expect({ reason, status: r.status, body: r.body }).toEqual({
        reason,
        status: 400,
        body: { error: { code: 'SCHEMA', message: 'the request holds text no record can hold (U+0000, or half of a surrogate pair); nothing of it was stored', relogin: false } },
      });
    }
    // The lost receipts are on record: a tick that is not clean follows (the listener ticks every 500 ms).
    const deadline = performance.now() + 5_000;
    while ((await unclean()) === before && performance.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(await unclean()).toBeGreaterThan(before);
    expect(await stored()).toEqual([{ r: 'journal full' }]);
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
