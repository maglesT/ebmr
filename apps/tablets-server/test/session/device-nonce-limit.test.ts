/**
 * The device-nonce rate limit (DI-19, DI-20; decision 0004 X22-X27). It was 120 a minute per client address, so parallel
 * kiosk E2E specs, all from 127.0.0.1, tripped it and a badge tap sometimes got no nonce. Now (bind.ts,
 * DeviceRateLimitSpec):
 *  - every nonce is bound to the key it is asked for (`spki`, required): only a proof signed with that key can use it;
 *  - a request that shows a proof ticket (`lastNonce`: the nonce of this key's last successful proof as an active
 *    browser terminal, good once) counts toward that terminal's own count per address, checked first, so a terminal
 *    past it neither uses up the address's allowance nor starves the others;
 *  - a request without one is unproven, whatever key it names: every unproven request of an address shares one count,
 *    no more room than the whole address had before, and it counts toward the key's own count too;
 *  - a ceiling per address over everything that got past its first count.
 * Only a good proof by a browser terminal (PERSONAL, SHARED, GRADE_A_B) leaves a ticket: not a failed one, not one the
 * registry refuses, and not a good one by a key enrolled to a SERVER or INSTRUMENT device.
 * What decision 0004 X34 accepts is pinned here too: requests without a ticket that name a terminal's public key (no
 * private key needed) fill that terminal's count ("whoever holds one terminal key"), and once the address's unproven
 * count is full every request without a ticket is refused ("a proof ticket counts once").
 *
 * Each test asks from addresses of its own (inject's remoteAddress), so the counts of one test never meet another's.
 * A ticket is not tied to an address: the proofs that make tickets run from further addresses of their own (the
 * identify route has its own limit per address), so they never touch the counts under test.
 */
import { randomBytes, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { ed25519PrivateKey, loginProofMessage } from '@ebmr/integration-sdk/scale';
import { identity, withCommand } from '@ebmr/kernel';
import { routes } from '@ebmr/api-contract';
import { generateDeviceKey, passwordActor, signDeviceProof, terminalOf, type DeviceKey } from '@ebmr/test-kit';
import { startGatewayListener } from '../../src/features/devices/listener.ts';
import { DEVICE_NONCE_RATE_LIMIT as LIMIT } from '../../src/features/session/index.ts';
import { PROOF_TICKET_TTL_MS, ProofTickets } from '../../src/platform/auth/device-proof.ts';
import { GW, gatewayKey, gatewayService, post } from '../devices/support.ts';
import { logCollector, ORIGINS, startServer, type TestServer } from '../support/harness.ts';

let sbx: TestServer;
const log = logCollector();
/** Two more enrolled browser terminals, so that four can fill the ceiling of one address and a fifth is left. */
const EXTRA = ['TEST-PC-NONCE-1', 'TEST-PC-NONCE-2'] as const;
const extraKeys = new Map<string, DeviceKey>();
/**
 * Devices that sign in through no browser, each enrolled ACTIVE with a P-256 key all the same, so that a device proof by
 * one of them succeeds (the registry resolves any ACTIVE device) although it is no browser terminal.
 */
const NOT_BROWSER = [
  { code: 'TEST-SRV-NONCE-1', deviceClass: 'SERVER' },
  { code: 'TEST-BAL-NONCE-1', deviceClass: 'INSTRUMENT', room: 'LAB-NONCE' },
] as const;

const adminActor = async () =>
  passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'nonce rate-limit test', correlationId: randomUUID() });

beforeAll(async () => {
  sbx = await startServer('SANDBOX', { logStream: log.stream });
  const enrol = async (d: { code: string; deviceClass: identity.DeviceClass; room?: string }) => {
    const key = generateDeviceKey();
    await withCommand(sbx.db.app, await adminActor(), (c) =>
      identity.registerDevice(c, { ...d, site: sbx.seed.siteCode, fingerprint: key.fingerprint, description: 'Nonce rate-limit test device' }),
    );
    extraKeys.set(d.code, key);
  };
  for (const code of EXTRA) await enrol({ code, deviceClass: 'PERSONAL' });
  for (const d of NOT_BROWSER) await enrol(d);
});
afterAll(async () => {
  await sbx?.close();
});

let net = 0;
/** An IPv4 address no other request of this file uses. */
const freshAddress = (): string => {
  net += 1;
  return `10.${77 + (net >> 16)}.${(net >> 8) & 255}.${net & 255}`;
};

/** A browser terminal as the web client runs it: its key, and its proof ticket (the nonce of its last good proof). */
interface Terminal {
  code: string;
  key: DeviceKey;
  ticket?: string | undefined;
}
const terminal = (code: string): Terminal => {
  const key = extraKeys.get(code) ?? terminalOf(sbx.seed, code).key;
  if (!key) throw new Error(`${code} has no key`);
  return { code, key };
};
/** A key nobody enrolled (the server does not parse it for a nonce; any base64 names a key). */
const inventedKey = (): string => randomBytes(91).toString('base64');

const SAME_ORIGIN = { origin: ORIGINS.SANDBOX, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };

interface Asked {
  /** '200', or '<status>:<refusal code>:<which count>'. */
  outcome: string;
  nonce?: string;
  headers: Record<string, string | undefined>;
}

async function ask(address: string, body: { spki?: string; lastNonce?: string | undefined }): Promise<Asked> {
  const res = await sbx.app.inject({ method: 'POST', url: routes.session.deviceNonce.path, remoteAddress: address, headers: SAME_ORIGIN, payload: JSON.stringify(body) });
  const headers = Object.fromEntries(['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'].map((h) => [h, res.headers[h] as string | undefined]));
  if (res.statusCode === 200) return { outcome: '200', nonce: (JSON.parse(res.body) as { nonce: string }).nonce, headers };
  const refused = JSON.parse(res.body) as { refusal?: { code?: string; details?: { limit?: string } } };
  return { outcome: `${res.statusCode}:${refused.refusal?.code ?? '?'}:${refused.refusal?.details?.limit ?? '-'}`, headers };
}

/** Identifies the terminal of `key` with a proof over `nonce`; '200' or '<status>:<reason>'. */
async function identifyWith(key: DeviceKey, nonce: string, address = freshAddress(), path: string = routes.session.identify.path): Promise<string> {
  const sig = signDeviceProof(key, `${nonce}|POST|${path}|${sha256Hex(canonicalJson({}))}`);
  const res = await sbx.app.inject({ method: 'POST', url: routes.session.identify.path, remoteAddress: address, headers: SAME_ORIGIN, payload: JSON.stringify({ proof: { spki: key.publicKeySpki, nonce, sig } }) });
  if (res.statusCode === 200) return '200';
  const refused = JSON.parse(res.body) as { refusal?: { code?: string; details?: { reason?: string } } };
  return `${res.statusCode}:${refused.refusal?.details?.reason ?? refused.refusal?.code ?? '?'}`;
}

/** Gives `t` a proof ticket: a nonce asked for and proven from addresses of their own. */
async function freshTicket(t: Terminal): Promise<void> {
  const side = freshAddress();
  const { nonce } = await ask(side, { spki: t.key.publicKeySpki });
  if (!nonce) throw new Error('no nonce for the ticket');
  expect(await identifyWith(t.key, nonce, side)).toBe('200');
  t.ticket = nonce;
}

/** Asks from `address` as the browser of `t` does after a good proof: with its ticket. A nonce served is proven at once. */
async function askProven(address: string, t: Terminal): Promise<string> {
  if (t.ticket === undefined) await freshTicket(t);
  const asked = await ask(address, { spki: t.key.publicKeySpki, lastNonce: t.ticket });
  t.ticket = undefined;
  if (asked.nonce) {
    expect(await identifyWith(t.key, asked.nonce)).toBe('200');
    t.ticket = asked.nonce;
  }
  return asked.outcome;
}

async function tally(n: number, one: (i: number) => Promise<string>): Promise<Record<string, number>> {
  const seen: Record<string, number> = {};
  for (let i = 0; i < n; i += 1) {
    const outcome = await one(i);
    seen[outcome] = (seen[outcome] ?? 0) + 1;
  }
  return seen;
}

const mintedNonces = async (): Promise<number> => Number((await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from tab.device_nonce')).rows[0]?.n);
const TERMINAL = '429:RATE_LIMITED:TERMINAL';
const ADDRESS = '429:RATE_LIMITED:ADDRESS';
const UNPROVEN = '429:RATE_LIMITED:UNPROVEN';

describe('a device nonce is bound to the key it is asked for', () => {
  it('[DI-20] a proof signed with another key cannot use it, and a request that names no key gets none', async () => {
    const disp = terminal('TEST-KIOSK-DISP-1');
    const pc = terminal('TEST-PC-01');
    const before = await mintedNonces();
    expect((await ask(freshAddress(), {})).outcome).toBe('400:SCHEMA:-');
    expect(await mintedNonces()).toBe(before);
    const forDisp = (await ask(freshAddress(), { spki: disp.key.publicKeySpki })).nonce ?? '';
    expect(await identifyWith(pc.key, forDisp)).toBe('403:NONCE');
    // The other key's attempt did not use it up: the key it was asked for still can.
    expect(await identifyWith(disp.key, forDisp)).toBe('200');
    const forInvented = (await ask(freshAddress(), { spki: inventedKey() })).nonce ?? '';
    expect(await identifyWith(pc.key, forInvented)).toBe('403:NONCE');
  });

  it("[DI-20] the gateway listener's login nonce is no browser nonce, and a browser nonce is no login nonce there", async () => {
    const pc = terminal('TEST-PC-01');
    const listener = await startGatewayListener(sbx.built.ctx, { host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${listener.port}`;
    try {
      const gwNonce = ((await post(base, '/gw/v1/nonce', {})).body as { nonce: string }).nonce;
      expect(await identifyWith(pc.key, gwNonce)).toBe('403:NONCE');
      const key = gatewayKey(sbx);
      const service = gatewayService(sbx);
      const login = async (nonce: string) => {
        const sig = sign(null, loginProofMessage(nonce, GW, service.loginName, key.publicKeySpki), ed25519PrivateKey(key.privateKeyPkcs8)).toString('base64');
        const res = await post(base, '/gw/v1/session', { gatewayCode: GW, loginName: service.loginName, serviceKey: service.serviceKey, spki: key.publicKeySpki, nonce, sig, apiToken: randomBytes(32).toString('base64url') });
        return (res.body as { error?: { code?: string } }).error?.code ?? String(res.status);
      };
      const browserNonce = (await ask(freshAddress(), { spki: pc.key.publicKeySpki })).nonce ?? '';
      expect(await login(browserNonce)).toBe('NONCE');
      // The listener's own nonce gets past that check (the gateway is not enrolled in this test, so it stops later).
      expect(await login(((await post(base, '/gw/v1/nonce', {})).body as { nonce: string }).nonce)).not.toBe('NONCE');
    } finally {
      await listener.close();
    }
  });
});

describe('device nonces are counted per proven terminal, under a shared count for the unproven and a ceiling per address', () => {
  it('[DI-19][DI-20] a terminal that proves with its key has a count of its own: past it, it is refused, and the other terminals behind the same address are not', async () => {
    const address = freshAddress();
    const disp = terminal('TEST-KIOSK-DISP-1');
    expect(await tally(LIMIT.max, () => askProven(address, disp))).toEqual({ '200': LIMIT.max });
    expect(await askProven(address, disp)).toBe(TERMINAL);
    expect(await askProven(address, terminal('TEST-KIOSK-BLEND-1'))).toBe('200');
    expect(await askProven(address, terminal('TEST-PC-01'))).toBe('200');
    // The same terminal from another address has a count of its own.
    expect(await askProven(freshAddress(), disp)).toBe('200');
  });

  it('[DI-19][DI-20] a terminal that keeps asking past its count, with a ticket or without, uses up neither the address allowance nor the unproven count', async () => {
    const address = freshAddress();
    const noisy = terminal('TEST-KIOSK-DISP-1');
    expect(await tally(LIMIT.max, () => askProven(address, noisy))).toEqual({ '200': LIMIT.max });
    // Far past its count: more refused requests than the whole address may make.
    expect(await tally(40, () => askProven(address, noisy))).toEqual({ [TERMINAL]: 40 });
    expect(await tally(LIMIT.addressMax, () => ask(address, { spki: noisy.key.publicKeySpki }).then((a) => a.outcome))).toEqual({ [TERMINAL]: LIMIT.addressMax });
    // Everything else behind the address still has its full room: the unproven count and three more terminals.
    expect(await tally(LIMIT.unprovenMax, () => ask(address, { spki: inventedKey() }).then((a) => a.outcome))).toEqual({ '200': LIMIT.unprovenMax });
    for (const code of ['TEST-KIOSK-BLEND-1', 'TEST-PC-01']) {
      const t = terminal(code);
      expect(await tally(LIMIT.max, () => askProven(address, t))).toEqual({ '200': LIMIT.max });
    }
    // 120 + 120 + 240: the address has 480 - 480 = 0 left, so a fourth proven terminal is refused by the ceiling.
    expect(await askProven(address, terminal('TEST-PC-NONCE-1'))).toBe(ADDRESS);
  });

  it('[DI-19] the ceiling per address still trips: four busy terminals use it up, and a fifth, proven or not, is refused there', async () => {
    const address = freshAddress();
    const before = await mintedNonces();
    const four = ['TEST-KIOSK-DISP-1', 'TEST-KIOSK-BLEND-1', 'TEST-PC-01', 'TEST-PC-NONCE-1'].map(terminal);
    // Round by round, as terminals working side by side ask.
    expect(await tally(LIMIT.max * four.length, (i) => askProven(address, four[i % four.length] as Terminal))).toEqual({ '200': LIMIT.addressMax });
    const fifth = terminal('TEST-PC-NONCE-2');
    expect(await askProven(address, fifth)).toBe(ADDRESS);
    expect((await ask(address, { spki: fifth.key.publicKeySpki })).outcome).toBe(ADDRESS);
    expect((await ask(address, { spki: inventedKey() })).outcome).toBe(ADDRESS);
    // Another address is not affected.
    expect(await askProven(freshAddress(), fifth)).toBe('200');
    // The address minted exactly its ceiling (the tickets' own nonces came from other addresses: one each, plus the last).
    const ticketNonces = four.length + 2;
    expect(await mintedNonces()).toBe(before + LIMIT.addressMax + ticketNonces + 1);
  });

  it('[DI-19] a caller that holds no enrolled private key gets no more nonces from one address than before, whatever public keys it names and whatever it shows as a ticket', async () => {
    const address = freshAddress();
    const before = await mintedNonces();
    const keys = [...['TEST-KIOSK-DISP-1', 'TEST-KIOSK-BLEND-1', 'TEST-PC-01', ...EXTRA].map((c) => terminal(c).key.publicKeySpki), inventedKey()];
    // As a browser would: each key shows the last nonce served for it (never proven), or a made-up one.
    const served = new Map<string, string>();
    const outcomes = await tally(keys.length * 130, async (i) => {
      const spki = keys[i % keys.length] ?? '';
      const lastNonce = i % 2 === 0 ? served.get(spki) : randomBytes(24).toString('base64url');
      const asked = await ask(address, { spki, lastNonce });
      if (asked.nonce) served.set(spki, asked.nonce);
      return asked.outcome;
    });
    expect(outcomes).toEqual({ '200': LIMIT.unprovenMax, [UNPROVEN]: keys.length * 130 - LIMIT.unprovenMax });
    expect(await mintedNonces()).toBe(before + LIMIT.unprovenMax);
  });

  it('[DI-19][DI-20] whoever holds one terminal key gets no more than its own count of nonces bound to it from one address, with tickets or without', async () => {
    const address = freshAddress();
    const disp = terminal('TEST-KIOSK-DISP-1');
    const half = LIMIT.max / 2;
    expect(await tally(half, () => ask(address, { spki: disp.key.publicKeySpki }).then((a) => a.outcome))).toEqual({ '200': half });
    expect(await tally(LIMIT.max, () => askProven(address, disp))).toEqual({ '200': half, [TERMINAL]: half });
    expect((await ask(address, { spki: disp.key.publicKeySpki })).outcome).toBe(TERMINAL);
    // Room left in the unproven count only yields nonces bound to other keys, which its proofs cannot use.
    const other = (await ask(address, { spki: inventedKey() })).nonce ?? '';
    expect(await identifyWith(disp.key, other)).toBe('403:NONCE');
  });

  it('[DI-19] a flood of invented keys from another address cannot push a terminal out of its count', async () => {
    const address = freshAddress();
    const disp = terminal('TEST-KIOSK-DISP-1');
    expect(await tally(LIMIT.max, () => askProven(address, disp))).toEqual({ '200': LIMIT.max });
    expect(await askProven(address, disp)).toBe(TERMINAL);
    // More invented keys than the in-memory count keeps (5000), all from one other address.
    const flood = freshAddress();
    expect(await tally(5100, () => ask(flood, { spki: inventedKey() }).then((a) => a.outcome))).toEqual({ '200': LIMIT.unprovenMax, [UNPROVEN]: 5100 - LIMIT.unprovenMax });
    expect(await askProven(address, disp)).toBe(TERMINAL);
    expect((await ask(address, { spki: disp.key.publicKeySpki })).outcome).toBe(TERMINAL);
  });

  it('[DI-19][DI-20] a proof ticket counts once, only for the key that proved, only after a good proof, and not for a terminal blocked since', async () => {
    const address = freshAddress();
    expect(await tally(LIMIT.unprovenMax, () => ask(address, { spki: inventedKey() }).then((a) => a.outcome))).toEqual({ '200': LIMIT.unprovenMax });
    // From here on a request without a ticket is refused at this address, and one with a ticket is not.
    const disp = terminal('TEST-KIOSK-DISP-1');
    const pc = terminal('TEST-PC-01');
    await freshTicket(disp);
    const ticket = disp.ticket ?? '';
    expect((await ask(address, { spki: pc.key.publicKeySpki, lastNonce: ticket })).outcome).toBe(UNPROVEN);
    expect((await ask(address, { spki: disp.key.publicKeySpki, lastNonce: ticket })).outcome).toBe('200');
    expect((await ask(address, { spki: disp.key.publicKeySpki, lastNonce: ticket })).outcome).toBe(UNPROVEN);
    // A proof that failed leaves no ticket: a signature over another path, and a key nobody enrolled.
    const bad = (await ask(freshAddress(), { spki: disp.key.publicKeySpki })).nonce ?? '';
    expect(await identifyWith(disp.key, bad, freshAddress(), '/api/session/login')).toBe('403:SIGNATURE');
    expect((await ask(address, { spki: disp.key.publicKeySpki, lastNonce: bad })).outcome).toBe(UNPROVEN);
    const stranger = generateDeviceKey();
    const strange = (await ask(freshAddress(), { spki: stranger.publicKeySpki })).nonce ?? '';
    expect(await identifyWith(stranger, strange)).toBe('403:UNREGISTERED');
    expect((await ask(address, { spki: stranger.publicKeySpki, lastNonce: strange })).outcome).toBe(UNPROVEN);
    // A terminal blocked after its proof: its ticket no longer gives it a count of its own, and the look-up raises no alert.
    const alerts = async () => Number((await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from iam.security_alert where kind in ('UNREGISTERED_DEVICE', 'BLOCKED_DEVICE_USE')")).rows[0]?.n);
    const deviceId = terminalOf(sbx.seed, 'TEST-PC-01').deviceId;
    const setStatus = async (status: 'ACTIVE' | 'BLOCKED') => withCommand(sbx.db.app, await adminActor(), (c) => identity.setDeviceStatus(c, deviceId, status, 'nonce rate-limit test'));
    await freshTicket(pc);
    const alertsBefore = await alerts();
    await setStatus('BLOCKED');
    try {
      expect((await ask(address, { spki: pc.key.publicKeySpki, lastNonce: pc.ticket })).outcome).toBe(UNPROVEN);
    } finally {
      await setStatus('ACTIVE');
    }
    expect(await alerts()).toBe(alertsBefore);
  });

  it('[DI-19][DI-20] a proof the registry refuses leaves no ticket: its key stays unproven and, once the unproven count is full, cannot touch the allowance the proven terminals need', async () => {
    const address = freshAddress();
    expect(await tally(LIMIT.unprovenMax, () => ask(address, { spki: inventedKey() }).then((a) => a.outcome))).toEqual({ '200': LIMIT.unprovenMax });
    const stranger = generateDeviceKey();
    const strange = (await ask(freshAddress(), { spki: stranger.publicKeySpki })).nonce ?? '';
    expect(await identifyWith(stranger, strange)).toBe('403:UNREGISTERED');
    expect((await ask(address, { spki: stranger.publicKeySpki, lastNonce: strange })).outcome).toBe(UNPROVEN);
    // The address still has exactly the rest of its ceiling for three proven terminals, and not one nonce more.
    const three = ['TEST-KIOSK-DISP-1', 'TEST-KIOSK-BLEND-1', 'TEST-PC-01'].map(terminal);
    const rest = LIMIT.addressMax - LIMIT.unprovenMax;
    expect(await tally(rest, (i) => askProven(address, three[i % three.length] as Terminal))).toEqual({ '200': rest });
    expect(await askProven(address, terminal('TEST-PC-NONCE-1'))).toBe(ADDRESS);
  });

  it('[DI-19][DI-20] a good proof by a key enrolled to a device that signs in through no browser (SERVER, INSTRUMENT) leaves no ticket: its key stays unproven and cannot touch the allowance the proven terminals need', async () => {
    const address = freshAddress();
    expect(await tally(LIMIT.unprovenMax, () => ask(address, { spki: inventedKey() }).then((a) => a.outcome))).toEqual({ '200': LIMIT.unprovenMax });
    const devices = sbx.built.ctx.devices;
    for (const { code } of NOT_BROWSER) {
      const key = extraKeys.get(code) as DeviceKey;
      // The proof itself succeeds: the registry resolves the key to an ACTIVE device.
      const shown = (await ask(freshAddress(), { spki: key.publicKeySpki })).nonce ?? '';
      expect(await identifyWith(key, shown)).toBe('200');
      expect((await ask(address, { spki: key.publicKeySpki, lastNonce: shown })).outcome).toBe(UNPROVEN);
      const kept = (await ask(freshAddress(), { spki: key.publicKeySpki })).nonce ?? '';
      expect(await identifyWith(key, kept)).toBe('200');
      expect(devices.takeProofTicket(key.publicKeySpki, kept)).toBe(false);
    }
    // The same good proof by a browser terminal leaves one.
    const pc = terminal('TEST-PC-NONCE-2');
    const own = (await ask(freshAddress(), { spki: pc.key.publicKeySpki })).nonce ?? '';
    expect(await identifyWith(pc.key, own)).toBe('200');
    expect(devices.takeProofTicket(pc.key.publicKeySpki, own)).toBe(true);
    // The address still has exactly the rest of its ceiling for three proven terminals, and not one nonce more.
    const three = ['TEST-KIOSK-DISP-1', 'TEST-KIOSK-BLEND-1', 'TEST-PC-01'].map(terminal);
    const rest = LIMIT.addressMax - LIMIT.unprovenMax;
    expect(await tally(rest, (i) => askProven(address, three[i % three.length] as Terminal))).toEqual({ '200': rest });
    expect(await askProven(address, terminal('TEST-PC-NONCE-1'))).toBe(ADDRESS);
  });

  it('[DI-19] a proof ticket is good once and for ten minutes, and a key keeps its sixteen latest', () => {
    let now = 1_000;
    const tickets = new ProofTickets(() => ({ monoMs: now, wallMs: now }));
    tickets.record('key-a', 'h1');
    expect(tickets.take('key-b', 'h1')).toBe(false);
    expect(tickets.take('key-a', 'h1')).toBe(true);
    expect(tickets.take('key-a', 'h1')).toBe(false);
    tickets.record('key-a', 'h2');
    tickets.record('key-a', 'h3');
    now += PROOF_TICKET_TTL_MS - 1;
    expect(tickets.take('key-a', 'h2')).toBe(true);
    now += 1;
    expect(tickets.take('key-a', 'h3')).toBe(false);
    for (let i = 0; i < 17; i += 1) tickets.record('key-a', `n${i}`);
    expect(tickets.take('key-a', 'n0')).toBe(false);
    expect(tickets.take('key-a', 'n1')).toBe(true);
    expect(tickets.take('key-a', 'n16')).toBe(true);
  });

  it('[DI-19] an IPv6 address counts by its /64 network', async () => {
    const disp = terminal('TEST-KIOSK-DISP-1');
    expect(await tally(LIMIT.max, () => askProven('2001:db8:0:77::1', disp))).toEqual({ '200': LIMIT.max });
    expect(await askProven('2001:db8:0:77::2', disp)).toBe(TERMINAL);
    expect(await askProven('2001:db8:0:78::1', disp)).toBe('200');
  });

  it('[DI-19] the answer carries the rate-limit headers of its fullest count, a refusal also Retry-After, and a refusal is logged at warn', async () => {
    const address = freshAddress();
    const first = await ask(address, { spki: inventedKey() });
    expect(first.outcome).toBe('200');
    expect([first.headers['x-ratelimit-limit'], first.headers['x-ratelimit-remaining'], first.headers['retry-after']]).toEqual([String(LIMIT.unprovenMax), String(LIMIT.unprovenMax - 1), undefined]);
    expect(Number(first.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
    expect(await tally(LIMIT.unprovenMax - 1, () => ask(address, { spki: inventedKey() }).then((a) => a.outcome))).toEqual({ '200': LIMIT.unprovenMax - 1 });
    const refused = await ask(address, { spki: inventedKey() });
    expect(refused.outcome).toBe(UNPROVEN);
    expect([refused.headers['x-ratelimit-limit'], refused.headers['x-ratelimit-remaining']]).toEqual([String(LIMIT.unprovenMax), '0']);
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    const warned = log
      .lines()
      .map((l) => JSON.parse(l) as { level?: number; msg?: string; limit?: string; address?: string })
      .filter((l) => l.msg === 'device nonce refused: rate limit' && l.address === address);
    expect(warned.map((l) => [l.level, l.limit])).toEqual([[40, 'UNPROVEN']]);
  });
});
