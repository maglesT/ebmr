/**
 * Inter-site transfer packages and federated genealogy with two installations in one test run (Phase 6 slice 6i; kernel
 * 1220, site services 0980, 0981, recipe-core 1090, 1091; outline L-41; DI-31, DI-39, PR-57, IN-29; defaults D-P6i-0-1
 * to D-P6i-0-10). Two databases, PUNE (the shipping site) and GOA (the receiving site), each with its own key; every act
 * runs as the application role inside a validated command and every seal is verified by the receiving database.
 */
import { randomUUID } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { signFor } from '../helpers.ts';
import { Installation, rawPublicKey, refusal, sealOf, TAG } from './world.ts';

let pune: Installation;
let goa: Installation;
let third: { code: string; key: ReturnType<typeof generateKeyPairSync>['privateKey']; publicKey: string };
let lot: { id: string; code: string };
let first: { packageId: string; packageNo: string; payload: string; seal: string };
let received: { receiptId: string; lotId: string; lotCode: string };
let downstream: Awaited<ReturnType<Installation['downstream']>>;
let olderExcerpt: string;

const now = (s = 0): string => new Date(Date.now() + s * 1000).toISOString();

beforeAll(async () => {
  [pune, goa] = await Promise.all([Installation.create(`PUNE-${TAG}`), Installation.create(`GOA-${TAG}`)]);
  const pair = generateKeyPairSync('ed25519');
  third = { code: `NASIK-${TAG}`, key: pair.privateKey, publicKey: rawPublicKey(pair.publicKey) };
  await Promise.all([pune.trust(goa), goa.trust(pune)]);
  await pune.trust({ code: third.code, publicKey: third.publicKey } as Installation);
  lot = await pune.releasedIntermediate('500');
}, 300_000);
afterAll(async () => {
  await Promise.all([pune?.drop(), goa?.drop()]);
});

describe('the outbound package (site services 0980; L-41)', () => {
  it('[DI-39] the status and disposition travel with the lot, and only a released intermediate is packaged', async () => {
    // A CoA line: an approved release result (fixture rows, as QC's approval leaves them).
    await pune.fixture(
      `with t as (insert into site.lot_test_result (lot_id, test_code, method_reference, purpose, result_value, unit, lower_limit, upper_limit, recorded_by_person, recorded_by_account, correlation_id)
                  values ($1, 'LOD', 'STP-LOD-01', 'RELEASE', 1.2, '%', null, 2.0, $2, $2, $2) returning id)
       insert into site.lot_test_approval (result_id, signature_id, approved_by_person, approved_by_account) select t.id, gen_random_uuid(), $2, $2 from t`,
      [lot.id, randomUUID()],
    );
    first = await pune.ship(lot.id, goa, '100');
    const p = JSON.parse(first.payload) as Record<string, any>;
    expect(p).toMatchObject({
      format: 'ebmr.lot-transfer.v1',
      packageId: first.packageId,
      origin: { installation: pune.code, site: 'SITE-1', edition: 'TABLETS' },
      destination: { installation: goa.code, site: 'SITE-1' },
      lot: { id: lot.id, lotCode: lot.code, materialKind: 'INTERMEDIATE', unit: 'kg', quantity: '100' },
      status: { state: 'RELEASED_FOR_FURTHER_PROCESSING', decision: { event: 'RELEASE_FOR_FURTHER_PROCESSING', personId: pune.qa.personId } },
      coa: [{ testCode: 'ASSAY', result: '99.5', unit: '%', lowerLimit: '98.0', upperLimit: '102.0', verdict: 'PASS' },
            { testCode: 'LOD', result: '1.2', unit: '%', upperLimit: '2.0', verdict: 'PASS' }],
      hold: { basis: 'RETEST' },
      markets: ['IN'],
      genealogy: { direction: 'BACKWARD', rows: [{ nodeKind: 'LOT', nodeId: lot.id, depth: 0 }] },
    });
    expect(p.status.decision.signatureId).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.ruleResolutions.length).toBeGreaterThan(0);
    expect(p.ruleResolutions.find((r: { key: string }) => r.key === 'kernel.selfInspection.maxIntervalMonths')).toMatchObject({ method: 'SMALLER_STRICTER', value: '12' });
    // The payload is the stored text; the stored seal verifies under this installation's key, and the lot has 400 kg left.
    expect(await pune.scalar('select payload_sha256 = encode(sha256(convert_to($1, \'UTF8\')), \'hex\') as v from site.transfer_package where id = $2', [first.payload, first.packageId])).toBe(true);
    expect(await pune.scalar("select platform.own_seal_valid('transfer-package', $1, $2) as v", [first.payload, first.seal])).toBe(true);
    expect(await pune.scalar('select site.lot_available($1)::text as v', [lot.id])).toBe('400');

    // Refusals: more than is left, an untrusted destination, a lot in quarantine, a finished lot, an administrator.
    expect(await refusal(pune.ship(lot.id, goa, '401'))).toMatch(/EBMR-XFR-015/);
    expect(await refusal(pune.ship(lot.id, `UNKNOWN-${TAG}`, '1'))).toMatch(/EBMR-XFR-012/);
    const q = randomUUID();
    await pune.fixture(
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at, received_by_person, received_by_account, correlation_id)
       values ($1, 'SITE-1', $2, 'GRAN-500', 'Granules', 'INTERMEDIATE', 10, 'kg', '2030-01-01T00:00:00Z', $1, $1, $1)`, [q, `Q-${TAG}`]);
    await pune.quarantine(q);
    expect(await refusal(pune.ship(q, goa, '1'))).toMatch(/EBMR-XFR-014 .* QUARANTINE/);
    const f = randomUUID();
    await pune.fixture(
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at, received_by_person, received_by_account, correlation_id)
       values ($1, 'SITE-1', $2, 'PCM-500', 'Tablets', 'FINISHED', 10, 'units', '2030-01-01T00:00:00Z', $1, $1, $1)`, [f, `F-${TAG}`]);
    await pune.quarantine(f);
    expect(await refusal(pune.ship(f, goa, '1'))).toMatch(/EBMR-XFR-013/);
    expect(await refusal(pune.run(pune.admin, 'select site.prepare_transfer_package($1, $2::jsonb) as r', [lot.id, JSON.stringify({ destination: goa.code, quantity: '1' })]))).toMatch(/EBMR-IAM-04[02]/);
  });

  it('[DI-31] a package is sealed once, by the person who prepared it, with this installation\'s current key', async () => {
    const run = (sealWith: 'own' | 'other', twice = false) =>
      withCommand(pune.db.app, { ...pune.stores, correlationId: randomUUID(), reasonCode: 'TEST', reasonText: 'seal' }, async (c) => {
        const p = (await c.query<{ r: { packageId: string; payload: string } }>('select site.prepare_transfer_package($1, $2::jsonb) as r', [lot.id, JSON.stringify({ destination: goa.code, quantity: '1' })])).rows[0]!.r;
        const seal = sealOf(sealWith === 'own' ? pune.key : goa.key, 'transfer-package', p.payload);
        await c.query('select site.seal_transfer_package($1, $2)', [p.packageId, seal]);
        if (twice) await c.query('select site.seal_transfer_package($1, $2)', [p.packageId, seal]);
      });
    expect(await refusal(run('other'))).toMatch(/EBMR-XFR-018/);
    expect(await refusal(run('own', true))).toMatch(/EBMR-XFR-017 .* sealed already/);
    // A seal of another purpose never verifies as a package seal.
    expect(await pune.scalar("select platform.own_seal_valid('transfer-package', $1, $2) as v", [first.payload, sealOf(pune.key, 'federation-answer', first.payload)])).toBe(false);
    // Nothing reaches the tables except through the definers.
    expect(await refusal(pune.db.app.query("insert into site.transfer_package_seal (package_id, seal, key_fingerprint, sealed_by_person, sealed_by_account) values ($1, 'x', repeat('0', 64), $1, $1)", [first.packageId]))).toMatch(/permission denied/);
    expect(await refusal(pune.db.admin.query("update site.transfer_package set quantity = 1 where id = $1", [first.packageId]))).toMatch(/insert-only|EBMR-AUDIT|refused/i);
  });
});

describe('the inbound package (site services 0981; L-41)', () => {
  it('[DI-31] a tampered transfer package is refused', async () => {
    const changed = first.payload.replace('"quantity": "100"', '"quantity": "900"');
    expect(changed).not.toBe(first.payload);
    const lots = await goa.scalar<string>('select count(*)::text as v from site.material_lot');
    const r = await goa.receive(changed, first.seal);
    expect(r).toMatchObject({ outcome: 'REFUSED', kind: 'TAMPERED' });
    expect(r.reason).toMatch(/EBMR-XFR-022/);
    // A package sealed by another key than the sender's is refused the same way.
    expect(await goa.receive(first.payload, sealOf(third.key, 'transfer-package', first.payload))).toMatchObject({ outcome: 'REFUSED', kind: 'TAMPERED' });
    // Nothing was created; the refusal and its alarm stay.
    expect(await goa.scalar<string>('select count(*)::text as v from site.material_lot')).toBe(lots);
    expect(await goa.scalar('select count(*)::int as v from site.transfer_receipt')).toBe(0);
    expect(await goa.scalar("select count(*)::int as v from site.transfer_refusal where kind = 'TAMPERED'")).toBe(2);
    expect(await goa.scalar("select kind || '/' || severity || '/' || path as v from platform.installation_alarm where id = $1", [r.alarmId])).toBe('TAMPERED/MAJOR/TRANSFER_IMPORT');
  });

  it('[DI-31] a package for another installation is refused', async () => {
    const toThird = await pune.ship(lot.id, third.code, '5');
    const r = await goa.receive(toThird.payload, toThird.seal);
    expect(r).toMatchObject({ outcome: 'REFUSED', kind: 'WRONG_DESTINATION' });
    expect(r.reason).toMatch(new RegExp(`EBMR-XFR-023 .*${third.code}.*${goa.code}`));
  });

  it('[DI-31] an unknown sender and a second import of the same package are refused', async () => {
    // Malformed text.
    expect(await goa.receive('not a package', first.seal)).toMatchObject({ outcome: 'REFUSED', kind: 'MALFORMED' });
    // A sender GOA does not trust (sealed with its own key, so only the trust is missing).
    const foreign = JSON.stringify({ ...JSON.parse(first.payload), packageId: randomUUID(), origin: { installation: third.code, site: 'SITE-1', edition: 'TABLETS' } });
    expect(await goa.receive(foreign, sealOf(third.key, 'transfer-package', foreign))).toMatchObject({ outcome: 'REFUSED', kind: 'UNKNOWN_PEER' });
    // The genuine package is taken in once.
    const ok = await goa.receive(first.payload, first.seal);
    expect(ok).toMatchObject({ outcome: 'RECEIVED', lotCode: lot.code });
    received = ok as typeof received;
    expect(await goa.receive(first.payload, first.seal)).toMatchObject({ outcome: 'REFUSED', kind: 'DUPLICATE' });
    expect(await goa.scalar("select count(*)::int as v from platform.installation_alarm where path = 'TRANSFER_IMPORT'")).toBe(6);
    // The import is the stores' act at the site, never an administrator's.
    expect(await refusal(goa.run(goa.admin, 'select site.import_transfer_package($1, $2) as r', [first.payload, first.seal]))).toMatch(/EBMR-IAM-04[02]/);
  });

  it('[DI-39] a received lot is unusable before local QA acceptance', async () => {
    expect(await goa.scalar("select material_kind || '/' || site.lot_state(id) || '/' || supplier || '/' || supplier_lot || '/' || received_quantity::text as v from site.material_lot where id = $1", [received.lotId]))
      .toBe(`INTERMEDIATE/QUARANTINE/${pune.code}/${lot.code}/100`);
    // The ordinary local release is refused before the acceptance, for every writer.
    expect(await refusal(goa.releaseForFurtherProcessing(received.lotId))).toMatch(/EBMR-XFR-040 .* not yet accepted/);
    expect(await refusal(goa.bypassReservation(received.lotId))).toMatch(/EBMR-XFR-040/);
    // The decision is QA's: the stores and an administrator are refused; a signature by another person is refused.
    expect(await refusal(goa.decide(received.receiptId, 'ACCEPTED', null, goa.stores))).toMatch(/EBMR-IAM-054 .*NO_SIGNING_PERMISSION/);
    const sig = await signFor(goa.db, goa.ap, { type: 'transfer_receipt', id: received.receiptId }, 'TRANSFER_RECEIPT_ACCEPTED', 'RECEIVED');
    expect(await refusal(goa.run(goa.qa, "select site.decide_transfer_receipt($1, 'ACCEPTED', $2, null) as r", [received.receiptId, sig]))).toMatch(/EBMR-XFR-036/);
    // Accepted by local QA: the receipt is ACCEPTED, then the ordinary release makes the lot usable.
    await goa.decide(received.receiptId, 'ACCEPTED');
    expect(await goa.scalar('select site.transfer_receipt_state($1) as v', [received.receiptId])).toBe('ACCEPTED');
    expect(await refusal(goa.decide(received.receiptId, 'REFUSED', 'decided twice for the test'))).toMatch(/EBMR-XFR-031|EBMR-ESIG/);
    expect(await goa.state(received.lotId)).toBe('QUARANTINE');
    await goa.locallyTested(received.lotId);
    await goa.releaseForFurtherProcessing(received.lotId);
    expect(await goa.state(received.lotId)).toBe('RELEASED_FOR_FURTHER_PROCESSING');
    const rid = await goa.run<string>(goa.stores, "select site.reserve_lot($1, gen_random_uuid(), 'B-1', 'TABLETS', 5, 'kg', now() + interval '1 hour') as r", [received.lotId]);
    expect(rid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DI-39] a receipt local QA refused never becomes usable', async () => {
    const p = await pune.ship(lot.id, goa, '10');
    const r = await goa.receive(p.payload, p.seal);
    const sig = await signFor(goa.db, goa.qa, { type: 'transfer_receipt', id: r.receiptId! }, 'TRANSFER_RECEIPT_REFUSED', 'RECEIVED');
    const decide = (reason: string) => goa.run(goa.qa, "select site.decide_transfer_receipt($1, 'REFUSED', $2, $3) as r", [r.receiptId, sig, reason]);
    expect(await refusal(decide('short'))).toMatch(/EBMR-XFR-031 .* reason/);
    await decide('container seals broken on arrival');
    expect(await refusal(goa.releaseForFurtherProcessing(r.lotId!))).toMatch(/EBMR-XFR-040 .* refused by local QA/);
  });

  it('the remaining hold time carries over and keeps running (D-P6i-0-5)', async () => {
    const until = now(3);
    const p = await pune.ship(lot.id, goa, '10', { holdUntil: until });
    expect(JSON.parse(p.payload).hold).toMatchObject({ basis: 'STATED' });
    const r = await goa.receive(p.payload, p.seal);
    expect(await goa.scalar('select hold_until = $2::timestamptz as v from site.transfer_receipt where id = $1', [r.receiptId, until])).toBe(true);
    expect(await goa.scalar("select site.transfer_hold_remaining($1) between interval '0' and interval '3 seconds' as v", [r.receiptId])).toBe(true);
    await sleep(3200);
    expect(await goa.scalar('select site.transfer_hold_remaining($1)::text as v', [r.receiptId])).toBe('00:00:00');
    expect(await refusal(goa.decide(r.receiptId!, 'ACCEPTED'))).toMatch(/EBMR-XFR-033 .* hold limit/);

    // Accepted and released inside the hold, the lot is still refused once the hold passes; a package onward carries it.
    const until2 = now(20);
    const p2 = await pune.ship(lot.id, goa, '10', { holdUntil: until2 });
    const r2 = await goa.receive(p2.payload, p2.seal);
    await goa.decide(r2.receiptId!, 'ACCEPTED');
    await goa.locallyTested(r2.lotId!);
    await goa.releaseForFurtherProcessing(r2.lotId!);
    const back = await goa.ship(r2.lotId!, pune, '1');
    expect(JSON.parse(back.payload).hold).toMatchObject({ basis: 'CARRIED', untilUs: String(BigInt(Date.parse(until2)) * 1000n) });
    const wait = Date.parse(until2) - Date.now() + 300;
    if (wait > 0) await sleep(wait);
    expect(await refusal(goa.run(goa.stores, "select site.reserve_lot($1, gen_random_uuid(), 'B-2', 'TABLETS', 1, 'kg', now() + interval '1 hour') as r", [r2.lotId]))).toMatch(/EBMR-XFR-041|EBMR-SITE-14[24]/);
    expect(await refusal(goa.bypassReservation(r2.lotId!))).toMatch(/EBMR-XFR-041/);
  }, 60_000);

  it('rule resolutions are re-resolved at the receiving site and the stricter wins (D-P6i-0-6)', async () => {
    const rows = await goa.db.admin.query<{ key: string; winner: string; resolved: string }>(
      "select key, winner, resolved_value #>> '{}' as resolved from site.transfer_rule_resolution where receipt_id = $1 order by key", [received.receiptId]);
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.find((r) => r.key === 'kernel.selfInspection.maxIntervalMonths')).toMatchObject({ winner: 'EQUAL', resolved: '12' });
    expect(rows.rows.every((r) => r.winner === 'EQUAL')).toBe(true);
    // The origin's table differs (a stricter, a looser and an unknown key): sealed by the origin, as its database would.
    const base = JSON.parse(first.payload) as Record<string, any>;
    const craft = (value: string, extra: object[] = []): Record<string, any> => ({
      ...base, packageId: randomUUID(), packageNo: `${lot.code}/T9${value}`,
      ruleResolutions: [...base.ruleResolutions.map((r: { key: string }) => (r.key === 'kernel.selfInspection.maxIntervalMonths' ? { ...r, value } : r)), ...extra],
    });
    const stricter = JSON.stringify(craft('6', [{ key: 'kernel.unknownAtGoa', tableCode: 'kernel', tableVersion: 1, method: 'LARGER_STRICTER', valueType: 'DECIMAL', unit: '1', value: '3' }]));
    const looser = JSON.stringify(craft('24'));
    const a = await goa.receive(stricter, sealOf(pune.key, 'transfer-package', stricter));
    const b = await goa.receive(looser, sealOf(pune.key, 'transfer-package', looser));
    const winner = async (receipt: string, key: string): Promise<string> =>
      goa.scalar("select winner || '=' || coalesce(resolved_value #>> '{}', '-') || '/' || coalesce(local_value #>> '{}', '-') as v from site.transfer_rule_resolution where receipt_id = $1 and key = $2", [receipt, key]);
    expect(await winner(a.receiptId!, 'kernel.selfInspection.maxIntervalMonths')).toBe('CARRIED=6/12');
    expect(await winner(a.receiptId!, 'kernel.unknownAtGoa')).toBe('CARRIED_ONLY=3/-');
    expect(await winner(b.receiptId!, 'kernel.selfInspection.maxIntervalMonths')).toBe('LOCAL=12/12');
  });
});

describe('genealogy across sites (recipe-core 1090; PR-57)', () => {
  it('[PR-57] a forward trace crosses a site transfer', async () => {
    downstream = await goa.downstream(received.lotId);
    // PUNE's own trace ends at the TRANSFER node: the lot left in the sealed package.
    const local = await pune.trace('LOT', lot.id, 'FORWARD');
    expect(local.find((r) => r.nodeId === first.packageId)).toMatchObject({ nodeKind: 'TRANSFER', parentId: lot.id, edgeKind: 'TRANSFERRED', depth: 1 });
    const view = await pune.scalar<Array<Record<string, string>>>("select recipe.genealogy_node_views(array['TRANSFER'], array[$1::uuid]) as v", [first.packageId]);
    expect(view[0]).toMatchObject({ kind: 'TRANSFER', label: first.packageNo, code: pune.code, name: goa.code, sub_kind: 'OUTBOUND', state: 'SEALED' });
    // GOA answers the forward query from the same node: received lot, the batch that consumed it, its finished lot and the consignee.
    const asked = await pune.ask(goa, first.packageId, 'FORWARD');
    expect(asked.ok).toBe(true);
    const excerpt = JSON.parse(asked.answer.payload!) as { from: string; to: string; asOfUs: string; rows: Array<{ nodeKind: string; nodeId: string; edgeKind: string | null; depth: number }>; nodes: Array<Record<string, string>> };
    expect(excerpt).toMatchObject({ from: goa.code, to: pune.code });
    expect(excerpt.rows.map((r) => [r.nodeKind, r.edgeKind, r.depth])).toEqual([
      ['TRANSFER', null, 0], ['LOT', 'TRANSFER_RECEIVED', 1], ['BATCH', 'CONSUMED', 2], ['LOT', 'FINISHED', 3], ['SHIPMENT', 'SHIPPED', 4],
    ]);
    expect(excerpt.rows.map((r) => r.nodeId)).toEqual([first.packageId, received.lotId, downstream.batch, downstream.finished, downstream.shipment]);
    expect(excerpt.nodes.find((n) => n.kind === 'SHIPMENT')).toMatchObject({ state: downstream.consignee });
    expect(excerpt.nodes.find((n) => n.kind === 'TRANSFER')).toMatchObject({ sub_kind: 'INBOUND', state: 'ACCEPTED', code: pune.code, name: goa.code });
    // Kept at PUNE with its as-of point, sealed by GOA.
    expect(await pune.scalar("select (platform.timestamptz_to_epoch_us(as_of) = $2) and platform.peer_seal_valid(peer_code, 'federation-answer', payload, seal) as v from recipe.federated_excerpt where id = $1",
      [asked.excerptId, excerpt.asOfUs])).toBe(true);
    olderExcerpt = asked.excerptId!;
  });

  it('[PR-57] a backward trace from the received lot reaches the shipped lot at its origin', async () => {
    const local = await goa.trace('LOT', downstream.finished, 'BACKWARD');
    expect(local.map((r) => [r.nodeKind, r.edgeKind])).toEqual([['LOT', null], ['BATCH', 'FINISHED'], ['LOT', 'CONSUMED'], ['TRANSFER', 'TRANSFER_RECEIVED']]);
    const asked = await goa.ask(pune, first.packageId, 'BACKWARD');
    expect(asked.ok).toBe(true);
    const rows = (JSON.parse(asked.answer.payload!) as { rows: Array<{ nodeKind: string; nodeId: string; edgeKind: string | null }> }).rows;
    expect(rows.map((r) => [r.nodeKind, r.nodeId, r.edgeKind])).toEqual([['TRANSFER', first.packageId, null], ['LOT', lot.id, 'TRANSFERRED']]);
  });

  it('[DI-31] the federation endpoint refuses an unsigned, replayed, misaddressed or unrelated request', async () => {
    const answer = async (request: string, seal: string): Promise<{ ok: boolean; reason?: string }> =>
      (await goa.db.app.query<{ r: { ok: boolean; reason?: string } }>('select recipe.answer_federated_genealogy($1, $2) as r', [request, seal])).rows[0]!.r;
    const issued = (await pune.db.app.query<{ r: { nonce: string; request: string } }>("select recipe.issue_federated_request($1, $2, 'FORWARD', null) as r", [goa.code, first.packageId])).rows[0]!.r;
    // Unsigned (a seal under another key), then the genuine one, then the same request again.
    expect((await answer(issued.request, sealOf(third.key, 'federation-request', issued.request))).reason).toMatch(/EBMR-FED-004/);
    const seal = sealOf(pune.key, 'federation-request', issued.request);
    expect((await answer(issued.request, seal)).ok).toBe(true);
    expect((await answer(issued.request, seal)).reason).toMatch(/EBMR-FED-006 .* answered already/);
    const craft = (over: Record<string, unknown>): string => JSON.stringify({ ...JSON.parse(issued.request), nonce: randomUUID(), ...over });
    const misaddressed = craft({ to: third.code });
    expect((await answer(misaddressed, sealOf(pune.key, 'federation-request', misaddressed))).reason).toMatch(/EBMR-FED-005/);
    const stale = craft({ issuedAtUs: String((BigInt(Date.now()) - 600_000n) * 1000n) });
    expect((await answer(stale, sealOf(pune.key, 'federation-request', stale))).reason).toMatch(/EBMR-FED-006 .* 300 seconds/);
    const stranger = craft({ from: third.code });
    expect((await answer(stranger, sealOf(third.key, 'federation-request', stranger))).reason).toMatch(/EBMR-FED-003/);
    // A transfer GOA never exchanged with PUNE (PUNE's package to NASIK).
    const other = await pune.scalar<string>('select id::text as v from site.transfer_package where destination_installation = $1 limit 1', [third.code]);
    const unrelated = craft({ query: { transferId: other, direction: 'FORWARD', asOfUs: String(BigInt(Date.now()) * 1000n) } });
    expect((await answer(unrelated, sealOf(pune.key, 'federation-request', unrelated))).reason).toMatch(/EBMR-FED-011/);
    expect(await goa.scalar("select count(*)::int as v from platform.federation_request where outcome = 'REFUSED' and alarm_id is not null")).toBe(6);
    // The asking side keeps only an answer sealed by the peer that answers exactly what it asked.
    const again = (await pune.db.app.query<{ r: { nonce: string; request: string } }>("select recipe.issue_federated_request($1, $2, 'FORWARD', null) as r", [goa.code, first.packageId])).rows[0]!.r;
    const good = await answer(again.request, sealOf(pune.key, 'federation-request', again.request)) as { ok: boolean; payload: string };
    const record = async (payload: string, s: string): Promise<{ ok: boolean; reason?: string }> =>
      (await pune.db.app.query<{ r: { ok: boolean; reason?: string } }>('select recipe.record_federated_excerpt($1, $2, $3) as r', [again.nonce, payload, s])).rows[0]!.r;
    expect((await record(good.payload, sealOf(pune.key, 'federation-answer', good.payload))).reason).toMatch(/EBMR-FED-017/);
    const forged = good.payload.replace(downstream.consignee, 'CUST-FORGED');
    expect((await record(forged, sealOf(pune.key, 'federation-answer', forged))).reason).toMatch(/EBMR-FED-017/);
    expect((await record(good.payload, sealOf(goa.key, 'federation-answer', good.payload))).ok).toBe(true);
    expect(await pune.scalar("select count(*)::int as v from recipe.federated_request_failure where status = 'WRONG_ANSWER'")).toBe(2);
  });
});

describe('the mock recall across sites (recipe-core 1091; IN-29)', () => {
  it('[IN-29] a mock recall with one site down is marked incomplete', async () => {
    const id = await pune.run<string>(pune.qa, "select recipe.run_mock_recall('LOT', $1, null, false, null) as r", [lot.id]);
    const fed = async (): Promise<{ complete: boolean; transfers: Array<Record<string, unknown>> }> => pune.scalar('select recipe.mock_recall_federation($1) as v', [id]);
    const transfers = await pune.scalar<Array<{ transfer_id: string; destination: string }>>("select result -> 'transfers' as v from recipe.mock_recall where id = $1", [id]);
    const toGoa = await pune.scalar<number>('select count(*)::int as v from site.transfer_package where lot_id = $1 and destination_installation = $2', [lot.id, goa.code]);
    expect(transfers.filter((t) => t.destination === goa.code).length).toBe(toGoa);
    expect(transfers.filter((t) => t.destination === third.code).length).toBe(1);
    expect((await fed()).complete).toBe(false);
    expect((await fed()).transfers.every((t) => t['status'] === 'NOT_ASKED')).toBe(true);
    // GOA is down: the last excerpt received is shown with its own, older as-of; it is never taken as the answer.
    const asOf = await pune.scalar<string>("select platform.timestamptz_to_epoch_us(as_of) as v from recipe.mock_recall where id = $1", [id]);
    expect(await refusal(pune.run(pune.qa, "select recipe.record_mock_recall_remote($1, $2, 'ANSWERED', $3, null) as r", [id, first.packageId, olderExcerpt]))).toMatch(/EBMR-RCL-024/);
    await pune.run(pune.qa, "select recipe.record_mock_recall_remote($1, $2, 'UNREACHABLE', $3, 'connection refused') as r", [id, first.packageId, olderExcerpt]);
    let f = await fed();
    expect(f.complete).toBe(false);
    const line = f.transfers.find((t) => t['transfer_id'] === first.packageId)!;
    expect(line).toMatchObject({ status: 'UNREACHABLE', excerpt_id: olderExcerpt, detail: 'connection refused' });
    expect(BigInt(line['excerpt_as_of_us'] as string) < BigInt(asOf)).toBe(true);
    // Every outbound transfer answered as of the recall's own instant: complete.
    for (const t of transfers) {
      if (t.destination !== goa.code) {
        await pune.run(pune.qa, "select recipe.record_mock_recall_remote($1, $2, 'NOT_REGISTERED', null, 'the destination does not answer this site') as r", [id, t.transfer_id]);
        continue;
      }
      const asked = await pune.ask(goa, t.transfer_id, 'FORWARD', asOf);
      expect(asked.ok).toBe(true);
      await pune.run(pune.qa, "select recipe.record_mock_recall_remote($1, $2, 'ANSWERED', $3, null) as r", [id, t.transfer_id, asked.excerptId]);
    }
    f = await fed();
    expect(f.transfers.filter((t) => t['status'] === 'ANSWERED').length).toBe(toGoa);
    expect(f.complete).toBe(false); // NASIK never answered
    // What the AP signs off says so.
    expect(await pune.scalar("select esig.provide('mock_recall', $1::text) -> 'content' -> 'federation' ->> 'complete' as v", [id])).toBe('false');
    const sig = await signFor(pune.db, pune.ap, { type: 'mock_recall', id }, 'MOCK_RECALL_SIGNED_OFF', 'RUN');
    await pune.run(pune.ap, 'select recipe.sign_off_mock_recall($1, $2) as r', [id, sig]);
    expect(await refusal(pune.run(pune.qa, "select recipe.record_mock_recall_remote($1, $2, 'UNREACHABLE', null, 'too late') as r", [id, first.packageId]))).toMatch(/EBMR-RCL-020/);
  }, 120_000);
});
