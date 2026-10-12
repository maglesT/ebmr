/**
 * Phase 3 slice 3c (builder A): the compression blocks' registers and rules held by the database (tablets 0870 to 0874),
 * proven as the application role past the server: the tooling register (inspection, issue, return with the press's
 * stroke count), the detector challenges, the step device as the plant unit of its equipment use, the interface-loss
 * job; and each TB-09, TB-10 and TB-17 entry against the register row it names: an honest entry is stored, the same act
 * through a tampered block handler (a forged engine) or naming another row is refused by the database alone.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { openPersonaSession, openServiceSession } from '@ebmr/test-kit';
import { actorOfBrowser } from '../../esig/support.ts';
import { codeOf, verifyTypedNet } from '../../execution/db-guards-support.ts';
import { importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../../execution/support.ts';
import { adminActor, enrol, fakeGateway, type FakeGateway } from '../../devices/support.ts';
import { COMPRESSION_BLOCK_VERSIONS } from '../../../src/blocks/compression/index.ts';
import { recordInterfaceLosses } from '../../../src/features/execution/sweeper.ts';
import { lastEntry, laxEntry, recorder, stateOf, type Entry } from '../granulation/db-support.ts';
import { compressionMbr, PIECES, PRESS_CLASS, SPEC } from './db-support.ts';
import { asSetup, cleanUnit, linkDevice, startUse, type PressUnit } from './plant-support.ts';

type Json = Record<string, unknown>;

const DEVICE = 'TEST-PRESS-3C';
const SERIAL = 'PRESS-3C-0001';
const DEVICE_B = 'TEST-PRESS-3C-B';
const SERIAL_B = 'PRESS-3C-0002';
const COUNTS = { upper: '27', lower: '27', dies: '27' };
const ITEMS = ['TIPS', 'EDGES', 'WEAR', 'EMBOSSING', 'CORROSION', 'CLEANLINESS'];
const findings = (ok = true): Json => Object.fromEntries(ITEMS.map((k, i) => [k, ok || i > 0]));

let sbx: ExecServer;
let d: RunDriver;
let rec: ReturnType<typeof recorder>;
let me: string;
let gw: FakeGateway | undefined;
let product: string;
let press: PressUnit;
let other: { id: string; code: string; classCode: string };
const ids: Record<string, string> = {};

const advance = (): void => {
  vi.advanceTimersByTime(7_000);
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const op = async (): Promise<ActorContext> => {
  advance();
  return actorOfBrowser(sbx, d.browser('operator1'), 'operator1');
};

/** A function call as operator1 in a validated command; its result (column r). */
async function asOp<T = Json>(sql: string, params: unknown[]): Promise<T> {
  return withCommand(sbx.db.app, await op(), async (c) => (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T);
}

async function asSteward<T = Json>(sql: string, params: unknown[]): Promise<T> {
  const steward = await openPersonaSession(sbx.db, sbx.seed, 'steward');
  return withCommand(sbx.db.app, { ...steward, correlationId: randomUUID() }, async (c) => (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T);
}

/** The database's answer for an entry: 'ok', or the EBMR code and the block rule code it names. */
async function verdict(step: string, entry: Entry, opts: Parameters<typeof rec.message>[2] = {}): Promise<string> {
  const m = await rec.message(step, entry, opts);
  if (m === 'ok') return m;
  const code = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(m)?.[1] ?? '?';
  const rule = /\((?:[^()]*; )?(TB(?:09|10|17)-[A-Z0-9-]+)[;)]/.exec(m)?.[1] ?? /(TB(?:09|10|17)-[A-Z0-9-]+)/.exec(m)?.[1];
  return rule ? `${code} ${rule}` : `${code} ${m.slice(0, 400)}`;
}

async function sql<T>(text: string, params: unknown[]): Promise<T | null> {
  const { rows } = await sbx.db.admin.query<{ r: T | null }>(text, params);
  return rows[0]?.r ?? null;
}
const content = (): Promise<Json | null> => sql<Json>('select recipe.batch_mbr_content($1) as r', [d.runId]);
const strip = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'kind'));

async function registerDevice(code: string, serial: string, chain: string): Promise<void> {
  const site = (await sbx.db.admin.query<{ s: string }>("select site_code as s from iam.device where code = 'TEST-BAL-01'")).rows[0]?.s ?? null;
  await identity.withGuardedCommand(sbx.db.app, await adminActor(sbx), async (c) => {
    await c.query('select iam.register_device($1, $2, $3, $4, $5, $6, $7)', [code, 'INSTRUMENT', site, 'DISP-1', null, createHash('sha256').update(`${code}:${randomUUID()}`).digest('hex'), 'Tablet press (test) behind the site gateway']);
    await c.query('select tab.bind_process_device($1, $2, $3, $4)', [chain, code, serial, 'PRESS']);
  });
}

const seqs: Record<string, number> = {};
async function strokes(value: string, serial = SERIAL): Promise<void> {
  seqs[serial] = (seqs[serial] ?? 0) + 1;
  const r = await gw?.post('/gw/v1/process-readings', { sessionId: randomUUID(), readings: [{ deviceSerial: serial, tag: 'stroke.count', value, unit: 'count', quality: 'GOOD', sourceTime: '1790584618000000', sequence: String(seqs[serial]), kind: 'ACTUAL' }] });
  expect(r?.status).toBe(200);
}

const bind = async (step: string, device: string) => codeOf(withCommand(sbx.db.app, await op(), (c) => c.query('select tab.bind_step_device($1, $2, $3)', [d.runId, step, device])));
const inspect = (set: string, kind: string, issue: string | null, f: Json, disposition: string | null) =>
  asOp<{ inspectionId: string; result: string; hold: Json | null }>('select tab.inspect_tooling($1, $2, $3, $4, $5) as r', [set, kind, issue, f, disposition]);
const issue = (set: string, counts: Json = COUNTS) => asOp<{ issueId: string }>('select tab.issue_tooling($1, $2, $3, $4) as r', [set, d.runId, press.code, counts]);

function toolingSet(code: string, extra: Json = {}): Json {
  return { code, product, ...SPEC, tips: '1', upperPunches: '27', lowerPunches: '27', dies: '27', strokeLimit: '100000', ...extra };
}

beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, compressionMbr()));
  d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1') });
  d.beforeTap = advance;
  rec = recorder(sbx, d, advance);
  me = personaIn(sbx, 'operator1').personId;
  product = (await sql<string>("select recipe.batch_product($1) ->> 'code' as r", [runId])) ?? '';
  const chain = await enrol(sbx);
  await registerDevice(DEVICE, SERIAL, chain);
  await registerDevice(DEVICE_B, SERIAL_B, chain);
  gw = await fakeGateway(sbx);
  for (const s of ['p-tb09i@', 'p-tb10@', 'p-tb17@', 'p-tb09r@']) await d.ok('operator1', { type: 'START_STEP', stepKey: s });
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await gw?.close();
  await sbx?.close();
});

describe('the compression blocks in the database (tablets 0870 to 0874)', () => {
  it('[DI-30][DI-05] the database holds the data schemas of TB-09, TB-10 and TB-17 as the block registry declares them (G-06 kinds unchanged), their block types and rule codes, and the block types that run on a process device; nothing can change them', async () => {
    const { rows } = await sbx.db.admin.query<{ k: string; schema: Json }>(
      "select block_type || '@' || block_version || ' ' || entry_kind as k, schema from recipe.block_data_schema where block_type in ('TB-09', 'TB-10', 'TB-17')",
    );
    const want: Record<string, Json> = {};
    for (const b of COMPRESSION_BLOCK_VERSIONS) for (const [k, s] of Object.entries(b.dataSchema?.entries ?? {})) want[`${b.type}@${b.version} ${k}`] = schemaJson(s as unknown as { type: string } & Json);
    expect(Object.fromEntries(rows.map((r) => [r.k, r.schema]))).toEqual(want);
    const src = ['tb-09', 'tb-10', 'tb-17'].map((f) => readFileSync(new URL(`../../../src/blocks/${f}.ts`, import.meta.url), 'utf8')).join('\n');
    const codes = [...new Set([...src.matchAll(/'(TB(?:09|10|17)(?:-[A-Z0-9]+)+)'/g)].map((m) => m[1] ?? ''))];
    const named = (await sbx.db.admin.query<{ name: string }>("select name from recipe.engine_name where name ~ '^TB(09|10|17)' or name in ('TB-09', 'TB-10', 'TB-17')")).rows.map((r) => r.name);
    expect(codes.filter((c) => !named.includes(c))).toEqual([]);
    expect(named).toEqual(expect.arrayContaining(['TB-09', 'TB-10', 'TB-17', 'TB09-SPEC', 'TB10-TOOLING', 'TB17-PIECES']));
    const types = (await sbx.db.admin.query<{ t: string }>('select block_type as t from tab.process_block_type order by 1')).rows.map((r) => r.t);
    expect(types).toEqual(expect.arrayContaining(['G-06', 'TB-04', 'TB-05', 'TB-07', 'TB-10', 'TB-17']));
    expect(types).not.toContain('TB-09');
    await expect(sbx.db.admin.query("delete from tab.process_block_type where block_type = 'TB-10'")).rejects.toThrow(/EBMR/);
    await expect(sbx.db.app.query("insert into tab.process_block_type values ('TB-99')")).rejects.toThrow(/permission denied/);
  });

  it('[PR-13][PR-16] the database never lets a Tablets edition step be skipped (TB-09, TB-10, TB-17 and every later TB block), even one the MBR marks skippable that moves no material', async () => {
    for (const type of ['TB-09', 'TB-10', 'TB-17', 'TB-24']) {
      const node = { kind: 'phase', id: 'p-x', block: { type, version: '1' }, config: { skippable: true }, records: [], consumes: [], produces: [], uses: [] };
      expect(await sql('select recipe.skip_problem($1::jsonb, $2::jsonb) as r', [JSON.stringify(await content()), JSON.stringify(node)]), type).toMatch(/never skipped/);
    }
    const generic = { kind: 'phase', id: 'p-x', block: { type: 'G-04', version: '1' }, config: { skippable: true }, records: [], computes: [], consumes: [], produces: [], uses: [] };
    expect(await sql('select recipe.skip_problem($1::jsonb, $2::jsonb) as r', [JSON.stringify(await content()), JSON.stringify(generic)])).toBeNull();
  });

  it('[PR-22][PR-23][INV-12][DI-31] review backlog #5 (slice 3a): a step runs on the process device of the plant unit of its equipment use: a device linked to no unit, a unit without an open use of the batch, or a unit of another class than the MBR binds is refused; a device is linked to a PROCESS unit once, by the system administrator only', async () => {
    expect(await bind('p-tb10', DEVICE)).toBe('EBMR-DEV-134');
    // A unit of another class, in use by the batch, with device B linked: refused (the stage binds PRESS to PRESS_CLASS).
    other = await cleanUnit(sbx, d.runId);
    await startUse(sbx, await op(), other.code, d.runId);
    await linkDevice(sbx, DEVICE_B, other.code);
    expect(await bind('p-tb10', DEVICE_B)).toBe('EBMR-DEV-134');
    // The press of the stage's class, linked, before its use starts: refused; once in use: bound.
    const unit = await cleanUnit(sbx, d.runId, PRESS_CLASS);
    await linkDevice(sbx, DEVICE, unit.code);
    expect(await bind('p-tb10', DEVICE)).toBe('EBMR-DEV-134');
    press = { ...unit, useId: await startUse(sbx, await op(), unit.code, d.runId) };
    expect(await bind('p-tb10', DEVICE)).toBe('ok');
    // The link: once per binding, a PROCESS unit of the plant, not by an operator, never written directly.
    expect(await codeOf(linkDevice(sbx, DEVICE, other.code))).toBe('EBMR-DEV-152');
    expect(await codeOf(identity.withGuardedCommand(sbx.db.app, await adminActor(sbx), (c) => c.query("select tab.link_process_device_unit(gen_random_uuid(), 'X')")))).toBe('EBMR-DEV-150');
    const bindingB = await sql<string>('select id::text as r from tab.process_device where device_code = $1', [DEVICE_B]);
    expect(await codeOf(asOp('select tab.link_process_device_unit($1, $2) as r', [bindingB, unit.code]))).toMatch(/^EBMR-IAM-/);
    await expect(sbx.db.app.query('insert into tab.process_device_unit (process_device_id, equipment_id, person_id, account_id) values (gen_random_uuid(), $1, gen_random_uuid(), gen_random_uuid())', [unit.id])).rejects.toThrow(/permission denied/);
    await expect(sbx.db.admin.query('update tab.process_device_unit set equipment_id = $1', [other.id])).rejects.toThrow(/EBMR-AUDIT-004/);
  });

  it('[INV-24][IN-36][PR-27][PR-22] the tooling register: a set is issued only for its own product, after a passing inspection before use with every checklist item, never twice at once; the strokes of a use come from the press counter; a set at or past its stroke limit may not compress and is never issued again; nobody writes the register directly', async () => {
    await asSteward('select tab.define_tooling_set($1) as r', [toolingSet('TEST-SET-3C-01')]);
    await asSteward('select tab.define_tooling_set($1) as r', [toolingSet('TEST-SET-3C-02', { strokeLimit: '100' })]);
    expect(await codeOf(asSteward('select tab.define_tooling_set($1) as r', [toolingSet('TEST-SET-3C-X', { product: 'TEST-NO-SUCH-PRODUCT' })]))).toBe('EBMR-PLANT-012');
    expect(await codeOf(asOp('select tab.define_tooling_set($1) as r', [toolingSet('TEST-SET-3C-Y')]))).toMatch(/^EBMR-IAM-/);
    // No inspection yet; an inspection that leaves out a checklist item; a failed inspection (disposition required).
    expect(await codeOf(issue('TEST-SET-3C-01'))).toBe('EBMR-TOOL-020');
    expect(await codeOf(inspect('TEST-SET-3C-01', 'PRE_USE', null, { TIPS: true }, null))).toBe('EBMR-TOOL-012');
    expect(await codeOf(inspect('TEST-SET-3C-01', 'PRE_USE', null, findings(false), null))).toBe('EBMR-TOOL-013');
    const failed = await inspect('TEST-SET-3C-01', 'PRE_USE', null, findings(false), 'POLISH');
    expect(failed.result).toBe('FAIL');
    ids['failedPre'] = failed.inspectionId;
    expect(await codeOf(issue('TEST-SET-3C-01'))).toBe('EBMR-TOOL-020');
    const pre1 = await inspect('TEST-SET-3C-01', 'PRE_USE', null, findings(), null);
    ids['pre1'] = pre1.inspectionId;
    // Review 3c finding 2: the press counter's reading at issue is the baseline of the use.
    await strokes('5000');
    expect(await codeOf(issue('TEST-SET-3C-01', { upper: '28', lower: '27', dies: '27' }))).toBe('EBMR-TOOL-022');
    ids['issue1'] = (await issue('TEST-SET-3C-01')).issueId;
    expect(await codeOf(issue('TEST-SET-3C-01'))).toBe('EBMR-TOOL-020');
    expect(await codeOf(inspect('TEST-SET-3C-01', 'PRE_USE', null, findings(), null))).toBe('EBMR-TOOL-011');
    ids['pre2'] = (await inspect('TEST-SET-3C-02', 'PRE_USE', null, findings(), null)).inspectionId;
    ids['issue2'] = (await issue('TEST-SET-3C-02')).issueId;
    // PR-27: a set assigned to another product is never issued to this batch.
    await asSetup(sbx, "insert into plant.product (code, name, highly_potent, recorded_by) values ('TEST-OTHER-3C', 'Other', false, gen_random_uuid()) on conflict do nothing");
    await asSteward('select tab.define_tooling_set($1) as r', [toolingSet('TEST-SET-3C-OTHER', { product: 'TEST-OTHER-3C' })]);
    await withCommand(sbx.db.app, await op(), (c) => c.query('select tab.inspect_tooling($1, $2, $3, $4, $5)', ['TEST-SET-3C-OTHER', 'PRE_USE', null, findings(), null])).catch(() => undefined);
    expect(await sql('select tab.tooling_issue_problem(id, $1) as r from tab.tooling_set where code = $2', [product, 'TEST-SET-3C-OTHER'])).toMatch(/assigned to product TEST-OTHER-3C/);
    // The press counts 150 strokes after both issues: set 02 (limit 100) may no longer compress, set 01 may.
    await strokes('5150');
    expect(await sql('select tab.issue_strokes($1, clock_timestamp()) as r', [ids['issue2']])).toMatchObject({ strokes: 150, readings: 1, baselined: true });
    expect(await sql('select tab.tooling_use_problem($1) as r', [ids['issue2']])).toMatch(/150 strokes with this use, at or past its limit of 100 \(INV-24\)/);
    expect(await sql('select tab.tooling_use_problem($1) as r', [ids['issue1']])).toBeNull();
    // Bypass: the register is never written by the application role, never changed by owner-level code.
    await expect(sbx.db.app.query('insert into tab.tooling_issue (set_id, batch_id, press_equipment_id, pre_use_inspection_id, upper_issued, lower_issued, dies_issued, person_id, account_id) select set_id, $1, $2, id, 1, 1, 1, person_id, account_id from tab.tooling_inspection limit 1', [d.runId, press.id])).rejects.toThrow(/permission denied/);
    await expect(sbx.db.app.query("update tab.tooling_set set stroke_limit = 999999999 where code = 'TEST-SET-3C-02'")).rejects.toThrow(/permission denied/);
    await expect(sbx.db.admin.query("update tab.tooling_set set stroke_limit = 999999999 where code = 'TEST-SET-3C-02'")).rejects.toThrow(/EBMR-AUDIT-004/);
    await expect(sbx.db.admin.query('delete from tab.tooling_inspection where id = $1', [ids['failedPre']])).rejects.toThrow(/EBMR-AUDIT-004/);
  });

  it('[IN-36][INV-24][PR-27] TB-09 issue: an inspection entry is the register\'s row of this person with its result; an issue only on the passing inspection the step recorded, of a set matching the MBR\'s approved tooling specification; a forged engine is refused', async () => {
    const inspected = (inspectionId: string, set = 'TEST-SET-3C-01', result = 'PASS'): Entry => ({ kind: 'TOOLING_INSPECTED', set, inspectionId, when: 'BEFORE', result });
    expect(await verdict('p-tb09i', inspected(ids['pre1'] ?? '', 'TEST-SET-3C-01', 'FAIL'), { tamper: laxEntry('p-tb09i', { ...strip(inspected(ids['pre1'] ?? '', 'TEST-SET-3C-01', 'FAIL')), inspectedBy: me }) })).toBe('EBMR-EXE-260 TB09-REGISTER');
    expect(await verdict('p-tb09i', inspected(ids['pre1'] ?? '', 'TEST-SET-3C-02'))).toBe('EBMR-EXE-260 TB09-REGISTER');
    // The failed inspection: stored only with its exception.
    expect(await verdict('p-tb09i', inspected(ids['failedPre'] ?? '', 'TEST-SET-3C-01', 'FAIL'), { tamper: laxEntry('p-tb09i', { ...strip(inspected(ids['failedPre'] ?? '', 'TEST-SET-3C-01', 'FAIL')), inspectedBy: me }) })).toMatch(/^EBMR-EXE-260 .*TOOLING_FAILED_BEFORE_USE/s);
    const issued = (issueId: string, set = 'TEST-SET-3C-01'): Entry => ({ kind: 'TOOLING_ISSUED', set, issueId, press: press.code });
    // An issue before the step recorded its passing inspection (the engine refuses too; here the forged engine).
    expect(await verdict('p-tb09i', issued(ids['issue1'] ?? ''), { tamper: laxEntry('p-tb09i', { ...strip(issued(ids['issue1'] ?? '')), inspection: 'EN-1', issuedBy: me }) })).toBe('EBMR-EXE-260 TB09-NOT-INSPECTED');
    expect(await verdict('p-tb09i', inspected(ids['pre1'] ?? ''))).toBe('ok');
    expect(await verdict('p-tb09i', inspected(ids['pre1'] ?? ''))).toBe('EBMR-EXE-260 TB09-REGISTER');
    expect(await verdict('p-tb09i', issued(ids['issue2'] ?? '', 'TEST-SET-3C-01'))).toBe('EBMR-EXE-260 TB09-REGISTER');
    expect(await verdict('p-tb09i', issued(ids['issue1'] ?? ''))).toBe('ok');
    expect(await verdict('p-tb09i', inspected(ids['pre2'] ?? '', 'TEST-SET-3C-02'))).toBe('ok');
    expect(await verdict('p-tb09i', issued(ids['issue2'] ?? '', 'TEST-SET-3C-02'))).toBe('ok');
    // A set whose master data are not the MBR's approved tooling (PR-27): the register issues it, the step refuses it.
    await asSteward('select tab.define_tooling_set($1) as r', [toolingSet('TEST-SET-3C-03', { upperEmbossing: 'C4' })]);
    const pre3 = await inspect('TEST-SET-3C-03', 'PRE_USE', null, findings(), null);
    const issue3 = await issue('TEST-SET-3C-03');
    expect(await verdict('p-tb09i', inspected(pre3.inspectionId, 'TEST-SET-3C-03'))).toBe('ok');
    expect(await verdict('p-tb09i', issued(issue3.issueId, 'TEST-SET-3C-03'))).toBe('EBMR-EXE-260 TB09-SPEC');
    ids['issue3'] = issue3.issueId;
  });

  it('[INV-24][IN-26][PR-23][DI-31] TB-10: the set-up names the batch\'s open use of the press its device is the unit of, and tooling a TB-09 step issued that may compress (INV-24: within its stroke limit); the hopper charge is the person\'s scan of this batch (IN-26 (c)); the first-off needs its approval check; a setting outside its range waits for a deviation; the step closes only while the tooling may still compress', async () => {
    const setup = (issueId: string, useId = press.useId): Entry => ({ kind: 'PRESS_SETUP', press: press.code, useId, issueId });
    expect(await verdict('p-tb10', setup(ids['issue2'] ?? ''))).toBe('EBMR-EXE-260 TB10-TOOLING');
    expect(await verdict('p-tb10', setup(ids['issue3'] ?? ''))).toBe('EBMR-EXE-260 TB10-TOOLING');
    expect(await verdict('p-tb10', setup(ids['issue1'] ?? '', randomUUID()))).toBe('EBMR-EXE-260 TB10-PRESS');
    expect(await verdict('p-tb10', setup(ids['issue1'] ?? ''))).toBe('ok');
    expect(await verdict('p-tb10', { kind: 'PRE_USE_CHECKLIST', items: [{ item: 'DUST_EXTRACTION', ok: true }] }, { tamper: laxEntry('p-tb10', { items: [{ item: 'DUST_EXTRACTION', ok: true }], allOk: true, checkedBy: me }) })).toBe('EBMR-EXE-260 TB10-CHECKLIST');
    const items = ['DUST_EXTRACTION', 'NOZZLES_CLEAN_NO_LEAK', 'CALIBRATED_BALANCE'].map((item) => ({ item, ok: true }));
    expect(await verdict('p-tb10', { kind: 'PRE_USE_CHECKLIST', items })).toBe('ok');
    // The hopper charge: a container of this batch, closed and usable, scanned by the operator (plant.charge_container).
    const opened = await asOp<{ container_id: string; version: number }>('select plant.open_container($1, $2, $3) as r', [d.runId, 'BLENDING', 'kg']);
    const closed = await asOp<{ label_code: string }>('select plant.close_container($1, $2, $3) as r', [opened.container_id, '42.000', opened.version]);
    await verifyTypedNet(sbx, d.browser('verifier1'), opened.container_id);
    const charge = await asOp<{ charge_id: string }>('select plant.charge_container($1, $2, $3) as r', [d.runId, 'COMPRESSION', closed.label_code]);
    expect(await verdict('p-tb10', { kind: 'HOPPER_CHARGE', chargeId: randomUUID() })).toBe('EBMR-EXE-260 TB10-CHARGE');
    expect(await verdict('p-tb10', { kind: 'HOPPER_CHARGE', chargeId: charge.charge_id })).toBe('ok');
    // The first-off without its approval check (a forged engine), then honestly.
    expect(await verdict('p-tb10', { kind: 'FIRST_OFF', result: 'PASS' }, { tamper: laxEntry('p-tb10', { result: 'PASS', recordedBy: me }) })).toMatch(/^EBMR-EXE-260 .*need its check/s);
    expect(await verdict('p-tb10', { kind: 'FIRST_OFF', result: 'PASS' })).toBe('ok');
    const change = { kind: 'SETTING_CHANGE', tag: 'force.main_kN', value: '16.0', unit: 'kN', reason: 'Hardness low' };
    expect(await verdict('p-tb10', change, { tamper: laxEntry('p-tb10', { ...strip(change), withinRange: true, changedBy: me }) })).toMatch(/^EBMR-EXE-260 .*not build.*withinRange/s);
    expect(await verdict('p-tb10', change, { tamper: laxEntry('p-tb10', { ...strip(change), withinRange: false, changedBy: me }) })).toMatch(/^EBMR-EXE-260 .*without SETTING_OUT_OF_RANGE/s);
    expect(await verdict('p-tb10', change)).toBe('ok');
    expect(Object.values((await stateOf(sbx, d.runId)).exceptions).map((x) => x['type'])).toContain('SETTING_OUT_OF_RANGE');
    // The close: allowed while the tooling may compress (read on the run's real state).
    const c = await content();
    const old = await stateOf(sbx, d.runId);
    const closedState = structuredClone(old);
    (closedState.steps['p-tb10@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.compression_close_problem($1, $2, $3, $4) as r', [d.runId, c, old, closedState])).toBeNull();
    const noFirstOff = structuredClone(closedState);
    for (const [k, e] of Object.entries(noFirstOff.entries)) if (e['kind'] === 'FIRST_OFF') delete noFirstOff.entries[k];
    expect(await sql('select tab.compression_close_problem($1, $2, $3, $4) as r', [d.runId, c, old, noFirstOff])).toMatch(/TB10-FIRST-OFF/);
  });

  it('[IN-36][IN-35] TB-17: a challenge names certified test pieces of the register (an expired certificate is refused at database time); the metal detector is challenged with every piece the MBR names; a failed challenge holds the press output since the last passing challenge and is stored only with its exception; a late one only with CHALLENGE_OVERDUE (database time)', async () => {
    const until = (days: number) => sql<string>(`select (clock_timestamp() + make_interval(days => $1))::text as r`, [days]);
    await asSteward('select tab.define_test_piece($1) as r', [{ code: 'TP-FE-08', kind: 'FERROUS', size: PIECES[0]?.size, certificateRef: 'CERT-FE-08', certifiedUntil: await until(365) }]);
    await asSteward('select tab.define_test_piece($1) as r', [{ code: 'TP-SS-12', kind: 'STAINLESS', size: PIECES[1]?.size, certificateRef: 'CERT-SS-12', certifiedUntil: await until(365) }]);
    await asSteward('select tab.define_test_piece($1) as r', [{ code: 'TP-NF-10', kind: 'NON_FERROUS', size: { value: '1.0', unit: 'mm' }, certificateRef: 'CERT-NF-10', certifiedUntil: await until(-1) }]);
    const challenge = (timing: string, pieces: Json[]) =>
      asOp<{ challengeId: string; passed: boolean; hold: Json | null }>('select tab.record_detector_challenge($1, $2, $3, $4, $5, $6) as r', [d.runId, press.code, 'METAL_DETECTOR', 'MD-01', timing, JSON.stringify(pieces)]);
    const piece = (p: string, ok = true) => ({ piece: p, detected: ok, rejected: ok });
    expect(await codeOf(challenge('START', [piece('TP-FE-08'), piece('TP-NF-10')]))).toBe('EBMR-DET-010');
    expect(await codeOf(challenge('START', [piece('TP-FE-08'), piece('TP-FE-08')]))).toBe('EBMR-DET-010');
    const start = await challenge('START', [piece('TP-FE-08'), piece('TP-SS-12')]);
    const entry = (id: string, timing: string, passed: boolean): Entry => ({ kind: 'CHALLENGE', challengeId: id, device: 'METAL_DETECTOR', timing, passed });
    expect(await verdict('p-tb17', entry(start.challengeId, 'START', false))).toBe('EBMR-EXE-260 TB17-REGISTER');
    expect(await verdict('p-tb17', entry(start.challengeId, 'START', true))).toBe('ok');
    const partial = await challenge('INTERVAL', [piece('TP-FE-08')]);
    expect(await verdict('p-tb17', entry(partial.challengeId, 'INTERVAL', true))).toBe('EBMR-EXE-260 TB17-PIECES');
    // A container of the press opened after the passing START challenge; the failed challenge holds it at its close.
    const opened = await asOp<{ container_id: string; label_code: string; version: number }>('select plant.open_container($1, $2, $3, $4) as r', [d.runId, 'COMPRESSION', 'kg', press.code]);
    const failed = await challenge('INTERVAL', [piece('TP-FE-08', false), piece('TP-SS-12')]);
    expect([failed.passed, failed.hold?.['pending']]).toEqual([false, [opened.label_code]]);
    const closed = await asOp<{ state: string }>('select plant.close_container($1, $2, $3) as r', [opened.container_id, '12.000', opened.version]);
    expect(closed.state).toBe('HELD');
    const forged = entry(failed.challengeId, 'INTERVAL', false);
    expect(await verdict('p-tb17', forged, { tamper: laxEntry('p-tb17', { ...strip(forged), recordedBy: me }) })).toMatch(/^EBMR-EXE-260 .*DETECTOR_CHALLENGE_FAILED/s);
    expect(await verdict('p-tb17', forged)).toBe('ok');
    // CHALLENGE_OVERDUE: the run's state with the START challenge recorded three hours earlier (database time decides).
    const pass = await challenge('INTERVAL', [piece('TP-FE-08'), piece('TP-SS-12')]);
    const before = await stateOf(sbx, d.runId);
    expect(await verdict('p-tb17', entry(pass.challengeId, 'INTERVAL', true))).toBe('ok');
    const after = await stateOf(sbx, d.runId);
    const c = await content();
    const back = (s: Json & { entries: Record<string, Json> }) => {
      const x = structuredClone(s);
      for (const e of Object.values(x.entries)) if (e['kind'] === 'CHALLENGE' && e['stepKey'] === 'p-tb17@') e['recordedAt'] = { $u: String(BigInt(String((e['recordedAt'] as Json)['$u'])) - 10_800_000_000n) };
      return x;
    };
    const id = await lastEntry(sbx, d.runId, 'p-tb17@', 'CHALLENGE');
    const old = back(before);
    const now = back(after);
    now.entries[id] = after.entries[id] as Json;
    const cmd = { entry: entry(pass.challengeId, 'INTERVAL', true) };
    expect(await sql('select tab.compression_entry_problem($1, $2, $3, $4, $5) as r', [d.runId, c, before, after, cmd])).toBeNull();
    expect(await sql('select tab.compression_entry_problem($1, $2, $3, $4, $5) as r', [d.runId, c, old, now, cmd])).toMatch(/without CHALLENGE_OVERDUE/);
    // Rejects destroyed, de-duster; the close needs a passing END challenge.
    expect(await verdict('p-tb17', { kind: 'REJECT_COUNT', device: 'METAL_DETECTOR', count: '37', disposition: 'INSPECTION_THEN_DESTRUCTION' })).toBe('ok');
    expect(await verdict('p-tb17', { kind: 'DEDUSTING', deDuster: 'DD-02', inUse: true }, { tamper: laxEntry('p-tb17', { deDuster: 'DD-02', inUse: true, recordedBy: me }) })).toBe('EBMR-EXE-260 TB17-DEDUSTER');
    expect(await verdict('p-tb17', { kind: 'DEDUSTING', deDuster: 'DD-01', inUse: true })).toBe('ok');
    const s = await stateOf(sbx, d.runId);
    const closing = structuredClone(s);
    (closing.steps['p-tb17@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.compression_close_problem($1, $2, $3, $4) as r', [d.runId, c, s, closing])).toMatch(/TB17-END-CHALLENGE/);
    const end = await challenge('END', [piece('TP-FE-08'), piece('TP-SS-12')]);
    expect(await verdict('p-tb17', entry(end.challengeId, 'END', true))).toBe('ok');
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-tb17@' });
    expect((await stateOf(sbx, d.runId)).steps['p-tb17@']?.['status']).toBe('AWAITING_VERIFICATION');
  });

  it('[IN-36][INV-24][PR-22] TB-09 return: the strokes of the use come from the press counter; a missing die and a failed after-use inspection hold the press output since the issue and are stored only with their exceptions; a set past its limit is never issued again; the step closes only with every returned set inspected after use (IN-36 catalogue test); the set-up step can no longer close on returned tooling', async () => {
    const opened = await asOp<{ container_id: string; label_code: string; version: number }>('select plant.open_container($1, $2, $3, $4) as r', [d.runId, 'COMPRESSION', 'kg', press.code]);
    await strokes('5150');
    // Set 02: 150 strokes from the counter, past its limit of 100; review 3c finding 1: the output made since the
    // counter crossed the limit is held (the container opened after it).
    const r2 = await asOp<Json>('select tab.return_tooling($1, $2) as r', [ids['issue2'], COUNTS]);
    expect([r2['strokes'], r2['strokeSource'], r2['limitExceeded'], r2['countMismatch']]).toEqual(['150', 'PRESS_COUNTER', true, false]);
    expect((r2['hold'] as Json | null)?.['pending']).toEqual([opened.label_code]);
    expect(await codeOf(asOp('select tab.return_tooling($1, $2, $3) as r', [ids['issue1'], COUNTS, '10']))).toBe('EBMR-TOOL-032');
    const returned = (issueId: string, set: string, r: Json): Entry => ({ kind: 'TOOLING_RETURNED', set, issueId, strokes: r['strokes'], strokeSource: r['strokeSource'], countMismatch: r['countMismatch'], limitExceeded: r['limitExceeded'] });
    const e2 = returned(ids['issue2'] ?? '', 'TEST-SET-3C-02', r2);
    expect(await verdict('p-tb09r', e2, { tamper: laxEntry('p-tb09r', { ...strip(e2), returnedBy: me }) })).toMatch(/^EBMR-EXE-260 .*TOOLING_LIMIT_EXCEEDED/s);
    expect(await verdict('p-tb09r', { ...e2, strokes: '10' })).toBe('EBMR-EXE-260 TB09-REGISTER');
    expect(await verdict('p-tb09r', e2)).toBe('ok');
    const post2 = await inspect('TEST-SET-3C-02', 'POST_USE', ids['issue2'] ?? '', findings(), null);
    expect(await verdict('p-tb09r', { kind: 'TOOLING_INSPECTED', set: 'TEST-SET-3C-02', inspectionId: post2.inspectionId, when: 'AFTER', result: 'PASS' })).toBe('ok');
    await inspect('TEST-SET-3C-02', 'PRE_USE', null, findings(), null);
    expect(await codeOf(issue('TEST-SET-3C-02'))).toBe('EBMR-TOOL-020');
    // Set 01: a die missing at return (the open container is held at its close); found chipped after use.
    const r1 = await asOp<Json>('select tab.return_tooling($1, $2) as r', [ids['issue1'], { upper: '27', lower: '27', dies: '26' }]);
    expect([r1['countMismatch'], (r1['hold'] as Json)['pending']]).toEqual([true, [opened.label_code]]);
    const e1 = returned(ids['issue1'] ?? '', 'TEST-SET-3C-01', r1);
    expect(await verdict('p-tb09r', e1, { tamper: laxEntry('p-tb09r', { ...strip(e1), returnedBy: me }) })).toMatch(/^EBMR-EXE-260 .*TOOLING_COUNT_MISMATCH/s);
    expect(await verdict('p-tb09r', e1)).toBe('ok');
    // The set-up step on the returned set can no longer close (INV-24).
    const c = await content();
    const s = await stateOf(sbx, d.runId);
    const closing = structuredClone(s);
    (closing.steps['p-tb10@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.compression_close_problem($1, $2, $3, $4) as r', [d.runId, c, s, closing])).toMatch(/set TEST-SET-3C-01 was returned \(TB10-TOOLING; INV-24\)/);
    // Review 3c finding 1: a compression run (TB-11 RUN_START, tablets 0893) never starts on the returned set.
    expect(await sql('select tab.press_tooling_problem($1, $2, $3) as r', [c, s, press.code])).toMatch(/TEST-SET-3C-01 was returned \(TB10-TOOLING; INV-24\)/);
    // Closing the return step without the after-use inspection of set 01 (IN-36 catalogue test).
    const closeReturn = structuredClone(s);
    (closeReturn.steps['p-tb09r@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.compression_close_problem($1, $2, $3, $4) as r', [d.runId, c, s, closeReturn])).toMatch(/set TEST-SET-3C-01 has no inspection after use \(TB09-AFTER-CHECK-MISSING/);
    const post1 = await inspect('TEST-SET-3C-01', 'POST_USE', ids['issue1'] ?? '', findings(false), 'RETIRE');
    expect(post1.result).toBe('FAIL');
    const after = { kind: 'TOOLING_INSPECTED', set: 'TEST-SET-3C-01', inspectionId: post1.inspectionId, when: 'AFTER', result: 'FAIL' };
    expect(await verdict('p-tb09r', { ...after, result: 'PASS' })).toBe('EBMR-EXE-260 TB09-REGISTER');
    expect(await verdict('p-tb09r', after, { tamper: laxEntry('p-tb09r', { ...strip(after), inspectedBy: me }) })).toMatch(/^EBMR-EXE-260 .*TOOLING_FAILED_AFTER_USE/s);
    expect(await verdict('p-tb09r', after)).toBe('ok');
    expect(await asOp<{ state: string }>('select plant.close_container($1, $2, $3) as r', [opened.container_id, '9.000', opened.version])).toMatchObject({ state: 'HELD' });
    expect(await sql("select tab.tooling_fit_problem(id) as r from tab.tooling_set where code = 'TEST-SET-3C-01'", [])).toMatch(/retired/);
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-tb09r@' });
    expect((await stateOf(sbx, d.runId)).steps['p-tb09r@']?.['status']).toBe('AWAITING_VERIFICATION');
  });

  it('[INV-24][DI-31] review 3c finding 2: without a counter baseline at issue the press counter never decides a use\'s strokes: one reading counts no strokes, so the count is keyed (flagged MANUAL) and never below what the counter saw', async () => {
    await asSteward('select tab.define_tooling_set($1) as r', [toolingSet('TEST-SET-3C-04')]);
    await inspect('TEST-SET-3C-04', 'PRE_USE', null, findings(), null);
    // The second press (device B) has sent nothing: no baseline.
    const issued = await asOp<{ issueId: string }>('select tab.issue_tooling($1, $2, $3, $4) as r', ['TEST-SET-3C-04', d.runId, other.code, COUNTS]);
    expect(await sql('select baseline_reading_id as r from tab.tooling_issue where id = $1', [issued.issueId])).toBeNull();
    await strokes('900', SERIAL_B);
    await strokes('950', SERIAL_B);
    expect(await sql('select tab.issue_strokes($1, clock_timestamp()) as r', [issued.issueId])).toMatchObject({ strokes: 50, readings: 2, baselined: false });
    expect(await codeOf(asOp('select tab.return_tooling($1, $2) as r', [issued.issueId, COUNTS]))).toBe('EBMR-TOOL-032');
    expect(await codeOf(asOp('select tab.return_tooling($1, $2, $3) as r', [issued.issueId, COUNTS, '40']))).toBe('EBMR-TOOL-033');
    const r = await asOp<Json>('select tab.return_tooling($1, $2, $3) as r', [issued.issueId, COUNTS, '1200']);
    expect([r['strokes'], r['strokeSource']]).toEqual(['1200', 'MANUAL']);
  });

  it('[DI-31] review backlog #7 (slice 3a): the sweeper\'s service identity records an interface loss when a bound step\'s device sent nothing for longer than its stale age (database time), once per loss; nobody else may; the step closes only after an INTERFACE_LOSS entry answers it', async () => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-watch@' });
    expect(await bind('p-watch', DEVICE)).toBe('ok');
    await strokes('5200');
    const sweeper = { ...(await openServiceSession(sbx.db, sbx.seed, 'sweeper')), correlationId: randomUUID() };
    expect((await recordInterfaceLosses(sbx.built.ctx, sweeper)).filter((l) => l.batchId === d.runId)).toEqual([]);
    await wait(1_300);
    const found = (await recordInterfaceLosses(sbx.built.ctx, sweeper)).filter((l) => l.batchId === d.runId);
    expect(found.map((l) => l.step)).toEqual(['p-watch']);
    expect((await recordInterfaceLosses(sbx.built.ctx, sweeper)).filter((l) => l.batchId === d.runId)).toEqual([]);
    expect(await codeOf(asOp('select tab.record_interface_losses() as r', []))).toMatch(/^EBMR-IAM-/);
    await expect(sbx.db.app.query("insert into tab.interface_loss (batch_id, step, process_device_id, max_age_us, detected_us, person_id, account_id) select $1, 'p-watch', process_device_id, 1, 1, person_id, account_id from tab.step_device limit 1", [d.runId])).rejects.toThrow(/permission denied/);
    const c = await content();
    const s = await stateOf(sbx, d.runId);
    const closing = structuredClone(s);
    (closing.steps['p-watch@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.interface_loss_close_problem($1, $2, $3, $4) as r', [d.runId, c, s, closing])).toMatch(/no INTERFACE_LOSS entry of the step answers it/);
    expect(await verdict('p-watch', { kind: 'INTERFACE_LOSS', reason: 'Press link silent (sweeper)' })).toBe('ok');
    const s2 = await stateOf(sbx, d.runId);
    const closing2 = structuredClone(s2);
    (closing2.steps['p-watch@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.interface_loss_close_problem($1, $2, $3, $4) as r', [d.runId, c, s2, closing2])).toBeNull();
    expect(Object.values(s2.exceptions).map((x) => x['type'])).toContain('INTERFACE_LOSS');
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
