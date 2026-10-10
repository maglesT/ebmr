/**
 * Phase 3 slice 3a (D-S3-1; G-06, tablets 0820): process readings of a press behind the site gateway, setpoint
 * downloads with their read-back, alarm acknowledgements, and the binding of a G-06 step's entries to the readings.
 * The gateway speaks the integration-sdk process wire over the listener; the operator's entries are written past the
 * server (ExecutionTx and the store, as the application role) so the database alone decides.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import type { engine, flow } from '@ebmr/recipe-core';
import { execution } from '@ebmr/recipe-core';
import { actorOfBrowser } from '../esig/support.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { codeOf, appendAs, engineResult } from '../execution/db-guards-support.ts';
import { dcMiniVariant, importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';
import { adminActor, enrol, fakeGateway, type FakeGateway } from './support.ts';

let sbx: ExecServer;
let gw: FakeGateway;
let chainId: string;
let d: RunDriver;
const SERIAL = 'PRESS-0001';
const DEVICE = 'TEST-PRESS-01';
const RUN_SESSION = randomUUID();
let seq = 0;

type Json = Record<string, unknown>;

function withPress(): flow.MbrContent {
  return dcMiniVariant((prep, content) => {
    (content['references'] as Json[]).push({ id: 'SYS-PRS', kind: 'COMPUTERISED_SYSTEM', code: 'SYS-PRS', version: '1' });
    const press = {
      kind: 'phase', id: 'p-press', name: 'Compression run', block: { type: 'G-06', version: '1' },
      config: {
        setpoints: [{ tag: 'force.main_kN', value: '12.50', unit: 'kN', tolerance: '0.05' }],
        actuals: [{ tag: 'turret.speed_rpm', unit: 'rpm', min: '20.0', max: '60.0' }],
        criticalAlarms: ['force.main_kN'],
        maxAgeSeconds: 600,
      },
      records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
      signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } },
      significant: true, riskClass: 'HIGH', system: { kind: 'PLC', ref: 'SYS-PRS', recipe: 'RCP-COMP', recipeVersion: '5' },
    };
    const watch = { ...press, id: 'p-press-watch', name: 'Press link watch', config: { maxAgeSeconds: 1 } };
    return [press, watch, ...prep];
  });
}

const reading = (tag: string, value: string, unit: string, kind = 'ACTUAL', extra: Json = {}) => {
  seq += 1;
  return { deviceSerial: SERIAL, tag, value, unit, quality: 'GOOD', sourceTime: '1790584618000000', sequence: String(seq), kind, ...extra };
};

async function send(readings: Json[]) {
  return gw.post('/gw/v1/process-readings', { sessionId: RUN_SESSION, readings });
}

async function stored(): Promise<{ id: string; seq: string; tag: string; kind: string; value: string; received_us: string }[]> {
  const { rows } = await sbx.db.app.query<{ id: string; seq: string; tag: string; kind: string; value: string; received_us: string }>(
    'select id, seq::text, tag, kind, value, received_us::text from tab.process_reading where serial = $1 order by seq',
    [SERIAL],
  );
  return rows;
}

async function operator(): Promise<ActorContext> {
  vi.advanceTimersByTime(7_000);
  return actorOfBrowser(sbx, d.browser('operator1'), 'operator1');
}

/** operator1 records `entry` at p-press past the server, claiming `claim` first (a process reading id) in the same command. */
async function record(entry: Json & { kind: string }, opts: { claim?: string; ack?: { reading: string; comment: string } } = {}): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const me = personaIn(sbx, 'operator1');
  return codeOf(
    withCommand(sbx.db.app, await operator(), async (c) => {
      if (opts.claim) await c.query('select tab.claim_process_reading($1, $2, $3)', [opts.claim, d.runId, 'p-press']);
      if (opts.ack) await c.query('select tab.acknowledge_process_alarm($1, $2, $3, $4)', [opts.ack.reading, d.runId, 'p-press', opts.ack.comment]);
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = { type: 'RECORD_ENTRY', commandId: randomUUID(), actor: engineActor(me.personId, roles), step: 'p-press', context: [], entry };
      return appendAs(tx, command, engineResult(tx, command), roles);
    }),
  );
}

const asEntry = (r: { id: string; tag: string; value: string; received_us: string }, kind: string, unit: string): Json & { kind: string } => ({
  kind, tag: r.tag, value: r.value, unit, source: 'EQUIPMENT', readingId: r.id, quality: 'GOOD', receivedAtUs: r.received_us,
});

beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
  chainId = await enrol(sbx);
  const site = (await sbx.db.admin.query<{ s: string }>("select site_code as s from iam.device where code = 'TEST-BAL-01'")).rows[0]?.s ?? null;
  await identity.withGuardedCommand(sbx.db.app, await adminActor(sbx), async (c) => {
    await c.query('select iam.register_device($1, $2, $3, $4, $5, $6, $7)', [DEVICE, 'INSTRUMENT', site, 'DISP-1', null, createHash('sha256').update(`${DEVICE}:${randomUUID()}`).digest('hex'), 'Tablet press (simulated) behind the site gateway']);
    await c.query('select tab.bind_process_device($1, $2, $3, $4)', [chainId, DEVICE, SERIAL, 'PRESS']);
  });
  gw = await fakeGateway(sbx);
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withPress()));
  d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-press@' });
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await gw?.close();
  await sbx?.close();
});

describe('process readings over the gateway uplink (tablets 0820)', () => {
  it('[DI-31][DI-32] a request is taken whole: each reading stored once with its tag, decimal value and unit, quality, source time, sequence and the gateway capture session, at database time; the same request again is answered as duplicates', async () => {
    const batch = [reading('turret.speed_rpm', '45.0', 'rpm'), reading('force.main_kN', '12.48', 'kN')];
    const r = await send(batch);
    expect(r.status).toBe(200);
    const again = await send(batch);
    expect((again.body as { readings: { outcome: string }[] }).readings.map((x) => x.outcome)).toEqual(['DUPLICATE', 'DUPLICATE']);
    const rows = await stored();
    expect(rows.map((x) => [x.seq, x.tag, x.kind, x.value])).toEqual([['1', 'turret.speed_rpm', 'ACTUAL', '45.0'], ['2', 'force.main_kN', 'ACTUAL', '12.48']]);
    const { rows: run } = await sbx.db.app.query<{ g: string }>('select distinct gateway_run_id::text as g from tab.process_reading where serial = $1', [SERIAL]);
    expect(run).toEqual([{ g: RUN_SESSION }]);
  });

  it('[DI-31] a gap, a repeated sequence with other content, an unknown device, tag or unit, too many digits or a read-back of a tag without a setpoint is refused whole, with a device alarm; nothing of the request is kept', async () => {
    const before = (await stored()).length;
    const alarms = async () => Number((await sbx.db.app.query<{ n: string }>("select count(*)::text as n from tab.device_alarm where kind = 'READING_REFUSED'")).rows[0]?.n);
    const a0 = await alarms();
    const good = { deviceSerial: SERIAL, tag: 'turret.speed_rpm', value: '45.0', unit: 'rpm', quality: 'GOOD', sourceTime: '1790584618000000', kind: 'ACTUAL' };
    const next = String(seq + 1);
    const outcomes = {
      gap: (await send([{ ...good, sequence: String(seq + 2) }])).status,
      changed: (await send([{ ...good, sequence: '1', value: '46.0' }])).status,
      partial: (await send([{ ...good, sequence: next }, { ...good, sequence: String(seq + 2), deviceSerial: 'NOPE-9' }])).status,
      tag: (await send([{ ...good, sequence: next, tag: 'bed.temp_C', unit: 'degC', value: '40.0' }])).status,
      unit: (await send([{ ...good, sequence: next, unit: 'rph' }])).status,
      digits: (await send([{ ...good, sequence: next, value: '45.05' }])).status,
      readback: (await send([{ ...good, sequence: next, tag: 'tablet.count', unit: 'count', value: '10', kind: 'SETPOINT_READBACK' }])).status,
    };
    expect(outcomes).toEqual({ gap: 422, changed: 422, partial: 422, tag: 422, unit: 400, digits: 400, readback: 400 });
    expect((await stored()).length).toBe(before);
    expect(await alarms()).toBe(a0 + 7);
    // Only the gateway's functions write: the application role inserts nothing itself, a person cannot ingest.
    await expect(sbx.db.app.query("insert into tab.process_reading (process_device_id) values (gen_random_uuid())")).rejects.toThrow(/permission denied/);
    expect(await codeOf(withCommand(sbx.db.app, await operator(), (c) => c.query('select tab.ingest_process_readings($1::jsonb)', [JSON.stringify({ sessionId: RUN_SESSION, readings: [{ ...good, sequence: next }] })])))).toMatch(/EBMR-IAM-040|EBMR-DEV-030/);
  });

  it('[DI-31][PR-14] a setpoint download takes the MBR value of the step; the gateway fetches it, reads it back and acknowledges; an acknowledgement that contradicts its read-back is refused, the same one again is taken', async () => {
    const op = await operator();
    expect(await codeOf(withCommand(sbx.db.app, op, (c) => c.query('select tab.request_setpoint_download($1, $2, $3)', [d.runId, 'p-press', 'force.main_kN'])))).toBe('EBMR-DEV-133');
    await withCommand(sbx.db.app, await operator(), (c) => c.query('select tab.bind_step_device($1, $2, $3)', [d.runId, 'p-press', DEVICE]));
    expect(await codeOf(withCommand(sbx.db.app, await operator(), (c) => c.query('select tab.bind_step_device($1, $2, $3)', [d.runId, 'p-press', DEVICE])))).toBe('EBMR-DEV-131');
    expect(await codeOf(withCommand(sbx.db.app, await operator(), (c) => c.query('select tab.request_setpoint_download($1, $2, $3)', [d.runId, 'p-press', 'fill.depth_mm'])))).toBe('EBMR-DEV-132');
    const id = await withCommand(sbx.db.app, await operator(), async (c) => (await c.query<{ id: string }>('select tab.request_setpoint_download($1, $2, $3) as id', [d.runId, 'p-press', 'force.main_kN'])).rows[0]?.id ?? '');
    // Review 3a finding 2: a read-back received before the gateway fetched the download does not confirm it.
    const early = reading('force.main_kN', '12.52', 'kN', 'SETPOINT_READBACK');
    expect((await send([early])).status).toBe(200);
    const res = await fetch(`${gw.base}/gw/v1/setpoint-downloads`, { headers: { authorization: `Bearer ${gw.token}` } });
    expect(await res.json()).toEqual({ downloads: [{ id, deviceSerial: SERIAL, tag: 'force.main_kN', value: '12.50', unit: 'kN' }] });
    const stale = await gw.post(`/gw/v1/setpoint-downloads/${id}/ack`, { sessionId: RUN_SESSION, outcome: 'MISMATCH', readback: { value: '12.52', unit: 'kN', sourceTime: early.sourceTime, sequence: early.sequence }, message: null });
    expect([stale.status, (stale.body as { error: { code: string } }).error.code]).toEqual([422, 'EBMR-DEV-146']);
    const rb = reading('force.main_kN', '12.52', 'kN', 'SETPOINT_READBACK');
    expect((await send([rb])).status).toBe(200);
    const ack = { sessionId: RUN_SESSION, outcome: 'APPLIED', readback: { value: '12.52', unit: 'kN', sourceTime: rb.sourceTime, sequence: rb.sequence }, message: null };
    expect((await gw.post(`/gw/v1/setpoint-downloads/${id}/ack`, ack)).status).toBe(422);
    const mismatch = { ...ack, outcome: 'MISMATCH' };
    expect((await gw.post(`/gw/v1/setpoint-downloads/${id}/ack`, mismatch)).body).toMatchObject({ outcome: 'ACKNOWLEDGED' });
    expect((await gw.post(`/gw/v1/setpoint-downloads/${id}/ack`, mismatch)).body).toMatchObject({ outcome: 'DUPLICATE' });
    expect(await (await fetch(`${gw.base}/gw/v1/setpoint-downloads`, { headers: { authorization: `Bearer ${gw.token}` } })).json()).toEqual({ downloads: [] });
  });

  it('[DI-31][DI-32][PR-14] a G-06 value captured from the equipment is recorded only on the reading of the step device claimed for it in its command, exactly as received; the read-back only as the acknowledged read-back of a step download', async () => {
    const before = (await stored()).find((r) => r.tag === 'turret.speed_rpm') as Awaited<ReturnType<typeof stored>>[number];
    expect((await send([reading('turret.speed_rpm', '45.0', 'rpm'), reading('force.main_kN', '12.48', 'kN')])).status).toBe(200);
    const rows = await stored();
    const speed = rows.filter((r) => r.tag === 'turret.speed_rpm').at(-1) as (typeof rows)[number];
    const rb = rows.filter((r) => r.kind === 'SETPOINT_READBACK').at(-1) as (typeof rows)[number];
    const force = rows.filter((r) => r.tag === 'force.main_kN' && r.kind === 'ACTUAL').at(-1) as (typeof rows)[number];
    // Review 3a finding 3: a reading the device sent before the step was bound to it is not the step's.
    expect(await record(asEntry(before, 'ACTUAL', 'rpm'), { claim: before.id })).toBe('EBMR-DEV-144');
    const outcomes = {
      unclaimed: await record(asEntry(speed, 'ACTUAL', 'rpm')),
      forgedValue: await record({ ...asEntry(speed, 'ACTUAL', 'rpm'), value: '30.0' }, { claim: speed.id }),
      forgedTime: await record({ ...asEntry(speed, 'ACTUAL', 'rpm'), receivedAtUs: String(BigInt(speed.received_us) + 1n) }, { claim: speed.id }),
      wrongKind: await record(asEntry(force, 'SETPOINT_READBACK', 'kN'), { claim: force.id }),
      honest: await record(asEntry(speed, 'ACTUAL', 'rpm'), { claim: speed.id }),
      reused: await record(asEntry(speed, 'ACTUAL', 'rpm'), { claim: speed.id }),
      readback: await record(asEntry(rb, 'SETPOINT_READBACK', 'kN'), { claim: rb.id }),
    };
    expect(outcomes).toEqual({ unclaimed: 'EBMR-EXE-211', forgedValue: 'EBMR-EXE-211', forgedTime: 'EBMR-EXE-211', wrongKind: 'EBMR-EXE-211', honest: 'ok', reused: 'EBMR-DEV-145', readback: 'ok' });
    const { rows: uses } = await sbx.db.app.query<{ n: string }>('select count(*)::text as n from tab.process_reading_use where batch_id = $1', [d.runId]);
    expect(uses[0]?.n).toBe('2');
  });

  it('[DI-49] an alarm reading is acknowledged once, by a person, with a comment; the G-06 acknowledgement of a device alarm stands on that acknowledgement in its own command; the alarm log cannot be changed', async () => {
    expect((await send([reading('force.main_kN', '14.10', 'kN', 'ALARM')])).status).toBe(200);
    const alarm = (await stored()).find((r) => r.kind === 'ALARM') as Awaited<ReturnType<typeof stored>>[number];
    expect(await record(asEntry(alarm, 'ALARM', 'kN'), { claim: alarm.id })).toBe('ok');
    const { rows } = await sbx.db.admin.query<{ k: string }>("select k from recipe.execution_state s, jsonb_each(s.state -> 'entries') e(k, v) where s.batch_id = $1 and v ->> 'kind' = 'ALARM'", [d.runId]);
    const entryId = rows[0]?.k ?? '';
    const ackAlone = async (comment: string) => codeOf(withCommand(sbx.db.app, await operator(), (c) => c.query('select tab.acknowledge_process_alarm($1, $2, $3, $4)', [alarm.id, d.runId, 'p-press', comment])));
    expect(await ackAlone('  ')).toBe('EBMR-DEV-142');
    // Review 3a finding 3: an acknowledgement outside the step's ALARM_ACK entry is refused at commit.
    expect(await ackAlone('Seen on the HMI')).toBe('EBMR-DEV-148');
    expect(await codeOf(withCommand(sbx.db.app, await operator(), (c) => c.query('select tab.acknowledge_process_alarm($1, $2, $3, $4)', [alarm.id, d.runId, 'p-press-watch', 'x'])))).toBe('EBMR-DEV-141');
    const comment = 'Force spike on one station; punch inspected, no defect';
    expect(await record({ kind: 'ALARM_ACK', alarm: entryId, comment })).toBe('EBMR-EXE-211');
    expect(await record({ kind: 'ALARM_ACK', alarm: entryId, comment: 'another text' }, { ack: { reading: alarm.id, comment } })).toBe('EBMR-EXE-211');
    expect(await record({ kind: 'ALARM_ACK', alarm: entryId, comment }, { ack: { reading: alarm.id, comment } })).toBe('ok');
    expect(await ackAlone(comment)).toBe('EBMR-DEV-143');
    await expect(sbx.db.app.query('delete from tab.process_reading')).rejects.toThrow(/permission denied/);
    await expect(sbx.db.admin.query('delete from tab.process_reading where id = $1', [alarm.id])).rejects.toThrow(/EBMR-AUDIT-004/);
    await expect(sbx.db.admin.query('update tab.process_alarm_ack set comment = $1', ['x'])).rejects.toThrow(/EBMR-AUDIT-004/);
  });

  it('[DI-31][PR-14] interface loss is read from readings that stop arriving: a step is lost while unbound or when its device sent nothing for longer than the configured age (database time)', async () => {
    const status = async (step: string) => (await sbx.db.app.query<{ s: { lost: boolean; bound: boolean } }>('select tab.step_link_status($1, $2) as s', [d.runId, step])).rows[0]?.s;
    expect(await status('p-press')).toMatchObject({ bound: true, lost: false });
    expect(await status('p-press-watch')).toMatchObject({ bound: false, lost: true });
    await withCommand(sbx.db.app, await operator(), (c) => c.query('select tab.bind_step_device($1, $2, $3)', [d.runId, 'p-press-watch', DEVICE]));
    expect((await send([reading('turret.speed_rpm', '44.0', 'rpm')])).status).toBe(200);
    expect(await status('p-press-watch')).toMatchObject({ bound: true, lost: false });
    await sbx.db.admin.query('select pg_sleep(1.2)');
    expect(await status('p-press-watch')).toMatchObject({ bound: true, lost: true });
    expect(await codeOf(sbx.db.app.query('select tab.step_link_status($1, $2)', [d.runId, 'p-disp-clear']))).toBe('EBMR-DEV-130');
  });
});
