/**
 * Review finding P48 (module C5; DI-31, DI-32, DI-22, DI-20): the database is the enforcement point for the proof of
 * a scale reading, not the gateway listener. Whoever holds only the application role's credentials can build the
 * gateway's own actor context from iam.session (a SERVER device needs no authentication event) and call
 * tab.ingest_reading directly; before this fix the database stored a junk signature as it came and never compared
 * the raw instrument line with the value, so any value became an "original" DEVICE record attributed to the
 * gateway.
 *
 * The database now proves every row of tab.device_reading itself (sql/0270_devices_readings_guards.sql): its hash
 * is SHA-256 of the canonical text of the row's own columns, its Ed25519 signature verifies under the key enrolled
 * for its chain, and its raw MT-SICS line states exactly its value, unit, stability and status. A claim checks the
 * stored proof again. These tests drive the database directly, with no listener in between.
 */
import { generateKeyPairSync, randomUUID, sign, verify, createPublicKey } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '@ebmr/kernel';
import { asAdmin } from '@ebmr/test-kit';
import {
  READING_FORMAT,
  ed25519PrivateKey,
  formatWeight,
  interpretWeightLine,
  readingHash,
  sealReading,
  signatureMessage,
  type ReadingBody,
  type ScaleReading,
} from '@ebmr/integration-sdk/scale';
import { withActorCommand } from '../../src/platform/db/commands.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { GW, enrol, fakeGateway, gatewayKey, ingestProven, operatorActor, type FakeGateway } from './support.ts';

let server: TestServer;
let gw: FakeGateway;

beforeAll(async () => {
  server = await startServer('SANDBOX');
  await enrol(server);
  gw = await fakeGateway(server); // the real gateway is logged in, so its session is live
}, 180_000);

afterAll(async () => {
  await gw?.close();
  await server?.close();
});

/**
 * What a holder of the application role's credentials alone can build: the live gateway session's actor, in a role
 * its account is granted now that holds INTERFACE.WRITE (the permission of tab.ingest_reading). Everything is read
 * through the application pool; nothing is hard-coded, so the attack follows whatever role the gateway is granted.
 */
async function stolenGatewayActor(): Promise<ActorContext & { deviceId: string }> {
  const { rows } = await server.db.app.query<{ id: string; person_id: string; account_id: string; device_id: string; legal_name: string; role_code: string | null }>(
    `select s.id, s.person_id, s.account_id, s.device_id, p.legal_name,
            (select min(g.role_code) from iam.role_grant g join iam.role_permission rp on rp.role_code = g.role_code
              where g.account_id = s.account_id and g.status = 'APPROVED' and g.revoked_at is null
                and g.valid_from <= clock_timestamp() and (g.valid_to is null or g.valid_to > clock_timestamp())
                and rp.permission_code = 'INTERFACE.WRITE') as role_code
       from iam.session s join iam.device d on d.id = s.device_id join iam.person p on p.id = s.person_id
      where d.code = $1 and s.ended_at is null
      order by s.opened_at desc limit 1`,
    [GW],
  );
  const s = rows[0];
  if (!s) throw new Error('test set-up: no live gateway session');
  if (!s.role_code) throw new Error('test set-up: the gateway account holds no role with INTERFACE.WRITE');
  return {
    personId: s.person_id,
    accountId: s.account_id,
    roleCode: s.role_code,
    sessionId: s.id,
    deviceId: s.device_id,
    source: 'INTEGRATION',
    siteZone: server.config.siteZone,
    legalName: s.legal_name,
    correlationId: randomUUID(),
  };
}

async function head(): Promise<{ seq: string; hash: string }> {
  const { rows } = await server.db.app.query<{ h: { seq: string; hash: string } }>('select tab.chain_head($1) as h', [gw.login.chainId]);
  return rows[0]!.h;
}

/** The next reading body of the chain (at the server's head), with the given value and raw line. */
function body(h: { seq: string; hash: string }, value: string | null, raw: string, overrides: Partial<ReadingBody> = {}): ReadingBody {
  return {
    format: READING_FORMAT,
    readingId: randomUUID(),
    chainId: gw.login.chainId,
    gatewayCode: GW,
    deviceCode: 'TEST-BAL-01',
    serial: 'SIM-0001',
    seq: (BigInt(h.seq) + 1n).toString(),
    value,
    unit: 'kg',
    stable: true,
    status: 'OK',
    raw,
    sourceTimeUs: '1790584618000000',
    trust: 'DEVICE_UNSYNCED',
    installation: 'SANDBOX',
    purpose: 'GROSS',
    prevHash: h.hash,
    ...overrides,
  };
}

const gatewayPrivateKey = () => ed25519PrivateKey(gatewayKey(server).privateKeyPkcs8);

/**
 * tab.ingest_reading called straight through the application pool as the gateway's session (upload wait 0, proven as
 * the gateway proves it: signed over a challenge the database issued to that session; tablets 0330).
 */
function ingestDirect(reading: ScaleReading): Promise<unknown> {
  return stolenGatewayActor().then((actor) => ingestProven(server, actor, reading, '0'));
}

async function stored(id: string): Promise<number> {
  return (await server.db.app.query('select 1 from tab.device_reading where id = $1', [id])).rowCount ?? 0;
}

describe('P48: the database proves the signature and the raw line of every reading it stores', () => {
  it('[DI-22] precondition: with only the application role, the gateway session\'s actor is accepted and a genuinely signed reading ingests directly', async () => {
    // So every refusal below is the reading proof's, not an authority refusal (EBMR-IAM-1xx) of a wrongly built actor.
    const actor = await stolenGatewayActor();
    expect(actor.roleCode).toBe(server.seed.services.find((x) => x.key === 'gateway')?.roleCode);
    const signed = sealReading(body(await head(), '1.250', 'S S      1.250 kg'), gatewayPrivateKey());
    await expect(ingestDirect(signed)).resolves.toMatchObject({ outcome: 'INGESTED', readingId: signed.readingId });
    expect(await stored(signed.readingId)).toBe(1);
  });

  it('[DI-31][DI-22] a reading with a junk signature, sent with only the application role, is refused and not stored; nothing can claim it', async () => {
    const b = body(await head(), '9.999', 'S S      9.999 kg'); // the raw line agrees with the value: only the signature is wrong
    const forged: ScaleReading = { ...b, hash: readingHash(b), signature: 'AAAA' };
    await expect(ingestDirect(forged)).rejects.toThrow(/EBMR-DEV-061/);
    expect(await stored(forged.readingId)).toBe(0);
    const op = await operatorActor(server);
    await expect(
      withActorCommand(server.db.app, op, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [forged.readingId], room: 'DISP-1', maxAgeUs: 120_000_000n, purpose: 'GROSS' })),
    ).rejects.toThrow(/EBMR-DEV-101/);
  });

  it('[DI-31] a well-formed Ed25519 signature by a key that is not the enrolled one is refused', async () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    const signed = sealReading(body(await head(), '1.250', 'S S      1.250 kg'), other);
    await expect(ingestDirect(signed)).rejects.toThrow(/EBMR-DEV-061/);
    expect(await stored(signed.readingId)).toBe(0);
  });

  it('[DI-31] a genuine signature written in non-canonical base64 (same 64 bytes, unused bits of the last character set) is refused', async () => {
    const signed = sealReading(body(await head(), '1.250', 'S S      1.250 kg'), gatewayPrivateKey());
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const last = alphabet.indexOf(signed.signature[85]!);
    const variant = `${signed.signature.slice(0, 85)}${alphabet[last | 0x0f]!}==`;
    // Node decodes both texts to the same bytes, so its check alone would take either; the stored text must be one.
    expect(variant).not.toBe(signed.signature);
    expect(Buffer.from(variant, 'base64').equals(Buffer.from(signed.signature, 'base64'))).toBe(true);
    await expect(ingestDirect({ ...signed, signature: variant })).rejects.toThrow(/EBMR-DEV-061/);
    expect(await stored(signed.readingId)).toBe(0);
    // The canonical text of the same signature is accepted.
    await expect(ingestDirect(signed)).resolves.toMatchObject({ outcome: 'INGESTED' });
  });

  it('[DI-32] a genuinely signed reading whose raw line states another weight than its value is refused and not stored', async () => {
    const signed = sealReading(body(await head(), '9.999', 'S S      1.000 kg'), gatewayPrivateKey());
    await expect(ingestDirect(signed)).rejects.toThrow(/EBMR-DEV-062/);
    expect(await stored(signed.readingId)).toBe(0);
  });

  it.each([
    ['a dynamic line recorded as a stable weight', '2.000', 'S D      2.000 kg', {}],
    ['a stable line recorded as unstable', '2.000', 'S S      2.000 kg', { stable: false, status: 'UNSTABLE' as const }],
    ['an overload line recorded with a weight', '2.000', 'S +', {}],
    ['a tare response recorded as a weight', '2.000', 'T S      2.000 kg', {}],
    ['a garbled line', '2.000', 'S S 2.000kg', {}],
    ['a weight field with a leading zero', '2.000', 'S S     02.000 kg', {}],
    ['an offline reading (no line of a balance says OFFLINE)', null, 'S I', { unit: null, stable: false, status: 'OFFLINE' as const }],
  ])('[DI-32] the raw line must state the reading: %s is refused', async (_label, value, raw, overrides) => {
    const signed = sealReading(body(await head(), value, raw, overrides), gatewayPrivateKey());
    await expect(ingestDirect(signed)).rejects.toThrow(/EBMR-DEV-062/);
    expect(await stored(signed.readingId)).toBe(0);
  });

  it('[DI-32] readings whose raw line states them are accepted: stable, unstable, overload, underload and an error line', async () => {
    const cases: [string | null, string, Partial<ReadingBody>][] = [
      ['1.250', 'S S      1.250 kg', {}],
      ['-0.005', 'S D     -0.005 kg', { stable: false, status: 'UNSTABLE' }],
      [null, 'S +', { unit: null, stable: false, status: 'OVERLOAD' }],
      [null, 'S -', { unit: null, stable: false, status: 'UNDERLOAD' }],
      [null, 'ES', { unit: null, stable: false, status: 'ERROR' }],
    ];
    for (const [value, raw, overrides] of cases) {
      const signed = sealReading(body(await head(), value, raw, overrides), gatewayPrivateKey());
      await expect(ingestDirect(signed)).resolves.toMatchObject({ outcome: 'INGESTED' });
      expect(await stored(signed.readingId)).toBe(1);
    }
  });

  it('[DI-31] even owner-level code cannot store an unproven reading: the check is on the table, not only in the ingest function', async () => {
    const b = body(await head(), '9.999', 'S S      9.999 kg');
    const hash = readingHash(b);
    await expect(
      asAdmin(server.database, (c) =>
        c.query(
          `insert into tab.device_reading (id, chain_id, seq, gateway_device_id, gateway_code, instrument_device_id, device_code, serial, value, unit,
                                           stable, status, raw, source_time_us, trust, installation, purpose, prev_hash, hash, signature,
                                           uplink_delay_us, recorded_us, ingest_session_id, correlation_id)
           select $1, k.id, $2, k.gateway_device_id, k.gateway_code, d.id, d.code, 'SIM-0001', '9.999', 'kg', true, 'OK', 'S S      9.999 kg',
                  1790584618000000, 'DEVICE_UNSYNCED', 'SANDBOX', 'GROSS', $3, $4, 'AAAA', 0, 0, gen_random_uuid(), gen_random_uuid()
             from tab.gateway_key k, iam.device d where k.id = $5 and d.code = 'TEST-BAL-01'`,
          [b.readingId, b.seq, b.prevHash, hash, gw.login.chainId],
        ),
      ),
    ).rejects.toThrow(/EBMR-DEV-061/);
    expect(await stored(b.readingId)).toBe(0);
  });

  it('[DI-31][DI-32] a claim checks the stored proof again: a row that reached the table without it is never used', async () => {
    // Planted with the table's triggers switched off, as only a superuser could (a restore gone wrong, or tampering).
    const b = body(await head(), '9.999', 'S S      1.000 kg');
    await asAdmin(server.database, async (c) => {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query(
        `insert into tab.device_reading (id, chain_id, seq, gateway_device_id, gateway_code, instrument_device_id, device_code, serial, value, unit,
                                         stable, status, raw, source_time_us, trust, installation, purpose, prev_hash, hash, signature,
                                         uplink_delay_us, recorded_at, recorded_us, ingest_session_id, correlation_id)
         select $1, k.id, $2, k.gateway_device_id, k.gateway_code, d.id, d.code, 'SIM-0001', '9.999', 'kg', true, 'OK', 'S S      1.000 kg',
                1790584618000000, 'DEVICE_UNSYNCED', 'SANDBOX', 'GROSS', $3, $4, 'AAAA', 0, clock_timestamp(),
                platform.epoch_micros(clock_timestamp()), gen_random_uuid(), gen_random_uuid()
           from tab.gateway_key k, iam.device d where k.id = $5 and d.code = 'TEST-BAL-01'`,
        [b.readingId, b.seq, b.prevHash, readingHash(b), gw.login.chainId],
      );
      await c.query('commit');
    });
    expect(await stored(b.readingId)).toBe(1);
    const op = await operatorActor(server);
    await expect(
      withActorCommand(server.db.app, op, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [b.readingId], room: 'DISP-1', maxAgeUs: 120_000_000n, purpose: 'GROSS' })),
    ).rejects.toThrow(/EBMR-DEV-110/);
    expect((await server.db.app.query('select 1 from tab.reading_use where reading_id = $1', [b.readingId])).rowCount).toBe(0);
  });

  it('[DI-31] a genuine reading through the listener is still ingested and claimable (the database accepts what the gateway signs)', async () => {
    // The direct calls above moved the chain head: the fake gateway logs in again to take it up.
    await gw.close();
    gw = await fakeGateway(server);
    const r = gw.next({ value: '4.321', raw: formatWeight('S', 'S', '4.321', 'kg') });
    const res = await gw.uplink([{ reading: r }]);
    expect(res.body.refused, JSON.stringify(res.body.refused)).toBeNull();
    const op = await operatorActor(server);
    await expect(
      withActorCommand(server.db.app, op, (c) => server.built.ctx.deviceReadings.claim(c, { readingIds: [r.readingId], room: 'DISP-1', maxAgeUs: 120_000_000n, purpose: 'GROSS' })),
    ).resolves.toMatchObject([{ readingId: r.readingId, value: '4.321', raw: 'S S      4.321 kg' }]);
  });
});

// ---------------------------------------------------------------------------------------------
// The database's own Ed25519 verification and MT-SICS interpretation agree with Node's and the SDK's.

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function nodeVerify(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
  try {
    return verify(null, message, createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' }), signature);
  } catch {
    return false;
  }
}

async function sqlVerify(publicKey: Buffer, message: Buffer, signature: Buffer): Promise<boolean> {
  // The helper is not granted to the application role (only the definers use it), so the owner's view is read.
  return asAdmin(server.database, async (c) => (await c.query<{ ok: boolean }>('select tab.ed25519_verify($1, $2, $3) as ok', [publicKey, message, signature])).rows[0]!.ok);
}

describe('P48: Ed25519 verification in PostgreSQL', () => {
  // RFC 8032 section 7.1, tests 1 to 3 (public key, message, signature).
  const vectors = [
    ['d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '', 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'],
    ['3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72', '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'],
    ['fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025', 'af82', '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'],
  ] as const;

  it('[DI-31] the RFC 8032 test vectors verify, and fail with one bit of the signature, the message or the key changed', async () => {
    for (const [pk, msg, sig] of vectors) {
      const [k, m, s] = [Buffer.from(pk, 'hex'), Buffer.from(msg, 'hex'), Buffer.from(sig, 'hex')];
      expect(nodeVerify(k, m, s)).toBe(true);
      expect(await sqlVerify(k, m, s)).toBe(true);
      const s2 = Buffer.from(s);
      s2[5] = s2[5]! ^ 0x01;
      expect(await sqlVerify(k, m, s2)).toBe(false);
      const s3 = Buffer.from(s);
      s3[40] = s3[40]! ^ 0x80;
      expect(await sqlVerify(k, m, s3)).toBe(false);
      // R with its sign bit (the parity of x) flipped.
      const s4 = Buffer.from(s);
      s4[31] = s4[31]! ^ 0x80;
      expect(nodeVerify(k, m, s4)).toBe(false);
      expect(await sqlVerify(k, m, s4)).toBe(false);
      expect(await sqlVerify(k, Buffer.concat([m, Buffer.from([0])]), s)).toBe(false);
      const k2 = Buffer.from(k);
      k2[0] = k2[0]! ^ 0x02;
      expect(await sqlVerify(k2, m, s)).toBe(nodeVerify(k2, m, s));
    }
  });

  it('[DI-31] a signature whose scalar is not reduced (S + L) is refused, as OpenSSL refuses it', async () => {
    const L = (1n << 252n) + 27742317777372353535851937790883648493n;
    const [pk, msg, sig] = vectors[1];
    const s = Buffer.from(sig, 'hex');
    let scalar = 0n;
    for (let i = 63; i >= 32; i--) scalar = (scalar << 8n) | BigInt(s[i]!);
    let bumped = scalar + L;
    const out = Buffer.from(s);
    for (let i = 32; i < 64; i++) {
      out[i] = Number(bumped & 0xffn);
      bumped >>= 8n;
    }
    const [k, m] = [Buffer.from(pk, 'hex'), Buffer.from(msg, 'hex')];
    expect(nodeVerify(k, m, out)).toBe(false);
    expect(await sqlVerify(k, m, out)).toBe(false);
  });

  it('[DI-31] for random keys, messages and tampering the database gives the same verdict as Node (fast-check)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 160 }), fc.nat(511), fc.constantFrom('none', 'signature', 'message', 'key'), async (bytes, bit, tamper) => {
        const pair = generateKeyPairSync('ed25519');
        const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
        const message = Buffer.from(bytes);
        const signature = sign(null, message, pair.privateKey);
        const [k, m, s] = [Buffer.from(publicKey), Buffer.from(message), Buffer.from(signature)];
        if (tamper === 'signature') s[bit >> 3] = s[bit >> 3]! ^ (1 << (bit & 7));
        if (tamper === 'message') {
          if (m.length === 0) return;
          m[(bit >> 3) % m.length] = m[(bit >> 3) % m.length]! ^ (1 << (bit & 7));
        }
        if (tamper === 'key') k[(bit >> 3) % 32] = k[(bit >> 3) % 32]! ^ (1 << (bit & 7));
        const expected = nodeVerify(k, m, s);
        if (tamper === 'none') expect(expected).toBe(true);
        expect(await sqlVerify(k, m, s)).toBe(expected);
      }),
      { numRuns: 40 },
    );
  });

  it('[DI-31] the signature of a sealed reading verifies in SQL over the same message the SDK signs', async () => {
    const signed = sealReading(body(await head(), '1.250', 'S S      1.250 kg'), gatewayPrivateKey());
    const spki = Buffer.from(gatewayKey(server).publicKeySpki, 'base64');
    expect(await sqlVerify(spki.subarray(12), signatureMessage(signed.hash), Buffer.from(signed.signature, 'base64'))).toBe(true);
  });
});

describe('P48: the raw MT-SICS line read in PostgreSQL', () => {
  const unit = fc.constantFrom('kg', 'g', 'mg', 'lb', 'KG', 'ozt');
  const decimal = fc.oneof(
    fc.constantFrom('0', '0.000', '-0.005', '1.250', '12345.678', '60.000', '00.5', '1.', '.5', '-', '1e3', '01', '-00.1', '1.2.3'),
    fc.tuple(fc.boolean(), fc.nat(99999), fc.option(fc.nat(9999), { nil: null })).map(([neg, int, frac]) => `${neg ? '-' : ''}${int}${frac === null ? '' : `.${frac}`}`),
  );
  const printable = fc.string({ unit: fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)), minLength: 0, maxLength: 40 });
  const line = fc.oneof(
    fc.tuple(fc.constantFrom('S', 'T', 'Z', 's'), fc.constantFrom('S', 'D', 'I', 'A'), fc.integer({ min: 1, max: 12 }), decimal, unit).map(([c, st, pad, v, u]) => `${c} ${st}${' '.repeat(pad)}${v} ${u}`),
    fc.tuple(fc.constantFrom('S', 'T', 'Z', 'I4', 'X'), fc.constantFrom('A', 'I', '+', '-', '?')).map(([c, st]) => `${c} ${st}`),
    fc.constantFrom('I4 A "SIM-0001"', 'I4 A "a b"', 'I4 A ""', 'I4 A', 'ES', 'ET', 'EL', 'EX', 'S S', 'S S      1.250 kg ', ' S S      1.250 kg', 'S S\t1.250 kg'),
    printable,
    fc.string({ minLength: 129, maxLength: 140 }),
  );

  it('[DI-32] the SQL reading of any line equals the SDK interpretWeightLine (null for a line the SDK refuses) (fast-check)', async () => {
    await asAdmin(server.database, (admin) =>
      fc.assert(
        fc.asyncProperty(line, async (raw) => {
          let expected: unknown;
          try {
            expected = interpretWeightLine(raw);
          } catch {
            expected = null;
          }
          const { rows } = await admin.query<{ r: unknown }>('select tab.raw_weight_interpretation($1) as r', [raw]);
          expect(rows[0]?.r ?? null).toEqual(expected);
        }),
        { numRuns: 400 },
      ),
    );
  });
});
