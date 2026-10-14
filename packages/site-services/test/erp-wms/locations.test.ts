/**
 * Stock locations (PR-46 clause 2; site services 0911, 0913; D-P6a-7): the segregation rule the WMS asks before a move
 * (site.location_move_problem), and a move that already happened against it: recorded with an integration alarm and
 * an exception linked to the lot, which stays blocked until QA closes it with a deviation. As the application role,
 * with bypass attempts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeLotStatus } from '../../src/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers.ts';
import { refusal } from '../lots/support.ts';
import { ErpWorld } from './support.ts';

let db: TestDatabase;
let w: ErpWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  w = await ErpWorld.create(db);
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const problem = async (lotId: string, kind: string): Promise<string | null> =>
  (await db.app.query<{ p: string | null }>('select site.location_move_problem($1, $2) as p', [lotId, kind])).rows[0]?.p ?? null;

const move = (lotCode: string, toLocationKind: string, toLocation = 'WH-RLS-01') => ({
  lotNumber: lotCode, fromLocation: 'WH-QRT-01', toLocation, toLocationKind, quantity: { value: '10.000', unit: 'kg' }, movedAt: '1800000000000000',
});

describe('the location rule (PR-46 clause 2)', () => {
  it('[PR-46] moving rejected stock to a released-stock location is blocked', async () => {
    const rejected = await w.receive('API');
    const rej = await w.sign(w.cast.qcHead, rejected.lotId, 'MATERIAL_LOT_REJECTED', 'QUARANTINE');
    await w.run(w.cast.qcHead, async (c) => changeLotStatus(c, rejected.lotId, 'REJECT', await w.version(rejected.lotId), rej), 'assay out of specification');
    expect(await problem(rejected.lotId, 'RELEASED')).toMatch(/^lot .* is REJECTED: it may go only to a REJECTED, RETURNS location, not to RELEASED \(PR-46\)$/);
    expect(await problem(rejected.lotId, 'PRODUCTION')).toMatch(/REJECTED/);
    expect(await problem(rejected.lotId, 'QUARANTINE')).toMatch(/REJECTED/);
    expect(await problem(rejected.lotId, 'REJECTED')).toBeNull();
    expect(await problem(rejected.lotId, 'RETURNS')).toBeNull();
    // Quarantined stock goes nowhere it could be taken for use; released stock goes anywhere.
    const quarantined = await w.receive('API');
    expect(await problem(quarantined.lotId, 'RELEASED')).toMatch(/is QUARANTINE: it may go only to a QUARANTINE, REJECTED, RETURNS location/);
    expect(await problem(quarantined.lotId, 'PRODUCTION')).toMatch(/is QUARANTINE/);
    const released = await w.releasedLot('API');
    for (const kind of ['QUARANTINE', 'RELEASED', 'REJECTED', 'PRODUCTION', 'RETURNS']) expect(await problem(released.lotId, kind)).toBeNull();
    // Released but past its retest: not to released stock.
    await w.timeTravel("update site.material_lot set retest_at = clock_timestamp() - interval '1 day' where id = $1", [released.lotId]);
    expect(await problem(released.lotId, 'RELEASED')).toMatch(/is RELEASED but lot .* was due for retest/);
    expect(await refusal(db.app.query("select site.location_move_problem($1, 'CANTEEN')", [released.lotId]))).toMatch(/EBMR-SITE-919/);
    expect(await refusal(db.app.query("select site.location_move_problem(gen_random_uuid(), 'RELEASED')"))).toMatch(/EBMR-SITE-919 unknown lot/);
  });

  it('[PR-46][DI-31] an inbound move that already happened against the rule raises an alarm and an exception linked to the lot; the lot stays blocked until QA closes it with a deviation', async () => {
    const lot = await w.receive('API');
    const alarmsBefore = await w.alarms('OUT_OF_RANGE');
    const r = await w.inbound(w.envelope('wms.stock_move', move(lot.lotCode, 'RELEASED')));
    expect(r.outcome).toBe('ACCEPTED');
    const applied = r.applied as { moveId: string; problem: string; exceptionId: string; alarmId: string };
    expect(applied.problem).toMatch(/is QUARANTINE: it may go only to/);
    expect(await w.alarms('OUT_OF_RANGE')).toBe(alarmsBefore + 1);
    const { rows } = await db.app.query<{ lot_id: string; alarm: string; to_kind: string }>(
      'select e.lot_id, e.alarm_id::text as alarm, m.to_kind from site.lot_location_exception e join site.lot_location_move m on m.id = e.move_id where e.id = $1', [applied.exceptionId]);
    expect(rows).toEqual([{ lot_id: lot.lotId, alarm: applied.alarmId, to_kind: 'RELEASED' }]);
    expect((await db.app.query('select site.lot_current_location($1) as l', [lot.lotId])).rows[0]).toEqual({ l: { location: 'WH-RLS-01', kind: 'RELEASED', movedAtUs: '1800000000000000' } });
    // Blocked: not released, and not to released stock or production again, while the exception is open.
    await w.identity(lot.lotId);
    const sig = await w.sign(w.cast.qcHead, lot.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    const releaseIt = () => w.run(w.cast.qcHead, async (c) => changeLotStatus(c, lot.lotId, 'RELEASE', await w.version(lot.lotId), sig, 'IDENTITY_TESTED'));
    expect(await refusal(releaseIt())).toMatch(/EBMR-SITE-920 the lot is blocked by an open location exception/);
    expect(await problem(lot.lotId, 'PRODUCTION')).toMatch(/blocked by an open location exception/);
    // QA closes it only with a deviation linked to the lot, and nobody else closes it.
    const close = (actor = w.cast.qa, deviation: string, note = 'Pallet returned to quarantine; WMS rule corrected') =>
      w.run(actor, (c) => c.query('select site.resolve_lot_location_exception($1, $2, $3)', [applied.exceptionId, deviation, note]));
    const dev = await w.run(w.cast.qa, async (c) =>
      (await c.query<{ r: { deviationId: string } }>('select site.raise_deviation($1::jsonb) as r', [
        JSON.stringify({ kind: 'DEVIATION', title: 'Quarantined lot moved to released stock by the WMS', classification: 'MAJOR', riskRationale: 'Unreleased material was available for picking' }),
      ])).rows[0]?.r.deviationId ?? '');
    expect(await refusal(close(w.cast.qa, dev))).toMatch(/EBMR-SITE-921 a location exception of lot .* is closed with a deviation linked to the lot/);
    await w.run(w.cast.qa, (c) => c.query("select site.link_deviation($1, 'LOT', $2)", [dev, lot.lotId]));
    expect(await refusal(close(w.cast.warehouse, dev))).toMatch(/EBMR-IAM-\d{3}/);
    expect(await refusal(close(w.cast.qa, dev, ' '))).toMatch(/EBMR-SITE-921/);
    expect(await refusal(db.app.query('insert into site.lot_location_exception_resolution (exception_id) values ($1)', [applied.exceptionId]))).toMatch(/permission denied/);
    await close(w.cast.qa, dev);
    expect(await refusal(close(w.cast.qa, dev))).toMatch(/EBMR-SITE-921 the location exception is already closed/);
    // The location exception no longer blocks; the open deviation linked to the lot now governs its release (0822).
    expect(await refusal(releaseIt())).toMatch(/EBMR-SITE-830 .* deviation .* linked to it is OPEN/);
    expect((await db.app.query('select (site.lot_open_location_exception($1)).id as id', [lot.lotId])).rows[0]).toEqual({ id: null });
  });

  it('[PR-46] an open location exception blocks the issue of a released lot (reservation and consumption)', async () => {
    const lot = await w.releasedLot('API');
    const batch = await w.batch(['IN']);
    const reservation = await w.reserve(lot.lotId, batch, '2');
    // The WMS moves the released lot after its retest fell due (it should have gone to quarantine).
    await w.timeTravel("update site.material_lot set retest_at = clock_timestamp() - interval '1 hour' where id = $1", [lot.lotId]);
    const r = await w.inbound(w.envelope('wms.stock_move', move(lot.lotCode, 'PRODUCTION', 'LINE-1')));
    expect((r.applied as { problem: string }).problem).toMatch(/due for retest/);
    await w.timeTravel("update site.material_lot set retest_at = null where id = $1", [lot.lotId]);
    expect(await refusal(w.reserve(lot.lotId, batch, '1'))).toMatch(/EBMR-SITE-920/);
    expect(await refusal(w.consume(batch, reservation, lot.materialCode, '1'))).toMatch(/EBMR-SITE-920/);
    // A move that keeps to the rule raises nothing.
    const fine = await w.releasedLot('API');
    const ok = await w.inbound(w.envelope('wms.stock_move', move(fine.lotCode, 'PRODUCTION', 'LINE-1')));
    expect(ok.applied).toMatchObject({ problem: null, exceptionId: null, alarmId: null });
  });
});
