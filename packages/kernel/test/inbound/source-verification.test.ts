/**
 * The edition-neutral marker of a signed inbound source (Phase 7 slice 7a, 6jc-R9; kernel 1305; DI-31, DI-20):
 * platform.accept_inbound_detail, which every receiving command calls before it writes, takes an envelope of a source
 * listed in platform.signing_source (OPCUA) only with a verification recorded in the same transaction by an
 * owner-level edition verifier, and uses that verification up. The application role can neither record one nor write
 * the verification table. The Tablets verifier itself (the gateway's signature) is proven in
 * apps/tablets-server/test/equipment-data/feed-signature.test.ts; here a TEST-ONLY verifier stands in for it.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { expectPermissionDenied, expectRefused } from '../identity/helpers.ts';
import { count, ctxOf, ensureTestVerifier, envelopeFor, inboundReason, registerAdapter, type TestAdapter } from '../integrations/support.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let db: TestDatabase;
let opcua: TestAdapter;
let ems: TestAdapter;

beforeAll(async () => {
  db = await createTestDatabase();
  opcua = await registerAdapter(db, 'OPCUA');
  ems = await registerAdapter(db, 'EMS');
  await ensureTestVerifier(db);
}, 120_000);
afterAll(async () => {
  await db.drop();
});

const event = (n: number) => ({ equipmentCode: 'PRESS-01', eventId: `e-${randomBytes(4).toString('hex')}-${n.toString()}`, kind: 'FAULT', state: null, recipeVersion: null, message: 'fault', occurredAt: '1760000000000000' });
const chunk = () => ({ tag: 't', samples: [] });

/** accept_inbound_detail for each envelope in turn in ONE command of adapter `a`; `mark`: the envelopes to verify first. */
function acceptAll(a: TestAdapter, envs: Record<string, unknown>[], mark: Record<string, unknown>[] = [], peer?: string) {
  return withCommand(db.app, ctxOf(a.actor, inboundReason(envs[0])), async (c) => {
    for (const m of mark) await c.query('select ebmr_test_only.mark_source_verified($1::jsonb)', [JSON.stringify(m)]);
    if (peer !== undefined) await c.query("select set_config('ebmr.transport_peer', $1, true)", [peer]);
    const out: Record<string, unknown>[] = [];
    for (const e of envs) out.push((await c.query<{ r: Record<string, unknown> }>('select platform.accept_inbound_detail($1::jsonb) as r', [JSON.stringify(e)])).rows[0]!.r);
    return out;
  });
}
const messagesOf = (a: TestAdapter) => count(db, 'select count(*) as n from platform.inbound_message where adapter_code = $1', [a.code]);

describe('the signing-source marker (kernel 1305)', () => {
  it('[DI-31] an OPCUA envelope that reaches the receiving half without its verification is refused (EBMR-INT-030) and leaves nothing', async () => {
    const before = await messagesOf(opcua);
    await expectRefused(acceptAll(opcua, [envelopeFor(opcua, 'opcua.equipment_event', event(1))]), 'EBMR-INT-030');
    // accept_inbound, the uuid form, goes through the same check.
    const e = envelopeFor(opcua, 'opcua.equipment_event', event(2));
    await expectRefused(withCommand(db.app, ctxOf(opcua.actor), (c) => c.query('select platform.accept_inbound($1::jsonb)', [JSON.stringify(e)])), 'EBMR-INT-030');
    expect(await messagesOf(opcua)).toBe(before);
    expect(await count(db, 'select count(*) as n from platform.source_verification')).toBe(0);
  });

  it('[DI-31] a verification names one envelope and is used up by it: another envelope, or the same one again in the transaction, is refused', async () => {
    const a = envelopeFor(opcua, 'opcua.equipment_event', event(3));
    const b = envelopeFor(opcua, 'opcua.equipment_event', event(4));
    await expectRefused(acceptAll(opcua, [b], [a]), 'EBMR-INT-030');
    // The same envelope with another sequence number is another envelope.
    await expectRefused(acceptAll(opcua, [{ ...a, sequenceNo: '999999' }], [a]), 'EBMR-INT-030');
    await expectRefused(acceptAll(opcua, [a, a], [a]), 'EBMR-INT-030');
    const [r] = await acceptAll(opcua, [a], [a]);
    expect(r).toMatchObject({ outcome: 'ACCEPTED' });
    const { rows } = await db.admin.query<{ v: string | null }>('select source_verification as v from platform.inbound_message where adapter_code = $1 and idempotency_key = $2', [opcua.code, a['idempotencyKey']]);
    expect(rows[0]?.v).toMatch(/^TEST-ONLY /);
    // Nothing of a verification outlives its transaction.
    expect(await count(db, 'select count(*) as n from platform.source_verification')).toBe(0);
  });

  it('[DI-31] the application role can neither record a verification nor write the verification table or the source list', async () => {
    const key = 'a'.repeat(64);
    await expectPermissionDenied(withCommand(db.app, ctxOf(opcua.actor), (c) => c.query("select platform.record_source_verification($1, 'forged')", [key])));
    await expectPermissionDenied(withCommand(db.app, ctxOf(opcua.actor), (c) => c.query("insert into platform.source_verification (envelope_key, verifier) values ($1, 'forged')", [key])));
    await expectPermissionDenied(withCommand(db.app, ctxOf(opcua.actor), (c) => c.query("delete from platform.signing_source where source_system = 'OPCUA'")));
    // The list is insert-only even for the owner: OPCUA stays a signing source.
    await expect(db.admin.query("delete from platform.signing_source where source_system = 'OPCUA'")).rejects.toThrow();
    expect((await db.app.query<{ r: boolean }>("select platform.source_requires_signature('OPCUA') as r")).rows[0]?.r).toBe(true);
    expect((await db.app.query<{ r: boolean }>("select platform.source_requires_signature('EMS') as r")).rows[0]?.r).toBe(false);
  });

  it('[DI-31] a verification names its envelope by a lowercase SHA-256 key and names its verifier, or it is refused', async () => {
    // Mutation campaign at the Phase 7 exit (D-P7-1 item 4): the owner's own call is checked too.
    const record = (key: string | null, verifier: string | null) =>
      db.admin.query('select platform.record_source_verification($1, $2)', [key, verifier]);
    for (const key of [null, 'not-a-key', 'A'.repeat(64), 'a'.repeat(63)]) {
      await expect(record(key, 'TEST-ONLY verifier'), String(key)).rejects.toThrow(/EBMR-INT-030 a source verification names its envelope by its key/);
    }
    for (const verifier of [null, '', '   ']) {
      await expect(record('a'.repeat(64), verifier), String(verifier)).rejects.toThrow(/EBMR-INT-030 a source verification names what verified the envelope/);
    }
    expect(await count(db, 'select count(*) as n from platform.source_verification')).toBe(0);
  });

  it('[DI-31] a source that does not sign (EMS) is taken without a verification; the transport peer the server reports is kept with the message', async () => {
    const peer = 'b'.repeat(64);
    const e = envelopeFor(ems, 'ems.series_chunk', chunk());
    const [r] = await acceptAll(ems, [e], [], peer);
    expect(r).toMatchObject({ outcome: 'ACCEPTED' });
    const { rows } = await db.admin.query<{ p: string | null; v: string | null }>('select transport_peer as p, source_verification as v from platform.inbound_message where id = $1', [r!['messageId']]);
    expect(rows[0]).toEqual({ p: peer, v: null });
    // Without TLS (loopback) nothing is reported; a value that is not a SHA-256 fingerprint is refused, never stored.
    const [plain] = await acceptAll(ems, [envelopeFor(ems, 'ems.series_chunk', chunk())]);
    expect((await db.admin.query<{ p: string | null }>('select transport_peer as p from platform.inbound_message where id = $1', [plain!['messageId']])).rows[0]?.p).toBeNull();
    await expect(acceptAll(ems, [envelopeFor(ems, 'ems.series_chunk', chunk())], [], 'not-a-fingerprint')).rejects.toThrow(/transport_peer/);
    // Advisory, and said so where it is stored (kernel 1306): any application-role session can set the setting.
    const comment = (await db.admin.query<{ c: string }>("select col_description('platform.inbound_message'::regclass, (select attnum from pg_attribute where attrelid = 'platform.inbound_message'::regclass and attname = 'transport_peer')::int) as c")).rows[0]?.c;
    expect(comment).toMatch(/^Advisory: .*not evidence by itself/);
  });

  it('[DI-31] the envelope check admits the gateway signature in its shape only', async () => {
    const sig = { alg: 'Ed25519', gatewayCode: 'GW-01', keyId: 'c'.repeat(64), sig: `${'A'.repeat(86)}==` };
    const good = { ...envelopeFor(ems, 'ems.series_chunk', chunk()), gatewaySignature: sig };
    expect((await db.app.query<{ p: string | null }>('select platform.inbound_envelope_problem($1::jsonb) as p', [JSON.stringify(good)])).rows[0]?.p).toBeNull();
    for (const bad of [{ ...sig, alg: 'RSA' }, { ...sig, keyId: 'C'.repeat(64) }, { ...sig, sig: 'short==' }, { ...sig, extra: '1' }, 'signed']) {
      const p = (await db.app.query<{ p: string | null }>('select platform.inbound_envelope_problem($1::jsonb) as p', [JSON.stringify({ ...good, gatewaySignature: bad })])).rows[0]?.p;
      expect(p, JSON.stringify(bad)).toMatch(/gatewaySignature/);
    }
    await expectRefused(acceptAll(ems, [{ ...good, gatewaySignature: { ...sig, alg: 'RSA' } }]), 'EBMR-INT-001');
  });
});
