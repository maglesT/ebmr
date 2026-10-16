/**
 * The EMS simulator (Phase 6 slice 6b, builder B; DI-31, DI-32, DI-49): every published message is a valid envelope of
 * the EMS contract with a chunk hash the receiver can recompute, chunk numbers count up per room and tag, the shown
 * value is exactly the raw value, and a sensor that stops reporting raises the EMS's own FEED_GAP occurrence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMS, InboundEnvelope, payloadSchema, seriesChunkHash, type SeriesChunkV1 } from '@ebmr/integration-sdk/adapter';
import { emsSimulator } from '../../src/ems/model.ts';
import type { FeedClock, FeedEnvelope } from '../../src/system-feed/feed.ts';
import { startFeedSimulator, type RunningFeedSimulator } from '../../src/system-feed/server.ts';

const fixedClock = (): FeedClock => {
  let t = 1_790_000_000_000_000n;
  return { nowUs: () => (t += 1000n) };
};

function parsed(env: unknown): Record<string, unknown> {
  const e = InboundEnvelope.parse(env);
  const schema = payloadSchema(EMS, e);
  if (!schema) throw new Error(`no EMS schema for ${e.messageType}`);
  return schema.parse(e.payload) as Record<string, unknown>;
}

let sim: RunningFeedSimulator;
let base: string;
const post = async (path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const last = (): FeedEnvelope => {
  const all = sim.feed.published();
  return all[all.length - 1] as FeedEnvelope;
};

beforeAll(async () => {
  const { feed, plugin } = emsSimulator(fixedClock());
  sim = await startFeedSimulator(feed, plugin, { host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${sim.port.toString()}`;
});
afterAll(async () => {
  await sim?.close();
});

describe('the EMS simulator (DI-31, DI-32, DI-49)', () => {
  it('[DI-32][DI-31] publishes room samples as valid ems.series_chunk messages: native raw text, the exact shown value, a recomputable hash', async () => {
    const r = await post('/ems/v1/samples', { roomCode: 'RM-A', tag: 'room.temp_C', samples: [{ raw: '21.50' }, { raw: '2.18E1' }, { raw: '###', status: '0x80000000' }] });
    expect(r.status).toBe(201);
    const env = last();
    expect(env).toMatchObject({ sourceSystem: 'EMS', messageType: 'ems.series_chunk', sourceRecordId: 'RM-A/room.temp_C' });
    const p = parsed(env) as unknown as SeriesChunkV1;
    expect(p).toMatchObject({ subjectKind: 'AREA', subjectCode: 'RM-A', tag: 'room.temp_C', unit: 'degC', chunkNo: '1' });
    expect(p.samples.map((s) => [s.raw, s.value, s.status])).toEqual([['21.50', '21.5', '0x00000000'], ['2.18E1', '21.8', '0x00000000'], ['###', null, '0x80000000']]);
    expect(p.chunkHash).toBe(seriesChunkHash(p));
    const times = p.samples.map((s) => BigInt(s.sourceTime));
    expect(times.every((t, i) => i === 0 || t > (times[i - 1] as bigint))).toBe(true);
    expect(p.samples.every((s) => s.serverTime !== null && BigInt(s.serverTime) >= BigInt(s.sourceTime))).toBe(true);
    expect(BigInt(env.sourceTimestamp) > (times[times.length - 1] as bigint)).toBe(true);
  });

  it('[DI-31] numbers the chunks per room and tag from 1; an unknown tag or an empty chunk is refused and takes no number', async () => {
    expect((await post('/ems/v1/samples', { roomCode: 'RM-A', tag: 'room.temp_C', samples: [{ raw: '22.0' }] })).status).toBe(201);
    expect((parsed(last()) as unknown as SeriesChunkV1).chunkNo).toBe('2');
    expect((await post('/ems/v1/samples', { roomCode: 'RM-A', tag: 'room.rh_pct', samples: [{ raw: '45.2' }] })).status).toBe(201);
    expect(parsed(last())).toMatchObject({ chunkNo: '1', unit: '%RH' });
    expect((await post('/ems/v1/samples', { roomCode: 'RM-B', tag: 'room.temp_C', samples: [{ raw: '20.1' }] })).status).toBe(201);
    expect(parsed(last())).toMatchObject({ chunkNo: '1', subjectCode: 'RM-B' });
    expect((await post('/ems/v1/samples', { roomCode: 'RM-A', tag: 'room.dp_Pa', samples: [{ raw: '12' }] })).status).toBe(400);
    expect((await post('/ems/v1/samples', { roomCode: 'RM-A', tag: 'room.temp_C', samples: [] })).status).toBe(400);
    expect((await post('/ems/v1/samples', { roomCode: 'RM-A', tag: 'room.temp_C', samples: [{ raw: '22.1' }] })).status).toBe(201);
    expect(parsed(last())).toMatchObject({ chunkNo: '3' });
  });

  it('[DI-49] publishes a room alarm the client posts as a valid ems.alarm with the occurrence time', async () => {
    const r = await post('/ems/v1/alarms', {
      roomCode: 'RM-A', occurrenceId: 'EMS-1', transition: 'RAISED', alarmCode: 'TEMP_HIGH', severity: '800', tag: 'room.temp_C',
      value: { value: '26.1', unit: 'degC' }, limit: { value: '25.0', unit: 'degC' }, limitKind: 'HIGH', message: 'room temperature above 25.0 degC',
    });
    expect(r.status).toBe(201);
    expect(parsed(last())).toMatchObject({ subjectKind: 'AREA', subjectCode: 'RM-A', alarmCode: 'TEMP_HIGH', limitKind: 'HIGH' });
    expect((await post('/ems/v1/alarms', { roomCode: 'RM-A', occurrenceId: 'EMS-2', transition: 'RAISED', alarmCode: 'TEMP_HIGH', severity: '800', limitKind: 'HIGH', message: 'no limit' })).status).toBe(400);
  });

  it('[DI-31][DI-49] a sensor that stops reporting raises the EMS FEED_GAP occurrence; its samples are refused until it reports again, then the occurrence clears', async () => {
    const on = await post('/ems/v1/sensor-gap', { roomCode: 'RM-B', tag: 'room.rh_pct', on: true });
    expect(on.status).toBe(201);
    const raised = parsed(last());
    expect(raised).toMatchObject({ subjectKind: 'AREA', subjectCode: 'RM-B', transition: 'RAISED', alarmCode: 'FEED_GAP', tag: 'room.rh_pct', limit: null, limitKind: 'STATE', value: null });
    expect(String(raised['alarmCode'])).toMatch(/^[A-Z][A-Z0-9_.-]{0,63}$/);
    expect((await post('/ems/v1/sensor-gap', { roomCode: 'RM-B', tag: 'room.rh_pct', on: true })).body).toEqual({ unchanged: true });
    expect((await post('/ems/v1/samples', { roomCode: 'RM-B', tag: 'room.rh_pct', samples: [{ raw: '40.0' }] })).status).toBe(409);
    expect((await post('/ems/v1/samples', { roomCode: 'RM-B', tag: 'room.temp_C', samples: [{ raw: '20.2' }] })).status).toBe(201);
    expect((await post('/ems/v1/sensor-gap', { roomCode: 'RM-B', tag: 'room.rh_pct', on: false })).status).toBe(201);
    expect(parsed(last())).toMatchObject({ transition: 'CLEARED', alarmCode: 'FEED_GAP', occurrenceId: raised['occurrenceId'] });
    expect((await post('/ems/v1/samples', { roomCode: 'RM-B', tag: 'room.rh_pct', samples: [{ raw: '40.0' }] })).status).toBe(201);
    expect((await post('/ems/v1/sensor-gap', { roomCode: 'RM-B', tag: 'room.dp_Pa', on: true })).status).toBe(400);
  });

  it('[DI-31] WRONG_BATCH names an unknown room and keeps the chunk hash valid; MALFORMED breaks the contract', async () => {
    sim.feed.faults.add('WRONG_BATCH');
    await post('/ems/v1/samples', { roomCode: 'RM-A', tag: 'room.rh_pct', samples: [{ raw: '45.0' }] });
    sim.feed.faults.delete('WRONG_BATCH');
    const p = parsed(last()) as unknown as SeriesChunkV1;
    expect(p.subjectCode).toMatch(/^NO-SUCH-ROOM-/);
    expect(p.chunkHash).toBe(seriesChunkHash(p));
    sim.feed.faults.add('MALFORMED');
    await post('/ems/v1/samples', { roomCode: 'RM-A', tag: 'room.rh_pct', samples: [{ raw: '45.1' }] });
    sim.feed.faults.delete('MALFORMED');
    expect(() => parsed(last())).toThrow();
  });
});
