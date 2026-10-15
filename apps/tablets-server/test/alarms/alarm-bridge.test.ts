/**
 * The bridge of the Tablets process alarms into the generic plant alarm log (tablets 1218; DI-49; D-P6b-0-2, D-P6b-B-4):
 * an ALARM reading of a press from the gateway uplink becomes a plant occurrence bound at its source time to the batch,
 * the step and the unit; it blocks the step signature (recipe-core 0974) until the G-06 acknowledgment of the reading,
 * which is the log's acknowledgment (the same person, time and comment); ALARM_CLEARED clears it. As the gateway's and
 * the operator's real identities over the real uplink and engine, with bypass attempts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import type { engine, flow } from '@ebmr/recipe-core';
import { execution } from '@ebmr/recipe-core';
import { actorOfBrowser } from '../esig/support.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { batchAlarmLog } from '../../src/features/alarms/reads.ts';
import { codeOf, appendAs, engineResult } from '../execution/db-guards-support.ts';
import { dcMiniVariant, importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';
import { adminActor, enrol, fakeGateway, type FakeGateway } from '../devices/support.ts';
import { pressInUse, type PressUnit } from '../blocks/compression/plant-support.ts';

let sbx: ExecServer;
let gw: FakeGateway;
let d: RunDriver;
let unit: PressUnit;
const SERIAL = 'PRESS-0009';
const DEVICE = 'TEST-PRESS-09';
const RUN_SESSION = randomUUID();
let seq = 0;

type Json = Record<string, unknown>;

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

/** The database's now in microseconds (the source time of a reading the press sends now). */
async function nowUs(): Promise<string> {
  return (await sbx.db.app.query<{ us: string }>('select floor(extract(epoch from clock_timestamp()) * 1000000)::bigint::text as us')).rows[0]?.us ?? '';
}

const reading = async (tag: string, value: string, unit_: string, kind: string) => {
  seq += 1;
  return { deviceSerial: SERIAL, tag, value, unit: unit_, quality: 'GOOD', sourceTime: await nowUs(), sequence: String(seq), kind };
};
const send = (readings: Json[]) => gw.post('/gw/v1/process-readings', { sessionId: RUN_SESSION, readings });

async function operator(): Promise<ActorContext> {
  vi.advanceTimersByTime(7_000);
  return actorOfBrowser(sbx, d.browser('operator1'), 'operator1');
}

/** operator1 records `entry` at p-press past the server, claiming the reading and acknowledging the alarm in the same command. */
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

const plantAlarm = async (readingId: string) =>
  (await sbx.db.app.query<{ id: string; source: string; alarm_code: string; gmp_critical: boolean; value: string; equipment_id: string; us: string }>(
    "select id, source, alarm_code, gmp_critical, value, equipment_id, raised_source_us::text as us from plant.alarm where occurrence_id = 'PR-' || $1", [readingId])).rows[0];
const signProblem = async () =>
  (await sbx.db.app.query<{ p: string | null }>("select plant.step_rules_problem($1, 'SIGN_PERFORMED', 'p-press', null, $2, clock_timestamp()) as p", [d.runId, personaIn(sbx, 'operator1').personId])).rows[0]?.p ?? null;

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
  d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  unit = await pressInUse(sbx, operator, d.runId, { deviceCode: DEVICE });
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-press@' });
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await gw?.close();
  await sbx?.close();
});

describe('the process alarms in the plant alarm log (tablets 1218)', () => {
  it('[DI-49] a press alarm reading enters the batch\'s alarm log bound to the batch, the step and the unit, blocks the step signature, and its G-06 acknowledgment is the log\'s', async () => {
    // The step's device binding binds the unit to the step for the alarm log (plant.step_equipment).
    await withCommand(sbx.db.app, await operator(), (c) => c.query('select tab.bind_step_device($1, $2, $3)', [d.runId, 'p-press', DEVICE]));
    expect((await sbx.db.app.query('select step, equipment_id from plant.step_equipment where batch_id = $1', [d.runId])).rows).toEqual([{ step: 'p-press', equipment_id: unit.id }]);
    const excursion = await reading('force.main_kN', '14.10', 'kN', 'ALARM');
    expect((await send([excursion])).status).toBe(200);
    const r = (await sbx.db.app.query<{ id: string }>('select id from tab.process_reading where serial = $1 and seq = $2', [SERIAL, excursion.sequence])).rows[0]?.id ?? '';
    const a = await plantAlarm(r);
    // An unconfigured code (TAG.<tag>) counts as GMP-critical (D-P6b-0-3); the source time is the press's.
    expect(a).toEqual({ id: expect.any(String), source: 'EBMR', alarm_code: 'TAG.FORCE.MAIN_KN', gmp_critical: true, value: '14.10', equipment_id: unit.id, us: excursion.sourceTime });
    expect((await sbx.db.app.query('select batch_id, step from plant.alarm_batch where alarm_id = $1', [a?.id])).rows).toEqual([{ batch_id: d.runId, step: 'p-press' }]);
    expect(await signProblem()).toMatch(/^EBMR-ALM-020 DI-49: GMP-critical alarm\(s\) await acknowledgment: TAG\.FORCE\.MAIN_KN \(PR-/);
    // The operator records the alarm in the step and acknowledges it with the action taken (G-06, tablets 0820).
    const asEntry = { kind: 'ALARM', tag: 'force.main_kN', value: '14.10', unit: 'kN', source: 'EQUIPMENT', readingId: r, quality: 'GOOD',
                      receivedAtUs: (await sbx.db.app.query<{ us: string }>('select received_us::text as us from tab.process_reading where id = $1', [r])).rows[0]?.us };
    expect(await record(asEntry, { claim: r })).toBe('ok');
    const { rows } = await sbx.db.admin.query<{ k: string }>("select k from recipe.execution_state s, jsonb_each(s.state -> 'entries') e(k, v) where s.batch_id = $1 and v ->> 'kind' = 'ALARM'", [d.runId]);
    const comment = 'Force spike on station 12: fill depth reduced by 0.1 mm, force back in range; tablets of the window rejected';
    expect(await record({ kind: 'ALARM_ACK', alarm: rows[0]?.k ?? '', comment }, { ack: { reading: r, comment } })).toBe('ok');
    expect(await signProblem()).toBeNull();
    const cleared = await reading('force.main_kN', '12.48', 'kN', 'ALARM_CLEARED');
    expect((await send([cleared])).status).toBe(200);
    // The batch's alarm log (the review and step screens' read): raise and acknowledgment times, the acknowledger, the comment.
    const log = await batchAlarmLog(sbx.built.ctx, sbx.db.app, d.runId);
    expect(log).toHaveLength(1);
    const me = personaIn(sbx, 'operator1');
    expect(log[0]).toMatchObject({
      source: 'EBMR', occurrenceId: `PR-${r}`, subject: { kind: 'EQUIPMENT', code: unit.code }, alarmCode: 'TAG.FORCE.MAIN_KN', gmpCritical: true, value: { value: '14.10', unit: 'kN' },
      raisedAtSource: expect.objectContaining({ us: excursion.sourceTime }), clearedAtSource: expect.objectContaining({ us: cleared.sourceTime }),
      batches: [{ batchId: d.runId, batchNumber: expect.any(String), step: 'p-press' }],
      acknowledgement: { by: expect.objectContaining({ personId: me.personId }), at: expect.anything(), actionTaken: comment, comment, deviationRef: null },
    });
    // Bypass: the log is written only by the bridge; nobody changes or erases it, the owner included.
    await expect(sbx.db.app.query("insert into plant.alarm_ack (alarm_id, action_taken, person_id, account_id, session_id, correlation_id) values ($1, 'x', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [a?.id])).rejects.toThrow(/permission denied/);
    await expect(sbx.db.admin.query('delete from plant.alarm_ack where alarm_id = $1', [a?.id])).rejects.toThrow(/EBMR-AUDIT|insert-only|not allowed/i);
    await expect(sbx.db.admin.query("update plant.alarm set message = 'nothing' where id = $1", [a?.id])).rejects.toThrow(/EBMR-AUDIT|insert-only|not allowed/i);
    await expect(sbx.db.app.query('select plant.raise_alarm($1::jsonb)', ['{}'])).rejects.toThrow(/permission denied/);
  });

  it('[DI-49] an alarm whose code needs a deviation is not acknowledged by the G-06 entry: it stays open in the log and keeps blocking the signature', async () => {
    const steward = await actorOfBrowser(sbx, await sbx.asPersona('steward'), 'steward');
    await withCommand(sbx.db.app, { ...steward, reasonCode: 'TEST_SETUP', reasonText: 'alarm configuration' } as ActorContext, (c) =>
      c.query("select plant.define_alarm_code('EBMR', 'TAG.TURRET.SPEED_RPM', true, true, 'Turret overspeed: a deviation is raised')"));
    const over = await reading('turret.speed_rpm', '75.0', 'rpm', 'ALARM');
    expect((await send([over])).status).toBe(200);
    const r = (await sbx.db.app.query<{ id: string }>('select id from tab.process_reading where serial = $1 and seq = $2', [SERIAL, over.sequence])).rows[0]?.id ?? '';
    expect(await plantAlarm(r)).toMatchObject({ alarm_code: 'TAG.TURRET.SPEED_RPM', gmp_critical: true });
    const asEntry = { kind: 'ALARM', tag: 'turret.speed_rpm', value: '75.0', unit: 'rpm', source: 'EQUIPMENT', readingId: r, quality: 'GOOD',
                      receivedAtUs: (await sbx.db.app.query<{ us: string }>('select received_us::text as us from tab.process_reading where id = $1', [r])).rows[0]?.us };
    expect(await record(asEntry, { claim: r })).toBe('ok');
    const { rows } = await sbx.db.admin.query<{ k: string }>("select k from recipe.execution_state s, jsonb_each(s.state -> 'entries') e(k, v) where s.batch_id = $1 and v ->> 'kind' = 'ALARM' and v -> 'data' ->> 'readingId' = $2", [d.runId, r]);
    expect(await record({ kind: 'ALARM_ACK', alarm: rows[0]?.k ?? '', comment: 'Turret slowed' }, { ack: { reading: r, comment: 'Turret slowed' } })).toBe('ok');
    expect((await sbx.db.app.query('select count(*)::int as n from plant.alarm_ack k join plant.alarm a on a.id = k.alarm_id where a.occurrence_id = $1', [`PR-${r}`])).rows).toEqual([{ n: 0 }]);
    expect(await signProblem()).toMatch(/^EBMR-ALM-020 .*TAG\.TURRET\.SPEED_RPM/);
  });
});
