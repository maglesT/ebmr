/**
 * Installation keys, seals, lot-transfer packages and the federation request and answer, rule by rule (SQL mutation
 * group "transfer-and-federation": kernel 1220, 1221, 1230, site services 0980, 0981, recipe-core 1090 to 1093). The
 * scenario tests (transfer/transfer.test.ts) show each working; these take the rules the Phase 6 mutation run found
 * unproven, where a change could let a tampered, misaddressed, replayed or untrusted package or answer through:
 *
 * - Ed25519 in the database (platform.ed25519_verify) against the RFC 8032 test vectors, a malleated S (S + L), a
 *   truncated or extended signature and key, a key that is no point, and two signatures under the neutral point that
 *   only the exact rules tell apart (S = L, and S = 2^252 whose top bit the scalar ladder must not skip);
 * - a seal verifies only for a listed purpose and in canonical base64 (platform.seal_valid);
 * - a package the trusted origin did seal is still refused when it is not a lot-transfer package, is addressed to
 *   another site, or states anything but a released intermediate lot with its number, quantity, expiry and hold;
 * - the received lot keeps its retest instant, and the hold limit is the earliest of the carried hold, retest and expiry;
 * - a revoked peer is trusted no more (and no other peer is affected), a peer approval is recorded by its signer, and a
 *   second key for a trusted installation is refused;
 * - the origin packages only an unexpired lot, up to what is left, with a well-formed request and a future stated hold;
 * - the federation endpoint refuses a malformed request or query with ok = false and answers only about a sealed package
 *   it exchanged with the asker; the asking site keeps only an answer to exactly its request.
 *
 * Seals are made with the test's private keys exactly as each server makes them (world.ts, D-P6i-0-8).
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signerActor, signFor } from '../helpers.ts';
import { Installation, rawPublicKey, refusal, sealOf, TAG, unique } from '../transfer/world.ts';

let pune: Installation;
let goa: Installation;
let lot: { id: string; code: string };
let first: { packageId: string; packageNo: string; payload: string; seal: string };

type Json = Record<string, unknown>;
const nowUs = (): string => String(BigInt(Date.now()) * 1000n);

beforeAll(async () => {
  [pune, goa] = await Promise.all([Installation.create(`PUNE-${TAG}`), Installation.create(`GOA-${TAG}`)]);
  await Promise.all([pune.trust(goa), goa.trust(pune)]);
  lot = await pune.releasedIntermediate('500');
  first = await pune.ship(lot.id, goa, '100');
}, 300_000);
afterAll(async () => {
  await Promise.all([pune?.drop(), goa?.drop()]);
});

describe('Ed25519 and seals in the database (kernel 1220, 1230)', () => {
  const L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;
  const Q = 57896044618658097711785492504343953926634992332820282019728792003956564819949n;
  const le32 = (n: bigint): string => {
    let h = '';
    for (let i = 0; i < 32; i++) h += Number((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0');
    return h;
  };
  const verify = async (key: string | null, message: string | null, signature: string | null): Promise<boolean | null> =>
    pune.scalar<boolean | null>("select platform.ed25519_verify(decode($1, 'hex'), decode($2, 'hex'), decode($3, 'hex')) as v", [key, message, signature]);
  // RFC 8032 section 7.1, tests 1 to 3 (public key, message, signature).
  const rfc: Array<[string, string, string]> = [
    ['d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '',
     'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'],
    ['3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72',
     '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'],
    ['fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025', 'af82',
     '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'],
  ];

  it('[DI-31] the RFC 8032 vectors verify; a malleated, truncated or extended signature, a wrong key length and a key that is no point do not', async () => {
    for (const [key, message, signature] of rfc) {
      expect(await verify(key, message, signature)).toBe(true);
      // The same signature with S + L: the same point, refused (S below L, RFC 8032 section 5.1.7).
      const s = BigInt(`0x${Buffer.from(signature.slice(64), 'hex').reverse().toString('hex')}`);
      expect(await verify(key, message, signature.slice(0, 64) + le32(s + L))).toBe(false);
      // One byte more or less on the signature or the key, and a NULL in each place.
      expect(await verify(key, message, `${signature}00`)).toBe(false);
      expect(await verify(key, message, signature.slice(0, 126))).toBe(false);
      expect(await verify(`${key}00`, message, signature)).toBe(false);
      expect(await verify(key.slice(0, 62), message, signature)).toBe(false);
      expect(await verify(null, message, signature)).toBe(false);
      expect(await verify(key, null, signature)).toBe(false);
      expect(await verify(key, message, null)).toBe(false);
    }
    // A 32-byte key that decodes to no point of the curve.
    const noPoint = await pune.scalar<string>(
      "select h as v from (select lpad(to_hex(y), 2, '0') || repeat('00', 31) as h from generate_series(2, 60) y) c where platform.ed25519_decode(decode(h, 'hex')) is null limit 1");
    expect(noPoint).toMatch(/^[0-9a-f]{64}$/);
    expect(await verify(noPoint, rfc[0]![1], rfc[0]![2])).toBe(false);
  });

  it('[DI-31] under the neutral point S = L is refused and S = 2^252 needs every bit of the scalar ladder', async () => {
    // The neutral point (0, 1) as a key: [k]A is the neutral point whatever k is, so the result is [S]B alone.
    const neutral = `01${'00'.repeat(31)}`;
    // S = L: [L]B is the neutral point, whose encoding is R = 1; only "S below L" refuses it.
    expect(await verify(neutral, '00', neutral + le32(L))).toBe(false);
    // S = 2^252 (below L, its highest bit at position 252): R is the encoding of [2^252]B, computed by doubling B.
    const p = await pune.scalar<string[]>(
      `with recursive d(i, p) as (
         select 0, array[15112221349535400772501151409588531511454012693041857206046113283949847762202,
                         46316835694926478169428394003475163141307993866256225615783033603165251855960, 1,
                         46827403850823179245072216630277197565144205554125654976674165829533817101731]::numeric[]
         union all select i + 1, platform.ed25519_double(p) from d where i < 252)
       select array[(p[1])::text, (p[2])::text, (p[3])::text] as v from d where i = 252`);
    const [x, y, z] = p.map((n) => BigInt(n));
    const pow = (b: bigint, e: bigint): bigint => {
      let r = 1n;
      let a = ((b % Q) + Q) % Q;
      for (let k = e; k > 0n; k >>= 1n) {
        if (k & 1n) r = (r * a) % Q;
        a = (a * a) % Q;
      }
      return r;
    };
    const zi = pow(z!, Q - 2n);
    const R = le32(((y! * zi) % Q) + (((x! * zi) % Q) & 1n) * (1n << 255n));
    for (const message of ['00', '01', '02']) {
      expect(await verify(neutral, message, R + le32(1n << 252n))).toBe(true);
    }
    // With no message there is no k: refused, even though R is [S]B (which is all a NULL k would leave to check).
    expect(await verify(neutral, null, R + le32(1n << 252n))).toBe(false);
  });

  it('[DI-31] a seal verifies only for a listed purpose and in canonical base64 (platform.seal_valid)', async () => {
    const payload = '{"a":1}';
    const valid = (purpose: string, seal: string) =>
      pune.scalar<boolean>("select platform.seal_valid(decode($1, 'base64'), $2, $3, $4) as v", [pune.publicKey, purpose, payload, seal]);
    const seal = sealOf(pune.key, 'transfer-package', payload);
    expect(await valid('transfer-package', seal)).toBe(true);
    // Signed by the key for another purpose than the three: refused even though the signature is good.
    const other = sealOf(pune.key, 'other' as 'transfer-package', payload);
    expect(await valid('other', other)).toBe(false);
    // The same 64 bytes in non-canonical base64 (the unused low bits of the last character set): refused.
    const last = seal.charAt(85);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const nonCanonical = seal.slice(0, 85) + alphabet.charAt(alphabet.indexOf(last) + 1) + '==';
    expect(Buffer.from(nonCanonical, 'base64').equals(Buffer.from(seal, 'base64'))).toBe(true);
    expect(await valid('transfer-package', nonCanonical)).toBe(false);
  });
});

describe('the inbound package (site services 0981)', () => {
  const reseal = (over: (m: Json) => void): { payload: string; seal: string } => {
    const m = JSON.parse(first.payload) as Json;
    over(m);
    const payload = JSON.stringify(m);
    return { payload, seal: sealOf(pune.key, 'transfer-package', payload) };
  };
  const lotOf = (m: Json): Json => m['lot'] as Json;

  it('[DI-31] [DI-39] a package its trusted origin sealed is still refused when malformed, addressed to another site or not a released intermediate', async () => {
    const cases: Array<[string, (m: Json) => void, string]> = [
      ['format', (m) => { m['format'] = 'ebmr.lot-transfer.v2'; }, 'MALFORMED'],
      ['origin code', (m) => { m['origin'] = { ...(m['origin'] as Json), installation: pune.code.toLowerCase() }; }, 'MALFORMED'],
      ['package id', (m) => { m['packageId'] = 'not-a-uuid'; }, 'MALFORMED'],
      ['destination site', (m) => { m['destination'] = { ...(m['destination'] as Json), site: 'SITE-9' }; }, 'WRONG_DESTINATION'],
      ['lot not an object', (m) => { m['lot'] = 'lot'; }, 'MALFORMED'],
      ['material kind', (m) => { lotOf(m)['materialKind'] = 'RAW_MATERIAL'; }, 'MALFORMED'],
      ['lot code', (m) => { lotOf(m)['lotCode'] = 'bad code'; }, 'MALFORMED'],
      ['material code', (m) => { lotOf(m)['materialCode'] = 'bad code'; }, 'MALFORMED'],
      ['material name', (m) => { lotOf(m)['materialName'] = '   '; }, 'MALFORMED'],
      ['unit', (m) => { lotOf(m)['unit'] = ''; }, 'MALFORMED'],
      ['quantity zero', (m) => { lotOf(m)['quantity'] = '0'; }, 'MALFORMED'],
      ['quantity exponent', (m) => { lotOf(m)['quantity'] = '1e2'; }, 'MALFORMED'],
      ['expiry', (m) => { lotOf(m)['expiresAtUs'] = 'soon'; }, 'MALFORMED'],
      ['retest', (m) => { lotOf(m)['retestAtUs'] = 'soon'; }, 'MALFORMED'],
      ['lot id', (m) => { lotOf(m)['id'] = 'lot-1'; }, 'MALFORMED'],
      ['status not an object', (m) => { m['status'] = 'RELEASED'; }, 'MALFORMED'],
      ['status quarantine', (m) => { m['status'] = { ...(m['status'] as Json), state: 'QUARANTINE' }; }, 'MALFORMED'],
      ['status rejected', (m) => { m['status'] = { ...(m['status'] as Json), state: 'REJECTED' }; }, 'MALFORMED'],
      ['hold', (m) => { m['hold'] = { basis: 'STATED' }; }, 'MALFORMED'],
      ['markets', (m) => { m['markets'] = 'IN'; }, 'MALFORMED'],
      ['package number', (m) => { m['packageNo'] = 'bad no'; }, 'MALFORMED'],
    ];
    for (const [name, over, kind] of cases) {
      const p = reseal(over);
      const r = await goa.receive(p.payload, p.seal);
      expect({ name, outcome: r.outcome, kind: r.kind }).toEqual({ name, outcome: 'REFUSED', kind });
    }
    expect(await goa.scalar('select count(*)::int as v from site.transfer_receipt')).toBe(0);
  });

  it('[PR-18] the received lot keeps its retest instant; the hold limit is the earliest of the carried hold, retest and expiry', async () => {
    const m = JSON.parse(first.payload) as Json;
    const retest = lotOf(m)['retestAtUs'] as string;
    const expiry = lotOf(m)['expiresAtUs'] as string;
    expect(BigInt(retest) < BigInt(expiry)).toBe(true);
    // The origin claims a hold up to the expiry: the receiving site still holds to the earlier retest.
    const late = reseal((x) => { x['packageId'] = randomUUID(); x['packageNo'] = unique('PK-'); x['hold'] = { untilUs: expiry, basis: 'EXPIRY' }; });
    const r = await goa.receive(late.payload, late.seal);
    expect(r.outcome).toBe('RECEIVED');
    expect(await goa.scalar<string>(
      "select platform.timestamptz_to_epoch_us(l.retest_at)::text || '/' || platform.timestamptz_to_epoch_us(t.hold_until)::text as v from site.material_lot l join site.transfer_receipt t on t.lot_id = l.id where t.id = $1",
      [r.receiptId])).toBe(`${retest}/${retest}`);
    // What local QA signs names this receipt's own lot and its own re-resolved rules.
    const content = await goa.scalar<{ lot_code: string; rules: unknown[] }>("select esig.provide('transfer_receipt', $1::text) -> 'content' as v", [r.receiptId]);
    expect(content.lot_code).toBe(r.lotCode);
    expect(content.rules.length).toBe(await goa.scalar<number>('select count(*)::int as v from site.transfer_rule_resolution where receipt_id = $1', [r.receiptId]));
    expect(content.rules.length).toBeGreaterThan(0);
    // A retest stated after the expiry is the expiry.
    const after = reseal((x) => { x['packageId'] = randomUUID(); x['packageNo'] = unique('PK-'); lotOf(x)['retestAtUs'] = String(BigInt(expiry) + 1_000_000n); });
    const r2 = await goa.receive(after.payload, after.seal);
    expect(await goa.scalar<string>('select platform.timestamptz_to_epoch_us(retest_at)::text as v from site.material_lot where id = $1', [r2.lotId])).toBe(expiry);
  });
});

describe('trust in a peer installation (kernel 1220)', () => {
  const keyPair = () => {
    const pair = generateKeyPairSync('ed25519');
    return { key: pair.privateKey, publicKey: rawPublicKey(pair.publicKey) };
  };
  const revoke = (id: string, reason: string) => goa.run(goa.qa, 'select platform.revoke_peer_installation($1, $2)::text as r', [id, reason]);

  it('[DI-31] a revoked peer is trusted no more and no other peer is affected; a revocation needs an approved peer and its reason', async () => {
    const nasik = { code: `NASIK-${TAG}`, ...keyPair() };
    const proposed = await goa.propose(`SURAT-${TAG}`, keyPair().publicKey);
    expect(await refusal(revoke(proposed, 'never approved, so never trusted'))).toMatch(/EBMR-XFR-006/);
    const id = await goa.trust({ code: nasik.code, publicKey: nasik.publicKey } as Installation);
    expect(await refusal(revoke(id, 'too short'))).toMatch(/EBMR-XFR-009/);
    await revoke(id, 'key leaked');
    expect(await refusal(revoke(id, 'revoked a second time'))).toMatch(/EBMR-XFR-006/);
    expect(await goa.scalar<string>('select platform.peer_installation_state($1) as v', [id])).toBe('REVOKED');
    expect(await goa.scalar<string | null>('select (platform.trusted_peer($1)).id::text as v', [nasik.code])).toBeNull();
    // PUNE, approved and never revoked, stays trusted.
    expect(await goa.scalar<string>("select platform.peer_installation_state(id) || '/' || ((platform.trusted_peer($1)).id = id)::text as v from platform.peer_installation where installation_code = $1", [pune.code]))
      .toBe('APPROVED/true');
    // A package sealed by the revoked key is refused as from an unknown peer.
    const foreign = JSON.stringify({ ...(JSON.parse(first.payload) as Json), packageId: randomUUID(), origin: { installation: nasik.code, site: 'SITE-1', edition: 'TABLETS' } });
    expect(await goa.receive(foreign, sealOf(nasik.key, 'transfer-package', foreign))).toMatchObject({ outcome: 'REFUSED', kind: 'UNKNOWN_PEER' });
  });

  it('[DI-31] a peer approval is recorded by the person who signed it, and a second key for a trusted installation is refused', async () => {
    const id = await goa.propose(`DAMAN-${TAG}`, keyPair().publicKey);
    const sig = await signFor(goa.db, goa.ap, { type: 'peer_installation', id }, 'PEER_INSTALLATION_APPROVED', 'PROPOSED');
    expect(await refusal(goa.run(goa.qa, 'select platform.approve_peer_installation($1, $2)::text as r', [id, sig]))).toMatch(/EBMR-XFR-008 .* signed/);
    const second = await goa.propose(pune.code, keyPair().publicKey);
    expect(await refusal(goa.approvePeer(second))).toMatch(/EBMR-XFR-007/);
  });

  it('[DI-31] the installation identity never changes its code, site or edition, and a peer is proposed in full and never as this installation', async () => {
    const setIdentity = (code: unknown, site: unknown, edition: unknown, key: unknown) =>
      goa.run<number>(goa.admin, 'select platform.set_installation_identity($1, $2, $3, $4) as r', [code, site, edition, key]);
    const version = await goa.scalar<number>('select (platform.current_installation()).version as v');
    for (const [code, site, edition] of [[`goa-${TAG}`, 'SITE-1', 'TABLETS'], [goa.code, 'site 1', 'TABLETS'], [goa.code, 'SITE-1', 'CAPSULES'], [goa.code, 'SITE-1', null]]) {
      expect(await refusal(setIdentity(code, site, edition, goa.publicKey))).toMatch(/EBMR-XFR-001/);
    }
    expect(await refusal(setIdentity(goa.code, 'SITE-1', 'TABLETS', 'not a key'))).toMatch(/EBMR-XFR-002/);
    for (const [code, site, edition] of [[`OTHER-${TAG}`, 'SITE-1', 'TABLETS'], [goa.code, 'SITE-2', 'TABLETS'], [goa.code, 'SITE-1', 'INJECTABLES']]) {
      expect(await refusal(setIdentity(code, site, edition, keyPair().publicKey))).toMatch(/EBMR-XFR-003/);
    }
    // The same key again changes nothing.
    expect(await setIdentity(goa.code, 'SITE-1', 'TABLETS', goa.publicKey)).toBe(version);
    expect(await goa.scalar<number>('select (platform.current_installation()).version as v')).toBe(version);
    // A new key is a new version (key rotation); the original key back is the next one.
    expect(await setIdentity(goa.code, 'SITE-1', 'TABLETS', keyPair().publicKey)).toBe(version + 1);
    expect(await setIdentity(goa.code, 'SITE-1', 'TABLETS', goa.publicKey)).toBe(version + 2);

    const propose = (over: Json) => goa.run<string>(goa.admin, 'select platform.propose_peer_installation($1::jsonb) as r', [JSON.stringify({
      installationCode: unique('PEER-'), siteCode: 'SITE-1', edition: 'TABLETS', baseUrl: 'https://peer.example', publicKey: keyPair().publicKey, ...over })]);
    for (const over of [{ installationCode: 'peer' }, { siteCode: 'site 1' }, { edition: 'CAPSULES' }, { baseUrl: 'ftp://peer.example' },
                        { baseUrl: `https://${'a'.repeat(191)}.e` }]) {
      expect(await refusal(propose(over))).toMatch(/EBMR-XFR-004/);
    }
    expect(await propose({ baseUrl: `https://${'a'.repeat(190)}.e` })).toMatch(/^[0-9a-f-]{36}$/);
    expect(await refusal(propose({ installationCode: goa.code }))).toMatch(/EBMR-XFR-005/);
    expect(await refusal(propose({ publicKey: goa.publicKey }))).toMatch(/EBMR-XFR-005/);
  });
});

describe('the outbound package (site services 0980)', () => {
  const prepare = (lotId: string, request: unknown) =>
    pune.run<{ payload: string }>(pune.stores, 'select site.prepare_transfer_package($1, $2::jsonb) as r', [lotId, JSON.stringify(request)]);

  it('[DI-39] [INV-13] [PR-18] the origin packages an unexpired lot, up to what is left, on a well-formed request with a future stated hold', async () => {
    const bad: unknown[] = [null, { destination: 'goa', quantity: '1' }, { destination: goa.code, quantity: 1 }, { destination: goa.code, quantity: '1e1' },
                            { destination: goa.code, quantity: '0' }, { destination: goa.code, quantity: '1', markets: 'IN' },
                            { destination: goa.code, quantity: '1', holdUntil: '2030-01-01' }];
    for (const request of bad) {
      expect(await refusal(prepare(lot.id, request))).toMatch(/EBMR-XFR-011/);
    }
    expect(await refusal(prepare(lot.id, { destination: goa.code, quantity: '1', holdUntil: '2020-01-01T00:00:00Z' }))).toMatch(/EBMR-XFR-016/);
    // Exactly what is left may be packaged.
    const small = await pune.releasedIntermediate('50');
    expect(JSON.parse((await prepare(small.id, { destination: goa.code, quantity: '50' })).payload)).toMatchObject({ lot: { quantity: '50' } });
    // Without a retest instant the hold limit is the expiry.
    const noRetest = await pune.releasedIntermediate('50');
    await pune.fixture('update site.material_lot set retest_at = null where id = $1', [noRetest.id]);
    const p = JSON.parse((await prepare(noRetest.id, { destination: goa.code, quantity: '1' })).payload) as { hold: Json; lot: Json };
    expect(p.hold).toEqual({ basis: 'EXPIRY', untilUs: p.lot['expiresAtUs'] });
    // Past its expiry, or past its retest instant while its expiry is ahead: not packaged.
    const expired = await pune.releasedIntermediate('50');
    await pune.fixture("update site.material_lot set retest_at = null, expires_at = now() - interval '1 hour' where id = $1", [expired.id]);
    expect(await refusal(prepare(expired.id, { destination: goa.code, quantity: '1' }))).toMatch(/EBMR-XFR-014/);
    const retestDue = await pune.releasedIntermediate('50');
    await pune.fixture("update site.material_lot set retest_at = now() - interval '1 hour' where id = $1", [retestDue.id]);
    expect(await refusal(prepare(retestDue.id, { destination: goa.code, quantity: '1' }))).toMatch(/EBMR-XFR-014/);
  });
});

describe('the federation request and answer (kernel 1220, recipe-core 1093)', () => {
  const request = (over: Json = {}, query: Json = {}): string => JSON.stringify({
    format: 'ebmr.federation-request.v1', nonce: randomUUID(), from: pune.code, to: goa.code, issuedAtUs: nowUs(),
    query: { transferId: first.packageId, direction: 'FORWARD', asOfUs: nowUs(), ...query }, ...over });
  const answer = (r: string) => goa.answer(r, sealOf(pune.key, 'federation-request', r));

  it('[DI-31] a malformed request or query is refused with ok = false; only a sealed package exchanged with the asker is answered about', async () => {
    // GOA received PUNE's package (the transfer the queries name).
    expect(await goa.receive(first.payload, first.seal)).toMatchObject({ outcome: 'RECEIVED' });
    for (const r of [request({ format: 'ebmr.federation-request.v2' }), request({ nonce: undefined }), request({ issuedAtUs: 'now' }), request({ query: 'trace' })]) {
      const a = await answer(r);
      expect({ ok: a.ok, reason: a.reason }).toEqual({ ok: false, reason: expect.stringMatching(/^EBMR-FED-002/) as unknown });
    }
    for (const q of [{ transferId: 'transfer-1' }, { direction: 'SIDEWAYS' }, { asOfUs: 'now' }]) {
      const r = request({}, q);
      const a = await answer(r);
      expect({ ok: a.ok, reason: a.reason }).toEqual({ ok: false, reason: expect.stringMatching(/^EBMR-FED-010/) as unknown });
      // The refusal is logged against this request's own nonce.
      expect(await goa.scalar<number>("select count(*)::int as v from platform.federation_request where nonce = $1 and outcome = 'REFUSED' and reason like 'EBMR-FED-010%'",
        [(JSON.parse(r) as Json)['nonce']])).toBe(1);
    }
    // A package GOA prepared for PUNE but never sealed is not exchanged (GOA has sealed another package, to PUNE).
    const own = await goa.releasedIntermediate('50');
    await goa.ship(own.id, pune, '5');
    const unsealed = await goa.run<{ packageId: string }>(goa.stores, 'select site.prepare_transfer_package($1, $2::jsonb) as r', [own.id, JSON.stringify({ destination: pune.code, quantity: '5' })]);
    const a = await answer(request({}, { transferId: unsealed.packageId }));
    expect({ ok: a.ok, reason: a.reason }).toEqual({ ok: false, reason: expect.stringMatching(/^EBMR-FED-011/) as unknown });
    // An unknown asker: ok = false.
    const stranger = await goa.answer(request({ from: `NASIK-${TAG}` }), 'x');
    expect(stranger.ok).toBe(false);
  });

  it('[DI-31] the asking site keeps only an answer that answers exactly its request', async () => {
    const issued = await pune.issue(goa, first.packageId, 'FORWARD');
    const good = await goa.answer(issued.request, sealOf(pune.key, 'federation-request', issued.request)) as { ok: boolean; payload: string };
    expect(good.ok).toBe(true);
    const variant = (over: (m: Json) => void): string => {
      const m = JSON.parse(good.payload) as Json;
      over(m);
      return JSON.stringify(m);
    };
    const cases: Array<[string, (m: Json) => void, RegExp]> = [
      ['format', (m) => { m['format'] = 'ebmr.genealogy-excerpt.v2'; }, /^EBMR-FED-018/],
      ['rows', (m) => { m['rows'] = {}; }, /^EBMR-FED-018/],
      ['nodes', (m) => { m['nodes'] = {}; }, /^EBMR-FED-018/],
      ['from', (m) => { m['from'] = `NASIK-${TAG}`; }, /^EBMR-FED-019/],
      ['to', (m) => { m['to'] = `NASIK-${TAG}`; }, /^EBMR-FED-019/],
      ['nonce', (m) => { m['requestNonce'] = randomUUID(); }, /^EBMR-FED-019/],
      ['transfer', (m) => { m['query'] = { ...(m['query'] as Json), transferId: randomUUID() }; }, /^EBMR-FED-019/],
      ['direction', (m) => { m['query'] = { ...(m['query'] as Json), direction: 'BACKWARD' }; }, /^EBMR-FED-019/],
      ['as-of', (m) => { m['asOfUs'] = String(BigInt(m['asOfUs'] as string) - 1n); }, /^EBMR-FED-019/],
    ];
    for (const [name, over, reason] of cases) {
      const payload = variant(over);
      const r = await pune.recordExcerpt(issued.nonce, payload, sealOf(goa.key, 'federation-answer', payload));
      expect({ name, ok: r.ok, reason: r.reason }).toEqual({ name, ok: false, reason: expect.stringMatching(reason) as unknown });
    }
    expect((await pune.recordExcerpt(issued.nonce, good.payload, sealOf(goa.key, 'federation-answer', good.payload))).ok).toBe(true);
    expect(await pune.scalar<number>('select count(*)::int as v from recipe.federated_excerpt where nonce = $1', [issued.nonce])).toBe(1);
  });
});

describe('acts with no other test in the group (kernel 1220, 1221, site services 0980, recipe-core 1091)', () => {
  it('[DI-18] [DI-31] an installation alarm is acknowledged once, with a note, by a person who holds ALARM.ACKNOWLEDGE and never by an administrator', async () => {
    const alarm = await goa.scalar<string>('select id::text as v from platform.installation_alarm order by raised_at limit 1');
    expect(alarm).toMatch(/^[0-9a-f-]{36}$/);
    const ack = (who: typeof goa.admin, id: string, note: string | null) =>
      goa.run(who, 'select platform.acknowledge_installation_alarm($1, $2)::text as r', [id, note]);
    const operator = goa.cast.operator;
    expect(await refusal(ack(goa.admin, alarm, 'seen by the administrator'))).toMatch(/EBMR-IAM-04[02]/);
    expect(await refusal(ack(operator, randomUUID(), 'no such alarm'))).toMatch(/EBMR-FED-009 there is no installation alarm/);
    expect(await refusal(ack(operator, alarm, '   '))).toMatch(/EBMR-FED-009 .* note/);
    expect(await refusal(ack(operator, alarm, 'x'.repeat(1001)))).toMatch(/EBMR-FED-009 .* note/);
    await ack(operator, alarm, 'origin informed; the package is resent');
    expect(await goa.scalar<string>("select note || '/' || (acknowledged_by = $2::uuid)::text as v from platform.installation_alarm_ack where alarm_id = $1", [alarm, operator.personId]))
      .toBe('origin informed; the package is resent/true');
    expect(await refusal(ack(operator, alarm, 'a second time'))).toMatch(/EBMR-FED-009 .* acknowledged already/);
  });

  it('[DI-31] a package is sealed by the person who prepared it, and only a package that exists is sealed', async () => {
    const other = await signerActor(pune.db, 'WAREHOUSE_LABELLING');
    const p = await pune.run<{ packageId: string; payload: string }>(pune.stores, 'select site.prepare_transfer_package($1, $2::jsonb) as r', [lot.id, JSON.stringify({ destination: goa.code, quantity: '1' })]);
    const seal = sealOf(pune.key, 'transfer-package', p.payload);
    expect(await refusal(pune.run(other, 'select site.seal_transfer_package($1, $2)::text as r', [p.packageId, seal]))).toMatch(/EBMR-XFR-017 .* prepared it/);
    expect(await refusal(pune.run(pune.stores, 'select site.seal_transfer_package($1, $2)::text as r', [randomUUID(), seal]))).toMatch(/EBMR-XFR-017 there is no transfer package/);
    await pune.run(pune.stores, 'select site.seal_transfer_package($1, $2)::text as r', [p.packageId, seal]);
  });

  it('[IN-29] a mock recall records for a transfer only the destination\'s forward excerpt of that transfer, with a known status', async () => {
    const second = await pune.ship(lot.id, goa, '5');
    expect(await goa.receive(second.payload, second.seal)).toMatchObject({ outcome: 'RECEIVED' });
    const ofSecond = await pune.ask(goa, second.packageId, 'FORWARD');
    const backward = await pune.ask(goa, first.packageId, 'BACKWARD');
    expect([ofSecond.ok, backward.ok]).toEqual([true, true]);
    const id = await pune.run<string>(pune.qa, "select recipe.run_mock_recall('LOT', $1, null, false, null) as r", [lot.id]);
    const record = (transfer: string, status: string, excerpt: string | null) =>
      pune.run(pune.qa, 'select recipe.record_mock_recall_remote($1, $2, $3, $4, null)::text as r', [id, transfer, status, excerpt]);
    expect(await refusal(record(randomUUID(), 'UNREACHABLE', null))).toMatch(/EBMR-RCL-021/);
    expect(await refusal(record(first.packageId, 'LOST', null))).toMatch(/EBMR-RCL-022/);
    for (const excerpt of [ofSecond.excerptId!, backward.excerptId!, randomUUID()]) {
      expect(await refusal(record(first.packageId, 'UNREACHABLE', excerpt))).toMatch(/EBMR-RCL-023/);
    }
    await record(first.packageId, 'UNREACHABLE', null);
  });
});
