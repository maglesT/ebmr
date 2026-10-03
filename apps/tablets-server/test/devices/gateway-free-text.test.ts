/**
 * The gateway login's free text (review F30-F33, the same defect at the gateway listener; DI-20, DI-31): a login
 * name, service key or nonce holding U+0000 or a UTF-16 surrogate without its other half. U+0000 reached a text
 * parameter (22021) and the refusal's record (jsonb), so the login was answered 500 INTERNAL with nothing recorded; a
 * lone surrogate was written as U+FFFD by the driver, so the server looked up a name the gateway never sent. Now the
 * login schema refuses such text: 400 SCHEMA, as any login not in the expected form, and the database never sees it.
 * The heartbeat and the readings are not changed: a reading's text fields are patterns (printable ASCII raw lines), and
 * a heartbeat goes to the database as JSON, whose refusal of such text loses the heartbeat's receipt, which keeps the
 * manual path shut (decision X37).
 */
import { randomBytes, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ed25519PrivateKey, LoginRequest, loginProofMessage } from '@ebmr/integration-sdk/scale';
import { startGatewayListener, type GatewayListener } from '../../src/features/devices/listener.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { enrol, gatewayKey, gatewayService, GW, post } from './support.ts';

let server: TestServer;
let listener: GatewayListener;
let base: string;

beforeAll(async () => {
  server = await startServer('SANDBOX');
  await enrol(server);
  listener = await startGatewayListener(server.built.ctx, { host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${listener.port}`;
}, 180_000);
afterAll(async () => {
  await listener?.close();
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

describe('the gateway login refuses text no record can hold (review F30-F33)', () => {
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
