/**
 * Material lots and LIMS, rule by rule (SQL mutation group "lots-and-lims": site services 0710 to 0762). These tests
 * close the gaps the Phase 3 exit SQL mutation run found in test/lots and test/quality: each refusal with its own code
 * and nothing else standing in for it (an unknown lot, route, reservation or result; a decision that is not one; a
 * route a RELEASE needs and nothing else takes; a destroyed lot; a destruction or a link recorded twice; a reason
 * left out), and the person rules of the signed acts (a vendor route enabled and a result approved by the person who
 * signed, a result approved by another person than its recorder).
 *
 * Controls: IN-24, PR-17, PR-18, PR-19, IN-20, DI-22, DI-33, DI-35; invariant INV-13.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext } from '../../../kernel/src/db/command.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import { changeLotStatus, destroyLot, linkDeviation, proposeVendorRoute, raiseDeviation, recordLotDestruction } from '../../src/index.ts';
import { createTestDatabase, signerActor, signFor, type TestDatabase } from '../helpers.ts';
import { refusal, seedCast, withSecondRole, World } from '../lots/support.ts';

let db: TestDatabase;
let w: World;
let qa2: SeededActor;
let qcHead2: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  qa2 = await signerActor(db, 'QA_REVIEWER');
  qcHead2 = await signerActor(db, 'HEAD_OF_QC');
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const sql = (actor: SeededActor, text: string, params: unknown[] = []): Promise<string> => refusal(w.run(actor, (c) => c.query(text, params)));

/** A lot rejected from QUARANTINE by the head of QC. */
async function rejected(): Promise<{ lotId: string }> {
  const lot = await w.receive('API');
  const rej = await w.sign(w.cast.qcHead, lot.lotId, 'MATERIAL_LOT_REJECTED', 'QUARANTINE');
  await w.run(w.cast.qcHead, async (c) => changeLotStatus(c, lot.lotId, 'REJECT', await w.version(lot.lotId), rej), 'assay out of specification');
  return lot;
}

describe('lots: each refusal on its own (site services 0712)', () => {
  it('[IN-24] an unknown lot is refused as unknown', async () => {
    expect(await sql(w.cast.analyst, "select site.record_identity_result($1, 'PASS', 'STP-1', 'AR-1')", [randomUUID()])).toMatch(/EBMR-SITE-102 unknown material lot/);
  });

  it('[IN-24][INV-13] a destroyed lot takes no result; a destruction is recorded once', async () => {
    const lot = await rejected();
    await w.run(w.cast.warehouse, (c) => recordLotDestruction(c, lot.lotId, 'incineration', 'rejected lot'));
    expect(await refusal(w.run(w.cast.warehouse, (c) => recordLotDestruction(c, lot.lotId, 'incineration', 'again')))).toMatch(/EBMR-SITE-150 the destruction of lot .* is already recorded/);
    const sig = await w.sign(w.cast.witness, lot.lotId, 'MATERIAL_DESTRUCTION_WITNESSED', 'REJECTED');
    await w.run(w.cast.warehouse, async (c) => destroyLot(c, lot.lotId, await w.version(lot.lotId), sig));
    expect(await sql(w.cast.analyst, "select site.record_identity_result($1, 'PASS', 'STP-1', 'AR-1')", [lot.lotId])).toMatch(/EBMR-SITE-106 lot .* is DESTROYED; no result is recorded/);
    expect(
      await sql(w.cast.analyst, 'select site.record_lot_test_result($1, $2::jsonb)', [lot.lotId, JSON.stringify({ testCode: 'ASSAY', purpose: 'RELEASE', value: '99', lowerLimit: '98' })]),
    ).toMatch(/EBMR-SITE-200 lot .* is DESTROYED; no result is recorded/);
  });

  it('[IN-24] a status decision is one of the decisions; a RELEASE names a known route and only a RELEASE names one', async () => {
    const lot = await w.receive('EXCIPIENT');
    const v = await w.version(lot.lotId);
    const change = (event: string | null, route: string | null) => sql(w.cast.qcHead, 'select site.change_lot_status($1, $2, $3, null, $4)', [lot.lotId, event, v, route]);
    expect(await change('CONSUME', null)).toMatch(/EBMR-SITE-110 CONSUME is not a lot status decision/);
    expect(await change(null, null)).toMatch(/EBMR-SITE-110 NULL is not a lot status decision/);
    expect(await change('RELEASE', null)).toMatch(/EBMR-SITE-111 a RELEASE records its route/);
    expect(await change('HOLD', 'IDENTITY_TESTED')).toMatch(/EBMR-SITE-111 a RELEASE records its route/);
    expect(await change('RELEASE', 'TRUSTED_SUPPLIER')).toMatch(/EBMR-SITE-111 unknown release route TRUSTED_SUPPLIER/);
  });

  it('[IN-24][DI-35] a vendor-history route: unknown, decided twice, enabled with another QA person\'s signature, a second one enabled, or disabled without being enabled or without a reason', async () => {
    const lot = await w.receive('EXCIPIENT');
    const propose = () => w.run(w.cast.qa, (c) => proposeVendorRoute(c, lot.materialCode, 'Trend of 30 supplier certificates against full tests, all within limits', 'QA-STAT-1'));
    const sign = (route: string, by: SeededActor = w.cast.qa) => signFor(db, by, { type: 'vendor_route', id: route }, 'VENDOR_ROUTE_ENABLED', 'PROPOSED');
    const ghost = randomUUID();
    expect(await sql(w.cast.qa, 'select site.enable_vendor_route($1, gen_random_uuid())', [ghost])).toMatch(/EBMR-SITE-133 unknown vendor-history route/);
    expect(await sql(w.cast.qa, "select site.disable_vendor_route($1, 'no longer')", [ghost])).toMatch(/EBMR-SITE-133 unknown vendor-history route/);
    const r1 = await propose();
    expect(await sql(w.cast.qa, "select site.disable_vendor_route($1, 'no longer')", [r1])).toMatch(/EBMR-SITE-133 the vendor-history route of .* is not enabled/);
    const s1 = await sign(r1);
    expect(await sql(qa2, 'select site.enable_vendor_route($1, $2)', [r1, s1])).toMatch(/^EBMR-SITE-134 the route is enabled by the QA person who signed it$/);
    await w.run(w.cast.qa, (c) => c.query('select site.enable_vendor_route($1, $2)', [r1, s1]));
    expect(await sql(w.cast.qa, 'select site.enable_vendor_route($1, $2)', [r1, s1])).toMatch(/EBMR-SITE-133 the vendor-history route of .* was already enabled or disabled/);
    const r2 = await propose();
    const s2 = await sign(r2);
    expect(await sql(w.cast.qa, 'select site.enable_vendor_route($1, $2)', [r2, s2])).toMatch(/EBMR-SITE-133 a vendor-history route of .* is already enabled at site/);
    expect(await sql(w.cast.qa, "select site.disable_vendor_route($1, '  ')", [r1])).toMatch(/EBMR-SITE-135 disabling a vendor-history route states the reason/);
    expect(await sql(w.cast.qa, "select site.disable_vendor_route($1, 'supplier changed')", [r1])).toBe('');
    expect(await sql(w.cast.qa, "select site.disable_vendor_route($1, 'again')", [r1])).toMatch(/EBMR-SITE-133 the vendor-history route of .* is not enabled/);
  });

  it('[INV-13][DI-22] a reservation: unknown, already revoked, or cancelled without a reason', async () => {
    const lot = await w.releasedLot('EXCIPIENT');
    const batch = await w.batch(['IN']);
    const res = await w.reserve(lot.lotId, batch, '1.000');
    expect(await sql(w.cast.warehouse, "select site.cancel_reservation($1, 'plan changed')", [randomUUID()])).toMatch(/EBMR-SITE-146 unknown reservation/);
    expect(await sql(w.cast.warehouse, "select site.cancel_reservation($1, '  ')", [res])).toMatch(/EBMR-SITE-146 cancelling a reservation states the person's own reason/);
    expect(await sql(w.cast.warehouse, "select site.cancel_reservation($1, 'plan changed')", [res])).toBe('');
    expect(await sql(w.cast.warehouse, "select site.cancel_reservation($1, 'plan changed')", [res])).toMatch(/EBMR-SITE-146 the reservation is already revoked/);
  });
});

describe('LIMS: results and their approval (site services 0740)', () => {
  const RESULT = { testCode: 'ASSAY', methodReference: 'STP-AS-01', purpose: 'RELEASE', value: '97.0', unit: '%' };
  const record = (lotId: string, p: unknown) =>
    w.run(w.cast.analyst, async (c) => (await c.query<{ r: { resultId: string } }>('select site.record_lot_test_result($1, $2::jsonb) as r', [lotId, p === null ? null : JSON.stringify(p)])).rows[0]?.r.resultId ?? '');

  it('[DI-33] a result is an object; only a revision states a revision reason', async () => {
    const lot = await w.receive('API');
    expect(await refusal(record(lot.lotId, null))).toMatch(/^EBMR-SITE-201 the result details are required$/);
    expect(await refusal(record(lot.lotId, ['ASSAY']))).toMatch(/^EBMR-SITE-201 the result details are required$/);
    expect(await refusal(record(lot.lotId, { ...RESULT, revisionReason: 'typo' }))).toMatch(/EBMR-SITE-202 only a revision states a revision reason/);
  });

  it('[DI-33][DI-35] approval: an unknown result, one approved already, its recorder, another QC person\'s signature', async () => {
    const lot = await w.receive('API');
    const id = await record(lot.lotId, RESULT);
    expect(await sql(w.cast.qcHead, 'select site.approve_lot_test_result($1, gen_random_uuid())', [randomUUID()])).toMatch(/EBMR-SITE-203 unknown lot test result/);
    // The recorder holding the approver's permission too is refused as the recorder, before any signature is read.
    const recorderAsHead = await withSecondRole(db, w.cast.analyst, 'HEAD_OF_QC');
    expect(await sql(recorderAsHead, 'select site.approve_lot_test_result($1, gen_random_uuid())', [id])).toMatch(/EBMR-SITE-204 a result is approved by a QC person other than its recorder/);
    const sig = await signFor(db, w.cast.qcHead, { type: 'lot_test_result', id }, 'QC_RESULT_APPROVED', 'RECORDED');
    expect(await sql(qcHead2, 'select site.approve_lot_test_result($1, $2)', [id, sig])).toMatch(/^EBMR-SITE-204 the approval is recorded by the QC person who signed it$/);
    await w.run(w.cast.qcHead, (c) => c.query('select site.approve_lot_test_result($1, $2)', [id, sig]));
    expect(await sql(w.cast.qcHead, 'select site.approve_lot_test_result($1, $2)', [id, sig])).toMatch(/EBMR-SITE-203 the ASSAY result is APPROVED; only a current result not yet approved/);
  });

  it('[IN-20] an OOS link: an unknown result is refused as unknown; a result is linked to its OOS record once', async () => {
    const lot = await w.receive('API');
    const id = await record(lot.lotId, RESULT);
    const sig = await signFor(db, w.cast.qcHead, { type: 'lot_test_result', id }, 'QC_RESULT_APPROVED', 'RECORDED');
    await w.run(w.cast.qcHead, (c) => c.query('select site.approve_lot_test_result($1, $2)', [id, sig]));
    expect(await sql(w.cast.analyst, 'select site.link_lot_test_oos($1, gen_random_uuid())', [randomUUID()])).toMatch(/EBMR-SITE-203 unknown lot test result/);
    const oos = await w.run(w.cast.analyst, (c) =>
      raiseDeviation(c, { kind: 'OOS', title: 'Assay below the limit', classification: 'MAJOR', riskRationale: 'Potency below the specification' }),
    );
    await w.run(w.cast.analyst, (c) => linkDeviation(c, oos.deviationId, 'LOT', lot.lotId));
    await w.run(w.cast.analyst, (c) => c.query('select site.link_lot_test_oos($1, $2)', [id, oos.deviationId]));
    expect(await sql(w.cast.analyst, 'select site.link_lot_test_oos($1, $2)', [id, oos.deviationId])).toMatch(/EBMR-SITE-205 the result is already linked to its OOS record/);
  });
});

describe('a retest decision (site services 0752)', () => {
  /** site.record_lot_retest as the database's signed writer calls it: the superuser inside the head of QC's command. */
  async function retest(lotId: string, results: string[] | null): Promise<string> {
    const ctx = await cmd(db, w.cast.qcHead);
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
      return await refusal(c.query("select site.record_lot_retest($1, clock_timestamp() + interval '30 days', $2::uuid[])", [lotId, results]));
    } finally {
      await c.query('rollback');
      c.release();
    }
  }

  it('[PR-18] a lot without a retest date, a rejected lot, no results, or results that are not the lot\'s are refused', async () => {
    const noDate = await w.receive('EXCIPIENT');
    expect(await retest(noDate.lotId, [randomUUID()])).toMatch(/EBMR-SITE-180 lot .* has no retest date/);
    const withDate = await w.receive('EXCIPIENT', { retestAt: '2029-01-01T00:00:00Z' });
    expect(await retest(withDate.lotId, null)).toMatch(/EBMR-SITE-182 a retest decision names the approved passing retest results/);
    expect(await retest(withDate.lotId, [])).toMatch(/EBMR-SITE-182 a retest decision names the approved passing retest results/);
    expect(await retest(withDate.lotId, [randomUUID()])).toMatch(/EBMR-SITE-182 a retest decision names only results of the lot/);
    const rej = await rejected();
    expect(await retest(rej.lotId, [randomUUID()])).toMatch(/EBMR-SITE-180 lot .* is REJECTED; it is not retested/);
  });
});
