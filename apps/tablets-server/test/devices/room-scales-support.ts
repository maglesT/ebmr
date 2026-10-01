/**
 * Shared set-up of the two-scales tests (review finding P50): a sandbox server whose room DISP-1 holds two balances
 * behind the site gateway, TEST-BAL-01 (enrolled with the gateway) and TEST-BAL-00 (registered and bound by the
 * administrator here, no heartbeat yet), and helpers that drive a dc-mini run to the paracetamol weighing, report
 * scale states as the gateway does, record what the server's gateway API monitor observes (tablets 0340), and write a
 * hand-keyed weighing past the server as a writer holding the application role's rights would.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { expect, inject, vi } from 'vitest';
import { identity, toDbContext, withCommand, type ActorContext } from '@ebmr/kernel';
import { execution, flow, type engine } from '@ebmr/recipe-core';
import { asAdmin, openServiceSession, terminalOf } from '@ebmr/test-kit';
import { withActorCommand } from '../../src/platform/db/commands.ts';
import { scaleStatuses } from '../../src/features/devices/port.ts';
import { containerId } from '../../src/features/execution/intents.ts';
import { lotForEngine, resolveLot } from '../../src/features/execution/lots.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import type { TestBrowser } from '../support/harness.ts';
import { adminActor, enrol, fakeGateway, type FakeGateway } from './support.ts';
import { actorOf, codeOf } from '../execution/db-guards-support.ts';
import { dcMini, importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';

export interface Rig {
  server: ExecServer;
  gw: FakeGateway;
  /** The directory of the service-keys file written for the server's gateway API monitor (removed by stopRig). */
  keysDir?: string;
}

/**
 * A DEMO-ONLY service-keys file holding only the gateway API monitor's entry (terminal TEST-SRV-MONITOR) of the
 * sandbox template's seed, as the set-up CLI writes it: the server then records, as the monitor, whether it reaches
 * the gateway's API (tablets 0340). No sweeper entry, so no sweeper starts.
 */
function monitorKeysFile(): { dir: string; file: string } {
  const seed = inject('serverTemplates').sandbox.seed;
  const s = seed.services.find((x) => x.key === 'monitor');
  if (!s) throw new Error('SETUP: no gateway API monitor identity in the seed');
  const t = terminalOf(seed, s.terminal);
  const dir = mkdtempSync(join(tmpdir(), 'ebmr-monitor-keys-'));
  const file = join(dir, 'sandbox-service-keys.json');
  writeFileSync(file, JSON.stringify({ label: 'DEMO-ONLY service secrets', services: [{ ...s, fingerprint: t.fingerprint, terminalKey: t.key }] }));
  return { dir, file };
}

/**
 * The server with the second balance TEST-BAL-00 in DISP-1, and the fake gateway (the tap limiter's clock is faked).
 * `env` adds to the server's configuration (e.g. EBMR_GATEWAY_URL of a fake gateway API). With `monitor`, the server
 * holds the gateway API monitor's identity, so a capture that cannot reach the gateway's API, and each probe of it, is
 * recorded (without it nothing the server observes of the API is recorded).
 */
export async function startRig(env: Record<string, string> = {}, opts: { monitor?: boolean } = {}): Promise<Rig> {
  const keys = opts.monitor ? monitorKeysFile() : null;
  const server = await startExecServer(keys ? { ...env, EBMR_SERVICE_KEYS_FILE: keys.file } : env);
  vi.useFakeTimers({ toFake: ['performance'] });
  const chain = await enrol(server);
  const site = await asAdmin(server.database, (c) => c.query<{ site_code: string }>("select site_code from iam.device where code = 'TEST-BAL-01'"));
  const admin = await adminActor(server, 'P50: second balance in DISP-1');
  await identity.withGuardedCommand(server.db.app, admin, async (c) => {
    await c.query("select iam.register_device('TEST-BAL-00', 'INSTRUMENT', $1, 'DISP-1', null, $2, 'Floor scale 300 kg in DISP-1')", [site.rows[0]?.site_code, randomBytes(32).toString('hex')]);
    await c.query("select tab.bind_instrument($1, 'TEST-BAL-00', 'SIM-0000', 'kg', '0.01')", [chain]);
  });
  const gw = await fakeGateway(server);
  // As a server that has just started: the manual path stays shut until the listener has vouched for a full window
  // (tablets 0350 item 6), so the cases start once it has.
  if (!(await untilVouched(server))) throw new Error('SETUP: the gateway listener did not vouch for a window within 20 s of its start');
  return { server, gw, ...(keys ? { keysDir: keys.dir } : {}) };
}

/**
 * How long a case waits for a report to have stood for the gate's window: the heartbeat window (10 s), and up to 2 s
 * more, since the window the gateway listener vouches for ends at its last closed tick, at most 2 s before the weighing,
 * and spans a full 10 s (tablets 0350 item 6).
 */
export const GATE_WINDOW_MS = 12_000;

/** Polls every 100 ms, for at most `ms`, until the database vouches for the window before now (tab.listener_attested_from). */
export async function untilVouched(server: { db: { admin: pg.Pool } }, ms = 20_000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    const { rows } = await server.db.admin.query<{ ok: boolean }>("select tab.listener_attested_from(clock_timestamp() - interval '10 seconds') is not null as ok");
    if (rows[0]?.ok) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export async function stopRig(rig: Rig | undefined): Promise<void> {
  vi.useRealTimers();
  await rig?.gw.close();
  await rig?.server.close();
  if (rig?.keysDir) rmSync(rig.keysDir, { recursive: true, force: true });
}

/** A session of the gateway API monitor identity (TEST-gw-monitor, role GATEWAY_API_MONITOR, source SYSTEM; tablets 0340). */
export async function monitorActor(rig: Rig): Promise<ActorContext & { deviceId: string }> {
  return openServiceSession(rig.server.db, rig.server.seed, 'monitor');
}

/** The statement the monitor sends: tab.record_gateway_api_contact for TEST-GW-01. */
export const RECORD_CONTACT_SQL = "select tab.record_gateway_api_contact('TEST-GW-01', $1, $2) as written";

/** Records, in a command of the monitor `actor` (default: a new session of it), whether the server reaches TEST-GW-01's API. */
export async function recordContact(rig: Rig, reachable: boolean, detail: string, actor?: ActorContext): Promise<boolean> {
  const who = actor ?? (await monitorActor(rig));
  return withActorCommand(rig.server.db.app, { ...who, correlationId: randomUUID() }, async (c) => (await c.query<{ written: boolean }>(RECORD_CONTACT_SQL, [reachable, detail])).rows[0]?.written ?? false);
}

/**
 * Lets `ms` of database time pass (at least) while the gateway keeps reporting `states` every 3 s, then reports them
 * once more: the heartbeats stay fresh (a scale whose last heartbeat is older than 10 s is OFFLINE for that reason
 * alone), so what opens or keeps closed the manual path afterwards is the age of the server's own reports.
 */
export async function standFor(rig: Rig, ms: number, states: Readonly<Record<string, 'ONLINE' | 'OFFLINE'>>): Promise<void> {
  const { rows } = await rig.server.db.admin.query<{ t: string }>('select clock_timestamp()::text as t');
  const start = rows[0]?.t ?? '';
  for (;;) {
    await report(rig, states);
    const r = await rig.server.db.admin.query<{ left: number }>("select greatest(0, $2::int - extract(epoch from clock_timestamp() - $1::timestamptz) * 1000)::int as left", [start, ms]);
    const left = r.rows[0]?.left ?? 0;
    if (left <= 0) break;
    await new Promise((res) => setTimeout(res, Math.min(3000, left + 50)));
  }
  await report(rig, states);
}

export const CLEAR = 'p-disp-clear@';
export const PCM = 'p-disp-pcm@';
export const handKeyed = { type: 'RECORD_ENTRY' as const, stepKey: PCM, entry: { kind: 'CONTAINER_WEIGHING' as const, item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', manual: { gross: '51.250', tare: '1.250', unit: 'kg' } } };
const SERIALS: Readonly<Record<string, string>> = { 'TEST-BAL-00': 'SIM-0000', 'TEST-BAL-01': 'SIM-0001' };

/** A run of `content` (dc-mini) issued by the issuer; `browsers` default to the issuer, and operator1 and verifier1 on their DISP-1 kiosk. */
export async function newRun(rig: Rig, opts: { content?: flow.MbrContent; browsers?: Record<string, TestBrowser> } = {}): Promise<RunDriver> {
  const browsers = opts.browsers ?? { issuer: await rig.server.asPersona('issuer'), operator1: await rig.server.asPersona('operator1'), verifier1: await rig.server.asPersona('verifier1') };
  const issuer = browsers['issuer'];
  if (!issuer) throw new Error('SETUP: no issuer browser');
  const d = new RunDriver(rig.server, await importAndIssue(rig.server, issuer, writePackage(rig.server, opts.content ?? dcMini())), browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

/** Clearance, balance status, SOP and quantities of the dispensing stage by `operator` (verified by verifier1), then the paracetamol step is started. */
export async function reachPcm(d: RunDriver, operator = 'operator1'): Promise<void> {
  await d.ok(operator, { type: 'START_STEP', stepKey: CLEAR });
  await d.ok(operator, { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
  await d.ok(operator, { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'X', batchNumber: 'TEST-B26-9' } });
  await d.signed(operator, { type: 'SIGN_PERFORMED', stepKey: CLEAR });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
  await d.ok(operator, { type: 'START_STEP', stepKey: 'p-disp-bal@' });
  await d.ok(operator, { type: 'RECORD_ENTRY', stepKey: 'p-disp-bal@', entry: { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-1', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) } });
  await d.signed(operator, { type: 'SIGN_PERFORMED', stepKey: 'p-disp-bal@' });
  await d.ok(operator, { type: 'START_STEP', stepKey: 'p-disp-sop@' });
  await d.ok(operator, { type: 'RECORD_ENTRY', stepKey: 'p-disp-sop@', entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } });
  await d.signed(operator, { type: 'SIGN_PERFORMED', stepKey: 'p-disp-sop@' });
  await d.ok(operator, { type: 'START_STEP', stepKey: 'p-disp-calc@' });
  await d.signed(operator, { type: 'SIGN_PERFORMED', stepKey: 'p-disp-calc@' });
  await d.ok(operator, { type: 'START_STEP', stepKey: PCM });
}

/** The devices of a gateway heartbeat: each scale named, in the state given (ONLINE with its registered serial). */
export function devicesOf(states: Readonly<Record<string, 'ONLINE' | 'OFFLINE'>>): { deviceCode: string; state: string; serial: string | null }[] {
  return Object.entries(states).map(([deviceCode, state]) => ({ deviceCode, state, serial: state === 'ONLINE' ? (SERIALS[deviceCode] ?? null) : null }));
}

/** A gateway heartbeat of `states` (devicesOf), which the server answers 200. */
export async function report(rig: Rig, states: Readonly<Record<string, 'ONLINE' | 'OFFLINE'>>): Promise<void> {
  const r = await rig.gw.heartbeat(devicesOf(states));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** [device code, status] of the DISP-1 scales, as the database answers now. */
export async function statuses(rig: Rig): Promise<string[][]> {
  return (await scaleStatuses(rig.server.built.ctx, 'DISP-1')).map((s) => [s.deviceCode, s.status]);
}

/** The evidence the server stored with the run's last row. */
export async function lastEvidence(rig: Rig, runId: string): Promise<Record<string, unknown>> {
  const { rows } = await rig.server.db.admin.query<{ evidence: Record<string, unknown> }>('select evidence from recipe.execution_command where batch_id = $1 order by seq desc limit 1', [runId]);
  return rows[0]?.evidence ?? {};
}

export interface ForgedWeighingOptions {
  edit?: (entry: Record<string, unknown>) => void;
  /** Runs in the command's transaction once the row is written (on its connection). */
  during?: (c: pg.PoolClient) => Promise<void>;
  /**
   * Runs `work` in the command's transaction before the weighing. With `actor`, the transaction is opened as that actor
   * and operator1's context is installed after `work` (kernel.begin_command); either way it is all one transaction.
   */
  before?: { actor?: ActorContext; work: (c: pg.PoolClient) => Promise<void> };
  browser?: string;
  /** The transaction's isolation level (default: the database's, READ COMMITTED); its snapshot is taken by begin_command. */
  isolation?: 'repeatable read' | 'serializable';
}

/** withCommand, in a transaction of `isolation` when one is given. */
async function withCommandAt<T>(pool: pg.Pool, actor: ActorContext, isolation: ForgedWeighingOptions['isolation'], work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!isolation) return withCommand(pool, actor, work);
  const client = await pool.connect();
  try {
    await client.query(`begin isolation level ${isolation}`);
    await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(actor))]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * A hand-keyed weighing of the paracetamol step written past the server, as a server that skips its own checks (or a
 * writer holding the application role's rights) would write it: operator1's command on the terminal of `browser`
 * (default operator1's), through ExecutionTx. The database's refusal code, or 'ok'.
 */
export async function forgedWeighing(rig: Rig, d: RunDriver, opts: ForgedWeighingOptions = {}): Promise<string> {
  return codeOf(forgedWeighingRow(rig, d, opts));
}

/** `forgedWeighing`, rejected with the database's refusal itself (for its message). */
export async function forgedWeighingRow(rig: Rig, d: RunDriver, opts: ForgedWeighingOptions = {}): Promise<engine.StepResult> {
  const { server } = rig;
  const run = await runContext(server.db.admin, d.runId);
  const lot = await resolveLot(server.db.admin, 'TEST-L26-0101');
  if (!lot) throw new Error('SETUP: demo lot missing');
  const operator = await actorOf(server, d.browser(opts.browser ?? 'operator1'), 'operator1');
  return withCommandAt(server.db.app, opts.before?.actor ?? operator, opts.isolation, async (c) => {
    if (opts.before) {
      await opts.before.work(c);
      if (opts.before.actor) await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(operator))]);
    }
    const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
    const roles = await engineRoles(c);
    const entry: Record<string, unknown> & { kind: string } = {
      kind: 'CONTAINER_WEIGHING',
      item: 'pcmDispensed',
      bomLine: 'BOM-PCM',
      container: containerId(tx.state, undefined),
      lot: lotForEngine(lot),
      gross: '51.250',
      tare: '1.250',
      unit: 'kg',
      balance: 'MANUAL',
      source: 'MANUAL',
    };
    opts.edit?.(entry);
    const command: engine.Command = { type: 'RECORD_ENTRY', commandId: randomUUID(), actor: engineActor(personaIn(server, 'operator1').personId, roles), step: 'p-disp-pcm', context: [], entry };
    const r = await tx.command(command, roles, { manual: { writtenPastTheServer: true } });
    await opts.during?.(c);
    return r;
  });
}

/** A dc-mini whose dispensing stage names no room (its steps are accepted from any terminal). */
export function roomFreeDispensing(): flow.MbrContent {
  const content = JSON.parse(JSON.stringify(dcMini())) as { procedure: { body: { children: { id: string; binding: Record<string, unknown> }[] } } };
  const stage = content.procedure.body.children.find((c) => c.id === 'S-DISP');
  if (!stage) throw new Error('SETUP: dc-mini has no S-DISP');
  stage.binding['rooms'] = [];
  const parsed = flow.parseMbr(content);
  if (!parsed.ok) throw new Error(`SETUP: the room-free dc-mini does not parse: ${JSON.stringify(parsed.problems.slice(0, 3))}`);
  return parsed.mbr;
}
