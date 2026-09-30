/**
 * The gateway's side of the proven upload wait (DI-28, review finding P53; tablets 0330): each batch first takes a
 * challenge the server's database issues, and each reading's wait at the gateway is measured only after that
 * challenge arrived and signed with the gateway key over the challenge, the reading id and the wait. The database
 * counts everything after the signing itself, so the signed wait must cover everything before it, including a slow
 * answer to the challenge request.
 */
import { randomUUID, verify } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { READING_FORMAT, ed25519PrivateKey, ed25519PublicKey, sealReading, uploadWaitMessage, type ScaleReading } from '@ebmr/integration-sdk/scale';
import { systemClock } from '../src/clock.ts';
import { Journal } from '../src/journal.ts';
import { Uplink, newApiToken } from '../src/uplink.ts';
import { FakeServer, configFor, gatewayKeys, tempDir } from './support.ts';

const keys = gatewayKeys();
const privateKey = ed25519PrivateKey(keys.privateKeyPkcs8);
const publicKey = ed25519PublicKey(keys.publicKeySpki);
const servers: FakeServer[] = [];
const journals: Journal[] = [];
const uplinks: Uplink[] = [];

afterEach(async () => {
  for (const u of uplinks.splice(0)) await u.stop();
  for (const j of journals.splice(0)) await j.close();
  for (const s of servers.splice(0)) await s.stop();
});

function builder(chainId: string) {
  return (seq: bigint, prevHash: string): ScaleReading =>
    sealReading(
      {
        format: READING_FORMAT,
        readingId: randomUUID(),
        chainId,
        gatewayCode: 'TEST-GW-01',
        deviceCode: 'TEST-BAL-01',
        serial: 'SIM-0001',
        seq: seq.toString(),
        value: '1.250',
        unit: 'kg',
        stable: true,
        status: 'OK',
        raw: 'S S      1.250 kg',
        sourceTimeUs: '1790584618000000',
        trust: 'DEVICE_UNSYNCED',
        installation: 'SANDBOX',
        purpose: 'GROSS',
        prevHash,
      },
      privateKey,
    );
}

async function rig(): Promise<{ s: FakeServer; j: Journal; up: Uplink; capturedAt: Map<string, bigint> }> {
  const s = new FakeServer(keys.publicKeySpki);
  await s.start();
  servers.push(s);
  const dir = tempDir();
  const j = await Journal.open({ dir, gatewayCode: 'TEST-GW-01', publicKey });
  journals.push(j);
  const capturedAt = new Map<string, bigint>();
  const up = new Uplink({
    config: configFor({ simPort: 1, uplink: s.url, journalDir: dir, keys }),
    journal: j,
    clock: systemClock,
    apiToken: newApiToken(),
    capturedAt,
    heartbeatBody: () => ({ devices: [] }),
  });
  uplinks.push(up);
  await up.logIn();
  return { s, j, up, capturedAt };
}

/** Journals a reading as a capture does: its monotonic capture time is remembered for its wait. */
async function capture(r: { s: FakeServer; j: Journal; capturedAt: Map<string, bigint> }): Promise<ScaleReading> {
  const reading = await r.j.appendNext(builder(r.s.chainId));
  r.capturedAt.set(reading.readingId, systemClock.monoUs());
  return reading;
}

describe('the upload wait is signed against a challenge from the server (DI-28)', () => {
  it('[DI-28] each batch takes a fresh challenge from the server, and every item\'s wait is signed with the gateway key over that challenge, the reading id and the wait', async () => {
    const r = await rig();
    const a = await capture(r);
    await r.up.flush();
    const b = await capture(r);
    await r.up.flush();
    expect(r.s.readings.map((x) => x.readingId)).toEqual([a.readingId, b.readingId]);
    expect(r.s.refused).toEqual([]);
    const [ia, ib] = r.s.items;
    expect(ia?.reading.readingId).toBe(a.readingId);
    expect(ib?.reading.readingId).toBe(b.readingId);
    for (const item of [ia!, ib!]) {
      expect(r.s.challenges.has(item.challengeId)).toBe(true);
      expect(item.delayUs).not.toBeNull();
      expect(verify(null, uploadWaitMessage(item.challengeId, item.reading.readingId, item.delayUs!), publicKey, Buffer.from(item.waitSig!, 'base64'))).toBe(true);
    }
    expect(ia!.challengeId).not.toBe(ib!.challengeId);
  });

  it('[DI-28] the wait is measured after the challenge arrived: a slow answer to the challenge request is inside the signed wait', async () => {
    const r = await rig();
    r.s.challengeDelayMs = 1200;
    const a = await capture(r);
    await r.up.flush();
    expect(r.s.readings.map((x) => x.readingId)).toEqual([a.readingId]);
    const item = r.s.items[0]!;
    expect(BigInt(item.delayUs!) >= 1_150_000n, `signed wait ${String(item.delayUs)} us`).toBe(true);
  });

  it('[DI-28] a reading whose capture time the gateway no longer knows (journalled before a restart) is sent with no wait and no signature, and a wait is never sent unsigned', async () => {
    const r = await rig();
    const known = await capture(r);
    const unknown = await r.j.appendNext(builder(r.s.chainId)); // no capture time: as after a restart
    await r.up.flush();
    expect(r.s.readings.map((x) => x.readingId)).toEqual([known.readingId, unknown.readingId]);
    const byId = new Map(r.s.items.map((i) => [i.reading.readingId, i]));
    expect(byId.get(unknown.readingId)).toMatchObject({ delayUs: null, waitSig: null });
    expect(byId.get(known.readingId)?.waitSig).toEqual(expect.any(String));
  });
});
