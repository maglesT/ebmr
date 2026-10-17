/**
 * Kill tests of the qms-capa-lims-cmms mutation group, recipe-core part (recipe-core 0950 to 0952; decision 0019, Phase 6
 * exit campaign part 1): the CMMS receiving commands and the maintenance rule at equipment use, the QMS guard on every
 * release-type decision, and G-REL's QMS item.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { signerActor } from '../../../kernel/test/continuity/helpers.ts';
import { expectRefused } from '../../../kernel/test/identity/helpers.ts';
import { seedAdministration, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { envelopeFor, nowUs, acknowledgeGaps, heldHead, receive, registerAdapter, setMirrorMode, syncMirror, type TestAdapter } from '../../../kernel/test/integrations/support.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { PlantWorld, seedPlantCast } from '../plant/support.ts';

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
const day = async (n: number): Promise<string> => (await db.admin.query<{ d: string }>('select (site.site_today() + $1::integer)::text as d', [n])).rows[0]!.d;
const calibration = (equipmentCode: string, over: Record<string, unknown> = {}) => ({
  equipmentCode, calibrationRef: unique('CAL-'), performedAt: nowUs(), result: 'PASS', dueOn: '2099-12-31', ...over,
});
const sendCal = (payload: unknown, o = {}, type = 'cmms.calibration') => receive(db, cmms, 'plant.receive_cmms_calibration', envelopeFor(cmms, type, payload, o));
const sendWo = (payload: unknown, o = {}) => receive(db, cmms, 'plant.receive_cmms_maintenance', envelopeFor(cmms, 'cmms.maintenance', payload, o));
/** The adapter caught up with what it sent (refused messages included), its test gaps acknowledged. */
const sync = async (a: TestAdapter, dataClass: string): Promise<void> => {
  await acknowledgeGaps(db, a.code);
  await syncMirror(db, a, dataClass, await heldHead(db, a.code));
};
const errorOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'no error';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe('the CMMS receiving commands (DI-31, IN-25, PR-23; recipe-core 0950)', () => {
  it('[DI-31][PR-23] calibration: the message type, the mode, each malformed field, a unit without calibration and an equal timestamp are refused', async () => {
    const press = await w.press({ calibrationRequired: true });
    const plain = await w.press();
    // STAND_IN: the built-in logbook holds calibrations; a CMMS message is not applied.
    await setMirrorMode(db, 'CMMS_CALIBRATION', 'STAND_IN');
    await expectRefused(sendCal(calibration(press.code)), 'EBMR-CMMS-001', /CMMS_CALIBRATION in the built-in logbook/);
    await setMirrorMode(db, 'CMMS_CALIBRATION', 'MIRROR');
    try {
      await sync(cmms, 'CMMS_CALIBRATION');
      await expectRefused(sendCal(calibration(press.code), {}, 'cmms.maintenance'), 'EBMR-CMMS-002', /receives cmms.calibration messages, not cmms.maintenance/);
      for (const over of [{ equipmentCode: '' }, { calibrationRef: '' }, { performedAt: 'yesterday' }, { result: 'OK' }, { dueOn: '2099/12/31' }]) {
        await expectRefused(sendCal(calibration(press.code, over)), 'EBMR-CMMS-002', /equipmentCode, calibrationRef, performedAt/);
      }
      await expectRefused(sendCal(calibration(press.code, { dueOn: '2099-02-30' })), 'EBMR-CMMS-002', /2099-02-30 is not a date/);
      await expectRefused(sendCal(calibration(plain.code)), 'EBMR-CMMS-003', /is of a class without calibration/);
      const ts = nowUs();
      expect(await sendCal(calibration(press.code, { performedAt: ts }))).toMatchObject({ outcome: 'ACCEPTED', applied: 'RECORDED' });
      await expectRefused(sendCal(calibration(press.code, { performedAt: ts })), 'EBMR-CMMS-004', /is older than one already applied/);
    } finally {
      await setMirrorMode(db, 'CMMS_CALIBRATION', 'STAND_IN');
    }
  });

  it('[DI-31][IN-25] maintenance: each malformed field is refused; staleness is per unit and work order, an equal timestamp is stale; preventive work due today does not stop the unit', async () => {
    const press = await w.press();
    const other = await w.press();
    await setMirrorMode(db, 'CMMS_MAINTENANCE', 'MIRROR');
    try {
      await sync(cmms, 'CMMS_MAINTENANCE');
      const wo = (over: Record<string, unknown> = {}) => ({ equipmentCode: press.code, workOrder: unique('WO-'), kind: 'CORRECTIVE', status: 'OPEN', dueOn: null, ...over });
      await expectRefused(sendWo({ ...wo(), technician: 'X' }), 'EBMR-CMMS-002', /unknown field technician/);
      const { dueOn: _omit, ...withoutDue } = wo();
      for (const bad of [wo({ equipmentCode: '' }), wo({ workOrder: '' }), wo({ kind: 'BREAKDOWN' }), wo({ status: 'DONE' }), withoutDue, wo({ dueOn: '2099/12/31' })]) {
        await expectRefused(sendWo(bad), 'EBMR-CMMS-002', /equipmentCode, workOrder, kind/);
      }
      await expectRefused(sendWo(wo({ dueOn: '2099-02-30' })), 'EBMR-CMMS-002', /2099-02-30 is not a date/);
      // Staleness: the same work order of the same unit at the same or an older instant is refused...
      const code = unique('WO-');
      const ts = nowUs();
      await sendWo(wo({ workOrder: code }), { sourceTimestamp: ts });
      await expectRefused(sendWo(wo({ workOrder: code, status: 'IN_PROGRESS' }), { sourceTimestamp: ts }), 'EBMR-CMMS-004', /is older than the one already applied/);
      // ...but the same work order number of another unit, and another work order of this unit, are their own records.
      const older = (BigInt(ts) - 1_000_000n).toString();
      expect(await sendWo(wo({ equipmentCode: other.code, workOrder: code }), { sourceTimestamp: older })).toMatchObject({ applied: 'RECORDED' });
      expect(await sendWo(wo(), { sourceTimestamp: older })).toMatchObject({ applied: 'RECORDED' });
      // Preventive maintenance due today is not yet overdue; due yesterday it stops the unit.
      const problems = async (equipmentId: string) => (await db.admin.query<{ p: string[] }>('select plant.cmms_maintenance_problems($1) as p', [equipmentId])).rows[0]!.p;
      const unit = await w.press();
      await sendWo({ equipmentCode: unit.code, workOrder: unique('PM-'), kind: 'PREVENTIVE', status: 'OPEN', dueOn: await day(0) });
      expect(await problems(unit.id)).toEqual([]);
      const late = unique('PM-');
      await sendWo({ equipmentCode: unit.code, workOrder: late, kind: 'PREVENTIVE', status: 'OPEN', dueOn: await day(-1) });
      expect(await problems(unit.id)).toEqual([expect.stringContaining(`preventive maintenance (CMMS work order ${late})`)]);
    } finally {
      await setMirrorMode(db, 'CMMS_MAINTENANCE', 'STAND_IN');
    }
  });
});

describe('the QMS status at every release-type decision (DI-31; recipe-core 0951)', () => {
  /** A finished lot of SITE-1 (fixture rows, triggers off). */
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
  const insert = (sql: string, lotId: string) => withCommand(db.admin, withReason(ap), (c) => c.query(sql, [lotId]));

  it('[DI-31] a QP certification made in the system and an after-release reconfirmation meet the QMS check; a refusal, a recall and a certificate from outside do not', async () => {
    await setMirrorMode(db, 'QMS_STATUS', 'MIRROR');
    try {
      await sync(qmsAdapter, 'QMS_STATUS');
      const lot = await fixtureLot();
      await expectRefused(insert("insert into recipe.qp_certification (lot_id, source, outcome) values ($1, 'IN_SYSTEM', 'CERTIFIED')", lot.lotId), 'EBMR-QMS-013');
      await expectRefused(insert("insert into recipe.after_release_decision (lot_id, act) values ($1, 'RECONFIRM')", lot.lotId), 'EBMR-QMS-013');
      for (const sql of [
        "insert into recipe.qp_certification (lot_id, source, outcome) values ($1, 'MESSAGE', 'CERTIFIED')",
        "insert into recipe.qp_certification (lot_id, source, outcome) values ($1, 'IN_SYSTEM', 'REJECTED_BY_QP')",
        "insert into recipe.after_release_decision (lot_id, act) values ($1, 'RECALL')",
      ]) {
        expect(await errorOf(insert(sql, lot.lotId))).not.toMatch(/EBMR-(QMS|INT)-0/);
      }
    } finally {
      await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
    }
  });

  it('[DI-31] G-REL\'s QMS item is never marked as changed since the review, in either mode', async () => {
    const lot = await fixtureLot();
    const item = async () => (await db.app.query<{ i: Record<string, unknown> }>("select recipe.grel_qms_item($1, 'IN') as i", [lot.lotId])).rows[0]!.i;
    await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
    expect(await item()).toMatchObject({ status: 'NA', since_review: false });
    await setMirrorMode(db, 'QMS_STATUS', 'MIRROR');
    try {
      await sync(qmsAdapter, 'QMS_STATUS');
      expect(await item()).toMatchObject({ status: 'GREEN', since_review: false });
    } finally {
      await setMirrorMode(db, 'QMS_STATUS', 'STAND_IN');
    }
  });
});
