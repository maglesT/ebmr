/**
 * Kill tests of the SQL mutation group "equipment-data-and-alarms" (Phase 6 exit, decision 0019): the plant alarm log,
 * equipment events, native series, the original records of simple devices and OPC UA endpoint identity (recipe-core
 * 0960, 0961, 0976). Each case aims at a clause a surviving mutant changed: one malformed field at a time (so every
 * `or` of a form check is proven on its own), the exact instants a binding window opens and closes, and the refusals
 * the suite did not reach. Refusals are matched by their message, not only their code, where a later layer refuses with
 * the same code (the OPC UA data guard's EBMR-EQD-002, the chunk hash's EBMR-EQD-001).
 *
 * Controls: DI-49 (alarms in batch context, acknowledged by a person), DI-32 (native series and original records),
 * DI-31 (inbound data checked as received), DI-20 (OPC UA endpoint identity).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectRefused } from '../../../kernel/test/identity/helpers.ts';
import { toDbContext, withCommand } from '../../../kernel/src/db/command.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { seedAdministration, seedServiceActor, withReason } from '../../../kernel/test/identity/seed.ts';
import { envelopeFor, nowUs, receive, registerAdapter, type TestAdapter } from '../../../kernel/test/integrations/support.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as plant from '../../src/plant/index.ts';
import { enrol, enrolEndpoint, reportSession, servedByEndpoint } from '../equipment-data/support.ts';
import { PlantWorld, seedPlantCast, tag } from '../plant/support.ts';

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
const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await db.admin.query<{ r: T }>(sql, params)).rows[0]!.r;

async function servedPress(): Promise<{ id: string; code: string }> {
  const press = await w.press();
  await servedByEndpoint(db, opcua, await w.room(), [press.code]);
  return press;
}

async function pressInUse(label: string, step = 'p-compress@1'): Promise<{ press: { id: string; code: string }; batchId: string; product: string; useId: string }> {
  const press = await servedPress();
  const product = await w.product();
  await w.clean('EQUIPMENT', press.code, 'MAJOR');
  const useId = await w.startUse(press.code, label, product);
  const b = await w.batch(label, product);
  await w.run(w.cast.operator, (c) => c.query('select plant.bind_step_equipment($1, $2, $3)', [b.id, step, press.code]));
  return { press, batchId: b.id, product, useId };
}

const bind = (batchId: string, step: string, unit: string | null) => w.run(w.cast.operator, (c) => c.query('select plant.bind_step_equipment($1, $2, $3)', [batchId, step, unit]));

const defineCode = (source: string | null, alarmCode: string | null, gmp: boolean | null, dev: boolean | null, description: string | null = 'test code') =>
  w.run(w.cast.steward, async (c) => (await c.query<{ v: number }>('select plant.define_alarm_code($1, $2, $3, $4, $5) as v', [source, alarmCode, gmp, dev, description])).rows[0]!.v);

const alarmPayload = (subjectCode: string, over: Record<string, unknown> = {}) => ({
  subjectKind: 'EQUIPMENT', subjectCode, occurrenceId: `occ-${randomBytes(4).toString('hex')}`, transition: 'RAISED', alarmCode: 'FORCE_MAIN_HIGH', severity: '800',
  tag: 'force.main_kN', value: { value: '18.40', unit: 'kN' }, limit: { value: '18.00', unit: 'kN' }, limitKind: 'HIGH', message: 'Main compression force high',
  occurredAt: nowUs(), ...over,
});
const sendAlarm = (payload: unknown, a: TestAdapter = opcua, messageType?: string) =>
  receive(db, a, 'plant.receive_equipment_alarm', envelopeFor(a, messageType ?? (a.system === 'EMS' ? 'ems.alarm' : 'opcua.alarm'), payload));

const acknowledge = (alarmId: string, action: string | null, comment: string | null, deviationRef: string | null = null, actor = w.cast.operator) =>
  w.run(actor, (c) => c.query('select plant.acknowledge_alarm($1, $2, $3, $4)', [alarmId, action, comment, deviationRef]));

describe('alarm codes and step bindings (DI-49)', () => {
  it('[DI-49] an alarm code names its source, code, both flags and a description, one clause at a time; versions count per source and code', async () => {
    const c = code('VER');
    for (const [s, k, g, d, text] of [
      ['PLC', c, true, false, 'x'], [null, c, true, false, 'x'], ['OPCUA', 'lower', true, false, 'x'], ['OPCUA', null, true, false, 'x'],
      ['OPCUA', c, null, false, 'x'], ['OPCUA', c, true, null, 'x'], ['OPCUA', c, true, false, '  '], ['OPCUA', c, true, false, null],
    ] as const) {
      await expectRefused(defineCode(s, k, g, d, text), 'EBMR-ALM-030', /an alarm code names its source/);
    }
    expect(await defineCode('OPCUA', c, true, false)).toBe(1);
    // The same code from another source, and another code from the same source, start at version 1.
    expect(await defineCode('EMS', c, true, false)).toBe(1);
    expect(await defineCode('OPCUA', code('OTHER'), false, false)).toBe(1);
    expect(await defineCode('OPCUA', c, false, false)).toBe(2);
    expect(await defineCode('EMS', c, true, true)).toBe(2);
  });

  it('[DI-49] a step is bound to a unit in use by its batch only: a named step, a known unit in use by this batch, once per step and unit', async () => {
    const label = `BND-${tag()}`;
    const { press, batchId, product } = await pressInUse(label, 's-1');
    await expectRefused(bind(batchId, ' ', press.code), 'EBMR-ALM-032');
    await expectRefused(bind(batchId, 's-2', 'NO-SUCH-UNIT'), 'EBMR-ALM-033');
    // A known unit that is in use by no batch.
    const idle = await w.press();
    await expectRefused(bind(batchId, 's-2', idle.code), 'EBMR-ALM-033', /is not in use by this batch/);
    // A unit in use by another batch, started after this batch's unit (the latest open use of any unit is not this one).
    const other = await w.press();
    await w.clean('EQUIPMENT', other.code, 'MAJOR');
    await w.startUse(other.code, `BND-O-${tag()}`, product);
    await expectRefused(bind(batchId, 's-2', other.code), 'EBMR-ALM-033', /is not in use by this batch/);
    // This batch's unit is still its own after the other use started.
    await bind(batchId, 's-2', press.code);
    await expectRefused(bind(batchId, 's-1', press.code), 'EBMR-ALM-034', /is already bound/);
    // The same step on a second unit of the batch, and another step on the same unit, are each bound once.
    const second = await w.press();
    await w.clean('EQUIPMENT', second.code, 'MAJOR');
    await w.startUse(second.code, label, product);
    await bind(batchId, 's-1', second.code);
    await bind(batchId, 's-3', second.code);
    expect((await db.app.query<{ step: string }>('select step from plant.step_equipment where batch_id = $1 order by step, equipment_id', [batchId])).rows.map((r) => r.step)).toEqual(['s-1', 's-1', 's-2', 's-3']);
  });
});

describe('receiving alarms (DI-49, DI-31)', () => {
  it('[DI-31][DI-49] an alarm payload is refused for each malformed field on its own; a message of 500 characters is taken', async () => {
    const press = await servedPress();
    const malformed = /malformed alarm payload: occurrenceId, transition/;
    for (const over of [
      { occurrenceId: 'has space' }, { occurrenceId: '' }, { transition: 'OPENED' }, { alarmCode: 'lower' }, { severity: '0' }, { severity: '1001' },
      { message: '   ' }, { message: 'm'.repeat(501) }, { value: { value: '18,4', unit: 'kN' } }, { limit: { value: 'x', unit: 'kN' } },
      { limitKind: 'SIDEWAYS' }, { limit: null }, { limitKind: 'STATE' },
    ]) {
      await expectRefused(sendAlarm(alarmPayload(press.code, { alarmCode: code('FORM'), ...over })), 'EBMR-ALM-001', malformed);
    }
    expect(await sendAlarm(alarmPayload(press.code, { alarmCode: code('LONG'), message: 'm'.repeat(500) }))).toMatchObject({ outcome: 'ACCEPTED', applied: 'RAISED' });
    // Another message type is refused by this command before anything is accepted.
    await expectRefused(sendAlarm(alarmPayload(press.code), opcua, 'opcua.equipment_event'), 'EBMR-ALM-001', /this command receives opcua.alarm and ems.alarm/);
  });

  it('[DI-49] a transition finds its own occurrence on its own subject; a transition of one occurrence does not stand for another', async () => {
    const press = await servedPress();
    const a = alarmPayload(press.code, { alarmCode: code('A') });
    const b = alarmPayload(press.code, { alarmCode: code('B') });
    const ra = await sendAlarm(a);
    const rb = await sendAlarm(b);
    // An occurrence never raised on the unit, while others are: refused.
    await expectRefused(sendAlarm({ ...a, occurrenceId: `occ-never-${randomBytes(3).toString('hex')}`, transition: 'CLEARED', occurredAt: nowUs() }), 'EBMR-ALM-005');
    expect(await sendAlarm({ ...a, transition: 'CLEARED', occurredAt: nowUs() })).toMatchObject({ applied: 'CLEARED', alarmId: ra['alarmId'] });
    // The second occurrence clears too: the first one's CLEARED is not its own.
    expect(await sendAlarm({ ...b, transition: 'CLEARED', occurredAt: nowUs() })).toMatchObject({ applied: 'CLEARED', alarmId: rb['alarmId'] });
    expect((await db.app.query('select alarm_id from plant.alarm_transition where alarm_id = any($1) order by alarm_id', [[ra['alarmId'], rb['alarmId']]])).rows).toHaveLength(2);
  });
});

describe('acknowledging an alarm (DI-49)', () => {
  it('[DI-49] an unknown alarm is refused; an alarm bound to no batch needs a deviation record of this installation when it needs a deviation', async () => {
    await expectRefused(acknowledge(randomUUID(), 'Checked', 'Comment'), 'EBMR-ALM-011', /there is no plant alarm/);
    const idle = await servedPress();
    const dev = code('DEVREQ');
    await defineCode('OPCUA', dev, true, true);
    const r1 = await sendAlarm(alarmPayload(idle.code, { alarmCode: dev }));
    const r2 = await sendAlarm(alarmPayload(idle.code, { alarmCode: dev }));
    expect((await db.app.query('select count(*)::int as n from plant.alarm_batch where alarm_id = any($1)', [[r1['alarmId'], r2['alarmId']]])).rows[0]).toEqual({ n: 0 });
    // Other alarms bound to batches exist, and so do deviation records.
    const inUse = await pressInUse(`ACK-${tag()}`);
    await sendAlarm(alarmPayload(inUse.press.code, { alarmCode: code('BOUND') }));
    expect((await db.app.query('select count(*)::int as n from plant.alarm_batch where batch_id = $1', [inUse.batchId])).rows[0]).toEqual({ n: 1 });
    const { ref } = await w.run(w.cast.operator, async (c) =>
      (await c.query<{ r: { ref: string } }>('select site.raise_deviation($1::jsonb) as r', [
        JSON.stringify({ kind: 'DEVIATION', title: 'Force excursion on the press', classification: 'MINOR', riskRationale: 'One alarm; product held' }),
      ])).rows[0]!.r,
    );
    await expectRefused(acknowledge(r1['alarmId'] as string, 'Stopped', 'Comment', `DEV-NOPE-${tag()}`), 'EBMR-ALM-015', /is not a deviation record of this installation/);
    await acknowledge(r2['alarmId'] as string, 'Stopped', 'Comment', ref);
    expect((await db.app.query('select deviation_ref from plant.alarm_ack where alarm_id = $1', [r2['alarmId']])).rows).toEqual([{ deviation_ref: ref }]);
  });
});

describe('equipment events (DI-49, DI-31)', () => {
  const send = (p: unknown, type = 'opcua.equipment_event') => receive(db, opcua, 'plant.receive_equipment_event', envelopeFor(opcua, type, p));
  const ev = (unit: string, over: Record<string, unknown> = {}) => ({
    equipmentCode: unit, eventId: `e-${randomBytes(4).toString('hex')}`, kind: 'STATE_CHANGED', state: 'RUNNING', recipeVersion: null, message: 'Press running', occurredAt: nowUs(), ...over,
  });

  it('[DI-31][DI-49] an equipment event is refused for each malformed field on its own, another message type, an unknown field or unit; 500 characters are taken', async () => {
    const press = await servedPress();
    const malformed = /malformed equipment event: eventId, kind/;
    for (const over of [
      { eventId: 'has space' }, { kind: 'EXPLODED' }, { kind: 'FAULT', state: 'RUNNING' }, { state: 'DANCING' }, { kind: 'RECIPE_MISMATCH', state: null, recipeVersion: 'has space' },
      { message: ' ' }, { message: 'm'.repeat(501) },
    ]) {
      await expectRefused(send(ev(press.code, over)), 'EBMR-EQD-001', malformed);
    }
    expect(await send(ev(press.code, { message: 'm'.repeat(500) }))).toMatchObject({ outcome: 'ACCEPTED' });
    await expectRefused(send(ev(press.code), 'opcua.alarm'), 'EBMR-EQD-001', /this command receives opcua.equipment_event/);
    await expectRefused(send({ ...ev(press.code), extra: 'x' }), 'EBMR-EQD-001', /unknown field extra/);
    await expectRefused(send(ev('NO-SUCH-UNIT')), 'EBMR-EQD-002', /is not known to this installation/);
  });
});

describe('native series (DI-32, DI-31)', () => {
  type Sample = { sourceTime: string; serverTime: string | null; raw: string; value: string | null; status: string };
  const sampleHash = (c: { subjectKind: string; subjectCode: string; tag: string; unit: string; chunkNo: string; samples: Sample[] }) =>
    sha([[c.subjectKind, c.subjectCode, c.tag, c.unit, c.chunkNo].join('|'), ...c.samples.map((s) => [s.sourceTime, s.serverTime ?? '', s.raw, s.value ?? '', s.status].join('|'))].join('\n'));
  const samplesFrom = (t0: bigint, n = 3): Sample[] =>
    Array.from({ length: n }, (_, i) => ({ sourceTime: (t0 + BigInt(i) * 100_000n).toString(), serverTime: null, raw: '12.5', value: '12.50', status: '0x00000000' }));
  const chunk = (subjectCode: string, chunkNo: string, samples: unknown, over: Record<string, unknown> = {}) => {
    const c = { subjectKind: 'EQUIPMENT', subjectCode, tag: 'force.main_kN', unit: 'kN', chunkNo, samples, ...over };
    return { ...c, chunkHash: (over['chunkHash'] as string | undefined) ?? (Array.isArray(samples) ? sampleHash(c as Parameters<typeof sampleHash>[0]) : sha('no samples')) };
  };
  const sendChunk = (payload: unknown, a: TestAdapter = opcua, type?: string) =>
    receive(db, a, 'plant.receive_series_chunk', envelopeFor(a, type ?? (a.system === 'EMS' ? 'ems.series_chunk' : 'opcua.series_chunk'), payload));

  it('[DI-31][DI-32] a chunk is refused for each malformed chunk field and each malformed sample field on its own; a raw text of 64 characters is taken', async () => {
    const press = await servedPress();
    const t0 = BigInt(nowUs()) - 120_000_000n; // within the five minutes before the session (6jc-R13, recipe-core 1233)
    const bad = /malformed series chunk: chunkNo, 1 to 2000 samples/;
    await expectRefused(sendChunk(chunk(press.code, '0', samplesFrom(t0))), 'EBMR-EQD-001', bad);
    await expectRefused(sendChunk(chunk(press.code, '1', { sourceTime: '1' })), 'EBMR-EQD-001', bad);
    await expectRefused(sendChunk(chunk(press.code, '1', [])), 'EBMR-EQD-001', bad);
    await expectRefused(sendChunk(chunk(press.code, '1', samplesFrom(t0, 2001))), 'EBMR-EQD-001', bad);
    await expectRefused(sendChunk(chunk(press.code, '1', samplesFrom(t0), { chunkHash: 'not-a-hash' })), 'EBMR-EQD-001', bad);
    const sample = /malformed sample: sourceTime, serverTime or null/;
    const s0 = samplesFrom(t0, 1)[0]!;
    for (const s of [
      'x', { ...s0, extra: '1' }, { ...s0, sourceTime: '01' }, { ...s0, serverTime: 'x' }, { ...s0, raw: '' }, { ...s0, raw: '1'.repeat(65), value: null },
      { ...s0, status: '0x0' },
    ]) {
      await expectRefused(sendChunk(chunk(press.code, '1', [s])), 'EBMR-EQD-001', sample);
    }
    const order = /source times increase within a chunk/;
    await expectRefused(sendChunk(chunk(press.code, '1', [s0, { ...s0 }])), 'EBMR-EQD-001', order);
    await expectRefused(sendChunk(chunk(press.code, '1', [s0, { ...s0, sourceTime: (t0 - 1n).toString() }])), 'EBMR-EQD-001', order);
    expect(await sendChunk(chunk(press.code, '1', [{ ...s0, raw: '1'.repeat(64), value: null }]))).toMatchObject({ outcome: 'ACCEPTED' });
    await expectRefused(sendChunk(chunk(press.code, '2', samplesFrom(t0 + 1_000_000n)), opcua, 'opcua.alarm'), 'EBMR-EQD-001', /this command receives opcua.series_chunk/);
    // A room tag in the unit's own unit of measure on a unit: the wrong kind of subject.
    await expectRefused(sendChunk(chunk(press.code, '2', samplesFrom(t0 + 1_000_000n), { tag: 'room.rh_pct', unit: '%RH' })), 'EBMR-EQD-002', /wrong tag/);
  });

  it('[DI-32] a chunk that ends where a recorded chunk begins, or begins where one ends, overlaps it', async () => {
    const press = await servedPress();
    const t0 = BigInt(nowUs()) - 120_000_000n; // within the five minutes before the session (6jc-R13, recipe-core 1233)
    expect(await sendChunk(chunk(press.code, '5', samplesFrom(t0)))).toMatchObject({ outcome: 'ACCEPTED' }); // t0 .. t0 + 200 ms
    await expectRefused(sendChunk(chunk(press.code, '6', samplesFrom(t0 + 200_000n))), 'EBMR-EQD-005');
    await expectRefused(sendChunk(chunk(press.code, '4', samplesFrom(t0 - 200_000n))), 'EBMR-EQD-005');
    expect(await sendChunk(chunk(press.code, '6', samplesFrom(t0 + 200_001n)))).toMatchObject({ outcome: 'ACCEPTED' });
    expect(await sendChunk(chunk(press.code, '4', samplesFrom(t0 - 200_001n)))).toMatchObject({ outcome: 'ACCEPTED' });
  });
});

describe('original records of simple devices (DI-32)', () => {
  const rec = (r: Record<string, unknown>, actor = opcua.actor) =>
    w.run(actor, async (c) => (await c.query<{ id: string }>('select plant.record_device_original($1::jsonb) as id', [JSON.stringify(r)])).rows[0]!.id);

  it('[DI-32] an original record names a known device and batch and states its capture, step, value and unit, one clause at a time; it is kept on that device', async () => {
    const { press, batchId } = await pressInUse(`ORG-${tag()}`);
    const base = { equipmentCode: press.code, capture: 'TRANSMITTED', deviceRef: 'ns=2;s=force', rawOutput: '12.5', value: '12.50', unit: 'kN', deviceTimeUs: nowUs(), batchId, step: 'p-compress@1', entryRef: null };
    await expectRefused(rec({ ...base, equipmentCode: 'NO-SUCH-UNIT' }), 'EBMR-EQD-011', /is not known to this installation/);
    await expectRefused(rec({ ...base, batchId: randomUUID() }), 'EBMR-EQD-011', /is not known to this installation/);
    const form = /an original record states its capture/;
    for (const over of [{ capture: 'PHOTO' }, { step: ' ' }, { value: '12,50' }, { unit: '' }, { unit: 'k N' }]) {
      await expectRefused(rec({ ...base, ...over }), 'EBMR-EQD-012', form);
    }
    const id = await rec(base);
    expect((await db.app.query('select equipment_id from plant.device_original where id = $1', [id])).rows).toEqual([{ equipment_id: press.id }]);
  });

  it('[DI-32] raw text states the shown decimal exactly or not at all: no null, no malformed raw or shown text, no rounding', async () => {
    const f = (raw: string | null, value: string | null) => one<boolean | null>('select plant.raw_states_value($1, $2) as r', [raw, value]);
    expect(await f(null, '1')).toBe(false);
    expect(await f('1', null)).toBe(false);
    expect(await f('abc', '1')).toBe(false);
    expect(await f('1', '01')).toBe(false);
    expect(await f('1', '1.')).toBe(false);
    expect(await f('1.0E0', '1')).toBe(true);
    expect(await f('12.499', '12.50')).toBe(false);
  });
});

describe('the batch context of a subject at an instant (DI-49, DI-32)', () => {
  const ctx = (kind: string, equipment: string | null, area: string | null, at: string) =>
    db.admin.query<{ batch_id: string; step: string | null }>('select batch_id, step from plant.batch_context_at($1, $2, $3, $4::timestamptz) order by batch_id', [kind, equipment, area, at]).then((r) => r.rows);
  const at = (sql: string, params: unknown[]) => one<string>(sql, params);

  it('[DI-49] a unit serves the batch of the use open at the instant, with the step that batch last bound to it in that use, from the first microsecond', async () => {
    const label = `CTX-${tag()}`;
    const { press, batchId, product, useId } = await pressInUse(label, 's-old');
    await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, useId));
    const ended = await at('select ended_at::text as r from plant.equipment_use_status where id = $1', [useId]);
    const started1 = await at('select started_at::text as r from plant.equipment_use_status where id = $1', [useId]);
    const boundOld = await at("select bound_at::text as r from plant.step_equipment where use_id = $1 and step = 's-old'", [useId]);
    await w.clean('EQUIPMENT', press.code, 'MAJOR');
    const use2 = await w.startUse(press.code, label, product);
    // The same batch on a second unit, bound later.
    const p2 = await w.press();
    await w.clean('EQUIPMENT', p2.code, 'MAJOR');
    await w.startUse(p2.code, label, product);
    await bind(batchId, 's-elsewhere', p2.code);
    const now = await at('select clock_timestamp()::text as r', []);
    // The new use, no step bound in it yet: not the old use's step, not the step on the other unit.
    expect(await ctx('EQUIPMENT', press.id, null, now)).toEqual([{ batch_id: batchId, step: null }]);
    await bind(batchId, 's-new', press.code);
    const boundNew = await at("select bound_at::text as r from plant.step_equipment where use_id = $1 and step = 's-new'", [use2]);
    expect(await ctx('EQUIPMENT', press.id, null, boundNew)).toEqual([{ batch_id: batchId, step: 's-new' }]);
    // The first use: open from its first microsecond, closed at its end; its step from the instant it was bound.
    expect(await ctx('EQUIPMENT', press.id, null, started1)).toEqual([{ batch_id: batchId, step: null }]);
    expect(await ctx('EQUIPMENT', press.id, null, boundOld)).toEqual([{ batch_id: batchId, step: 's-old' }]);
    expect(await ctx('EQUIPMENT', press.id, null, ended)).toEqual([]);
  });

  it('[DI-49] a room serves the batches occupying it at the instant, from the first microsecond, until its end; never another room\'s', async () => {
    const product = await w.product();
    const occupy = async (label: string) => {
      const room = await w.room();
      await w.clean('AREA', room.code, 'MAJOR');
      await w.clear(room.code, 'PRODUCT_CHANGE', { batch: label, product });
      const occ = await w.startIn(room.code, { batch: label, product });
      return { room, occ, batchId: (await w.batch(label, product)).id };
    };
    const r1 = await occupy(`OCC-1-${tag()}`);
    const r2 = await occupy(`OCC-2-${tag()}`);
    await occupy(`OCC-3-${tag()}`);
    await w.run(w.cast.operator, (c) => plant.endAreaOccupancy(c, r1.occ));
    const started = await at('select started_at::text as r from plant.area_occupancy where id = $1', [r1.occ]);
    const ended = await at('select ended_at::text as r from plant.area_occupancy_end where occupancy_id = $1', [r1.occ]);
    const now = await at('select clock_timestamp()::text as r', []);
    expect(await ctx('AREA', null, r2.room.id, now)).toEqual([{ batch_id: r2.batchId, step: null }]);
    expect(await ctx('AREA', null, r1.room.id, started)).toEqual([{ batch_id: r1.batchId, step: null }]);
    expect(await ctx('AREA', null, r1.room.id, ended)).toEqual([]);
    expect(await ctx('AREA', null, r1.room.id, now)).toEqual([]);
  });
});

describe('OPC UA endpoint identity (DI-20)', () => {
  const area = (deviceCode: string) => one<string | null>('select plant.device_area(d) as r from iam.device d where d.code = $1', [deviceCode]);
  const asAdmin = async <T>(sql: string, params: unknown[]): Promise<T | undefined> => {
    const { admin } = await seedAdministration(db);
    return withCommand(db.app, withReason(admin), async (c) => (await c.query<{ r: T }>(sql, params)).rows[0]?.r);
  };
  const retire = (deviceCode: string, reason: string | null) => asAdmin<number>('select plant.retire_opcua_endpoint($1, $2) as r', [deviceCode, reason]);

  it('[DI-20] the plant area of a registered device is its line when it has one, else its room', async () => {
    const line = await w.room({ kind: 'LINE' });
    const line2 = await w.room({ kind: 'LINE' });
    const room = await w.room();
    const onLine = await enrolEndpoint(db, { code: line.code, kind: 'LINE' }, [(await w.press()).code]);
    const inRoom = await enrolEndpoint(db, room, [(await w.press()).code]);
    expect(await area(onLine.code)).toBe(line.id);
    expect(await area(inRoom.code)).toBe(room.id);
    expect(line2.id).not.toBe(line.id);
    expect((await db.app.query('select area_id from plant.opcua_endpoint_current where device_code = $1', [onLine.code])).rows).toEqual([{ area_id: line.id }]);
  });

  it('[DI-20] enrolment states its reason, names an ACTIVE instrument and units of its own room; a retired endpoint no longer holds its units; retirement once', async () => {
    const room = await w.room();
    const press = await w.press();
    const ep = await enrolEndpoint(db, room, [press.code]);
    await expectRefused(asAdmin("select plant.enrol_opcua_endpoint($1, $2, 'Basic256Sha256', $3, '  ') as r", [ep.code, ep.url, [press.code]]), 'EBMR-EQD-030', /states its reason/);
    // A registered device that is no instrument, and an instrument that is not ACTIVE.
    const server = (await db.admin.query<{ c: string }>("select code as c from iam.device where device_class <> 'INSTRUMENT' and status = 'ACTIVE' limit 1")).rows[0]?.c;
    expect(server).toBeTruthy();
    await expectRefused(asAdmin("select plant.enrol_opcua_endpoint($1, $2, 'Basic256Sha256', $3, 'x') as r", [server, ep.url, [press.code]]), 'EBMR-EQD-031');
    // A unit installed in another room than the endpoint.
    const elsewhere = await w.room();
    const cls = (await db.admin.query<{ c: string }>('select class_code as c from plant.equipment where id = $1', [press.id])).rows[0]!.c;
    const placed = `EQ-${tag()}`;
    await w.run(w.cast.steward, (c) => plant.defineEquipment(c, { code: placed, name: placed, classCode: cls, areaCode: elsewhere.code }));
    await expectRefused(enrolEndpoint(db, room, [placed]), 'EBMR-EQD-036', /is installed in another room or line/);
    // Installed in the endpoint's own room: enrolled.
    const own = await enrolEndpoint(db, elsewhere, [placed]);
    expect(await reportSession(db, opcua, own)).toMatchObject({ applied: 'SESSION_VALID' });
    // Retired, the endpoint no longer holds the unit; another endpoint takes it.
    await expectRefused(retire(ep.code, ' '), 'EBMR-EQD-030', /retirement states its reason/);
    expect(await retire(ep.code, 'decommissioned')).toBe(2);
    await expectRefused(retire(ep.code, 'again'), 'EBMR-EQD-038');
    await expectRefused(retire(`NOPE-${tag()}`, 'x'), 'EBMR-EQD-038');
    const next = await enrolEndpoint(db, room, [press.code]);
    expect(next.units).toEqual([press.code]);
    // A unit installed elsewhere, served by its own endpoint, does not make this endpoint's session RELOCATED.
    expect(await reportSession(db, opcua, next)).toMatchObject({ applied: 'SESSION_VALID' });
    expect(await enrol(db, next.code, next.url, [press.code])).toBe(2);
  });

  it('[DI-20][DI-31] a session report is refused for each malformed field on its own, another message type or an unknown field; RELOCATED names where it is enrolled', async () => {
    const room = await w.room();
    const press = await w.press();
    const ep = await enrolEndpoint(db, room, [press.code]);
    const malformed = /malformed endpoint session: endpointCode, endpointUrl/;
    for (const over of [
      { endpointCode: '-bad' }, { endpointUrl: 'http://x' }, { securityMode: 'Encrypt' }, { securityPolicy: 'has space' }, { certificateThumbprint: 'ABC' },
      { reportedLocation: 'rm-lower' }, { equipmentCodes: press.code }, { equipmentCodes: [] }, { equipmentCodes: Array.from({ length: 65 }, (_, i) => `EQ-${i}`) },
      { equipmentCodes: [5] }, { equipmentCodes: ['lower'] },
    ]) {
      await expectRefused(reportSession(db, opcua, ep, over), 'EBMR-EQD-020', malformed);
    }
    const payload = { endpointCode: ep.code, endpointUrl: ep.url, securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256', certificateThumbprint: ep.thumbprint, reportedLocation: ep.areaCode, equipmentCodes: ep.units, openedAt: nowUs() };
    await expectRefused(receive(db, opcua, 'plant.receive_opcua_endpoint_session', envelopeFor(opcua, 'opcua.series_chunk', payload)), 'EBMR-EQD-020', /this command receives opcua.endpoint_session/);
    await expectRefused(receive(db, opcua, 'plant.receive_opcua_endpoint_session', envelopeFor(opcua, 'opcua.endpoint_session', { ...payload, extra: 1 })), 'EBMR-EQD-020', /unknown field extra/);
    expect(await reportSession(db, opcua, ep, { reportedLocation: null })).toMatchObject({ applied: 'SESSION_VALID' });
    const other = await w.room();
    const moved = await reportSession(db, opcua, ep, { reportedLocation: other.code });
    expect(moved).toMatchObject({ applied: 'SESSION_REFUSED', refusal: 'RELOCATED' });
    expect(moved['detail']).toBe(`endpoint ${ep.code} reports location ${other.code}; it is enrolled in ${room.code} and registered in ${room.code}`);
  });
});

it('[DI-49] an EMS alarm is received for a room (the adapter of the EMS is in use here)', async () => {
  const room = await w.room();
  const r = await sendAlarm(alarmPayload(room.code, { subjectKind: 'AREA', alarmCode: code('RH'), tag: 'room.rh_pct', value: { value: '61.2', unit: '%RH' }, limit: { value: '60.0', unit: '%RH' } }), ems);
  expect(r).toMatchObject({ outcome: 'ACCEPTED', applied: 'RAISED' });
});

describe('the OPC UA data guard on owner-level writes (DI-20)', () => {
  /** Inserts a series row of `unit` as the owner (triggers on) in the adapter's command; the refusal's message, or 'inserted'. Rolled back. */
  async function ownerSeries(unit: string, inboundMessageId: string): Promise<string> {
    const ctx = await cmd(db, opcua.actor);
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
      await c.query('set local role ebmr_owner');
      await c.query(
        `insert into plant.series (source, subject_kind, equipment_id, tag, unit, chunk_no, from_us, to_us, sample_count, samples, chunk_hash, inbound_message_id)
         values ('OPCUA', 'EQUIPMENT', $1, 'force.main_kN', 'kN', 1, 1, 1, 1, '[{}]'::jsonb, repeat('a', 64), $2)`,
        [unit, inboundMessageId],
      );
      return 'inserted';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      await c.query('rollback');
      c.release();
    }
  }

  it('[DI-20] OPC UA data name the inbound message they came in, and only a session received before that message counts', async () => {
    const press = await servedPress();
    const session = (await db.admin.query<{ m: string }>(
      'select s.inbound_message_id::text as m from plant.opcua_endpoint_session s join plant.opcua_endpoint_unit eu on eu.endpoint_id = s.endpoint_id where eu.equipment_id = $1',
      [press.id],
    )).rows;
    expect(session).toHaveLength(1);
    expect(await ownerSeries(press.id, randomUUID())).toMatch(/EBMR-EQD-002 DI-20: OPC UA data name a unit and the inbound message they came in/);
    // Data claiming the session's own message: no session precedes them.
    expect(await ownerSeries(press.id, session[0]!.m)).toMatch(/EBMR-EQD-002 DI-20: no session of endpoint .* precedes the data of unit/);
  });

  it('[DI-20] a unit of another room on an enrolment (an owner-level write past the enrolment check) makes the session RELOCATED and its data refused as relocated', async () => {
    const room = await w.room();
    const press = await w.press();
    const ep = await enrolEndpoint(db, room, [press.code]);
    const elsewhere = await w.room();
    const cls = (await db.admin.query<{ c: string }>('select class_code as c from plant.equipment where id = $1', [press.id])).rows[0]!.c;
    const placed = `EQ-${tag()}`;
    const placedId = await w.run(w.cast.steward, (c) => plant.defineEquipment(c, { code: placed, name: placed, classCode: cls, areaCode: elsewhere.code }));
    const { admin } = await seedAdministration(db);
    const ctx = await cmd(db, admin);
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
      await c.query('set local role ebmr_owner');
      await c.query('insert into plant.opcua_endpoint_unit (endpoint_id, equipment_id) select id, $2 from plant.opcua_endpoint_current where device_code = $1', [ep.code, placedId]);
      await c.query('commit');
    } finally {
      c.release();
    }
    expect(await reportSession(db, opcua, ep)).toMatchObject({ applied: 'SESSION_REFUSED', refusal: 'RELOCATED' });
    const t0 = BigInt(nowUs()) - 120_000_000n; // within the five minutes before the session (6jc-R13, recipe-core 1233)
    const samples = [{ sourceTime: t0.toString(), serverTime: null, raw: '12.5', value: '12.50', status: '0x00000000' }];
    const body = { subjectKind: 'EQUIPMENT', subjectCode: placed, tag: 'force.main_kN', unit: 'kN', chunkNo: '1', samples };
    const hash = sha([['EQUIPMENT', placed, 'force.main_kN', 'kN', '1'].join('|'), [t0.toString(), '', '12.5', '12.50', '0x00000000'].join('|')].join('\n'));
    await expectRefused(receive(db, opcua, 'plant.receive_series_chunk', envelopeFor(opcua, 'opcua.series_chunk', { ...body, chunkHash: hash })), 'EBMR-EQD-002', /was relocated after its enrolment/);
  });
});

describe('the functions Phase 6A re-created (recipe-core 1217, 1232, 1233, 1234; D-P7-1 item 4)', () => {
  const st = async (sql: string, params: unknown[]): Promise<string> =>
    db.admin.query<{ r: string }>(sql, params).then((x) => String(x.rows[0]!.r), (e: unknown) => (e instanceof Error ? e.message : String(e)));

  it('[DI-31][DI-20] a source time is epoch microseconds of at most 16 digits, and not more than its bound before the session it stands on, the bound itself taken', async () => {
    expect(await st("select plant.source_time_or_raise('12345678901234567', 'EQD')::text as r", [])).toMatch(/^EBMR-EQD-001 malformed source time 12345678901234567/);
    const start = BigInt(nowUs());
    const at = (d: bigint): string => (start + d).toString();
    const three = (us: string, notBefore: string | null) => st('select plant.source_time_or_raise($1, $2, $3::bigint)::text as r', [us, 'EQD', notBefore]);
    expect(await three(at(-300_000_000n), start.toString())).toBe(at(-300_000_000n));
    expect(await three(at(-300_000_001n), start.toString())).toMatch(/^EBMR-EQD-003 source time \d+ is more than five minutes before the start of the endpoint session/);
    expect(await three(at(-60_000_000n), start.toString())).toBe(at(-60_000_000n));
    expect(await three(at(-900_000_000n), null)).toBe(at(-900_000_000n));
    const four = (us: string, allowed: string) => st('select plant.source_time_or_raise($1, $2, $3::bigint, $4::bigint)::text as r', [us, 'ALM', start.toString(), allowed]);
    expect(await four(at(-7_000_000n), '7000000')).toBe(at(-7_000_000n));
    expect(await four(at(-7_000_001n), '7000000')).toMatch(/^EBMR-ALM-003 source time \d+ is more than 7 s before the start of the endpoint session/);
  });

  it('[DI-20] the session a unit\'s data stand on is the last one of its own endpoint on this adapter, not another endpoint\'s later session', async () => {
    // Since recipe-core 1235 every OPC UA record may be as old as the gateway's offline buffer (7 days by default) before
    // its session's start. A's session started six days ago, B's (another endpoint, same adapter) now: a sample of seven
    // days and an hour ago stands on A's session, not on B's.
    const room = await w.room();
    const a = await w.press();
    const b = await w.press();
    const epA = await enrolEndpoint(db, room, [a.code]);
    const epB = await enrolEndpoint(db, room, [b.code]);
    const now = BigInt(nowUs());
    const DAY = 86_400_000_000n;
    expect(await reportSession(db, opcua, epA, { openedAt: (now - 6n * DAY).toString() })).toMatchObject({ applied: 'SESSION_VALID' });
    expect(await reportSession(db, opcua, epB, { openedAt: now.toString() })).toMatchObject({ applied: 'SESSION_VALID' });
    const t0 = now - 7n * DAY - 3_600_000_000n;
    const samples = [{ sourceTime: t0.toString(), serverTime: null, raw: '12.5', value: '12.50', status: '0x00000000' }];
    const body = { subjectKind: 'EQUIPMENT', subjectCode: a.code, tag: 'force.main_kN', unit: 'kN', chunkNo: '1', samples };
    const hash = sha([['EQUIPMENT', a.code, 'force.main_kN', 'kN', '1'].join('|'), [t0.toString(), '', '12.5', '12.50', '0x00000000'].join('|')].join('\n'));
    expect(await receive(db, opcua, 'plant.receive_series_chunk', envelopeFor(opcua, 'opcua.series_chunk', { ...body, chunkHash: hash }))).toMatchObject({ outcome: 'ACCEPTED' });
    // The same sample for B is more than the buffer before B's session.
    const hb = sha([['EQUIPMENT', b.code, 'force.main_kN', 'kN', '1'].join('|'), [t0.toString(), '', '12.5', '12.50', '0x00000000'].join('|')].join('\n'));
    await expectRefused(receive(db, opcua, 'plant.receive_series_chunk', envelopeFor(opcua, 'opcua.series_chunk', { ...body, subjectCode: b.code, chunkHash: hb })), 'EBMR-EQD-003', /before the start of the endpoint session/);
  });

  it('[DI-31][DI-49][DI-20] a series gap is refused for another message type, an unknown field, each malformed field on its own, an empty interval, a wrong tag and a unit without its session; a valid one raises the alarm', async () => {
    const press = await servedPress();
    const from = BigInt(nowUs()) - 60_000_000n;
    const gap = (over: Record<string, unknown> = {}) => ({
      subjectKind: 'EQUIPMENT', subjectCode: press.code, tag: 'force.main_kN', unit: 'kN', fromUs: from.toString(), toUs: (from + 10_000_000n).toString(),
      reason: 'GATEWAY_RESTART', detail: 'gateway restarted', ...over,
    });
    const send = (payload: unknown, type = 'opcua.series_gap') => receive(db, opcua, 'plant.receive_series_gap', envelopeFor(opcua, type, payload));
    const MALFORMED = /^EBMR-EQD-040 malformed series gap: subjectKind, subjectCode, tag, unit, fromUs and toUs/;
    await expectRefused(send(gap(), 'opcua.series_chunk'), 'EBMR-EQD-040', /this command receives opcua.series_gap, not opcua.series_chunk/);
    await expectRefused(send(gap({ extra: '1' })), 'EBMR-EQD-040', /unknown field extra/);
    for (const over of [{ toUs: 'soon' }, { fromUs: '-1' }, { reason: 'POWER_CUT' }, { detail: '   ' }, { detail: 'x'.repeat(501) }]) {
      await expectRefused(send(gap(over)), 'EBMR-EQD-040', MALFORMED);
    }
    await expectRefused(send(gap({ toUs: from.toString() })), 'EBMR-EQD-040', /fromUs \d+ is not before toUs \d+/);
    await expectRefused(send(gap({ unit: 'N' })), 'EBMR-EQD-002', /is not a series tag of a equipment in its unit/);
    await expectRefused(send(gap({ tag: 'room.temp_C', unit: 'degC' })), 'EBMR-EQD-002', /is not a series tag of a equipment in its unit/);
    const unserved = await w.press();
    await expectRefused(send(gap({ subjectCode: unserved.code })), 'EBMR-EQD-002', /\(wrong identity\)$/);
    expect(await send(gap({ detail: 'y'.repeat(500) }))).toMatchObject({ outcome: 'ACCEPTED', applied: 'SERIES_GAP alarm raised' });
  });

  it('[DI-49] an alarm is acknowledged by a person: a service account whose role came to hold ALARM.ACKNOWLEDGE is refused by the kernel', async () => {
    const press = await servedPress();
    const r = await sendAlarm(alarmPayload(press.code, { alarmCode: code('SVC') }));
    // A service account cannot be granted a role that acknowledges (EBMR-IAM-035); here its own role is given the
    // permission afterwards, behind the triggers' back, and taken away again.
    const svc = await seedServiceActor(db, { kind: 'SERVICE', source: 'SYSTEM', name: 'Service identity' });
    const c = await db.admin.connect();
    const tamper = async (sqlText: string): Promise<void> => {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query(sqlText);
      await c.query('commit');
    };
    try {
      await tamper("insert into iam.role_permission (role_code, permission_code) values ('SERVICE_ACCOUNT', 'ALARM.ACKNOWLEDGE')");
      // The kernel refuses the permission itself to a non-interactive account, before plant.acknowledge_alarm's own
      // person check (EBMR-ALM-010, recorded as equivalent in tools/sql-mutation/equivalent.json).
      await expectRefused(acknowledge(r['alarmId'] as string, 'Checked', 'Acknowledged by a service', null, svc), 'EBMR-IAM-040', /lacks permission ALARM\.ACKNOWLEDGE .*NON_INTERACTIVE_ACCOUNT_CANNOT_SIGN/);
    } finally {
      await tamper("delete from iam.role_permission where role_code = 'SERVICE_ACCOUNT' and permission_code = 'ALARM.ACKNOWLEDGE'");
      c.release();
    }
  });
});
