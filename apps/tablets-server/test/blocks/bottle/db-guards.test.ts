/**
 * Phase 3 slice 4b (builder B): the packaging-line blocks' rules held by the database (tablets 0985 to 0987), proven as
 * the application role past the server: an honest entry the engine builds is stored; the same act through a tampered
 * block handler (a forged engine: a rule skipped, a verdict or a computed value changed, an exception dropped) is refused
 * by the database alone. Checks and challenges hold the line unit's containers through the slice 1 container command
 * (plant.record_ipc_check). Rules about the MBR and about closing a step are read through their functions on the run's
 * real state and content, forged where the test says so.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import { BOTTLE_BLOCK_VERSIONS, TB23, TB24 } from '../../../src/blocks/bottle/index.ts';
import { actorOfBrowser } from '../../esig/support.ts';
import { codeOf } from '../../execution/db-guards-support.ts';
import { importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../../execution/support.ts';
import { fakeTimers, lastEntry, laxEntry, recorder, stateOf, tamperHandler, type Entry } from '../granulation/db-support.ts';
import { openPersonaSession, openServiceSession } from '@ebmr/test-kit';
import { recordIpcOverdue } from '../../../src/features/execution/sweeper.ts';
import { occupiedLine } from '../blister/db-support.ts';
import { asSetup } from '../compression/plant-support.ts';
import { BOTTLE_UNIT, BOTTLE_UNIT_2, CARTON_ARTWORK_SET, CARTON_UNIT, LABEL_ARTWORK_SET, lineMbr, lineUnits, PREFIX, TESTER, torqueTester } from './db-support.ts';

type Json = Record<string, unknown>;
let sbx: ExecServer;
let d: RunDriver;
let rec: ReturnType<typeof recorder>;
let me = '';
let batchNumber = '';
let product = '';

const advance = (): void => {
  vi.advanceTimersByTime(7_000);
};
const as = async (persona = 'operator1'): Promise<ActorContext> => {
  advance();
  return actorOfBrowser(sbx, d.browser(persona), persona);
};
async function asOp<T = Json>(text: string, params: unknown[], persona = 'operator1'): Promise<T> {
  return withCommand(sbx.db.app, await as(persona), async (c) => (await c.query<{ r: T }>(text, params)).rows[0]?.r as T);
}
async function sql<T>(text: string, params: unknown[] = []): Promise<T | null> {
  return (await sbx.db.admin.query<{ r: T | null }>(text, params)).rows[0]?.r ?? null;
}
/** The database's answer for an entry: 'ok', or the EBMR code and the block rule code it names. */
async function verdict(step: string, entry: Entry, opts: Parameters<typeof rec.message>[2] = {}): Promise<string> {
  const m = await rec.message(step, entry, opts);
  if (m === 'ok') return m;
  const code = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(m)?.[1] ?? '?';
  const rule = /\((?:[^()]*; )?((?:TB2[34]|G21)-[A-Z0-9-]+)[;)]/.exec(m)?.[1] ?? /((?:TB2[34]|G21)-[A-Z0-9-]+)/.exec(m)?.[1];
  return rule ? `${code} ${rule}` : `${code} ${m.slice(0, 400)}`;
}
const content = async (): Promise<Json> => (await sql<Json>('select recipe.batch_mbr_content($1) as r', [d.runId])) ?? {};
const dataOf = async (key: string, kind: string): Promise<Json> => ((await stateOf(sbx, d.runId)).entries[await lastEntry(sbx, d.runId, key, kind)]?.['data'] ?? {}) as Json;
const types = async (key: string): Promise<string[]> =>
  Object.values((await stateOf(sbx, d.runId)).exceptions).filter((e) => (e['source'] as Json)['stepKey'] === key).map((e) => String(e['type'])).sort();
const checks = async (unit: string): Promise<string[][]> =>
  (await sbx.db.admin.query<{ s: string; r: string }>("select coalesce(stream, '-') as s, result as r from plant.ipc_check where batch_id = $1 and press_code = $2 order by recorded_at, id", [d.runId, unit])).rows.map((r) => [r.s, r.r]);
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A master-data command as the data steward. */
async function asSteward<T = Json>(text: string, params: unknown[]): Promise<T> {
  const steward = await openPersonaSession(sbx.db, sbx.seed, 'steward');
  return withCommand(sbx.db.app, { ...steward, correlationId: randomUUID() }, async (c) => (await c.query<{ r: T }>(text, params)).rows[0]?.r as T);
}
const open = (unit: string) => asOp<{ container_id: string; version: number; label_code: string }>('select plant.open_container($1, $2, $3, $4) as r', [d.runId, 'PACKAGING', 'kg', unit]);
const held = (c: { container_id: string }) => sql<number>('select count(*)::int as r from plant.container_hold where container_id = $1', [c.container_id]);
/** The refusal of a signed act, or 'ok'. */
async function signedOutcome(persona: string, intent: Parameters<RunDriver['sign']>[1]): Promise<string> {
  const r = await d.sign(persona, intent);
  if (r.result.ok) return 'ok';
  return JSON.stringify(r.result.error.kind === 'REFUSAL' ? r.result.error.envelope.refusal : r.result.error);
}
const us = (v: unknown): bigint => {
  const u = (v as Json | undefined)?.['$u'];
  return typeof u === 'string' ? BigInt(u) : 0n;
};
/** State `st` with step `key` closed (AWAITING_VERIFICATION) at its last entry's time plus `laterUs`, then `edit` applied. */
function closingOf(st: Json, key: string, laterUs = 0n, edit: (x: Json) => void = () => undefined): Json {
  const x = structuredClone(st);
  const step = (x['steps'] as Json)[key] as Json;
  step['status'] = 'AWAITING_VERIFICATION';
  step['endedAt'] = { $u: String(Object.values(x['entries'] as Record<string, Json>).map((e) => us(e['recordedAt'])).reduce((a, b) => (a > b ? a : b), 0n) + laterUs) };
  edit(x);
  return x;
}
const closeProblem = async (st: Json, x: Json): Promise<string | null> => sql<string>('select tab.packline_close_problem($1, $2, $3) as r', [await content(), st, x]);
/** The honest engine's result for step `step` of `block` without exception types `drop` (or with its data changed). */
function quiet(step: string, block: typeof TB23, drop: string[], data: (x: Json) => Json = (x) => x) {
  return tamperHandler(step, {
    acceptEntry: (view, entry) => {
      const r = block.handler?.acceptEntry?.(view, entry);
      if (!r?.ok) throw new Error(`SETUP: the honest engine refused: ${JSON.stringify(r)}`);
      return { ...r, data: data(r.data), exceptions: (r.exceptions ?? []).filter((e) => !drop.includes(e.type)) };
    },
  });
}

beforeAll(async () => {
  sbx = await startExecServer();
  fakeTimers();
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, lineMbr()), undefined, {}, ['IN', 'US']);
  d = new RunDriver(sbx, runId, {
    issuer,
    steward: await sbx.asPersona('steward'),
    operator1: await sbx.asPersona('operator1'),
    operator2: await sbx.asPersona('operator2', 'TEST-KIOSK-DISP-1'),
    verifier1: await sbx.asPersona('verifier1'),
    supervisor1: await sbx.asPersona('supervisor1'),
    qa1: await sbx.asPersona('qa1'),
  });
  d.beforeTap = advance;
  rec = recorder(sbx, d, advance);
  batchNumber = (await sql<string>('select batch_number as r from recipe.batch_execution where id = $1', [runId])) ?? '';
  product = String((((await content())['header'] as Json)['product'] as Json)['code']);
  me = personaIn(sbx, 'operator1').personId;
  await lineUnits(sbx, runId, [BOTTLE_UNIT, CARTON_UNIT, BOTTLE_UNIT_2]);
  await torqueTester(sbx);
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb23@' });
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb24@' });
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

describe('the packaging-line blocks in the database (tablets 0985 to 0987)', () => {
  it('[DI-30][DI-05] the database holds the data schemas of TB-23 and TB-24 as the block registry declares them (CHALLENGE as G-21\'s), their block types and rule codes; nothing can change them, and the application role writes no register row directly', async () => {
    const { rows } = await sbx.db.admin.query<{ k: string; schema: Json }>("select block_type || '@' || block_version || ' ' || entry_kind as k, schema from recipe.block_data_schema where block_type in ('TB-23', 'TB-24')");
    const want: Record<string, Json> = {};
    for (const b of BOTTLE_BLOCK_VERSIONS) for (const [k, s] of Object.entries(b.dataSchema?.entries ?? {})) want[`${b.type}@${b.version} ${k}`] = schemaJson(s as unknown as { type: string } & Json);
    expect(Object.fromEntries(rows.map((r) => [r.k, r.schema]))).toEqual(want);
    expect(want['TB-23@1 CHALLENGE']).toEqual(await sql<Json>("select schema as r from recipe.block_data_schema where block_type = 'G-21' and entry_kind = 'CHALLENGE'"));
    const files = ['tb-23.ts', 'tb-24.ts', 'bottle/common.ts'].map((f) => readFileSync(new URL(`../../../src/blocks/${f}`, import.meta.url), 'utf8')).join('\n');
    const codes = [...new Set([...files.matchAll(/'(TB(?:23|24)(?:-[A-Z0-9]+)+)'/g)].map((m) => m[1] ?? ''))];
    const named = (await sbx.db.admin.query<{ name: string }>("select name from recipe.engine_name where name ~ '^TB(23|24)' or name in ('TB-23', 'TB-24')")).rows.map((r) => r.name);
    expect(codes.filter((c) => !named.includes(c))).toEqual([]);
    expect(named).toEqual(expect.arrayContaining(['TB-23', 'TB-24', 'TB23-TESTER', 'TB23-NO-CHECK', 'TB24-SSCC-ISSUE', 'TB24-NOT-APPROVED', 'TB24-AGGREGATION']));
    await expect(sbx.db.admin.query("update recipe.block_data_schema set schema = '{\"type\": \"object\", \"fields\": {}}' where block_type = 'TB-23'")).rejects.toThrow(/EBMR-AUDIT-004/);
    await expect(sbx.db.app.query("insert into tab.sscc_issue (sscc, prefix, serial_ref, batch_id, step_key, person_id, account_id) values ('089012345000000019', '089012345', 1, $1, 'p-tb24@', $2, $2)", [d.runId, randomUUID()])).rejects.toThrow(/permission denied/);
  });

  it('[DI-17][DI-18] the new functions pin their search path with pg_temp last and belong to the owner; the application role executes only the SSCC issue', async () => {
    const { rows } = await sbx.db.admin.query<{ f: string; cfg: string[] | null; owner: string; app: boolean }>(
      `select p.oid::regprocedure::text as f, p.proconfig as cfg, pg_get_userbyid(p.proowner) as owner, has_function_privilege('ebmr_app', p.oid, 'execute') as app
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'tab' and (p.proname like 'packline\\_%' or p.proname like 'bottle\\_%' or p.proname like 'pack\\_%' or p.proname in ('gs1_check_ok', 'issue_sscc'))`);
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const r of rows) {
      expect(r.owner, r.f).toBe('ebmr_owner');
      expect(r.cfg?.find((c) => c.startsWith('search_path=')), r.f).toMatch(/pg_temp$/);
    }
    expect(rows.filter((r) => r.app).map((r) => r.f)).toEqual(['tab.issue_sscc(uuid,text)']);
  });

  it('[IN-17][INV-32][IN-22][PR-41][PR-42] the database accepts only an MBR whose bottle line names the G-21 step of its roll labels, whose cartoning names a G-21 step, whose packaging units are all different, and which checks the tamper-evident feature of a US OTC retail pack and the anti-tampering device of an EU pack', async () => {
    const c = await content();
    const problem = (edit: (x: Json) => void) => {
      const x = structuredClone(c);
      edit(x);
      return sql<string>('select tab.packline_mbr_problem($1) as r', [x]);
    };
    const phaseIn = (x: Json, id: string): Json => findPhase(x, id) as Json;
    expect(await sql<string>('select tab.packline_mbr_problem($1) as r', [c])).toBeNull();
    expect(await problem((x) => ((phaseIn(x, 'p-tb23')['config'] as Json)['labelItem'] = 'CARTON'))).toMatch(/TB23-LABEL-STEP/);
    expect(await problem((x) => ((phaseIn(x, 'p-tb23')['config'] as Json)['labelStep'] = 'p-tb24'))).toMatch(/TB23-LABEL-STEP/);
    expect(await problem((x) => ((phaseIn(x, 'p-tb24')['config'] as Json)['printedStep'] = 'p-lbl-x'))).toMatch(/TB24-PRINTED-STEP/);
    expect(await problem((x) => ((phaseIn(x, 'p-prt')['config'] as Json)['unit'] = CARTON_UNIT))).toMatch(/TB23-UNIT/);
    expect(await problem((x) => ((x['header'] as Json)['predicates'] = { usOtcRetail: true }))).toMatch(/TB23-TAMPER-EVIDENT/);
    expect(await problem((x) => {
      (x['header'] as Json)['predicates'] = { usOtcRetail: true };
      (phaseIn(x, 'p-tb23')['config'] as Json)['tamperEvident'] = true;
    })).toBeNull();
    expect(await problem((x) => ((x['header'] as Json)['marketSet'] = ['IN', 'EU']))).toMatch(/TB24-ATD-REQUIRED/);
  });

  it('[PR-34][PR-35][IN-38] review 4b: a TB-23 or TB-24 entry is stored only on a line occupied now by this batch\'s packaging order, on a passed and verified clearance for it and for the artwork set its G-21 step names; a potent product only on a line flagged isolated', async () => {
    const rej: Entry = { kind: 'REJECTS', reason: 'OTHER', bottles: '1' };
    const cw: Entry = { kind: 'CHALLENGE', device: 'CW', trigger: 'START', result: 'PASS' };
    expect(await verdict('p-tb23', rej)).toMatch(/^EBMR-TAB-384 .*TB23-LINE/s);
    expect(await verdict('p-tb24', cw)).toMatch(/^EBMR-TAB-384 .*TB24-LINE/s);
    await occupiedLine(sbx, d.runId, BOTTLE_UNIT, batchNumber, 'ROLL-LABEL:ART-0');
    expect(await rec.message('p-tb23', rej)).toMatch(/cleared for artwork set ROLL-LABEL:ART-0, not ROLL-LABEL:ART-1 \(TB23-LINE.*EBMR-TAB-384/s);
    await occupiedLine(sbx, d.runId, CARTON_UNIT, batchNumber, CARTON_ARTWORK_SET, 'TEST-ORDER-OTHER');
    expect(await rec.message('p-tb24', cw)).toMatch(/passed and verified clearance.*TB24-LINE.*EBMR-TAB-384/s);
    const line = await occupiedLine(sbx, d.runId, BOTTLE_UNIT, batchNumber, LABEL_ARTWORK_SET);
    const cartons = await occupiedLine(sbx, d.runId, CARTON_UNIT, batchNumber, CARTON_ARTWORK_SET);
    // A potent product (plant product list, as TB-21 reads it): only on an isolated line.
    await asSetup(sbx, 'update plant.product set highly_potent = true where code = $1', [product]);
    expect(await verdict('p-tb23', rej)).toMatch(/^EBMR-TAB-384 .*TB23-ISOLATION/s);
    await asSteward('select tab.record_line_isolation($1, true, $2) as r', [line, 'QUAL-LINE-ISO-BTL']);
    expect(await verdict('p-tb23', rej)).toBe('ok');
    expect(await verdict('p-tb24', cw)).toMatch(/^EBMR-TAB-384 .*TB24-ISOLATION/s);
    await asSetup(sbx, 'update plant.product set highly_potent = false where code = $1', [product]);
    expect(await verdict('p-tb24', cw)).toBe('ok');
    void cartons;
  });

  it('[PR-37][IN-22] TB-23 checks are judged by the database (a forged pass or a dropped exception is refused); a failing check holds every container of the bottle line since its stream\'s last passing check; a PASS on the line is recorded only from a passing entry of its step, once; a torque check needs a tester in use for the batch', async () => {
    const box = await open(BOTTLE_UNIT);
    const bad: Entry = { kind: 'COUNT_CHECK', counts: ['30', '29'] };
    expect(await verdict('p-tb23', bad, { tamper: quiet('p-tb23', TB23, [], (x) => ({ ...x, result: 'PASS' })) })).toMatch(/^EBMR-TAB-380 .*result/s);
    expect(await verdict('p-tb23', bad, { tamper: quiet('p-tb23', TB23, ['LINE_CHECK_FAILED']) })).toMatch(/^EBMR-TAB-380 .*LINE_CHECK_FAILED/s);
    expect(await verdict('p-tb23', bad)).toBe('ok');
    expect(await dataOf('p-tb23@', 'COUNT_CHECK')).toEqual({ stream: 'COUNT', counts: ['30', '29'], expected: '30', result: 'FAIL', missed: false, checkedBy: me });
    expect(await held(box)).toBe(1);
    expect(await checks(BOTTLE_UNIT)).toEqual([['COUNT', 'FAIL']]);
    // A direct PASS of the line by the application role, or a second record of the same entry, is refused.
    expect(await codeOf(asOp("select plant.record_ipc_check($1, $2, 'COUNT', 'PASS', 'operator says so') as r", [d.runId, BOTTLE_UNIT]))).toBe('EBMR-TAB-382');
    expect(await verdict('p-tb23', { kind: 'COUNT_CHECK', counts: ['30', '30'] })).toBe('ok');
    const ref = `TB23:p-tb23@:${await lastEntry(sbx, d.runId, 'p-tb23@', 'COUNT_CHECK')}`;
    expect(await codeOf(asOp("select plant.record_ipc_check($1, $2, 'COUNT', 'PASS', $3) as r", [d.runId, BOTTLE_UNIT, ref]))).toBe('EBMR-TAB-382');
    expect(await checks(BOTTLE_UNIT)).toEqual([['COUNT', 'FAIL'], ['COUNT', 'PASS']]);
    // The torque tester: refused without a use for the batch, recorded with one; out of limits fails.
    const torque: Entry = { kind: 'TORQUE_CHECK', tester: TESTER, application: ['2.0'], removal: ['2.3'] };
    expect(await verdict('p-tb23', torque)).toBe('EBMR-TAB-380 TB23-TESTER');
    await asOp("select plant.record_instrument_check($1, 'PASS', 'Torque tester per-use check', $2::uuid) as r", [TESTER, d.runId]);
    await asOp("select plant.record_instrument_use($1, $2::uuid, clock_timestamp() + interval '8 hours') as r", [TESTER, d.runId]);
    expect(await verdict('p-tb23', torque, { tamper: quiet('p-tb23', TB23, ['LINE_CHECK_FAILED'], (x) => ({ ...x, result: 'PASS' })) })).toMatch(/^EBMR-TAB-380 /);
    expect(await verdict('p-tb23', torque)).toBe('ok');
    expect(await types('p-tb23@')).toEqual(['LINE_CHECK_FAILED', 'LINE_CHECK_FAILED']);
    // PR-41: a seal check of a pack that is not tamper-evident states no labelling statement check (forged engine refused).
    expect(await verdict('p-tb23', { kind: 'SEAL_CHECK', examined: '10', defective: '0', statementChecked: true }, { tamper: laxEntry('p-tb23', { stream: 'SEAL', examined: '10', defective: '0', statementChecked: true, result: 'PASS', missed: false, checkedBy: me }) }))
      .toBe('EBMR-TAB-380 TB23-TAMPER-EVIDENT');
  });

  it('[IN-22][PR-37] a TB-23 device challenge is G-21\'s: a failed one is stored only with CHALLENGE_FAILED that stops the step for QA, holds the line\'s output since the device\'s last passing challenge, needs a second person, and no output is counted until a passing one', async () => {
    expect(await verdict('p-tb23', { kind: 'CHALLENGE', device: 'SEALDET', trigger: 'START', result: 'PASS' }, { tamper: laxEntry('p-tb23', { device: 'SEALDET', trigger: 'START', result: 'PASS', missed: false, challengedBy: me }) }))
      .toMatch(/^EBMR-TAB-380 .*second person/s);
    expect(await verdict('p-tb23', { kind: 'CHALLENGE', device: 'SEALDET', trigger: 'START', result: 'PASS' })).toBe('ok');
    const box = await open(BOTTLE_UNIT);
    const fail: Entry = { kind: 'CHALLENGE', device: 'SEALDET', trigger: 'INTERVAL', result: 'FAIL' };
    expect(await verdict('p-tb23', fail, { tamper: quiet('p-tb23', TB23, ['CHALLENGE_FAILED']) })).toMatch(/^EBMR-TAB-380 .*CHALLENGE_FAILED/s);
    expect(await verdict('p-tb23', fail)).toBe('ok');
    expect(await held(box)).toBe(1);
    expect((await checks(BOTTLE_UNIT)).filter((x) => x[0] === 'D.SEALDET')).toEqual([['D.SEALDET', 'PASS'], ['D.SEALDET', 'FAIL']]);
    // A forged engine that counts output while the device's last challenge failed is refused.
    expect(await verdict('p-tb23', { kind: 'GOOD_OUTPUT', bottles: '100' }, { tamper: laxEntry('p-tb23', { bottles: '100', recordedBy: me }) })).toBe('EBMR-TAB-380 TB23-STOPPED');
    expect(await verdict('p-tb23', { kind: 'CHALLENGE', device: 'SEALDET', trigger: 'INTERVAL', result: 'PASS' })).toBe('ok');
  });

  it('[PR-38] bright stock is identified by the record (product, strength, batch, bottles) and labelled back only by the scan of this batch and product, never more than is left: a forged engine is refused', async () => {
    expect(await verdict('p-tb23', { kind: 'BRIGHT_STOCK', bottles: '120' }, { tamper: quiet('p-tb23', TB23, [], (x) => ({ ...x, batch: 'TEST-B-OTHER' })) })).toMatch(/^EBMR-TAB-380 .*batch/s);
    expect(await verdict('p-tb23', { kind: 'BRIGHT_STOCK', bottles: '120' })).toBe('ok');
    expect(await dataOf('p-tb23@', 'BRIGHT_STOCK')).toMatchObject({ tag: '1', bottles: '120', batch: batchNumber, product: { code: product }, countPerBottle: '30' });
    const use = (over: Json): Entry => ({ kind: 'BRIGHT_STOCK_USE', tag: '1', scannedBatch: batchNumber, scannedProduct: product, bottles: '120', ...over });
    const lax = (e: Entry) => laxEntry('p-tb23', { tag: e['tag'], bottles: e['bottles'], scannedBatch: e['scannedBatch'], scannedProduct: e['scannedProduct'], usedBy: me });
    expect(await verdict('p-tb23', use({ scannedBatch: 'TEST-B-OTHER' }), { tamper: lax(use({ scannedBatch: 'TEST-B-OTHER' })) })).toBe('EBMR-TAB-380 TB23-BRIGHT-STOCK-SCAN');
    expect(await verdict('p-tb23', use({ bottles: '121' }), { tamper: lax(use({ bottles: '121' })) })).toBe('EBMR-TAB-380 TB23-BRIGHT-STOCK-QUANTITY');
    expect(await verdict('p-tb23', use({}))).toBe('ok');
  });

  it('[PR-37][IN-17][PR-38] a TB-23 step closes only with every stream\'s last check passing and none due, its devices\' START and END challenges, its good output and no bright stock left (read on the run\'s state)', async () => {
    const st = await stateOf(sbx, d.runId);
    expect(await closeProblem(st, closingOf(st, 'p-tb23@'))).toMatch(/DESICCANT stream has no check \(TB23-NO-CHECK\)/);
    expect(await verdict('p-tb23', { kind: 'DESICCANT_CHECK', examined: '10', missing: '0' })).toBe('ok');
    expect(await verdict('p-tb23', { kind: 'TORQUE_CHECK', tester: TESTER, application: ['2.0'], removal: ['1.5'] })).toBe('ok');
    expect(await verdict('p-tb23', { kind: 'SEAL_CHECK', examined: '10', defective: '0' })).toBe('ok');
    const st2 = await stateOf(sbx, d.runId);
    expect(await closeProblem(st2, closingOf(st2, 'p-tb23@'))).toMatch(/device SEALDET has no passing end challenge/);
    expect(await verdict('p-tb23', { kind: 'CHALLENGE', device: 'SEALDET', trigger: 'END', result: 'PASS' })).toBe('ok');
    const st3 = await stateOf(sbx, d.runId);
    expect(await closeProblem(st3, closingOf(st3, 'p-tb23@'))).toMatch(/TB23-NO-OUTPUT/);
    expect(await verdict('p-tb23', { kind: 'GOOD_OUTPUT', bottles: '9000' })).toBe('ok');
    const st4 = await stateOf(sbx, d.runId);
    expect(await closeProblem(st4, closingOf(st4, 'p-tb23@'))).toBeNull();
    expect(await closeProblem(st4, closingOf(st4, 'p-tb23@', 31n * 60_000_000n))).toMatch(/TB23-CHECK-DUE/);
    // A bright stock tag left unlabelled keeps it open.
    expect(await closeProblem(st4, closingOf(st4, 'p-tb23@', 0n, (x) => {
      const e = Object.values(x['entries'] as Record<string, Json>).find((y) => y['kind'] === 'BRIGHT_STOCK_USE') as Json;
      (e['data'] as Json)['bottles'] = '100';
    }))).toMatch(/TB23-BRIGHT-STOCK-OPEN/);
    // The honest close through the server: QA decides the failed challenge, then the step is performed and verified.
    for (const [id] of Object.entries((await stateOf(sbx, d.runId)).exceptions).filter(([, e]) => e['type'] === 'CHALLENGE_FAILED' && (e['source'] as Json)['stepKey'] === 'p-tb23@')) {
      await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: id, outcome: 'NO_IMPACT', justification: 'Seal detector re-challenged and passed; the held bottles were re-inspected.' });
    }
    expect(await signedOutcome('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-tb23@' })).toBe('ok');
    expect(await signedOutcome('verifier1', { type: 'VERIFY', stepKey: 'p-tb23@', meaning: 'VERIFIED' })).toBe('ok');
    expect((await stateOf(sbx, d.runId)).steps['p-tb23@']?.['status']).toBe('COMPLETED');
  });

  it('[PR-42][PR-37] a shipper is labelled from the record under an SSCC the register issued for this batch and step, once; an SSCC typed by hand, another step\'s or a forged label is refused', async () => {
    expect(await codeOf(asOp('select tab.issue_sscc($1, $2) as r', [d.runId, 'p-tb23@']))).toBe('EBMR-TAB-383');
    const a = await asOp<{ sscc: string; prefix: string }>('select tab.issue_sscc($1, $2) as r', [d.runId, 'p-tb24@']);
    const b = await asOp<{ sscc: string }>('select tab.issue_sscc($1, $2) as r', [d.runId, 'p-tb24@']);
    expect(a.sscc).toMatch(new RegExp(`^${PREFIX}[0-9]{9}$`));
    expect(await sql<boolean>('select tab.gs1_check_ok($1) as r', [a.sscc])).toBe(true);
    expect(BigInt(b.sscc.slice(0, 17)) - BigInt(a.sscc.slice(0, 17))).toBe(1n);
    await verdict('p-tb24', { kind: 'PACKS_MADE', packs: '60' });
    const typed = ssccNotIssued(a.sscc, b.sscc);
    expect(await verdict('p-tb24', { kind: 'SHIPPER', sscc: typed, packs: '20', part: false })).toBe('EBMR-TAB-380 TB24-SSCC-ISSUE');
    expect(await verdict('p-tb24', { kind: 'SHIPPER', sscc: a.sscc, packs: '20', part: false }, { tamper: quiet('p-tb24', TB24, [], (x) => ({ ...x, label: { ...(x['label'] as Json), batch: 'TEST-B-OTHER' } })) })).toMatch(/^EBMR-TAB-380 .*label/s);
    expect(await verdict('p-tb24', { kind: 'SHIPPER', sscc: a.sscc, packs: '20', part: false })).toBe('ok');
    expect(await dataOf('p-tb24@', 'SHIPPER')).toMatchObject({ sscc: a.sscc, label: { sscc: a.sscc, batch: batchNumber, product, packs: '20' } });
    expect(await verdict('p-tb24', { kind: 'SHIPPER', sscc: b.sscc, packs: '19', part: false }, { tamper: laxEntry('p-tb24', { sscc: b.sscc, packs: '19', part: false, label: {}, labelledBy: me }) })).toBe('EBMR-TAB-380 TB24-SHIPPER-COUNT');
    expect(await verdict('p-tb24', { kind: 'SHIPPER', sscc: b.sscc, packs: '20', part: false })).toBe('ok');
  });

  it('[PR-37][IN-22] samples never return to good output, and packs of an unusual event re-enter only after the event\'s exception carries the investigation and QA\'s disposition: before that, or naming another deviation, the database refuses the re-entry', async () => {
    expect(await verdict('p-tb24', { kind: 'PACK_SAMPLE', purpose: 'QC', packs: '2' })).toBe('ok');
    const lax = (event: string, packs = '2', inspection = 'PASS') => laxEntry('p-tb24', { event, packs, inspection, investigation: 'TEST-DEV-0401', approvedBy: me }, { verificationRequired: true });
    expect(await verdict('p-tb24', { kind: 'RE_ENTRY', event: 'QC', packs: '2', inspection: 'PASS', investigation: 'TEST-DEV-0401' }, { tamper: lax('QC') })).toBe('EBMR-TAB-380 TB24-EVENT');
    expect(await verdict('p-tb24', { kind: 'SET_ASIDE', event: 'JAM', description: 'Carton jam at the infeed', packs: '6' }, { tamper: quiet('p-tb24', TB24, ['UNUSUAL_EVENT']) })).toMatch(/^EBMR-TAB-380 .*UNUSUAL_EVENT/s);
    expect(await verdict('p-tb24', { kind: 'SET_ASIDE', event: 'JAM', description: 'Carton jam at the infeed', packs: '6' })).toBe('ok');
    const re: Entry = { kind: 'RE_ENTRY', event: 'JAM', packs: '4', inspection: 'PASS', investigation: 'TEST-DEV-0401' };
    expect(await verdict('p-tb24', re)).toBe('EBMR-TAB-380 TB24-NOT-APPROVED');
    const ex = Object.entries((await stateOf(sbx, d.runId)).exceptions).find(([, e]) => e['type'] === 'UNUSUAL_EVENT')?.[0] ?? '';
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: ex, deviationRef: 'TEST-DEV-0401' });
    expect(await verdict('p-tb24', re)).toBe('EBMR-TAB-380 TB24-NOT-APPROVED');
    await d.signed('qa1', { type: 'DISPOSITION_EXCEPTION', exception: ex, outcome: 'DEVIATION_RAISED', justification: 'Packs inspected one by one; the jam damaged none.' });
    expect(await verdict('p-tb24', { ...re, investigation: 'TEST-DEV-0402' })).toBe('EBMR-TAB-380 TB24-NOT-APPROVED');
    expect(await verdict('p-tb24', { ...re, inspection: 'FAIL' }, { tamper: lax('JAM', '4', 'FAIL') })).toBe('EBMR-TAB-380 TB24-INSPECTION');
    expect(await verdict('p-tb24', re)).toBe('ok');
    expect(await dataOf('p-tb24@', 'RE_ENTRY')).toEqual({ event: 'JAM', packs: '4', inspection: 'PASS', investigation: 'TEST-DEV-0401', approvedBy: me });
  });

  it('[PR-37][IN-17][PR-42] TB-24: the examinations and the reconciliation are the database\'s (a forged verdict or balance is refused); the step closes only with an in-run and a passing end-of-run examination, the reconciliation, and shippers that hold exactly the serials the G-21 step commissioned', async () => {
    expect(await verdict('p-tb24', { kind: 'EXAMINATION', timing: 'END', examined: '20', defective: '0', labelCorrect: true }, { tamper: laxEntry('p-tb24', { stream: 'EXAM', timing: 'END', examined: '20', defective: '0', labelCorrect: true, result: 'PASS', missed: false, checkedBy: me }) }))
      .toBe('EBMR-TAB-380 TB24-NO-IN-RUN');
    const box = await open(CARTON_UNIT);
    const failing: Entry = { kind: 'EXAMINATION', timing: 'IN_RUN', examined: '5', defective: '1', labelCorrect: true };
    expect(await verdict('p-tb24', failing, { tamper: quiet('p-tb24', TB24, ['LINE_CHECK_FAILED'], (x) => ({ ...x, result: 'PASS' })) })).toMatch(/^EBMR-TAB-380 /);
    expect(await verdict('p-tb24', failing)).toBe('ok');
    expect(await held(box)).toBe(1);
    expect(await verdict('p-tb24', { kind: 'EXAMINATION', timing: 'IN_RUN', examined: '5', defective: '0', labelCorrect: true })).toBe('ok');
    expect(await verdict('p-tb24', { kind: 'EXAMINATION', timing: 'END', examined: '20', defective: '0', labelCorrect: true })).toBe('ok');
    for (const t of ['START', 'END']) expect(await verdict('p-tb24', { kind: 'CHALLENGE', device: 'CW', trigger: t, result: 'PASS' })).toBe('ok');
    // made 60, shipped 40, samples 2, set aside 6 less 4 re-entered: 16 unexplained (limit 0).
    const recon: Entry = { kind: 'RECONCILIATION' };
    const honest = { made: '60', shipped: '40', rejects: '0', samples: '2', setAside: '6', reEntered: '4', unexplained: '16', withinLimits: false, reconciledBy: me };
    expect(await verdict('p-tb24', recon, { tamper: laxEntry('p-tb24', { ...honest, unexplained: '0', withinLimits: true }) })).toMatch(/^EBMR-TAB-380 .*unexplained/s);
    expect(await verdict('p-tb24', recon, { tamper: laxEntry('p-tb24', honest) })).toMatch(/^EBMR-TAB-380 .*PACK_RECONCILIATION/s);
    const st = await stateOf(sbx, d.runId);
    expect(await closeProblem(st, closingOf(st, 'p-tb24@'))).toMatch(/TB24-NOT-RECONCILED/);
    expect(await verdict('p-tb24', recon)).toBe('ok');
    expect(await dataOf('p-tb24@', 'RECONCILIATION')).toEqual(honest);
    expect(await types('p-tb24@')).toEqual(['LINE_CHECK_FAILED', 'PACK_RECONCILIATION', 'UNUSUAL_EVENT']);
    expect(await verdict('p-tb24', { kind: 'PACKS_MADE', packs: '1' }, { tamper: laxEntry('p-tb24', { packs: '1', recordedBy: me }) })).toBe('EBMR-TAB-380 TB24-RECONCILED');
    // PR-42: the G-21 step serialises US for this batch: the shippers' 40 packs must equal its pools' commissioned serials.
    const st2 = await stateOf(sbx, d.runId);
    expect(await closeProblem(st2, closingOf(st2, 'p-tb24@'))).toMatch(/hold 40 packs, but the serial pools of p-prt commissioned none reconciled \(TB24-AGGREGATION/);
    const withPool = (commissioned: string) => closingOf(st2, 'p-tb24@', 0n, (x) => {
      (x['entries'] as Json)['EN-9001'] = { id: 'EN-9001', stepKey: 'p-prt@', kind: 'SERIAL_RECONCILIATION', recordedSeq: 9001, recordedAt: { $u: '1' }, enteredBy: me, data: { poolId: 'TEST-POOL-1', commissioned, closed: true } };
      (x['steps'] as Json)['p-prt@'] = { key: 'p-prt@', step: 'p-prt', status: 'COMPLETED' };
    });
    expect(await closeProblem(st2, withPool('39'))).toMatch(/TB24-AGGREGATION/);
    expect(await closeProblem(st2, withPool('40'))).toBeNull();
    // Through the server: the engine would close the step; the database refuses it while the pools are not reconciled.
    expect(await signedOutcome('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-tb24@' })).toMatch(/EBMR-TAB-381.*TB24-AGGREGATION|TB24-AGGREGATION.*EBMR-TAB-381/s);
    expect((await stateOf(sbx, d.runId)).steps['p-tb24@']?.['status']).toBe('IN_PROGRESS');
  });

  it('[PR-37][IN-22] review 4b: a missed periodic line check and a missed device challenge of a running bottle line are recorded by the server sweeper at database time with the MISSED hold of the line\'s containers, without any entry; the next check raises LINE_CHECK_MISSED', async () => {
    await occupiedLine(sbx, d.runId, BOTTLE_UNIT_2, batchNumber, LABEL_ARTWORK_SET);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb23m@' });
    expect(await verdict('p-tb23m', { kind: 'COUNT_CHECK', counts: ['30'] })).toBe('ok');
    expect(await verdict('p-tb23m', { kind: 'CHALLENGE', device: 'SEALDET', trigger: 'START', result: 'PASS' })).toBe('ok');
    const box = await open(BOTTLE_UNIT_2);
    await wait(3_500);
    const sweeper = { ...(await openServiceSession(sbx.db, sbx.seed, 'sweeper')), correlationId: randomUUID() };
    const alarms = (await recordIpcOverdue(sbx.built.ctx, sweeper)).filter((a) => a.batchId === d.runId && a.stepKey === 'p-tb23m@');
    expect(alarms.map((m) => [m.stream, m.test, m.held])).toEqual([['COUNT', 'LINE_CHECK', true], ['D.SEALDET', 'CHALLENGE', true]]);
    expect((await checks(BOTTLE_UNIT_2)).filter((c) => c[1] === 'MISSED')).toEqual([['COUNT', 'MISSED'], ['D.SEALDET', 'MISSED']]);
    expect(await sql<string>('select plant.container_usable_problem($1) as r', [box.container_id])).toMatch(/under a hold/);
    // Once per due time; the TB-24 step and the other TB-23 step are not due.
    expect((await recordIpcOverdue(sbx.built.ctx, sweeper)).filter((a) => a.batchId === d.runId && a.stepKey === 'p-tb23m@')).toEqual([]);
    expect(await verdict('p-tb23m', { kind: 'COUNT_CHECK', counts: ['30'] })).toBe('ok');
    expect(await types('p-tb23m@')).toEqual(['LINE_CHECK_MISSED']);
  });
});

/** A block schema as recipe.block_data_schema holds it (as recipe-core test/execution/entry-data-sql.test.ts reads it). */
function schemaJson(s: { type: string } & Json): Json {
  const o: Json = { type: s.type };
  if (s.type === 'string') {
    if (s['enum']) o['enum'] = [...(s['enum'] as string[])];
    if (s['pattern']) o['pattern'] = (s['pattern'] as RegExp).source;
  } else if (s.type === 'decimal') {
    if (s['min'] !== undefined) o['min'] = s['min'];
    if (s['minExclusive'] === true) o['minExclusive'] = true;
  } else if (s.type === 'integer') {
    if (s['min'] !== undefined) o['min'] = s['min'];
    if (s['max'] !== undefined) o['max'] = s['max'];
  } else if (s.type === 'object') {
    o['fields'] = Object.fromEntries(Object.entries(s['fields'] as Record<string, { type: string } & Json>).map(([k, f]) => [k, schemaJson(f)]));
  } else if (s.type === 'array') {
    o['items'] = schemaJson(s['items'] as { type: string } & Json);
    if (s['minItems'] !== undefined) o['minItems'] = s['minItems'];
    if (s['maxItems'] !== undefined) o['maxItems'] = s['maxItems'];
  } else if (s.type === 'record') {
    o['values'] = schemaJson(s['values'] as { type: string } & Json);
  }
  if (s['optional'] === true) o['optional'] = true;
  return o;
}

/** The phase node `id` in MBR content `x` (the object itself, to edit). */
function findPhase(x: unknown, id: string): Json | undefined {
  if (Array.isArray(x)) {
    for (const y of x) {
      const f = findPhase(y, id);
      if (f) return f;
    }
    return undefined;
  }
  if (typeof x !== 'object' || x === null) return undefined;
  const o = x as Json;
  if (o['kind'] === 'phase' && o['id'] === id) return o;
  for (const v of Object.values(o)) {
    const f = findPhase(v, id);
    if (f) return f;
  }
  return undefined;
}

/** A valid SSCC of the prefix that the register did not issue (the next after `b`, by its own check digit). */
function ssccNotIssued(_a: string, b: string): string {
  const body = (BigInt(b.slice(0, 17)) + 5n).toString().padStart(17, '0');
  for (let n = 0; n < 10; n += 1) {
    const code = body + String(n);
    let sum = 0;
    for (let i = 0; i < 17; i += 1) sum += (code.charCodeAt(16 - i) - 48) * (i % 2 === 0 ? 3 : 1);
    if ((10 - (sum % 10)) % 10 === n) return code;
  }
  return `${body}0`;
}
