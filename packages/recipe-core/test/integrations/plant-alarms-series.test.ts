/**
 * The equipment-data interfaces of slice 6b-0 (recipe-core 0960; DI-49, DI-32, DI-31; D-P6b-3, D-P6a-0-3): the generic
 * alarm log in the batch context with its acknowledgment (the disposition), equipment events, native series chunks and
 * the original records of simple devices. As the application role through real identities (an OPC UA and an EMS
 * adapter of the 6a framework, the plant cast), with bypass attempts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectRefused } from '../../../kernel/test/identity/helpers.ts';
import { envelopeFor, nowUs, receive, registerAdapter, type TestAdapter } from '../../../kernel/test/integrations/support.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { PlantWorld, seedPlantCast } from '../plant/support.ts';

let db: TestDatabase;
let w: PlantWorld;
let opcua: TestAdapter;
let ems: TestAdapter;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new PlantWorld(db, await seedPlantCast(db));
  opcua = await registerAdapter(db, 'OPCUA');
  ems = await registerAdapter(db, 'EMS');
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const code = (p: string): string => `${p}_${randomBytes(3).toString('hex').toUpperCase()}`;
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** A press in use by batch `label` with step `step` bound to it. */
async function pressInUse(label: string, step = 'p-compress@1'): Promise<{ press: { id: string; code: string }; batchId: string; product: string }> {
  const press = await w.press();
  const product = await w.product();
  await w.clean('EQUIPMENT', press.code, 'MAJOR');
  await w.startUse(press.code, label, product);
  const b = await w.batch(label, product);
  await w.run(w.cast.operator, (c) => c.query('select plant.bind_step_equipment($1, $2, $3)', [b.id, step, press.code]));
  return { press, batchId: b.id, product };
}

async function defineCode(source: string, alarmCode: string, gmpCritical: boolean, deviationRequired = false): Promise<number> {
  return w.run(w.cast.steward, async (c) => (await c.query<{ v: number }>('select plant.define_alarm_code($1, $2, $3, $4, $5) as v', [source, alarmCode, gmpCritical, deviationRequired, `${alarmCode} test`])).rows[0]!.v);
}

const alarmPayload = (subjectCode: string, over: Record<string, unknown> = {}) => ({
  subjectKind: 'EQUIPMENT', subjectCode, occurrenceId: `occ-${randomBytes(4).toString('hex')}`, transition: 'RAISED', alarmCode: 'FORCE_MAIN_HIGH', severity: '800',
  tag: 'force.main_kN', value: { value: '18.40', unit: 'kN' }, limit: { value: '18.00', unit: 'kN' }, limitKind: 'HIGH', message: 'Main compression force high',
  occurredAt: nowUs(), ...over,
});
const sendAlarm = (payload: unknown, a: TestAdapter = opcua) => receive(db, a, 'plant.receive_equipment_alarm', envelopeFor(a, a.system === 'EMS' ? 'ems.alarm' : 'opcua.alarm', payload));

const acknowledge = (alarmId: string, action: string | null, comment: string | null, deviationRef: string | null = null, actor = w.cast.operator) =>
  w.run(actor, (c) => c.query('select plant.acknowledge_alarm($1, $2, $3, $4)', [alarmId, action, comment, deviationRef]));

describe('the plant alarm log in the batch context (DI-49)', () => {
  it('[DI-49] a simulated compression-force excursion appears with raise and acknowledgment times, the acknowledger and the comment', async () => {
    const { press, batchId } = await pressInUse('ALM-1');
    const alarmCode = code('FORCE_MAIN_HIGH');
    expect(await defineCode('OPCUA', alarmCode, true)).toBe(1);
    const raised = alarmPayload(press.code, { alarmCode });
    const r = await sendAlarm(raised);
    expect(r).toMatchObject({ outcome: 'ACCEPTED', applied: 'RAISED' });
    const alarmId = r['alarmId'] as string;
    // Bound at the raise to the batch, the step and the unit; GMP-critical from the configuration (version 1).
    expect((await db.app.query('select batch_id, step from plant.alarm_batch where alarm_id = $1', [alarmId])).rows).toEqual([{ batch_id: batchId, step: 'p-compress@1' }]);
    const before = (await db.app.query<Record<string, unknown>>('select gmp_critical, code_version, limit_value, limit_kind, value, raised_source_us::text as us from plant.alarm where id = $1', [alarmId])).rows[0];
    expect(before).toEqual({ gmp_critical: true, code_version: 1, limit_value: '18.00', limit_kind: 'HIGH', value: '18.40', us: raised.occurredAt });
    // Unacknowledged, it blocks the step (builder B wires this into the step signature and review).
    expect((await db.app.query<{ p: string | null }>('select plant.alarm_problem($1, $2) as p', [batchId, 'p-compress@1'])).rows[0]!.p).toMatch(new RegExp(`EBMR-ALM-020 .*${alarmCode}`));
    await sendAlarm({ ...raised, transition: 'CLEARED', occurredAt: nowUs() });
    await acknowledge(alarmId, 'Reduced fill depth; force back in range', 'Excursion of 0.4 kN for 3 s; tablets from the window rejected');
    const log = (await db.app.query<Record<string, unknown>>('select * from plant.batch_alarms($1)', [batchId])).rows;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      id: alarmId, alarm_code: alarmCode, action_taken: 'Reduced fill depth; force back in range', ack_comment: 'Excursion of 0.4 kN for 3 s; tablets from the window rejected',
      acked_by_person: w.cast.operator.personId, acked_by_role: 'OPERATOR',
    });
    expect(log[0]!['received_at']).toBeInstanceOf(Date);
    expect(log[0]!['cleared_at']).toBeInstanceOf(Date);
    expect(log[0]!['acked_at']).toBeInstanceOf(Date);
    expect((await db.app.query<{ p: string | null }>('select plant.alarm_problem($1, null) as p', [batchId])).rows[0]!.p).toBeNull();
  });

  it('[DI-49] acknowledging a GMP-critical alarm without a comment is refused; the action taken is always required; once only; a person only', async () => {
    const { press } = await pressInUse('ALM-2');
    // An unconfigured code counts as GMP-critical (fail safe).
    const r = await sendAlarm(alarmPayload(press.code, { alarmCode: code('UNCONFIGURED') }));
    const alarmId = r['alarmId'] as string;
    expect((await db.app.query('select gmp_critical, code_version from plant.alarm where id = $1', [alarmId])).rows).toEqual([{ gmp_critical: true, code_version: null }]);
    await expectRefused(acknowledge(alarmId, 'Checked', null), 'EBMR-ALM-013', /GMP-critical; it is acknowledged only with a comment/);
    await expectRefused(acknowledge(alarmId, 'Checked', '   '), 'EBMR-ALM-013');
    await expectRefused(acknowledge(alarmId, ' ', 'A comment'), 'EBMR-ALM-012');
    // The adapter's integration identity never acknowledges (DI-14: no ACKNOWLEDGE permission).
    await expectRefused(w.run(opcua.actor, (c) => c.query('select plant.acknowledge_alarm($1, $2, $3, null)', [alarmId, 'x', 'y'])), 'EBMR-IAM-040');
    await acknowledge(alarmId, 'Checked the punch', 'Comment');
    await expectRefused(acknowledge(alarmId, 'Again', 'Again'), 'EBMR-ALM-016');
    // A minor alarm needs the action taken but no comment.
    const minor = code('MINOR');
    await defineCode('OPCUA', minor, false);
    const m = await sendAlarm(alarmPayload(press.code, { alarmCode: minor }));
    await acknowledge(m['alarmId'] as string, 'Noted', null);
    // A deviation-required alarm needs a deviation reference that stands for the batch.
    const dev = code('DEV');
    await defineCode('OPCUA', dev, true, true);
    const d = await sendAlarm(alarmPayload(press.code, { alarmCode: dev }));
    await expectRefused(acknowledge(d['alarmId'] as string, 'Stopped', 'Comment', null), 'EBMR-ALM-014');
    await expectRefused(acknowledge(d['alarmId'] as string, 'Stopped', 'Comment', 'DEV-NOPE-2026-00001'), 'EBMR-ALM-015');
    await expectRefused(w.run(w.cast.steward, (c) => c.query("select plant.define_alarm_code('OPCUA', $1, false, true, 'x')", [code('BAD')])), 'EBMR-ALM-031');
  });

  it('[DI-49] the alarm log cannot be deleted or updated by any role', async () => {
    const { press } = await pressInUse('ALM-3');
    const r = await sendAlarm(alarmPayload(press.code, { alarmCode: code('LOG') }));
    const alarmId = r['alarmId'] as string;
    await acknowledge(alarmId, 'Done', 'Comment');
    const columns: Record<string, string> = {
      'plant.alarm': 'message', 'plant.alarm_batch': 'step', 'plant.alarm_transition': 'transition', 'plant.alarm_ack': 'comment', 'plant.alarm_code': 'description',
      'plant.equipment_state_event': 'message', 'plant.series': 'unit', 'plant.device_original': 'unit', 'plant.step_equipment': 'step', 'plant.series_tag': 'unit',
    };
    for (const [t, col] of Object.entries(columns)) {
      await expect(db.app.query(`delete from ${t}`), t).rejects.toThrow(/permission denied/);
      await expect(db.app.query(`update ${t} set ${col} = ${col}`), t).rejects.toThrow(/permission denied/);
      await expect(db.app.query(`truncate ${t}`), t).rejects.toThrow(/permission denied/);
    }
    await expect(db.app.query("insert into plant.alarm (source, occurrence_id) values ('EBMR', 'x')")).rejects.toThrow(/permission denied/);
    // The core that raises an alarm is the owner's; the application cannot call it.
    await expect(db.app.query("select plant.raise_alarm('{}'::jsonb)")).rejects.toThrow(/permission denied/);
    // Even the owner cannot change or erase a row: the tables are insert-only.
    const c = await db.admin.connect();
    try {
      await c.query('set role ebmr_owner');
      await expect(c.query("update plant.alarm set message = 'changed' where id = $1", [alarmId])).rejects.toThrow(/EBMR-AUDIT|insert-only|not allowed/i);
      await expect(c.query('delete from plant.alarm_ack where alarm_id = $1', [alarmId])).rejects.toThrow(/EBMR-AUDIT|insert-only|not allowed/i);
      await expect(c.query('truncate plant.alarm cascade')).rejects.toThrow(/EBMR-AUDIT|insert-only|not allowed/i);
    } finally {
      await c.query('reset role');
      c.release();
    }
    expect((await db.app.query('select count(*)::int as n from plant.alarm_ack where alarm_id = $1', [alarmId])).rows[0]).toEqual({ n: 1 });
  });

  it('[DI-49] alarms are in the batch\'s review scope: bound at the source time to the batch, step and unit; a room alarm to the batch in the room; none outside a use', async () => {
    const { press, batchId } = await pressInUse('ALM-4');
    const product = (await db.app.query<{ c: string }>('select product_code as c from plant.equipment_use where batch_id = $1', [batchId])).rows[0]!.c;
    const room = await w.room();
    await w.clean('AREA', room.code, 'MAJOR');
    await w.clear(room.code, 'PRODUCT_CHANGE', { batch: 'ALM-4', product });
    await w.startIn(room.code, { batch: 'ALM-4', product });
    const roomAlarm = await sendAlarm(
      alarmPayload(room.code, { subjectKind: 'AREA', alarmCode: code('RH_HIGH'), tag: 'room.rh_pct', value: { value: '61.2', unit: '%RH' }, limit: { value: '60.0', unit: '%RH' } }),
      ems,
    );
    const pressAlarm = await sendAlarm(alarmPayload(press.code, { alarmCode: code('REJECT_BURST'), tag: null, value: null, limit: null, limitKind: 'STATE' }));
    const ids = (await db.app.query<{ id: string; step: string | null }>('select id, step from plant.batch_alarms($1) order by step nulls first', [batchId])).rows;
    expect(ids).toEqual([{ id: roomAlarm['alarmId'], step: null }, { id: pressAlarm['alarmId'], step: 'p-compress@1' }]);
    // A unit not in use: the alarm is logged with no batch.
    const idle = await w.press();
    const loose = await sendAlarm(alarmPayload(idle.code, { alarmCode: code('IDLE') }));
    expect((await db.app.query('select count(*)::int as n from plant.alarm_batch where alarm_id = $1', [loose['alarmId']])).rows[0]).toEqual({ n: 0 });
    // A source time before the use began binds to no batch (the binding is by the source time, not by arrival).
    const early = await sendAlarm(alarmPayload(press.code, { alarmCode: code('EARLY'), occurredAt: '1600000000000000' }));
    expect((await db.app.query('select count(*)::int as n from plant.alarm_batch where alarm_id = $1', [early['alarmId']])).rows[0]).toEqual({ n: 0 });
  });

  it('[DI-31][DI-49] a transition before its raise, a raise twice, the wrong system, an unknown unit, a future time and a malformed payload are refused; nothing is recorded', async () => {
    const { press } = await pressInUse('ALM-5');
    const raised = alarmPayload(press.code, { alarmCode: code('X') });
    await expectRefused(sendAlarm({ ...raised, transition: 'CLEARED' }), 'EBMR-ALM-005', /never raised here/);
    await sendAlarm(raised);
    await expectRefused(sendAlarm(raised), 'EBMR-ALM-004');
    await sendAlarm({ ...raised, transition: 'SOURCE_ACKNOWLEDGED' });
    await expectRefused(sendAlarm({ ...raised, transition: 'SOURCE_ACKNOWLEDGED' }), 'EBMR-ALM-004');
    await expectRefused(sendAlarm(alarmPayload(press.code), ems), 'EBMR-ALM-002', /wrong source/);
    await expectRefused(sendAlarm(alarmPayload('NO-SUCH-UNIT')), 'EBMR-ALM-002', /wrong unit/);
    const future = (BigInt(nowUs()) + 3_600_000_000n).toString();
    await expectRefused(sendAlarm(alarmPayload(press.code, { occurredAt: future })), 'EBMR-ALM-003');
    await expectRefused(sendAlarm(alarmPayload(press.code, { limit: null })), 'EBMR-ALM-001');
    await expectRefused(sendAlarm({ ...alarmPayload(press.code), extra: 'x' }), 'EBMR-ALM-001');
    expect((await db.app.query('select count(*)::int as n from plant.alarm where occurrence_id = $1', [raised.occurrenceId])).rows[0]).toEqual({ n: 1 });
  });

  it('[DI-49] equipment events are recorded in the batch context; a repeated event id and an unknown unit are refused', async () => {
    const { press, batchId } = await pressInUse('EVT-1');
    const ev = { equipmentCode: press.code, eventId: `e-${randomBytes(4).toString('hex')}`, kind: 'STATE_CHANGED', state: 'RUNNING', recipeVersion: null, message: 'Press running', occurredAt: nowUs() };
    const send = (p: unknown) => receive(db, opcua, 'plant.receive_equipment_event', envelopeFor(opcua, 'opcua.equipment_event', p));
    expect(await send(ev)).toMatchObject({ outcome: 'ACCEPTED', batchId, step: 'p-compress@1' });
    await expectRefused(send(ev), 'EBMR-EQD-004');
    await expectRefused(send({ ...ev, eventId: 'e-2', equipmentCode: 'NO-SUCH-UNIT' }), 'EBMR-EQD-002');
    await expectRefused(send({ ...ev, eventId: 'e-3', kind: 'RECIPE_LOADED', state: null }), 'EBMR-EQD-001');
    expect(await send({ ...ev, eventId: `e-${randomBytes(4).toString('hex')}`, kind: 'RECIPE_LOADED', state: null, recipeVersion: 'PRESS-RCP-7' })).toMatchObject({ outcome: 'ACCEPTED' });
  });
});

describe('native series and original records (DI-32)', () => {
  const sampleHash = (c: { subjectKind: string; subjectCode: string; tag: string; unit: string; chunkNo: string; samples: { sourceTime: string; serverTime: string | null; raw: string; value: string | null; status: string }[] }) =>
    sha([[c.subjectKind, c.subjectCode, c.tag, c.unit, c.chunkNo].join('|'), ...c.samples.map((s) => [s.sourceTime, s.serverTime ?? '', s.raw, s.value ?? '', s.status].join('|'))].join('\n'));

  const chunk = (subjectCode: string, chunkNo: string, startUs: bigint, over: Record<string, unknown> = {}) => {
    const c = {
      subjectKind: 'EQUIPMENT', subjectCode, tag: 'force.main_kN', unit: 'kN', chunkNo,
      samples: [
        { sourceTime: startUs.toString(), serverTime: (startUs + 50n).toString(), raw: '1.25E1', value: '12.50', status: '0x00000000' },
        { sourceTime: (startUs + 100_000n).toString(), serverTime: null, raw: '12.61', value: '12.61', status: '0x40000000' },
        { sourceTime: (startUs + 200_000n).toString(), serverTime: null, raw: 'NaN', value: null, status: '0x80000000' },
      ],
      ...over,
    };
    return { ...c, chunkHash: (over['chunkHash'] as string | undefined) ?? sampleHash(c) };
  };
  const sendChunk = (payload: unknown, a: TestAdapter = opcua) => receive(db, a, 'plant.receive_series_chunk', envelopeFor(a, a.system === 'EMS' ? 'ems.series_chunk' : 'opcua.series_chunk', payload));

  it('[DI-32] trend data are kept in native form: raw values, source timestamps and status codes as received, the chunk hash recomputed, linked to the batch and step', async () => {
    const { press, batchId } = await pressInUse('SER-1');
    const t0 = BigInt(nowUs());
    const r = await sendChunk(chunk(press.code, '1', t0));
    expect(r).toMatchObject({ outcome: 'ACCEPTED', applied: 'RECORDED', samples: '3' });
    const row = (await db.app.query<{ samples: unknown[]; from_us: string; to_us: string }>('select samples, from_us::text, to_us::text, chunk_hash from plant.series where id = $1', [r['seriesId']])).rows[0]!;
    expect(row.samples[0]).toEqual({ sourceTime: t0.toString(), serverTime: (t0 + 50n).toString(), raw: '1.25E1', value: '12.50', status: '0x00000000' });
    expect([row.from_us, row.to_us]).toEqual([t0.toString(), (t0 + 200_000n).toString()]);
    await sendChunk(chunk(press.code, '2', t0 + 1_000_000n));
    const inStep = (await db.app.query<{ chunk_no: string }>('select chunk_no::text from plant.series_in_context($1, $2, $3)', [batchId, 'p-compress@1', 'force.main_kN'])).rows;
    expect(inStep.map((x) => x.chunk_no)).toEqual(['1', '2']);
    expect((await db.app.query('select count(*)::int as n from plant.series_in_context($1, $2, $3)', [batchId, 'p-other@1', 'force.main_kN'])).rows[0]).toEqual({ n: 0 });
    // A room's humidity from the EMS.
    const room = await w.room();
    const rh = chunk(room.code, '1', t0, {
      subjectKind: 'AREA', tag: 'room.rh_pct', unit: '%RH', samples: [{ sourceTime: t0.toString(), serverTime: null, raw: '45.3', value: '45.3', status: '0x00000000' }],
    });
    expect(await sendChunk(rh, ems)).toMatchObject({ outcome: 'ACCEPTED' });
  });

  it('[DI-32] a rounded shown value, a BAD sample with a value, a changed sample, a wrong tag or unit, a repeated or overlapping chunk is refused', async () => {
    const press = await w.press();
    const t0 = BigInt(nowUs());
    const rounded = chunk(press.code, '1', t0, { samples: [{ sourceTime: t0.toString(), serverTime: null, raw: '12.499', value: '12.50', status: '0x00000000' }] });
    await expectRefused(sendChunk(rounded), 'EBMR-EQD-001', /DI-32: the shown value 12.50 is not the raw value 12.499/);
    const bad = chunk(press.code, '1', t0, { samples: [{ sourceTime: t0.toString(), serverTime: null, raw: '12.5', value: '12.5', status: '0x80000000' }] });
    await expectRefused(sendChunk(bad), 'EBMR-EQD-001');
    const good = chunk(press.code, '1', t0);
    await expectRefused(sendChunk({ ...good, chunkHash: sha('other') }), 'EBMR-EQD-001', /chunk hash does not match/);
    await expectRefused(sendChunk(chunk(press.code, '1', t0, { unit: 'N' })), 'EBMR-EQD-002', /wrong tag/);
    await expectRefused(sendChunk(chunk(press.code, '1', t0, { tag: 'room.rh_pct' })), 'EBMR-EQD-002');
    await expectRefused(sendChunk(chunk(press.code, '1', t0), ems), 'EBMR-EQD-002', /wrong source/);
    await sendChunk(good);
    await expectRefused(sendChunk(chunk(press.code, '1', t0 + 10_000_000n)), 'EBMR-EQD-004');
    await expectRefused(sendChunk(chunk(press.code, '2', t0 + 100_000n)), 'EBMR-EQD-005');
    // A late chunk that fills a gap is accepted (late data are never lost, D-P6a-0-6).
    expect(await sendChunk(chunk(press.code, '3', t0 - 10_000_000n))).toMatchObject({ outcome: 'ACCEPTED' });
    expect((await db.app.query('select count(*)::int as n from plant.series where equipment_id = $1', [press.id])).rows[0]).toEqual({ n: 2 });
  });

  it('[DI-32] an OPC UA reading stores raw output equal to the displayed value; a raw output that rounds to it is refused', async () => {
    const { press, batchId } = await pressInUse('ORG-1');
    const rec = (r: Record<string, unknown>, actor = w.cast.operator) => w.run(actor, async (c) => (await c.query<{ id: string }>('select plant.record_device_original($1::jsonb) as id', [JSON.stringify(r)])).rows[0]!.id);
    const base = { equipmentCode: press.code, capture: 'TRANSMITTED', deviceRef: 'nsu=urn:ebmr:process:tags:v1;s=X/force.main_kN', rawOutput: '1.25E1', value: '12.50', unit: 'kN', deviceTimeUs: nowUs(), batchId, step: 'p-compress@1', entryRef: null };
    const id = await rec(base);
    expect((await db.app.query('select raw_output, value from plant.device_original where id = $1', [id])).rows).toEqual([{ raw_output: '1.25E1', value: '12.50' }]);
    await expectRefused(rec({ ...base, rawOutput: '12.499' }), 'EBMR-EQD-014', /does not state the shown value 12.50 exactly/);
    await expectRefused(rec({ ...base, rawOutput: null }), 'EBMR-EQD-013');
    await expectRefused(rec({ ...base, deviceTimeUs: null }), 'EBMR-EQD-013');
    // The adapter's identity records with INTERFACE.WRITE.
    expect(await rec(base, opcua.actor)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DI-32] a printed ticket is linked to its weighing', async () => {
    const { press, batchId } = await pressInUse('ORG-2');
    const rec = (r: Record<string, unknown>) => w.run(w.cast.operator, async (c) => (await c.query<{ id: string }>('select plant.record_device_original($1::jsonb) as id', [JSON.stringify(r)])).rows[0]!.id);
    const ticket = { equipmentCode: press.code, capture: 'PRINTED_TICKET', value: '250.4', unit: 'g', ticketSha256: sha('scan of the ticket'), ticketRef: 'TC-2026-000123', batchId, step: 'p-weigh@1', entryRef: 'cmd-42' };
    const id = await rec(ticket);
    expect((await db.app.query('select capture, ticket_ref, entry_ref, raw_output from plant.device_original where id = $1', [id])).rows).toEqual([
      { capture: 'PRINTED_TICKET', ticket_ref: 'TC-2026-000123', entry_ref: 'cmd-42', raw_output: null },
    ]);
    await expectRefused(rec({ ...ticket, entryRef: null }), 'EBMR-EQD-015');
    await expectRefused(rec({ ...ticket, ticketSha256: null }), 'EBMR-EQD-015');
    await expectRefused(rec({ ...ticket, batchId: null }), 'EBMR-EQD-010');
  });
});
