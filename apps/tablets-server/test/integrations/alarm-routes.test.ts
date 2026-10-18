/**
 * The integrations routes with data (Phase 6 slice 6a, builder A; DI-31, DI-14, INV-40; contract ns/integrations.ts,
 * kernel 1180): an ERP/WMS adapter's messages raise a gap alarm and a recorded refusal; the health page, the adapter
 * detail and the alarm list show them; a person acknowledges an alarm with a note, once, from a shared kiosk only with a
 * fresh badge tap; an integration identity or a person without ALARM.ACKNOWLEDGE cannot.
 */
import { createHash, randomUUID } from 'node:crypto';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personaIn, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { adapterActor, adapterIdentity, type AdapterIdentity } from './erp-wms/support.ts';

const I = routes.integrations;
let gmp: TestServer;
let erp: AdapterIdentity;
let gapAlarm = '';
let refusalAlarm = '';

const envelope = (seq: number, payload: Record<string, unknown>) => ({
  sourceSystem: 'ERP_WMS', messageType: 'erp.material_master', sourceRecordId: `MM-${seq.toString()}`, sourceTimestamp: '1800000000000000', sequenceNo: seq.toString(),
  idempotencyKey: `k-${randomUUID()}`, schemaVersion: '1', payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), payload,
});

beforeAll(async () => {
  gmp = await startServer('GMP');
  erp = await adapterIdentity(gmp, 'ERP');
  const actor = await adapterActor(gmp, erp);
  // (A material master, applied as it is received; since slice 6d an erp.shipment needs a released finished lot.)
  const shipment = (id: string) => ({ materialCode: `MAT-${id}`, name: `Material ${id}`, baseUnit: 'kg', materialKind: 'EXCIPIENT' });
  await withCommand(gmp.db.app, { ...actor, correlationId: randomUUID() }, (c) => c.query('select site.erp_wms_receive($1::jsonb)', [JSON.stringify(envelope(1, shipment('SH-1')))]));
  const gap = await withCommand(gmp.db.app, { ...actor, correlationId: randomUUID() }, async (c) =>
    (await c.query<{ r: { alarmId: string } }>('select site.erp_wms_receive($1::jsonb) as r', [JSON.stringify(envelope(4, shipment('SH-4')))])).rows[0]?.r);
  gapAlarm = gap?.alarmId ?? '';
  const refused = await withCommand(gmp.db.app, { ...actor, correlationId: randomUUID() }, async (c) =>
    (await c.query<{ id: string }>("select platform.record_inbound_refusal($1::jsonb, 'MALFORMED', 'EBMR-ERP-001 malformed erp.material_master payload') as id", [JSON.stringify(envelope(5, { garbled: true }))])).rows[0]?.id ?? '');
  refusalAlarm = (await gmp.db.app.query<{ a: string }>('select alarm_id::text as a from platform.inbound_exception where id = $1', [refused])).rows[0]?.a ?? '';
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('integrations routes with data (DI-31)', () => {
  it('[DI-31] the health page, the adapter detail and the alarm list show the adapter\'s messages, refusals and open alarms', async () => {
    const qa = await gmp.asPersona('qaInvestigator');
    const health = valueOf(await qa.call(I.adapters)).adapters.find((a) => a.adapterCode === erp.code);
    expect(health).toMatchObject({ sourceSystem: 'ERP_WMS', status: 'ACTIVE', openAlarms: '2', lastMessage: { sequenceNo: '4', sequenceStatus: 'GAP' } });
    expect(health?.mirrors.map((m) => m.dataClass).sort()).toEqual(['ERP_ITEM_MASTER', 'ERP_LOT_STATUS', 'WMS_STOCK']);
    const detail = valueOf(await qa.call(I.adapter, { params: { adapterCode: erp.code } }));
    expect(detail.messages.map((m) => m.sequenceNo)).toEqual(['4', '1']);
    expect(detail.refusals).toEqual([expect.objectContaining({ errorClass: 'MALFORMED', sequenceNo: '5', alarmId: refusalAlarm })]);
    const open = valueOf(await qa.call(I.alarms, { query: { adapterCode: erp.code } })).alarms;
    expect(open.map((a) => [a.alarmId, a.kind]).sort()).toEqual([[gapAlarm, 'SEQUENCE_GAP'], [refusalAlarm, 'MALFORMED']].sort());
    expect(open.find((a) => a.alarmId === gapAlarm)?.summary).toMatch(/2/);
    const mirrors = valueOf(await qa.call(I.mirrors)).mirrors;
    expect(mirrors.find((m) => m.dataClass === 'ERP_LOT_STATUS')).toMatchObject({ mode: 'STAND_IN', stale: false });
    // Slice 6c (tablets 1231): the L3 serial-status class is listed under the contract (it answered 500 before the enum knew it).
    expect(mirrors.find((m) => m.dataClass === 'L3_SERIAL_STATUS')).toMatchObject({ sourceSystem: 'L3', mode: 'STAND_IN', blocking: true, stale: false });
    expect(refusalOf(await qa.call(I.adapter, { params: { adapterCode: 'NO-SUCH-ADAPTER' } }))?.status).toBe(404);
  });

  it('[DI-31][DI-14][INV-40] a person acknowledges an alarm with a note, once, from a kiosk only with a fresh tap; others cannot', async () => {
    const kiosk = await gmp.asPersona('operator1');
    const path = `/api/integrations/alarms/${refusalAlarm}/acknowledge`;
    const body = { note: 'ERP team asked to resend shipments 2 and 3' };
    expect(refusalOf(await kiosk.call(I.acknowledgeAlarm, { params: { alarmId: refusalAlarm }, body }))).toMatchObject({ status: 428, code: 'TAP_REQUIRED' });
    // A note is required (the contract and the database); QA without ALARM.ACKNOWLEDGE is refused by the database.
    expect(refusalOf(await kiosk.call(I.acknowledgeAlarm, { params: { alarmId: refusalAlarm }, body: { note: ' ' }, attribution: await tapFor(kiosk, personaIn(gmp, 'operator1'), 'POST', path, { note: ' ' }) }))?.status).toBe(400);
    const qa = await gmp.asPersona('qaInvestigator');
    expect(refusalOf(await qa.call(I.acknowledgeAlarm, { params: { alarmId: refusalAlarm }, body }))).toMatchObject({ code: 'EBMR-PLAT-006' });
    const acked = valueOf(await kiosk.call(I.acknowledgeAlarm, { params: { alarmId: refusalAlarm }, body, attribution: await tapFor(kiosk, personaIn(gmp, 'operator1'), 'POST', path, body) }));
    expect(acked).toMatchObject({ alarmId: refusalAlarm, acknowledgement: { note: body.note, by: { personId: personaIn(gmp, 'operator1').personId } } });
    // Once: a second acknowledgment is refused.
    const again = { note: 'second note' };
    expect(refusalOf(await kiosk.call(I.acknowledgeAlarm, { params: { alarmId: refusalAlarm }, body: again, attribution: await tapFor(kiosk, personaIn(gmp, 'operator1'), 'POST', path, again) }))?.status).toBe(409);
    // A sequence gap on the ERP adapter (it feeds a blocking mirror, ERP lot status) is QA's or the system owner's to
    // acknowledge (kernel 1320, 6jc-R11): the operator is refused by the database, QA acknowledges it.
    const gapPath = `/api/integrations/alarms/${gapAlarm}/acknowledge`;
    expect(refusalOf(await kiosk.call(I.acknowledgeAlarm, { params: { alarmId: gapAlarm }, body, attribution: await tapFor(kiosk, personaIn(gmp, 'operator1'), 'POST', gapPath, body) })))
      .toMatchObject({ code: 'EBMR-PLAT-006' });
    const gapAcked = valueOf(await qa.call(I.acknowledgeAlarm, { params: { alarmId: gapAlarm }, body }));
    expect(gapAcked).toMatchObject({ alarmId: gapAlarm, acknowledgement: { note: body.note, by: { personId: personaIn(gmp, 'qaInvestigator').personId } } });
    const lists = async (state: 'OPEN' | 'ACKNOWLEDGED') => valueOf(await qa.call(I.alarms, { query: { state, adapterCode: erp.code } })).alarms.map((a) => a.alarmId).sort();
    expect(await lists('ACKNOWLEDGED')).toEqual([gapAlarm, refusalAlarm].sort());
    expect(await lists('OPEN')).toEqual([]);
    // The integration identity never acknowledges (DI-14), not even its own alarm.
    const actor = await adapterActor(gmp, erp);
    await expect(withCommand(gmp.db.app, { ...actor, correlationId: randomUUID() }, (c) => c.query('select platform.acknowledge_integration_alarm($1, $2)', [refusalAlarm, 'self'])))
      .rejects.toThrow(/EBMR-PLAT-006/);
  });
});
