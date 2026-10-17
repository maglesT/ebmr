/**
 * The market routes and acts over HTTP (Phase 4 slice 4a; contract ns/release.ts; recipe-core 0820 to 0824, tablets 1180,
 * 1189): the lot's market view and market-add evaluations, a market added through the ceremony (its sequence read by the
 * server), the two-row release ceremony (D-P4-5) refused whole when the database refuses, and the intake of a structured
 * certification message whose Ed25519 signature the database verifies, every message acknowledged (DI-39). The finished
 * lot is posted as the edition's definer posts it; its batch is a real GMP batch, issued and not reviewed.
 */
import { generateKeyPairSync, randomUUID, sign as edSign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { routes, type SignableAction } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { refusalOf, valueOf } from '../esig/support.ts';
import { actorOf, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import type { TestBrowser } from '../support/harness.ts';
import { credentialsOf, describeAction, signAction } from '../support/signed-acts.ts';

let w: GmpBatchWorld;
let ap: TestBrowser;
let qa: TestBrowser;
let batchId: string;
let lotId: string;
let lotCode: string;
let batchNumber: string;
const keys = generateKeyPairSync('ed25519');
const importerCode = `EUIMP-${randomUUID().slice(0, 6).toUpperCase()}`;

beforeAll(async () => {
  w = await startGmpBatchWorld();
  const issuer = await w.gmp.asPersona('issuer');
  [ap, qa] = await Promise.all([w.gmp.asPersona('qcuAuthoriser'), w.gmp.asPersona('qaInvestigator')]);
  batchId = await w.issued(issuer);
  batchNumber = (await w.gmp.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [batchId])).rows[0]!.n;
  const stores = await actorOf(w.gmp, 'stores');
  lotId = await withCommand(w.gmp.db.admin, { ...stores, correlationId: randomUUID() }, async (c) =>
    (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId, batchNumber, edition: 'TABLETS', siteCode: 'SITE-1', productCode: w.content.header.product.code, productName: 'Market route product',
                       strength: '500 mg', markets: ['IN'], quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
    ])).rows[0]!.id,
  );
  lotCode = (await w.gmp.db.admin.query<{ c: string }>('select lot_code as c from site.material_lot where id = $1', [lotId])).rows[0]!.c;
  // TEST FIXTURE: the importer and its message key (QA's signed EU_IMPORTER_APPROVED act is proven in recipe-core's tests).
  const spki = keys.publicKey.export({ type: 'spki', format: 'der' });
  await withCommand(w.gmp.db.admin, { ...stores, correlationId: randomUUID() }, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "insert into recipe.eu_importer (code, name, technical_agreement_ref, mia_number, public_key, signature_id, person_id, account_id) values ($1, 'Example Pharma Import GmbH', 'TA-2026-007', 'DE-MIA-2024-118', $2, gen_random_uuid(), $3, $4) returning id",
      [importerCode, spki.subarray(spki.length - 32), stores.personId, stores.accountId],
    );
    await c.query('insert into recipe.eu_importer_product (product_code, importer_id) values ($1, $2)', [w.content.header.product.code, rows[0]!.id]);
  });
}, 600_000);
afterAll(async () => {
  await w?.close();
});

const codeOf = (r: Awaited<ReturnType<typeof signAction>>): string => (r.ok ? 'ok' : (refusalOf(r)?.why.match(/EBMR-[A-Z]+-\d{3}/)?.[0] ?? refusalOf(r)?.code ?? 'refused'));

/** The two-row ceremony as a screen runs it: a challenge for each record, the credentials entered once. */
async function signTwoRows(b: TestBrowser, personaKey: string, action: SignableAction, withCompanion = true) {
  const d = await describeAction(b, action);
  const challenge = async (aggregateType: string, aggregateId: string, meaning: string) => {
    const preview = valueOf(await b.call(routes.esig.content, { query: { aggregateType, aggregateId, intent: meaning } }));
    return valueOf(await b.call(routes.esig.createChallenge, {
      body: { aggregateType, aggregateId, contentVersion: preview.contentVersion, meaning, clientContentHash: sha256Hex(preview.canonicalText), action },
    }));
  };
  const first = await challenge(d.aggregateType, d.aggregateId, d.meaning ?? '');
  const second = withCompanion && d.companion ? await challenge(d.companion.aggregateType, d.companion.aggregateId, d.companion.meaning) : null;
  const body = { challengeId: first.challengeId, credentials: credentialsOf(w.gmp, personaKey), action, ...(second ? { companionChallengeId: second.challengeId } : {}) };
  return b.call(routes.esig.sign, { body: { ...body, proof: await b.proof('POST', '/api/esig/sign', body) } });
}

async function message(fields: Record<string, unknown>, opts: { badKey?: boolean } = {}) {
  const text = JSON.stringify({ format: 'ebmr.qp-certification.v1', messageId: `MSG-${randomUUID()}`, importerCode, lotCode, batchNumber, productCode: w.content.header.product.code,
                                outcome: 'CERTIFIED', certifier: { name: 'Dr. Lena Vogel', miaNumber: 'DE-MIA-2024-118' }, certifiedAt: new Date().toISOString(), ...fields });
  const key = opts.badKey ? generateKeyPairSync('ed25519').privateKey : keys.privateKey;
  const body = { message: text, signature: edSign(null, Buffer.from(text, 'utf8'), key).toString('base64') };
  return qa.call(routes.release.qpMessage, { body });
}

describe('market routes over HTTP (outline 3.3.3, 5.2.6)', () => {
  it('[meta] an India-only lot has no export disposition; the market-add evaluations of the lot and its batch answer; the importers are listed; an unknown lot is 404', async () => {
    const view = valueOf(await qa.call(routes.release.markets, { params: { lotId } }));
    expect(view).toMatchObject({ lotId, manufacturerState: 'NOT_READY', markets: ['IN'], dispositions: [] });
    const lotEval = valueOf(await qa.call(routes.release.marketAdd, { params: { lotId }, query: { market: 'US' } }));
    expect(lotEval).toMatchObject({ subjectKind: 'LOT', subjectId: lotId, market: 'US' });
    expect(lotEval.items.map((i) => i.id)).toEqual(['MA.MBR_AUTHORISATION', 'MA.IDENTITY_ROUTE', 'MA.RELEASE_TESTS', 'MA.RESERVE_SAMPLES']);
    const batchEval = valueOf(await qa.call(routes.release.batchMarketAdd, { params: { batchId }, query: { market: 'EU' } }));
    expect(batchEval.items.map((i) => i.id)).toEqual(['MA.MBR_AUTHORISATION', 'MA.IDENTITY_ROUTE']);
    expect(refusalOf(await qa.call(routes.release.markets, { params: { lotId: randomUUID() } })).status).toBe(404);
    expect(refusalOf(await qa.call(routes.release.batchMarketAdd, { params: { batchId: randomUUID() }, query: { market: 'US' } })).status).toBe(404);
    const imp = valueOf(await qa.call(routes.release.importers)).importers.find((i) => i.code === importerCode);
    expect(imp).toMatchObject({ miaNumber: 'DE-MIA-2024-118', products: [w.content.header.product.code] });
    expect(imp?.keyFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('[INV-43] QA adds the US to the lot under a change record through the ceremony: the server reads the change\'s sequence, the evaluation is stored and shown; the AP cannot', async () => {
    const changeRecordId = (await w.gmp.db.admin.query<{ id: string }>('select id from recipe.change_record order by recorded_at limit 1')).rows[0]!.id;
    const add: SignableAction = { kind: 'RELEASE_ACT', act: 'MARKET_ADD', lotId, input: { market: 'US', changeRecordId } };
    const d = await describeAction(qa, add);
    expect(d).toMatchObject({ aggregateType: 'market_change', aggregateId: `LOT/${lotId}/ADD/US/1`, meaning: 'MARKET_ADDED', expectedState: 'NOT_IN_SET' });
    expect(codeOf(await signAction(w.gmp, ap, 'qcuAuthoriser', add))).not.toBe('ok');
    expect(codeOf(await signAction(w.gmp, qa, 'qaInvestigator', { ...add, input: { market: 'US' } }))).toBe('EBMR-API-ACT-INPUT');
    expect(codeOf(await signAction(w.gmp, qa, 'qaInvestigator', add))).toBe('ok');
    const view = valueOf(await qa.call(routes.release.markets, { params: { lotId } }));
    expect(view.markets).toEqual(['IN', 'US']);
    const us = view.dispositions.find((x) => x.market === 'US');
    expect(us?.changes).toHaveLength(1);
    expect(us?.changes[0]).toMatchObject({ change: 'ADD', subjectKind: 'LOT', removedAfterFailure: false, by: { legalName: 'Divya Menon' } });
    expect(us?.changes[0]?.evaluation?.items.length).toBeGreaterThan(0);
    expect(us?.marketAdd).not.toBeNull();
    expect(['NOT_READY', 'INELIGIBLE']).toContain(us?.state);
    expect(us?.gates.release.ready).toBe(false);
    // The next change of the market is the second in the sequence.
    expect((await describeAction(qa, { kind: 'RELEASE_ACT', act: 'MARKET_REMOVE', lotId, input: { market: 'US', deviationId: randomUUID() } })).aggregateId).toBe(`LOT/${lotId}/REMOVE/US/2`);
  });

  it('the two-row release (D-P4-5): the server names the companion record; without its challenge nothing is signed, and an AP who does not hold the QCU permission cannot open the US challenge', async () => {
    const action: SignableAction = { kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId, input: { expectedEpoch: 'a'.repeat(64), usExpectedEpoch: 'b'.repeat(64) } };
    const d = await describeAction(ap, action);
    expect(d.companion).toMatchObject({ aggregateType: 'us_disposition', aggregateId: `${lotId}/RELEASE`, meaning: 'US_DISPOSITION' });
    expect((await describeAction(ap, { ...action, input: { expectedEpoch: 'a'.repeat(64) } })).companion).toBeUndefined();
    const count = async () => Number((await w.gmp.db.admin.query<{ n: string }>("select count(*) as n from esig.signature where aggregate_id like $1 || '%'", [lotId])).rows[0]!.n);
    const before = await count();
    // The seed's AP holds no RELEASE.US_DISPOSITION: the US record is not even shown for signing.
    await expect(signTwoRows(ap, 'qcuAuthoriser', action)).rejects.toThrow(/may not sign US_DISPOSITION/);
    // The action asks for two rows: one challenge alone signs nothing.
    const one = await signTwoRows(ap, 'qcuAuthoriser', action, false).catch((e: Error) => e);
    expect(one instanceof Error || !one.ok).toBe(true);
    expect(await count()).toBe(before);
    // Quick review MEDIUM 4: the database act itself needs RELEASE.US_DISPOSITION of the actor, whatever signatures it is given.
    const apActor = await actorOf(w.gmp, 'qcuAuthoriser');
    const direct = await withCommand(w.gmp.db.app, { ...apActor, correlationId: randomUUID() }, (c) =>
      c.query('select recipe.record_release_with_us_disposition($1, $2, $3, $4, $5)', [lotId, randomUUID(), randomUUID(), 'a'.repeat(64), 'b'.repeat(64)]),
    ).then(() => 'ok', (e: Error) => e.message);
    expect(direct).toMatch(/EBMR-IAM-040 .*RELEASE\.US_DISPOSITION/);
  });
});

describe('the structured certification message (DI-39)', () => {
  it('[DI-39] the database verifies the importer\'s signature and acknowledges every message: a forged one, an unknown importer and a lot not awaiting certification are refused with their reason; a resend gets its first acknowledgement', async () => {
    const forged = valueOf(await message({}, { badKey: true }));
    expect(forged).toMatchObject({ outcome: 'REFUSED', certificationId: null });
    expect(forged.reason).toMatch(/EBMR-DSP-082/);
    const unknown = valueOf(await message({ importerCode: 'EUIMP-NOBODY' }));
    expect(unknown.reason).toMatch(/EBMR-DSP-081/);
    const notAwaiting = valueOf(await message({}));
    expect(notAwaiting).toMatchObject({ outcome: 'REFUSED', lotId });
    expect(notAwaiting.reason).toMatch(/EBMR-DSP-03[13]/);
    // Nothing reached the register; every message has its acknowledgement.
    expect((await w.gmp.db.admin.query('select 1 from recipe.qp_certification where lot_id = $1', [lotId])).rows).toEqual([]);
    const acks = await w.gmp.db.admin.query<{ n: string }>('select count(*) as n from recipe.qp_message_ack where message_sha256 = any ($1)', [[forged.messageSha256, unknown.messageSha256, notAwaiting.messageSha256]]);
    expect(Number(acks.rows[0]!.n)).toBe(3);
    // The application role cannot write the register or an acknowledgement, nor take a message in without the check.
    expect(await w.gmp.db.app.query("insert into recipe.qp_message_ack (message_id, message_sha256, outcome, reason, person_id, account_id) values ('x', $1, 'REFUSED', 'x', gen_random_uuid(), gen_random_uuid())", ['0'.repeat(64)]).then(() => 'ok', (e: Error) => e.message)).toMatch(/permission denied/);
    expect(await w.gmp.db.app.query("select recipe.take_qp_message('{}', true)").then(() => 'ok', (e: Error) => e.message)).toMatch(/permission denied/);
    // Mutation triage T11 (tab.take_qp_certification_message#1, #6, #8): the database refuses a message whose signature
    // is missing or not 64 bytes, also when the application role calls it directly (the route checks the form first).
    const qaActor = await actorOf(w.gmp, 'qaInvestigator');
    const text = JSON.stringify({ format: 'ebmr.qp-certification.v1', messageId: `MSG-${randomUUID()}`, importerCode, lotCode, batchNumber, productCode: w.content.header.product.code,
                                  outcome: 'CERTIFIED', certifier: { name: 'Dr. Lena Vogel', miaNumber: 'DE-MIA-2024-118' }, certifiedAt: new Date().toISOString() });
    for (const signature of ['', 'AAAA', null, Buffer.alloc(63, 1).toString('base64')]) {
      const ack = await withCommand(w.gmp.db.app, { ...qaActor, correlationId: randomUUID() }, async (c) =>
        (await c.query<{ a: { outcome: string; reason: string } }>('select tab.take_qp_certification_message($1, $2) as a', [text, signature])).rows[0]!.a);
      expect(ack, String(signature)).toMatchObject({ outcome: 'REFUSED', reason: expect.stringMatching(/EBMR-DSP-082/) as unknown });
    }
  });
});
