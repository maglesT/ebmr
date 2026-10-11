/**
 * Material lots, release routes, reservations and consumption (build outline 5.2.9; Phase 3 slice 1 plan, core
 * row INV-13 / IN-24 (a)(c) / PR-18 and INV-14 input side; defaults D-S1-1, D-S1-2).
 *
 * Every rule is proven against the database as the application role (ebmr_app), including attempts to bypass the
 * command functions. Consumption goes through recipe.consume_lot, the batch-side definer the dispensing block
 * calls, which takes the batch's market set from the batch record.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cancelReservation,
  changeLotStatus,
  destroyLot,
  disableVendorRoute,
  lotUsage,
  proposeVendorRoute,
  recordIdentityResult,
  recordLotDestruction,
  reserveLot,
} from '../../src/index.ts';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { createTestDatabase, signerActor, signFor, type TestDatabase } from '../helpers.ts';
import { as, refusal, seedCast, unique, withSecondRole, World } from './support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 300_000);
afterAll(async () => {
  await db.drop();
});

describe('receipt and release', () => {
  it('[IN-24][PR-18][INV-13] a received lot is in QUARANTINE: it cannot be reserved, so nothing can be consumed from it', async () => {
    const lot = await w.receive('API');
    expect(lot.state).toBe('QUARANTINE');
    const usage = await w.run(w.cast.warehouse, (c) => lotUsage(c, lot.lotId));
    expect(usage).toMatchObject({ usageStatus: 'QUARANTINE', quantity: '10.000', available: '10.000' });
    const batch = await w.batch(['IN']);
    expect(await refusal(w.reserve(lot.lotId, batch, '1'))).toMatch(/EBMR-SITE-141 .*QUARANTINE: only a released lot is reserved/);
    // No reservation, no consumption.
    expect(await refusal(w.consume(batch, '00000000-0000-4000-8000-000000000001', lot.materialCode, '1'))).toMatch(/EBMR-SITE-160 .*only against a reservation/);
  });

  it('[IN-24] a release on the identity-tested route needs a passing identity result and the QC releaser\'s own signature; the route is recorded', async () => {
    const lot = await w.receive('API');
    const sig = await w.sign(w.cast.qcHead, lot.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    const v = await w.version(lot.lotId);
    expect(await refusal(w.run(w.cast.qcHead, (c) => changeLotStatus(c, lot.lotId, 'RELEASE', v, sig, 'IDENTITY_TESTED')))).toMatch(
      /EBMR-PLAT-068 .*release_route_satisfied: lot .* has no passing identity result/,
    );
    // A RELEASE without a route, or a route on another decision, is refused before anything is recorded.
    expect(await refusal(w.run(w.cast.qcHead, (c) => changeLotStatus(c, lot.lotId, 'RELEASE', v, sig)))).toMatch(/EBMR-SITE-111/);
    // The QC analyst records results but does not release (DI-17).
    await w.identity(lot.lotId);
    const sig2 = await w.sign(w.cast.qcHead, lot.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    expect(await refusal(w.run(w.cast.analyst, async (c) => changeLotStatus(c, lot.lotId, 'RELEASE', await w.version(lot.lotId), sig2, 'IDENTITY_TESTED')))).toMatch(
      /EBMR-IAM-040 .*MATERIAL\.RELEASE/,
    );
    // The signature is the releaser's own: QA cannot fire a release signed by the head of QC.
    expect(await refusal(w.run(w.cast.qa, async (c) => changeLotStatus(c, lot.lotId, 'RELEASE', await w.version(lot.lotId), sig2, 'IDENTITY_TESTED')))).toMatch(
      /signer_is_actor/,
    );
    const r = await w.run(w.cast.qcHead, async (c) => changeLotStatus(c, lot.lotId, 'RELEASE', await w.version(lot.lotId), sig2, 'IDENTITY_TESTED'));
    expect(r).toMatchObject({ from: 'QUARANTINE', to: 'RELEASED' });
    expect((await w.run(w.cast.warehouse, (c) => lotUsage(c, lot.lotId)))?.releaseRoute).toBe('IDENTITY_TESTED');
    // The signature was used once; a release signature cannot be reused for another transition.
    expect(await refusal(w.run(w.cast.qa, async (c) => changeLotStatus(c, lot.lotId, 'HOLD', await w.version(lot.lotId), sig2), 'test'))).toMatch(/EBMR-PLAT-0(75|08)|means MATERIAL_LOT_RELEASED/);
  });

  it('[IN-24][DI-17] segregation: the analyst who recorded the identity result cannot sign the lot\'s release, and the warehouse that received it cannot either', async () => {
    const lot = await w.receive('API');
    await w.identity(lot.lotId);
    const analystAsHead = await withSecondRole(db, w.cast.analyst, 'HEAD_OF_QC');
    expect(await refusal(w.sign(analystAsHead, lot.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE'))).toMatch(/EBMR-ESIG-0\d\d/);
    const receiverAsHead = await withSecondRole(db, w.cast.warehouse, 'HEAD_OF_QC');
    expect(await refusal(w.sign(receiverAsHead, lot.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE'))).toMatch(/EBMR-ESIG-0\d\d/);
    // An uninvolved head of QC can.
    await expect(w.sign(w.cast.qcHead, lot.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE')).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DI-18][DI-17] an administrator never receives, releases, reserves or decides on a lot; an operator cannot receive one', async () => {
    const lot = await w.receive('API');
    expect(await refusal(w.run(w.cast.admin, (c) => recordIdentityResult(c, lot.lotId, 'PASS', 'm', 't')))).toMatch(/EBMR-IAM-042/);
    expect(await refusal(w.run(w.cast.admin, (c) => c.query("select site.receive_lot('{}'::jsonb)")))).toMatch(/EBMR-IAM-042/);
    expect(await refusal(w.run(w.cast.admin, async (c) => changeLotStatus(c, lot.lotId, 'REJECT', await w.version(lot.lotId), null), 'x'))).toMatch(/EBMR-IAM-042/);
    expect(await refusal(w.run(w.cast.operator, (c) => c.query(`select site.receive_lot($1::jsonb)`, [JSON.stringify({ lotCode: unique('L'), materialCode: 'X1', materialName: 'x', materialKind: 'API', quantity: '1', unit: 'kg', expiresAt: '2030-01-01T00:00:00Z' })])))).toMatch(
      /EBMR-IAM-040 .*MATERIAL\.HANDLE/,
    );
  });

  it('[IN-24] a finished-product lot never leaves quarantine through this path; an intermediate is released for further processing by QA only', async () => {
    const finished = await w.receive('FINISHED');
    await w.identity(finished.lotId);
    const sig = await w.sign(w.cast.qcHead, finished.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    expect(await refusal(w.run(w.cast.qcHead, async (c) => changeLotStatus(c, finished.lotId, 'RELEASE', await w.version(finished.lotId), sig, 'IDENTITY_TESTED')))).toMatch(
      /not_finished: lot .* is finished product/,
    );
    const rej = await w.sign(w.cast.qa, finished.lotId, 'MATERIAL_LOT_REJECTED', 'QUARANTINE');
    expect(await refusal(w.run(w.cast.qa, async (c) => changeLotStatus(c, finished.lotId, 'REJECT', await w.version(finished.lotId), rej), 'finished'))).toMatch(/not_finished/);
    const qd = await w.decide(w.cast.qa, finished.lotId, 'RELEASE_FOR_FURTHER_PROCESSING', 'QUARANTINE');
    expect(await refusal(w.run(w.cast.qa, async (c) => changeLotStatus(c, finished.lotId, 'RELEASE_FOR_FURTHER_PROCESSING', await w.version(finished.lotId), qd), 'x'))).toMatch(
      /not_finished/,
    );
    expect(await w.state(finished.lotId)).toBe('QUARANTINE');

    const intermediate = await w.receive('INTERMEDIATE');
    const isig = await w.sign(w.cast.qcHead, intermediate.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    await w.identity(intermediate.lotId);
    const isig2 = await w.sign(w.cast.qcHead, intermediate.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    expect(isig).not.toBe(isig2);
    expect(await refusal(w.run(w.cast.qcHead, async (c) => changeLotStatus(c, intermediate.lotId, 'RELEASE', await w.version(intermediate.lotId), isig2, 'IDENTITY_TESTED')))).toMatch(
      /not_intermediate/,
    );
    const excipient = await w.receive('EXCIPIENT');
    const esig = await w.decide(w.cast.qa, excipient.lotId, 'RELEASE_FOR_FURTHER_PROCESSING', 'QUARANTINE');
    expect(await refusal(w.run(w.cast.qa, async (c) => changeLotStatus(c, excipient.lotId, 'RELEASE_FOR_FURTHER_PROCESSING', await w.version(excipient.lotId), esig), 'x'))).toMatch(
      /intermediate_only/,
    );
    const rffp = await w.decide(w.cast.qa, intermediate.lotId, 'RELEASE_FOR_FURTHER_PROCESSING', 'QUARANTINE');
    expect(await w.run(w.cast.qa, async (c) => changeLotStatus(c, intermediate.lotId, 'RELEASE_FOR_FURTHER_PROCESSING', await w.version(intermediate.lotId), rffp), 'granulate for compression')).toMatchObject({
      to: 'RELEASED_FOR_FURTHER_PROCESSING',
    });
    // An intermediate of the site's own production is used on QA's release for further processing (basis INTERMEDIATE, D-S1-2 as applied here).
    const exportBatch = await w.batch(['IN', 'US', 'EU']);
    const res = await w.reserve(intermediate.lotId, exportBatch, '1');
    expect(await w.consume(exportBatch, res, intermediate.materialCode, '1')).toMatchObject({ identity_basis: 'INTERMEDIATE' });
  });
});

describe('vendor-history release route (IN-24 (c), D-S1-2)', () => {
  it('[IN-24][INV-13] release an excipient lot on vendor history and try to dispense it into a batch with markets {India, US}; blocked until an identity result exists', async () => {
    const lot = await w.receive('EXCIPIENT');
    // Default: no material is enabled, so the vendor-history route is refused.
    const sig = await w.sign(w.cast.qcHead, lot.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    expect(await refusal(w.run(w.cast.qcHead, async (c) => changeLotStatus(c, lot.lotId, 'RELEASE', await w.version(lot.lotId), sig, 'VENDOR_HISTORY')))).toMatch(
      /QA has not enabled the vendor-history route for material/,
    );
    await w.enableVendorHistory(lot.materialCode);
    // The refused release changed nothing: the same signature now releases the lot.
    await w.run(w.cast.qcHead, async (c) => changeLotStatus(c, lot.lotId, 'RELEASE', await w.version(lot.lotId), sig, 'VENDOR_HISTORY'));

    const export_ = await w.batch(['IN', 'US']);
    const forExport = await w.reserve(lot.lotId, export_, '4');
    expect(await refusal(w.consume(export_, forExport, lot.materialCode, '1'))).toMatch(
      /EBMR-SITE-169 lot .* has no identity result: a batch for markets \{IN, US\} needs an identity test of every lot; the vendor-history route serves India-only batches \(IN-24 \(c\)/,
    );
    // The same lot serves an India-only batch on the vendor-history route.
    const domestic = await w.batch(['IN']);
    const forDomestic = await w.reserve(lot.lotId, domestic, '2');
    expect(await w.consume(domestic, forDomestic, lot.materialCode, '1')).toMatchObject({ identity_basis: 'VENDOR_HISTORY_INDIA_ONLY', quantity_after: '9.000' });
    // Once QC records an identity result, the {IN, US} batch may use it.
    await w.identity(lot.lotId);
    expect(await w.consume(export_, forExport, lot.materialCode, '1')).toMatchObject({ identity_basis: 'IDENTITY_RESULT', quantity_after: '8.000' });
  });

  it('[IN-24] the vendor-history route is only for excipients, needs a stored justification and QA\'s signature, and its withdrawal blocks India-only use of lots without an identity result', async () => {
    const api = await w.receive('API');
    expect(await refusal(w.run(w.cast.qa, (c) => c.query("select site.propose_vendor_route($1, 'API', 'a long enough statistical justification', 'REF-1')", [api.materialCode])))).toMatch(
      /EBMR-SITE-131/,
    );
    const exc = await w.receive('EXCIPIENT');
    expect(await refusal(w.run(w.cast.qa, (c) => proposeVendorRoute(c, exc.materialCode, 'too short', 'REF-1')))).toMatch(/EBMR-SITE-132/);
    expect(await refusal(w.run(w.cast.qcHead, (c) => proposeVendorRoute(c, exc.materialCode, 'a long enough statistical justification', 'REF-1')))).toMatch(
      /EBMR-IAM-040 .*MATERIAL\.QA_DISPOSITION/,
    );
    // Proposed but not signed: still not enabled.
    const routeId = await w.run(w.cast.qa, (c) => proposeVendorRoute(c, exc.materialCode, 'a long enough statistical justification', 'REF-1'));
    expect(await refusal(w.run(w.cast.qa, (c) => c.query('select site.enable_vendor_route($1, $2)', [routeId, '00000000-0000-4000-8000-000000000002'])))).toMatch(/EBMR-ESIG-070/);
    const sig = await w.sign(w.cast.qcHead, exc.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    expect(await refusal(w.run(w.cast.qcHead, async (c) => changeLotStatus(c, exc.lotId, 'RELEASE', await w.version(exc.lotId), sig, 'VENDOR_HISTORY')))).toMatch(/has not enabled/);
    const vsig = await signFor(db, w.cast.qa, { type: 'vendor_route', id: routeId }, 'VENDOR_ROUTE_ENABLED', 'PROPOSED');
    await w.run(w.cast.qa, (c) => c.query('select site.enable_vendor_route($1, $2)', [routeId, vsig]));
    await w.run(w.cast.qcHead, async (c) => changeLotStatus(c, exc.lotId, 'RELEASE', await w.version(exc.lotId), sig, 'VENDOR_HISTORY'));
    // An API lot is never released on vendor history, even with an identity result.
    await w.identity(api.lotId);
    const asig = await w.sign(w.cast.qcHead, api.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    expect(await refusal(w.run(w.cast.qcHead, async (c) => changeLotStatus(c, api.lotId, 'RELEASE', await w.version(api.lotId), asig, 'VENDOR_HISTORY')))).toMatch(
      /only for excipients/,
    );
    // QA withdraws the route: an India-only batch can no longer use the lot without an identity result.
    const domestic = await w.batch(['IN']);
    const res = await w.reserve(exc.lotId, domestic, '1');
    await w.run(w.cast.qa, (c) => disableVendorRoute(c, routeId, 'supplier audit finding'));
    expect(await refusal(w.consume(domestic, res, exc.materialCode, '1'))).toMatch(/EBMR-SITE-169 .*no longer has enabled/);
  });

  it('[IN-24] a failing identity result blocks release and use whatever the route or markets', async () => {
    const lot = await w.receive('EXCIPIENT');
    await w.enableVendorHistory(lot.materialCode);
    await w.identity(lot.lotId, 'FAIL');
    const sig = await w.sign(w.cast.qcHead, lot.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    expect(await refusal(w.run(w.cast.qcHead, async (c) => changeLotStatus(c, lot.lotId, 'RELEASE', await w.version(lot.lotId), sig, 'VENDOR_HISTORY')))).toMatch(
      /a failing identity result is recorded/,
    );
  });
});

describe('consumption guard (INV-13, INV-14, PR-18)', () => {
  it('[INV-13][INV-14] each consumption writes its genealogy row with the lot quantity in the same transaction; the quantity never goes negative; the lot is CONSUMED at zero', async () => {
    const lot = await w.releasedLot('API');
    const batch = await w.batch(['IN', 'EU']);
    expect(await refusal(w.reserve(lot.lotId, batch, '10.001'))).toMatch(/EBMR-SITE-145 .*10\.000 kg available/);
    const res = await w.reserve(lot.lotId, batch, '10');
    expect(await refusal(w.reserve(lot.lotId, await w.batch(['IN']), '0.001'))).toMatch(/EBMR-SITE-145 .*has 0\.000 kg available/);
    await w.consume(batch, res, lot.materialCode, '4');
    expect(await refusal(w.consume(batch, res, lot.materialCode, '6.5'))).toMatch(/EBMR-SITE-168 the reservation has 6 kg left/);
    expect(await refusal(w.consume(batch, res, lot.materialCode, '-1'))).toMatch(/EBMR-SITE-167/);
    const last = await w.consume(batch, res, lot.materialCode, '6');
    expect(last).toMatchObject({ quantity_after: '0.000', lot_state: 'CONSUMED', batch_number: batch.number });
    const { rows } = await db.app.query<{ q: string; b: string; a: string; batch_id: string; markets: string[] }>(
      'select quantity::text as q, quantity_before::text as b, quantity_after::text as a, batch_id, market_set as markets from site.lot_consumption where lot_id = $1 order by consumed_at',
      [lot.lotId],
    );
    expect(rows).toEqual([
      { q: '4', b: '10.000', a: '6.000', batch_id: batch.id, markets: ['IN', 'EU'] },
      { q: '6', b: '6.000', a: '0.000', batch_id: batch.id, markets: ['IN', 'EU'] },
    ]);
    expect(await w.run(w.cast.warehouse, (c) => lotUsage(c, lot.lotId))).toMatchObject({ state: 'CONSUMED', usageStatus: 'CONSUMED', quantity: '0.000', available: '0.000' });
    // Every consumed quantity is accounted for: received = remaining + consumed (INV-13).
    const { rows: sum } = await db.app.query<{ ok: boolean }>(
      'select site.lot_quantity(l.id) = 0 and l.received_quantity = (select sum(c.quantity) from site.lot_consumption c where c.lot_id = l.id) as ok from site.material_lot l where l.id = $1',
      [lot.lotId],
    );
    expect(sum[0]?.ok).toBe(true);
  });

  it('[INV-13][PR-18] the guard: right material, the reservation\'s own batch, not revoked, not expired, the dispenser\'s permission', async () => {
    const lot = await w.releasedLot('API');
    const batch = await w.batch(['IN']);
    const other = await w.batch(['IN']);
    const res = await w.reserve(lot.lotId, batch, '5');
    expect(await refusal(w.consume(batch, res, 'WRONG-MATERIAL', '1'))).toMatch(/EBMR-SITE-161 wrong material/);
    expect(await refusal(w.consume(other, res, lot.materialCode, '1'))).toMatch(/EBMR-SITE-162 the reservation is for batch/);
    expect(await refusal(w.consume(batch, res, lot.materialCode, '1', w.cast.warehouse))).toMatch(/EBMR-IAM-040 .*DISPENSE\.EXECUTE/);
    expect(await refusal(w.consume(batch, res, lot.materialCode, '1', w.cast.admin))).toMatch(/EBMR-IAM-042/);
    // An expired reservation is refused (its expiry moved into the past).
    const late = await w.reserve(lot.lotId, other, '1');
    await w.timeTravel("update site.lot_reservation set expires_at = clock_timestamp() - interval '1 second' where id = $1", [late]);
    expect(await refusal(w.consume(other, late, lot.materialCode, '1'))).toMatch(/EBMR-SITE-164 the reservation expired/);
    // An expired reservation no longer holds quantity.
    expect((await w.run(w.cast.warehouse, (c) => lotUsage(c, lot.lotId)))?.available).toBe('5.000');
    // A cancelled reservation is refused.
    await w.run(w.cast.warehouse, (c) => cancelReservation(c, res, 'batch rescheduled'));
    expect(await refusal(w.consume(batch, res, lot.materialCode, '1'))).toMatch(/EBMR-SITE-163 the reservation was revoked: reservation cancelled: batch rescheduled/);
    // An unknown batch: nothing is consumed into a batch the edition does not hold.
    expect(await refusal(w.consume({ id: '00000000-0000-4000-8000-000000000003', number: 'NOPE', markets: ['IN'] }, res, lot.materialCode, '1'))).toMatch(/EBMR-RCP-431/);
  });

  it('[PR-18] a lot past its retest instant, or past expiry, is blocked at reservation and at consumption; the usage status shows RETEST_DUE / EXPIRED', async () => {
    const lot = await w.releasedLot('API', { retestAt: '2029-01-01T00:00:00Z' });
    const batch = await w.batch(['IN']);
    const res = await w.reserve(lot.lotId, batch, '2');
    await w.timeTravel("update site.material_lot set retest_at = clock_timestamp() - interval '1 second' where id = $1", [lot.lotId]);
    expect(await refusal(w.consume(batch, res, lot.materialCode, '1'))).toMatch(/EBMR-SITE-166 lot .* was due for retest at .* \(PR-18\)/);
    expect(await refusal(w.reserve(lot.lotId, batch, '1'))).toMatch(/EBMR-SITE-142 .*due for retest/);
    expect((await w.run(w.cast.warehouse, (c) => lotUsage(c, lot.lotId)))?.usageStatus).toBe('RETEST_DUE');

    const lot2 = await w.releasedLot('API');
    const res2 = await w.reserve(lot2.lotId, batch, '2');
    await w.timeTravel("update site.material_lot set expires_at = clock_timestamp() - interval '1 second' where id = $1", [lot2.lotId]);
    expect(await refusal(w.consume(batch, res2, lot2.materialCode, '1'))).toMatch(/EBMR-SITE-166 lot .* expired at/);
    expect((await w.run(w.cast.warehouse, (c) => lotUsage(c, lot2.lotId)))?.usageStatus).toBe('EXPIRED');
  });

  it('[INV-13][IN-24] putting a lot ON_HOLD revokes its open reservations; consumption against them stays refused after UNHOLD', async () => {
    const lot = await w.releasedLot('API');
    const batch = await w.batch(['IN']);
    const res = await w.reserve(lot.lotId, batch, '3');
    await w.consume(batch, res, lot.materialCode, '1');
    let sig = await w.decide(w.cast.qa, lot.lotId, 'HOLD', 'RELEASED');
    // A QA decision states its reason.
    expect(await refusal(w.run(w.cast.qa, async (c) => changeLotStatus(c, lot.lotId, 'HOLD', await w.version(lot.lotId), sig)))).toMatch(/platform\.reason_given/);
    const hold = await w.run(w.cast.qa, async (c) => changeLotStatus(c, lot.lotId, 'HOLD', await w.version(lot.lotId), sig), 'supplier complaint under investigation');
    expect(hold).toMatchObject({ to: 'ON_HOLD', revokedReservations: 1 });
    const { rows } = await db.app.query<{ kind: string; cause: string; reason: string }>(
      'select kind, cause, reason_text as reason from site.lot_reservation_revocation where reservation_id = $1',
      [res],
    );
    // The revocation names the transition and carries QA's own reason for it; the system writes no reason.
    expect(rows.map((r) => [r.kind, r.reason])).toEqual([['STATUS_CHANGE', 'supplier complaint under investigation']]);
    expect(rows[0]?.cause).toMatch(/RELEASED -> ON_HOLD/);
    expect(await refusal(w.consume(batch, res, lot.materialCode, '1'))).toMatch(/EBMR-SITE-163 the reservation was revoked/);
    expect(await refusal(w.reserve(lot.lotId, batch, '1'))).toMatch(/EBMR-SITE-141 .*ON_HOLD/);
    sig = await w.decide(w.cast.qa, lot.lotId, 'UNHOLD', 'ON_HOLD');
    await w.run(w.cast.qa, async (c) => changeLotStatus(c, lot.lotId, 'UNHOLD', await w.version(lot.lotId), sig), 'investigation closed, no impact');
    expect(await refusal(w.consume(batch, res, lot.materialCode, '1'))).toMatch(/EBMR-SITE-163/);
    const again = await w.reserve(lot.lotId, batch, '2');
    expect(await w.consume(batch, again, lot.materialCode, '2')).toMatchObject({ quantity_after: '7.000' });
  });
});

describe('what the release signature covers (review backlog item 6; sql/0720)', () => {
  const signedContent = async (lotId: string) =>
    (await db.admin.query<{ c: { content: Record<string, unknown>; content_version: number } }>('select site.material_lot_content($1) as c', [lotId])).rows[0]?.c;
  const SUPERSEDED = /EBMR-PLAT-0\d\d .*(superseded|signed again|SUPERSEDED)/i;

  it('[IN-24][DI-37] the signed content shows the release route and the received quantity; a signature over IDENTITY_TESTED content cannot release on VENDOR_HISTORY', async () => {
    const lot = await w.receive('EXCIPIENT');
    await w.enableVendorHistory(lot.materialCode);
    expect((await signedContent(lot.lotId))?.content).toMatchObject({ release_route: 'VENDOR_HISTORY', received_quantity: '10.000' });
    await w.identity(lot.lotId);
    expect((await signedContent(lot.lotId))?.content).toMatchObject({ release_route: 'IDENTITY_TESTED', received_quantity: '10.000' });
    const sig = await w.sign(w.cast.qcHead, lot.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    // Every other condition of the vendor-history route holds (an enabled excipient, no failing result), yet the signature covers IDENTITY_TESTED.
    expect(await refusal(w.run(w.cast.qcHead, async (c) => changeLotStatus(c, lot.lotId, 'RELEASE', await w.version(lot.lotId), sig, 'VENDOR_HISTORY')))).toMatch(
      /EBMR-PLAT-068 .*release_route_satisfied: the release signature covers lot .* with release route IDENTITY_TESTED .*EBMR-SITE-112/,
    );
    await w.run(w.cast.qcHead, async (c) => changeLotStatus(c, lot.lotId, 'RELEASE', await w.version(lot.lotId), sig, 'IDENTITY_TESTED'));
    expect((await w.run(w.cast.warehouse, (c) => lotUsage(c, lot.lotId)))?.releaseRoute).toBe('IDENTITY_TESTED');
    expect((await signedContent(lot.lotId))?.content).toMatchObject({ release_route: 'IDENTITY_TESTED' });
  });

  it('[IN-24][DI-37] a signature over VENDOR_HISTORY content cannot release on IDENTITY_TESTED: the identity result that would allow it supersedes the signature', async () => {
    const lot = await w.receive('EXCIPIENT');
    await w.enableVendorHistory(lot.materialCode);
    const sig = await w.sign(w.cast.qcHead, lot.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    // Without an identity result the identity-tested route is refused outright.
    expect(await refusal(w.run(w.cast.qcHead, async (c) => changeLotStatus(c, lot.lotId, 'RELEASE', await w.version(lot.lotId), sig, 'IDENTITY_TESTED')))).toMatch(
      /has no passing identity result/,
    );
    // Once QC records one, the content (and the route it shows) changes, so the signature no longer authorises either route.
    await w.identity(lot.lotId);
    expect(await refusal(w.run(w.cast.qcHead, async (c) => changeLotStatus(c, lot.lotId, 'RELEASE', await w.version(lot.lotId), sig, 'IDENTITY_TESTED')))).toMatch(SUPERSEDED);
    expect(await refusal(w.run(w.cast.qcHead, async (c) => changeLotStatus(c, lot.lotId, 'RELEASE', await w.version(lot.lotId), sig, 'VENDOR_HISTORY')))).toMatch(SUPERSEDED);
    const { rows } = await db.app.query<{ status: string }>("select esig.signature_state($1) ->> 'status' as status", [sig]);
    expect(rows[0]?.status).toBe('SUPERSEDED_BY_CHANGE');
    // A new signature over the new content releases on the route it shows.
    const fresh = await w.sign(w.cast.qcHead, lot.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    await w.run(w.cast.qcHead, async (c) => changeLotStatus(c, lot.lotId, 'RELEASE', await w.version(lot.lotId), fresh, 'IDENTITY_TESTED'));
  });

  it('[IN-24][DI-37][INV-13] the release signature covers the received quantity; consuming from the released lot does not supersede it', async () => {
    const lot = await w.receive('API');
    await w.identity(lot.lotId);
    expect((await signedContent(lot.lotId))?.content).toMatchObject({ received_quantity: '10.000', release_route: 'IDENTITY_TESTED' });
    expect((await signedContent(lot.lotId))?.content).not.toHaveProperty('current_quantity');
    const sig = await w.sign(w.cast.qcHead, lot.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    await w.run(w.cast.qcHead, async (c) => changeLotStatus(c, lot.lotId, 'RELEASE', await w.version(lot.lotId), sig, 'IDENTITY_TESTED'));
    // After the release its own state entry is the last change the signature saw.
    const status = async () => (await db.app.query<{ s: string }>("select esig.signature_state($1) ->> 'status' as s", [sig])).rows[0]?.s;
    const statusAfterRelease = await status();
    const before = await signedContent(lot.lotId);
    const batch = await w.batch(['IN']);
    const res = await w.reserve(lot.lotId, batch, '3');
    await w.consume(batch, res, lot.materialCode, '1');
    await w.consume(batch, res, lot.materialCode, '1');
    // Consumption changes neither the signed content nor the signature's status, and leaves no change-log entry on the lot.
    expect(await signedContent(lot.lotId)).toEqual(before);
    expect(await status()).toBe(statusAfterRelease);
    const { rows: changes } = await db.admin.query("select 1 from esig.content_change where aggregate_ref = $1 and table_name = 'site.lot_consumption'", [`material_lot:${lot.lotId}`]);
    expect(changes).toEqual([]);
    // A QA decision signed before a consumption still applies after it.
    const hold = await w.decide(w.cast.qa, lot.lotId, 'HOLD', 'RELEASED');
    await w.consume(batch, res, lot.materialCode, '1');
    expect(await w.run(w.cast.qa, async (c) => changeLotStatus(c, lot.lotId, 'HOLD', await w.version(lot.lotId), hold), 'complaint')).toMatchObject({ to: 'ON_HOLD' });
    const { rows } = await db.admin.query('select * from esig.verify_signatures() where signature_id = any($1::uuid[])', [[sig, hold]]);
    expect(rows).toEqual([]);
    expect((await db.admin.query("select 1 from esig.signed_table where table_name = 'site.lot_consumption'::regclass")).rows).toEqual([]);
  });
});

describe('witnessed destruction (IN-24 (a))', () => {
  it('[IN-24] DESTROYED only with a destruction record and a witness other than its performer', async () => {
    const lot = await w.receive('API');
    const rej = await w.sign(w.cast.qcHead, lot.lotId, 'MATERIAL_LOT_REJECTED', 'QUARANTINE');
    await w.run(w.cast.qcHead, async (c) => changeLotStatus(c, lot.lotId, 'REJECT', await w.version(lot.lotId), rej), 'assay out of specification');
    const early = await w.sign(w.cast.witness, lot.lotId, 'MATERIAL_DESTRUCTION_WITNESSED', 'REJECTED');
    expect(await refusal(w.run(w.cast.warehouse, async (c) => destroyLot(c, lot.lotId, await w.version(lot.lotId), early)))).toMatch(/EBMR-SITE-151/);
    await w.run(w.cast.warehouse, (c) => recordLotDestruction(c, lot.lotId, 'incineration by approved contractor', 'rejected lot'));
    // The witnessing signed before the record existed was superseded by it (INV-09).
    expect(await refusal(w.run(w.cast.warehouse, async (c) => destroyLot(c, lot.lotId, await w.version(lot.lotId), early)))).toMatch(/EBMR-PLAT-0\d\d .*(superseded|signed again|SUPERSEDED)/i);
    // The performer cannot witness his own destruction.
    const performerAsWitness = await withSecondRole(db, w.cast.warehouse, 'VERIFIER');
    expect(await refusal(w.sign(performerAsWitness, lot.lotId, 'MATERIAL_DESTRUCTION_WITNESSED', 'REJECTED'))).toMatch(/EBMR-ESIG-0\d\d/);
    const sig = await w.sign(w.cast.witness, lot.lotId, 'MATERIAL_DESTRUCTION_WITNESSED', 'REJECTED');
    // Only the performer fires DESTROY: not another warehouse person, not the witness.
    const otherWarehouse = await signerActor(db, 'WAREHOUSE_LABELLING');
    expect(await refusal(w.run(otherWarehouse, async (c) => destroyLot(c, lot.lotId, await w.version(lot.lotId), sig)))).toMatch(/EBMR-SITE-151/);
    expect(await refusal(w.run(w.cast.witness, async (c) => destroyLot(c, lot.lotId, await w.version(lot.lotId), sig)))).toMatch(/EBMR-IAM-040 .*MATERIAL\.HANDLE/);
    expect(await w.run(w.cast.warehouse, async (c) => destroyLot(c, lot.lotId, await w.version(lot.lotId), sig))).toMatchObject({ to: 'DESTROYED' });
  });
  it('[IN-24] a person who consumed from a lot does not witness its destruction (stricter default, sql/0721)', async () => {
    const lot = await w.releasedLot('API');
    const batch = await w.batch(['IN']);
    const res = await w.reserve(lot.lotId, batch, '2');
    await w.consume(batch, res, lot.materialCode, '1');
    const recall = await w.decide(w.cast.qa, lot.lotId, 'RECALL', 'RELEASED');
    await w.run(w.cast.qa, async (c) => changeLotStatus(c, lot.lotId, 'RECALL', await w.version(lot.lotId), recall), 'supplier recall notice');
    await w.run(w.cast.warehouse, (c) => recordLotDestruction(c, lot.lotId, 'incineration by approved contractor', 'recalled lot'));
    // The dispenser also holds the verifier role, so only the rule refuses him.
    const consumerAsWitness = await withSecondRole(db, w.cast.dispenser, 'VERIFIER');
    const bad = await w.sign(consumerAsWitness, lot.lotId, 'MATERIAL_DESTRUCTION_WITNESSED', 'RECALLED');
    expect(await refusal(w.run(w.cast.warehouse, async (c) => destroyLot(c, lot.lotId, await w.version(lot.lotId), bad)))).toMatch(
      /EBMR-PLAT-068 .*destruction_witnessed: the witness of a destruction did not consume from the lot \(EBMR-SITE-152\)/,
    );
    const sig = await w.sign(w.cast.witness, lot.lotId, 'MATERIAL_DESTRUCTION_WITNESSED', 'RECALLED');
    expect(await w.run(w.cast.warehouse, async (c) => destroyLot(c, lot.lotId, await w.version(lot.lotId), sig))).toMatchObject({ to: 'DESTROYED' });
  });
});

describe('no bypass (INV-13; ADR 0012)', () => {
  it('[INV-13] the application role cannot write lots, reservations or consumptions directly, cannot call the site consumption guard, and cannot fire a lot transition directly', async () => {
    const lot = await w.releasedLot('API');
    const batch = await w.batch(['IN']);
    const res = await w.reserve(lot.lotId, batch, '2');
    for (const sql of [
      "update site.material_lot set received_quantity = 100 where id = $1",
      "update site.lot_reservation set quantity = 100 where lot_id = $1",
      "insert into site.lot_reservation_revocation (reservation_id, kind, cause, revoked_by_person, revoked_by_account) select id, 'STATUS_CHANGE', 'x', lot_id, lot_id from site.lot_reservation where lot_id = $1",
      "insert into site.lot_consumption (lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after, market_set, identity_basis, consumed_by_person, consumed_by_account, xact_id) select id, id, id, 'X', 'TABLETS', material_code, 1, unit, 1, 0, '{IN}', 'IDENTITY_RESULT', id, id, 0 from site.material_lot where id = $1",
      "insert into site.lot_reservation (lot_id, batch_id, batch_number, edition, quantity, unit, expires_at, lot_state_version, reserved_by_person, reserved_by_account) select id, id, 'X', 'TABLETS', 1, unit, now(), 1, id, id from site.material_lot where id = $1",
      "insert into site.lot_identity_result (lot_id, result, method_reference, test_reference, recorded_by_person, recorded_by_account) values ($1, 'PASS', 'm', 't', $1, $1)",
      "insert into site.lot_status_command (lot_id, event, from_state, person_id, account_id, xact_id) values ($1, 'HOLD', 'RELEASED', $1, $1, txid_current())",
      "delete from site.material_lot where id = $1",
    ]) {
      expect(await refusal(w.run(w.cast.dispenser, (c) => c.query(sql, [lot.lotId]), 'bypass'))).toMatch(/permission denied/);
    }
    expect(await refusal(w.run(w.cast.dispenser, (c) => c.query("select site.consume_reservation($1, $2, $3, '{IN}', $4, 1, 'kg')", [res, batch.id, batch.number, lot.materialCode])))).toMatch(
      /permission denied for function consume_reservation/,
    );
    // A direct transition, even with a valid QA signature, is refused: it would skip the reservation revocation.
    const sig = await w.decide(w.cast.qa, lot.lotId, 'HOLD', 'RELEASED');
    expect(await refusal(w.run(w.cast.qa, async (c) => c.query("select platform.transition('material_lot', 'material_lot', $1, 'HOLD', $2::bigint, jsonb_build_object('signature_id', $3::text))", [lot.lotId, await w.version(lot.lotId), sig]), 'bypass'))).toMatch(
      /EBMR-PLAT-068 .*command_recorded/,
    );
    // The rules hold for owner-level code too: lots and reservations are insert-only, and a consumption must start from
    // the lot's current (derived) quantity.
    expect(await refusal(db.admin.query("update site.material_lot set expires_at = '2031-01-01' where id = $1", [lot.lotId]))).toMatch(/EBMR-AUDIT-004 .*insert-only/);
    expect(await refusal(db.admin.query('update site.lot_reservation set quantity = 100 where id = $1', [res]))).toMatch(/EBMR-AUDIT-004/);
    const forged = (before: string, after: string) =>
      withCommand(db.admin, as(w.cast.dispenser), (c) =>
        c.query(
          `insert into site.lot_consumption (lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after,
                                             market_set, identity_basis, consumed_by_person, consumed_by_account, xact_id)
           select l.id, $2, $3, $4, 'TABLETS', l.material_code, $5::numeric - $6::numeric, l.unit, $5, $6, '{IN}', 'IDENTITY_RESULT', l.id, l.id, 0 from site.material_lot l where l.id = $1`,
          [lot.lotId, res, batch.id, batch.number, before, after],
        ),
      );
    expect(await refusal(forged('99', '98'))).toMatch(/EBMR-SITE-121 a consumption starts from the lot's current quantity 10\.000/);
    // Never negative, even for a forged row that starts from the right quantity.
    expect(await refusal(forged('10.000', '-1'))).toMatch(/check constraint/);
    expect((await w.run(w.cast.warehouse, (c) => lotUsage(c, lot.lotId)))?.quantity).toBe('10.000');
  });

  it('[INV-13] a reservation is a positive quantity in the lot\'s unit, for a usable lot, expiring before the lot\'s dates', async () => {
    const lot = await w.releasedLot('API', { retestAt: '2029-01-01T00:00:00Z' });
    const batch = await w.batch(['IN']);
    const base = { lotId: lot.lotId, batchId: batch.id, batchNumber: batch.number, edition: 'TABLETS' as const, unit: 'kg', expiresAt: await w.isoIn(600) };
    expect(await refusal(w.run(w.cast.warehouse, (c) => reserveLot(c, { ...base, quantity: '0' })))).toMatch(/EBMR-SITE-143/);
    expect(await refusal(w.run(w.cast.warehouse, (c) => reserveLot(c, { ...base, quantity: '1', unit: 'g' })))).toMatch(/EBMR-SITE-143/);
    expect(await refusal(w.run(w.cast.warehouse, (c) => reserveLot(c, { ...base, quantity: '1', expiresAt: '2029-06-01T00:00:00Z' })))).toMatch(/EBMR-SITE-144/);
    expect(await refusal(w.run(w.cast.warehouse, (c) => reserveLot(c, { ...base, quantity: '1', expiresAt: '2020-01-01T00:00:00Z' })))).toMatch(/EBMR-SITE-144/);
    expect(await refusal(w.run(w.cast.dispenser, (c) => reserveLot(c, { ...base, quantity: '1' })))).toMatch(/EBMR-IAM-040 .*MATERIAL\.HANDLE/);
  });
});

describe('invariants after every scenario above', () => {
  it('[INV-13][INV-14] no lot quantity is negative, every lot\'s received quantity equals its quantity plus its consumptions, every consumption has its reservation and batch, and lot states follow the published machine', async () => {
    const { rows: bad } = await db.app.query(
      `select l.lot_code from site.material_lot l
        where site.lot_quantity(l.id) < 0
           or exists (select 1 from site.lot_consumption c where c.lot_id = l.id and c.quantity_after < 0)
       union all
       select c.id::text from site.lot_consumption c join site.lot_reservation r on r.id = c.reservation_id
        where r.lot_id <> c.lot_id or r.batch_id <> c.batch_id or r.batch_number <> c.batch_number
           or (select sum(x.quantity) from site.lot_consumption x where x.reservation_id = r.id) > r.quantity`,
    );
    expect(bad).toEqual([]);
    const { rows: consumed } = await db.app.query<{ n: string }>('select count(*)::text as n from site.lot_consumption');
    expect(Number(consumed[0]?.n)).toBeGreaterThan(0);
    expect((await db.app.query("select * from platform.state_violations() where aggregate_type = 'material_lot'")).rows).toEqual([]);
  });
});
