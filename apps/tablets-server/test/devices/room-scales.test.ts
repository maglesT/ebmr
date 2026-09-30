/**
 * Two scales in one room, and the manual two-person path (review finding P50; DI-30, DI-32, PR-20, DI-20).
 *
 * DeviceReadingPort.scaleStatus(room) is the scale the step screen shows in its header and captures from.
 * tab.bind_instrument allows any number of instruments per room (a floor scale and a bench balance is a normal
 * dispensing set-up). The port used to answer the first scale of the room by device code, whatever its status, so a
 * scale that was not online could open the manual path while another scale of the room was online, and be written
 * into the record as the balance.
 *
 * Safe behaviour: while any validated scale of the step's room is ONLINE, the step header shows an ONLINE scale
 * (the one the step captures from) and hand-keyed weights are refused (EBMR-EXE-074); only when no scale of the room
 * is ONLINE is the manual two-person path open. With several scales in the room and none online, the header names
 * none and a hand-keyed weighing is recorded with the balance the operator names (a scale of the room), else MANUAL,
 * not with whichever scale sorts first (a skeptic found TEST-BAL-00, never connected, written into the record while
 * TEST-BAL-01, the scale in use, was offline). That holds only for a room with several scales: a room with one scale
 * keeps naming it whatever its status (decision X3), so a hand-keyed weighing there records that scale as its
 * balance although the server cannot know it was the one read. The statuses that opened the fallback are stored with
 * the row, so the record still shows that the scale was not online.
 *
 * Round-1 verification: a terminal of no room opened the manual path on a stage that names no room, and nothing
 * recorded which balance was read or the statuses that justified the fallback. The database side of the gate (race,
 * bypass, serialisation with the heartbeats, a terminal of no room; tablets 0310) is proved in
 * manual-weighing-gate.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { scaleStatuses } from '../../src/features/devices/port.ts';
import type { FakeGateway } from './support.ts';
import { handKeyed, lastEvidence, newRun, PCM, reachPcm, report, roomFreeDispensing, startRig, stopRig, forgedWeighing, type Rig } from './room-scales-support.ts';
import { outcomeOf, refusalOf, rowsOf, RunDriver, valueOf, violations, type ExecServer } from '../execution/support.ts';

let rig: Rig;
let server: ExecServer;
let gw: FakeGateway;

beforeAll(async () => {
  rig = await startRig();
  ({ server, gw } = rig);
}, 180_000);

afterAll(async () => {
  await stopRig(rig);
});

/** What a refusal tells the person (what happened and why). */
const said = (r: Parameters<typeof refusalOf>[0]): string => `${refusalOf(r).whatHappened} ${refusalOf(r).why}`;

describe('review P50: with two scales in a room, the header and the manual-entry gate never use an arbitrary one (DI-30, DI-32, PR-20)', () => {
  it('[PR-20][DI-32][DI-30] while a scale of the step\'s room is online, the header shows an online scale and hand-keyed weights are refused; with none online the manual path opens and the record never names an arbitrary balance', async () => {
    const d = await newRun(rig);
    await reachPcm(d);

    // Case 1: TEST-BAL-01, the DISP-1 balance, is online (fresh heartbeat with its registered serial); TEST-BAL-00,
    // first by code, has never reported.
    const hb = await gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' }]);
    expect(hb.status, JSON.stringify(hb.body)).toBe(200);
    const scales = await scaleStatuses(server.built.ctx, 'DISP-1');
    expect(scales.map((s) => [s.deviceCode, s.status])).toEqual([
      ['TEST-BAL-00', 'UNKNOWN'],
      ['TEST-BAL-01', 'ONLINE'],
    ]);
    // The operator's own screen lists TEST-BAL-01 online in the room.
    const listed = valueOf(await d.browser('operator1').call(routes.devices.scales, { query: { room: 'DISP-1' } })).scales;
    expect(listed.find((s) => s.deviceCode === 'TEST-BAL-01')?.status).toBe('ONLINE');
    // The step header shows the online scale, the one the step captures from.
    expect.soft((await d.stepView('operator1', PCM)).run.scale).toMatchObject({ deviceCode: 'TEST-BAL-01', status: 'ONLINE' });

    // Hand-keyed tare and gross while a validated scale of the room is online: refused, nothing recorded.
    const r = await d.command('operator1', handKeyed);
    const recorded = r.ok ? (r.value.step?.entries.at(-1)?.data ?? null) : null;
    expect({ outcome: outcomeOf(r), recorded }).toEqual({ outcome: '422:EBMR-EXE-074', recorded: null });

    // The scale in use, TEST-BAL-01, goes offline; TEST-BAL-00 has still never reported. No scale of the room is
    // online, so the manual two-person path opens; but nothing says which balance the operator read, so the header
    // names no scale and the record names none: never TEST-BAL-00, a scale that was never connected.
    expect((await gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'OFFLINE', serial: null }])).status).toBe(200);
    expect((await scaleStatuses(server.built.ctx, 'DISP-1')).map((s) => [s.deviceCode, s.status])).toEqual([
      ['TEST-BAL-00', 'UNKNOWN'],
      ['TEST-BAL-01', 'OFFLINE'],
    ]);
    expect.soft((await d.stepView('operator1', PCM)).run.scale).toBeNull();
    const keyed = valueOf(await d.command('operator1', handKeyed));
    expect(keyed.step?.entries.at(-1)?.data).toMatchObject({ source: 'MANUAL', balance: 'MANUAL', tare: '1.250', gross: '51.250' });
    expect(keyed.step?.exceptions.map((e) => e.type)).toContain('MANUAL_ENTRY_FALLBACK');
    // The statuses that opened the fallback are stored with the row, with the balance recorded and none named.
    expect((await lastEvidence(rig, d.runId))['manual']).toEqual({
      room: 'DISP-1',
      balance: 'MANUAL',
      declaredBalance: null,
      scales: [
        { deviceCode: 'TEST-BAL-00', status: 'UNKNOWN', lastHeartbeatUs: null },
        { deviceCode: 'TEST-BAL-01', status: 'OFFLINE', lastHeartbeatUs: expect.stringMatching(/^[0-9]+$/) as unknown },
      ],
    });

    // Case 2 (the reverse order): TEST-BAL-00 is online, TEST-BAL-01 is off. The header, the capture and the gate
    // all use TEST-BAL-00, so the weighing can be captured and is never keyed by hand beside an online scale.
    expect((await gw.heartbeat([
      { deviceCode: 'TEST-BAL-00', state: 'ONLINE', serial: 'SIM-0000' },
      { deviceCode: 'TEST-BAL-01', state: 'OFFLINE', serial: null },
    ])).status).toBe(200);
    expect((await d.stepView('operator1', PCM)).run.scale).toMatchObject({ deviceCode: 'TEST-BAL-00', status: 'ONLINE' });
    const r2 = await d.command('operator1', handKeyed);
    expect(outcomeOf(r2)).toBe('422:EBMR-EXE-074');
    // The weighing is recorded from the scale the header names.
    const tare = gw.next({ deviceCode: 'TEST-BAL-00', serial: 'SIM-0000', value: '1.25', purpose: 'TARE' });
    const gross = gw.next({ deviceCode: 'TEST-BAL-00', serial: 'SIM-0000', value: '51.25', purpose: 'GROSS' });
    const up = await gw.uplink([{ reading: tare }, { reading: gross }]);
    expect(up.body.refused, JSON.stringify(up.body)).toBeNull();
    const captured = valueOf(await d.command('operator1', { type: 'RECORD_ENTRY', stepKey: PCM, entry: { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', tareReadingId: tare.readingId, grossReadingId: gross.readingId } }));
    expect(captured.step?.entries.at(-1)?.data).toMatchObject({ balance: 'TEST-BAL-00', source: 'DEVICE', tare: '1.25', gross: '51.25' });

    // Both scales offline again, both known: still no single scale to name, so the header shows none.
    expect((await gw.heartbeat([
      { deviceCode: 'TEST-BAL-00', state: 'OFFLINE', serial: null },
      { deviceCode: 'TEST-BAL-01', state: 'OFFLINE', serial: null },
    ])).status).toBe(200);
    expect((await d.stepView('operator1', PCM)).run.scale).toBeNull();
  }, 300_000);

  it('[DI-32][PR-20] the port answers an online scale of the room whenever one is online, whatever the device codes sort', async () => {
    const port = server.built.ctx.deviceReadings;
    expect((await gw.heartbeat([
      { deviceCode: 'TEST-BAL-00', state: 'OFFLINE', serial: null },
      { deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' },
    ])).status).toBe(200);
    expect(await port.scaleStatus('DISP-1')).toMatchObject({ deviceCode: 'TEST-BAL-01', status: 'ONLINE' });
    // None online: no scale of the room is ONLINE (the manual path is open), and with two of them the port names
    // neither (it cannot know which one the operator reads), whichever reported last; never another room's.
    expect((await gw.heartbeat([
      { deviceCode: 'TEST-BAL-00', state: 'OFFLINE', serial: null },
      { deviceCode: 'TEST-BAL-01', state: 'CONNECTING', serial: null },
    ])).status).toBe(200);
    expect(await port.scaleStatus('DISP-1')).toBeNull();
    expect((await gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'OFFLINE', serial: null }])).status).toBe(200);
    expect(await port.scaleStatus('DISP-1')).toBeNull();
    expect(await port.scaleStatus('BLEND-1')).toBeNull();
    expect(await port.scaleStatus(null)).toBeNull();
  }, 60_000);
});

describe('review P50, round-1 verification: the manual path names the room, the balance read and the statuses (DI-20, DI-30, PR-20)', () => {
  it('[DI-20][PR-20][DI-30] a terminal registered to no room never keys weights by hand, even on a stage that names no room: refused by the server and by the database', async () => {
    const d = await newRun(rig, { content: roomFreeDispensing() });
    await reachPcm(d);
    await report(rig, { 'TEST-BAL-00': 'OFFLINE', 'TEST-BAL-01': 'OFFLINE' });
    // operator1 goes to the office PC (registered to no room), where the steps of this stage are otherwise accepted.
    const office = new RunDriver(server, d.runId, { operator1: await server.asPersona('operator1', 'TEST-PC-01') });
    expect(office.browser('operator1').terminal).toBe('TEST-PC-01');
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const fromOffice = await office.command('operator1', handKeyed);
    expect(outcomeOf(fromOffice)).toBe('422:EBMR-EXE-074');
    // The server's own refusal (the database, behind it, says the same in its own words).
    expect(said(fromOffice)).toMatch(/only at a terminal of the room where the weighing is done/);
    // Written past the server from the office PC: the database refuses it too.
    expect(await forgedWeighing(rig, office)).toBe('EBMR-EXE-074');
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);

    // From the DISP-1 kiosk (a terminal of a room where no scale is online) the manual path is open.
    const kiosk = new RunDriver(server, d.runId, { operator1: await server.asPersona('operator1') });
    kiosk.beforeTap = d.beforeTap;
    const keyed = valueOf(await kiosk.command('operator1', handKeyed));
    expect(keyed.step?.entries.at(-1)?.data).toMatchObject({ source: 'MANUAL', balance: 'MANUAL' });
    expect(await violations(server)).toEqual([]);
  }, 300_000);

  it('[DI-20][DI-30][PR-20] the operator may name the balance read: a scale of the room is recorded as the balance while none of them is online, any other device is refused, and the statuses are stored with the row', async () => {
    const d = await newRun(rig);
    await reachPcm(d);
    await report(rig, { 'TEST-BAL-00': 'OFFLINE', 'TEST-BAL-01': 'OFFLINE' });
    const naming = (deviceCode: string) => ({ ...handKeyed, entry: { ...handKeyed.entry, manual: { ...handKeyed.entry.manual, deviceCode } } });
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const otherRoom = await d.command('operator1', naming('TEST-BAL-02'));
    const notAScale = await d.command('operator1', naming('TEST-KIOSK-DISP-1'));
    expect({ otherRoom: outcomeOf(otherRoom), notAScale: outcomeOf(notAScale) }).toEqual({ otherRoom: '422:EBMR-EXE-074', notAScale: '422:EBMR-EXE-074' });
    // The server's own refusals (the database, behind it, refuses such a balance too).
    expect(said(otherRoom)).toMatch(/TEST-BAL-02 is not a scale of room DISP-1/);
    expect(said(notAScale)).toMatch(/TEST-KIOSK-DISP-1 is not a scale of room DISP-1/);
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);

    const named = valueOf(await d.command('operator1', naming('TEST-BAL-00')));
    expect(named.step?.entries.at(-1)?.data).toMatchObject({ source: 'MANUAL', balance: 'TEST-BAL-00', tare: '1.250', gross: '51.250' });
    expect((await lastEvidence(rig, d.runId))['manual']).toEqual({
      room: 'DISP-1',
      balance: 'TEST-BAL-00',
      declaredBalance: 'TEST-BAL-00',
      scales: [
        { deviceCode: 'TEST-BAL-00', status: 'OFFLINE', lastHeartbeatUs: expect.stringMatching(/^[0-9]+$/) as unknown },
        { deviceCode: 'TEST-BAL-01', status: 'OFFLINE', lastHeartbeatUs: expect.stringMatching(/^[0-9]+$/) as unknown },
      ],
    });
    // Named while it is online: refused like any weight keyed by hand beside an online scale.
    await report(rig, { 'TEST-BAL-00': 'ONLINE' });
    expect(outcomeOf(await d.command('operator1', naming('TEST-BAL-00')))).toBe('422:EBMR-EXE-074');
    expect(await violations(server)).toEqual([]);
  }, 300_000);
});
