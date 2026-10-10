/**
 * Phase 3 slice 4b (builder A): the blister blocks' rules held by the database (tablets 0970 to 0972), proven as the
 * application role past the server: an honest entry the engine builds is stored; the same act through a tampered block
 * handler (a forged engine: a rule skipped, a result or an exception changed) or on facts the plant and the register do
 * not hold is refused by the database alone. The defect checks and sealing values of TB-21 and the leak tests of TB-22
 * hold the machine's containers through the slice 1 container commands (plant.record_ipc_check); the missed-test timer
 * runs at database time. Rules about closing a step are read through their functions on the run's real state, forged
 * where the test says so.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import { BLISTER_TAGS } from '@ebmr/integration-sdk/process';
import { openPersonaSession, openServiceSession } from '@ebmr/test-kit';
import { BLISTER_BLOCK_VERSIONS, TB21, TB22 } from '../../../src/blocks/blister/index.ts';
import { recordIpcOverdue } from '../../../src/features/execution/sweeper.ts';
import { actorOfBrowser } from '../../esig/support.ts';
import { codeOf } from '../../execution/db-guards-support.ts';
import { importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../../execution/support.ts';
import { asSetup, cleanUnit, startUse } from '../compression/plant-support.ts';
import { fakeTimers, lastEntry, laxEntry, recorder, stateOf, tamperHandler, type Entry } from '../granulation/db-support.ts';
import { ARTWORK_SET, BLISTER_CLASS, blisterMbr, CARTON_UNIT, VISION_UNIT, FILM_MATERIAL, FOIL_ARTWORK, FOIL_MATERIAL, occupiedLine } from './db-support.ts';

type Json = Record<string, unknown>;

let sbx: ExecServer;
let d: RunDriver;
let rec: ReturnType<typeof recorder>;
let me: string;
let machine = '';
let line = '';
let batchNumber = '';

const advance = (): void => {
  vi.advanceTimersByTime(7_000);
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const as = async (persona: string): Promise<ActorContext> => {
  advance();
  return actorOfBrowser(sbx, d.browser(persona), persona);
};
async function asP<T = Json>(persona: string, text: string, params: unknown[]): Promise<T> {
  return withCommand(sbx.db.app, await as(persona), async (c) => (await c.query<{ r: T }>(text, params)).rows[0]?.r as T);
}
async function asSteward<T = Json>(text: string, params: unknown[]): Promise<T> {
  const steward = await openPersonaSession(sbx.db, sbx.seed, 'steward');
  return withCommand(sbx.db.app, { ...steward, correlationId: randomUUID() }, async (c) => (await c.query<{ r: T }>(text, params)).rows[0]?.r as T);
}
async function sql<T>(text: string, params: unknown[] = []): Promise<T | null> {
  return (await sbx.db.admin.query<{ r: T | null }>(text, params)).rows[0]?.r ?? null;
}

/** The database's answer for an entry: 'ok', or the EBMR code and the block rule code it names. */
async function verdict(step: string, entry: Entry, opts: Parameters<typeof rec.message>[2] = {}): Promise<string> {
  const m = await rec.message(step, entry, opts);
  if (m === 'ok') return m;
  const code = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(m)?.[1] ?? '?';
  const rule = /\((?:[^()]*; )?(TB2[12]-[A-Z0-9-]+)[;)]/.exec(m)?.[1];
  return rule ? `${code} ${rule}` : `${code} ${m.slice(0, 500)}`;
}

const entryData = async (key: string, kind: string): Promise<Json> => ((await stateOf(sbx, d.runId)).entries[await lastEntry(sbx, d.runId, key, kind)]?.['data'] ?? {}) as Json;
const types = async (key: string): Promise<string[]> =>
  Object.values((await stateOf(sbx, d.runId)).exceptions).filter((e) => (e['source'] as Json)['stepKey'] === key).map((e) => String(e['type'])).sort();
const checks = async (unit: string): Promise<string[][]> =>
  (await sbx.db.admin.query<{ s: string; r: string }>("select coalesce(stream, '-') as s, result as r from plant.ipc_check where batch_id = $1 and press_code = $2 order by recorded_at, id", [d.runId, unit])).rows.map((r) => [r.s, r.r]);
const open = (unit: string) => asP<{ container_id: string; version: number; label_code: string }>('operator1', 'select plant.open_container($1, $2, $3, $4) as r', [d.runId, 'BLISTERS', 'kg', unit]);
const close = (c: { container_id: string; version: number }) => asP<{ label_code: string }>('operator1', 'select plant.close_container($1, $2, $3) as r', [c.container_id, '12.500', c.version]);
const boxState = (c: { container_id: string }) => sql<string>("select state as r from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = $1", [c.container_id]);
const directPass = (unit: string, stream: string) => codeOf(asP('operator1', "select plant.record_ipc_check($1, $2, $3, 'PASS', 'operator says so') as r", [d.runId, unit, stream]));
const content = (): Promise<Json | null> => sql<Json>('select recipe.batch_mbr_content($1) as r', [d.runId]);

const reels = (film = 'TEST-PVC-1', foil = 'TEST-FOIL-1') => [{ role: 'FORMING_FILM', material: FILM_MATERIAL, lot: film }, { role: 'LIDDING_FOIL', material: FOIL_MATERIAL, lot: foil }];
const setup = (over: Json = {}): Entry => ({ kind: 'LINE_SETUP', machine, artworkSet: ARTWORK_SET, changeParts: ['FORM-TOOL-10', 'SEAL-PLATE-10'], materials: reels(), ...over });
const check = (over: Json = {}): Entry => ({ kind: 'EQUIPMENT_CHECK', rogueRemoved: true, changePartsFitted: true, emptyPocketDetector: 'PASS', ...over });
const temp = (value: string): Entry => ({ kind: 'ACTUAL', tag: 'blister.seal_temp_C', value, unit: 'degC', source: 'MANUAL' });
const defects = (n: string): Entry => ({ kind: 'DEFECT_CHECK', examined: '20', defects: n === '0' ? {} : { IMPROPER_SEAL: n } });
const leak = (track: string, leaking = '0', over: Json = {}): Entry => ({ kind: 'LEAK_TEST', track, tested: '10', vacuum: '70', holdSeconds: '45', leaking, ...over });

/** The honest engine's result without some exception types (or with its data changed): a forged engine for `step`. */
function quiet(step: string, block: typeof TB21, drop: string[], data: (x: Json) => Json = (x) => x) {
  return tamperHandler(step, {
    acceptEntry: (view, entry) => {
      const r = block.handler?.acceptEntry?.(view, entry);
      if (!r?.ok) throw new Error('SETUP: the honest engine refused');
      return { ...r, data: data(r.data), exceptions: (r.exceptions ?? []).filter((e) => !drop.includes(e.type)) };
    },
  });
}

beforeAll(async () => {
  sbx = await startExecServer();
  fakeTimers();
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, blisterMbr()));
  d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1'), steward: await sbx.asPersona('steward') });
  d.beforeTap = advance;
  rec = recorder(sbx, d, advance);
  me = personaIn(sbx, 'operator1').personId;
  batchNumber = (await sql<string>('select batch_number as r from recipe.batch_execution where id = $1', [runId])) ?? '';
  machine = (await cleanUnit(sbx, runId, BLISTER_CLASS)).code;
  await startUse(sbx, await as('operator1'), machine, runId);
  line = await occupiedLine(sbx, runId, machine, batchNumber, ARTWORK_SET);
  await withCommand(sbx.db.app, await as('steward'), async (c) => {
    for (const [code, material, status] of [['TEST-PVC-1', FILM_MATERIAL, 'RELEASED'], ['TEST-PVC-Q', FILM_MATERIAL, 'QUARANTINE'], ['TEST-FOIL-1', FOIL_MATERIAL, 'RELEASED'], ['TEST-FOIL-2', FOIL_MATERIAL, 'RELEASED']] as const) {
      await c.query('select tab.register_sandbox_lot($1::jsonb)', [JSON.stringify({ lotCode: code, materialCode: material, materialName: material, status, identityTested: true })]);
    }
    for (const code of ['TEST-FOIL-1', 'TEST-FOIL-2']) await c.query('select tab.record_lot_artwork($1, null, $2)', [code, FOIL_ARTWORK]);
  });
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

describe('the blister blocks in the database (tablets 0970 to 0972)', () => {
  it('[DI-30][DI-05] the database holds the data schemas of TB-21 and TB-22 as the block registry declares them (G-06 kinds unchanged), their block types and rule codes, the blister machine tags of the integration SDK, TB-21 as a block on a process device and the leak test in the alarm; nothing can change them', async () => {
    const { rows } = await sbx.db.admin.query<{ k: string; schema: Json }>("select block_type || '@' || block_version || ' ' || entry_kind as k, schema from recipe.block_data_schema where block_type in ('TB-21', 'TB-22')");
    const want: Record<string, Json> = {};
    for (const b of BLISTER_BLOCK_VERSIONS) for (const [k, s] of Object.entries(b.dataSchema?.entries ?? {})) want[`${b.type}@${b.version} ${k}`] = schemaJson(s as unknown as { type: string } & Json);
    expect(Object.fromEntries(rows.map((r) => [r.k, r.schema]))).toEqual(want);
    expect(want['TB-21@1 ACTUAL']).toEqual(await sql<Json>("select schema as r from recipe.block_data_schema where block_type = 'G-06' and entry_kind = 'ACTUAL'"));
    const files = ['tb-21', 'tb-22'].map((f) => readFileSync(new URL(`../../../src/blocks/${f}.ts`, import.meta.url), 'utf8')).join('\n');
    const codes = [...new Set([...files.matchAll(/'(TB2[12](?:-[A-Z0-9]+)+)'/g)].map((m) => m[1] ?? ''))];
    const named = (await sbx.db.admin.query<{ name: string }>("select name from recipe.engine_name where name ~ '^TB2[12]' or name in ('TB-21', 'TB-22')")).rows.map((r) => r.name);
    expect(codes.filter((c) => !named.includes(c))).toEqual([]);
    expect(named).toEqual(expect.arrayContaining(['TB-21', 'TB-22', 'TB21-LINE', 'TB21-ISOLATION', 'TB21-LOT', 'TB21-FOIL-NOT-ISSUED', 'TB21-NO-LINE-CHECK', 'TB22-NO-LINE-CHECK']));
    const tags = await sbx.db.admin.query<Json>('select tag, equipment_kind, unit, scale, counter, setpoint from tab.process_tag where tag = any ($1::text[]) order by tag', [BLISTER_TAGS.map((t) => t.tag)]);
    expect(tags.rows).toEqual([...BLISTER_TAGS].sort((a, b) => (a.tag < b.tag ? -1 : 1)).map((t) => ({ tag: t.tag, equipment_kind: t.equipment, unit: t.unit, scale: t.scale, counter: t.counter, setpoint: t.setpoint })));
    expect((await sbx.db.admin.query<{ t: string }>('select block_type as t from tab.process_block_type')).rows.map((r) => r.t)).toEqual(expect.arrayContaining(['G-06', 'TB-06', 'TB-21']));
    expect(await sql<string>("select pg_get_constraintdef(oid) as r from pg_constraint where conname = 'process_device_equipment_kind_check'")).toMatch(/BLENDER.*BLISTER_MACHINE.*COATER.*PRESS.*ROLLER_COMPACTOR/s);
    expect(await sql<string>("select pg_get_constraintdef(oid) as r from pg_constraint where conname = 'ipc_overdue_alarm_test_check'")).toMatch(/DISINTEGRATION.*LEAK.*RIBBON.*WEIGHT/s);
    await expect(sbx.db.admin.query("update recipe.block_data_schema set schema = '{\"type\": \"object\", \"fields\": {}}' where block_type = 'TB-22'")).rejects.toThrow(/EBMR-AUDIT-004/);
    await expect(sbx.db.admin.query("delete from tab.process_block_type where block_type = 'TB-21'")).rejects.toThrow(/EBMR-/);
  });

  it('[DI-17][DI-18] the new and replaced functions pin their search path with pg_temp last and belong to the owner; the application role executes only the line isolation writer and reader of them besides the two missed-check readers, and writes no isolation row directly', async () => {
    const { rows } = await sbx.db.admin.query<{ f: string; owner: string; config: string[] | null; pub: boolean; app: boolean }>(
      `select p.oid::regprocedure::text as f, pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
              coalesce(exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'), p.proacl is null) as pub,
              has_function_privilege('ebmr_app', p.oid, 'EXECUTE') as app
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'tab' and (p.proname ~ '^(blister|leak)_' or p.proname in ('line_isolated', 'record_line_isolation', 'ipc_pass_check', 'ipc_overdue_at', 'record_ipc_overdue'))
        order by 1`,
    );
    expect(rows.length).toBe(23);
    for (const r of rows) {
      expect(r.owner, r.f).toBe('ebmr_owner');
      expect(r.config?.find((c) => c.startsWith('search_path=')), r.f).toMatch(/, pg_temp$/);
      expect(r.pub, r.f).toBe(false);
    }
    expect(rows.filter((r) => r.app).map((r) => r.f)).toEqual([
      'tab.ipc_overdue_at(uuid,timestamp with time zone)', 'tab.line_isolated(uuid)', 'tab.record_ipc_overdue(uuid)', 'tab.record_line_isolation(text,boolean,text)',
    ]);
    const area = await sql<string>('select id::text as r from plant.area where code = $1', [line]);
    await expect(sbx.db.app.query("insert into tab.line_isolation (area_id, isolated, reference, person_id, account_id, correlation_id) values ($1, true, 'X', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [area])).rejects.toThrow(/permission denied/);
  });

  it('[IN-38][PR-33][PR-34][PR-35] TB-21 line set-up: the machine is a PROCESS unit in use on the line the packaging order occupies, cleared for the artwork set scanned; every reel is a released lot of its material, and the printed foil a lot issued for its item at the G-21 step; the change parts are the format\'s whatever the engine says; the stored set-up is what was scanned with the reels the block builds', async () => {
    for (const s of ['p-g21@', 'p-tb21c@']) await d.ok('operator1', { type: 'START_STEP', stepKey: s });
    expect(await verdict('p-tb21c', setup())).toBe('EBMR-TAB-370 TB21-FOIL-NOT-ISSUED');
    const facts = await sql<Json>("select tab.printed_lot_facts('TEST-FOIL-1', $1) as r", [d.runId]);
    expect(await rec.record('p-g21', { kind: 'ISSUE', item: 'FOIL', lot: facts, scannedArtwork: FOIL_ARTWORK, quantity: { value: '1000', unit: '1' } })).toBe('ok');
    expect(await verdict('p-tb21c', setup({ machine: 'TEST-NO-SUCH-UNIT' }))).toBe('EBMR-TAB-370 TB21-PRESS');
    expect(await verdict('p-tb21c', setup({ artworkSet: 'FOIL:ART-F2' }))).toBe('EBMR-TAB-370 TB21-LINE');
    expect(await verdict('p-tb21c', setup({ materials: reels('TEST-PVC-Q') }))).toBe('EBMR-TAB-370 TB21-LOT');
    expect(await verdict('p-tb21c', setup({ materials: reels('TEST-FOIL-1', 'TEST-FOIL-1') }), { tamper: quiet('p-tb21c', TB21, []) })).toBe('EBMR-TAB-370 TB21-LOT');
    // A forged engine that skips the change-part scan, and one that stores another order of them.
    expect(await verdict('p-tb21c', setup({ changeParts: ['FORM-TOOL-10'] }), { tamper: laxEntry('p-tb21c', {}) })).toBe('EBMR-TAB-370 TB21-CHANGE-PART');
    expect(await verdict('p-tb21c', setup(), { tamper: quiet('p-tb21c', TB21, [], (x) => ({ ...x, reels: (x['reels'] as Json[]).map((r) => ({ ...r, item: undefined })) })) })).toMatch(/^EBMR-TAB-370 .*reels/s);
    expect(await verdict('p-tb21c', setup())).toBe('ok');
    expect(await entryData('p-tb21c@', 'LINE_SETUP')).toEqual({
      machine, artworkSet: ARTWORK_SET, changeParts: ['FORM-TOOL-10', 'SEAL-PLATE-10'], materials: reels(),
      reels: [{ role: 'FORMING_FILM', material: FILM_MATERIAL, lot: 'TEST-PVC-1' }, { role: 'LIDDING_FOIL', material: FOIL_MATERIAL, lot: 'TEST-FOIL-1', item: 'FOIL' }], setUpBy: me,
    });
    // The independent check always needs the step's second person; a forged engine that drops it is refused.
    expect(await verdict('p-tb21c', check(), { tamper: laxEntry('p-tb21c', { rogueRemoved: true, changePartsFitted: true, emptyPocketDetector: 'PASS', result: 'PASS', checkedBy: me }) })).toMatch(/^EBMR-TAB-370 .*second person/s);
    expect(await verdict('p-tb21c', check({ emptyPocketDetector: 'FAIL' }), { tamper: quiet('p-tb21c', TB21, [], (x) => ({ ...x, result: 'PASS' })) })).toMatch(/^EBMR-TAB-370 .*result/s);
    expect(await verdict('p-tb21c', check())).toBe('ok');
    expect((await stateOf(sbx, d.runId)).steps['p-tb21c@']?.['verificationRequired']).toBe(true);
  });

  it('[IN-38] an uncoated potent or beta-lactam product is set up only on a line flagged isolated, by a master-data steward citing its qualification (never an operator or an administrator, never a direct write); the latest flag holds', async () => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb21i@' });
    expect(await verdict('p-tb21i', setup())).toBe('EBMR-TAB-370 TB21-ISOLATION');
    expect(await codeOf(asP('operator1', 'select tab.record_line_isolation($1, true, $2) as r', [line, 'QUAL-LINE-ISO-01']))).toMatch(/EBMR-IAM|permission/i);
    await expect(asSteward('select tab.record_line_isolation($1, true, $2) as r', ['TEST-NO-SUCH-LINE', 'QUAL-LINE-ISO-01'])).rejects.toThrow(/EBMR-TAB-372/);
    await asSteward('select tab.record_line_isolation($1, true, $2) as r', [line, 'QUAL-LINE-ISO-01']);
    expect(await verdict('p-tb21i', setup())).toBe('ok');
    await asSteward('select tab.record_line_isolation($1, false, $2) as r', [line, 'QUAL-LINE-ISO-01 withdrawn']);
    const area = await sql<string>('select id::text as r from plant.area where code = $1', [line]);
    expect(await sql<boolean>('select tab.line_isolated($1::uuid) as r', [area])).toBe(false);
    await expect(sbx.db.admin.query('update tab.line_isolation set isolated = true')).rejects.toThrow(/EBMR-/);
    const cfg = { product: { uncoated: true, potent: false, betaLactam: false } };
    expect(await sql<string>('select tab.blister_isolation_problem($1, $2, $3) as r', [d.runId, cfg, machine])).toBeNull();
    expect(await sql<string>('select tab.blister_isolation_problem($1, $2, $3) as r', [d.runId, { product: { uncoated: true, potent: true, betaLactam: false } }, machine])).toMatch(/TB21-ISOLATION/);
    expect(await sql<string>('select tab.blister_isolation_problem($1, $2, $3) as r', [d.runId, { product: { uncoated: false, potent: true, betaLactam: true } }, machine])).toBeNull();
  });

  it('[IN-38][PR-34][PR-35] the run and the leak test start only after a completed independent line check of the same machine (performed, then verified by another person), on the line the order still occupies', async () => {
    for (const s of ['p-tb21@', 'p-tb22@']) await d.ok('operator1', { type: 'START_STEP', stepKey: s });
    expect(await verdict('p-tb21', { kind: 'RUN_START', machine })).toBe('EBMR-TAB-370 TB21-NO-LINE-CHECK');
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-tb21c@' });
    expect(await verdict('p-tb22', { kind: 'RUN_START', machine })).toBe('EBMR-TAB-370 TB22-NO-LINE-CHECK');
    await d.signed('verifier1', { type: 'VERIFY', stepKey: 'p-tb21c@', meaning: 'VERIFIED' });
    expect((await stateOf(sbx, d.runId)).steps['p-tb21c@']?.['status']).toBe('COMPLETED');
    // Another machine of the batch, in use but on no line of the order: the line rule refuses it.
    const other = (await cleanUnit(sbx, d.runId, BLISTER_CLASS)).code;
    await startUse(sbx, await as('operator1'), other, d.runId);
    expect(await sql<string>('select tab.blister_line_problem($1, $2, null) as r', [d.runId, other])).toMatch(/TB21-LINE/);
    expect(await verdict('p-tb21', { kind: 'RUN_START', machine })).toBe('ok');
    expect(await verdict('p-tb22', { kind: 'RUN_START', machine })).toBe('ok');
  });

  it('[PR-37][PR-29][IN-38] TB-21 run: a sealing value outside its validated range is stored only with PROCESS_VALUE_OUT_OF_LIMITS and holds the machine\'s containers; a defect check is judged by the database (a forged pass is refused), a failure holds every container since the last passing check of the line series even past a whole-unit pass, and a passing check is recorded only from the step', async () => {
    const c1 = await open(machine);
    await close(c1);
    expect(await verdict('p-tb21', temp('182.0'), { tamper: quiet('p-tb21', TB21, ['PROCESS_VALUE_OUT_OF_LIMITS']) })).toMatch(/^EBMR-EXE-275 .*PROCESS_VALUE_OUT_OF_LIMITS/s);
    expect(await verdict('p-tb21', temp('182.0'))).toBe('ok');
    expect(await checks(machine)).toEqual([['LINE', 'FAIL']]);
    expect(await boxState(c1)).toBe('HELD');
    expect(await verdict('p-tb21', defects('2'), { tamper: quiet('p-tb21', TB21, [], (x) => ({ ...x, result: 'PASS' })) })).toMatch(/^EBMR-TAB-370 .*result/s);
    expect(await verdict('p-tb21', defects('2'), { tamper: quiet('p-tb21', TB21, ['DEFECT_CHECK_FAILED']) })).toMatch(/^EBMR-TAB-370 .*DEFECT_CHECK_FAILED/s);
    expect(await verdict('p-tb21', { kind: 'DEFECT_CHECK', examined: '25', defects: {} }, { tamper: laxEntry('p-tb21', {}) })).toBe('EBMR-TAB-370 TB21-SAMPLE');
    expect(await verdict('p-tb21', defects('0'))).toBe('ok');
    expect(await directPass(machine, 'LINE')).toBe('EBMR-TAB-302');
    // A container closed after the last line pass and before a whole-unit pass (as a G-21 challenge records one).
    const c2 = await open(machine);
    await close(c2);
    await asSetup(sbx, "insert into plant.ipc_check (batch_id, press_code, stream, result, reference, person_id, account_id) values ($1, $2, null, 'PASS', 'G21 challenge (arranged)', gen_random_uuid(), gen_random_uuid())", [d.runId, machine]);
    expect(await verdict('p-tb21', defects('1'))).toBe('ok');
    expect((await checks(machine)).slice(-3)).toEqual([['LINE', 'PASS'], ['-', 'PASS'], ['LINE', 'FAIL']]);
    expect(await boxState(c2)).toBe('HELD');
    expect(await types('p-tb21@')).toEqual(['DEFECT_CHECK_FAILED', 'PROCESS_MANUAL_FALLBACK', 'PROCESS_VALUE_OUT_OF_LIMITS']);
  });

  it('[PR-33][PR-37] TB-21 run: a new reel is a released lot of its web, a printed one issued at the G-21 step; pocket rejects feed the count, whose reconciliation is the database\'s own (a forged balance is refused); the run closes only with its count and a passing last defect check', async () => {
    expect(await verdict('p-tb21', { kind: 'REEL_CHANGE', role: 'LIDDING_FOIL', material: FOIL_MATERIAL, lot: 'TEST-FOIL-2' })).toBe('EBMR-TAB-370 TB21-FOIL-NOT-ISSUED');
    expect(await verdict('p-tb21', { kind: 'REEL_CHANGE', role: 'FORMING_FILM', material: FILM_MATERIAL, lot: 'TEST-PVC-Q' })).toBe('EBMR-TAB-370 TB21-LOT');
    expect(await verdict('p-tb21', { kind: 'REEL_CHANGE', role: 'LIDDING_FOIL', material: FOIL_MATERIAL, lot: 'TEST-FOIL-1' })).toBe('ok');
    expect(await verdict('p-tb21', { kind: 'REJECTS', emptyPocket: '12', brokenPocket: '3' })).toBe('ok');
    expect(await verdict('p-tb21', { kind: 'RUN_END' })).toBe('ok');
    const count: Entry = { kind: 'COUNT', formed: '1000', good: '960', setupWaste: '20', samples: '4' };
    expect(await verdict('p-tb21', count, { tamper: quiet('p-tb21', TB21, ['BLISTER_COUNT_UNEXPLAINED'], (x) => ({ ...x, unexplained: '0' })) })).toMatch(/^EBMR-TAB-370 .*unexplained/s);
    expect(await verdict('p-tb21', count, { tamper: quiet('p-tb21', TB21, ['BLISTER_COUNT_UNEXPLAINED']) })).toMatch(/^EBMR-TAB-370 .*BLISTER_COUNT_UNEXPLAINED/s);
    expect(await verdict('p-tb21', count)).toBe('ok');
    expect(await entryData('p-tb21@', 'COUNT')).toMatchObject({ formed: '1000', rejects: '15', unexplained: '1', goodUnits: '9600' });
    const c = await content();
    const old = await stateOf(sbx, d.runId);
    const done = structuredClone(old);
    (done.steps['p-tb21@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.blister_close_problem($1, $2, $3) as r', [c, old, done])).toMatch(/TB21-LAST-CHECK/);
    expect(await verdict('p-tb21', defects('0'))).toBe('ok');
    const old2 = await stateOf(sbx, d.runId);
    const done2 = structuredClone(old2);
    (done2.steps['p-tb21@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.blister_close_problem($1, $2, $3) as r', [c, old2, done2])).toBeNull();
    const noCount = structuredClone(done2);
    delete noCount.entries[await lastEntry(sbx, d.runId, 'p-tb21@', 'COUNT')];
    expect(await sql('select tab.blister_close_problem($1, $2, $3) as r', [c, old2, noCount])).toMatch(/TB21-NO-COUNT/);
  });

  it('[IN-38][PR-29] TB-22: any leaking pocket fails the test (a forged pass is refused) and holds every container of the machine since the track\'s last passing test; a test outside the validated method is refused; a pass is recorded only from the step; the step closes only with an end-of-run test of every track', async () => {
    const c3 = await open(machine);
    await close(c3);
    expect(await verdict('p-tb22', leak('T1', '1'), { tamper: quiet('p-tb22', TB22, ['LEAK_TEST_FAILED'], (x) => ({ ...x, result: 'PASS' })) })).toMatch(/^EBMR-TAB-370 .*result/s);
    expect(await verdict('p-tb22', leak('T1', '1'), { tamper: quiet('p-tb22', TB22, ['LEAK_TEST_FAILED']) })).toMatch(/^EBMR-TAB-370 .*LEAK_TEST_FAILED/s);
    expect(await verdict('p-tb22', leak('T1', '0', { vacuum: '50' }), { tamper: laxEntry('p-tb22', {}, { verificationRequired: true }) })).toBe('EBMR-TAB-370 TB22-PARAMETERS');
    expect(await verdict('p-tb22', leak('T1', '1'))).toBe('ok');
    expect((await checks(machine)).at(-1)).toEqual(['T1', 'FAIL']);
    expect(await boxState(c3)).toBe('HELD');
    expect(await verdict('p-tb22', leak('T1'))).toBe('ok');
    expect(await verdict('p-tb22', leak('T2'))).toBe('ok');
    expect((await checks(machine)).slice(-2)).toEqual([['T1', 'PASS'], ['T2', 'PASS']]);
    expect(await directPass(machine, 'T2')).toBe('EBMR-TAB-302');
    expect(await types('p-tb22@')).toEqual(['LEAK_TEST_FAILED']);
    expect((await stateOf(sbx, d.runId)).steps['p-tb22@']?.['verificationRequired']).toBe(true);
    expect(await verdict('p-tb22', { kind: 'RUN_END' })).toBe('ok');
    expect(await verdict('p-tb22', leak('T1'))).toBe('ok');
    const c = await content();
    const old = await stateOf(sbx, d.runId);
    const done = structuredClone(old);
    (done.steps['p-tb22@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.blister_close_problem($1, $2, $3) as r', [c, old, done])).toMatch(/TB22-END-TEST/);
    expect(await verdict('p-tb22', leak('T2'))).toBe('ok');
    const old2 = await stateOf(sbx, d.runId);
    const done2 = structuredClone(old2);
    (done2.steps['p-tb22@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.blister_close_problem($1, $2, $3) as r', [c, old2, done2])).toBeNull();
  });

  it('[IN-38][PR-29] TB-22 missed leak test at database time (IN-38 (c)): the server sweeper records the alarm and the MISSED hold of the machine without any entry; the next entry must list it with LEAK_TEST_MISSED (a forged engine that leaves it out is refused)', async () => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb22m@' });
    expect(await verdict('p-tb22m', { kind: 'RUN_START', machine })).toBe('ok');
    const box = await open(machine);
    await close(box);
    await wait(3_500);
    const sweeper = { ...(await openServiceSession(sbx.db, sbx.seed, 'sweeper')), correlationId: randomUUID() };
    const alarms = (await recordIpcOverdue(sbx.built.ctx, sweeper)).filter((a) => a.batchId === d.runId && a.stepKey === 'p-tb22m@');
    expect(alarms.map((m) => [m.stream, m.test, m.held])).toEqual([['T1', 'LEAK', true]]);
    expect((await checks(machine)).at(-1)).toEqual(['T1', 'MISSED']);
    expect(await sql<string>('select plant.container_usable_problem($1) as r', [box.container_id])).toMatch(/under a hold/);
    const forged = quiet('p-tb22m', TB22, ['LEAK_TEST_MISSED'], (x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'missed')));
    expect(await verdict('p-tb22m', { kind: 'EVENT', event: 'RESTART' }, { tamper: forged })).toMatch(/^EBMR-TAB-370 .*missed/s);
    expect(await verdict('p-tb22m', { kind: 'EVENT', event: 'RESTART' })).toBe('ok');
    expect(((await entryData('p-tb22m@', 'EVENT'))['missed'] as Json[]).map((m) => [m['stream'], m['test'], m['by']])).toEqual([['T1', 'LEAK', 'TIME']]);
    expect(await types('p-tb22m@')).toEqual(['LEAK_TEST_MISSED']);
    expect((await checks(machine)).at(-1)).toEqual(['T1', 'MISSED']);
  });

  it('[PR-29][PR-37][IN-22] lead review: a blister and cartoning order records the PASS checks its other blocks\' own guards hold (a TB-24 challenge on the cartoning line, a G-21 challenge on its unit) beside the blister ones; a forged PASS with an unguarded prefix, a delegated prefix on a unit no such step names, or a replayed G-21 reference is still refused', async () => {
    for (const code of [CARTON_UNIT, VISION_UNIT]) {
      const cls = `CL-${randomUUID().slice(0, 6).toUpperCase()}`;
      await asSetup(sbx, "insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, recorded_by) values ($1, 'PROCESS', 'Packaging line (test)', interval '72 hours', interval '48 hours', false, gen_random_uuid())", [cls]);
      await asSetup(sbx, "insert into plant.equipment (id, code, name, class_code, kind, recorded_by) values (gen_random_uuid(), $1, $1, $2, 'PROCESS', gen_random_uuid())", [code, cls]);
    }
    for (const s of ['p-tb24@', 'p-g21u@']) await d.ok('operator1', { type: 'START_STEP', stepKey: s });
    expect(await rec.record('p-tb24', { kind: 'CHALLENGE', device: 'CW', trigger: 'START', result: 'PASS' })).toBe('ok');
    expect((await checks(CARTON_UNIT)).at(-1)).toEqual(['D.CW', 'PASS']);
    expect(await rec.record('p-g21u', { kind: 'CHALLENGE', device: 'CAM', trigger: 'START', result: 'PASS' })).toBe('ok');
    expect((await checks(VISION_UNIT)).at(-1)).toEqual(['-', 'PASS']);
    const g21ref = await sql<string>("select reference as r from plant.ipc_check where batch_id = $1 and press_code = $2 and result = 'PASS' order by recorded_at desc limit 1", [d.runId, VISION_UNIT]);
    const pass = (unit: string, stream: string | null, reference: string) => codeOf(asP('operator1', "select plant.record_ipc_check($1, $2, $3, 'PASS', $4) as r", [d.runId, unit, stream, reference]));
    expect(await pass(VISION_UNIT, null, g21ref ?? '')).toBe('EBMR-TAB-302');
    expect(await pass(VISION_UNIT, null, 'G21:p-g21u@:EN-1:CAM')).toBe('EBMR-TAB-302');
    expect(await pass(machine, 'LINE', 'QA:says so')).toBe('EBMR-TAB-302');
    expect(await pass(machine, 'LINE', 'TB24:p-tb24@:EN-1')).toBe('EBMR-TAB-302');
    expect(await pass(CARTON_UNIT, 'D.CW', 'TB24:p-tb24@:EN-999999')).toMatch(/EBMR-TAB-(302|382)/);
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
