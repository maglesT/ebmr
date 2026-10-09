/**
 * D16 (SQL mutation kill results, group device-readings): a gateway key of small order is neither enrolled nor
 * trusted (tablets 0702; controls DI-32, DI-30, DI-20, DI-31).
 *
 * The database verifies a reading's Ed25519 signature the way OpenSSL does, without the cofactor (tablets 0270,
 * tab.ed25519_verify): [S]B - [k]A must be R. For a public key A of small order ([8]A is the neutral point) that
 * equation does not depend on a private key: with A the neutral point, R = B and S = 1 satisfy it for every message,
 * and for a key of order 2, 4 or 8 a forger tries a few values of S until k is a multiple of the order. Before 0702,
 * tab.enrol_gateway_key (0250) checked only that the key was base64 and that its SHA-256 was the fingerprint the
 * administrator registered for the gateway's SERVER device, so such a key could be enrolled; anyone who then reached
 * ingestion could store readings "signed by the holder of the enrolled key" (EBMR-DEV-061), prove an upload wait
 * (EBMR-DEV-055) and pass the listener's login proof, with no private key at all.
 *
 * Since 0702: enrolment refuses an SPKI that is not the 44-byte Ed25519 SubjectPublicKeyInfo (EBMR-DEV-016), a key
 * that is not the canonical encoding of a curve point (EBMR-DEV-017) and a key of small order (EBMR-DEV-018). A key of
 * small order enrolled before 0702 is never trusted: no session binds under it (EBMR-DEV-025, which also refuses the
 * listener's login), and the signature checks of a reading and of an upload wait are false under it, so ingestion
 * refuses its readings and a claim refuses one stored before (EBMR-DEV-110). Such a key is written here by the
 * superuser with triggers off, as 0250's enrolment stored it, since no product path writes one any more; so is a
 * gateway session bound under it, and a reading stored under it.
 *
 * The small-order points are the eight points of the curve's torsion group (orders 1, 2, 4 and 8, as listed by the
 * libraries that refuse such keys, libsodium among them); each one's order is computed here in affine coordinates,
 * independent of the database's point arithmetic, from the coordinates the database decodes.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity, type ActorContext } from '@ebmr/kernel';
import { READING_FORMAT, formatWeight, readingHash, sealReading, uploadWaitMessage, type ReadingBody, type ScaleReading } from '@ebmr/integration-sdk/scale';
import { gatewayActor, gatewaySessionOf, startGatewayListener } from '../../src/features/devices/listener.ts';
import { withActorCommand } from '../../src/platform/db/commands.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { INGEST_READING_SQL, adminActor, gatewayService, issueChallenge, operatorActor, post } from './support.ts';

type Json = Record<string, unknown>;

let server: TestServer;
let site: string;
/** The neutral point's key as enrolled before 0702 (for TEST-GW-20, the gateway registered with its fingerprint). */
let before: { keyId: string; tokenHash: string; code: string };

const ED25519_SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_SPKI_HEADER = Buffer.from('302a300506032b656e032100', 'hex');
const ED448_OID_HEADER = Buffer.from('302a300506032b6571032100', 'hex');
const spkiOf = (key: Buffer, header = ED25519_SPKI_HEADER): string => Buffer.concat([header, key]).toString('base64');
const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const fingerprintOf = (spki: string): string => sha256Hex(Buffer.from(spki, 'base64'));
const hex = (h: string): Buffer => Buffer.from(h, 'hex');

/** The eight points of small order, as canonical encodings (y little-endian, the sign of x in the top bit). */
const SMALL_ORDER: readonly { order: number; name: string; key: Buffer }[] = [
  { order: 1, name: 'the neutral point (0, 1)', key: hex(`01${'00'.repeat(31)}`) },
  { order: 2, name: 'the point (0, -1)', key: hex(`ec${'ff'.repeat(30)}7f`) },
  { order: 4, name: 'the point (sqrt(-1), 0)', key: hex('00'.repeat(32)) },
  { order: 4, name: 'the point (-sqrt(-1), 0)', key: hex(`${'00'.repeat(31)}80`) },
  { order: 8, name: 'a point of order 8 (y = 26e8...fc05, x even)', key: hex('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05') },
  { order: 8, name: 'a point of order 8 (y = 26e8...fc05, x odd)', key: hex('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85') },
  { order: 8, name: 'a point of order 8 (y = c717...037a, x even)', key: hex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a') },
  { order: 8, name: 'a point of order 8 (y = c717...037a, x odd)', key: hex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa') },
];

/** 32 bytes that are no curve point: y = 2 (no x satisfies the curve equation), y = q + 1 unreduced, x = 0 with a sign. */
const NOT_POINTS: readonly { name: string; key: Buffer }[] = [
  { name: 'y = 2, which has no x on the curve', key: hex(`02${'00'.repeat(31)}`) },
  { name: 'the neutral point written unreduced (y = q + 1)', key: hex(`ee${'ff'.repeat(30)}7f`) },
  { name: 'the neutral point with the sign bit of x set (x = 0 has no sign)', key: hex(`01${'00'.repeat(30)}80`) },
];

/** An honest gateway key, enrolled for its own gateway (the last one registered); the 32 bytes of another one, for the SPKIs of the wrong form. */
const honest = generateKeyPairSync('ed25519');
const honestSpki = honest.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const otherRaw = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(12);

/** SPKIs that are not the 44-byte Ed25519 SubjectPublicKeyInfo of RFC 8410. */
const WRONG_FORM: readonly { name: string; spki: string }[] = [
  { name: 'one byte too long (the Ed25519 header, a valid key, a trailing 00)', spki: spkiOf(Buffer.concat([otherRaw, Buffer.from([0])])) },
  { name: 'one byte too short (the Ed25519 header and 31 bytes of a key)', spki: spkiOf(otherRaw.subarray(0, 31)) },
  { name: 'an X25519 key (OID 1.3.101.110) of 44 bytes', spki: spkiOf(otherRaw, X25519_SPKI_HEADER) },
  { name: 'the OID of Ed448 (1.3.101.113) over 32 bytes, 44 bytes in all', spki: spkiOf(otherRaw, ED448_OID_HEADER) },
];

/**
 * The neutral point's universal forgery: R = B (the base point's encoding) and S = 1 verify under the cofactorless check
 * for every message, since [1]B - [k]O = B.
 */
const BASE_POINT = hex(`58${'66'.repeat(31)}`);
const FORGED = Buffer.concat([BASE_POINT, hex(`01${'00'.repeat(31)}`)]).toString('base64');
const NEUTRAL_SPKI = spkiOf(SMALL_ORDER[0]?.key ?? Buffer.alloc(0));

/** Gateway codes by SPKI: every SPKI tested gets an ACTIVE SERVER device whose fingerprint is its SHA-256. */
const gatewayOf = new Map<string, string>();
const deviceIds = new Map<string, string>();

beforeAll(async () => {
  server = await startServer('SANDBOX');
  site = (await server.db.admin.query<{ site_code: string }>("select site_code from iam.device where code = 'TEST-GW-01'")).rows[0]?.site_code ?? '';
  const spkis = [
    ...SMALL_ORDER.map((p) => spkiOf(p.key)),
    ...NOT_POINTS.map((p) => spkiOf(p.key)),
    ...WRONG_FORM.map((w) => w.spki),
    honestSpki,
  ];
  spkis.forEach((s, i) => gatewayOf.set(s, `TEST-GW-${String(20 + i).padStart(2, '0')}`));
  await withActorCommand(server.db.app, await adminActor(server, 'D16 tests: gateways of every key tested'), async (c) => {
    for (const [spki, code] of gatewayOf) {
      await c.query('select iam.register_device($1, $2, $3, null, null, $4, $5)', [code, 'SERVER', site, fingerprintOf(spki), `${code} (D16 tests)`]);
    }
    // The scales behind the honest gateway and behind the neutral point's (both in DISP-1, the operator's kiosk room).
    for (const code of ['TEST-BAL-20', 'TEST-BAL-21']) {
      await c.query('select iam.register_device($1, $2, $3, $4, null, $5, $6)', [code, 'INSTRUMENT', site, 'DISP-1', sha256Hex(randomBytes(32)), `${code} (D16 tests)`]);
    }
  });
  for (const r of (await server.db.admin.query<{ code: string; id: string }>('select code, id::text as id from iam.device')).rows) deviceIds.set(r.code, r.id);
  // First of all, so that no enrolment below can take its place: a device holds one ACTIVE key.
  before = await enrolledBefore0702(NEUTRAL_SPKI);
}, 300_000);

afterAll(async () => {
  await server?.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------

const gateway = (spki: string): string => {
  const code = gatewayOf.get(spki);
  if (!code) throw new Error('SETUP: no gateway registered for this SPKI');
  return code;
};
const deviceId = (code: string): string => {
  const id = deviceIds.get(code);
  if (!id) throw new Error(`SETUP: no device ${code}`);
  return id;
};

/** tab.enrol_gateway_key in the administrator's command (IAM.DEVICE_MANAGE), as the set-up's seed calls it. */
async function enrol(code: string, spki: string | null): Promise<string> {
  const id = await withActorCommand(server.db.app, await adminActor(server, 'D16 tests: enrolment'), async (c) =>
    (await c.query<{ id: string }>('select tab.enrol_gateway_key($1, $2, $3)::text as id', [code, spki, gatewayService(server).loginName])).rows[0]?.id,
  );
  if (!id) throw new Error('no enrolment was returned');
  return id;
}

async function keysOf(code: string): Promise<number> {
  return (await server.db.admin.query('select 1 from tab.gateway_key where gateway_code = $1', [code])).rowCount ?? 0;
}

async function bindInstrument(keyId: string, instrument: string, serial: string): Promise<void> {
  await withActorCommand(server.db.app, await adminActor(server, 'D16 tests: binding'), (c) =>
    c.query("select tab.bind_instrument($1, $2, $3, 'kg', '0.001')", [keyId, instrument, serial]),
  );
}

/** The gateway identity's service-key login on the SERVER device registered with `spki`'s fingerprint; its session. */
async function serviceLogin(spki: string): Promise<string> {
  const s = gatewayService(server);
  const fp = fingerprintOf(spki);
  const ev = await identity.authenticate(server.db.authn, { method: 'SERVICE_KEY', identifier: s.loginName, secret: s.serviceKey, deviceFingerprint: fp, purpose: 'LOGIN' });
  return (await identity.openSession(server.db.app, ev.authEventId, fp)).sessionId;
}

/** tab.bind_gateway_session as the listener calls it at login; the token's hash. */
async function bindSession(sessionId: string, spki: string): Promise<string> {
  const hash = sha256Hex(randomBytes(32));
  await server.db.app.query('select tab.bind_gateway_session($1, $2, $3)', [sessionId, hash, spki]);
  return hash;
}

/** The gateway actor of a bound token, as the listener builds it. */
async function actorOf(hash: string): Promise<ActorContext> {
  const r = (await server.db.app.query<{ r: Json | null }>('select tab.resolve_gateway_session($1) as r', [hash])).rows[0]?.r;
  if (!r) throw new Error('SETUP: the token does not resolve');
  return gatewayActor(gatewaySessionOf(hash, r), server.config.siteZone, randomUUID());
}

/** The superuser's statements in one transaction with triggers off (session_replication_role = replica). */
async function asOwnerWithoutTriggers(work: (c: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<void>): Promise<void> {
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    await work(c);
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}

/**
 * A key of small order enrolled before tablets 0702, for the gateway registered with its fingerprint: the row 0250's
 * tab.enrol_gateway_key stored (ACTIVE, the gateway identity's account, the administrator as enrolling person), with
 * the instrument TEST-BAL-21 bound to it and a gateway session bound under it, as a login before 0702 bound it.
 */
async function enrolledBefore0702(spki: string): Promise<{ keyId: string; tokenHash: string; code: string }> {
  const code = gateway(spki);
  const keyId = randomUUID();
  const admin = await adminActor(server, 'D16 tests: the enrolling administrator');
  await asOwnerWithoutTriggers(async (c) => {
    await c.query(
      `insert into tab.gateway_key (id, gateway_device_id, gateway_code, account_id, public_key_spki, key_fingerprint, enrolled_by_person)
       select $1, $2, $3, a.id, $4, $5, $6 from iam.account a where a.login_name = $7`,
      [keyId, deviceId(code), code, spki, fingerprintOf(spki), admin.personId, gatewayService(server).loginName],
    );
  });
  await bindInstrument(keyId, 'TEST-BAL-21', 'SIM-0021');
  const sessionId = await serviceLogin(spki);
  const tokenHash = sha256Hex(randomBytes(32));
  await asOwnerWithoutTriggers(async (c) => {
    await c.query('insert into tab.gateway_session (token_hash, session_id, gateway_key_id) values ($1, $2, $3)', [tokenHash, sessionId, keyId]);
  });
  return { keyId, tokenHash, code };
}

/** The next reading of a chain at its head in the database: TEST-BAL-2x in DISP-1, 1.250 kg stable, taken as GROSS. */
async function nextReading(chainId: string, gatewayCode: string, deviceCode: string, serial: string): Promise<ReadingBody> {
  const h = (await server.db.app.query<{ h: { seq: string; hash: string } }>('select tab.chain_head($1) as h', [chainId])).rows[0]?.h;
  if (!h) throw new Error('SETUP: no chain head');
  return {
    format: READING_FORMAT,
    readingId: randomUUID(),
    chainId,
    gatewayCode,
    deviceCode,
    serial,
    seq: (BigInt(h.seq) + 1n).toString(),
    value: '1.250',
    unit: 'kg',
    stable: true,
    status: 'OK',
    raw: formatWeight('S', 'S', '1.250', 'kg'),
    sourceTimeUs: '1790584618000000',
    trust: 'DEVICE_UNSYNCED',
    installation: 'SANDBOX',
    purpose: 'GROSS',
    prevHash: h.hash,
  };
}

/** A reading "signed" without any private key: the neutral point's universal forgery. */
const forged = (b: ReadingBody): ScaleReading => ({ ...b, hash: readingHash(b), signature: FORGED });

async function stored(id: string): Promise<number> {
  return (await server.db.admin.query('select 1 from tab.device_reading where id = $1', [id])).rowCount ?? 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Point arithmetic in affine coordinates (independent of the database's), for the orders of the points tested
// ---------------------------------------------------------------------------------------------------------------------

const Q = (1n << 255n) - 19n;
const mod = (a: bigint): bigint => ((a % Q) + Q) % Q;
const pow = (b: bigint, e: bigint): bigint => {
  let r = 1n;
  let x = mod(b);
  for (let n = e; n > 0n; n >>= 1n) {
    if (n & 1n) r = mod(r * x);
    x = mod(x * x);
  }
  return r;
};
const inv = (a: bigint): bigint => pow(a, Q - 2n);
const D = mod(-121665n * inv(121666n));
/** Edwards addition on -x^2 + y^2 = 1 + d x^2 y^2 (complete on this curve). */
const add = ([x1, y1]: [bigint, bigint], [x2, y2]: [bigint, bigint]): [bigint, bigint] => {
  const t = mod(D * x1 * x2 * y1 * y2);
  return [mod((x1 * y2 + y1 * x2) * inv(1n + t)), mod((y1 * y2 + x1 * x2) * inv(1n - t))];
};
/** The order of a point when it is at most 8, otherwise null. */
function smallOrder(p: [bigint, bigint]): number | null {
  let acc = p;
  for (let n = 1; n <= 8; n += 1) {
    if (acc[0] === 0n && acc[1] === 1n) return n;
    acc = add(acc, p);
  }
  return null;
}
/** The affine coordinates the database decodes from 32 bytes (null when they are no point). */
async function decoded(key: Buffer): Promise<[bigint, bigint] | null> {
  const r = (await server.db.admin.query<{ r: string[] | null }>('select tab.ed25519_decode($1)::text[] as r', [key])).rows[0]?.r;
  return r ? [BigInt(r[0] ?? ''), BigInt(r[1] ?? '')] : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------------------------------------------------

describe('D16: enrolment takes only an Ed25519 key of large order (tablets 0702)', () => {
  it('[DI-32][DI-30][DI-20] the keys tested are what they are named: eight points of orders 1, 2, 4 and 8, three encodings of no point, and an honest key of large order', async () => {
    for (const p of SMALL_ORDER) {
      const point = await decoded(p.key);
      expect(point, p.name).not.toBeNull();
      expect(point && smallOrder(point), p.name).toBe(p.order);
    }
    for (const p of NOT_POINTS) expect(await decoded(p.key), p.name).toBeNull();
    const h = await decoded(Buffer.from(honestSpki, 'base64').subarray(12));
    expect(h && smallOrder(h)).toBeNull();
  });

  it.each(SMALL_ORDER.map((p) => [p.name, p.order, spkiOf(p.key)] as const))(
    '[DI-32][DI-30][DI-20] a key of small order is refused (EBMR-DEV-018), whatever fingerprint was registered: %s (order %i)',
    async (_name, _order, spki) => {
      const code = gateway(spki);
      const keys = await keysOf(code);
      await expect(enrol(code, spki)).rejects.toThrow(
        /^EBMR-DEV-018 DI-20: the gateway public key is of small order \(eight times it is the neutral point\), so a signature under it proves nothing; generate a new key pair on the gateway and register its fingerprint$/,
      );
      // The neutral point's gateway keeps only the key written as enrolled before 0702; the others hold none.
      expect(await keysOf(code)).toBe(keys);
    },
  );

  it.each(NOT_POINTS.map((p) => [p.name, spkiOf(p.key)] as const))(
    '[DI-32][DI-30][DI-20] a key that is not the canonical encoding of a curve point is refused (EBMR-DEV-017): %s',
    async (_name, spki) => {
      const code = gateway(spki);
      await expect(enrol(code, spki)).rejects.toThrow(/^EBMR-DEV-017 DI-20: the gateway public key is not the encoding of a point of the Ed25519 curve; give the public key exactly as the gateway exported it$/);
      expect(await keysOf(code)).toBe(0);
    },
  );

  it.each(WRONG_FORM.map((w) => [w.name, w.spki] as const))(
    '[DI-32][DI-30][DI-20] an SPKI that is not the 44-byte Ed25519 SubjectPublicKeyInfo is refused (EBMR-DEV-016): %s',
    async (_name, spki) => {
      const code = gateway(spki);
      await expect(enrol(code, spki)).rejects.toThrow(
        /^EBMR-DEV-016 DI-20: the gateway public key is not an Ed25519 SubjectPublicKeyInfo \(44 bytes: the RFC 8410 header and a 32-byte key\); export the gateway's public key as SPKI DER in base64$/,
      );
      expect(await keysOf(code)).toBe(0);
    },
  );

  it('[DI-32][DI-30][DI-20] a missing key is refused as not an Ed25519 SubjectPublicKeyInfo (EBMR-DEV-016)', async () => {
    const code = gateway(honestSpki);
    await expect(enrol(code, null)).rejects.toThrow(/^EBMR-DEV-016 /);
    expect(await keysOf(code)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// An honest key: enrolled, bound, and its signed reading accepted
// ---------------------------------------------------------------------------------------------------------------------

describe('D16: an honest gateway key is enrolled and trusted as before', () => {
  it('[DI-32][DI-30][DI-20] an honest key enrols, a session binds under it, and a reading and a wait signed with its private key are accepted', async () => {
    const code = gateway(honestSpki);
    const keyId = await enrol(code, honestSpki);
    expect(await keysOf(code)).toBe(1);
    await bindInstrument(keyId, 'TEST-BAL-20', 'SIM-0020');
    const actor = await actorOf(await bindSession(await serviceLogin(honestSpki), honestSpki));
    const reading = sealReading(await nextReading(keyId, code, 'TEST-BAL-20', 'SIM-0020'), honest.privateKey);
    const { challengeId } = await issueChallenge(server, actor);
    const waitSig = sign(null, uploadWaitMessage(challengeId, reading.readingId, '0'), honest.privateKey).toString('base64');
    const answer = await withActorCommand(server.db.app, actor, async (c) =>
      (await c.query<{ r: Json }>(INGEST_READING_SQL, [JSON.stringify(reading), '0', challengeId, waitSig])).rows[0]?.r,
    );
    expect(answer?.['outcome']).toBe('INGESTED');
    expect(await stored(reading.readingId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A key of small order enrolled before 0702
// ---------------------------------------------------------------------------------------------------------------------

describe('D16: a key of small order enrolled before tablets 0702 is never trusted', () => {
  let actor: ActorContext;

  beforeAll(async () => {
    actor = await actorOf(before.tokenHash);
  });

  it('[DI-32][DI-30][DI-20] no session binds under it: the gateway identity\'s fresh session on that device is refused (EBMR-DEV-025)', async () => {
    const sessionId = await serviceLogin(NEUTRAL_SPKI);
    await expect(bindSession(sessionId, NEUTRAL_SPKI)).rejects.toThrow(
      new RegExp(
        `^EBMR-DEV-025 DI-20: the gateway key enrolled for ${before.code} cannot be trusted: the gateway public key is of small order \\(eight times it is the neutral point\\), so a signature under it proves nothing; revoke it and enrol a new key$`,
      ),
    );
    expect((await server.db.admin.query('select 1 from tab.gateway_session where session_id = $1', [sessionId])).rowCount).toBe(0);
  });

  it('[DI-32][DI-30][DI-20] the listener\'s login with a forged key proof is refused (401, EBMR-DEV-025), so its proof proves nothing for this chain', async () => {
    const listener = await startGatewayListener(server.built.ctx, { host: '127.0.0.1', port: 0 });
    try {
      const base = `http://127.0.0.1:${listener.port}`;
      const { nonce } = (await post(base, '/gw/v1/nonce', {})).body as { nonce: string };
      const service = gatewayService(server);
      const res = await post(base, '/gw/v1/session', {
        gatewayCode: before.code,
        loginName: service.loginName,
        serviceKey: service.serviceKey,
        spki: NEUTRAL_SPKI,
        nonce,
        sig: FORGED,
        apiToken: randomBytes(32).toString('base64url'),
      });
      expect(res.status).toBe(401);
      expect((res.body as { error: { code: string } }).error.code).toBe('EBMR-DEV-025');
    } finally {
      await listener.close();
    }
  });

  it('[DI-32][DI-30][DI-31] a reading "signed" under it without a private key is refused at ingestion (EBMR-DEV-061), nothing stored', async () => {
    const reading = forged(await nextReading(before.keyId, before.code, 'TEST-BAL-21', 'SIM-0021'));
    await expect(
      withActorCommand(server.db.app, actor, (c) => c.query(INGEST_READING_SQL, [JSON.stringify(reading), null, null, null])),
    ).rejects.toThrow(new RegExp(`^EBMR-DEV-061 DI-31: the signature of reading ${reading.readingId} does not verify with the gateway key enrolled for its chain$`));
    expect(await stored(reading.readingId)).toBe(0);
  });

  it('[DI-32][DI-30][DI-28] an upload wait "signed" under it without a private key is refused (EBMR-DEV-055), nothing stored', async () => {
    const reading = forged(await nextReading(before.keyId, before.code, 'TEST-BAL-21', 'SIM-0021'));
    const { challengeId } = await issueChallenge(server, actor);
    await expect(
      withActorCommand(server.db.app, actor, (c) => c.query(INGEST_READING_SQL, [JSON.stringify(reading), '0', challengeId, FORGED])),
    ).rejects.toThrow(/^EBMR-DEV-055 DI-28: the signature over the wait of reading /);
    expect(await stored(reading.readingId)).toBe(0);
  });

  it('[DI-32][DI-30] a reading stored under it before 0702 is never used as a weight (EBMR-DEV-110), nothing used', async () => {
    const reading = forged(await nextReading(before.keyId, before.code, 'TEST-BAL-21', 'SIM-0021'));
    await asOwnerWithoutTriggers(async (c) => {
      await c.query(
        `insert into tab.device_reading (id, chain_id, seq, gateway_device_id, gateway_code, instrument_device_id, device_code, serial, value, unit,
                                         stable, status, raw, source_time_us, trust, installation, purpose, prev_hash, hash, signature,
                                         uplink_delay_us, recorded_at, recorded_us, ingest_session_id, correlation_id)
         values ($1, $2, $20, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 0, clock_timestamp(),
                 platform.epoch_micros(clock_timestamp()), gen_random_uuid(), gen_random_uuid())`,
        [reading.readingId, reading.chainId, deviceId(before.code), reading.gatewayCode, deviceId('TEST-BAL-21'), reading.deviceCode, reading.serial,
         reading.value, reading.unit, reading.stable, reading.status, reading.raw, reading.sourceTimeUs, reading.trust, reading.installation,
         reading.purpose, reading.prevHash, reading.hash, reading.signature, reading.seq],
      );
    });
    const operator = await operatorActor(server);
    await expect(
      withActorCommand(server.db.app, operator, (c) =>
        c.query("select tab.claim_readings($1::uuid[], 'DISP-1', 120000000, 'GROSS')", [[reading.readingId]]),
      ),
    ).rejects.toThrow(/^EBMR-DEV-110 /);
    expect((await server.db.admin.query('select 1 from tab.reading_use where reading_id = $1', [reading.readingId])).rowCount).toBe(0);
  });
});

