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
import { refusalOf } from '../esig/support.ts';
import { dcMiniVariant, importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';
import { adminActor, enrol, fakeGateway, type FakeGateway } from './support.ts';
import { pressInUse } from '../blocks/compression/plant-support.ts';
import { PROCESS_TAGS } from '@ebmr/integration-sdk/process';

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

/** Superuser test setup with triggers off for this transaction only (never used to prove a control). */
async function asTimeTraveller(server: ExecServer, text: string, params: unknown[]): Promise<void> {
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(text, params);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
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
async function record(entry: Json & { kind: string }, opts: { claim?: string; ack?: { reading: string; comment: string }; forge?: (r: engine.StepResult) => engine.StepResult } = {}): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const me = personaIn(sbx, 'operator1');
  return codeOf(
    withCommand(sbx.db.app, await operator(), async (c) => {
      if (opts.claim) await c.query('select tab.claim_process_reading($1, $2, $3)', [opts.claim, d.runId, 'p-press']);
      if (opts.ack) await c.query('select tab.acknowledge_process_alarm($1, $2, $3, $4)', [opts.ack.reading, d.runId, 'p-press', opts.ack.comment]);
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = { type: 'RECORD_ENTRY', commandId: randomUUID(), actor: engineActor(me.personId, roles), step: 'p-press', context: [], entry };
      const honest = engineResult(tx, command);
      return appendAs(tx, command, opts.forge ? opts.forge(structuredClone(honest)) : honest, roles);
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
  // Slice 3c (tablets 0870): the press is the plant unit of the batch's open use, and the device is linked to it.
  await pressInUse(sbx, operator, d.runId, { deviceCode: DEVICE });
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

  it('[DI-31][DI-32] D-P4-10, the device-to-entry path: over the server an entry from the equipment names only its reading; the server claims it in the entry\'s command and copies tag, value, unit, quality and receipt time; a typed value with it, no reading, an old reading or a used one is refused', async () => {
    expect((await send([reading('turret.speed_rpm', '46.5', 'rpm'), reading('force.main_kN', '12.60', 'kN'), reading('turret.speed_rpm', '47.0', 'rpm')])).status).toBe(200);
    const rows = await stored();
    const [speed, old] = rows.filter((r) => r.tag === 'turret.speed_rpm').slice(-2) as [(typeof rows)[number], (typeof rows)[number]];
    const block = (data: Json) => d.command('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-press@', entry: { kind: 'BLOCK_ENTRY', entryKind: 'ACTUAL', data } } as never);
    const code = async (data: Json) => {
      const r = await block(data);
      return r.ok ? 'ok' : (refusalOf(r)?.code ?? 'refused');
    };
    expect(await code({ source: 'EQUIPMENT', readingId: speed.id, value: '99.0' })).toBe('EBMR-API-DEVICE-TYPED');
    expect(await code({ source: 'EQUIPMENT' })).toBe('EBMR-API-DEVICE-READING');
    // A reading older than the step's window (its receipt moved back as superuser setup, triggers off) is refused at the claim.
    await asTimeTraveller(sbx, 'update tab.process_reading set received_us = received_us - 700000000 where id = $1', [old.id]);
    expect(await code({ source: 'EQUIPMENT', readingId: old.id })).toMatch(/EBMR-DEV-154|INVALID|EXECUTION/);
    expect(await code({ source: 'EQUIPMENT', readingId: speed.id })).toBe('ok');
    const state = (await execution.loadState(sbx.db.admin, d.runId))?.state;
    const recorded = Object.values(state?.entries ?? {}).find((e) => (e.data as Json)['readingId'] === speed.id) as unknown as Json | undefined;
    expect(recorded?.['data']).toMatchObject({ source: 'EQUIPMENT', readingId: speed.id, quality: 'GOOD', receivedAtUs: speed.received_us });
    expect(await code({ source: 'EQUIPMENT', readingId: speed.id })).toMatch(/EBMR-DEV-145|INVALID|EXECUTION/);
    // Bypass: the claim checks the window in the database as the application role too.
    expect(await codeOf(withCommand(sbx.db.app, await operator(), (c) => c.query('select tab.claim_process_reading($1, $2, $3)', [old.id, d.runId, 'p-press'])))).toBe('EBMR-DEV-154');
    // A value keyed by hand is still the MBR's to allow (source MANUAL; this press's MBR keeps the fallback shut while the link is up).
    expect(await code({ source: 'MANUAL', tag: 'turret.speed_rpm', value: '46.0', unit: 'rpm' })).toBe('G06-MANUAL-NOT-ALLOWED');
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

  it('[DI-04][PR-14] the equipment reports another recipe version than the MBR names: the RECIPE_CHECK is stored only with matches false and RECIPE_MISMATCH, which stops the step for QA; a forged match or a dropped exception is refused by the database', async () => {
    const check = { kind: 'RECIPE_CHECK', recipe: 'RCP-COMP', recipeVersion: '4' };
    const checkOf = (r: engine.StepResult) => Object.values(r.state.entries).find((e) => e.kind === 'RECIPE_CHECK' && e.data['recipeVersion'] === '4');
    const dropMismatch = (r: engine.StepResult) => {
      const gone = Object.entries(r.state.exceptions).filter(([, x]) => x.type === 'RECIPE_MISMATCH').map(([k]) => k);
      for (const k of gone) delete r.state.exceptions[k];
      // A consistent forgery: the row's events do not tell of the exception either.
      return { ...r, events: r.events.filter((ev) => !(ev.type === 'EXCEPTION_RAISED' && gone.includes(ev.exception))) };
    };
    const outcomes = {
      forgedMatch: await record(check, {
        forge: (r) => {
          const e = checkOf(r);
          if (e) e.data['matches'] = true;
          return dropMismatch(r);
        },
      }),
      droppedException: await record(check, { forge: dropMismatch }),
      honest: await record(check),
    };
    expect(outcomes).toEqual({ forgedMatch: 'EBMR-EXE-126', droppedException: 'EBMR-EXE-275', honest: 'ok' });
    const { rows } = await sbx.db.admin.query<{ data: Json; ex: { type: string; severity: string; status: string }[] }>(
      `select v -> 'data' as data,
              (select jsonb_agg(jsonb_build_object('type', x ->> 'type', 'severity', x ->> 'severity', 'status', x ->> 'status'))
                 from jsonb_each(s.state -> 'exceptions') q(k, x) where x ->> 'type' = 'RECIPE_MISMATCH') as ex
         from recipe.execution_state s, jsonb_each(s.state -> 'entries') e(k, v)
        where s.batch_id = $1 and v ->> 'kind' = 'RECIPE_CHECK'`,
      [d.runId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({ recipe: 'RCP-COMP', recipeVersion: '4', matches: false });
    expect(rows[0]?.ex).toEqual([{ type: 'RECIPE_MISMATCH', severity: 'ACTION', status: 'OPEN' }]);
  });

  it('[DI-31] slice 6c (D-S6-8): the database takes the tags of every process kind exactly as the integration SDK names them; a bottle line is bound and sends its counter; a tag of another kind is refused whole', async () => {
    const { rows } = await sbx.db.admin.query<{ tag: string; equipment_kind: string; unit: string; scale: number; counter: boolean; setpoint: boolean }>(
      'select tag, equipment_kind, unit, scale, counter, setpoint from tab.process_tag order by tag',
    );
    expect(rows).toEqual(
      [...PROCESS_TAGS].sort((a, b) => (a.tag < b.tag ? -1 : 1)).map((t) => ({ tag: t.tag, equipment_kind: t.equipment, unit: t.unit, scale: t.scale, counter: t.counter, setpoint: t.setpoint })),
    );
    const site = (await sbx.db.admin.query<{ s: string }>("select site_code as s from iam.device where code = 'TEST-BAL-01'")).rows[0]?.s ?? null;
    const code = 'TEST-BOTTLE-01';
    const serial = 'BOTTLE-LINE-0001';
    await identity.withGuardedCommand(sbx.db.app, await adminActor(sbx), async (c) => {
      await c.query('select iam.register_device($1, $2, $3, $4, $5, $6, $7)', [code, 'INSTRUMENT', site, 'DISP-1', null, createHash('sha256').update(`${code}:${randomUUID()}`).digest('hex'), 'Bottle line (simulated) behind the site gateway']);
      await c.query('select tab.bind_process_device($1, $2, $3, $4)', [chainId, code, serial, 'BOTTLE_LINE']);
    });
    // The bottle line's own sequence (the press's is untouched).
    let bottleSeq = 0;
    const bottle = (tag: string, value: string, unit: string) => {
      bottleSeq += 1;
      return { deviceSerial: serial, tag, value, unit, quality: 'GOOD', sourceTime: '1790584618000000', sequence: String(bottleSeq), kind: 'ACTUAL' };
    };
    expect((await gw.post('/gw/v1/process-readings', { sessionId: RUN_SESSION, readings: [bottle('bottle.count', '120', 'count')] })).status).toBe(200);
    const taken = await sbx.db.app.query<{ tag: string; value: string }>('select tag, value from tab.process_reading where serial = $1', [serial]);
    expect(taken.rows).toEqual([{ tag: 'bottle.count', value: '120' }]);
    expect((await gw.post('/gw/v1/process-readings', { sessionId: RUN_SESSION, readings: [bottle('cartoner.count', '5', 'count')] })).status).not.toBe(200);
    expect((await sbx.db.app.query('select 1 from tab.process_reading where serial = $1', [serial])).rows).toHaveLength(1);
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
