/**
 * Stale mirrors fail closed at equipment use and at release (recipe-core 0950, 0951; site services 0925; Phase 6 slice
 * 6a, builder B; DI-31, INV-26, IN-25, PR-23; D-P6a-3, D-P6a-5). The CMMS adapter's calibrations and work orders reach
 * the use guard; a stale CMMS mirror refuses the use and names the mirror; the QMS status is fetched live inside the
 * release transaction and a release without that fetch, with an older one, with an open QMS deviation or with a changed
 * version token is refused, also for a direct insert. As the application role through real identities.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { signerActor } from '../../../kernel/test/continuity/helpers.ts';
import { expectRefused } from '../../../kernel/test/identity/helpers.ts';
import { seedAdministration, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { ageMirror, count, envelopeFor, nowUs, receive, registerAdapter, setMirrorMode, syncMirror, type TestAdapter } from '../../../kernel/test/integrations/support.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { DAY, PlantWorld, seedPlantCast } from '../plant/support.ts';

let db: TestDatabase;
let w: PlantWorld;
let cmms: TestAdapter;
let qmsAdapter: TestAdapter;
let ap: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAdministration(db);
  w = new PlantWorld(db, await seedPlantCast(db));
  cmms = await registerAdapter(db, 'CMMS');
  qmsAdapter = await registerAdapter(db, 'QMS');
  ap = await signerActor(db, 'AUTHORISED_PERSON');
}, 300_000);
afterAll(async () => {
  await db.drop();
});

let serial = 0;
const unique = (prefix: string): string => `${prefix}${randomUUID().slice(0, 6).toUpperCase()}${(serial++).toString()}`;

/** A material lot of SITE-1 (fixture rows, triggers off: the lot's own life cycle is tested elsewhere). */
async function fixtureLot(): Promise<{ lotId: string; lotCode: string }> {
  const lotId = randomUUID();
  const lotCode = unique('L-');
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                      received_by_person, received_by_account, correlation_id)
       values ($1, 'SITE-1', $2, 'FG-1', 'Finished goods', 'FINISHED', 1000, 'units', '2030-01-01T00:00:00Z', $3, $3, $3)`,
      [lotId, lotCode, randomUUID()],
    );
    await c.query('commit');
  } finally {
    c.release();
  }
  return { lotId, lotCode };
}

const day = async (n: number): Promise<string> => (await db.admin.query<{ d: string }>('select (site.site_today() + $1::integer)::text as d', [n])).rows[0]!.d;
const calibration = (equipmentCode: string, over: Record<string, unknown> = {}) => ({
  equipmentCode, calibrationRef: unique('CAL-'), performedAt: nowUs(), result: 'PASS', dueOn: '2099-12-31', ...over,
});
const sendCal = (payload: unknown, o = {}) => receive(db, cmms, 'plant.receive_cmms_calibration', envelopeFor(cmms, 'cmms.calibration', payload, o));
const sendWo = (payload: unknown) => receive(db, cmms, 'plant.receive_cmms_maintenance', envelopeFor(cmms, 'cmms.maintenance', payload));

describe('the CMMS mirror at equipment use (DI-31, IN-25, PR-23)', () => {
  it('[DI-31] stale CMMS mirror: an equipment use is refused and names the calibration mirror', async () => {
    const press = await w.press({ calibrationRequired: true });
    const product = await w.product();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    await setMirrorMode(db, 'CMMS_CALIBRATION', 'MIRROR');
    await expectRefused(w.startUse(press.code, 'CM-1', product), 'EBMR-INT-010', /CMMS mirror CMMS_CALIBRATION is stale: it has never synchronised.*call the CMMS system owner/);
    await syncMirror(db, cmms, 'CMMS_CALIBRATION');
    // The heartbeat stops while the calibration data stays: after the 60-minute bound the use is refused again.
    await ageMirror(db, 'CMMS_CALIBRATION', 2 * 3600);
    await expectRefused(w.startUse(press.code, 'CM-1', product), 'EBMR-INT-010', /CMMS mirror CMMS_CALIBRATION is stale: last synchronised 72\d\d s ago, more than its bound of 3600 s/);
    // A unit without calibration does not read the calibration mirror.
    const blender = await w.press();
    await w.clean('EQUIPMENT', blender.code, 'MAJOR');
    await expect(w.startUse(blender.code, 'CM-2', product)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await syncMirror(db, cmms, 'CMMS_CALIBRATION');
    await expect(w.startUse(press.code, 'CM-1', product)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await setMirrorMode(db, 'CMMS_CALIBRATION', 'STAND_IN');
  });

  it('[DI-31] stale CMMS maintenance mirror: every equipment use is refused and names the mirror; STAND_IN has no bound', async () => {
    const press = await w.press();
    const product = await w.product();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    await setMirrorMode(db, 'CMMS_MAINTENANCE', 'MIRROR');
    await expectRefused(w.startUse(press.code, 'MM-1', product), 'EBMR-INT-010', /CMMS mirror CMMS_MAINTENANCE is stale/);
    await setMirrorMode(db, 'CMMS_MAINTENANCE', 'STAND_IN');
    await expect(w.startUse(press.code, 'MM-1', product)).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DI-31][PR-23] CMMS calibrations reach the use guard: a FAIL blocks the unit, a PASS with a future due date frees it; manual entries are refused in MIRROR', async () => {
    const press = await w.press({ calibrationRequired: true });
    const product = await w.product();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    await setMirrorMode(db, 'CMMS_CALIBRATION', 'MIRROR');
    await syncMirror(db, cmms, 'CMMS_CALIBRATION');
    // The modes never mix: the built-in logbook entry is refused while the CMMS holds calibrations.
    await expect(w.calibrate(press.code, 30 * DAY)).rejects.toThrow(/EBMR-PLANT-025/);
    const failRef = unique('CAL-');
    const fail = await sendCal(calibration(press.code, { calibrationRef: failRef, result: 'FAIL', dueOn: '2001-01-01' }));
    expect(fail).toMatchObject({ outcome: 'ACCEPTED', applied: 'RECORDED' });
    await expect(w.startUse(press.code, 'CF-1', product)).rejects.toThrow(/the unit is OUT_OF_TOLERANCE .*EBMR-PLANT-061/);
    // Each CMMS calibration traces to its message (DI-31).
    expect(await count(db, 'select count(*) as n from plant.cmms_calibration_message where calibration_id = $1 and message_id = $2', [fail['calibrationId'], fail['messageId']])).toBe(1);
    // A late, older calibration never overwrites the newer one; the same reference again is a duplicate.
    await expectRefused(sendCal(calibration(press.code, { performedAt: '1700000000000000' })), 'EBMR-CMMS-004');
    await expectRefused(sendCal(calibration(press.code, { calibrationRef: failRef })), 'EBMR-CMMS-005');
    await expectRefused(sendCal(calibration(press.code, { dueOn: '2001-01-01' })), 'EBMR-CMMS-006');
    await expectRefused(sendCal(calibration('NO-SUCH-UNIT')), 'EBMR-CMMS-003', /wrong unit/);
    await expectRefused(sendCal({ ...calibration(press.code), technician: 'X' }), 'EBMR-CMMS-002');
    // An adjusted pass: left in tolerance (the unit is usable), found out of it (as found FAIL lists the batches since, PR-23).
    const adj = await sendCal(calibration(press.code, { result: 'ADJUSTED_PASS', dueOn: await day(200) }));
    expect((await db.app.query('select as_found, as_left from plant.calibration where id = $1', [adj['calibrationId']])).rows).toEqual([{ as_found: 'FAIL', as_left: 'PASS' }]);
    await expect(w.startUse(press.code, 'CF-2', product)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await setMirrorMode(db, 'CMMS_CALIBRATION', 'STAND_IN');
  });

  it('[DI-31][IN-25] CMMS work orders reach the use guard: a unit under maintenance or past its preventive due date is refused', async () => {
    const press = await w.press();
    const product = await w.product();
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    await setMirrorMode(db, 'CMMS_MAINTENANCE', 'MIRROR');
    await syncMirror(db, cmms, 'CMMS_MAINTENANCE');
    const wo = unique('WO-');
    await sendWo({ equipmentCode: press.code, workOrder: wo, kind: 'CORRECTIVE', status: 'IN_PROGRESS', dueOn: null });
    await expect(w.startUse(press.code, 'WO-1', product)).rejects.toThrow(new RegExp(`under maintenance \\(CMMS work order ${wo}\\).*EBMR-PLANT-061`));
    await sendWo({ equipmentCode: press.code, workOrder: wo, kind: 'CORRECTIVE', status: 'COMPLETED', dueOn: null });
    const pm = unique('PM-');
    await sendWo({ equipmentCode: press.code, workOrder: pm, kind: 'PREVENTIVE', status: 'OPEN', dueOn: await day(-1) });
    await expect(w.startUse(press.code, 'WO-1', product)).rejects.toThrow(new RegExp(`preventive maintenance \\(CMMS work order ${pm}\\) was due on .*EBMR-PLANT-061`));
    await sendWo({ equipmentCode: press.code, workOrder: pm, kind: 'PREVENTIVE', status: 'COMPLETED', dueOn: await day(-1) });
    await expect(w.startUse(press.code, 'WO-1', product)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await expectRefused(sendWo({ equipmentCode: 'NO-SUCH-UNIT', workOrder: wo, kind: 'CORRECTIVE', status: 'OPEN', dueOn: null }), 'EBMR-CMMS-003');
    await setMirrorMode(db, 'CMMS_MAINTENANCE', 'STAND_IN');
  });
});

describe('the QMS status at release (DI-31; D-P6a-3, D-P6a-0-11)', () => {
  const status = (deviationRef: string, s: string, token: string, lots: string[]) => ({ deviationRef, status: s, lotNumbers: lots, versionToken: token });

  /** In one transaction as the AP: the live fetch's answer recorded, then `then` (the release's work). */
  const inRelease = <T>(lotId: string, answer: unknown, then: (c: pg.PoolClient) => Promise<T>) =>
    withCommand(db.app, { ...ap }, async (c) => {
      if (answer !== undefined) await c.query('select site.record_qms_release_fetch($1, $2::jsonb)', [lotId, JSON.stringify(answer)]);
      return then(c);
    });
  const problem = (c: pg.PoolClient, lotId: string) => c.query<{ p: string | null }>('select site.qms_release_problem($1) as p', [lotId]).then((r) => r.rows[0]!.p);

  it('[DI-31] QMS unreachable at release: the release is refused and names the QMS', async () => {
    const lot = await fixtureLot();
    // STAND_IN: no QMS, nothing to fetch, no refusal.
    await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
    expect(await inRelease(lot.lotId, undefined, (c) => problem(c, lot.lotId))).toBeNull();
    await setMirrorMode(db, 'QMS_STATUS', 'MIRROR');
    await syncMirror(db, qmsAdapter, 'QMS_STATUS');
    // MIRROR and no live answer in this transaction (the QMS could not be reached): refused, naming the QMS.
    expect(await inRelease(lot.lotId, undefined, (c) => problem(c, lot.lotId))).toMatch(/^EBMR-QMS-013 the QMS status of lot .* was not fetched from the QMS in this release.*call the QMS system owner/);
    // A fetch of an earlier transaction does not count: the status is fetched inside the signing transaction.
    await inRelease(lot.lotId, [], () => Promise.resolve(undefined));
    expect(await inRelease(lot.lotId, undefined, (c) => problem(c, lot.lotId))).toMatch(/^EBMR-QMS-013/);
    expect(await inRelease(lot.lotId, [], (c) => problem(c, lot.lotId))).toBeNull();
    // The database guard: a release decision inserted directly, by any role, meets the same check.
    await expectRefused(
      withCommand(db.admin, withReason(ap), (c) => c.query("insert into recipe.manufacturer_release_decision (lot_id, decision) values ($1, 'RELEASED')", [lot.lotId])),
      'EBMR-QMS-013',
    );
    await expectRefused(
      withCommand(db.admin, withReason(ap), (c) => c.query("insert into recipe.us_disposition_decision (lot_id, decision) values ($1, 'RELEASED')", [lot.lotId])),
      'EBMR-QMS-013',
    );
    // A rejection never needs the QMS (the insert then fails on its own missing columns, not on the QMS).
    await expect(withCommand(db.admin, withReason(ap), (c) => c.query("insert into recipe.manufacturer_release_decision (lot_id, decision) values ($1, 'REJECTED')", [lot.lotId])))
      .rejects.toThrow(/null value/);
    // Only the person releasing records the fetch.
    await expectRefused(withCommand(db.app, w.cast.operator, (c) => c.query("select site.record_qms_release_fetch($1, '[]'::jsonb)", [lot.lotId])), 'EBMR-QMS-010');
  });

  it('[DI-31] a changed version token at signing refuses the release; an open QMS deviation and a fetch older than the bound refuse it too', async () => {
    await setMirrorMode(db, 'QMS_STATUS', 'MIRROR');
    await syncMirror(db, qmsAdapter, 'QMS_STATUS');
    const lot = await fixtureLot();
    const ref = unique('QD-');
    await receive(db, qmsAdapter, 'site.receive_qms_deviation_status', envelopeFor(qmsAdapter, 'qms.deviation_status', status(ref, 'OPEN', 'v1', [lot.lotCode])));
    // G-REL's QMS item shows the mirror with its version tokens; the epoch moves with them.
    const item = async () => (await db.app.query<{ i: { status: string; evidence: { label: string }[] } }>("select recipe.grel_qms_item($1, 'IN') as i", [lot.lotId])).rows[0]!.i;
    expect(await item()).toMatchObject({ status: 'RED', evidence: [{ label: `${ref} OPEN (QMS version v1)` }] });
    // The live answer matches the mirror but the deviation is open: refused, naming the QMS deviation.
    expect(await inRelease(lot.lotId, [{ deviationRef: ref, status: 'OPEN', versionToken: 'v1' }], (c) => problem(c, lot.lotId)))
      .toMatch(new RegExp(`^EBMR-QMS-015 the QMS holds 1 open deviation\\(s\\) naming lot ${lot.lotCode} \\(${ref} OPEN\\)`));
    // The QMS closed it, but the mirror the signer evaluated still says v1: the changed token refuses the release.
    await expectRefused(inRelease(lot.lotId, [{ deviationRef: ref, status: 'CLOSED', versionToken: 'v2' }], (c) => problem(c, lot.lotId)), 'EBMR-QMS-011', /version tokens differ/);
    // A stale answer (an older token than the mirror holds, or a deviation the QMS no longer lists) is refused alike.
    await receive(db, qmsAdapter, 'site.receive_qms_deviation_status', envelopeFor(qmsAdapter, 'qms.deviation_status', status(ref, 'CLOSED', 'v2', [lot.lotCode])));
    await syncMirror(db, qmsAdapter, 'QMS_STATUS');
    expect(await item()).toMatchObject({ status: 'GREEN', evidence: [{ label: `${ref} CLOSED (QMS version v2)` }] });
    await expectRefused(inRelease(lot.lotId, [{ deviationRef: ref, status: 'OPEN', versionToken: 'v1' }], () => Promise.resolve(undefined)), 'EBMR-QMS-011');
    await expectRefused(inRelease(lot.lotId, [], () => Promise.resolve(undefined)), 'EBMR-QMS-011');
    await expectRefused(inRelease(lot.lotId, [{ deviationRef: ref, status: 'CLOSED' }], () => Promise.resolve(undefined)), 'EBMR-QMS-012');
    // The matching answer passes.
    expect(await inRelease(lot.lotId, [{ deviationRef: ref, status: 'CLOSED', versionToken: 'v2' }], (c) => problem(c, lot.lotId))).toBeNull();
    // The 60 s QMS_STATUS bound is a backstop: an answer older than it in the same transaction is refused.
    const aged = await withCommand(db.admin, { ...ap }, async (c) => {
      await c.query('select site.record_qms_release_fetch($1, $2::jsonb)', [lot.lotId, JSON.stringify([{ deviationRef: ref, status: 'CLOSED', versionToken: 'v2' }])]);
      await c.query('set local session_replication_role = replica');
      await c.query("update site.qms_release_fetch set fetched_at = fetched_at - interval '2 minutes' where lot_id = $1 and xact_id = pg_current_xact_id()", [lot.lotId]);
      return problem(c, lot.lotId);
    });
    expect(aged).toMatch(/^EBMR-QMS-014 the QMS status of lot .* was fetched 1[12]\d s ago, more than the QMS_STATUS bound of 60 s/);
    await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
  });

  it('[DI-31][PR-23] G-REL carries the QMS item for a finished lot in MIRROR mode only, and the market items of US and EU for a finished lot only (mutation triage, recipe.grel_evaluate)', async () => {
    // Two fixture lots of SITE-1: one posted as a finished lot (fixture row, triggers off), one that is not.
    const finished = await fixtureLot();
    const other = await fixtureLot();
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query(
        `insert into site.finished_lot (lot_id, batch_id, batch_number, edition, product_code, strength, markets, posted_by_person, posted_by_account)
         values ($1, gen_random_uuid(), $2, 'TABLETS', 'FG-1', '10 mg', '{IN,US}', gen_random_uuid(), gen_random_uuid())`,
        [finished.lotId, unique('B-')],
      );
      await c.query('commit');
    } finally {
      c.release();
    }
    type Grel = { ready: boolean; items: { id: string; status: string }[] };
    const grel = async (lotId: string, market: string): Promise<Grel> =>
      (await db.app.query<{ g: Grel }>('select recipe.grel_evaluate($1, $2) as g', [lotId, market])).rows[0]!.g;
    const qmsItem = (g: Grel) => g.items.filter((i) => i.id === 'G2.QMS_STATUS');
    try {
      await setMirrorMode(db, 'QMS_STATUS', 'MIRROR');
      await syncMirror(db, qmsAdapter, 'QMS_STATUS');
      const ref = unique('QD-');
      await receive(db, qmsAdapter, 'site.receive_qms_deviation_status',
        envelopeFor(qmsAdapter, 'qms.deviation_status', status(ref, 'OPEN', 'v1', [finished.lotCode, other.lotCode])));
      // MIRROR: the finished lot's checklist carries the QMS item, RED for the open deviation, and is not ready.
      const g = await grel(finished.lotId, 'IN');
      expect(qmsItem(g)).toMatchObject([{ status: 'RED' }]);
      expect(g.ready).toBe(false);
      // A lot that is not a finished lot gets no QMS item, though another lot is one.
      expect(qmsItem(await grel(other.lotId, 'IN'))).toEqual([]);
      // Nor gets it the market items of US: its checklist for US is its checklist for IN.
      const us = await grel(other.lotId, 'US');
      expect(us.items.map((i) => i.id).sort()).toEqual((await grel(other.lotId, 'IN')).items.map((i) => i.id).sort());
      // STAND_IN: no QMS item at all, the finished lot's either.
      await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
      expect(qmsItem(await grel(finished.lotId, 'IN'))).toEqual([]);
    } finally {
      await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
    }
  });

  it('[DI-31] a release with a stale QMS mirror is refused even with a matching fetch record', async () => {
    await setMirrorMode(db, 'QMS_STATUS', 'MIRROR');
    try {
      const lot = await fixtureLot();
      // The QMS adapter stopped: the fetch cannot be compared with a mirror that says nothing about the QMS now.
      await syncMirror(db, qmsAdapter, 'QMS_STATUS');
      await ageMirror(db, 'QMS_STATUS', 120);
      await expectRefused(inRelease(lot.lotId, [], () => Promise.resolve(undefined)), 'EBMR-INT-010', /QMS mirror QMS_STATUS is stale: last synchronised 1[12]\d s ago, more than its bound of 60 s/);
      // The fetch matched a fresh mirror, then the mirror went stale before the decision: the release is refused, and
      // a decision inserted directly meets the same check.
      await syncMirror(db, qmsAdapter, 'QMS_STATUS');
      const late = await inRelease(lot.lotId, [], async (c) => {
        await ageMirror(db, 'QMS_STATUS', 120);
        return problem(c, lot.lotId);
      });
      expect(late).toMatch(new RegExp(`^EBMR-INT-010 the QMS mirror QMS_STATUS is stale: last synchronised 1[12]\\d s ago, more than its bound of 60 s; lot ${lot.lotCode} is not released.*call the QMS system owner`));
      await syncMirror(db, qmsAdapter, 'QMS_STATUS');
      await expectRefused(
        withCommand(db.admin, withReason(ap), async (c) => {
          await c.query('select site.record_qms_release_fetch($1, $2::jsonb)', [lot.lotId, '[]']);
          await ageMirror(db, 'QMS_STATUS', 120);
          await c.query("insert into recipe.manufacturer_release_decision (lot_id, decision) values ($1, 'RELEASED')", [lot.lotId]);
        }),
        'EBMR-INT-010',
      );
      // With the mirror fresh again, the same fetch passes.
      await syncMirror(db, qmsAdapter, 'QMS_STATUS');
      expect(await inRelease(lot.lotId, [], (c) => problem(c, lot.lotId))).toBeNull();
    } finally {
      await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
    }
  });
});
