/**
 * Phase 3 slice 4a (builder B, lead follow-up): the G-21 rules that act when time passes or a step or the batch closes,
 * proven on minimal packaging records run to their end as the application role (recipe-core 0581, tablets 0952):
 *   (a) a scheduled challenge not done within its interval, at database time, records MISSED and holds the output made
 *       since the last good challenge;
 *   (b) the destruction step closes only when it destroyed exactly the coded quantity; coded material is never returned;
 *   (c) the packaging order never reaches EXECUTION_COMPLETE while a serial pool is unreconciled or has unexplained
 *       serials (the completion trigger itself).
 * The L3 system is a fake of the serialisation contract; serialisation without a configured L3 system fails closed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { PRINT_EVENTS_PATH, printJobAckPath } from '@ebmr/integration-sdk/printer';
import { adminActor, enrol, fakeGateway, type FakeGateway } from '../../devices/support.ts';
import type { PoolReport } from '@ebmr/integration-sdk/serialisation';
import { actorOfBrowser } from '../../esig/support.ts';
import { codeOf } from '../../execution/db-guards-support.ts';
import { asPersonaInRole, importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../../execution/support.ts';
import { configuredL3Client, fetchSerialReport, requestSerialPool, sendSerialEvents, type L3Client, type SerialChange } from '../../../src/features/execution/serialisation.ts';
import { parseConfig } from '../../../src/config.ts';
import { fakeTimers, laxEntry, recorder, stateOf, type Entry } from '../granulation/db-support.ts';
import { asSetup } from '../compression/plant-support.ts';
import { ARTWORK, CARTON_MATERIAL, GTIN, LINE_UNIT, lineUnit, minimalMbr, occupyLine, packPhase } from './db-support.ts';

type Json = Record<string, unknown>;
let sbx: ExecServer;
let gw: FakeGateway;
const SERIAL = 'PRN-T9';
const GW_SESSION = randomUUID();
let seq = 0;
const advance = (): void => {
  vi.advanceTimersByTime(7_000);
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const WITNESSED = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } };
const CARTON = { id: 'CARTON', material: CARTON_MATERIAL, artwork: { IN: ARTWORK, US: ARTWORK }, unit: '1', issue: { need: '1000', allowancePercent: '2' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' }, coded: true };

interface Run {
  d: RunDriver;
  rec: ReturnType<typeof recorder>;
  as: (persona: string) => Promise<ActorContext>;
  sql: <T>(text: string, params?: unknown[]) => Promise<T | null>;
}

async function run(phases: Json[], personas: string[] = ['operator1', 'verifier1', 'supervisor1']): Promise<Run> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, minimalMbr(phases)), undefined, {}, ['IN', 'US']);
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of personas) browsers[p] = await sbx.asPersona(p, 'TEST-KIOSK-DISP-1');
  const d = new RunDriver(sbx, runId, browsers);
  d.beforeTap = advance;
  return {
    d,
    rec: recorder(sbx, d, advance),
    as: async (persona) => {
      advance();
      return actorOfBrowser(sbx, d.browser(persona), persona);
    },
    sql: async <T,>(text: string, params: unknown[] = []) => (await sbx.db.admin.query<{ r: T | null }>(text, params)).rows[0]?.r ?? null,
  };
}

/** The refusal of a signed act, or 'ok'. */
async function signedOutcome(d: RunDriver, persona: string, intent: Parameters<RunDriver['sign']>[1]): Promise<string> {
  const r = await d.sign(persona, intent);
  if (r.result.ok) return 'ok';
  return JSON.stringify(r.result.error.kind === 'REFUSAL' ? r.result.error.envelope.refusal : r.result.error);
}
async function performAndVerify(d: RunDriver, stepKey: string, meaning: 'VERIFIED' | 'WITNESSED' = 'VERIFIED'): Promise<string> {
  const p = await signedOutcome(d, 'operator1', { type: 'SIGN_PERFORMED', stepKey });
  if (p !== 'ok') return p;
  const s = (await stateOf(sbx, d.runId)).steps[stepKey]?.['status'];
  return s === 'AWAITING_VERIFICATION' ? signedOutcome(d, 'verifier1', { type: 'VERIFY', stepKey, meaning }) : 'ok';
}
const issueEntry: Entry = { kind: 'ISSUE', item: 'CARTON', lot: { id: 'TEST-CTN-C1', material: CARTON_MATERIAL, status: 'RELEASED', artwork: ARTWORK }, scannedArtwork: ARTWORK, quantity: { value: '1020', unit: '1' } };

/** A fake L3 system: pools of the asked quantity, and the report it is told to give. */
function fakeL3(): L3Client & { next: PoolReport | null } {
  const self = {
    next: null as PoolReport | null,
    requestPool: (r: { quantity: string }) => Promise.resolve({ poolId: `TEST-POOL-${randomUUID().slice(0, 8).toUpperCase()}`, serials: Array.from({ length: Number(r.quantity) }, (_, i) => `S${i + 1}`), issuedAt: '1790584618000000' }),
    sendEvents: () => Promise.resolve(),
    report: () => (self.next ? Promise.resolve(self.next) : Promise.reject(new Error('no report'))),
  };
  return self;
}
const report = (poolId: string, commissioned: string, unexplained: string, decommissioned = '0'): PoolReport => ({
  poolId, counts: { issued: '10', COMMISSIONED: commissioned, DECOMMISSIONED: decommissioned, DESTROYED: '0', SAMPLE: '0', UNUSED_RETURNED: '0' }, unexplained,
  reportHash: createHash('sha256').update(`${poolId}:${commissioned}:${decommissioned}:${unexplained}`).digest('hex'),
});
const changes = (n: number, from: SerialChange['from'], state: SerialChange['state']): SerialChange[] => Array.from({ length: n }, (_, i) => ({ serial: `S${i}`, from, state, at: '1790584618000000' }));

beforeAll(async () => {
  sbx = await startExecServer();
  fakeTimers();
  const steward = await sbx.asPersona('steward');
  await withCommand(sbx.db.app, await actorOfBrowser(sbx, steward, 'steward'), async (c) => {
    await c.query('select tab.register_sandbox_lot($1::jsonb)', [JSON.stringify({ lotCode: 'TEST-CTN-C1', materialCode: CARTON_MATERIAL, materialName: 'Printed carton', status: 'RELEASED', identityTested: true })]);
    await c.query('select tab.record_lot_artwork($1, null, $2)', ['TEST-CTN-C1', ARTWORK]);
  });
  const chain = await enrol(sbx);
  const site = (await sbx.db.admin.query<{ s: string }>("select site_code as s from iam.device where code = 'TEST-BAL-01'")).rows[0]?.s ?? null;
  await identity.withGuardedCommand(sbx.db.app, await adminActor(sbx), async (c) => {
    await c.query('select iam.register_device($1, $2, $3, $4, $5, $6, $7)', ['TEST-PRN-09', 'INSTRUMENT', site, 'DISP-1', null, createHash('sha256').update(`PRN9:${randomUUID()}`).digest('hex'), 'Line printer (simulated)']);
    await c.query('select tab.bind_print_device($1, $2, $3, $4)', [chain, 'TEST-PRN-09', SERIAL, 'PRINTER']);
  });
  gw = await fakeGateway(sbx);
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await gw?.close();
  await sbx?.close();
});

describe('G-21 when time passes and steps and the batch close (recipe-core 0581, tablets 0952)', () => {
  it('[IN-22][PR-37] a scheduled challenge not done within its interval (at database time) is MISSED: the late challenge carries the exception that stops the step, the line unit records MISSED and the output since the last good challenge is held; a forged engine that calls it on time, or drops the exception, is refused', async () => {
    const r = await run([packPhase('p-g21', 'G-21', { devices: [{ id: 'CW', kind: 'CHECKWEIGHER', every: { value: '3', unit: 's' }, triggers: ['START'] }], unit: LINE_UNIT })]);
    await lineUnit(sbx, r.d.runId);
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    expect(await r.rec.record('p-g21', { kind: 'CHALLENGE', device: 'CW', trigger: 'START', result: 'PASS' })).toBe('ok');
    const box = await withCommand(sbx.db.app, await r.as('operator1'), async (c) => (await c.query<{ r: Json }>('select plant.open_container($1, $2, $3, $4) as r', [r.d.runId, 'PACKAGING', 'kg', LINE_UNIT])).rows[0]?.r ?? {});
    await wait(3_500);
    const late: Entry = { kind: 'CHALLENGE', device: 'CW', trigger: 'INTERVAL', result: 'PASS' };
    const me = personaIn(sbx, 'operator1').personId;
    expect(await r.rec.message('p-g21', late, { tamper: laxEntry('p-g21', { device: 'CW', trigger: 'INTERVAL', result: 'PASS', missed: false, challengedBy: me }, { verificationRequired: true }) })).toMatch(/missed/);
    expect(await r.rec.message('p-g21', late, { tamper: laxEntry('p-g21', { device: 'CW', trigger: 'INTERVAL', result: 'PASS', missed: true, challengedBy: me }, { verificationRequired: true }) })).toMatch(/EBMR-EXE-291/);
    expect(await r.sql<boolean>('select exists (select 1 from plant.container_hold where container_id = $1) as r', [box['container_id']])).toBe(false);
    expect(await r.rec.record('p-g21', late)).toBe('ok');
    const s = await stateOf(sbx, r.d.runId);
    expect(Object.values(s.exceptions).map((x) => x['type'])).toEqual(['CHALLENGE_MISSED']);
    expect(await r.sql<string[]>("select array_agg(result order by recorded_at) as r from plant.ipc_check where batch_id = $1 and press_code = $2", [r.d.runId, LINE_UNIT])).toEqual(['PASS', 'MISSED', 'PASS']);
    expect(await r.sql<boolean>("select exists (select 1 from plant.container_hold h join plant.ipc_check k on k.id = h.ipc_check_id where h.container_id = $1 and k.result = 'MISSED') as r", [box['container_id']])).toBe(true);
  });

  it('[PR-40][IN-22][INV-32] the destruction step of the coded surplus closes only when it destroyed exactly the coded quantity the reconciliation counts; coded material is never returned to stores, not even through a forged engine', async () => {
    const r = await run([
      packPhase('p-g21', 'G-21', { items: [CARTON], destructionStep: 'p-destroy' }),
      packPhase('p-destroy', 'G-23', {}, { signatures: WITNESSED }),
    ]);
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    expect(await r.rec.record('p-g21', issueEntry)).toBe('ok');
    expect(await r.rec.record('p-g21', { kind: 'RECONCILIATION', item: 'CARTON', used: '1000', setupWaste: '10', damaged: '0', codedDestroyed: '10', uncodedReturned: '0', specimens: '0' })).toBe('ok');
    expect(await performAndVerify(r.d, 'p-g21@')).toBe('ok');
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-destroy@' });
    const disposal = (category: string, quantity: string, batchCoded: boolean): Entry => ({
      kind: 'DISPOSAL', category, material: CARTON_MATERIAL, batchCoded, quantity: { value: quantity, unit: '1' }, ...(category === 'DESTRUCTION' ? { method: 'Shredding' } : {}),
    });
    // Never returned: as uncoded (none counted uncoded returned) or, through a forged engine, as coded.
    expect(await r.rec.message('p-destroy', disposal('RETURN_TO_STORES', '1', false))).toMatch(/G21-CODED-RETURN.*EBMR-EXE-294/s);
    const coded = disposal('RETURN_TO_STORES', '1', true);
    expect(await r.rec.message('p-destroy', coded, { tamper: laxEntry('p-destroy', Object.fromEntries(Object.entries(coded).filter(([k]) => k !== 'kind'))) })).toMatch(/G23-BATCH-CODED|G21-CODED-RETURN/);
    // 6 of the 10 coded cartons destroyed: the step does not close.
    expect(await r.rec.record('p-destroy', disposal('DESTRUCTION', '6', true))).toBe('ok');
    expect(await performAndVerify(r.d, 'p-destroy@', 'WITNESSED')).toMatch(/G21-NOT-DESTROYED/);
    expect((await stateOf(sbx, r.d.runId)).steps['p-destroy@']?.['status']).toBe('IN_PROGRESS');
    expect(await r.rec.record('p-destroy', disposal('DESTRUCTION', '4', true))).toBe('ok');
    expect(await performAndVerify(r.d, 'p-destroy@', 'WITNESSED')).toBe('ok');
  });

  it('[PR-42] the packaging order does not reach EXECUTION_COMPLETE while its serial pool is unreconciled: a serial event after the closed report its step closed on leaves the pool open, and a newer report the record does not reconcile keeps it so; a clean order completes', async () => {
    const serialised = async (): Promise<{ r: Run; l3: ReturnType<typeof fakeL3>; poolId: string; complete: () => Promise<string> }> => {
      const l3 = fakeL3();
      const r = await run([packPhase('p-g21', 'G-21', { markets: { US: { gtin: GTIN } }, serialisation: { markets: ['US'] } })]);
      await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
      const pool = await withCommand(sbx.db.app, await r.as('operator1'), (c) => requestSerialPool(c, l3, { batchId: r.d.runId, stepKey: 'p-g21@', market: 'US', quantity: '10' }));
      expect(await r.rec.record('p-g21', { kind: 'SERIAL_POOL', poolId: pool.poolId, market: 'US', gtin: GTIN, quantity: '10' })).toBe('ok');
      await withCommand(sbx.db.app, await r.as('operator1'), (c) => sendSerialEvents(c, l3, pool.poolId, changes(10, null, 'COMMISSIONED')));
      l3.next = report(pool.poolId, '10', '0');
      const closed = await withCommand(sbx.db.app, await r.as('operator1'), (c) => fetchSerialReport(c, l3, pool.poolId));
      expect(await r.rec.record('p-g21', closed as Entry)).toBe('ok');
      expect(await signedOutcome(r.d, 'operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-g21@' })).toBe('ok');
      const complete = async (): Promise<string> => {
        const v = (await stateOf(sbx, r.d.runId)).steps['p-g21@']?.['status'] === 'AWAITING_VERIFICATION' ? await signedOutcome(r.d, 'verifier1', { type: 'VERIFY', stepKey: 'p-g21@', meaning: 'VERIFIED' }) : 'ok';
        if (v !== 'ok' || (await stateOf(sbx, r.d.runId))['status'] === 'EXECUTION_COMPLETE') return v;
        const view = await r.d.runView('supervisor1');
        const signOff = view.actions.find((a) => a.action === 'SIGN_OFF_STAGE');
        return signOff ? signedOutcome(r.d, 'supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: String(signOff.target) }) : 'no sign-off offered';
      };
      return { r, l3, poolId: pool.poolId, complete };
    };
    const open = await serialised();
    await withCommand(sbx.db.app, await open.r.as('operator1'), (c) => sendSerialEvents(c, open.l3, open.poolId, changes(1, 'COMMISSIONED', 'DECOMMISSIONED')));
    expect(await open.complete()).toMatch(/EBMR-EXE-298/);
    expect((await stateOf(sbx, open.r.d.runId))['status']).not.toBe('EXECUTION_COMPLETE');
    open.l3.next = report(open.poolId, '9', '0', '1');
    await withCommand(sbx.db.app, await open.r.as('operator1'), (c) => fetchSerialReport(c, open.l3, open.poolId));
    expect(await open.complete()).toMatch(/EBMR-EXE-298/);
    expect((await stateOf(sbx, open.r.d.runId))['status']).not.toBe('EXECUTION_COMPLETE');
    const clean = await serialised();
    expect(await clean.complete()).toBe('ok');
    expect((await stateOf(sbx, clean.r.d.runId))['status']).toBe('EXECUTION_COMPLETE');
  });

  it('[IN-22][PR-37] a G-21 step does not close while a failed challenge result of its devices is not recorded: the FAIL becomes an entry, with its exception and its hold', async () => {
    const r = await run([packPhase('p-g21', 'G-21', {
      devices: [{ id: 'CODER', kind: 'PRINTER', serial: SERIAL }, { id: 'CAM', kind: 'VISION', serial: SERIAL, triggers: ['START'] }],
      unit: LINE_UNIT, firstPrintRole: 'PRODUCTION_OPERATOR', shelfLifeMonths: 24, markets: { US: { gtin: GTIN } },
    })], ['operator1', 'operator2', 'verifier1', 'supervisor1']);
    await lineUnit(sbx, r.d.runId);
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    await occupyLine(sbx, r.d.runId, (await r.sql<string>('select batch_number as r from recipe.batch_execution where id = $1', [r.d.runId])) ?? '');
    const op = async <T,>(persona: string, text: string, params: unknown[]): Promise<T> => withCommand(sbx.db.app, await r.as(persona), async (c) => (await c.query<{ r: T }>(text, params)).rows[0]?.r as T);
    await op('operator1', 'select tab.record_packaging_batch_data($1, $2, null) as r', [r.d.runId, 'p-g21@']);
    const job = await op<Json>('operator1', 'select tab.release_print_job($1, $2, $3, $4) as r', [r.d.runId, 'p-g21@', 'CODER', 'LAYOUT-US-1']);
    expect((await gw.post(printJobAckPath(String(job['id'])), { sessionId: GW_SESSION, outcome: 'LOADED', echoedFields: job['fields'], sourceTime: '1790584618000000', message: null })).status).toBe(200);
    expect(await r.rec.record('p-g21', { kind: 'FIRST_PRINT', device: 'CODER', job: job['id'], approved: true }, { persona: 'operator2' })).toBe('ok');
    const ev = async (value: string): Promise<string> => {
      seq += 1;
      const res = await gw.post(PRINT_EVENTS_PATH, { sessionId: GW_SESSION, events: [{ deviceSerial: SERIAL, jobId: String(job['id']), kind: 'CHALLENGE_RESULT', value, sourceTime: `179058461800000${seq}`, sequence: String(seq) }] });
      return String((((res.body as Json)['events'] as Json[])[0] as Json)['eventId']);
    };
    const pass = await ev('PASS');
    expect(await r.rec.record('p-g21', { kind: 'CHALLENGE', device: 'CAM', trigger: 'START', result: 'PASS', event: pass, at: `179058461800000${seq}` })).toBe('ok');
    await ev('FAIL');
    expect(await signedOutcome(r.d, 'operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-g21@' })).toBe('ok');
    expect(await signedOutcome(r.d, 'operator2', { type: 'SIGN_PERFORMED', stepKey: 'p-g21@' })).toMatch(/EBMR-EXE-296/);
    expect((await stateOf(sbx, r.d.runId)).steps['p-g21@']?.['status']).toBe('IN_PROGRESS');
  });

  it('[IN-31] an MRP a person gives is checked by a second person before a print job carries it, and its giver, though holding the rights to check and release, neither checks nor releases', async () => {
    const r = await run([packPhase('p-g21', 'G-21', {
      devices: [{ id: 'CODER', kind: 'PRINTER', serial: SERIAL }], unit: LINE_UNIT, shelfLifeMonths: 24, markets: { IN: { gtin: GTIN, mrp: true } },
    })], ['operator1', 'operator2', 'verifier1', 'operatorVerifier1']);
    await lineUnit(sbx, r.d.runId);
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    await occupyLine(sbx, r.d.runId, (await r.sql<string>('select batch_number as r from recipe.batch_execution where id = $1', [r.d.runId])) ?? '');
    // The MRP's giver acts in the role each act needs (one session at a time: a new one supersedes the last).
    const giverIn: Record<string, Awaited<ReturnType<typeof asPersonaInRole>>> = {};
    const actorOf = async (persona: string): Promise<ActorContext> => {
      const role = /^giverAs(VERIFIER|OPERATOR)$/.exec(persona)?.[1];
      if (!role) return r.as(persona);
      advance();
      return actorOfBrowser(sbx, giverIn[role] ?? (giverIn[role] = await asPersonaInRole(sbx, 'operatorVerifier1', role, 'TEST-KIOSK-DISP-1')), 'operatorVerifier1');
    };
    const op = async (persona: string, text: string, params: unknown[]): Promise<string> => {
      try {
        await withCommand(sbx.db.app, await actorOf(persona), (c) => c.query(text, params));
        return 'ok';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    const release = (persona: string) => op(persona, 'select tab.release_print_job($1, $2, $3, $4)', [r.d.runId, 'p-g21@', 'CODER', 'LAYOUT-IN-1']);
    const check = (persona: string) => op(persona, 'select tab.check_packaging_batch_data($1, $2, 1)', [r.d.runId, 'p-g21@']);
    expect(await op('operatorVerifier1', 'select tab.record_packaging_batch_data($1, $2, null)', [r.d.runId, 'p-g21@'])).toMatch(/An MRP is given exactly for a pack that shows it.*EBMR-EXE-296/);
    // The giver holds STEP.EXECUTE and STEP.VERIFY (operator and verifier), so each refusal below is the person rule.
    expect(await op('operatorVerifier1', 'select tab.record_packaging_batch_data($1, $2, $3)', [r.d.runId, 'p-g21@', '45.50'])).toBe('ok');
    expect(await release('operator2')).toMatch(/The MRP of batch data version 1 is not checked by a second person yet \(IN-31\)\. \[EBMR-EXE-296\]/);
    expect(await check('giverAsVERIFIER')).toMatch(/The MRP is checked by a second person, not the one who gave it \(IN-31\)\. \[EBMR-EXE-296\]/);
    expect(await check('verifier1')).toBe('ok');
    expect(await release('giverAsOPERATOR')).toMatch(/The person who gave the MRP does not release the print job that carries it \(IN-31\)\. \[EBMR-EXE-296\]/);
    expect(await release('operator2')).toBe('ok');
  });

  it('[L-29][PR-36] the database refuses a print job on a G-21 step whose stored configuration names no plant unit of the line (arranged past the engine, which refuses such a master), so a batch-data change can always hold', async () => {
    const r = await run([packPhase('p-g21', 'G-21', { devices: [{ id: 'CODER', kind: 'PRINTER', serial: SERIAL }], unit: LINE_UNIT, shelfLifeMonths: 24, markets: { US: { gtin: GTIN } } })], ['operator1']);
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    await asSetup(sbx, "update recipe.test_package set content = content #- '{procedure,body,children,0,body,children,0,body,children,0,config,unit}' where package_hash = (select package_hash from recipe.batch_execution where id = $1)", [r.d.runId]);
    expect((await r.sql<Json>("select recipe.step_node(recipe.batch_mbr_content($1), 'p-g21') -> 'config' as r", [r.d.runId]))?.['unit']).toBeUndefined();
    await expect(withCommand(sbx.db.app, await r.as('operator1'), (c) => c.query('select tab.release_print_job($1, $2, $3, $4)', [r.d.runId, 'p-g21@', 'CODER', 'LAYOUT-US-1']))).rejects.toThrow(/The step names no plant unit of the line, so a batch-data change could hold nothing \(L-29\)\. \[EBMR-EXE-296\]/);
  });

  it('[PR-42] without a configured L3 system (EBMR_L3_URL unset) serialisation is off: a pool request is refused with a clear reason and nothing is recorded; the URL is read from the environment, https only in production', async () => {
    const base = { EBMR_INSTALLATION: 'SANDBOX', EBMR_DATABASE: 'ebmr_x', EBMR_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' };
    const key = (): string => randomUUID();
    expect(parseConfig(base, key).l3Url).toBeNull();
    expect(parseConfig({ ...base, EBMR_L3_URL: 'http://127.0.0.1:3031/' }, key).l3Url).toBe('http://127.0.0.1:3031');
    expect(() => parseConfig({ ...base, EBMR_L3_URL: 'http://u:p@l3.example' }, key)).toThrow(/EBMR_L3_URL/);
    const calls: string[] = [];
    const fetchImpl = ((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response(JSON.stringify({ error: { code: 'NOT_SERIALISED', message: 'x' } }), { status: 422 }));
    }) as unknown as typeof fetch;
    await expect(configuredL3Client('http://127.0.0.1:3031', { fetchImpl }).report('TEST-POOL-1')).rejects.toThrow(/L3 NOT_SERIALISED/);
    expect(calls).toEqual(['http://127.0.0.1:3031/l3/v1/pools/TEST-POOL-1/report']);
    const r = await run([packPhase('p-g21', 'G-21', { markets: { US: { gtin: GTIN } }, serialisation: { markets: ['US'] } })], ['operator1']);
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    const off = configuredL3Client(null);
    expect(await codeOf(withCommand(sbx.db.app, await r.as('operator1'), (c) => requestSerialPool(c, off, { batchId: r.d.runId, stepKey: 'p-g21@', market: 'US', quantity: '10' })).catch((e: unknown) => {
      throw new Error((e as Error).message);
    }))).toMatch(/L3 NOT_CONFIGURED: no serialisation L3 system is configured/);
    expect(await r.sql<string>('select count(*)::text as r from tab.serial_pool where batch_id = $1', [r.d.runId])).toBe('0');
  });
});
