/**
 * The completion of a packaging order, rule by rule (SQL mutation group "packaging-labels-and-line-completion",
 * tablets 1230). The scenario test (blocks/packaging/line-completion.test.ts) shows specimens, the post-use inspection,
 * line stops and the reconciliation waiver working on minimal packaging records; these take each rule the Phase 6
 * mutation run found unproven to the input where it alone decides:
 *  - label specimens: a note is 1 to 500 characters; a specimen of one item does not stand for another's (PR-16);
 *  - coding specimens: each malformed specimen alone is refused; coding applies on a printer or a coded item, never on
 *    a vision system alone (IN-16, D-P6c-4);
 *  - withdrawing a specimen: an unknown specimen, a second withdrawal of the same one, a reason of up to 2000
 *    characters; one specimen's withdrawal does not count as another's (PR-16);
 *  - the waiver: CUT_LABEL with the 100 % electronic option qualifies; an item is judged on its own declaration, not on
 *    another item's of the step (PR-39); a step whose items are declared without a label template releases a print job
 *    on its layout (D-P6c-16);
 *  - line stops: a rejection on a job opens a stop even while another order's job has an open one, and again after
 *    its own earlier stop was resolved; a stop is resolved by its id with a reason of up to 2000 characters (PR-36);
 *  - the post-use inspection: only an order with a printed-materials step has one; each malformed answer or note alone
 *    is refused (a note of 1000 characters is not); an unknown inspection is not verified; an earlier inspection is not
 *    verified while a later one of the same order stands, and another order's later inspection does not block it
 *    (PR-34).
 * The master's labelling declaration and the other order's inspection are arranged as test set-up, as the scenario
 * test arranges its declarations (recipe-core 0990's commands are proven in recipe-core).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { PRINT_EVENTS_PATH, printJobAckPath } from '@ebmr/integration-sdk/printer';
import { adminActor, enrol, fakeGateway, type FakeGateway } from '../devices/support.ts';
import { actorOfBrowser } from '../esig/support.ts';
import { importAndIssue, RunDriver, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';
import { fakeTimers, recorder, stateOf, type Entry } from '../blocks/granulation/db-support.ts';
import { ARTWORK, CARTON_MATERIAL, GTIN, LINE_UNIT, lineUnit, minimalMbr, occupyLine, packPhase } from '../blocks/packaging/db-support.ts';

type Json = Record<string, unknown>;
let sbx: ExecServer;
let gw: FakeGateway;
const SERIAL = 'PRN-MUT1';
const GW_SESSION = randomUUID();
let seq = 0;
const advance = (): void => {
  vi.advanceTimersByTime(7_000);
};
const ITEM = (id: string): Json => ({ id, material: CARTON_MATERIAL, artwork: { IN: ARTWORK, US: ARTWORK }, unit: '1', issue: { need: '1000', allowancePercent: '2' }, counting: 'ROLL_COUNTER', limits: { maxUnexplained: '0' } });
const LINE_CFG = (items: string[]): Json => ({
  items: items.map(ITEM), devices: [{ id: 'CODER', kind: 'PRINTER', serial: SERIAL }, { id: 'CAM', kind: 'VISION', serial: SERIAL }],
  unit: LINE_UNIT, firstPrintRole: 'PRODUCTION_OPERATOR', shelfLifeMonths: 24, markets: { US: { gtin: GTIN } },
});
const issueEntry: Entry = { kind: 'ISSUE', item: 'CARTON', lot: { id: 'TEST-CTN-MUT', material: CARTON_MATERIAL, status: 'RELEASED', artwork: ARTWORK }, scannedArtwork: ARTWORK, quantity: { value: '1020', unit: '1' } };
const reconcile: Entry = { kind: 'RECONCILIATION', item: 'CARTON', used: '1000', setupWaste: '20', damaged: '0', codedDestroyed: '0', uncodedReturned: '0', specimens: '0' };

interface Run {
  d: RunDriver;
  rec: ReturnType<typeof recorder>;
  batchNumber: string;
  op: <T = Json>(persona: string, text: string, params: unknown[]) => Promise<T | string>;
  sql: <T>(text: string, params?: unknown[]) => Promise<T | null>;
}

async function run(phases: Json[]): Promise<Run> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, minimalMbr(phases)), undefined, {}, ['IN', 'US']);
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
    d, sql,
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
async function event(kind: string, value: string, jobId: string | null): Promise<{ status: number; id: string }> {
  seq += 1;
  const res = await gw.post(PRINT_EVENTS_PATH, { sessionId: GW_SESSION, events: [{ deviceSerial: SERIAL, jobId, kind, value, sourceTime: `17905846190${seq.toString().padStart(5, '0')}`, sequence: String(seq) }] });
  return { status: res.status, id: String((((res.body as Json)['events'] as Json[] | undefined)?.[0])?.['eventId']) };
}
/** Batch data, the line occupied and a print job of CODER released and loaded; returns the job's id. */
async function loadedJob(r: Run): Promise<string> {
  await lineUnit(sbx, r.d.runId);
  await occupyLine(sbx, r.d.runId, r.batchNumber);
  await r.op('operator1', 'select tab.record_packaging_batch_data($1, $2, null) as r', [r.d.runId, 'p-g21@']);
  const job = await r.op<Json>('operator1', 'select tab.release_print_job($1, $2, $3, $4) as r', [r.d.runId, 'p-g21@', 'CODER', 'LAYOUT-US-1']);
  expect(typeof job).not.toBe('string');
  const ack = await gw.post(printJobAckPath(String((job as Json)['id'])), { sessionId: GW_SESSION, outcome: 'LOADED', echoedFields: (job as Json)['fields'], sourceTime: '1790584619000000', message: null });
  expect(ack.status).toBe(200);
  return String((job as Json)['id']);
}
/** The master's labelling declaration of `item` on step p-g21 of the run's pinned version (arranged as set-up). */
async function declare(r: Run, item: string, form: string, option: string | null): Promise<void> {
  const c = await sbx.db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    let version = (await c.query<{ v: string }>('select version_id::text as v from recipe.batch_mbr_pin where batch_id = $1', [r.d.runId])).rows[0]?.v;
    if (!version) {
      version = randomUUID();
      await c.query(`insert into recipe.batch_mbr_pin (batch_id, family_id, version_id, version_number, content_hash, markets, scope, selection, rule_table_versions, person_id, account_id)
                     values ($1, gen_random_uuid(), $2, 1, $3, '{IN,US}', '{}', '{}', '{}', gen_random_uuid(), gen_random_uuid())`, [r.d.runId, version, 'a'.repeat(64)]);
    }
    await c.query(`insert into recipe.packaging_labelling (version_id, step, item, form, template_id, option_211122g, recorded_by_person, recorded_by_account, correlation_id)
                   values ($1, 'p-g21', $2, $3, null, $4, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`, [version, item, form, option]);
    await c.query('commit');
  } finally {
    c.release();
  }
}
const label = (r: Run, item: string, note: string | null) => r.op<string>('operator1', 'select tab.record_label_specimen($1, $2, $3, $4) as r', [r.d.runId, 'p-g21@', item, note]);
const voidSpecimen = (r: Run, id: string, reason: string) => r.op<string>('operator1', 'select tab.void_packaging_specimen($1, $2) as r', [id, reason]);
const stopsOf = async (r: Run): Promise<string> => (await r.sql<string>('select count(*)::text as r from tab.line_stop where batch_id = $1', [r.d.runId])) ?? '';
const UUID = /^[0-9a-f-]{36}$/;

/** The two-item run of the specimen and waiver tests, whose job keeps an open line stop for the line-stop test. */
let twoItems: Run;
let twoItemsJob: string;
/** The run of the line-stop test (another order: its inspection is the later one of another order in the last test). */
let other: Run;

beforeAll(async () => {
  sbx = await startExecServer();
  fakeTimers();
  const steward = await sbx.asPersona('steward');
  await withCommand(sbx.db.app, await actorOfBrowser(sbx, steward, 'steward'), async (c) => {
    await c.query('select tab.register_sandbox_lot($1::jsonb)', [JSON.stringify({ lotCode: 'TEST-CTN-MUT', materialCode: CARTON_MATERIAL, materialName: 'Printed carton', status: 'RELEASED', identityTested: true })]);
    await c.query('select tab.record_lot_artwork($1, null, $2)', ['TEST-CTN-MUT', ARTWORK]);
  });
  const chain = await enrol(sbx);
  const site = (await sbx.db.admin.query<{ s: string }>("select site_code as s from iam.device where code = 'TEST-BAL-01'")).rows[0]?.s ?? null;
  await identity.withGuardedCommand(sbx.db.app, await adminActor(sbx), async (c) => {
    await c.query('select iam.register_device($1, $2, $3, $4, $5, $6, $7)', ['TEST-PRN-MUT', 'INSTRUMENT', site, 'DISP-1', null, createHash('sha256').update(`PRNMUT:${randomUUID()}`).digest('hex'), 'Line printer with vision (simulated)']);
    await c.query('select tab.bind_print_device($1, $2, $3, $4)', [chain, 'TEST-PRN-MUT', SERIAL, 'PRINTER']);
  });
  gw = await fakeGateway(sbx);
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await gw?.close();
  await sbx?.close();
});

describe('packaging line completion, rule by rule (tablets 1230)', () => {
  it('[PR-16] a label specimen\'s note is 1 to 500 characters, one item\'s specimen does not stand for another\'s, and each withdrawal is its own specimen\'s', async () => {
    twoItems = await run([packPhase('p-g21', 'G-21', LINE_CFG(['CARTON', 'LEAFLET']))]);
    const r = twoItems;
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    const leaflet = await label(r, 'LEAFLET', null);
    expect(leaflet).toMatch(UUID);
    expect(await label(r, 'CARTON', '   ')).toMatch(/EBMR-LBL-035 a specimen note is 1 to 500 characters/);
    expect(await label(r, 'CARTON', 'x'.repeat(501))).toMatch(/EBMR-LBL-035 /);
    const carton = await label(r, 'CARTON', 'x'.repeat(500));
    expect(carton).toMatch(UUID);
    // Withdrawals: an unknown specimen, a reason at its 2000-character limit, the same specimen twice, then another one.
    const nowhere = randomUUID();
    expect(await voidSpecimen(r, nowhere, 'not there')).toMatch(new RegExp(`EBMR-LBL-037 ${nowhere} is no packaging specimen`));
    expect(await voidSpecimen(r, carton, 'y'.repeat(2001))).toMatch(/EBMR-LBL-037 a specimen is withdrawn with its reason/);
    expect(await voidSpecimen(r, carton, 'y'.repeat(2000))).toBe(r.d.runId);
    expect(await voidSpecimen(r, carton, 'again')).toMatch(/EBMR-LBL-037 the specimen is withdrawn already/);
    expect(await voidSpecimen(r, leaflet, 'photograph unreadable')).toBe(r.d.runId);
    expect(await r.sql<string>('select count(*)::text as r from tab.packaging_specimen_void where batch_id = $1', [r.d.runId])).toBe('2');
    expect(await label(r, 'CARTON', null)).toMatch(UUID);
  });

  it('[PR-39] CUT_LABEL with the 100 % electronic option qualifies for the waiver; an item is judged on its own declaration', async () => {
    const r = twoItems;
    const waive = (item: string) => r.op<string>('qa1', 'select tab.enable_reconciliation_waiver($1, $2, $3, $4) as r', [r.d.runId, 'p-g21@', item, 'CAM']);
    // Declared without a label template: the step's print job carries the line's layout, no template rule applies.
    await declare(r, 'CARTON', 'CUT_LABEL', 'ELECTRONIC_100');
    twoItemsJob = await loadedJob(r);
    expect((await event('CHALLENGE_RESULT', 'PASS', twoItemsJob)).status).toBe(200);
    // The step codes on the line (a printer, no coded item): each malformed coding specimen alone is refused, then start,
    // middle and end are recorded; the step still lacks LEAFLET's label specimen (CARTON's does not stand for it).
    const coded = (await r.sql<Json>("select tab.g21_expected_coding($1, 'p-g21@') as r", [r.d.runId])) ?? {};
    const spec = (position: string, c: unknown) => r.op<string>('operator1', 'select tab.record_coding_specimen($1, $2, $3, $4::jsonb) as r', [r.d.runId, 'p-g21@', position, JSON.stringify(c)]);
    for (const [position, c] of [['FIRST', coded], ['START', [coded]], ['START', { ...coded, batch: 5 }], ['START', { ...coded, batch: '' }], ['START', { ...coded, batch: 'b'.repeat(65) }]] as const) {
      expect(await spec(position, c)).toMatch(/EBMR-LBL-035 a coding specimen is/);
    }
    for (const position of ['START', 'MIDDLE', 'END']) expect(await spec(position, coded)).toMatch(UUID);
    expect(await r.sql<string>("select tab.g21_specimen_problem($1, 'p-g21@') as r", [r.d.runId])).toBe('step p-g21@ has no label specimen of item LEAFLET (PR-16)');
    // Coding applies on a printer or a coded item, never on a vision system alone.
    const applies = async (cfg: Json): Promise<boolean | null> => (await r.sql<boolean>('select tab.g21_coding_applies($1::jsonb) as r', [JSON.stringify(cfg)]));
    expect(await applies({ devices: [{ id: 'CAM', kind: 'VISION' }], items: [ITEM('CARTON')] })).toBe(false);
    expect(await applies({ devices: [{ id: 'CODER', kind: 'PRINTER' }], items: [ITEM('CARTON')] })).toBe(true);
    expect(await applies({ devices: [], items: [{ ...ITEM('CARTON'), coded: true }] })).toBe(true);
    expect(await waive('LEAFLET')).toMatch(/EBMR-LBL-048 item LEAFLET is not declared/);
    expect(await waive('CARTON')).toMatch(UUID);
    // The job's vision rejection opens a line stop, left open for the next test.
    expect((await event('FAULT', 'EXPIRY_REJECTED', twoItemsJob)).status).toBe(200);
    expect(await stopsOf(r)).toBe('1');
  });

  it('[PR-36] a rejection opens a stop while another order\'s stop is open, and again after its own stop was resolved; a stop is resolved by id with a reason of up to 2000 characters', async () => {
    other = await run([packPhase('p-g21', 'G-21', LINE_CFG(['CARTON']))]);
    const r = other;
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    const job = await loadedJob(r);
    expect((await event('FAULT', 'EXPIRY_REJECTED', job)).status).toBe(200);
    expect(await stopsOf(r)).toBe('1');
    expect(await stopsOf(twoItems)).toBe('1');
    const nowhere = randomUUID();
    expect(await r.op('qa1', 'select tab.resolve_line_stop($1, $2) as r', [nowhere, 'what stop'])).toMatch(new RegExp(`EBMR-LBL-045 ${nowhere} is no line stop`));
    const stop = (await r.sql<string>('select id::text as r from tab.line_stop where batch_id = $1', [r.d.runId])) ?? '';
    expect(await r.op('qa1', 'select tab.resolve_line_stop($1, $2) as r', [stop, 'z'.repeat(2001)])).toMatch(/EBMR-LBL-046 /);
    expect(await r.op('qa1', 'select tab.resolve_line_stop($1, $2) as r', [stop, 'z'.repeat(2000)])).toBe(r.d.runId);
    // The same job rejects again: a new stop, though the job has a resolved one.
    expect((await event('FAULT', 'LINE_STOPPED', job)).status).toBe(200);
    expect(await stopsOf(r)).toBe('2');
    expect(await r.sql<string>("select count(*)::text as r from tab.line_stop s where s.batch_id = $1 and not exists (select 1 from tab.line_stop_resolution x where x.stop_id = s.id)", [r.d.runId])).toBe('1');
  });

  it('[PR-34] the post-use inspection: only of an order with a printed-materials step, each malformed answer or note alone refused, and verified only as the order\'s latest', async () => {
    const checks = { noPrintedMaterial: true, noProduct: true, noDocuments: true, lineClean: true };
    // An order without a printed-materials step has no post-use inspection.
    const plain = await run([packPhase('p-destroy', 'G-23', {}, { signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } } })]);
    expect(await plain.op('operator1', 'select tab.record_post_use_inspection($1, $2::jsonb, null) as r', [plain.d.runId, JSON.stringify(checks)])).toMatch(/EBMR-LBL-040 /);
    expect(await plain.sql<string>('select count(*)::text as r from tab.post_use_inspection where batch_id = $1', [plain.d.runId])).toBe('0');
    const r = await run([packPhase('p-g21', 'G-21', { items: [ITEM('CARTON')] })]);
    const inspect = (c: unknown, note: string | null = null) =>
      r.op<string>('operator1', 'select tab.record_post_use_inspection($1, $2::jsonb, $3) as r', [r.d.runId, JSON.stringify(c), note]);
    const verify = (id: string) => r.op<string>('verifier1', 'select tab.verify_post_use_inspection($1) as r', [id]);
    expect(await inspect(checks)).toMatch(/EBMR-LBL-041 /);
    await r.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-g21@' });
    expect(await r.rec.record('p-g21', issueEntry)).toBe('ok');
    expect(await r.rec.record('p-g21', reconcile)).toBe('ok');
    expect(await label(r, 'CARTON', null)).toMatch(UUID);
    expect(await signed(r.d, 'operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-g21@' })).toBe('ok');
    expect(await signed(r.d, 'verifier1', { type: 'VERIFY', stepKey: 'p-g21@', meaning: 'VERIFIED' })).toBe('ok');
    expect((await stateOf(sbx, r.d.runId)).steps['p-g21@']?.['status']).toBe('COMPLETED');
    for (const [c, note] of [
      [{ ...checks, extra: true }, null],
      [{ ...checks, lineClean: 'yes' }, null],
      [checks, '   '],
      [checks, 'n'.repeat(1001)],
    ] as const) {
      expect(await inspect(c, note)).toMatch(/EBMR-LBL-042 /);
    }
    const first = await inspect(checks, 'n'.repeat(1000));
    expect(first).toMatch(UUID);
    expect(await r.sql<string>('select length(note)::text as r from tab.post_use_inspection where id = $1', [first])).toBe('1000');
    const nowhere = randomUUID();
    expect(await verify(nowhere)).toMatch(new RegExp(`EBMR-LBL-043 ${nowhere} is no post-use inspection`));
    const latest = await inspect(checks, 'line cleared again after a spill');
    expect(latest).toMatch(UUID);
    expect(await verify(first)).toMatch(/EBMR-LBL-043 a later post-use inspection of the order stands/);
    // Another order inspected later (arranged): it does not stand in the way of this order's latest.
    const c = await sbx.db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query(
        `insert into tab.post_use_inspection (batch_id, checks, passed, note, recorded_by_person, recorded_by_account, correlation_id)
         values ($1, $2::jsonb, true, null, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
        [other.d.runId, JSON.stringify(checks)],
      );
      await c.query('commit');
    } finally {
      c.release();
    }
    expect(await verify(latest)).toBe(r.d.runId);
    expect(await r.sql<string>('select tab.packaging_completion_problem($1) as r', [r.d.runId])).toBeNull();
  });
});
