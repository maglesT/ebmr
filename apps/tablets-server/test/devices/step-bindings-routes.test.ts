/**
 * The bindings of a process step and the G-06 alarm acknowledgement over HTTP (Phase 7 slice 7g, WP4; contract
 * ns/device-readings.ts; decision 0025): the step's bindings read, the process device bound to the step
 * (tab.bind_step_device), a plant unit in use bound to it (plant.bind_step_equipment), an MBR setpoint downloaded to the
 * bound device (tab.request_setpoint_download), and the ALARM_ACK entry of an alarm captured from the equipment, which
 * the server acknowledges in the entry's own command (tab.acknowledge_process_alarm). Every rule and right
 * (STEP.EXECUTE in the batch's scope) is the database's; the person's calls carry a fresh badge tap on the kiosk.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, type ActorContext } from '@ebmr/kernel';
import type { flow } from '@ebmr/recipe-core';
import { routes, type Result } from '@ebmr/api-contract';
import { actorOfBrowser, personaIn, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import { dcMiniVariant, importAndIssue, RunDriver, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { adminActor, enrol, fakeGateway, type FakeGateway } from './support.ts';
import { cleanUnit, pressInUse, startUse, type PressUnit } from '../blocks/compression/plant-support.ts';

const D = routes.devices;
let sbx: ExecServer;
let gw: FakeGateway;
let d: RunDriver;
let unit: PressUnit;
let operator: TestBrowser;
let verifier: TestBrowser;
const SERIAL = 'PRESS-0077';
const DEVICE = 'TEST-PRESS-77';
const RUN_SESSION = randomUUID();
const STEP_KEY = 'p-press@';
let seq = 0;

type Json = Record<string, unknown>;

/** The database's refusal as the server answers it: its code, then why. */
const refused = (r: Result<unknown>): string => `${refusalOf(r)?.code ?? ''} ${refusalOf(r)?.why ?? ''}`;

function withPress(): flow.MbrContent {
  return dcMiniVariant((prep, content) => {
    (content['references'] as Json[]).push({ id: 'SYS-PRS', kind: 'COMPUTERISED_SYSTEM', code: 'SYS-PRS', version: '1' });
    const press = {
      kind: 'phase', id: 'p-press', name: 'Compression run', block: { type: 'G-06', version: '1' },
      config: { setpoints: [{ tag: 'force.main_kN', value: '12.50', unit: 'kN', tolerance: '0.05' }], actuals: [{ tag: 'turret.speed_rpm', unit: 'rpm', min: '20.0', max: '60.0' }], criticalAlarms: ['force.main_kN'], maxAgeSeconds: 600 },
      records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [],
      signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } },
      significant: true, riskClass: 'HIGH', system: { kind: 'PLC', ref: 'SYS-PRS', recipe: 'RCP-COMP', recipeVersion: '5' },
    };
    return [press, ...prep];
  });
}

async function nowUs(): Promise<string> {
  return (await sbx.db.app.query<{ us: string }>('select floor(extract(epoch from clock_timestamp()) * 1000000)::bigint::text as us')).rows[0]?.us ?? '';
}
const reading = async (tag: string, value: string, unit_: string, kind: string) => {
  seq += 1;
  return { deviceSerial: SERIAL, tag, value, unit: unit_, quality: 'GOOD', sourceTime: await nowUs(), sequence: String(seq), kind };
};

async function actor(): Promise<ActorContext> {
  vi.advanceTimersByTime(7_000);
  return actorOfBrowser(sbx, operator, 'operator1');
}

/** A step act of `key` on its kiosk, with the fresh badge tap the route asks for. */
async function act<R extends typeof D.bindStepDevice | typeof D.bindStepEquipment | typeof D.requestSetpointDownload>(b: TestBrowser, key: string, route: R, extra: Record<string, string>) {
  const body = { batchId: d.runId, stepKey: STEP_KEY, ...extra };
  vi.advanceTimersByTime(7_000);
  const attribution = await tapFor(b, personaIn(sbx, key), 'POST', route.path, body);
  return b.call(route as typeof D.bindStepDevice, { body: body as never, attribution });
}

beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
  const chainId = await enrol(sbx);
  const site = (await sbx.db.admin.query<{ s: string }>("select site_code as s from iam.device where code = 'TEST-BAL-01'")).rows[0]?.s ?? null;
  await identity.withGuardedCommand(sbx.db.app, await adminActor(sbx), async (c) => {
    await c.query('select iam.register_device($1, $2, $3, $4, $5, $6, $7)', [DEVICE, 'INSTRUMENT', site, 'DISP-1', null, createHash('sha256').update(`${DEVICE}:${randomUUID()}`).digest('hex'), 'Tablet press (simulated) behind the site gateway']);
    await c.query('select tab.bind_process_device($1, $2, $3, $4)', [chainId, DEVICE, SERIAL, 'PRESS']);
  });
  gw = await fakeGateway(sbx);
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withPress()));
  [operator, verifier] = await Promise.all([sbx.asPersona('operator1'), sbx.asPersona('verifier1')]);
  d = new RunDriver(sbx, runId, { issuer, operator1: operator });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  unit = await pressInUse(sbx, actor, d.runId, { deviceCode: DEVICE });
  await d.ok('operator1', { type: 'START_STEP', stepKey: STEP_KEY });
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await gw?.close();
  await sbx?.close();
});

describe('the bindings of a process step (tablets 0820, 0870; recipe-core 0960)', () => {
  it('[PR-14][DI-49] the step binds the device of its unit once; a unit the batch has in use is bound to the step; an MBR setpoint is downloaded to the bound device, once while it waits; a person without STEP.EXECUTE is refused', async () => {
    const before = valueOf(await operator.call(D.stepBindings, { query: { batchId: d.runId, stepKey: STEP_KEY } }));
    expect(before).toMatchObject({ device: null, equipment: [], setpoints: [{ tag: 'force.main_kN', value: '12.50', unit: 'kN', waiting: false }] });
    expect(before.unitsInUse.map((u) => u.code)).toContain(unit.code);
    expect(before.devices).toContainEqual({ code: DEVICE, equipmentKind: 'PRESS', unitCode: unit.code });
    // No device bound yet: the download is refused.
    expect(refused(await act(operator, 'operator1', D.requestSetpointDownload, { tag: 'force.main_kN' }))).toMatch(/EBMR-DEV-133/);
    // The verifier holds no STEP.EXECUTE.
    expect(refusalOf(await act(verifier, 'verifier1', D.bindStepDevice, { deviceCode: DEVICE }))?.code).toBe('EBMR-IAM-040');
    const bound = valueOf(await act(operator, 'operator1', D.bindStepDevice, { deviceCode: DEVICE }));
    expect(bound.device).toMatchObject({ code: DEVICE, boundBy: { personId: personaIn(sbx, 'operator1').personId } });
    // The device's unit follows the step (the alarm log's binding).
    expect(bound.equipment.map((e) => e.code)).toEqual([unit.code]);
    expect(refused(await act(operator, 'operator1', D.bindStepDevice, { deviceCode: DEVICE }))).toMatch(/EBMR-DEV-131/);
    // Units: one already bound, one not in use by the batch, then a second unit in use bound to the step.
    expect(refused(await act(operator, 'operator1', D.bindStepEquipment, { equipmentCode: unit.code }))).toMatch(/EBMR-ALM-034/);
    const second = await cleanUnit(sbx, d.runId);
    expect(refused(await act(operator, 'operator1', D.bindStepEquipment, { equipmentCode: second.code }))).toMatch(/EBMR-ALM-033/);
    await startUse(sbx, await actor(), second.code, d.runId);
    expect(valueOf(await act(operator, 'operator1', D.bindStepEquipment, { equipmentCode: second.code })).equipment.map((e) => e.code).sort()).toEqual([unit.code, second.code].sort());
    // The setpoint the MBR approves, once while the gateway has not fetched it; another tag is refused.
    expect(refused(await act(operator, 'operator1', D.requestSetpointDownload, { tag: 'fill.depth_mm' }))).toMatch(/EBMR-DEV-132/);
    expect(valueOf(await act(operator, 'operator1', D.requestSetpointDownload, { tag: 'force.main_kN' })).setpoints).toEqual([{ tag: 'force.main_kN', value: '12.50', unit: 'kN', waiting: true }]);
    expect(refused(await act(operator, 'operator1', D.requestSetpointDownload, { tag: 'force.main_kN' }))).toMatch(/EBMR-DEV-134/);
    const res = await fetch(`${gw.base}/gw/v1/setpoint-downloads`, { headers: { authorization: `Bearer ${gw.token}` } });
    expect(await res.json()).toMatchObject({ downloads: [{ deviceSerial: SERIAL, tag: 'force.main_kN', value: '12.50', unit: 'kN' }] });
  }, 180_000);

  it('[DI-49] an alarm captured from the equipment is acknowledged by the ALARM_ACK entry: the server acknowledges the reading in the entry\'s own command, once, by the person, with the comment', async () => {
    const excursion = await reading('force.main_kN', '14.10', 'kN', 'ALARM');
    expect((await gw.post('/gw/v1/process-readings', { sessionId: RUN_SESSION, readings: [excursion] })).status).toBe(200);
    const r = (await sbx.db.app.query<{ id: string }>('select id from tab.process_reading where serial = $1 and seq = $2', [SERIAL, excursion.sequence])).rows[0]?.id ?? '';
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: STEP_KEY, entry: { kind: 'BLOCK_ENTRY', entryKind: 'ALARM', data: { source: 'EQUIPMENT', readingId: r } } });
    const { rows } = await sbx.db.admin.query<{ k: string }>("select k from recipe.execution_state s, jsonb_each(s.state -> 'entries') e(k, v) where s.batch_id = $1 and v ->> 'kind' = 'ALARM'", [d.runId]);
    const alarm = rows[0]?.k ?? '';
    const ack = (comment: string) => d.command('operator1', { type: 'RECORD_ENTRY', stepKey: STEP_KEY, entry: { kind: 'BLOCK_ENTRY', entryKind: 'ALARM_ACK', data: { alarm, comment } } });
    // Without a comment the acknowledgement is refused (the engine's schema or the database's DI-49 rule).
    expect((await ack('  ')).ok).toBe(false);
    const comment = 'Force spike on station 12: fill depth reduced by 0.1 mm, force back in range';
    const done = await ack(comment);
    expect(done.ok, done.ok ? '' : JSON.stringify(done.error)).toBe(true);
    const acks = await sbx.db.admin.query<{ comment: string; person_id: string; step: string }>('select comment, person_id, step from tab.process_alarm_ack where reading_id = $1', [r]);
    expect(acks.rows).toEqual([{ comment, person_id: personaIn(sbx, 'operator1').personId, step: 'p-press' }]);
    // Once: a second acknowledgement of the same alarm is refused, and nothing more is recorded.
    expect((await ack(comment)).ok).toBe(false);
    expect((await sbx.db.admin.query('select 1 from tab.process_alarm_ack where reading_id = $1', [r])).rows).toHaveLength(1);
  }, 180_000);
});
