/**
 * Phase 3 slice 3d (builder B): the forming blocks' rules held by the database (tablets 0930 to 0932), proven as the
 * application role past the server: an honest entry the engine builds is stored; the same act through a tampered block
 * handler (a forged engine: a rule skipped, an evaluation, a held list or an exception changed) is refused by the
 * database alone. The ribbon checks and the mill screen of TB-06 and the layer checks of TB-16 hold the unit's containers
 * through the slice 1 container commands (plant.record_ipc_check); the missed-check timer runs at database time. Rules
 * about closing a step are read through their functions on the run's real state, forged where the test says so.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { FORMING_TAGS } from '@ebmr/integration-sdk/process';
import { openPersonaSession, openServiceSession } from '@ebmr/test-kit';
import { FORMING_BLOCK_VERSIONS, TB06, TB16 } from '../../../src/blocks/forming/index.ts';
import { recordIpcOverdue } from '../../../src/features/execution/sweeper.ts';
import { actorOfBrowser } from '../../esig/support.ts';
import { adminActor, enrol, fakeGateway, type FakeGateway } from '../../devices/support.ts';
import { codeOf } from '../../execution/db-guards-support.ts';
import { importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../../execution/support.ts';
import { PRESS_CLASS, SPEC } from '../compression/db-support.ts';
import { asSetup, cleanUnit, linkDevice, startUse } from '../compression/plant-support.ts';
import { fakeTimers, lastEntry, laxEntry, recorder, stateOf, tamperHandler, type Entry } from '../granulation/db-support.ts';
import { COMPACTOR_CLASS, formingMbr, SCREEN } from './db-support.ts';

type Json = Record<string, unknown>;

let sbx: ExecServer;
let d: RunDriver;
let rec: ReturnType<typeof recorder>;
let me: string;
let gw: FakeGateway | undefined;
let compactor = '';
let press = '';
let pressUse = '';

const DEVICE = 'TEST-PRESS-3D';
const SERIAL = 'PRESS-3D-0001';
const ITEMS = ['TIPS', 'EDGES', 'WEAR', 'EMBOSSING', 'CORROSION', 'CLEANLINESS'];

const advance = (): void => {
  vi.advanceTimersByTime(7_000);
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const op = async (): Promise<ActorContext> => {
  advance();
  return actorOfBrowser(sbx, d.browser('operator1'), 'operator1');
};

/** A function call as operator1 in a validated command; its result (column r). */
async function asOp<T = Json>(text: string, params: unknown[]): Promise<T> {
  return withCommand(sbx.db.app, await op(), async (c) => (await c.query<{ r: T }>(text, params)).rows[0]?.r as T);
}

/** A master-data command as the data steward. */
async function asSteward<T = Json>(text: string, params: unknown[]): Promise<T> {
  const steward = await openPersonaSession(sbx.db, sbx.seed, 'steward');
  return withCommand(sbx.db.app, { ...steward, correlationId: randomUUID() }, async (c) => (await c.query<{ r: T }>(text, params)).rows[0]?.r as T);
}

async function sql<T>(text: string, params: unknown[]): Promise<T | null> {
  const { rows } = await sbx.db.admin.query<{ r: T | null }>(text, params);
  return rows[0]?.r ?? null;
}

/** The database's answer for an entry: 'ok', or the EBMR code and the block rule code it names. */
async function verdict(step: string, entry: Entry, opts: Parameters<typeof rec.message>[2] = {}): Promise<string> {
  const m = await rec.message(step, entry, opts);
  if (m === 'ok') return m;
  const code = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(m)?.[1] ?? '?';
  const rule = /\((?:[^()]*; )?(TB(?:02|06|11|16)-[A-Z0-9-]+)[;)]/.exec(m)?.[1] ?? /(TB(?:02|06|11|16)-[A-Z0-9-]+)/.exec(m)?.[1];
  return rule ? `${code} ${rule}` : `${code} ${m.slice(0, 500)}`;
}

const content = (): Promise<Json | null> => sql<Json>('select recipe.batch_mbr_content($1) as r', [d.runId]);
const entryData = async (key: string, kind: string): Promise<Json> => ((await stateOf(sbx, d.runId)).entries[await lastEntry(sbx, d.runId, key, kind)]?.['data'] ?? {}) as Json;
const types = async (key: string): Promise<string[]> =>
  Object.values((await stateOf(sbx, d.runId)).exceptions).filter((e) => (e['source'] as Json)['stepKey'] === key).map((e) => String(e['type'])).sort();
const checks = async (unit: string): Promise<string[][]> =>
  (await sbx.db.admin.query<{ s: string; r: string }>("select coalesce(stream, '-') as s, result as r from plant.ipc_check where batch_id = $1 and press_code = $2 order by recorded_at, id", [d.runId, unit])).rows.map((r) => [r.s, r.r]);
const open = (stage: string, unit: string | null) => asOp<{ container_id: string; version: number; label_code: string }>('select plant.open_container($1, $2, $3, $4) as r', [d.runId, stage, 'kg', unit]);
const close = (c: { container_id: string; version: number }) => asOp<{ label_code: string }>('select plant.close_container($1, $2, $3) as r', [c.container_id, '12.500', c.version]);
const state = (c: { container_id: string }) => sql<string>("select state as r from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = $1", [c.container_id]);
const held = (c: { container_id: string }) => sql<number>('select count(*)::int as r from plant.container_hold where container_id = $1', [c.container_id]);
const strip = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([k, v]) => k !== 'kind' && v !== undefined));
const kg = (value: string) => ({ value, unit: 'kg' });
const screen = (when: string, result: string): Entry => ({ kind: 'SCREEN_CHECK', screen: SCREEN.id, aperture: SCREEN.aperture, when, result });
const ribbon = (thickness: string): Entry => ({ kind: 'RIBBON_CHECK', thickness, appearance: 'COMPLIES' });
const group = (stream: string, g: string, extra: Json = {}): Entry => ({ kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'MANUAL', stream, groupWeight: g, ...extra });
const sweep = (): Entry => ({ kind: 'STATION_SWEEP', instrument: 'TEST-BAL-01', capture: 'MANUAL', stream: 'T', stations: ['400.0', '401.0'].map((w, i) => ({ station: i + 1, weight: w })) });
const phys = (defects: string[] = []): Entry => ({ kind: 'PHYSICAL_CHECK', instrument: 'TEST-HT-01', capture: 'MANUAL', stream: 'T', tablets: [{ thickness: '5.40' }, { thickness: '5.41' }], defects });
const directPass = (unit: string, stream: string) => codeOf(asOp("select plant.record_ipc_check($1, $2, $3, 'PASS', 'operator says so') as r", [d.runId, unit, stream]));

/** The honest engine's result without one exception type (or with its data changed): a forged engine for step `step`. */
function quiet(step: string, block: typeof TB06, drop: string[], data: (x: Json) => Json = (x) => x) {
  return tamperHandler(step, {
    acceptEntry: (view, entry) => {
      const r = block.handler?.acceptEntry?.(view, entry);
      if (!r?.ok) throw new Error('SETUP: the honest engine refused');
      return { ...r, data: data(r.data), exceptions: (r.exceptions ?? []).filter((e) => !drop.includes(e.type)) };
    },
  });
}

/** Instruments in use for the run (plant master data arranged by the superuser; checks and uses as operator1). */
async function instruments(): Promise<void> {
  await asSetup(sbx, "insert into plant.equipment_class (code, kind, description, calibration_required, check_regime, recorded_by) values ('EQC-IPC-3D', 'INSTRUMENT', 'IPC balance and tester', true, 'PER_USE', gen_random_uuid()) on conflict do nothing");
  for (const code of ['TEST-BAL-01', 'TEST-HT-01', 'TEST-BAL-09']) {
    const id = randomUUID();
    await asSetup(sbx, "insert into plant.equipment (id, code, name, class_code, kind, recorded_by) values ($1, $2, $2, 'EQC-IPC-3D', 'INSTRUMENT', gen_random_uuid())", [id, code]);
    await asSetup(sbx, "insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) values ($1, 'QUALIFIED', 'QUAL-IPC', 'IQ/OQ/PQ approved', gen_random_uuid(), gen_random_uuid())", [id]);
    await asSetup(sbx, "insert into plant.calibration (equipment_id, due_at, as_found, as_left, reference, person_id, account_id) values ($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', 'CAL-IPC', gen_random_uuid(), gen_random_uuid())", [id]);
  }
  for (const code of ['TEST-BAL-01', 'TEST-HT-01']) {
    await asOp("select plant.record_instrument_check($1, 'PASS', 'IPC per-use check', $2::uuid) as r", [code, d.runId]);
    await asOp("select plant.record_instrument_use($1, $2::uuid, clock_timestamp() + interval '8 hours') as r", [code, d.runId]);
  }
}

/**
 * The press set up and approved for the batch: a process device on a clean press unit of the stage's class in use for
 * the run, a tooling set issued at the TB-09 step after a passing inspection, the TB-10 set-up, checklist, charge and
 * a passing first-off, performed and verified (its check signature is the first-off approval).
 */
async function pressApproved(): Promise<void> {
  const chain = await enrol(sbx);
  const site = (await sbx.db.admin.query<{ s: string }>("select site_code as s from iam.device where code = 'TEST-BAL-01'")).rows[0]?.s ?? null;
  await identity.withGuardedCommand(sbx.db.app, await adminActor(sbx), async (c) => {
    await c.query('select iam.register_device($1, $2, $3, $4, $5, $6, $7)', [DEVICE, 'INSTRUMENT', site, 'DISP-1', null, createHash('sha256').update(`${DEVICE}:${randomUUID()}`).digest('hex'), 'Bilayer press (test) behind the site gateway']);
    await c.query('select tab.bind_process_device($1, $2, $3, $4)', [chain, DEVICE, SERIAL, 'PRESS']);
  });
  gw = await fakeGateway(sbx);
  const unit = await cleanUnit(sbx, d.runId, PRESS_CLASS);
  press = unit.code;
  await linkDevice(sbx, DEVICE, press);
  pressUse = await startUse(sbx, await op(), press, d.runId);
  await withCommand(sbx.db.app, await op(), (c) => c.query('select tab.bind_step_device($1, $2, $3)', [d.runId, 'p-tb10', DEVICE]));
  const r = await gw.post('/gw/v1/process-readings', { sessionId: randomUUID(), readings: [{ deviceSerial: SERIAL, tag: 'stroke.count', value: '1000', unit: 'count', quality: 'GOOD', sourceTime: '1790584618000000', sequence: '1', kind: 'ACTUAL' }] });
  expect(r.status).toBe(200);
  const product = (await sql<string>("select recipe.batch_product($1) ->> 'code' as r", [d.runId])) ?? '';
  const steward = await openPersonaSession(sbx.db, sbx.seed, 'steward');
  await withCommand(sbx.db.app, { ...steward, correlationId: randomUUID() }, (c) =>
    c.query('select tab.define_tooling_set($1)', [{ code: 'TEST-SET-3D-01', product, ...SPEC, tips: '1', upperPunches: '2', lowerPunches: '2', dies: '2', strokeLimit: '100000' }]));
  const pre = await asOp<{ inspectionId: string }>('select tab.inspect_tooling($1, $2, $3, $4, $5) as r', ['TEST-SET-3D-01', 'PRE_USE', null, Object.fromEntries(ITEMS.map((k) => [k, true])), null]);
  const issue = await asOp<{ issueId: string }>('select tab.issue_tooling($1, $2, $3, $4) as r', ['TEST-SET-3D-01', d.runId, press, { upper: '2', lower: '2', dies: '2' }]);
  for (const s of ['p-tb09i@', 'p-tb10@']) await d.ok('operator1', { type: 'START_STEP', stepKey: s });
  expect(await verdict('p-tb09i', { kind: 'TOOLING_INSPECTED', set: 'TEST-SET-3D-01', inspectionId: pre.inspectionId, when: 'BEFORE', result: 'PASS' })).toBe('ok');
  expect(await verdict('p-tb09i', { kind: 'TOOLING_ISSUED', set: 'TEST-SET-3D-01', issueId: issue.issueId, press })).toBe('ok');
  expect(await verdict('p-tb10', { kind: 'PRESS_SETUP', press, useId: pressUse, issueId: issue.issueId })).toBe('ok');
  expect(await verdict('p-tb10', { kind: 'PRE_USE_CHECKLIST', items: ['DUST_EXTRACTION', 'NOZZLES_CLEAN_NO_LEAK', 'CALIBRATED_BALANCE'].map((item) => ({ item, ok: true })) })).toBe('ok');
  const box = await open('BLEND_LA', null);
  const closed = await close(box);
  const charge = await asOp<{ charge_id: string }>('select plant.charge_container($1, $2, $3) as r', [d.runId, 'COMPRESSION', closed.label_code]);
  expect(await verdict('p-tb10', { kind: 'HOPPER_CHARGE', chargeId: charge.charge_id })).toBe('ok');
  expect(await verdict('p-tb10', { kind: 'FIRST_OFF', result: 'PASS' })).toBe('ok');
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-tb10@' });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: 'p-tb10@', meaning: 'VERIFIED' });
}

/** A blend container of `stage`, closed, charged by operator1's scan (plant.charge_container); its charge id. */
async function charged(stage: string): Promise<string> {
  const box = await open(stage, null);
  const closed = await close(box);
  return (await asOp<{ charge_id: string }>('select plant.charge_container($1, $2, $3) as r', [d.runId, 'COMPRESSION', closed.label_code])).charge_id;
}

beforeAll(async () => {
  sbx = await startExecServer();
  fakeTimers();
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, formingMbr()));
  d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1') });
  d.beforeTap = advance;
  rec = recorder(sbx, d, advance);
  me = personaIn(sbx, 'operator1').personId;
  const unit = await cleanUnit(sbx, runId, COMPACTOR_CLASS);
  compactor = unit.code;
  await startUse(sbx, await op(), compactor, runId);
  await instruments();
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await gw?.close();
  await sbx?.close();
});

describe('the forming blocks in the database (tablets 0930 to 0932)', () => {
  it('[DI-30][DI-05] the database holds the data schemas of TB-06 and TB-16 as the block registry declares them (G-06 and TB-11 kinds unchanged), their block types and rule codes, the roller compactor and bilayer press tags of the integration SDK, and both as blocks on a process device; nothing can change them', async () => {
    const { rows } = await sbx.db.admin.query<{ k: string; schema: Json }>("select block_type || '@' || block_version || ' ' || entry_kind as k, schema from recipe.block_data_schema where block_type in ('TB-06', 'TB-16')");
    const want: Record<string, Json> = {};
    for (const b of FORMING_BLOCK_VERSIONS) for (const [k, s] of Object.entries(b.dataSchema?.entries ?? {})) want[`${b.type}@${b.version} ${k}`] = schemaJson(s as unknown as { type: string } & Json);
    expect(Object.fromEntries(rows.map((r) => [r.k, r.schema]))).toEqual(want);
    for (const k of ['ACTUAL', 'WEIGHT_CHECK', 'STATION_SWEEP']) {
      const of = k === 'ACTUAL' ? 'G-06' : 'TB-11';
      const src = await sql<Json>('select schema as r from recipe.block_data_schema where block_type = $1 and entry_kind = $2', [of, k]);
      expect(want[`${k === 'ACTUAL' ? 'TB-06' : 'TB-16'}@1 ${k}`], k).toEqual(src);
    }
    const files = ['tb-06', 'tb-16'].map((f) => readFileSync(new URL(`../../../src/blocks/${f}.ts`, import.meta.url), 'utf8')).join('\n');
    const codes = [...new Set([...files.matchAll(/'(TB(?:06|16)(?:-[A-Z0-9]+)+)'/g)].map((m) => m[1] ?? ''))];
    const named = (await sbx.db.admin.query<{ name: string }>("select name from recipe.engine_name where name ~ '^TB(06|16)' or name in ('TB-06', 'TB-16')")).rows.map((r) => r.name);
    expect(codes.filter((c) => !named.includes(c))).toEqual([]);
    expect(named).toEqual(expect.arrayContaining(['TB-06', 'TB-16', 'TB06-PRESS', 'TB16-CHARGE', 'TB16-DISCHARGE']));
    const tags = await sbx.db.admin.query<Json>(`select tag, equipment_kind, unit, scale, counter, setpoint from tab.process_tag where tag = any ($1::text[]) order by tag`, [FORMING_TAGS.map((t) => t.tag)]);
    expect(tags.rows).toEqual([...FORMING_TAGS].sort((a, b) => (a.tag < b.tag ? -1 : 1)).map((t) => ({ tag: t.tag, equipment_kind: t.equipment, unit: t.unit, scale: t.scale, counter: t.counter, setpoint: t.setpoint })));
    const kinds = (await sbx.db.admin.query<{ t: string }>('select block_type as t from tab.process_block_type')).rows.map((r) => r.t);
    expect(kinds).toEqual(expect.arrayContaining(['G-06', 'TB-04', 'TB-10', 'TB-06', 'TB-16']));
    // The widened constraints keep every kind they held before.
    expect(await sql<string>("select pg_get_constraintdef(oid) as r from pg_constraint where conname = 'process_device_equipment_kind_check'", [])).toMatch(/BLENDER.*COATER.*DRYER.*GRANULATOR.*PRESS.*ROLLER_COMPACTOR/s);
    expect(await sql<string>("select pg_get_constraintdef(oid) as r from pg_constraint where conname = 'ipc_overdue_alarm_test_check'", [])).toMatch(/DISINTEGRATION.*FRIABILITY.*PHYSICAL.*RIBBON.*SWEEP.*WEIGHT/s);
    await expect(sbx.db.admin.query("update recipe.block_data_schema set schema = '{\"type\": \"object\", \"fields\": {}}' where block_type = 'TB-06'")).rejects.toThrow(/EBMR-AUDIT-004/);
    await expect(sbx.db.admin.query("delete from tab.process_block_type where block_type = 'TB-16'")).rejects.toThrow(/EBMR-/);
    await expect(sbx.db.app.query("insert into tab.process_tag (tag, equipment_kind, unit, scale, counter, setpoint) values ('roller.x_kN', 'ROLLER_COMPACTOR', 'kN', 1, false, false)")).rejects.toThrow(/permission denied/);
  });

  it('[DI-17][DI-18] the new and replaced functions pin their search path with pg_temp last and belong to the owner; the application role executes only the two missed-check readers it executed before, and writes no forming row directly', async () => {
    const { rows } = await sbx.db.admin.query<{ f: string; owner: string; config: string[] | null; pub: boolean; app: boolean }>(
      `select p.oid::regprocedure::text as f, pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
              coalesce(exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'), p.proacl is null) as pub,
              has_function_privilege('ebmr_app', p.oid, 'EXECUTE') as app
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'tab' and (p.proname ~ '^(forming|compaction|bilayer)_' or p.proname in ('ipc_pass_check', 'ipc_overdue_at', 'record_ipc_overdue'))
        order by 1`,
    );
    expect(rows.length).toBe(19);
    for (const r of rows) {
      expect(r.owner, r.f).toBe('ebmr_owner');
      expect(r.config?.find((c) => c.startsWith('search_path=')), r.f).toMatch(/, pg_temp$/);
      expect(r.pub, r.f).toBe(false);
    }
    expect(rows.filter((r) => r.app).map((r) => r.f)).toEqual(['tab.ipc_overdue_at(uuid,timestamp with time zone)', 'tab.record_ipc_overdue(uuid)']);
    await expect(sbx.db.app.query("insert into tab.process_block_type (block_type) values ('TB-99')")).rejects.toThrow(/permission denied/);
  });

  it('[PR-08][PR-29] TB-06: the run starts on a plant PROCESS unit in use for the batch; a roll gap outside its limits is stored only with PROCESS_VALUE_OUT_OF_LIMITS; a ribbon check is judged by the database (a forged pass is refused), a failing one holds every container of the compactor since its last passing check, and a passing check is recorded only from the step', async () => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb06@' });
    expect(await verdict('p-tb06', { kind: 'RUN_START', press: 'TEST-BAL-01' })).toBe('EBMR-TAB-340 TB06-PRESS');
    expect(await verdict('p-tb06', { kind: 'RUN_START', press: compactor })).toBe('ok');
    // A value keyed by hand under the MBR's fallback, outside its limits: forged without its exception, then honestly.
    const gap: Entry = { kind: 'ACTUAL', tag: 'roller.gap_mm', value: '3.80', unit: 'mm', source: 'MANUAL' };
    expect(await verdict('p-tb06', gap, { tamper: quiet('p-tb06', TB06, ['PROCESS_VALUE_OUT_OF_LIMITS']) })).toBe('EBMR-TAB-340 TB06-PROCESS-LIMITS');
    expect(await verdict('p-tb06', gap)).toBe('ok');
    expect(await entryData('p-tb06@', 'ACTUAL')).toMatchObject({ withinLimits: false, manualFallback: true });
    expect(await types('p-tb06@')).toEqual(['PROCESS_MANUAL_FALLBACK', 'PROCESS_VALUE_OUT_OF_LIMITS']);
    expect(await verdict('p-tb06', { kind: 'FEED', quantity: kg('50.000') })).toBe('ok');
    const c1 = await open('GRANULES', compactor);
    await close(c1);
    // A ribbon of 3.60 mm (above 3.50): a forged pass, a forged result without its exception, then honestly.
    expect(await verdict('p-tb06', ribbon('3.60'), { tamper: laxEntry('p-tb06', { thickness: '3.60', appearance: 'COMPLIES', evaluation: { thickness: 'PASS', appearance: 'PASS' }, result: 'PASS', recordedBy: me }) })).toMatch(/^EBMR-TAB-340 .*evaluation/s);
    expect(await verdict('p-tb06', ribbon('3.60'), { tamper: quiet('p-tb06', TB06, ['RIBBON_CHECK_FAILED']) })).toMatch(/^EBMR-TAB-340 .*RIBBON_CHECK_FAILED/s);
    expect(await verdict('p-tb06', { kind: 'RIBBON_CHECK', thickness: '3.00', density: '1.10', appearance: 'COMPLIES' }, { tamper: laxEntry('p-tb06', {}) })).toBe('EBMR-TAB-340 TB06-RIBBON-PARAMETERS');
    expect(await verdict('p-tb06', ribbon('3.60'))).toBe('ok');
    expect(await checks(compactor)).toEqual([['RIBBON', 'FAIL']]);
    expect(await state(c1)).toBe('HELD');
    expect(await directPass(compactor, 'RIBBON')).toBe('EBMR-TAB-302');
    expect(await verdict('p-tb06', ribbon('3.40'))).toBe('ok');
    expect((await entryData('p-tb06@', 'RIBBON_CHECK'))['result']).toBe('ALERT');
    expect(await checks(compactor)).toEqual([['RIBBON', 'FAIL'], ['RIBBON', 'PASS']]);
    expect(await types('p-tb06@')).toEqual(['PROCESS_MANUAL_FALLBACK', 'PROCESS_VALUE_OUT_OF_LIMITS', 'RIBBON_CHECK_ALERT', 'RIBBON_CHECK_FAILED']);
  });

  it('[IN-36][INV-24][PR-29] TB-06 mill screen (TB-02\'s rule): granules only through a screen checked intact before use; an after-use check that finds it damaged names exactly the granules milled through it since its last intact check (a forged list is refused) and holds the compactor\'s containers since then; the screen is never checked again at a TB-02 step of the batch either', async () => {
    expect(await verdict('p-tb06', { kind: 'GRANULE_OUTPUT', screen: SCREEN.id, granules: kg('20.000'), fines: kg('4.000') }, { tamper: laxEntry('p-tb06', {}) })).toBe('EBMR-TAB-340 TB06-NO-PRE-CHECK');
    expect(await verdict('p-tb06', { ...screen('BEFORE', 'INTACT'), aperture: { value: '2.0', unit: 'mm' } }, { tamper: laxEntry('p-tb06', {}, { verificationRequired: true }) })).toBe('EBMR-TAB-340 TB06-APERTURE');
    expect(await verdict('p-tb06', screen('BEFORE', 'INTACT'))).toBe('ok');
    expect((await stateOf(sbx, d.runId)).steps['p-tb06@']?.['verificationRequired']).toBe(true);
    expect(await verdict('p-tb06', { kind: 'GRANULE_OUTPUT', screen: SCREEN.id, granules: kg('20.000'), fines: kg('6.000') })).toBe('ok');
    const out1 = await lastEntry(sbx, d.runId, 'p-tb06@', 'GRANULE_OUTPUT');
    const c2 = await open('GRANULES', compactor);
    await close(c2);
    expect(await verdict('p-tb06', screen('AFTER', 'DAMAGED'), { tamper: quiet('p-tb06', TB06, [], (x) => ({ ...x, held: [] })) })).toMatch(/^EBMR-TAB-340 .*held/s);
    expect(await verdict('p-tb06', screen('AFTER', 'DAMAGED'), { tamper: quiet('p-tb06', TB06, ['SCREEN_INTEGRITY_FAILED']) })).toMatch(/^EBMR-TAB-340 .*SCREEN_INTEGRITY_FAILED/s);
    expect(await verdict('p-tb06', screen('AFTER', 'DAMAGED'))).toBe('ok');
    expect((await entryData('p-tb06@', 'SCREEN_CHECK'))['held']).toEqual([out1]);
    expect((await checks(compactor)).slice(-2)).toEqual([['MILL', 'PASS'], ['MILL', 'FAIL']]);
    expect(await state(c2)).toBe('HELD');
    expect(await verdict('p-tb06', screen('BEFORE', 'INTACT'), { tamper: laxEntry('p-tb06', {}, { verificationRequired: true }) })).toBe('EBMR-TAB-340 TB06-SCREEN-DAMAGED');
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb02@' });
    expect(await verdict('p-tb02', screen('BEFORE', 'INTACT'))).toBe('EBMR-TAB-340 TB02-SCREEN-DAMAGED');
  });

  it('[IN-36] TB-06 fines recycle and yield: fines are recycled only within the MBR\'s percentage of the pre-blend fed (a forged engine is refused), the yield is the database\'s own (C-09), after the run, and the step closes only with its end-of-run ribbon check, every screen checked after use and the yield', async () => {
    expect(await verdict('p-tb06', { kind: 'FINES_RECYCLED', quantity: kg('5.001') }, { tamper: laxEntry('p-tb06', { quantity: kg('5.001'), recycledPercent: '10.00', recordedBy: me }) })).toBe('EBMR-TAB-340 TB06-FINES-LIMIT');
    expect(await verdict('p-tb06', { kind: 'FINES_RECYCLED', quantity: kg('6.001') }, { tamper: laxEntry('p-tb06', { quantity: kg('6.001'), recycledPercent: '12.00', recordedBy: me }) })).toBe('EBMR-TAB-340 TB06-FINES-QUANTITY');
    expect(await verdict('p-tb06', { kind: 'FINES_RECYCLED', quantity: kg('4.000') })).toBe('ok');
    expect((await entryData('p-tb06@', 'FINES_RECYCLED'))['recycledPercent']).toBe('8.00');
    expect(await verdict('p-tb06', { kind: 'YIELD' }, { tamper: laxEntry('p-tb06', {}) })).toBe('EBMR-TAB-340 TB06-RUNNING');
    expect(await verdict('p-tb06', { kind: 'RUN_END' })).toBe('ok');
    expect(await verdict('p-tb06', ribbon('3.00'))).toBe('ok');
    const forged = { unit: 'kg', feed: '50', granules: '20', fines: '6', recycled: '4', net: '22', yieldPercent: '98.00', withinLimits: false, recordedBy: me };
    expect(await verdict('p-tb06', { kind: 'YIELD' }, { tamper: laxEntry('p-tb06', forged) })).toMatch(/^EBMR-TAB-340 .*yieldPercent/s);
    expect(await verdict('p-tb06', { kind: 'YIELD' })).toBe('ok');
    // (20 + 6 - 4) / 50 = 44.00 %: outside 95 to 100 %, with its exception.
    expect(await entryData('p-tb06@', 'YIELD')).toMatchObject({ feed: '50', fines: '6', recycled: '4', net: '22', yieldPercent: '44.00', withinLimits: false });
    expect(await types('p-tb06@')).toContain('COMPACTION_YIELD_OUT_OF_RANGE');
    const c = await content();
    const old = await stateOf(sbx, d.runId);
    const done = structuredClone(old);
    (done.steps['p-tb06@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.forming_close_problem($1, $2, $3) as r', [c, old, done])).toBeNull();
    const noYield = structuredClone(done);
    for (const [k, e] of Object.entries(noYield.entries)) if (e['kind'] === 'YIELD') delete noYield.entries[k];
    expect(await sql('select tab.forming_close_problem($1, $2, $3) as r', [c, old, noYield])).toMatch(/TB06-NO-YIELD/);
    const noEndCheck = structuredClone(done);
    const lastRibbon = await lastEntry(sbx, d.runId, 'p-tb06@', 'RIBBON_CHECK');
    delete noEndCheck.entries[lastRibbon];
    expect(await sql('select tab.forming_close_problem($1, $2, $3) as r', [c, old, noEndCheck])).toMatch(/TB06-END-CHECK/);
  });

  it('[PR-29] TB-06 missed ribbon check at database time: the server sweeper records the alarm and the MISSED hold of the compactor without any entry; the next entry must list it with RIBBON_CHECK_MISSED (a forged engine that leaves it out is refused)', async () => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb06m@' });
    expect(await verdict('p-tb06m', { kind: 'RUN_START', press: compactor })).toBe('ok');
    const box = await open('GRANULES', compactor);
    await close(box);
    await wait(3_500);
    const sweeper = { ...(await openServiceSession(sbx.db, sbx.seed, 'sweeper')), correlationId: randomUUID() };
    const alarms = (await recordIpcOverdue(sbx.built.ctx, sweeper)).filter((a) => a.batchId === d.runId && a.stepKey === 'p-tb06m@');
    expect(alarms.map((m) => [m.stream, m.test, m.held])).toEqual([['RIBBON', 'RIBBON', true]]);
    expect((await checks(compactor)).at(-1)).toEqual(['RIBBON', 'MISSED']);
    expect(await sql<string>('select plant.container_usable_problem($1) as r', [box.container_id])).toMatch(/under a hold/);
    const forged = quiet('p-tb06m', TB06, ['RIBBON_CHECK_MISSED'], (x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'missed')));
    expect(await verdict('p-tb06m', { kind: 'FEED', quantity: kg('10.000') }, { tamper: forged })).toMatch(/^EBMR-TAB-340 .*missed/s);
    expect(await verdict('p-tb06m', { kind: 'FEED', quantity: kg('10.000') })).toBe('ok');
    expect(((await entryData('p-tb06m@', 'FEED'))['missed'] as Json[]).map((m) => [m['stream'], m['test'], m['by']])).toEqual([['RIBBON', 'RIBBON', 'TIME']]);
    expect(await types('p-tb06m@')).toEqual(['RIBBON_CHECK_MISSED']);
    expect((await checks(compactor)).at(-1)).toEqual(['RIBBON', 'MISSED']);
  });

  it('[PR-21][IN-26][PR-23] TB-16 hopper charges: each layer\'s hopper takes a container of its own blend by the person\'s scan (a container of the other layer\'s blend, a swapped hopper, another person\'s or a reused charge are refused by the database); each charge needs a second person; the run cannot start with a layer uncharged, nor before the press\'s first-off approval', async () => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb16@' });
    const chargeA = await charged('BLEND_LA');
    const chargeB = await charged('BLEND_LB');
    const hopper = (layer: string, h: string, blend: string, chargeId: string): Entry => ({ kind: 'HOPPER_CHARGE', layer, hopper: h, blend, chargeId });
    // The engine trusts the blend the scan states; the database reads the container's own stage.
    expect(await verdict('p-tb16', hopper('L1', 'H1', 'BLEND_LA', chargeB))).toBe('EBMR-TAB-340 TB16-WRONG-BLEND');
    expect(await verdict('p-tb16', hopper('L1', 'H2', 'BLEND_LA', chargeA), { tamper: laxEntry('p-tb16', { layer: 'L1', hopper: 'H2', blend: 'BLEND_LA', chargeId: chargeA, chargedBy: me }, { verificationRequired: true }) })).toBe('EBMR-TAB-340 TB16-HOPPER');
    expect(await verdict('p-tb16', hopper('L1', 'H1', 'BLEND_LA', randomUUID()))).toBe('EBMR-TAB-340 TB16-CHARGE');
    expect(await verdict('p-tb16', hopper('L1', 'H1', 'BLEND_LA', chargeA), { tamper: laxEntry('p-tb16', { layer: 'L1', hopper: 'H1', blend: 'BLEND_LA', chargeId: chargeA, chargedBy: me }) })).toMatch(/^EBMR-TAB-340 .*second person/s);
    expect(await verdict('p-tb16', { kind: 'RUN_START', press: 'TEST-PRESS-X' }, { tamper: laxEntry('p-tb16', { press: 'TEST-PRESS-X', recordedBy: me }) })).toBe('EBMR-TAB-340 TB16-LAYER-UNCHARGED');
    expect(await verdict('p-tb16', hopper('L1', 'H1', 'BLEND_LA', chargeA))).toBe('ok');
    expect(await verdict('p-tb16', hopper('T', 'H2', 'BLEND_LB', chargeA))).toBe('EBMR-TAB-340 TB16-CHARGE');
    expect(await verdict('p-tb16', hopper('T', 'H2', 'BLEND_LB', chargeB))).toBe('ok');
    expect((await stateOf(sbx, d.runId)).steps['p-tb16@']?.['verificationRequired']).toBe(true);
    // A press in use for the batch but without its first-off: refused.
    const bare = await cleanUnit(sbx, d.runId, PRESS_CLASS);
    await startUse(sbx, await op(), bare.code, d.runId);
    expect(await verdict('p-tb16', { kind: 'RUN_START', press: bare.code })).toBe('EBMR-TAB-340 TB11-FIRST-OFF');
  });

  it('[IN-35][PR-29][DI-32] TB-16 layer checks: after the first-off the run starts; a layer-only sample is judged against the layer\'s own limits by the database (a forged pass is refused) and a failing one holds every container of the press since that layer\'s last passing check; the full tablets pass on their own stream; a check on an instrument without a use, readings never claimed, or a press that discharges its streams apart are refused', async () => {
    await pressApproved();
    expect(await verdict('p-tb16', { kind: 'RUN_START', press })).toBe('ok');
    expect(await verdict('p-tb16', sweep())).toBe('ok');
    const c1 = await open('COMPRESSION', press);
    await close(c1);
    // 1550 mg for 10 layer-only samples: 3.3 % above 150 mg, outside the layer's 3 % action limit.
    const failing = group('L1', '1550.0');
    expect(await verdict('p-tb16', failing, { tamper: quiet('p-tb16', TB16, [], (x) => ({ ...x, result: 'PASS' })) })).toMatch(/^EBMR-TAB-340 .*result/s);
    expect(await verdict('p-tb16', failing, { tamper: quiet('p-tb16', TB16, ['IPC_CHECK_FAILED']) })).toMatch(/^EBMR-TAB-340 .*IPC_CHECK_FAILED/s);
    expect(await verdict('p-tb16', { ...failing, stream: 'R' }, { tamper: laxEntry('p-tb16', {}) })).toBe('EBMR-TAB-340 TB16-STREAM');
    expect(await verdict('p-tb16', failing)).toBe('ok');
    expect((await entryData('p-tb16@', 'WEIGHT_CHECK'))).toMatchObject({ stream: 'L1', result: 'FAIL' });
    expect((await checks(press)).map((x) => x.join(' '))).toEqual(['T PASS', 'L1 FAIL']);
    expect(await state(c1)).toBe('HELD');
    // The full tablets are judged against their own limits (4010 mg for 10 is 0.25 % above 400 mg: within 2 %).
    expect(await verdict('p-tb16', group('T', '4010.0'))).toBe('ok');
    expect((await checks(press)).at(-1)).toEqual(['T', 'PASS']);
    expect(await directPass(press, 'L1')).toBe('EBMR-TAB-302');
    expect(await verdict('p-tb16', group('L1', '1500.0', { instrument: 'TEST-BAL-09' }))).toBe('EBMR-TAB-340 TB16-INSTRUMENT');
    expect(await verdict('p-tb16', group('L1', '1500.0', { capture: 'DEVICE', readings: [randomUUID()] }))).toBe('EBMR-TAB-340 TB16-DEVICE');
    await asSteward('select plant.configure_press_discharge($1, true) as r', [press]);
    expect(await verdict('p-tb16', group('L1', '1500.0'))).toBe('EBMR-TAB-340 TB16-DISCHARGE');
    await asSteward('select plant.configure_press_discharge($1, false) as r', [press]);
    expect(await verdict('p-tb16', group('L1', '1500.0'))).toBe('ok');
    expect((await checks(press)).at(-1)).toEqual(['L1', 'PASS']);
    expect(await types('p-tb16@')).toEqual(['IPC_CHECK_FAILED', 'IPC_MANUAL_ENTRY', 'IPC_MANUAL_ENTRY', 'IPC_MANUAL_ENTRY', 'IPC_MANUAL_ENTRY']);
  });

  it('[IN-35][PR-29] TB-16 closes only after the run ended with the sweep and an end-of-run check of every planned test of every layer (read on the run\'s state)', async () => {
    expect(await verdict('p-tb16', { kind: 'RUN_END' })).toBe('ok');
    const c = await content();
    const closing = async () => {
      const old = await stateOf(sbx, d.runId);
      const done = structuredClone(old);
      (done.steps['p-tb16@'] as Json)['status'] = 'AWAITING_VERIFICATION';
      return sql<string>('select tab.forming_close_problem($1, $2, $3) as r', [c, old, done]);
    };
    expect(await closing()).toMatch(/TB11-END-CHECK/);
    expect(await verdict('p-tb16', group('L1', '1500.0'))).toBe('ok');
    expect(await verdict('p-tb16', group('T', '4000.0'))).toBe('ok');
    expect(await closing()).toMatch(/TB11-END-CHECK/);
    expect(await verdict('p-tb16', phys(['LAMINATION']))).toBe('ok');
    expect(await entryData('p-tb16@', 'PHYSICAL_CHECK')).toMatchObject({ stream: 'T', result: 'FAIL' });
    expect((await checks(press)).at(-1)).toEqual(['T', 'FAIL']);
    expect(await closing()).toBeNull();
    const noSweep = await stateOf(sbx, d.runId);
    const forged = structuredClone(noSweep);
    (forged.steps['p-tb16@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    for (const [k, e] of Object.entries(forged.entries)) if (e['kind'] === 'STATION_SWEEP' && e['stepKey'] === 'p-tb16@') delete forged.entries[k];
    expect(await sql('select tab.forming_close_problem($1, $2, $3) as r', [c, noSweep, forged])).toMatch(/TB11-NO-SWEEP/);
  });

  it('[IN-35][PR-29] TB-16 missed checks at database time, layer by layer: the sweeper alarms every layer\'s overdue check and holds the press\'s containers for that layer\'s stream; the next entry must list them all with IPC_CHECK_MISSED', async () => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb16m@' });
    expect(await verdict('p-tb16m', { kind: 'HOPPER_CHARGE', layer: 'L1', hopper: 'H1', blend: 'BLEND_LA', chargeId: await charged('BLEND_LA') })).toBe('ok');
    expect(await verdict('p-tb16m', { kind: 'HOPPER_CHARGE', layer: 'T', hopper: 'H2', blend: 'BLEND_LB', chargeId: await charged('BLEND_LB') })).toBe('ok');
    expect(await verdict('p-tb16m', { kind: 'RUN_START', press })).toBe('ok');
    const before = (await checks(press)).length;
    await wait(3_500);
    const sweeper = { ...(await openServiceSession(sbx.db, sbx.seed, 'sweeper')), correlationId: randomUUID() };
    const alarms = (await recordIpcOverdue(sbx.built.ctx, sweeper)).filter((a) => a.batchId === d.runId && a.stepKey === 'p-tb16m@');
    expect(alarms.map((m) => [m.stream, m.test])).toEqual([['L1', 'WEIGHT'], ['T', 'WEIGHT'], ['T', 'PHYSICAL'], ['T', 'SWEEP']]);
    expect((await checks(press)).slice(before).map((x) => x.join(' '))).toEqual(['L1 MISSED', 'T MISSED', 'T MISSED', 'T MISSED']);
    const forged = quiet('p-tb16m', TB16, ['IPC_CHECK_MISSED'], (x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'missed')));
    expect(await verdict('p-tb16m', sweep(), { tamper: forged })).toMatch(/^EBMR-TAB-340 .*missed/s);
    expect(await verdict('p-tb16m', sweep())).toBe('ok');
    expect(((await entryData('p-tb16m@', 'STATION_SWEEP'))['missed'] as Json[]).map((m) => `${String(m['stream'])} ${String(m['test'])}`)).toEqual(['L1 WEIGHT', 'T WEIGHT', 'T PHYSICAL', 'T SWEEP']);
    expect(await types('p-tb16m@')).toContain('IPC_CHECK_MISSED');
    void held;
    void strip;
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
