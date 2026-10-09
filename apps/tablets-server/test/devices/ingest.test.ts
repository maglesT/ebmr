/**
 * Gateway listener and ingestion (module C5): the site gateway's readings enter under its integration identity,
 * signed, hash-chained and sequence-checked; every refused transfer raises an alarm (DI-31).
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asAdmin } from '@ebmr/test-kit';
import { canonicalReadingText, genesisHash, readingHash, sealReading, ed25519PrivateKey } from '@ebmr/integration-sdk/scale';
import { withActorCommand } from '../../src/platform/db/commands.ts';
import { gatewayActor, gatewaySessionOf } from '../../src/features/devices/listener.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { INGEST_READING_SQL, adminActor, enrol, fakeGateway, gatewayKey, ingestProven, loginAt, operatorActor, provenIngestParams, type FakeGateway } from './support.ts';

let server: TestServer;
let gw: FakeGateway;

async function alarms(kind: string): Promise<{ code: string; reading_id: string | null; message: string }[]> {
  const { rows } = await server.db.app.query<{ code: string; reading_id: string | null; message: string }>(
    'select code, reading_id, message from tab.device_alarm where kind = $1 order by id',
    [kind],
  );
  return rows;
}

async function head(): Promise<{ seq: string; hash: string }> {
  const { rows } = await server.db.app.query<{ h: { seq: string; hash: string } }>('select tab.chain_head($1) as h', [gw.login.chainId]);
  return rows[0]!.h;
}

/** A fresh fake gateway whose chain cursor starts at the server head (after refused readings). */
async function resync(): Promise<void> {
  await gw.close();
  gw = await fakeGateway(server);
}

beforeAll(async () => {
  server = await startServer('SANDBOX');
  await enrol(server);
  gw = await fakeGateway(server);
});

afterAll(async () => {
  await gw?.close();
  await server?.close();
});

beforeEach(async () => {
  await resync();
});

describe('gateway login', () => {
  it('[DI-31] the gateway logs in with its service key and proof of its enrolled key; the chain starts at the genesis link', () => {
    expect(gw.login.installation).toBe('SANDBOX');
    expect(gw.login.instruments).toEqual([{ deviceCode: 'TEST-BAL-01', serial: 'SIM-0001', unit: 'kg', resolution: '0.001', roomCode: 'DISP-1' }]);
    expect(BigInt(gw.login.head.seq)).toBeGreaterThanOrEqual(0n);
    if (gw.login.head.seq === '0') expect(gw.login.head.hash).toBe(genesisHash(gw.login.chainId));
  });

  it('[DI-20] a key that is not the enrolled one, a wrong proof or a wrong service key is refused, with an alarm', async () => {
    const other = generateKeyPairSync('ed25519');
    const spki = other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const pkcs8 = other.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    const unknownKey = await loginAt(gw.base, server, { spki, privateKeyPkcs8: pkcs8 });
    expect(unknownKey.status).toBe(401);
    // Proof signed with another key than the SPKI presented.
    const badProof = await loginAt(gw.base, server, { privateKeyPkcs8: pkcs8 });
    expect(badProof.status).toBe(401);
    expect((badProof.body as { error: { code: string } }).error.code).toBe('KEY_PROOF');
    const badSecret = await loginAt(gw.base, server, { serviceKey: 'not-the-service-key' });
    expect(badSecret.status).toBe(401);
    const refused = await alarms('GATEWAY_LOGIN_REFUSED');
    expect(refused.map((a) => a.code)).toEqual(expect.arrayContaining(['AUTH_FAILED', 'KEY_PROOF']));
  });

  it('[DI-31] a nonce is single use', async () => {
    const nonce = (await gw.post('/gw/v1/nonce', {}, null)).body as { nonce: string };
    const first = await gw.post('/gw/v1/session', { gatewayCode: 'TEST-GW-01', loginName: 'test-gw', serviceKey: 'x', spki: gatewayKey(server).publicKeySpki, nonce: nonce.nonce, sig: 'AAAA', apiToken: randomBytes(32).toString('base64url') }, null);
    expect(first.status).toBe(401);
    const again = await gw.post('/gw/v1/session', { gatewayCode: 'TEST-GW-01', loginName: 'test-gw', serviceKey: 'x', spki: gatewayKey(server).publicKeySpki, nonce: nonce.nonce, sig: 'AAAA', apiToken: randomBytes(32).toString('base64url') }, null);
    expect((again.body as { error: { code: string } }).error.code).toBe('NONCE');
  });

  it('[DI-31] readings, their challenges and heartbeats need the bearer token', async () => {
    const r = gw.next();
    const upload = { challengeId: await gw.challenge(), items: [{ reading: r, delayUs: null, waitSig: null }] };
    expect((await gw.post('/gw/v1/readings', upload, null)).status).toBe(401);
    expect((await gw.post('/gw/v1/readings', upload, randomBytes(32).toString('base64url'))).status).toBe(401);
    expect((await gw.post('/gw/v1/challenge', {}, null)).status).toBe(401);
    expect((await gw.post('/gw/v1/challenge', {}, randomBytes(32).toString('base64url'))).status).toBe(401);
    expect((await gw.post('/gw/v1/heartbeat', { gatewayTimeUs: '1790584618000000', devices: [], journal: { lastSeq: '0', ackedSeq: '0' } }, null)).status).toBe(401);
  });
});

describe('ingestion', () => {
  it('[DI-31][DI-28] readings are ingested in chain order; the same reading again is a duplicate, never a second row', async () => {
    const a = gw.next({ value: '1.250', raw: 'S S      1.250 kg' });
    const b = gw.next({ value: '1.251', raw: 'S S      1.251 kg' });
    const res = await gw.uplink([{ reading: a }, { reading: b }]);
    expect(res.status).toBe(200);
    expect(res.body.refused).toBeNull();
    expect(res.body.results.map((x) => x.outcome)).toEqual(['INGESTED', 'INGESTED']);
    expect(res.body.head).toEqual({ seq: b.seq, hash: b.hash });
    // A resend after a lost acknowledgement (gateway crash between write and ack).
    const again = await gw.uplink([{ reading: a }, { reading: b }]);
    expect(again.body.results.map((x) => x.outcome)).toEqual(['DUPLICATE', 'DUPLICATE']);
    const { rows } = await server.db.app.query<{ n: string }>('select count(*)::text as n from tab.device_reading where id = any($1::uuid[])', [[a.readingId, b.readingId]]);
    expect(rows[0]?.n).toBe('2');
  });

  it('[DI-31] a gap in the sequence is refused with an alarm; nothing after it is taken', async () => {
    gw.next(); // skipped: never sent
    const c = gw.next();
    const res = await gw.uplink([{ reading: c }]);
    expect(res.body.refused?.code).toBe('EBMR-DEV-044');
    expect(res.body.results).toEqual([]);
    expect((await alarms('READING_REFUSED')).some((x) => x.reading_id === c.readingId && x.code === 'EBMR-DEV-044')).toBe(true);
  });

  it('[DI-31] a tampered reading (value changed after signing) or an unsigned one is refused with an alarm', async () => {
    const r = gw.next();
    const tampered = { ...r, value: '1.260', raw: 'S S      1.260 kg' };
    const res = await gw.uplink([{ reading: tampered }]);
    expect(res.body.refused?.code).toBe('EBMR-DEV-045');
    // Re-hashed by an attacker without the key: the signature fails.
    const rehashed = { ...tampered, hash: readingHash(tampered) };
    const res2 = await gw.uplink([{ reading: rehashed }]);
    expect(res2.body.refused?.code).toBe('EBMR-DEV-061');
    // Unsigned: refused by the schema before anything else.
    const unsigned = { ...r, signature: '' };
    const res3 = await gw.post('/gw/v1/readings', { challengeId: await gw.challenge(), items: [{ reading: unsigned, delayUs: null, waitSig: null }] });
    expect(res3.status).toBe(400);
    expect((await alarms('READING_REFUSED')).map((a) => a.code)).toEqual(expect.arrayContaining(['EBMR-DEV-045', 'EBMR-DEV-061', 'SCHEMA']));
  });

  it('[DI-32] a raw line that does not state exactly the reading value is refused', async () => {
    const r = gw.next({ value: '2.000', raw: 'S S      2.001 kg' });
    const res = await gw.uplink([{ reading: r }]);
    expect(res.body.refused?.code).toBe('EBMR-DEV-062');
    await resync();
    const s = gw.next({ value: '2.000', raw: 'S D      2.000 kg' });
    expect((await gw.uplink([{ reading: s }])).body.refused?.code).toBe('EBMR-DEV-062');
  });

  it('[DI-20] a reading with a serial that is not the registered one is refused', async () => {
    const r = gw.next({ serial: 'SIM-9999' });
    const res = await gw.uplink([{ reading: r }]);
    expect(res.body.refused?.code).toBe('EBMR-DEV-048');
  });

  it('[DI-20] a reading from an instrument not bound to this gateway is refused', async () => {
    const r = gw.next({ deviceCode: 'TEST-BAL-02' });
    expect((await gw.uplink([{ reading: r }])).body.refused?.code).toBe('EBMR-DEV-046');
  });

  it('[DI-20] a reading of the other installation kind (GMP) is refused by a sandbox installation', async () => {
    const r = gw.next({ installation: 'GMP' });
    expect((await gw.uplink([{ reading: r }])).body.refused?.code).toBe('EBMR-DEV-043');
  });

  it('[DI-31] unit and resolution are checked: another unit or a value finer than the resolution is refused', async () => {
    const g = gw.next({ value: '1250', unit: 'g', raw: 'S S       1250 g' });
    expect((await gw.uplink([{ reading: g }])).body.refused?.code).toBe('EBMR-DEV-049');
    await resync();
    const fine = gw.next({ value: '1.2505', raw: 'S S     1.2505 kg' });
    expect((await gw.uplink([{ reading: fine }])).body.refused?.code).toBe('EBMR-DEV-050');
  });

  it('[DI-31] the database recomputes the hash itself: a direct call with a hash that does not match the content is refused', async () => {
    const r = gw.next();
    const forged = { ...r, value: '9.999', raw: 'S S      9.999 kg' };
    // The gateway session's actor as the listener builds it: the roles its account holds now (DI-17).
    const hash = createHash('sha256').update(gw.token).digest('hex');
    const { rows } = await server.db.app.query<{ r: Record<string, unknown> | null }>('select tab.resolve_gateway_session($1) as r', [hash]);
    const s = rows[0]?.r;
    if (!s) throw new Error('test set-up: the fake gateway session did not resolve');
    const actor = gatewayActor(gatewaySessionOf(hash, s), server.config.siteZone, randomUUID());
    // Its wait proven as the gateway proves it (tablets 0330), so only the hash can refuse it.
    await expect(ingestProven(server, actor, forged)).rejects.toThrow(/EBMR-DEV-045/);
    // The same call with the genuine reading is accepted: the SQL canonical text equals the SDK's.
    await expect(ingestProven(server, actor, r)).resolves.toBeDefined();
  });

  it('[DI-17][INV-20] the listener acts only in SITE_GATEWAY, never in the kernel\'s SERVICE_ACCOUNT, whatever roles its account holds', async () => {
    const hash = createHash('sha256').update(gw.token).digest('hex');
    const { rows } = await server.db.app.query<{ r: Record<string, unknown> | null }>('select tab.resolve_gateway_session($1) as r', [hash]);
    const session = gatewaySessionOf(hash, rows[0]!.r!);
    expect(gatewayActor(session, server.config.siteZone, randomUUID()).roleCode).toBe(server.seed.services.find((x) => x.key === 'gateway')?.roleCode);
    expect(gatewayActor({ ...session, roles: ['SERVICE_ACCOUNT', 'SITE_GATEWAY'] }, server.config.siteZone, randomUUID()).roleCode).toBe('SITE_GATEWAY');
    expect(gatewayActor({ ...session, roles: ['SERVICE_ACCOUNT'] }, server.config.siteZone, randomUUID()).roleCode).toBe('SITE_GATEWAY');
  });

  it('[DI-31] the SQL canonical text equals the SDK canonical text for any printable raw line, value and purpose (fast-check)', async () => {
    const printable = fc.string({ unit: fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)), minLength: 1, maxLength: 64 });
    // The helper is not granted to the application role (only the definers use it), so the owner's view is read.
    await asAdmin(server.database, (admin) =>
      fc.assert(
        fc.asyncProperty(printable, fc.option(fc.constantFrom('1.250', '-0.005', '12345.678'), { nil: null }), fc.boolean(), fc.option(fc.constantFrom('TARE' as const, 'GROSS' as const, 'CHECK' as const), { nil: null }), async (raw, value, stable, purpose) => {
          const r = gw.next({ raw, value, stable, purpose });
          const { hash, signature, ...body } = r;
          void hash;
          void signature;
          const { rows } = await admin.query<{ t: string }>('select tab.reading_canonical_text($1::jsonb) as t', [JSON.stringify(r)]);
          expect(rows[0]?.t).toBe(canonicalReadingText(body));
        }),
        { numRuns: 60 },
      ),
    );
  });

  it('[DI-31] only a bound gateway session of the INTEGRATION identity can ingest; a person or the administrator cannot', async () => {
    const r = gw.next();
    // Even with the wait proven as the gateway proves it (a challenge issued to the gateway's session, signed).
    const hash = createHash('sha256').update(gw.token).digest('hex');
    const { rows } = await server.db.app.query<{ r: Record<string, unknown> | null }>('select tab.resolve_gateway_session($1) as r', [hash]);
    const params = await provenIngestParams(server, gatewayActor(gatewaySessionOf(hash, rows[0]!.r!), server.config.siteZone, randomUUID()), r);
    const admin = await adminActor(server);
    await expect(withActorCommand(server.db.app, admin, (c) => c.query(INGEST_READING_SQL, params))).rejects.toThrow(/EBMR-IAM-04[02]|EBMR-DEV-030/);
    const op = await operatorActor(server);
    await expect(withActorCommand(server.db.app, op, (c) => c.query(INGEST_READING_SQL, params))).rejects.toThrow(/EBMR-IAM-04[02]|EBMR-DEV-030/);
    expect((await server.db.app.query('select 1 from tab.device_reading where id = $1', [r.readingId])).rowCount).toBe(0);
  });

  it('[DI-31] reconciliation by counts: a gateway that counts more acknowledged readings than the server holds raises an alarm', async () => {
    gw.next();
    gw.next(); // two readings the server never received, counted as acknowledged by this (fake) gateway
    const res = await gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' }]);
    expect(res.status).toBe(200);
    const alarm = await server.db.app.query<{ message: string }>("select message from tab.device_alarm where code = 'EBMR-DEV-070'");
    expect(alarm.rows.length).toBe(1);
    expect(alarm.rows[0]?.message).toMatch(/must send the missing readings again/);
    // Once a minute at most.
    await gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' }]);
    expect((await server.db.app.query("select 1 from tab.device_alarm where code = 'EBMR-DEV-070'")).rowCount).toBe(1);
  });

  it('[DI-22] an ingested reading is audited on its own chain, attributed to the gateway identity with source INTEGRATION', async () => {
    const r = gw.next();
    await gw.uplink([{ reading: r }]);
    const { rows } = await asAdmin(server.database, (c) =>
      c.query<{ action: string; source: string; legal: string }>(
        `select action, payload ->> 'source' as source, payload -> 'actor' ->> 'legal_name' as legal from kernel.audit_event where chain_key = $1 order by seq`,
        [`device_reading:${r.readingId}`],
      ),
    );
    expect(rows.map((x) => x.action)).toEqual(['INSERT', 'BUSINESS']);
    expect(rows.every((x) => x.source === 'INTEGRATION' && x.legal === 'TEST-gw')).toBe(true);
  });

  it('[DI-31] a revoked gateway key can no longer log in or ingest, and its readings can no longer be claimed', async () => {
    const r = gw.next();
    await gw.uplink([{ reading: r }]);
    const admin = await adminActor(server, 'key compromised (test)');
    await withActorCommand(server.db.app, admin, (c) => c.query("select tab.revoke_gateway_key($1, 'KEY_COMPROMISED', 'gateway key compromised in test')", [gw.login.chainId]));
    expect((await gw.uplink([{ reading: gw.next() }])).status).toBe(401);
    expect((await loginAt(gw.base, server)).status).toBe(401);
    const op = await operatorActor(server);
    await expect(
      withActorCommand(server.db.app, op, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [r.readingId], room: 'DISP-1', maxAgeUs: 120_000_000n, purpose: 'GROSS' })),
    ).rejects.toThrow(/EBMR-DEV-109/);
    // Re-enrol for the other tests (a new chain).
    await enrol(server);
    await resync();
    expect(gw.login.head.seq).toBe('0');
  });

  it('revoking needs a reason code and a reason text', async () => {
    const admin = await adminActor(server);
    await expect(withActorCommand(server.db.app, admin, (c) => c.query("select tab.revoke_gateway_key($1, '', '')", [gw.login.chainId]))).rejects.toThrow(/EBMR-DEV-009/);
    expect(await head()).toBeDefined();
  });

  it('sealReading is deterministic in its hash for the same content', () => {
    const k = ed25519PrivateKey(gatewayKey(server).privateKeyPkcs8);
    const r = gw.next();
    const { hash, signature, ...body } = r;
    void signature;
    expect(sealReading(body, k).hash).toBe(hash);
  });
});
