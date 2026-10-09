/**
 * Review finding P53 (module C5; DI-28, DI-32): the age of a reading at claim time was now - recorded + the wait the
 * gateway reported, where "recorded" is the database clock at the insert. The time the upload then spent at the
 * server was counted nowhere: waiting for a pool connection, for the chain lock in the database, and behind earlier
 * items of the batch. A reading held up for minutes at the server could still be claimed as fresh.
 *
 * Round 1 (tablets 0270) had the listener add its own wait and the database its wait inside the ingesting
 * transaction; round-1 verification (0320) bounded a DEVICE_SYNCED reading by the capture time the gateway signed.
 * Round-2 verification: for a DEVICE_UNSYNCED reading the wait before the ingesting transaction began was still the
 * application's word, so a holder of the application role's credentials could hold back a genuinely signed reading
 * and report no wait (the skeptic's exploit, ported below).
 *
 * Now (tablets 0330) the wait is proven to the database: it issues a challenge for each upload and keeps when; the
 * gateway measures each reading's wait only after the challenge arrived and signs it with its enrolled key together
 * with the challenge and the reading id; tab.ingest_reading verifies that signature and stores the signed wait plus
 * its own time from the challenge's issue to the insert. Everything after the gateway signed, however long an
 * application holds the upload back, is so counted by the database. The two-argument tab.ingest_reading, which took
 * any wait the caller named, is gone; a wait without a proof (EBMR-DEV-053), on a challenge the database did not
 * issue to the reading's enrolment (EBMR-DEV-054) or with a signature that does not verify (EBMR-DEV-055) is refused.
 * An absurd reported wait is refused as EBMR-DEV-052, a negative one as EBMR-DEV-051.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asAdmin } from '@ebmr/test-kit';
import { ed25519PublicKey, uploadWaitMessage, type ScaleReading } from '@ebmr/integration-sdk/scale';
import { gatewayActor, gatewaySessionOf, waitProofProblem } from '../../src/features/devices/listener.ts';
import { dbNowUs, withActorCommand } from '../../src/platform/db/commands.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import {
  INGEST_READING_SQL,
  adminActor,
  enrol,
  fakeGateway,
  gatewayKey,
  ingestProven,
  issueChallenge,
  operatorActor,
  provenIngestParams,
  signWait,
  type FakeGateway,
} from './support.ts';

let server: TestServer;
let gw: FakeGateway;

const HELD_MS = 2500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
  server = await startServer('SANDBOX');
  await enrol(server);
  gw = await fakeGateway(server);
}, 180_000);

beforeEach(async () => {
  // Each test starts with a gateway cursor at the server's head.
  await gw.close();
  gw = await fakeGateway(server);
});

afterAll(async () => {
  await gw?.close();
  await server?.close();
});

/** The gateway session's actor, resolved from its bearer token as the listener does (its roles included). */
async function sessionActor() {
  const hash = createHash('sha256').update(gw.token).digest('hex');
  const { rows } = await server.db.app.query<{ r: Record<string, unknown> | null }>('select tab.resolve_gateway_session($1) as r', [hash]);
  const s = rows[0]?.r;
  if (!s) throw new Error('test set-up: the fake gateway session did not resolve');
  return gatewayActor(gatewaySessionOf(hash, s), server.config.siteZone, randomUUID());
}

async function storedWait(id: string): Promise<bigint | null> {
  const { rows } = await server.db.app.query<{ w: string | null }>('select uplink_delay_us::text as w from tab.device_reading where id = $1', [id]);
  if (!rows[0]) throw new Error(`reading ${id} was not stored`);
  return rows[0].w === null ? null : BigInt(rows[0].w);
}

async function isStored(id: string): Promise<boolean> {
  return ((await server.db.app.query('select 1 from tab.device_reading where id = $1', [id])).rowCount ?? 0) > 0;
}

async function claim(id: string, maxAgeUs: bigint) {
  const op = await operatorActor(server);
  return withActorCommand(server.db.app, op, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [id], room: 'DISP-1', maxAgeUs, purpose: 'GROSS' }));
}

/** tab.ingest_reading called directly in a command of the gateway session with the given arguments. */
async function ingestWith(reading: ScaleReading, delayUs: string | null, challengeId: string | null, waitSig: string | null): Promise<unknown> {
  const actor = await sessionActor();
  return withActorCommand(server.db.app, actor, async (c) => (await c.query<{ r: unknown }>(INGEST_READING_SQL, [JSON.stringify(reading), delayUs, challengeId, waitSig])).rows[0]?.r);
}

/** Holds the FOR UPDATE lock on the chain's enrolment row (as ingestion takes it) until release() is called. */
async function holdChainLock(): Promise<{ release: () => void; done: Promise<void> }> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const done = asAdmin(server.database, async (c) => {
    await c.query('begin');
    await c.query('select 1 from tab.gateway_key where id = $1 for update', [gw.login.chainId]);
    locked();
    await held;
    await c.query('commit');
  });
  await isLocked;
  return { release, done };
}

describe('P53: the age of a reading counts the time its upload waited at the server', () => {
  it('[DI-28] a wait for the chain lock inside the database is counted: the reading is too old for a maximum age shorter than that wait', async () => {
    const r: ScaleReading = gw.next();
    const actor = await sessionActor();
    const params = await provenIngestParams(server, actor, r, '0');
    const lock = await holdChainLock();
    const ingest = withActorCommand(server.db.app, actor, (c) => c.query(INGEST_READING_SQL, params));
    await sleep(HELD_MS);
    lock.release();
    await lock.done;
    await ingest;
    const wait = await storedWait(r.readingId);
    expect(wait).not.toBeNull();
    expect(wait! >= BigInt(HELD_MS - 200) * 1000n, `stored wait ${String(wait)} us`).toBe(true);
    await expect(claim(r.readingId, 2_000_000n)).rejects.toThrow(/EBMR-DEV-104/);
  });

  it('[DI-28] a wait inside the ingesting transaction before the ingest statement is counted by the database, whatever wait the caller reports', async () => {
    // The caller holds a genuinely signed reading inside its open command, then reports no wait at all.
    const r: ScaleReading = gw.next();
    const actor = await sessionActor();
    const params = await provenIngestParams(server, actor, r, '0');
    await withActorCommand(server.db.app, actor, async (c) => {
      await sleep(HELD_MS);
      await c.query(INGEST_READING_SQL, params);
    });
    const wait = await storedWait(r.readingId);
    expect(wait).not.toBeNull();
    expect(wait! >= BigInt(HELD_MS - 200) * 1000n, `stored wait ${String(wait)} us`).toBe(true);
    await expect(claim(r.readingId, 2_000_000n)).rejects.toThrow(/EBMR-DEV-104/);
  });

  it('[DI-28] a wait at the server after the gateway signed its upload (every pool connection taken) is counted too', async () => {
    const r = gw.next();
    const challengeId = await gw.challenge();
    const taken: pg.PoolClient[] = [];
    try {
      // The listener shares this pool (the test server's application pool, 4 connections).
      for (let i = 0; i < 4; i++) taken.push(await server.db.app.connect());
      const upload = gw.uplink([{ reading: r, delayUs: '0' }], { challengeId });
      await sleep(HELD_MS);
      for (const c of taken.splice(0)) c.release();
      const res = await upload;
      expect(res.body.refused, JSON.stringify(res.body)).toBeNull();
    } finally {
      for (const c of taken) c.release();
    }
    const wait = await storedWait(r.readingId);
    expect(wait! >= BigInt(HELD_MS - 200) * 1000n, `stored wait ${String(wait)} us`).toBe(true);
    await expect(claim(r.readingId, 2_000_000n)).rejects.toThrow(/EBMR-DEV-104/);
  });

  it('[DI-28] the gateway\'s own signed wait is kept and the server\'s is added; a reading sent at once stays usable', async () => {
    const r = gw.next();
    const res = await gw.uplink([{ reading: r, delayUs: '1500000' }]);
    expect(res.body.refused).toBeNull();
    const wait = await storedWait(r.readingId);
    expect(wait! >= 1_500_000n && wait! < 3_500_000n, `stored wait ${String(wait)} us`).toBe(true);
    const fresh = gw.next();
    expect((await gw.uplink([{ reading: fresh, delayUs: '0' }])).body.refused).toBeNull();
    await expect(claim(fresh.readingId, 2_000_000n)).resolves.toHaveLength(1);
    // Unknown wait (sent again after a gateway restart): needs no proof, stays unknown, never claimable.
    const replayed = gw.next();
    expect((await gw.uplink([{ reading: replayed, delayUs: null }])).body.refused).toBeNull();
    expect(await storedWait(replayed.readingId)).toBeNull();
    await expect(claim(replayed.readingId, 120_000_000n)).rejects.toThrow(/EBMR-DEV-104/);
  });

  it('[DI-28] wait before BEGIN: a DEVICE_SYNCED reading older than the maximum age by its signed capture time is refused however small the reported wait', async () => {
    const actor = await sessionActor();
    // Captured 10 s ago on the gateway's synchronised clock (signed), then ingested with no wait reported, directly
    // and through the listener: the stored waits are small, only the signed capture time shows how old they are.
    const heldDirect = gw.next({ trust: 'DEVICE_SYNCED', sourceTimeUs: ((await dbNowUs(server.db.app)) - 10_000_000n).toString() });
    await ingestProven(server, actor, heldDirect, '0');
    const heldListener = gw.next({ trust: 'DEVICE_SYNCED', sourceTimeUs: ((await dbNowUs(server.db.app)) - 10_000_000n).toString() });
    expect((await gw.uplink([{ reading: heldListener, delayUs: '0' }])).body.refused).toBeNull();
    expect((await storedWait(heldDirect.readingId))! < 2_000_000n).toBe(true);
    expect((await storedWait(heldListener.readingId))! < 2_000_000n).toBe(true);
    await expect(claim(heldDirect.readingId, 2_000_000n)).rejects.toThrow(/EBMR-DEV-104 DI-28: .*synchronised clock/);
    await expect(claim(heldListener.readingId, 2_000_000n)).rejects.toThrow(/EBMR-DEV-104 DI-28: .*synchronised clock/);
    // Within the stated clock tolerance (2 x time.drift_alarm_threshold_s = 2 s by default): 3 s old passes a 2 s maximum age.
    const withinTolerance = gw.next({ trust: 'DEVICE_SYNCED', sourceTimeUs: ((await dbNowUs(server.db.app)) - 3_000_000n).toString() });
    expect((await gw.uplink([{ reading: withinTolerance, delayUs: '0' }])).body.refused).toBeNull();
    await expect(claim(withinTolerance.readingId, 2_000_000n)).resolves.toHaveLength(1);
    // A fresh synchronised reading is used as before.
    const fresh = gw.next({ trust: 'DEVICE_SYNCED', sourceTimeUs: (await dbNowUs(server.db.app)).toString() });
    expect((await gw.uplink([{ reading: fresh, delayUs: '0' }])).body.refused).toBeNull();
    await expect(claim(fresh.readingId, 2_000_000n)).resolves.toHaveLength(1);
  });

  it('[DI-28] a reported wait above 100 years is refused with EBMR-DEV-052 by the database and by the listener, never with a raw out-of-range error', async () => {
    const actor = await sessionActor();
    const atBound = gw.next();
    await ingestProven(server, actor, atBound, '3155760000000000');
    expect(await storedWait(atBound.readingId)).not.toBeNull();
    await expect(claim(atBound.readingId, 3_600_000_000n)).rejects.toThrow(/EBMR-DEV-104/);
    const beyond = gw.next();
    for (const wait of ['3155760000000001', '9223372036854775000']) {
      // Signed by the gateway, so only the bound can refuse it.
      await expect(ingestProven(server, await sessionActor(), beyond, wait)).rejects.toThrow(/^EBMR-DEV-052 DI-28: /);
    }
    // Through the listener: the item is refused with the same code (the wait does not fit a bigint at all here).
    const res = await gw.uplink([{ reading: beyond, delayUs: '99999999999999999999' }]);
    expect(res.status).toBe(200);
    expect(res.body.refused).toMatchObject({ readingId: beyond.readingId, code: 'EBMR-DEV-052' });
    expect(await isStored(beyond.readingId)).toBe(false);
  });

  it('[DI-28] a negative wait is refused by the database (it would make an old reading look fresh)', async () => {
    const r = gw.next();
    const actor = await sessionActor();
    const { challengeId } = await issueChallenge(server, actor);
    await expect(ingestWith(r, '-1000000', challengeId, signWait(server, challengeId, r.readingId, '-1000000'))).rejects.toThrow(/EBMR-DEV-051/);
    expect(await isStored(r.readingId)).toBe(false);
  });
});

describe('P53 round-2 verification: the wait before the ingesting transaction is proven to the database (tablets 0330)', () => {
  it('[DI-28] the skeptic\'s exploit: a DEVICE_UNSYNCED reading whose signed upload is held back 2.5 s before its ingesting transaction began, then ingested reporting no wait, is too old for a 2 s maximum age, directly and through the listener', async () => {
    // As the gateway sends it: a challenge from the database, then the reading's wait (none) signed over it.
    const direct = gw.next();
    expect(direct.trust).toBe('DEVICE_UNSYNCED');
    const actor = await sessionActor();
    const params = await provenIngestParams(server, actor, direct, '0');
    const viaListener = gw.next();
    const challengeId = await gw.challenge();
    // A holder of the application role's credentials keeps both back before any transaction begins ...
    await sleep(HELD_MS);
    // ... then ingests them with the gateway's genuine proof of no wait at the gateway.
    await expect(withActorCommand(server.db.app, actor, (c) => c.query(INGEST_READING_SQL, params))).resolves.toBeDefined();
    const res = await gw.uplink([{ reading: viaListener, delayUs: '0' }], { challengeId });
    expect(res.body.refused, JSON.stringify(res.body)).toBeNull();
    for (const r of [direct, viaListener]) {
      const wait = await storedWait(r.readingId);
      expect(wait! >= BigInt(HELD_MS - 200) * 1000n, `stored wait ${String(wait)} us`).toBe(true);
      await expect(claim(r.readingId, 2_000_000n)).rejects.toThrow(/EBMR-DEV-104 DI-28: /);
    }
  });

  it('[DI-28] the holder of the application role cannot report a smaller wait any other way: the two-argument call is gone, and a wait without a proof, on a challenge the database never issued, with the stale signature on a fresh challenge, with a changed wait or signed by another key is refused; nothing is stored', async () => {
    const r = gw.next();
    const actor = await sessionActor();
    const genuine = await provenIngestParams(server, actor, r, '2500000');
    const signedChallenge = genuine[2];
    // The entry point that took the caller's word for the wait no longer exists.
    await expect(withActorCommand(server.db.app, actor, (c) => c.query('select tab.ingest_reading($1::jsonb, 0)', [JSON.stringify(r)]))).rejects.toThrow(
      /function tab\.ingest_reading\(jsonb, integer\) does not exist/,
    );
    // No proof at all, or a challenge without the gateway's signature.
    await expect(ingestWith(r, '0', null, null)).rejects.toThrow(/^EBMR-DEV-053 DI-28: /);
    await expect(ingestWith(r, '0', signedChallenge, null)).rejects.toThrow(/^EBMR-DEV-053 DI-28: /);
    // A challenge the database never issued (the gateway was made to sign it): refused whatever the signature.
    const invented = randomUUID();
    await expect(ingestWith(r, '0', invented, signWait(server, invented, r.readingId, '0'))).rejects.toThrow(/^EBMR-DEV-054 DI-28: /);
    // The gateway's signature was made for its own challenge and wait: a fresh challenge, or a smaller wait, breaks it.
    const { challengeId: fresh } = await issueChallenge(server, actor);
    await expect(ingestWith(r, '2500000', fresh, genuine[3])).rejects.toThrow(/^EBMR-DEV-055 DI-28: /);
    await expect(ingestWith(r, '0', signedChallenge, genuine[3])).rejects.toThrow(/^EBMR-DEV-055 DI-28: /);
    // Nor does a key other than the enrolled one prove anything, nor a signature over another reading's id.
    const other = generateKeyPairSync('ed25519').privateKey;
    await expect(ingestWith(r, '0', fresh, sign(null, uploadWaitMessage(fresh, r.readingId, '0'), other).toString('base64'))).rejects.toThrow(/^EBMR-DEV-055 DI-28: /);
    await expect(ingestWith(r, '0', fresh, signWait(server, fresh, randomUUID(), '0'))).rejects.toThrow(/^EBMR-DEV-055 DI-28: /);
    expect(await isStored(r.readingId)).toBe(false);
    // The genuine proof is accepted, and its wait counts from its own challenge.
    await withActorCommand(server.db.app, actor, (c) => c.query(INGEST_READING_SQL, genuine));
    expect((await storedWait(r.readingId))! >= 2_500_000n).toBe(true);
    // The refusals of the listener's own early check are the same, and alarmed: a wait with no signature, or one
    // signed for another wait.
    const early = gw.next();
    const unsigned = await gw.uplink([{ reading: early, delayUs: '0', waitSig: null }]);
    expect(unsigned.body.refused).toMatchObject({ readingId: early.readingId, code: 'EBMR-DEV-053' });
    const cid = await gw.challenge();
    const changed = await gw.uplink([{ reading: early, delayUs: '0', waitSig: signWait(server, cid, early.readingId, '3000000') }], { challengeId: cid });
    expect(changed.body.refused).toMatchObject({ readingId: early.readingId, code: 'EBMR-DEV-055' });
    expect(await isStored(early.readingId)).toBe(false);
    const { rows } = await server.db.app.query<{ code: string }>("select code from tab.device_alarm where kind = 'READING_REFUSED' and reading_id = $1 order by id", [early.readingId]);
    expect(rows.map((a) => a.code)).toEqual(['EBMR-DEV-053', 'EBMR-DEV-055']);
  });

  it('[DI-28] the listener refuses an unproven wait early, as the database does: no signature (EBMR-DEV-053), or one that is not over this challenge, reading and wait (EBMR-DEV-055)', () => {
    const key = ed25519PublicKey(gatewayKey(server).publicKeySpki);
    const reading = gw.next();
    const cid = randomUUID();
    const item = (delayUs: string | null, waitSig: string | null) => ({ reading, delayUs, waitSig });
    expect(waitProofProblem(cid, item(null, null), key)).toBeNull();
    expect(waitProofProblem(cid, item('0', signWait(server, cid, reading.readingId, '0')), key)).toBeNull();
    expect(waitProofProblem(cid, item('0', null), key)?.code).toBe('EBMR-DEV-053');
    expect(waitProofProblem(cid, item('0', signWait(server, cid, reading.readingId, '1')), key)?.code).toBe('EBMR-DEV-055');
    expect(waitProofProblem(randomUUID(), item('0', signWait(server, cid, reading.readingId, '0')), key)?.code).toBe('EBMR-DEV-055');
    expect(waitProofProblem(cid, item('0', signWait(server, cid, randomUUID(), '0')), key)?.code).toBe('EBMR-DEV-055');
    expect(waitProofProblem(cid, item('0', 'AAAA'), key)?.code).toBe('EBMR-DEV-055');
  });

  it('[DI-28] the challenge is the database\'s: issued only to a bound gateway session in its role, with the database clock, and not readable or writable by the application role', async () => {
    const actor = await sessionActor();
    const before = await dbNowUs(server.db.app);
    const { challengeId, issuedUs } = await issueChallenge(server, actor);
    const after = await dbNowUs(server.db.app);
    expect(issuedUs >= before && issuedUs <= after, `issued ${String(issuedUs)} not within [${String(before)}, ${String(after)}]`).toBe(true);
    // The application role can neither read the challenges nor write one with an issue time of its choosing.
    await expect(server.db.app.query('select issued_at from tab.ingest_challenge where id = $1', [challengeId])).rejects.toThrow(/permission denied/);
    await expect(
      server.db.app.query("insert into tab.ingest_challenge (gateway_key_id, session_id, issued_at) values ($1, $2, clock_timestamp() + interval '1 hour')", [gw.login.chainId, actor.sessionId]),
    ).rejects.toThrow(/permission denied/);
    // A person's command, or none, gets no challenge.
    await expect(server.db.app.query('select tab.issue_ingest_challenge()')).rejects.toThrow(/EBMR-IAM-00[12]/);
    const op = await operatorActor(server);
    await expect(withActorCommand(server.db.app, op, (c) => c.query('select tab.issue_ingest_challenge()'))).rejects.toThrow(/EBMR-IAM-04[02]|EBMR-DEV-03[0-2]/);
    const admin = await adminActor(server);
    await expect(withActorCommand(server.db.app, admin, (c) => c.query('select tab.issue_ingest_challenge()'))).rejects.toThrow(/EBMR-IAM-04[02]|EBMR-DEV-03[0-2]/);
  });

  it('[DI-28][DI-31] a challenge issued to another enrolment (a key since revoked) proves no wait for a reading of the new chain', async () => {
    const { challengeId: oldChallenge } = await issueChallenge(server, await sessionActor());
    const admin = await adminActor(server, 'key rotated (test)');
    await withActorCommand(server.db.app, admin, (c) => c.query("select tab.revoke_gateway_key($1, 'KEY_COMPROMISED', 'gateway key rotated in test')", [gw.login.chainId]));
    await enrol(server);
    await gw.close();
    gw = await fakeGateway(server);
    const r = gw.next();
    // Signed with the same (re-enrolled) key, so only the challenge's enrolment can refuse it.
    await expect(ingestWith(r, '0', oldChallenge, signWait(server, oldChallenge, r.readingId, '0'))).rejects.toThrow(/^EBMR-DEV-054 DI-28: /);
    expect((await gw.uplink([{ reading: r, delayUs: '0' }], { challengeId: oldChallenge })).body.refused).toMatchObject({ readingId: r.readingId, code: 'EBMR-DEV-054' });
    expect(await isStored(r.readingId)).toBe(false);
    // The new enrolment's own challenge proves it.
    expect((await gw.uplink([{ reading: r, delayUs: '0' }])).body.refused).toBeNull();
    await expect(claim(r.readingId, 2_000_000n)).resolves.toHaveLength(1);
  });
});
