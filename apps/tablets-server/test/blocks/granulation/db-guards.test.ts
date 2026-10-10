/**
 * Phase 3 slice 3b (builder B): the granulation blocks' rules held by the database (tablets 0850, 0851), proven as the
 * application role past the server: an honest entry the engine builds is stored; the same act through a tampered block
 * handler (a forged engine: the rule skipped, the data or the exception changed) is refused by the database alone.
 * The time rules (use-by, minimum times) are judged at the row's database time. Rules about closing a step, computed
 * items and the loop bound are read through their functions on the run's real state, forged where the test says so.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, withCommand } from '@ebmr/kernel';
import { GRANULATION_TAGS } from '@ebmr/integration-sdk/process';
import { actorOfBrowser } from '../../esig/support.ts';
import { codeOf } from '../../execution/db-guards-support.ts';
import { importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../../execution/support.ts';
import { adminActor, enrol, fakeGateway, type FakeGateway } from '../../devices/support.ts';
import { GRANULATION_BLOCK_VERSIONS } from '../../../src/blocks/granulation/index.ts';
import { fakeTimers, granulationMbr, lastEntry, laxEntry, recorder, stateOf, type Entry } from './db-support.ts';

type Json = Record<string, unknown>;

let sbx: ExecServer;
let d: RunDriver;
let rec: ReturnType<typeof recorder>;
let me: string;
let gw: FakeGateway | undefined;

const advance = (): void => {
  vi.advanceTimersByTime(7_000);
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The database's answer for an act: 'ok', or the EBMR code and the block rule code it names. */
async function verdict(step: string, entry: Entry, opts: Parameters<typeof rec.message>[2] = {}): Promise<string> {
  const m = await rec.message(step, entry, opts);
  if (m === 'ok') return m;
  const code = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(m)?.[1] ?? '?';
  const rule = /\((?:[^()]*; )?(TB0\d-[A-Z0-9-]+)\)/.exec(m)?.[1] ?? /(TB0\d-[A-Z0-9-]+)/.exec(m)?.[1];
  return rule ? `${code} ${rule}` : `${code} ${m.slice(0, 300)}`;
}

async function sql<T>(text: string, params: unknown[]): Promise<T | null> {
  const { rows } = await sbx.db.admin.query<{ r: T | null }>(text, params);
  return rows[0]?.r ?? null;
}

const content = (): Promise<Json | null> => sql<Json>('select recipe.batch_mbr_content($1) as r', [d.runId]);

beforeAll(async () => {
  sbx = await startExecServer();
  fakeTimers();
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, granulationMbr()));
  d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1') });
  d.beforeTap = advance;
  rec = recorder(sbx, d, advance);
  me = personaIn(sbx, 'operator1').personId;
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await gw?.close();
  await sbx?.close();
});

describe('the granulation blocks in the database (tablets 0850, 0851)', () => {
  it('[DI-30][DI-05] the database holds the data schemas of TB-02, TB-03, TB-04, TB-05 and TB-07 as the block registry declares them (G-06 kinds unchanged), their block types and rule codes, and the granulation tags of the integration SDK; nothing can change them', async () => {
    const { rows } = await sbx.db.admin.query<{ k: string; schema: Json }>(
      "select block_type || '@' || block_version || ' ' || entry_kind as k, schema from recipe.block_data_schema where block_type in ('TB-02', 'TB-03', 'TB-04', 'TB-05', 'TB-07')",
    );
    const want: Record<string, Json> = {};
    for (const b of GRANULATION_BLOCK_VERSIONS) for (const [k, s] of Object.entries(b.dataSchema?.entries ?? {})) want[`${b.type}@${b.version} ${k}`] = schemaJson(s as unknown as { type: string } & Json);
    expect(Object.fromEntries(rows.map((r) => [r.k, r.schema]))).toEqual(want);
    const g06 = await sbx.db.admin.query<{ schema: Json }>("select schema from recipe.block_data_schema where block_type = 'G-06' and entry_kind = 'ACTUAL'");
    expect(want['TB-04@1 ACTUAL']).toEqual(g06.rows[0]?.schema);
    // Every rule code of the five blocks' sources is a name a test run's record may hold (recipe-core 0346).
    const src = ['tb-02', 'tb-03', 'tb-04', 'tb-05', 'tb-07'].map((f) => readFileSync(new URL(`../../../src/blocks/${f}.ts`, import.meta.url), 'utf8')).join('\n');
    const codes = [...new Set([...src.matchAll(/'(TB0\d(?:-[A-Z0-9]+)+)'/g)].map((m) => m[1] ?? ''))];
    const named = (await sbx.db.admin.query<{ name: string }>("select name from recipe.engine_name where name like 'TB0%' or name in ('TB-02', 'TB-03', 'TB-04', 'TB-05', 'TB-07')")).rows.map((r) => r.name);
    expect(codes.filter((c) => !named.includes(c))).toEqual([]);
    expect(named).toEqual(expect.arrayContaining(['TB-02', 'TB-03', 'TB-04', 'TB-05', 'TB-07']));
    const tags = await sbx.db.admin.query<{ tag: string; equipment_kind: string; unit: string; scale: number; counter: boolean; setpoint: boolean }>(
      "select tag, equipment_kind, unit, scale, counter, setpoint from tab.process_tag where equipment_kind in ('GRANULATOR', 'DRYER', 'BLENDER') order by tag",
    );
    expect(tags.rows).toEqual(
      [...GRANULATION_TAGS].sort((a, b) => (a.tag < b.tag ? -1 : 1)).map((t) => ({ tag: t.tag, equipment_kind: t.equipment, unit: t.unit, scale: t.scale, counter: t.counter, setpoint: t.setpoint })),
    );
    await expect(sbx.db.admin.query("update recipe.block_data_schema set schema = '{\"type\": \"object\", \"fields\": {}}' where block_type = 'TB-02'")).rejects.toThrow(/EBMR-AUDIT-004/);
    await expect(sbx.db.app.query("insert into recipe.engine_name (name, kind) values ('TB09-X', 'RULE_CODE')")).rejects.toThrow(/permission denied/);
  });

  it('[IN-36][INV-24][PR-23] TB-02: a material pass only through a screen checked intact before use, a screen only with its approved aperture; an after-use check that finds the screen damaged holds exactly the passes since its last intact check, with the exception that waits for a deviation; a damaged screen is never checked or used again; the step never closes without the after-use check', async () => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb02@' });
    const aperture = { value: '425', unit: 'um' };
    const pass = (n: string) => ({ kind: 'MATERIAL_PASS', screen: 'SCR-40', material: 'BOM-PCM', quantityIn: { value: n, unit: 'kg' }, quantityOut: { value: n, unit: 'kg' }, oversize: { value: '0.000', unit: 'kg' }, foreignMatter: false });
    const passData = (n: string) => ({ ...pass(n), kind: undefined, recordedBy: me });
    const strip = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([k, v]) => k !== 'kind' && v !== undefined));
    // A pass before any check, and a check of the screen at another aperture, through a forged engine.
    expect(await verdict('p-tb02', pass('10.000'), { tamper: laxEntry('p-tb02', strip(passData('10.000'))) })).toBe('EBMR-EXE-250 TB02-NO-PRE-CHECK');
    const wrong = { kind: 'SCREEN_CHECK', screen: 'SCR-40', aperture: { value: '500', unit: 'um' }, when: 'BEFORE', result: 'INTACT' };
    expect(await verdict('p-tb02', wrong, { tamper: laxEntry('p-tb02', { ...strip(wrong), checkedBy: me }, { verificationRequired: true }) })).toBe('EBMR-EXE-250 TB02-APERTURE');
    const check = (when: string, result: string) => ({ kind: 'SCREEN_CHECK', screen: 'SCR-40', aperture, when, result });
    expect(await verdict('p-tb02', check('BEFORE', 'INTACT'))).toBe('ok');
    expect(await verdict('p-tb02', pass('12.500'))).toBe('ok');
    expect(await verdict('p-tb02', pass('30.000'))).toBe('ok');
    const passes = Object.values((await stateOf(sbx, d.runId)).entries).filter((e) => e['kind'] === 'MATERIAL_PASS').map((e) => e['id']);
    // The after-use check found damaged: forged without the held passes, then without its exception.
    const damaged = check('AFTER', 'DAMAGED');
    expect(await verdict('p-tb02', damaged, { tamper: laxEntry('p-tb02', { ...strip(damaged), checkedBy: me }, { verificationRequired: true }) })).toMatch(/^EBMR-EXE-250 .*held/s);
    expect(await verdict('p-tb02', damaged, { tamper: laxEntry('p-tb02', { ...strip(damaged), held: passes.slice(1), checkedBy: me }, { verificationRequired: true }) })).toMatch(/^EBMR-EXE-250 .*held/s);
    expect(await verdict('p-tb02', damaged, { tamper: laxEntry('p-tb02', { ...strip(damaged), held: passes, checkedBy: me }, { verificationRequired: true }) })).toMatch(/^EBMR-EXE-250 .*SCREEN_INTEGRITY_FAILED/s);
    expect(await verdict('p-tb02', damaged)).toBe('ok');
    const s = await stateOf(sbx, d.runId);
    const after = Object.values(s.entries).find((e) => e['kind'] === 'SCREEN_CHECK' && (e['data'] as Json)['when'] === 'AFTER') as Json;
    expect((after['data'] as Json)['held']).toEqual(passes);
    const ex = Object.values(s.exceptions).find((e) => e['type'] === 'SCREEN_INTEGRITY_FAILED') as Json;
    expect([ex['severity'], ex['deviationRequired'], (ex['block'] as Json)['until']]).toEqual(['ACTION', true, 'DEVIATION']);
    expect((s.steps['p-tb02@'] as Json)['verificationRequired']).toBe(true);
    // The damaged screen is never checked again (the engine refuses too; here the forged engine).
    const again = check('BEFORE', 'INTACT');
    expect(await verdict('p-tb02', again, { tamper: laxEntry('p-tb02', { ...strip(again), checkedBy: me }, { verificationRequired: true }) })).toBe('EBMR-EXE-250 TB02-SCREEN-DAMAGED');
    // Closing without the after-use check (IN-36 catalogue test): the honest state with the AFTER check taken out.
    const c = await content();
    const old = await stateOf(sbx, d.runId);
    const closed = structuredClone(old);
    (closed.steps['p-tb02@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.granulation_close_problem($1, $2, $3) as r', [c, old, closed])).toBeNull();
    delete closed.entries[String(after['id'])];
    expect(await sql('select tab.granulation_close_problem($1, $2, $3) as r', [c, old, closed])).toMatch(/screen SCR-40 has no check after use \(TB02-AFTER-CHECK-MISSING\)/);
  });

  it('[IN-36][PR-30][IN-13] TB-03 and TB-04: a binder solution\'s use-by starts at its preparation (database time); an addition is refused once the use-by has passed at the row\'s database time, or when it would use more than was prepared, or names no preparation of the batch; a forged use-by is refused; the solution step closes', async () => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb03@' });
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb04@' });
    const prepared = { kind: 'PREPARED', quantity: { value: '4.000', unit: 'kg' }, appearance: 'COMPLIES' };
    const forged = { quantity: { value: '4.000', unit: 'kg' }, appearance: 'COMPLIES', preparedAtUs: '0', useByUs: '99999999999999999', preparedBy: me };
    expect(await verdict('p-tb03', prepared, { tamper: laxEntry('p-tb03', forged) })).toMatch(/^EBMR-EXE-250 .*preparedAtUs/s);
    expect(await verdict('p-tb03', prepared)).toBe('ok');
    const prep = await lastEntry(sbx, d.runId, 'p-tb03@', 'PREPARED');
    const data = (await stateOf(sbx, d.runId)).entries[prep]?.['data'] as Json;
    expect(BigInt(String(data['useByUs'])) - BigInt(String(data['preparedAtUs']))).toBe(3_000_000n);
    const add = (q: string, preparation = prep) => ({ kind: 'BINDER_ADDITION', preparation, quantity: { value: q, unit: 'kg' } });
    expect(await verdict('p-tb04', add('2.000'))).toBe('ok');
    // The engine sees only its own step: these two are the database's alone.
    expect(await verdict('p-tb04', add('2.500'))).toBe('EBMR-EXE-250 TB04-BINDER-OVERUSE');
    expect(await verdict('p-tb04', add('0.500', 'EN-1'))).toBe('EBMR-EXE-250 TB04-BINDER-PREPARATION');
    await wait(3_200);
    expect(await verdict('p-tb04', add('0.500'))).toBe('EBMR-EXE-250 TB04-BINDER-EXPIRED');
    // The solution step closes once prepared (honest perform and check over HTTP).
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-tb03@' });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: 'p-tb03@', meaning: 'VERIFIED' });
    expect((await stateOf(sbx, d.runId)).steps['p-tb03@']?.['status']).toBe('COMPLETED');
  });

  it('[IN-36][IN-13] TB-04 time end point: the massing time is measured between the entries at database time; an end point before the minimum, or one stating another time, is refused', async () => {
    expect(await verdict('p-tb04', { kind: 'MASSING_START' })).toBe('ok');
    const forged = { criterion: 'TIME', value: '75.000000', unit: 's', withinRange: true, recordedBy: me };
    expect(await verdict('p-tb04', { kind: 'END_POINT' }, { tamper: laxEntry('p-tb04', forged) })).toBe('EBMR-EXE-250 TB04-ENDPOINT-EARLY');
    await wait(1_100);
    expect(await verdict('p-tb04', { kind: 'END_POINT' }, { tamper: laxEntry('p-tb04', forged) })).toMatch(/^EBMR-EXE-250 .*value/s);
    expect(await verdict('p-tb04', { kind: 'END_POINT' })).toBe('ok');
    const e = (await stateOf(sbx, d.runId)).entries[await lastEntry(sbx, d.runId, 'p-tb04@', 'END_POINT')]?.['data'] as Json;
    expect([e['criterion'], e['unit'], e['withinRange']]).toEqual(['TIME', 's', true]);
    expect(Number(e['value'])).toBeGreaterThanOrEqual(1);
  });

  it('[DI-31][DI-32][IN-36] TB-04 power end point: the granulator\'s value stands on the claimed reading of the step\'s bound device (tablets 0820, G-06), and the end point on that usable value of the end-point tag, exactly; a TB-03 step cannot be bound to a device', async () => {
    const chain = await enrol(sbx);
    const serial = 'RMG-0001';
    const device = 'TEST-RMG-01';
    const site = (await sbx.db.admin.query<{ s: string }>("select site_code as s from iam.device where code = 'TEST-BAL-01'")).rows[0]?.s ?? null;
    await identity.withGuardedCommand(sbx.db.app, await adminActor(sbx), async (c) => {
      await c.query('select iam.register_device($1, $2, $3, $4, $5, $6, $7)', [device, 'INSTRUMENT', site, 'DISP-1', null, createHash('sha256').update(`${device}:${randomUUID()}`).digest('hex'), 'High-shear granulator (test) behind the site gateway']);
      await c.query('select tab.bind_process_device($1, $2, $3, $4)', [chain, device, serial, 'GRANULATOR']);
    });
    gw = await fakeGateway(sbx);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb04g@' });
    advance();
    const op = async () => actorOfBrowser(sbx, d.browser('operator1'), 'operator1');
    expect(await codeOf(withCommand(sbx.db.app, await op(), (c) => c.query('select tab.bind_step_device($1, $2, $3)', [d.runId, 'p-tb03', device])))).toBe('EBMR-DEV-130');
    advance();
    await withCommand(sbx.db.app, await op(), (c) => c.query('select tab.bind_step_device($1, $2, $3)', [d.runId, 'p-tb04g', device]));
    const session = randomUUID();
    const sent = await gw.post('/gw/v1/process-readings', { sessionId: session, readings: [{ deviceSerial: serial, tag: 'granulator.power_kW', value: '4.20', unit: 'kW', quality: 'GOOD', sourceTime: '1790584618000000', sequence: '1', kind: 'ACTUAL' }] });
    expect(sent.status).toBe(200);
    const r = (await sbx.db.admin.query<{ id: string; received_us: string }>('select id, received_us::text from tab.process_reading where serial = $1', [serial])).rows[0] as { id: string; received_us: string };
    const actual = { kind: 'ACTUAL', tag: 'granulator.power_kW', value: '4.20', unit: 'kW', source: 'EQUIPMENT', readingId: r.id, quality: 'GOOD', receivedAtUs: r.received_us };
    const claim = (c: PoolClient) => c.query('select tab.claim_process_reading($1, $2, $3)', [r.id, d.runId, 'p-tb04g']).then(() => undefined);
    expect(await verdict('p-tb04g', { ...actual, value: '4.30' }, { before: claim })).toMatch(/^EBMR-EXE-211/);
    expect(await verdict('p-tb04g', actual, { before: claim })).toBe('ok');
    const id = await lastEntry(sbx, d.runId, 'p-tb04g@', 'ACTUAL');
    const want = { criterion: 'POWER', actual: id, value: '4.20', unit: 'kW', withinRange: true, recordedBy: me };
    expect(await verdict('p-tb04g', { kind: 'END_POINT', actual: id }, { tamper: laxEntry('p-tb04g', { ...want, value: '4.40' }) })).toMatch(/^EBMR-EXE-250 .*value/s);
    expect(await verdict('p-tb04g', { kind: 'END_POINT', actual: 'EN-1' }, { tamper: laxEntry('p-tb04g', { ...want, actual: 'EN-1' }) })).toBe('EBMR-EXE-250 TB04-ENDPOINT-VALUE');
    expect(await verdict('p-tb04g', { kind: 'END_POINT', actual: id })).toBe('ok');
  });

  it('[IN-36][PR-27] TB-05: a filter bag last used for another product is refused without its wash record (IN-36 catalogue test), drying starts only after the bag check, the drying time is measured; the drying loop never runs beyond its maximum iterations', async () => {
    const key = 'p-tb05@L-DRY=1';
    const frames = [{ construct: 'L-DRY', index: 1 }];
    await d.ok('operator1', { type: 'START_STEP', stepKey: key });
    expect(await verdict('p-tb05', { kind: 'DRYING_START' }, { frames, tamper: laxEntry('p-tb05', { startedBy: me }) })).toBe('EBMR-EXE-250 TB05-BAG-UNCHECKED');
    const bag = { kind: 'BAG_CHECK', bag: 'TEST-BAG-07', when: 'BEFORE', result: 'INTACT', lastProduct: 'TEST-OTHER-PRODUCT' };
    expect(await verdict('p-tb05', bag, { frames, tamper: laxEntry('p-tb05', { bag: 'TEST-BAG-07', when: 'BEFORE', result: 'INTACT', lastProduct: 'TEST-OTHER-PRODUCT', checkedBy: me }) })).toBe('EBMR-EXE-250 TB05-BAG-WASH');
    expect(await verdict('p-tb05', { ...bag, washRecord: 'TEST-WASH-0007' }, { frames })).toBe('ok');
    expect(await verdict('p-tb05', { kind: 'DRYING_START' }, { frames })).toBe('ok');
    expect(await verdict('p-tb05', { kind: 'DRYING_END' }, { frames, tamper: laxEntry('p-tb05', { dryingSeconds: '1500.000000', endedBy: me }) })).toMatch(/^EBMR-EXE-250 .*dryingSeconds/s);
    expect(await verdict('p-tb05', { kind: 'DRYING_END' }, { frames })).toBe('ok');
    expect(await verdict('p-tb05', { kind: 'LOD_SAMPLE', analyser: 'TEST-MA-02', sampleMass: { value: '5.012', unit: 'g' } }, { frames })).toBe('ok');
    // The loop bound (DI-34): the run's state, and the same with the step in a third iteration of a loop of two.
    const c = await content();
    const s = await stateOf(sbx, d.runId);
    expect(await sql('select tab.granulation_loop_problem($1, $2) as r', [c, s])).toBeNull();
    const third = structuredClone(s);
    third.steps['p-tb05@L-DRY=3'] = { ...(s.steps[key] as Json), key: 'p-tb05@L-DRY=3', frames: [{ construct: 'L-DRY', index: 3 }] };
    expect(await sql('select tab.granulation_loop_problem($1, $2) as r', [c, third])).toMatch(/iteration 3 of loop L-DRY, beyond its maximum of 2 iterations \(TB05-LOOP-BOUND\)/);
  });

  it('[IN-36][IN-13][PR-29][INV-25] TB-07: the main blend ends no earlier than its minimum (database time), the lubricant only after it, BU samples only of the plan after blending and in 1 to 3 unit doses unless justified; the blend time item is the block\'s measured value, never typed; the step closes only with every planned sample or the missing ones flagged, and its honest close stores the computed time', async () => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb07@' });
    expect(await verdict('p-tb07', { kind: 'BLEND_START' })).toBe('ok');
    const lube = { kind: 'LUBRICANT_ADDED', quantity: { value: '0.250', unit: 'kg' } };
    expect(await verdict('p-tb07', lube, { tamper: laxEntry('p-tb07', { quantity: { value: '0.250', unit: 'kg' }, addedBy: me }) })).toBe('EBMR-EXE-250 TB07-LUBRICANT-EARLY');
    expect(await verdict('p-tb07', { kind: 'BLEND_END' }, { tamper: laxEntry('p-tb07', { seconds: '600.000000', withinLimits: true, recordedBy: me }) })).toBe('EBMR-EXE-250 TB07-BLEND-SHORT');
    await wait(1_100);
    expect(await verdict('p-tb07', { kind: 'BLEND_END' })).toBe('ok');
    expect(await verdict('p-tb07', lube)).toBe('ok');
    const sample = (location: string, mass: string, extra: Json = {}) => ({ kind: 'BU_SAMPLE', location, replicate: 1, mass: { value: mass, unit: 'mg' }, ...extra });
    const sampleData = (location: string, mass: string, inRange: boolean) => ({ location, replicate: 1, mass: { value: mass, unit: 'mg' }, withinDoseRange: inRange, sampledBy: me });
    expect(await verdict('p-tb07', sample('L1', '500'), { tamper: laxEntry('p-tb07', sampleData('L1', '500', true)) })).toBe('EBMR-EXE-250 TB07-BU-EARLY');
    await wait(1_100);
    expect(await verdict('p-tb07', { kind: 'LUBRICATION_END' })).toBe('ok');
    expect(await verdict('p-tb07', sample('L3', '500'), { tamper: laxEntry('p-tb07', sampleData('L3', '500', true)) })).toBe('EBMR-EXE-250 TB07-NOT-PLANNED');
    expect(await verdict('p-tb07', sample('L1', '800'), { tamper: laxEntry('p-tb07', sampleData('L1', '800', false)) })).toBe('EBMR-EXE-250 TB07-SAMPLE-SIZE');
    expect(await verdict('p-tb07', sample('L1', '800', { justification: 'Larger thief chamber at the bottom location' }))).toBe('ok');
    // The blend time item: the block's value from BLEND_END, as a BLOCK value naming it; a typed one is refused.
    const c = await content();
    const old = await stateOf(sbx, d.runId);
    const end = await lastEntry(sbx, d.runId, 'p-tb07@', 'BLEND_END');
    const seconds = String((old.entries[end]?.['data'] as Json)['seconds']);
    const point = (value: string, source: Json): Json => ({
      id: 'DP-900', item: 'blendSecs', stepKey: 'p-tb07@', step: 'p-tb07', frames: [], attempt: 1, version: 1, kind: 'VALUE', value: { kind: 'DECIMAL', value, unit: 's' }, source,
      enteredBy: me, recordedAt: { $u: '1' }, recordedSeq: 1, timeBasis: 'RECORDED_AT', status: 'VALID', failed: false, flags: [], exceptions: [],
    });
    const withPoint = (p: Json) => ({ ...old, points: { ...old.points, 'DP-900': p } });
    expect(await sql('select tab.granulation_computed_problem($1, $2, $3) as r', [c, old, withPoint(point(seconds, { mode: 'BLOCK', entries: [end] }))])).toBeNull();
    expect(await sql('select tab.granulation_computed_problem($1, $2, $3) as r', [c, old, withPoint(point('600', { mode: 'MANUAL' }))])).toMatch(/TB07-TIME-COMPUTED/);
    expect(await sql('select tab.granulation_computed_problem($1, $2, $3) as r', [c, old, withPoint(point('600', { mode: 'BLOCK', entries: [end] }))])).toMatch(/TB07-TIME-COMPUTED/);
    // The weighing rule (recipe-core 0322, EBMR-EXE-138) leaves out only that item; any other block value at the step is
    // still a weighing total (tablets 0852).
    expect(await sql('select recipe.weighing_totals_problem($1, $2, $3) as r', [old, withPoint(point(seconds, { mode: 'BLOCK', entries: [end] })), c])).toBeNull();
    const other = { ...point('600', { mode: 'BLOCK', entries: [end] }), item: 'pcmDispensed', value: { kind: 'DECIMAL', value: '600', unit: 'kg' } };
    expect(await sql('select recipe.weighing_totals_problem($1, $2, $3) as r', [old, withPoint(other), c])).toMatch(/which no weighing of its step counts into/);
    // Closing with location L2 not sampled: only with BU_LOCATION_MISSING raised.
    const closed = structuredClone(old);
    (closed.steps['p-tb07@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.granulation_close_problem($1, $2, $3) as r', [c, old, closed])).toMatch(/BU_LOCATION_MISSING was not raised/);
    closed.exceptions['EX-900'] = { id: 'EX-900', type: 'BU_LOCATION_MISSING', source: { stepKey: 'p-tb07@', step: 'p-tb07', frames: [] } };
    expect(await sql('select tab.granulation_close_problem($1, $2, $3) as r', [c, old, closed])).toBeNull();
    // The honest close over HTTP: the blend time computed by the block from BLEND_END (judged against its tier), the
    // missing location flagged, the step waiting for its check.
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-tb07@' });
    const done = await stateOf(sbx, d.runId);
    const computed = Object.values(done.points).find((x) => x['item'] === 'blendSecs') as Json;
    expect([computed['source'], (computed['value'] as Json)['value']]).toEqual([{ mode: 'BLOCK', entries: [end] }, seconds]);
    expect(Object.values(done.exceptions).filter((x) => x['type'] === 'BU_LOCATION_MISSING').map((x) => (x['source'] as Json)['stepKey'])).toEqual(['p-tb07@']);
    expect(done.steps['p-tb07@']?.['status']).toBe('AWAITING_VERIFICATION');
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
