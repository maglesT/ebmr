/**
 * Phase 3 slice 3d (builder A): the coating and finishing blocks' rules held by the database (tablets 0910 to 0912),
 * proven as the application role past the server: an honest entry the engine builds is stored; the same act through a
 * tampered block handler (a forged engine: the rule skipped, the data or the exception changed) is refused by the database
 * alone. Rules about closing a step, computed items, the loop bound and the MBR's gates are read through their functions
 * on the run's real state, forged where the test says so. Time rules (the use-by, the parameter log) are judged at the
 * row's database time.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import { actorOfBrowser } from '../../esig/support.ts';
import { codeOf, verifyTypedNet } from '../../execution/db-guards-support.ts';
import { importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../../execution/support.ts';
import { COATING_BLOCK_VERSIONS } from '../../../src/blocks/coating/index.ts';
import { AQL_SCHEME, expandedPlans, LETTERS, SAMPLE_CODE_ROWS } from '../../../src/blocks/coating/aql.ts';
import { fakeTimers, lastEntry, laxEntry, recorder, stateOf, tamperHandler, type Entry } from '../granulation/db-support.ts';
import { asSetup, cleanUnit } from '../compression/plant-support.ts';
import { coatingDbMbr, DEFECTS } from './db-support.ts';

type Json = Record<string, unknown>;

let sbx: ExecServer;
let d: RunDriver;
let rec: ReturnType<typeof recorder>;
let me: string;
let printerA: string;
let printerB: string;

const advance = (): void => {
  vi.advanceTimersByTime(7_000);
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const COAT1 = [{ construct: 'L-COAT', index: 1 }];

const op = async (): Promise<ActorContext> => {
  advance();
  return actorOfBrowser(sbx, d.browser('operator1'), 'operator1');
};
async function asOp<T = Json>(text: string, params: unknown[]): Promise<T> {
  return withCommand(sbx.db.app, await op(), async (c) => (await c.query<{ r: T }>(text, params)).rows[0]?.r as T);
}

/** The database's answer for an entry: 'ok', or the EBMR code and the block rule code it names. */
async function verdict(step: string, entry: Entry, opts: Parameters<typeof rec.message>[2] = {}): Promise<string> {
  const m = await rec.message(step, entry, opts);
  if (m === 'ok') return m;
  const code = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(m)?.[1] ?? '?';
  const rule = /\((?:[^()]*; )?(TB(?:18|19|20)-[A-Z0-9-]+)[;)]/.exec(m)?.[1] ?? /(TB(?:18|19|20)-[A-Z0-9-]+)/.exec(m)?.[1];
  return rule ? `${code} ${rule}` : `${code} ${m.slice(0, 400)}`;
}

async function sql<T>(text: string, params: unknown[]): Promise<T | null> {
  const { rows } = await sbx.db.admin.query<{ r: T | null }>(text, params);
  return rows[0]?.r ?? null;
}
const content = (): Promise<Json | null> => sql<Json>('select recipe.batch_mbr_content($1) as r', [d.runId]);
const strip = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'kind'));
const dataOf = async (stepKey: string, kind: string): Promise<Json> => (await stateOf(sbx, d.runId)).entries[await lastEntry(sbx, d.runId, stepKey, kind)]?.['data'] as Json;

async function performAndVerify(stepKey: string): Promise<void> {
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey });
  if ((await stateOf(sbx, d.runId)).steps[stepKey]?.['status'] === 'AWAITING_VERIFICATION') await d.signed('verifier1', { type: 'VERIFY', stepKey, meaning: 'VERIFIED' });
}

/** A container of the batch opened (on `press` when given) and closed by operator1. */
async function container(stage: string, press?: string): Promise<{ id: string; label: string }> {
  const o = await asOp<{ container_id: string; label_code: string; version: number }>(
    press ? 'select plant.open_container($1, $2, $3, $4) as r' : 'select plant.open_container($1, $2, $3) as r', press ? [d.runId, stage, 'kg', press] : [d.runId, stage, 'kg'],
  );
  await asOp('select plant.close_container($1, $2, $3) as r', [o.container_id, '10.000', o.version]);
  await verifyTypedNet(sbx, d.browser('verifier1'), o.container_id);
  return { id: o.container_id, label: o.label_code };
}
const stateOfContainer = (id: string) => sql<string>('select plant.container_state($1) as r', [id]);

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

beforeAll(async () => {
  sbx = await startExecServer();
  fakeTimers();
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, coatingDbMbr()));
  d = new RunDriver(sbx, runId, {
    issuer,
    operator1: await sbx.asPersona('operator1'),
    verifier1: await sbx.asPersona('verifier1'),
    qa1: await sbx.asPersona('qa1'),
  });
  d.beforeTap = advance;
  rec = recorder(sbx, d, advance);
  me = personaIn(sbx, 'operator1').personId;
  printerA = (await cleanUnit(sbx, runId)).code;
  printerB = (await cleanUnit(sbx, runId)).code;
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

describe('the coating and finishing blocks in the database (tablets 0910 to 0912)', () => {
  it('[DI-30][DI-05][DI-10] the database holds the data schemas of TB-18, TB-19 and TB-20 as the registry declares them (G-06 kinds unchanged), their rule codes, TB-18 as a block on a process device, and the sampling scheme as data with its source equal to the block\'s; nothing can change them', async () => {
    const { rows } = await sbx.db.admin.query<{ k: string; schema: Json }>(
      "select block_type || '@' || block_version || ' ' || entry_kind as k, schema from recipe.block_data_schema where block_type in ('TB-18', 'TB-19', 'TB-20')",
    );
    const want: Record<string, Json> = {};
    for (const b of COATING_BLOCK_VERSIONS) for (const [k, s] of Object.entries(b.dataSchema?.entries ?? {})) want[`${b.type}@${b.version} ${k}`] = schemaJson(s as unknown as { type: string } & Json);
    expect(Object.fromEntries(rows.map((r) => [r.k, r.schema]))).toEqual(want);
    const g06 = await sbx.db.admin.query<{ schema: Json }>("select schema from recipe.block_data_schema where block_type = 'G-06' and entry_kind = 'ACTUAL'");
    expect(want['TB-18@1 ACTUAL']).toEqual(g06.rows[0]?.schema);
    const src = ['tb-18', 'tb-19', 'tb-20'].map((f) => readFileSync(new URL(`../../../src/blocks/${f}.ts`, import.meta.url), 'utf8')).join('\n');
    const codes = [...new Set([...src.matchAll(/'(TB(?:18|19|20)(?:-[A-Z0-9]+)+)'/g)].map((m) => m[1] ?? ''))];
    const named = (await sbx.db.admin.query<{ name: string }>("select name from recipe.engine_name where name ~ '^TB(18|19|20)' or name in ('TB-18', 'TB-19', 'TB-20')")).rows.map((r) => r.name);
    expect(codes.filter((c) => !named.includes(c))).toEqual([]);
    expect(named).toEqual(expect.arrayContaining(['TB-18', 'TB-19', 'TB-20', 'TB18-SUSPENSION-EXPIRED', 'TB19-PRINTER', 'TB20-SEVERITY']));
    // TB-18 runs on a process device: its step is an automated equipment step of the batch, a printing step is not.
    expect(await sql<Json>('select tab.g06_step_node($1, $2) as r', [d.runId, 'p-coat'])).toMatchObject({ id: 'p-coat' });
    await expect(sbx.db.admin.query('select tab.g06_step_node($1, $2)', [d.runId, 'p-tb19'])).rejects.toThrow(/EBMR-DEV-130/);
    // The sampling scheme: its source and the rows equal the block's data.
    expect(await sql<Json>("select to_jsonb(s) - 'recorded_at' as r from tab.aql_scheme s", [])).toEqual({ code: AQL_SCHEME.code, version: AQL_SCHEME.version, source: AQL_SCHEME.source, effective_from: AQL_SCHEME.effectiveFrom, confidence: AQL_SCHEME.confidence });
    const letters = (await sbx.db.admin.query<{ l: string; n: string }>('select letter as l, sample_size::text as n from tab.aql_letter order by position')).rows;
    expect(letters).toEqual(LETTERS.map(([l, n]) => ({ l, n: n.toString() })));
    const codeRows = (await sbx.db.admin.query<{ f: string; t: string | null; a: string; b: string; c: string }>('select lot_from::text as f, lot_to::text as t, level_i as a, level_ii as b, level_iii as c from tab.aql_sample_code order by lot_from')).rows;
    expect(codeRows).toEqual(SAMPLE_CODE_ROWS.map((r) => ({ f: r.from.toString(), t: r.to?.toString() ?? null, a: r.letters[0], b: r.letters[1], c: r.letters[2] })));
    const plans = (await sbx.db.admin.query<{ k: string }>("select severity || ' ' || letter || ' ' || aql || ' ' || plan_letter || ' ' || sample_size || ' ' || ac || '/' || re as k from tab.aql_plan order by 1")).rows.map((r) => r.k);
    expect(plans).toEqual(expandedPlans().map((p) => `${p.severity} ${p.letter} ${p.aql} ${p.plan?.letter} ${p.plan?.n} ${p.plan?.ac}/${p.plan?.re}`).sort());
    await expect(sbx.db.admin.query("update tab.aql_plan set ac = 99 where letter = 'K'")).rejects.toThrow(/EBMR/);
    await expect(sbx.db.app.query("insert into tab.aql_lot_result (batch_id, installation, product_code, step_key, entry_id, severity, accepted) values ($1, 'SANDBOX', 'X', 'k', 'EN-1', 'NORMAL', true)", [d.runId])).rejects.toThrow(/permission denied/);
    await expect(sbx.db.admin.query("delete from recipe.block_data_schema where block_type = 'TB-20'")).rejects.toThrow(/EBMR-AUDIT-004/);
  });

  it('[IN-37][PR-29][PR-45] TB-19: printed tablets wait for the QC approval: a printed container cannot be charged until the hold point after printing is released; a passing print check of the printer is the only PASS that vouches for them; the printer is a plant unit; in a batch that also runs a TB-11 scheduler; a container opened on the printer before its set-up waits too (review 3d #4)', async () => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb19b@' });
    const setup = (printer: string, extra: Json = {}): Entry => ({ kind: 'PRINT_SETUP', printer, inkLot: 'TEST-INK-117', inkEdibleGrade: true, otherProductsPrinting: false, ...extra });
    expect(await verdict('p-tb19b', setup('TEST-NO-SUCH-PRINTER'))).toBe('EBMR-EXE-270 TB19-PRINTER');
    const inedible = setup(printerB, { inkEdibleGrade: false });
    expect(await verdict('p-tb19b', inedible, { tamper: laxEntry('p-tb19b', { ...strip(inedible), setUpBy: me }) })).toBe('EBMR-EXE-270 TB19-INK');
    const together = setup(printerB, { otherProductsPrinting: true });
    expect(await verdict('p-tb19b', together, { tamper: laxEntry('p-tb19b', { ...strip(together), inkEdibleGrade: true, setUpBy: me }) })).toBe('EBMR-EXE-270 TB19-SEGREGATION');
    // Review 3d #4: a container opened on the printer before its printing set-up is gated as well (the gate keys on the
    // set-up's printer when the container is charged, not when it was opened).
    const early = await container('PRINTING', printerB);
    expect(await verdict('p-tb19b', setup(printerB))).toBe('ok');
    const printed = await container('PRINTING', printerB);
    const check = { kind: 'PRINT_CHECK', examined: '50', legible: true, contentMatches: true, defects: {} };
    expect(await verdict('p-tb19b', { ...check, examined: '20' }, { tamper: laxEntry('p-tb19b', {}) })).toBe('EBMR-EXE-270 TB19-SAMPLE');
    expect(await verdict('p-tb19b', check)).toBe('ok');
    const pass = await sql<Json>("select to_jsonb(k) as r from plant.ipc_check k where k.batch_id = $1 and k.press_code = $2", [d.runId, printerB]);
    expect([pass?.['result'], String(pass?.['reference'])]).toEqual(['PASS', expect.stringMatching(/^TB19:p-tb19b@:EN-\d+$/)]);
    // A PASS recorded directly for the printer (not from a passing print check) is refused; a TB-11 reference for it too.
    expect(await codeOf(asOp('select plant.record_ipc_check($1, $2, null, $3, $4) as r', [d.runId, printerB, 'PASS', 'TB19:p-tb19b@:EN-1']))).toBe('EBMR-TAB-311');
    expect(await codeOf(asOp('select plant.record_ipc_check($1, $2, null, $3, $4) as r', [d.runId, printerB, 'PASS', 'TB11:p-tb11@:EN-1']))).toMatch(/^EBMR-TAB-3(02|11)$/);
    // IN-37 catalogue test: the printed container cannot be charged or packed before the QC approval.
    expect(await codeOf(asOp('select plant.charge_container($1, $2, $3, $4) as r', [d.runId, 'PACKING', printed.label, 'PACK']))).toBe('EBMR-TAB-310');
    expect(await codeOf(asOp('select plant.charge_container($1, $2, $3, $4) as r', [d.runId, 'PACKING', early.label, 'PACK']))).toBe('EBMR-TAB-310');
    await performAndVerify('p-tb19b@');
    await d.signed('qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-PRINT-B@', disposition: 'APPROVED' });
    expect(await codeOf(asOp('select plant.charge_container($1, $2, $3, $4) as r', [d.runId, 'PACKING', printed.label, 'PACK']))).toBe('ok');
    expect(await codeOf(asOp('select plant.charge_container($1, $2, $3, $4) as r', [d.runId, 'PACKING', early.label, 'PACK']))).toBe('ok');
    // The MBR keeps the gate: without the hold point after printing every row of the batch is refused.
    const c = await content();
    const noGate = JSON.parse(JSON.stringify(c).replace('"kind":"holdPoint","id":"H-PRINT"', '"kind":"holdPoint","id":"H-PRINT","x":1').replace(/"role":"QA","dispositions":\["APPROVED","NOT_APPROVED"\]/, '"role":"QA_REVIEWER","dispositions":["APPROVED","NOT_APPROVED"]')) as Json;
    expect(await sql('select tab.coating_mbr_problem($1) as r', [c])).toBeNull();
    expect(await sql('select tab.coating_mbr_problem($1) as r', [noGate])).toMatch(/TB19-NO-GATE/);
  });

  it('[IN-37][PR-29] TB-19: a failed print check is stored only with its exception and holds every printed container of the printer since its last passing check; the step closes only after a passing check', async () => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb19@' });
    expect(await verdict('p-tb19', { kind: 'PRINT_SETUP', printer: printerA, inkLot: 'TEST-INK-118', inkEdibleGrade: true, otherProductsPrinting: false })).toBe('ok');
    const box = await container('PRINTING', printerA);
    const failed = { kind: 'PRINT_CHECK', examined: '50', legible: false, contentMatches: true, defects: { SMUDGED: '2' } };
    const data = { examined: '50', legible: false, contentMatches: true, content: 'C3', defects: { SMUDGED: '2' }, defectCounts: { SMUDGED: '2', MISSING: '0', MISREGISTERED: '0' }, defectTotal: '2', checkedBy: me };
    expect(await verdict('p-tb19', failed, { tamper: laxEntry('p-tb19', { ...data, result: 'PASS' }) })).toMatch(/^EBMR-EXE-270 .*result/s);
    expect(await verdict('p-tb19', failed, { tamper: laxEntry('p-tb19', { ...data, result: 'FAIL' }) })).toMatch(/^EBMR-EXE-270 .*PRINT_CHECK_FAILED/s);
    expect(await verdict('p-tb19', failed)).toBe('ok');
    expect(await stateOfContainer(box.id)).toBe('HELD');
    const c = await content();
    const old = await stateOf(sbx, d.runId);
    const closed = structuredClone(old);
    (closed.steps['p-tb19@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.coating_close_problem($1, $2, $3) as r', [c, old, closed])).toMatch(/TB19-LAST-CHECK/);
  });

  it('[PR-29][IN-35][IN-37] TB-18: cores under hold are never coated: the pan load is refused while a compression output container of the batch is held (EBMR-TAB-390, TB18-HELD-CORES); once QA has decided on it the load is stored (GB-T-01 residual)', async () => {
    const press = (await cleanUnit(sbx, d.runId)).code;
    const held = await container('COMPRESSION', press);
    await asOp('select plant.record_ipc_check($1, $2, null, $3, $4) as r', [d.runId, press, 'FAIL', 'TEST-WEIGHT-FAIL']);
    expect(await stateOfContainer(held.id)).toBe('HELD');
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'cores@' });
    // Written as the application role straight to the store (the engine accepts it: it knows no plant containers).
    const load = { kind: 'PAN_LOAD', quantity: { value: '60.000', unit: 'kg' } };
    const refused = await rec.message('cores', load);
    expect(refused).toMatch(/EBMR-TAB-390/);
    expect(refused).toContain(held.label);
    expect(Object.values((await stateOf(sbx, d.runId)).entries).filter((e) => e['kind'] === 'PAN_LOAD')).toEqual([]);
    // QA rejects the held container: no container of the compression output is on hold any more.
    const version = await sql<string>("select version::text as r from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = $1", [held.id]);
    advance();
    const qa = await actorOfBrowser(sbx, d.browser('qa1'), 'qa1', { reasonCode: 'IPC_FAILED', reasonText: 'Held cores rejected after the failed weight check' });
    await withCommand(sbx.db.app, qa, (c) => c.query('select plant.reject_container($1, $2::bigint) as r', [held.id, version]));
    expect(await stateOfContainer(held.id)).toBe('REJECTED');
    expect(await sql<string[]>('select tab.held_compression_containers($1) as r', [d.runId])).toEqual([]);
  });

  it('[IN-37][PR-08][PR-29][DI-29][INV-25][DI-34] TB-18: the cores and the core mean are the block\'s; a coating suspension only of this batch, within its use-by at the row\'s time and never beyond what was prepared; the parameter log and the weight gain computed by the database; the gain above its maximum only with the exception for QA; computed items never typed; the loop bounded', async () => {
    // Suspensions: a film coat that expires in 3 s, one for an hour, and a binder.
    for (const s of ['p-tb03f', 'p-tb03c', 'p-tb03b']) await d.ok('operator1', { type: 'START_STEP', stepKey: `${s}@` });
    for (const [s, q] of [['p-tb03f', '5.000'], ['p-tb03c', '10.000'], ['p-tb03b', '5.000']] as const) {
      expect(await verdict(s, { kind: 'PREPARED', quantity: { value: q, unit: 'kg' }, appearance: 'COMPLIES' })).toBe('ok');
    }
    const prep = async (s: string) => lastEntry(sbx, d.runId, `${s}@`, 'PREPARED');
    // Cores.
    // Started by the test above (the held cores); started here when this test runs alone.
    if ((await stateOf(sbx, d.runId)).steps['cores@']?.['status'] !== 'IN_PROGRESS') await d.ok('operator1', { type: 'START_STEP', stepKey: 'cores@' });
    const room = { kind: 'ROOM_CHECK', filteredAir: true, temperature: '26.0', humidity: '45' };
    expect(await verdict('cores', room, { tamper: laxEntry('cores', { ...strip(room), withinLimits: true, checkedBy: me }) })).toMatch(/^EBMR-EXE-270 .*withinLimits/s);
    const noAir = { ...room, filteredAir: false, temperature: '24.0' };
    expect(await verdict('cores', noAir, { tamper: laxEntry('cores', { ...strip(noAir), withinLimits: true, checkedBy: me }) })).toBe('EBMR-EXE-270 TB18-AIR');
    expect(await verdict('cores', { ...room, temperature: '24.0' })).toBe('ok');
    expect(await verdict('cores', { kind: 'PAN_LOAD', quantity: { value: '60.000', unit: 'kg' } })).toBe('ok');
    const sample = { kind: 'CORE_SAMPLE', instrument: 'TEST-BAL-01', weighing: 'GROUP', count: '20', total: '5.0012', unit: 'g' };
    const honest = { ...strip(sample), totalMg: '5001.2', meanMg: '250.060000', recordedBy: me };
    expect(await verdict('cores', sample, { tamper: laxEntry('cores', { ...honest, meanMg: '250.000000' }, { verificationRequired: true }) })).toMatch(/^EBMR-EXE-270 .*meanMg/s);
    expect(await verdict('cores', { ...sample, count: '10' }, { tamper: laxEntry('cores', { ...honest, count: '10' }, { verificationRequired: true }) })).toBe('EBMR-EXE-270 TB18-SAMPLE');
    expect(await verdict('cores', sample, { tamper: laxEntry('cores', honest) })).toMatch(/^EBMR-EXE-270 .*second person/s);
    expect(await verdict('cores', sample)).toBe('ok');
    await performAndVerify('cores@');
    const s0 = await stateOf(sbx, d.runId);
    const point = Object.values(s0.points).find((p) => p['item'] === 'coreMean') as Json;
    expect(point['value']).toEqual({ kind: 'DECIMAL', value: '250.060000', unit: 'mg' });
    // A typed core mean (INV-25): the honest state with the point's value or source changed.
    const c = await content();
    const before = structuredClone(s0);
    delete before.points[String(point['id'])];
    expect(await sql('select tab.coating_computed_problem($1, $2, $3) as r', [c, before, s0])).toBeNull();
    const typed = structuredClone(s0);
    (typed.points[String(point['id'])] as Json)['value'] = { kind: 'DECIMAL', value: '250.000000', unit: 'mg' };
    expect(await sql('select tab.coating_computed_problem($1, $2, $3) as r', [c, before, typed])).toMatch(/TB18-COMPUTED/);
    // Coating, iteration 1.
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-coat@L-COAT=1' });
    const at = { frames: COAT1 };
    expect(await verdict('p-coat', { kind: 'SPRAY_START' }, at)).toBe('ok');
    const used = (preparation: string, value: string): Entry => ({ kind: 'SUSPENSION_USED', preparation, quantity: { value, unit: 'kg' } });
    expect(await verdict('p-coat', used(await prep('p-tb03b'), '1.000'), at)).toBe('EBMR-EXE-270 TB18-SUSPENSION-TYPE');
    expect(await verdict('p-coat', used('EN-1', '1.000'), at)).toBe('EBMR-EXE-270 TB18-SUSPENSION-PREPARATION');
    expect(await verdict('p-coat', used(await prep('p-tb03c'), '12.000'), at)).toBe('EBMR-EXE-270 TB18-SUSPENSION-OVERUSE');
    expect(await verdict('p-coat', used(await prep('p-tb03c'), '6.000'), at)).toBe('ok');
    // What coating sprayed counts against a later discard of the same suspension (the engine sees only the TB-03 step).
    expect(await verdict('p-tb03c', { kind: 'DISCARD', quantity: { value: '5.000', unit: 'kg' }, method: 'Drain' })).toBe('EBMR-EXE-270 TB18-SUSPENSION-OVERUSE');
    expect(await verdict('p-tb03c', { kind: 'DISCARD', quantity: { value: '4.000', unit: 'kg' }, method: 'Drain' })).toBe('ok');
    // IN-37: the suspension past its use-by at the row's database time.
    await wait(3_200);
    expect(await verdict('p-coat', used(await prep('p-tb03f'), '1.000'), at)).toBe('EBMR-EXE-270 TB18-SUSPENSION-EXPIRED');
    // The parameter log (interval 1 s): one manual value of the inlet temperature, then more than 1 s without values.
    expect(await verdict('p-coat', { kind: 'ACTUAL', tag: 'inlet.temp_C', value: '52.0', unit: 'degC', source: 'MANUAL' }, at)).toBe('ok');
    await wait(1_200);
    const end = { kind: 'SPRAY_END' };
    const s1 = await stateOf(sbx, d.runId);
    const sprayStart = Object.values(s1.entries).find((e) => e['kind'] === 'SPRAY_START') as Json;
    expect(await verdict('p-coat', end, { ...at, tamper: laxEntry('p-coat', { sprayingSeconds: '1.000000', logGaps: [], endedBy: me }) })).toMatch(/^EBMR-EXE-270 .*(logGaps|sprayingSeconds)/s);
    expect(await verdict('p-coat', end, at)).toBe('ok');
    const endData = await dataOf('p-coat@L-COAT=1', 'SPRAY_END');
    expect(endData['logGaps']).toEqual(['inlet.temp_C', 'exhaust.temp_C', 'bed.temp_C', 'spray.rate_g_min', 'pan.speed_rpm']);
    expect(Object.values((await stateOf(sbx, d.runId)).exceptions).some((e) => e['type'] === 'PARAMETER_LOG_GAP')).toBe(true);
    expect(sprayStart).toBeDefined();
    // The weight-gain check: 20 coated tablets at 5.2000 g, 260.0 mg against 250.06 mg: 3.9750 %, above the maximum 3.5 %.
    const weigh = { kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', weighing: 'GROUP', count: '20', total: '5.2000', unit: 'g' };
    const gainData = { ...strip(weigh), totalMg: '5200', meanMg: '260.000000', coreMeanMg: '250.060000', weightGain: '3.9750', belowMinimum: false, aboveMaximum: true, recordedBy: me };
    expect(await verdict('p-coat', weigh, { ...at, tamper: laxEntry('p-coat', { ...gainData, weightGain: '3.0000', aboveMaximum: false }, { verificationRequired: true }) })).toMatch(/^EBMR-EXE-270 .*aboveMaximum|weightGain/s);
    expect(await verdict('p-coat', weigh, { ...at, tamper: laxEntry('p-coat', gainData, { verificationRequired: true }) })).toMatch(/^EBMR-EXE-270 .*WEIGHT_GAIN_ABOVE_MAXIMUM/s);
    expect(await verdict('p-coat', weigh, at)).toBe('ok');
    expect((await dataOf('p-coat@L-COAT=1', 'WEIGHT_CHECK'))['weightGain']).toBe('3.9750');
    const ex = Object.values((await stateOf(sbx, d.runId)).exceptions).find((e) => e['type'] === 'WEIGHT_GAIN_ABOVE_MAXIMUM') as Json;
    expect([ex['qaOnly'], (ex['block'] as Json)['until']]).toEqual([true, 'DISPOSITION']);
    // A second check in the same iteration (the engine refuses it too): continued coating is the next iteration.
    expect(await verdict('p-coat', weigh, { ...at, tamper: laxEntry('p-coat', gainData, { verificationRequired: true }) })).toBe('EBMR-EXE-270 TB18-CHECK-TWICE');
    // Closing without the suspension; the loop bound (2 iterations here, 20 for the block).
    const s2 = await stateOf(sbx, d.runId);
    const closed = structuredClone(s2);
    (closed.steps['p-coat@L-COAT=1'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.coating_close_problem($1, $2, $3) as r', [c, s2, closed])).toBeNull();
    for (const [k, e] of Object.entries(closed.entries)) if (e['kind'] === 'SUSPENSION_USED') delete closed.entries[k];
    expect(await sql('select tab.coating_close_problem($1, $2, $3) as r', [c, s2, closed])).toMatch(/TB18-NO-SUSPENSION/);
    expect(await sql('select tab.coating_loop_problem($1, $2) as r', [c, s2])).toBeNull();
    const third = structuredClone(s2);
    third.steps['p-coat@L-COAT=3'] = { ...(s2.steps['p-coat@L-COAT=1'] as Json), key: 'p-coat@L-COAT=3', frames: [{ construct: 'L-COAT', index: 3 }] };
    expect(await sql('select tab.coating_loop_problem($1, $2) as r', [c, third])).toMatch(/iteration 3 of loop L-COAT, beyond its maximum of 2 iterations \(TB18-LOOP-BOUND\)/);
  });

  it('[PR-08][PR-14][DI-32] review 3d finding 1: a value of automated equipment outside its limits is stored only with PROCESS_VALUE_OUT_OF_LIMITS at every step on a process device: a coating iteration (TB-18) and a granulation step (TB-04)', async () => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb04@' });
    const cases: [string, string, { frames?: { construct: string; index: number }[] }, Entry][] = [
      ['p-coat', 'p-coat@L-COAT=1', { frames: COAT1 }, { kind: 'ACTUAL', tag: 'inlet.temp_C', value: '58.0', unit: 'degC', source: 'MANUAL' }],
      ['p-tb04', 'p-tb04@', {}, { kind: 'ACTUAL', tag: 'granulator.power_kW', value: '7.10', unit: 'kW', source: 'MANUAL' }],
    ];
    for (const [step, key, at, entry] of cases) {
      const data = { ...strip(entry), manualFallback: true, withinLimits: false, usable: true, recordedBy: me };
      const manual = { type: 'PROCESS_MANUAL_FALLBACK', title: 'keyed by hand', controls: ['PR-14', 'DI-32'], severity: 'ALERT' as const, category: 'MANUAL_ENTRY' as const, blocks: 'NONE' as const, item: String(entry['tag']) };
      const forged = tamperHandler(step, { acceptEntry: () => ({ ok: true, data, verificationRequired: true, exceptions: [manual] }) });
      expect(await rec.message(step, entry, { ...at, tamper: forged })).toMatch(/PROCESS_VALUE_OUT_OF_LIMITS .*\[EBMR-EXE-275\]/s);
      const silent = tamperHandler(step, { acceptEntry: () => ({ ok: true, data, verificationRequired: true }) });
      expect(await rec.message(step, entry, { ...at, tamper: silent })).toMatch(/EBMR-EXE-275/);
      expect(await verdict(step, entry, at)).toBe('ok');
      const ex = Object.values((await stateOf(sbx, d.runId)).exceptions).filter((e) => (e['source'] as Json)['stepKey'] === key).map((e) => e['type']);
      expect(ex).toEqual(expect.arrayContaining(['PROCESS_VALUE_OUT_OF_LIMITS', 'PROCESS_MANUAL_FALLBACK']));
    }
  });

  it('[PR-46][PR-47][PR-50][IN-35][PR-29][INV-41][DI-10] TB-20: the sort reconciled into reject containers of this batch, a foreign tablet only with its exception, the AQL plan and the severity of the switching rule decided by the database, a rejected lot never sampled again; reject containers never charged; the destruction step closes only with every reject container destroyed under witness', async () => {
    const r1 = await container('INSPECTION');
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb20@' });
    expect(await verdict('p-tb20', { kind: 'INSPECTION_START' })).toBe('ok');
    expect(await verdict('p-tb20', { kind: 'INSPECTION_END' })).toBe('ok');
    const sort = (extra: Json = {}): Entry => ({
      kind: 'SORT_RESULT',
      inspected: { count: '200000', mass: { value: '50.000', unit: 'kg' } },
      accepted: { count: '199680', mass: { value: '49.915', unit: 'kg' } },
      defects: [{ code: 'CHIPPED', count: '300' }, { code: 'BLACK-SPOT', count: '20' }],
      rejects: [{ category: 'DESTRUCTION', container: r1.id, count: '320', mass: { value: '0.080', unit: 'kg' } }],
      ...extra,
    });
    const data = (e: Entry, extra: Json = {}): Json => ({
      ...strip(e), rejectCount: '320', defectsByClass: { CRITICAL: '0', MAJOR: '300', MINOR: '20' }, unaccountedMass: { value: '0.005', unit: 'kg' }, recordedBy: me, ...extra,
    });
    const off = sort({ accepted: { count: '199681', mass: { value: '49.915', unit: 'kg' } } });
    expect(await verdict('p-tb20', off, { tamper: laxEntry('p-tb20', data(off), { verificationRequired: true }) })).toBe('EBMR-EXE-270 TB20-RECONCILE');
    const elsewhere = sort({ rejects: [{ category: 'DESTRUCTION', container: '00000000-0000-4000-8000-000000000009', count: '320', mass: { value: '0.080', unit: 'kg' } }] });
    expect(await verdict('p-tb20', elsewhere)).toBe('EBMR-EXE-270 TB20-CONTAINER-BATCH');
    const foreign = sort({ defects: [{ code: 'CHIPPED', count: '299' }, { code: 'BLACK-SPOT', count: '20' }, { code: 'FOREIGN', count: '1' }] });
    expect(await verdict('p-tb20', foreign, { tamper: laxEntry('p-tb20', data(foreign, { defectsByClass: { CRITICAL: '1', MAJOR: '299', MINOR: '20' } }), { verificationRequired: true }) })).toMatch(/^EBMR-EXE-270 .*FOREIGN_TABLET_FOUND/s);
    expect(await verdict('p-tb20', sort())).toBe('ok');
    // The reject container is never charged.
    expect(await codeOf(asOp('select plant.charge_container($1, $2, $3) as r', [d.runId, 'PACKING', r1.label]))).toBe('EBMR-TAB-310');
    // AQL: the severity is the switching rule's (normal for the product's first lot), the plan the scheme's.
    const aql = (severity: string, found: Json): Entry => ({ kind: 'AQL_RESULT', severity, found });
    expect(await verdict('p-tb20', aql('TIGHTENED', {}))).toBe('EBMR-EXE-270 TB20-SEVERITY');
    const rejected = aql('NORMAL', { MAJOR: '11' });
    const evaluation = {
      scheme: 'AQL-SINGLE-SAMPLING', schemeVersion: '1', severity: 'NORMAL', level: 'II', lotSize: '199680', letter: 'P', sampleSize: '800',
      classes: {
        CRITICAL: { ac: '0', re: '1', found: '0', accepted: true },
        MAJOR: { aql: '0.65', letter: 'P', n: '800', ac: '10', re: '11', found: '11', accepted: false },
        MINOR: { aql: '2.5', letter: 'N', n: '500', ac: '21', re: '22', found: '0', accepted: true },
      },
      result: 'REJECTED', recordedBy: me,
    };
    expect(await verdict('p-tb20', rejected, { tamper: laxEntry('p-tb20', { ...evaluation, result: 'ACCEPTED' }) })).toMatch(/^EBMR-EXE-270 .*result/s);
    expect(await verdict('p-tb20', rejected, { tamper: laxEntry('p-tb20', evaluation) })).toMatch(/^EBMR-EXE-270 .*AQL_REJECTED/s);
    // Review 3d finding 3: lots of one product are judged one at a time: while another lot of the product is being
    // recorded (its lock held), this one waits (here: gives up after 500 ms); afterwards it is recorded.
    const product = (await sql<string>("select recipe.batch_product($1) ->> 'code' as r", [d.runId])) ?? '';
    const holder = await sbx.db.admin.connect();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(hashtext($1))', [`tab.aql_lot_result:${product}:SANDBOX`]);
      expect(await verdict('p-tb20', rejected, { before: async (cl) => { await cl.query("set local lock_timeout = '500ms'"); } })).toMatch(/lock timeout/);
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    expect(await verdict('p-tb20', rejected)).toBe('ok');
    expect(await dataOf('p-tb20@', 'AQL_RESULT')).toEqual(evaluation);
    const lot = await sql<Json>("select jsonb_build_object('severity', severity, 'accepted', accepted, 'installation', installation) as r from tab.aql_lot_result where batch_id = $1", [d.runId]);
    expect(lot).toEqual({ severity: 'NORMAL', accepted: false, installation: 'SANDBOX' });
    // INV-41: never a second AQL result (a forged engine; the engine refuses it too).
    expect(await verdict('p-tb20', aql('NORMAL', {}), { tamper: laxEntry('p-tb20', { ...evaluation, result: 'ACCEPTED' }) })).toBe('EBMR-EXE-270 TB20-AQL-TWICE');
    // Destruction: the G-23 step closes only with every container for destruction destroyed, quantity for quantity.
    const c = await content();
    // The step waits behind the AQL rejection (QA decides first); its close is read on the run's state with the step in
    // progress, then closed.
    const s0 = structuredClone(await stateOf(sbx, d.runId));
    s0.steps['p-destroy@'] = { key: 'p-destroy@', step: 'p-destroy', frames: [], status: 'IN_PROGRESS' };
    const closing = structuredClone(s0);
    (closing.steps['p-destroy@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.coating_close_problem($1, $2, $3) as r', [c, s0, closing])).toMatch(/TB20-NOT-DESTROYED/);
    // The destruction names the container by its label (a test run cannot hold a real-format label in an entry, so the
    // destruction entry is laid into the run's state here; the rule is the close's, read on that state).
    const aqlAt = (s0.entries[await lastEntry(sbx, d.runId, 'p-tb20@', 'AQL_RESULT')] as Json)['recordedAt'];
    const destroyed = (value: string) => ({
      id: 'EN-900', stepKey: 'p-destroy@', kind: 'DISPOSAL', recordedSeq: 900, recordedAt: aqlAt,
      data: { category: 'DESTRUCTION', material: 'Inspection rejects', quantity: { value, unit: 'kg' }, container: r1.label, method: 'Incineration' },
    });
    const short = structuredClone(closing);
    short.entries['EN-900'] = destroyed('0.070');
    expect(await sql('select tab.coating_close_problem($1, $2, $3) as r', [c, s0, short])).toMatch(/TB20-NOT-DESTROYED/);
    const full = structuredClone(closing);
    full.entries['EN-900'] = destroyed('0.0800');
    expect(await sql('select tab.coating_close_problem($1, $2, $3) as r', [c, s0, full])).toBeNull();
    // The MBR's destruction step is witnessed.
    const unwitnessed = JSON.parse(JSON.stringify(c).replace('"meaning":"WITNESSED"', '"meaning":"VERIFIED"')) as Json;
    expect(await sql('select tab.coating_mbr_problem($1) as r', [unwitnessed])).toMatch(/TB20-DESTRUCTION/);
    // Review 3d finding 2: the destruction step comes after the inspection in its sequence and is never skippable.
    const seq = (x: Json): Json => JSON.parse(JSON.stringify(x)) as Json;
    const swap = (x: Json): Json => {
      const y = seq(x);
      const visit = (n: unknown): void => {
        if (n && typeof n === 'object') {
          const o = n as Json;
          if (o['id'] === 'seq-insp') (o['children'] as Json[]).reverse();
          Object.values(o).forEach(visit);
        }
      };
      visit(y);
      return y;
    };
    expect(await sql('select tab.coating_mbr_problem($1) as r', [c])).toBeNull();
    expect(await sql('select tab.coating_mbr_problem($1) as r', [swap(c ?? {})])).toMatch(/TB20-DESTRUCTION/);
    const skippable = seq(c ?? {});
    const mark = (n: unknown): void => {
      if (n && typeof n === 'object') {
        const o = n as Json;
        if (o['id'] === 'p-destroy') o['config'] = { skippable: true };
        Object.values(o).forEach(mark);
      }
    };
    mark(skippable);
    expect(await sql('select tab.coating_mbr_problem($1) as r', [skippable])).toMatch(/TB20-DESTRUCTION/);
    expect(DEFECTS.find((x) => x.code === 'FOREIGN')?.class).toBe('CRITICAL');
  });

  it('[PR-29][PR-47] the switching rule: normal until 2 of at most 5 consecutive lots are not accepted, then tightened until 5 consecutive lots are accepted', async () => {
    const product = 'TEST-SWITCH-PRODUCT';
    const lots = async (accepted: boolean[]) => {
      for (const a of accepted) {
        await asSetup(sbx, "insert into tab.aql_lot_result (batch_id, installation, product_code, step_key, entry_id, severity, accepted) values ($1, 'SANDBOX', $2, 'p-tb20@', 'EN-' || (floor(random() * 1e8) + 1)::bigint, 'NORMAL', $3)", [d.runId, product, a]);
        await wait(5);
      }
    };
    const severity = () => sql<string>("select tab.aql_severity($1, 'SANDBOX') as r", [product]);
    expect(await severity()).toBe('NORMAL');
    await lots([false, true, true, true, true, true, false]);
    expect(await severity()).toBe('NORMAL');
    await lots([true, false]);
    expect(await severity()).toBe('TIGHTENED');
    await lots([true, true, true, true]);
    expect(await severity()).toBe('TIGHTENED');
    await lots([true]);
    expect(await severity()).toBe('NORMAL');
    expect(await sql<string>("select tab.aql_severity($1, 'GMP') as r", [product])).toBe('NORMAL');
  });
});
