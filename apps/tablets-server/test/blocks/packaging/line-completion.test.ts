/**
 * Phase 6 slice 6c (tablets 1230; IN-16, IN-31, PR-16, PR-34, PR-36, PR-39; defaults D-P6c-3 to D-P6c-9, D-P6c-16): the
 * completion of a packaging order, held by the database and proven as the application role on minimal packaging records:
 *   - start, middle and end coding specimens, in that order, each showing the record's coding (IN-16, IN-31);
 *   - a label specimen of every printed item before the G-21 step closes; a withdrawn specimen or a missing checker
 *     signature blocks the order's completion and names the gap (PR-16);
 *   - the post-use inspection, passed and verified by a second person, gates EXECUTION_COMPLETE (PR-34);
 *   - a vision rejection of a wrong expiry, reported by the gateway, stops the line until QA resolves it (PR-36);
 *   - the reconciliation waiver needs a qualifying device and a qualifying declaration (PR-39);
 *   - a print job's layout is an approved template the master names, with every field it binds (D-P6c-16).
 * The master's labelling declaration of a sandbox run is arranged as test set-up (recipe-core 0990's commands are
 * proven in recipe-core).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { PRINT_EVENTS_PATH, printJobAckPath } from '@ebmr/integration-sdk/printer';
import { adminActor, enrol, fakeGateway, type FakeGateway } from '../../devices/support.ts';
import { actorOfBrowser } from '../../esig/support.ts';
import { asPersonaInRole, importAndIssue, RunDriver, startExecServer, writePackage, type ExecServer } from '../../execution/support.ts';
import { fakeTimers, recorder, stateOf, type Entry } from '../granulation/db-support.ts';
import { requestSerialPool, type L3Client } from '../../../src/features/execution/serialisation.ts';
import { ARTWORK, CARTON_MATERIAL, GTIN, LINE_UNIT, lineUnit, minimalMbr, occupyLine, packPhase, productMaster } from './db-support.ts';

type Json = Record<string, unknown>;
let sbx: ExecServer;
let gw: FakeGateway;
const SERIAL = 'PRN-LC1';
const GW_SESSION = randomUUID();
let seq = 0;
const advance = (): void => {
  vi.advanceTimersByTime(7_000);
};
const CARTON = (coded: boolean): Json => ({ id: 'CARTON', material: CARTON_MATERIAL, artwork: { IN: ARTWORK, US: ARTWORK }, unit: '1', issue: { need: '1000', allowancePercent: '2' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' }, ...(coded ? { coded: true } : {}) });
const LINE_CFG = (coded: boolean): Json => ({
  items: [CARTON(coded)], devices: [{ id: 'CODER', kind: 'PRINTER', serial: SERIAL }, { id: 'CAM', kind: 'VISION', serial: SERIAL }],
  unit: LINE_UNIT, firstPrintRole: 'PRODUCTION_OPERATOR', shelfLifeMonths: 24, markets: { US: { gtin: GTIN } },
  ...(coded ? { destructionStep: 'p-destroy' } : {}),
});
const issueEntry: Entry = { kind: 'ISSUE', item: 'CARTON', lot: { id: 'TEST-CTN-LC', material: CARTON_MATERIAL, status: 'RELEASED', artwork: ARTWORK }, scannedArtwork: ARTWORK, quantity: { value: '1020', unit: '1' } };

interface Run {
  d: RunDriver;
  rec: ReturnType<typeof recorder>;
  batchNumber: string;
  as: (persona: string) => Promise<ActorContext>;
  /** The function's result as `persona`, or the database's refusal text. */
  op: <T = Json>(persona: string, text: string, params: unknown[]) => Promise<T | string>;
  sql: <T>(text: string, params?: unknown[]) => Promise<T | null>;
}

async function run(phases: Json[], productCode?: string): Promise<Run> {
  const issuer = await sbx.asPersona('issuer');
  const mbr = minimalMbr(phases);
  // Slice 7r: a product of its own (no product master in the sandbox, unlike the dc-mini product an earlier case arranges).
  if (productCode) mbr.header.product = { ...mbr.header.product, code: productCode };
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, mbr), undefined, {}, ['IN', 'US']);
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of ['operator1', 'operator2', 'verifier1', 'supervisor1', 'qa1']) browsers[p] = await sbx.asPersona(p, 'TEST-KIOSK-DISP-1');
  const d = new RunDriver(sbx, runId, browsers);
  d.beforeTap = advance;
  const as = async (persona: string): Promise<ActorContext> => {
    advance();
    return actorOfBrowser(sbx, d.browser(persona), persona);
  };
  const sql = async <T,>(text: string, params: unknown[] = []): Promise<T | null> => (await sbx.db.admin.query<{ r: T | null }>(text, params)).rows[0]?.r ?? null;
  return {
    d, as, sql,
    rec: recorder(sbx, d, advance),
    batchNumber: (await sql<string>('select batch_number as r from recipe.batch_execution where id = $1', [runId])) ?? '',
    op: async <T,>(persona: string, text: string, params: unknown[]): Promise<T | string> => {
      try {
        return await withCommand(sbx.db.app, await as(persona), async (c) => (await c.query<{ r: T }>(text, params)).rows[0]?.r as T);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
  };
}

async function signed(d: RunDriver, persona: string, intent: Parameters<RunDriver['sign']>[1]): Promise<string> {
  const r = await d.sign(persona, intent);
  if (r.result.ok) return 'ok';
  return JSON.stringify(r.result.error.kind === 'REFUSAL' ? r.result.error.envelope.refusal : r.result.error);
}
/** Signs the stage off when the run waits for it; the outcome, or 'ok' once EXECUTION_COMPLETE. */
async function complete(r: Run): Promise<string> {
  if ((await stateOf(sbx, r.d.runId))['status'] === 'EXECUTION_COMPLETE') return 'ok';
  const view = await r.d.runView('supervisor1');
  const signOff = view.actions.find((a) => a.action === 'SIGN_OFF_STAGE');
  return signOff ? signed(r.d, 'supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: String(signOff.target) }) : 'no sign-off offered';
}
async function event(kind: string, value: string, jobId: string | null): Promise<{ status: number; id: string }> {
  seq += 1;
  const res = await gw.post(PRINT_EVENTS_PATH, { sessionId: GW_SESSION, events: [{ deviceSerial: SERIAL, jobId, kind, value, sourceTime: `17905846180${seq.toString().padStart(5, '0')}`, sequence: String(seq) }] });
  return { status: res.status, id: String((((res.body as Json)['events'] as Json[] | undefined)?.[0])?.['eventId']) };
}
/** Batch data, the line occupied and a print job of CODER released and loaded (the record's data); returns the job. */
async function loadedJob(r: Run, layout = 'LAYOUT-US-1'): Promise<Json> {
  await lineUnit(sbx, r.d.runId);
  await occupyLine(sbx, r.d.runId, r.batchNumber);
  if (!(await r.sql<boolean>("select exists (select 1 from tab.packaging_batch_data where batch_id = $1 and step_key = 'p-g21@') as r", [r.d.runId]))) {
    await r.op('operator1', 'select tab.record_packaging_batch_data($1, $2, null) as r', [r.d.runId, 'p-g21@']);
  }
  const job = await r.op<Json>('operator1', 'select tab.release_print_job($1, $2, $3, $4) as r', [r.d.runId, 'p-g21@', 'CODER', layout]);
  if (typeof job === 'string') return { refused: job };
  const ack = await gw.post(printJobAckPath(String(job['id'])), { sessionId: GW_SESSION, outcome: 'LOADED', echoedFields: job['fields'], sourceTime: '1790584618000000', message: null });
  expect(ack.status).toBe(200);
  return job;
}
const spec = (r: Run, persona: string, position: string, coded: Json) =>
  r.op<string>(persona, 'select tab.record_coding_specimen($1, $2, $3, $4::jsonb) as r', [r.d.runId, 'p-g21@', position, JSON.stringify(coded)]);
const label = (r: Run, item: string, persona = 'operator1') => r.op<string>(persona, 'select tab.record_label_specimen($1, $2, $3, $4) as r', [r.d.runId, 'p-g21@', item, 'specimen attached to the record']);
const reconcile = (coded: boolean): Entry => ({ kind: 'RECONCILIATION', item: 'CARTON', used: '1000', setupWaste: coded ? '10' : '20', damaged: '0', codedDestroyed: coded ? '10' : '0', uncodedReturned: '0', specimens: '0' });

beforeAll(async () => {
  sbx = await startExecServer();
  fakeTimers();
  const steward = await sbx.asPersona('steward');
  await withCommand(sbx.db.app, await actorOfBrowser(sbx, steward, 'steward'), async (c) => {
    await c.query('select tab.register_sandbox_lot($1::jsonb)', [JSON.stringify({ lotCode: 'TEST-CTN-LC', materialCode: CARTON_MATERIAL, materialName: 'Printed carton', status: 'RELEASED', identityTested: true })]);
    await c.query('select tab.record_lot_artwork($1, null, $2)', ['TEST-CTN-LC', ARTWORK]);
  });
  const chain = await enrol(sbx);
  const site = (await sbx.db.admin.query<{ s: string }>("select site_code as s from iam.device where code = 'TEST-BAL-01'")).rows[0]?.s ?? null;
  await identity.withGuardedCommand(sbx.db.app, await adminActor(sbx), async (c) => {
    await c.query('select iam.register_device($1, $2, $3, $4, $5, $6, $7)', ['TEST-PRN-LC', 'INSTRUMENT', site, 'DISP-1', null, createHash('sha256').update(`PRNLC:${randomUUID()}`).digest('hex'), 'Line printer with vision (simulated)']);
    await c.query('select tab.bind_print_device($1, $2, $3, $4)', [chain, 'TEST-PRN-LC', SERIAL, 'PRINTER']);
  });
  gw = await fakeGateway(sbx);
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await gw?.close();
  await sbx?.close();
});

describe('packaging line completion in the database (tablets 1230)', () => {
  it('[IN-16] start, middle and end coding specimens are required, in that order, each showing the record\'s batch number, manufacture date and expiry; the step does not close without them', async () => {
    const r = await run([packPhase('p-g21', 'G-21', { items: [CARTON(true)], destructionStep: 'p-destroy' }), packPhase('p-destroy', 'G-23', {}, { signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } } })]);
    expect(await spec(r, 'operator1', 'START', {})).toMatch(/EBMR-LBL-030 /);
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    expect(await r.rec.record('p-g21', issueEntry)).toBe('ok');
    // No product master in effect yet: the record gives no expiry, so no coding can be checked.
    expect(await spec(r, 'operator1', 'START', { batch: r.batchNumber, mfgDate: '2026-01-01', expiryDate: '2027-12' })).toMatch(/EBMR-LBL-034 /);
    await productMaster(sbx, r.d.runId);
    const be = (await r.sql<Json>('select recipe.batch_expiry($1) as r', [r.d.runId])) ?? {};
    const coded = { batch: r.batchNumber, mfgDate: be['manufactureDate'], expiryDate: be['expiryMonth'] } as Json;
    expect(await r.sql<Json>("select tab.g21_expected_coding($1, 'p-g21@') as r", [r.d.runId])).toEqual(coded);
    // Out of order, with another value, with a field the coding has no place for, or by a person without STEP.EXECUTE.
    expect(await spec(r, 'operator1', 'MIDDLE', coded)).toMatch(/EBMR-LBL-032 .*the next one is START/);
    expect(await spec(r, 'operator1', 'START', { ...coded, expiryDate: '2099-01' })).toMatch(/EBMR-LBL-033 the specimen shows expiryDate 2099-01/);
    expect(await spec(r, 'operator1', 'START', { ...coded, batch: 'OTHER-1' })).toMatch(/EBMR-LBL-033 the specimen shows batch OTHER-1/);
    expect(await spec(r, 'operator1', 'START', { ...coded, lot: 'X' })).toMatch(/EBMR-LBL-035 /);
    expect(await spec(r, 'issuer', 'START', coded)).toMatch(/EBMR-IAM-040 /);
    // The step does not close with only some of them.
    expect(await r.rec.record('p-g21', reconcile(true))).toBe('ok');
    expect(await signed(r.d, 'operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-g21@' })).toMatch(/EBMR-LBL-060.*no START coding specimen \(IN-16/);
    expect(await spec(r, 'operator1', 'START', coded)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await spec(r, 'operator1', 'END', coded)).toMatch(/EBMR-LBL-032 .*the next one is MIDDLE/);
    expect(await spec(r, 'operator2', 'MIDDLE', coded)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await signed(r.d, 'operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-g21@' })).toMatch(/EBMR-LBL-060.*no END coding specimen/);
    expect(await spec(r, 'operator1', 'END', coded)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await spec(r, 'operator1', 'END', coded)).toMatch(/EBMR-LBL-032 .*all three are recorded/);
    expect(await signed(r.d, 'operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-g21@' })).toMatch(/EBMR-LBL-060.*no label specimen of item CARTON \(PR-16\)/);
    expect(await label(r, 'FOIL')).toMatch(/EBMR-LBL-036 /);
    expect(await label(r, 'CARTON')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await label(r, 'CARTON')).toMatch(/EBMR-LBL-036 .*already/);
    expect(await signed(r.d, 'operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-g21@' })).toBe('ok');
    expect((await stateOf(sbx, r.d.runId)).steps['p-g21@']?.['status']).toBe('AWAITING_VERIFICATION');
    // Once the step is performed no specimen is recorded or withdrawn.
    const one = (await r.sql<string>("select id::text as r from tab.packaging_specimen where batch_id = $1 and kind = 'LABEL'", [r.d.runId])) ?? '';
    expect(await r.op('operator1', 'select tab.void_packaging_specimen($1, $2) as r', [one, 'recorded in error'])).toMatch(/EBMR-LBL-030 /);
    await expect(sbx.db.app.query("insert into tab.packaging_specimen (batch_id, step_key, kind, item, recorded_by_person, recorded_by_account, correlation_id) values ($1, 'p-g21@', 'LABEL', 'CARTON', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [r.d.runId])).rejects.toThrow(/permission denied/);
    // A step that does not code takes label specimens only.
    const plain = await run([packPhase('p-g21', 'G-21', { items: [CARTON(false)] })]);
    await plain.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    expect(await spec(plain, 'operator1', 'START', coded)).toMatch(/EBMR-LBL-031 /);
  });

  it('[PR-43][IN-16][DI-05] a test run with no product master in the sandbox is dated by the shelf life its own master\'s G-21 step states, so its coding specimens are checked (D-7r-1); a GMP batch never is', async () => {
    const witnessed = { signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } } };
    const r = await run([packPhase('p-g21', 'G-21', { items: [CARTON(true)], destructionStep: 'p-destroy', shelfLifeMonths: 30 }), packPhase('p-destroy', 'G-23', {}, witnessed)], 'TST-SL-7R');
    expect(await r.sql<Json>('select recipe.batch_shelf_life($1) as r', [r.d.runId])).toEqual({ versionId: null, shelfLifeMonths: 30, stabilityReference: null, tentative: true });
    const be = (await r.sql<Json>('select recipe.batch_expiry($1) as r', [r.d.runId])) ?? {};
    expect(be['shelfLifeMonths']).toBe(30);
    expect(await r.sql<string>('select recipe.expiry_month_end($1::date, 30)::text as r', [be['manufactureDate']])).toBe(be['expiryDate']);
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    expect(await r.rec.record('p-g21', issueEntry)).toBe('ok');
    const coded = { batch: r.batchNumber, mfgDate: be['manufactureDate'], expiryDate: be['expiryMonth'] } as Json;
    expect(await r.sql<Json>("select tab.g21_expected_coding($1, 'p-g21@') as r", [r.d.runId])).toEqual(coded);
    expect(await spec(r, 'operator1', 'START', { ...coded, expiryDate: '2099-01' })).toMatch(/EBMR-LBL-033 /);
    expect(await spec(r, 'operator1', 'START', coded)).toMatch(/^[0-9a-f-]{36}$/);
    // A master whose G-21 step states no shelf life gives none, as before.
    const none = await run([packPhase('p-g21', 'G-21', { items: [CARTON(true)], destructionStep: 'p-destroy' }), packPhase('p-destroy', 'G-23', {}, witnessed)], 'TST-SL-7R2');
    expect(await none.sql<Json>('select recipe.batch_shelf_life($1) as r', [none.d.runId])).toBeNull();
    // Only a test run (a batch that runs a test package) on the sandbox: a batch without one gives none.
    expect(await r.sql<Json>("select recipe.batch_shelf_life($1) as r from recipe.batch_execution b where b.id = $1 and b.package_hash is not null", [r.d.runId])).not.toBeNull();
    const fn = (await r.sql<string>("select pg_get_functiondef('recipe.batch_shelf_life(uuid)'::regprocedure) as r")) ?? '';
    expect(fn).toMatch(/b\.package_hash is null or kernel\.installation_kind\(\) <> 'SANDBOX'/);
  });

  it('[PR-16][AS-14] removing one label specimen or one checker signature blocks completion and names the gap', async () => {
    const r = await run([packPhase('p-g21', 'G-21', { items: [CARTON(false)] })]);
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    expect(await r.rec.record('p-g21', issueEntry)).toBe('ok');
    expect(await r.rec.record('p-g21', reconcile(false))).toBe('ok');
    const id = await label(r, 'CARTON');
    expect(await r.op('operator1', 'select tab.void_packaging_specimen($1, $2) as r', [id, ' '])).toMatch(/EBMR-LBL-037 /);
    expect(await r.op('operator1', 'select tab.void_packaging_specimen($1, $2) as r', [id, 'photograph unreadable'])).toBe(r.d.runId);
    expect(await r.sql<string>('select tab.packaging_completion_problem($1) as r', [r.d.runId])).toMatch(/step p-g21@ is not performed/);
    expect(await signed(r.d, 'operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-g21@' })).toMatch(/EBMR-LBL-060.*this row closes step p-g21@, but step p-g21@ has no label specimen of item CARTON \(PR-16\)/);
    expect(await label(r, 'CARTON')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await signed(r.d, 'operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-g21@' })).toBe('ok');
    // The checker's signature is the check of the specimens: without it the order does not complete, by any writer.
    expect(await r.sql<string>('select tab.packaging_completion_problem($1) as r', [r.d.runId])).toMatch(/step p-g21@ awaits its checker's signature, which is the check of its specimens \(PR-16\)/);
    await expect(sbx.db.admin.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = $1", [r.d.runId])).rejects.toThrow(/EBMR-LBL-061.*the packaging order cannot complete: step p-g21@ awaits its checker's signature/);
    expect(await signed(r.d, 'verifier1', { type: 'VERIFY', stepKey: 'p-g21@', meaning: 'VERIFIED' })).toBe('ok');
    expect(await r.sql<string>('select tab.packaging_completion_problem($1) as r', [r.d.runId])).toMatch(/no post-use inspection/);
    const view = await r.sql<Json>('select tab.packaging_completion_view($1) as r', [r.d.runId]);
    expect(view).toMatchObject({ batchNumber: r.batchNumber, steps: [{ stepKey: 'p-g21@', status: 'COMPLETED', coding: false, items: ['CARTON'], problem: null, labelSpecimens: [{ item: 'CARTON' }] }], completionProblem: (expect.stringMatching(/post-use/) as string) });
  });

  it('[PR-34] closing an order without the post-use inspection is blocked; a failed or unverified inspection blocks it too; the inspection is recorded after printing ended and verified by another person', async () => {
    const r = await run([packPhase('p-g21', 'G-21', { items: [CARTON(false)] })]);
    const checks = { noPrintedMaterial: true, noProduct: true, noDocuments: true, lineClean: true };
    const inspect = (c: Json, persona = 'operator1') => r.op<string>(persona, 'select tab.record_post_use_inspection($1, $2::jsonb, $3) as r', [r.d.runId, JSON.stringify(c), null]);
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    expect(await inspect(checks)).toMatch(/EBMR-LBL-041 step p-g21@ is not performed yet/);
    expect(await r.rec.record('p-g21', issueEntry)).toBe('ok');
    expect(await r.rec.record('p-g21', reconcile(false))).toBe('ok');
    await label(r, 'CARTON');
    expect(await signed(r.d, 'operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-g21@' })).toBe('ok');
    expect(await signed(r.d, 'verifier1', { type: 'VERIFY', stepKey: 'p-g21@', meaning: 'VERIFIED' })).toBe('ok');
    expect(await complete(r)).toMatch(/EBMR-LBL-061.*the packaging order cannot complete: the line has no post-use inspection \(PR-34\)/);
    expect((await stateOf(sbx, r.d.runId))['status']).not.toBe('EXECUTION_COMPLETE');
    expect(await inspect({ noPrintedMaterial: true, noProduct: true })).toMatch(/EBMR-LBL-042 /);
    const failed = await inspect({ ...checks, lineClean: false });
    expect(await complete(r)).toMatch(/EBMR-LBL-061.*did not pass/);
    expect(await r.op('verifier1', 'select tab.verify_post_use_inspection($1) as r', [failed])).toBe(r.d.runId);
    expect(await complete(r)).toMatch(/EBMR-LBL-061.*did not pass/);
    // The inspector, though holding the verifier's right too, does not verify their own inspection.
    const inRole = async (role: string): Promise<ActorContext> => {
      advance();
      return actorOfBrowser(sbx, await asPersonaInRole(sbx, 'operatorVerifier1', role, 'TEST-KIOSK-DISP-1'), 'operatorVerifier1');
    };
    const passed = await withCommand(sbx.db.app, await inRole('OPERATOR'), async (c) => (await c.query<{ r: string }>('select tab.record_post_use_inspection($1, $2::jsonb, null) as r', [r.d.runId, JSON.stringify(checks)])).rows[0]?.r ?? '');
    expect(await complete(r)).toMatch(/EBMR-LBL-061.*not verified by a second person/);
    await expect(withCommand(sbx.db.app, await inRole('VERIFIER'), (c) => c.query('select tab.verify_post_use_inspection($1)', [passed]))).rejects.toThrow(/EBMR-LBL-044 /);
    expect(await r.op('operator2', 'select tab.verify_post_use_inspection($1) as r', [passed])).toMatch(/EBMR-IAM-040 /);
    expect(await r.op('verifier1', 'select tab.verify_post_use_inspection($1) as r', [passed])).toBe(r.d.runId);
    expect(await r.op('verifier1', 'select tab.verify_post_use_inspection($1) as r', [passed])).toMatch(/EBMR-LBL-043 .*already/);
    expect(await complete(r)).toBe('ok');
    expect((await stateOf(sbx, r.d.runId))['status']).toBe('EXECUTION_COMPLETE');
    await expect(sbx.db.app.query('insert into tab.post_use_inspection_verify (inspection_id, batch_id, verified_by_person, verified_by_account, correlation_id) values ($1, $2, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', [failed, r.d.runId])).rejects.toThrow(/permission denied/);
  });

  it('[PR-36] a wrong expiry on a test unit is rejected by vision and stops the line: the gateway\'s EXPIRY_REJECTED opens a line stop; no job is released and the step does not close until QA resolves it with a reason', async () => {
    const r = await run([packPhase('p-g21', 'G-21', LINE_CFG(false))]);
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    const job = await loadedJob(r);
    expect(await r.rec.record('p-g21', { kind: 'FIRST_PRINT', device: 'CODER', job: job['id'], approved: true }, { persona: 'operator2' })).toBe('ok');
    // The vision system read another expiry on the challenge unit than the job's: the printer reports the rejection and stops.
    expect((await event('FAULT', 'EXPIRY_REJECTED', String(job['id']))).status).toBe(200);
    expect((await event('FAULT', 'LINE_STOPPED', String(job['id']))).status).toBe(200);
    const stops = await r.sql<Json[]>("select jsonb_agg(jsonb_build_object('cause', cause, 'jobId', job_id, 'stepKey', step_key)) as r from tab.line_stop where batch_id = $1", [r.d.runId]);
    expect(stops).toEqual([{ cause: 'EXPIRY_REJECTED', jobId: job['id'], stepKey: 'p-g21@' }]);
    expect(await r.op('operator1', 'select tab.release_print_job($1, $2, $3, $4) as r', [r.d.runId, 'p-g21@', 'CODER', 'LAYOUT-US-1'])).toMatch(/EBMR-LBL-062 step p-g21@ has an open line stop \(EXPIRY_REJECTED/);
    expect(await r.rec.record('p-g21', issueEntry)).toBe('ok');
    await label(r, 'CARTON');
    for (const position of ['START', 'MIDDLE', 'END']) await spec(r, 'operator1', position, (await r.sql<Json>("select tab.g21_expected_coding($1, 'p-g21@') as r", [r.d.runId])) ?? {});
    const stopId = (await r.sql<string>('select id::text as r from tab.line_stop where batch_id = $1', [r.d.runId])) ?? '';
    expect((await r.sql<Json>('select tab.packaging_completion_view($1) as r', [r.d.runId]))?.['steps']).toMatchObject([{ problem: (expect.stringMatching(/open line stop \(EXPIRY_REJECTED/) as string) }]);
    // QA alone resolves it, with a reason.
    expect(await r.op('operator1', 'select tab.resolve_line_stop($1, $2) as r', [stopId, 'coder corrected'])).toMatch(/EBMR-IAM-040 .*QA\.FLOOR_APPROVE/);
    expect(await r.op('qa1', 'select tab.resolve_line_stop($1, $2) as r', [stopId, ''])).toMatch(/EBMR-LBL-046 /);
    expect(await r.op('qa1', 'select tab.resolve_line_stop($1, $2) as r', [stopId, 'Wrong expiry in the coder buffer; job cleared, coder re-loaded from the record, challenge passed'])).toBe(r.d.runId);
    expect(await r.op('qa1', 'select tab.resolve_line_stop($1, $2) as r', [stopId, 'again'])).toMatch(/EBMR-LBL-045 .*already/);
    expect(await r.op<Json>('operator1', 'select tab.release_print_job($1, $2, $3, $4) as r', [r.d.runId, 'p-g21@', 'CODER', 'LAYOUT-US-1'])).toMatchObject({ packagingOrder: r.batchNumber });
    // Any other fault is recorded and stops nothing.
    expect((await event('FAULT', 'RIBBON_LOW', String(job['id']))).status).toBe(200);
    expect(await r.sql<string>('select count(*)::text as r from tab.line_stop where batch_id = $1', [r.d.runId])).toBe('1');
    await expect(sbx.db.app.query("insert into tab.line_stop_resolution (stop_id, batch_id, reason, resolved_by_person, resolved_by_account, correlation_id) values ($1, $2, 'x', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [stopId, r.d.runId])).rejects.toThrow(/permission denied/);
  });

  it('[PR-39] the waiver without a qualifying device is refused: not a vision or reader device, no passing challenge on a job of the step, or an item not declared for a 100 % electronic inspection; it records the device and its challenge and never switches the reconciliation off', async () => {
    const r = await run([packPhase('p-g21', 'G-21', LINE_CFG(false))]);
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    const waive = (item: string, device: string, persona = 'qa1') => r.op<string>(persona, 'select tab.enable_reconciliation_waiver($1, $2, $3, $4) as r', [r.d.runId, 'p-g21@', item, device]);
    expect(await waive('CARTON', 'CAM', 'operator1')).toMatch(/EBMR-IAM-040 /);
    expect(await waive('CARTON', 'CODER')).toMatch(/EBMR-LBL-049 CODER is no qualifying device/);
    expect(await waive('CARTON', 'NOPE')).toMatch(/EBMR-LBL-049 /);
    expect(await waive('FOIL', 'CAM')).toMatch(/EBMR-LBL-047 /);
    expect(await waive('CARTON', 'CAM')).toMatch(/EBMR-LBL-050 device CAM \(PRN-LC1\) has no passing challenge/);
    const job = await loadedJob(r);
    expect((await event('CHALLENGE_RESULT', 'FAIL', String(job['id']))).status).toBe(200);
    expect(await waive('CARTON', 'CAM')).toMatch(/EBMR-LBL-050 /);
    const pass = await event('CHALLENGE_RESULT', 'PASS', String(job['id']));
    expect(pass.status).toBe(200);
    // A qualifying device, but the item is not declared ROLL_LABEL or CUT_LABEL with the electronic option.
    expect(await waive('CARTON', 'CAM')).toMatch(/EBMR-LBL-048 item CARTON is not declared/);
    const version = await declare(r, 'CUT_LABEL', 'VISUAL_100_VERIFIED');
    expect(await waive('CARTON', 'CAM')).toMatch(/EBMR-LBL-048 /);
    await declare(r, 'ROLL_LABEL', null, version);
    const id = await waive('CARTON', 'CAM');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await r.sql<Json>('select jsonb_build_object(\'device\', device, \'serial\', device_serial, \'event\', challenge_event_id::text, \'form\', form) as r from tab.reconciliation_waiver where id = $1', [id])).toEqual({ device: 'CAM', serial: SERIAL, event: pass.id, form: 'ROLL_LABEL' });
    expect(await waive('CARTON', 'CAM')).toMatch(/duplicate key|EBMR/);
    // The reconciliation still runs: the step does not close without it.
    expect(await r.rec.record('p-g21', issueEntry)).toBe('ok');
    await label(r, 'CARTON');
    expect(await signed(r.d, 'operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-g21@' })).not.toBe('ok');
    expect((await stateOf(sbx, r.d.runId)).steps['p-g21@']?.['status']).toBe('IN_PROGRESS');
  });

  it('[PR-36][IN-31] a print job carries an approved label template the master names for its step, with every record field the template binds (D-P6c-16)', async () => {
    const r = await run([packPhase('p-g21', 'G-21', LINE_CFG(false))]);
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    const tpl = await template(['BATCH_NUMBER', 'EXPIRY_DATE', 'GTIN'], true);
    const mrp = await template(['BATCH_NUMBER', 'MRP'], true);
    const version = await declare(r, 'CARTON', null, undefined, tpl.id);
    expect(await loadedJob(r, 'LAYOUT-US-1')).toMatchObject({ refused: (expect.stringMatching(new RegExp(`EBMR-LBL-063 layout LAYOUT-US-1 is not an approved label template the packaging master names for step p-g21 \\(${tpl.ref}\\)`)) as string) });
    expect(await loadedJob(r, tpl.ref)).toMatchObject({ layoutRef: tpl.ref });
    await declare(r, 'CARTON', null, version, mrp.id);
    expect((await loadedJob(r, mrp.ref))['refused']).toMatch(/EBMR-LBL-063 template .* binds mrp, which the job does not carry/);
    const draft = await template(['BATCH_NUMBER'], false);
    await declare(r, 'CARTON', null, version, draft.id);
    expect((await loadedJob(r, draft.ref))['refused']).toMatch(/EBMR-LBL-063 /);
  });

  it('[PR-42] a pool the L3 system issues with a duplicate serial is refused and nothing is recorded (the simulator\'s DUPLICATE_SERIAL fault)', async () => {
    const r = await run([packPhase('p-g21', 'G-21', { markets: { US: { gtin: GTIN } }, serialisation: { markets: ['US'] } })]);
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    const duplicating: L3Client = {
      requestPool: () => Promise.resolve({ poolId: `TEST-POOL-${randomUUID().slice(0, 8).toUpperCase()}`, serials: ['S1', 'S2', 'S1'], issuedAt: '1790584618000000' }),
      sendEvents: () => Promise.resolve(),
      report: () => Promise.reject(new Error('no report')),
    };
    await expect(withCommand(sbx.db.app, await r.as('operator1'), (c) => requestSerialPool(c, duplicating, { batchId: r.d.runId, stepKey: 'p-g21@', market: 'US', quantity: '3' }))).rejects.toThrow(/no pool of the quantity asked.*EBMR-EXE-297/);
    expect(await r.sql<string>('select count(*)::text as r from tab.serial_pool where batch_id = $1', [r.d.runId])).toBe('0');
  });
});

let templates = 0;
/** A label template arranged as master data (recipe-core 0990's commands are proven there), approved when asked. */
async function template(fields: string[], approved: boolean): Promise<{ id: string; ref: string }> {
  const id = randomUUID();
  templates += 1;
  const code = `LC-${templates.toString()}-${randomUUID().slice(0, 4).toUpperCase()}`;
  const c = await sbx.db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    await c.query(`insert into recipe.label_template (id, code, version, scope, markets, layout, fields, created_by_person, created_by_account, correlation_id)
                   values ($1, $2, 1, 'EXPORT', '{US}', '{"width":"60","height":"40","elements":[]}', $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`, [id, code, fields]);
    if (approved) await c.query("insert into recipe.label_template_event (template_id, event, by_person, by_account, correlation_id) values ($1, 'APPROVED', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [id]);
    await c.query('commit');
  } finally {
    c.release();
  }
  return { id, ref: `${code}-v1` };
}
/** The run's master labelling declaration of p-g21 item CARTON, arranged (a sandbox run has no pinned master version). */
async function declare(r: Run, form: string, option: string | null, version: string = randomUUID(), templateId: string | null = null): Promise<string> {
  const c = await sbx.db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    if (!(await c.query('select 1 from recipe.batch_mbr_pin where batch_id = $1', [r.d.runId])).rowCount) {
      await c.query(`insert into recipe.batch_mbr_pin (batch_id, family_id, version_id, version_number, content_hash, markets, scope, selection, rule_table_versions, person_id, account_id)
                     values ($1, gen_random_uuid(), $2, 1, $3, '{IN,US}', '{}', '{}', '{}', gen_random_uuid(), gen_random_uuid())`, [r.d.runId, version, 'a'.repeat(64)]);
    }
    await c.query(`insert into recipe.packaging_labelling (version_id, step, item, form, template_id, option_211122g, recorded_by_person, recorded_by_account, correlation_id)
                   values ($1, 'p-g21', 'CARTON', $2, $3, $4, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`, [version, form, templateId, option]);
    await c.query('commit');
  } finally {
    c.release();
  }
  return version;
}
