/**
 * Phase 3 slice 3c (builder B): the IPC blocks' rules held by the database (tablets 0890 to 0893), proven as the
 * application role past the server: an honest entry the engine builds is stored; the same act through a tampered block
 * handler (a forged engine: a rule skipped, an evaluation or an exception changed) is refused by the database alone. The
 * TB-11 bracketing hold goes through the slice 1 container commands: a passing, failing or missed check is recorded for
 * its press and stream (plant.record_ipc_check), and a container filled since the last passing check is held. Times are
 * the database's. Rules about closing a step are read through their functions on the run's real state, forged where the
 * test says so.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { openServiceSession } from '@ebmr/test-kit';
import { recordIpcOverdue } from '../../../src/features/execution/sweeper.ts';
import type { flow } from '@ebmr/recipe-core';
import { DEMO_GATEWAY, DEMO_INSTRUMENTS, enrolGateway } from '../../../src/features/devices/enrol.ts';
import { IPC_BLOCK_VERSIONS } from '../../../src/blocks/ipc/index.ts';
import { NOT_APPLICABLE, RULE_SETS } from '../../../src/blocks/ipc/rule-sets.ts';
import { COMPRESSION_SAMPLE_CEILING } from '../../../src/blocks/tb-11.ts';
import { actorOfBrowser } from '../../esig/support.ts';
import { adminActor, fakeGateway, gatewayKey, type FakeGateway } from '../../devices/support.ts';
import { report, untilVouched } from '../../devices/room-scales-support.ts';
import { dcMiniVariant, importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../../execution/support.ts';
import { fakeTimers, laxEntry, recorder, stateOf, lastEntry, tamperHandler, type Entry } from '../granulation/db-support.ts';
import { TB11 } from '../../../src/blocks/tb-11.ts';

type Json = Record<string, unknown>;

let sbx: ExecServer;
let gw: FakeGateway | undefined;
let me: string;

const advance = (): void => {
  vi.advanceTimersByTime(7_000);
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };
const phaseOf = (id: string, type: string, config: Json): Json => ({
  kind: 'phase', id, name: `IPC step ${id}`, block: { type, version: '1' }, config,
  records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [], signatures: SIGNATURES, significant: true, riskClass: 'HIGH',
});

const WEIGHT = { mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '250.0', n: 20, weighing: 'GROUP', tolerance: { action: '2', alert: '1' } };

/** dc-mini with the IPC steps first in its dispensing preparation, each in a branch of one parallel node. */
function ipcMbr(every: { value: string; unit: string }, grace: { value: string; unit: string }): flow.MbrContent {
  return dcMiniVariant((prep) => {
    const branches = [
      // A run of another process than compression (the first-off rule of compression is p-tb11c's).
      phaseOf('p-tb11', 'TB-11', {
        process: 'OTHER',
        streams: [{ id: 'L' }, { id: 'R' }],
        plan: [{ test: 'WEIGHT', every, qrmRef: 'QRM-IPC-07' }],
        grace,
        sweep: { stations: 3, weight: { individual: { action: { min: '237.5', max: '262.5' } } } },
        weight: WEIGHT,
      }),
      phaseOf('p-tb11c', 'TB-11', {
        streams: [{ id: 'L' }],
        plan: [{ test: 'WEIGHT', every: { value: '15', unit: 'min' }, qrmRef: 'QRM-IPC-07' }],
        grace: { value: '5', unit: 'min' },
        sweep: { stations: 3, weight: { individual: { action: { min: '237.5', max: '262.5' } } } },
        weight: WEIGHT,
      }),
      phaseOf('p-tb12', 'TB-12', { mode: 'UNIFORMITY', tabletType: 'UNCOATED' }),
      phaseOf('p-tb12d', 'TB-12', { mode: 'CONTENT', tabletType: 'UNCOATED' }),
      phaseOf('p-tb13', 'TB-13', { n: 3, thickness: { individual: { action: { min: '3.2', max: '3.6' } } }, hardness: { unit: 'kp', individual: { action: { min: '60', max: '120' } } }, defects: ['CAPPING', 'STICKING'] }),
      phaseOf('p-tb14', 'TB-14', { tabletType: 'UNCOATED' }),
      phaseOf('p-tb15', 'TB-15', { tabletType: 'UNCOATED', timeLimit: { value: '3', unit: 's' } }),
    ];
    return [{ kind: 'parallel', id: 'par-ipc', branches: branches.map((b, i) => ({ id: `br-ipc-${i + 1}`, name: `IPC ${i + 1}`, body: b })) }, ...prep];
  });
}

/** The press, the balance and the testers as plant equipment (master data arranged by the superuser). */
async function plantEquipment(): Promise<void> {
  const c = await sbx.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query("insert into plant.product (code, name, highly_potent, recorded_by) values ('PCM500', 'Paracetamol tablets', false, gen_random_uuid()) on conflict do nothing");
    await c.query("insert into plant.equipment_class (code, kind, description, calibration_required, check_regime, recorded_by) values ('EQC-IPC', 'INSTRUMENT', 'IPC balance and testers', true, 'PER_USE', gen_random_uuid())");
    await c.query("insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, recorded_by) values ('EQC-PRESS', 'PROCESS', 'Rotary press', interval '3 days', interval '2 days', false, gen_random_uuid())");
    await c.query("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ('TEST-PRESS-01', 'Rotary press', 'EQC-PRESS', 'PROCESS', gen_random_uuid())");
    for (const code of ['TEST-BAL-01', 'TEST-HT-01', 'TEST-FRB-01', 'TEST-DT-01', 'TEST-BAL-09']) {
      const { rows } = await c.query<{ id: string }>("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ($1, $1, 'EQC-IPC', 'INSTRUMENT', gen_random_uuid()) returning id", [code]);
      await c.query("insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) values ($1, 'QUALIFIED', 'QUAL-IPC', 'IQ/OQ/PQ approved', gen_random_uuid(), gen_random_uuid())", [rows[0]?.id]);
      await c.query("insert into plant.calibration (equipment_id, due_at, as_found, as_left, reference, person_id, account_id) values ($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', 'CAL-IPC', gen_random_uuid(), gen_random_uuid())", [rows[0]?.id]);
    }
    await c.query('commit');
  } finally {
    c.release();
  }
}

interface Ctx {
  d: RunDriver;
  rec: ReturnType<typeof recorder>;
}

/** operator1's command in the run's own browser session. */
async function asOperator<T>(x: Ctx, work: (c: PoolClient) => Promise<T>): Promise<T> {
  advance();
  return withCommand(sbx.db.app, await actorOfBrowser(sbx, x.d.browser('operator1'), 'operator1'), work);
}

/** A run of the IPC MBR with the press in use for it (superuser) and the instruments checked and in use (operator1). */
async function newRun(every = { value: '60', unit: 's' }, grace = { value: '30', unit: 's' }, instruments = ['TEST-BAL-01', 'TEST-HT-01', 'TEST-FRB-01', 'TEST-DT-01']): Promise<Ctx> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, ipcMbr(every, grace)));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1') });
  d.beforeTap = advance;
  const x = { d, rec: recorder(sbx, d, advance) };
  const c = await sbx.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(
      `insert into plant.equipment_use (equipment_id, previous_use_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by)
       select q.id, (select u.id from plant.equipment_use u where u.equipment_id = q.id order by u.started_at desc limit 1), b.id, b.batch_number, 'PCM500', clock_timestamp() + interval '8 hours', gen_random_uuid(), gen_random_uuid()
         from plant.equipment q, recipe.batch_execution b where q.code = 'TEST-PRESS-01' and b.id = $1`,
      [runId],
    );
    await c.query('commit');
  } finally {
    c.release();
  }
  await asOperator(x, async (cl) => {
    for (const code of instruments) {
      await cl.query("select plant.record_instrument_check($1, 'PASS', 'IPC per-use check', $2::uuid)", [code, runId]);
      await cl.query("select plant.record_instrument_use($1, $2::uuid, clock_timestamp() + interval '8 hours')", [code, runId]);
    }
  });
  return x;
}

/** The database's answer for an act: 'ok', or the EBMR code and the rule code it names. */
async function verdict(x: Ctx, step: string, entry: Entry, opts: Parameters<ReturnType<typeof recorder>['message']>[2] = {}): Promise<string> {
  const m = await x.rec.message(step, entry, opts);
  if (m === 'ok') return m;
  const code = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(m)?.[1] ?? '?';
  const rule = /\((?:[^()]*; )?(TB1\d-[A-Z0-9-]+)\)/.exec(m)?.[1] ?? /(TB1\d-[A-Z0-9-]+)/.exec(m)?.[1];
  return rule ? `${code} ${rule}` : `${code} ${m.slice(0, 400)}`;
}

async function sql<T>(text: string, params: unknown[]): Promise<T | null> {
  const { rows } = await sbx.db.admin.query<{ r: T | null }>(text, params);
  return rows[0]?.r ?? null;
}

const entryData = async (x: Ctx, key: string, kind: string): Promise<Json> => {
  const s = await stateOf(sbx, x.d.runId);
  return (s.entries[await lastEntry(sbx, x.d.runId, key, kind)]?.['data'] ?? {}) as Json;
};
const types = async (x: Ctx, key: string): Promise<string[]> =>
  Object.values((await stateOf(sbx, x.d.runId)).exceptions).filter((e) => (e['source'] as Json)['stepKey'] === key).map((e) => String(e['type'])).sort();
const checks = async (x: Ctx): Promise<string[][]> =>
  (await sbx.db.admin.query<{ s: string; r: string }>('select coalesce(stream, \'-\') as s, result as r from plant.ipc_check where batch_id = $1 order by recorded_at, id', [x.d.runId])).rows.map((r) => [r.s, r.r]);

/** The data an honest engine stores, without the members the forged test changes (for laxEntry). */
const strip = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([k, v]) => k !== 'kind' && v !== undefined));
const manualGroup = (stream: string | undefined, g: string, extra: Json = {}): Entry => ({ kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'MANUAL', groupWeight: g, ...(stream ? { stream } : {}), ...extra });
const sweep = (stream: string, ws = ['250.0', '251.0', '249.5']): Entry => ({
  kind: 'STATION_SWEEP', instrument: 'TEST-BAL-01', capture: 'MANUAL', stream, stations: ws.map((w, i) => ({ station: i + 1, weight: w })),
});

beforeAll(async () => {
  sbx = await startExecServer();
  fakeTimers();
  me = personaIn(sbx, 'operator1').personId;
  await plantEquipment();
  await enrolGateway(sbx.db.app, await adminActor(sbx), { ...DEMO_GATEWAY, spki: gatewayKey(sbx).publicKeySpki, instruments: DEMO_INSTRUMENTS });
  gw = await fakeGateway(sbx);
  if (!(await untilVouched(sbx))) throw new Error('SETUP: the gateway listener did not vouch within 20 s');
  await report({ server: sbx, gw }, { 'TEST-BAL-01': 'ONLINE' });
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await gw?.close();
  await sbx?.close();
});

describe('the IPC blocks in the database (tablets 0890 to 0893)', () => {
  it('[DI-30][DI-10][IN-34] the database holds the data schemas of TB-11 to TB-15 as the registry declares them, their rule codes, the compendial rule sets with source, confidence and effective dates exactly as rule-sets.ts, and the compression ceiling; nothing can change them', async () => {
    const { rows } = await sbx.db.admin.query<{ k: string; schema: Json }>(
      "select block_type || '@' || block_version || ' ' || entry_kind as k, schema from recipe.block_data_schema where block_type in ('TB-11', 'TB-12', 'TB-13', 'TB-14', 'TB-15')",
    );
    const want: Record<string, Json> = {};
    for (const b of IPC_BLOCK_VERSIONS) for (const [k, s] of Object.entries(b.dataSchema?.entries ?? {})) want[`${b.type}@${b.version} ${k}`] = schemaJson(s as unknown as { type: string } & Json);
    expect(Object.fromEntries(rows.map((r) => [r.k, r.schema]))).toEqual(want);
    const src = ['tb-11', 'tb-12', 'tb-13', 'tb-14', 'tb-15'].map((f) => readFileSync(new URL(`../../../src/blocks/${f}.ts`, import.meta.url), 'utf8')).join('\n');
    const codes = [...new Set([...src.matchAll(/'(TB1\d(?:-[A-Z0-9]+)+)'/g)].map((m) => m[1] ?? ''))];
    const named = (await sbx.db.admin.query<{ name: string }>("select name from recipe.engine_name where name like 'TB1%'")).rows.map((r) => r.name);
    expect(codes.filter((c) => !named.includes(c))).toEqual([]);
    const sets = await sbx.db.admin.query<Json>(
      "select code, version, test, pharmacopoeia, markets, tablet_types, params, confidence, source, to_char(effective_from, 'YYYY-MM-DD') as effective_from, effective_to, note from tab.compendial_rule_set order by code collate \"C\"",
    );
    expect(sets.rows).toEqual(
      [...RULE_SETS].sort((a, b) => (a.code < b.code ? -1 : 1)).map((r) => ({
        code: r.code, version: r.version, test: r.test, pharmacopoeia: r.pharmacopoeia, markets: r.markets, tablet_types: r.tabletTypes, params: JSON.parse(JSON.stringify(r.params)) as Json,
        confidence: r.confidence, source: r.source, effective_from: r.effectiveFrom, effective_to: r.effectiveTo ?? null, note: r.note ?? null,
      })),
    );
    const na = await sbx.db.admin.query("select test, market, reason, source, to_char(effective_from, 'YYYY-MM-DD') as f from tab.compendial_not_applicable order by test, market");
    expect(na.rows).toEqual(NOT_APPLICABLE.map((n) => ({ test: n.test, market: n.market, reason: n.reason, source: n.source, f: n.effectiveFrom })));
    expect((await sbx.db.admin.query("select key, value, unit, source, to_char(effective_from, 'YYYY-MM-DD') as f from tab.ipc_rule")).rows).toEqual([
      { key: COMPRESSION_SAMPLE_CEILING.key, value: COMPRESSION_SAMPLE_CEILING.value, unit: COMPRESSION_SAMPLE_CEILING.unit, source: COMPRESSION_SAMPLE_CEILING.source, f: COMPRESSION_SAMPLE_CEILING.effectiveFrom },
    ]);
    await expect(sbx.db.admin.query("update tab.compendial_rule_set set params = '{}' where code = 'IP-UOW'")).rejects.toThrow(/EBMR-AUDIT-004|EBMR-/);
    await expect(sbx.db.app.query("insert into tab.ipc_rule (key, value, unit, source, effective_from) values ('x', '60', 'min', 'x', '2026-01-01')")).rejects.toThrow(/permission denied/);
  });

  it('[IN-34][PR-29][DI-10][DI-29] TB-12 uniformity of weight: the honest evaluation against the IP rule set is stored; a forged evaluation, a forged result without its exception, a check on an instrument without a use, a hand-keyed check without its second person are refused by the database alone', async () => {
    const x = await newRun();
    await x.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb12@' });
    const ws = [...Array.from({ length: 3 }, () => '263.0'), ...Array.from({ length: 3 }, () => '237.0'), ...Array.from({ length: 14 }, () => '250.0')];
    const check: Entry = { kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'MANUAL', weights: ws };
    // A forged evaluation that counts only two tablets outside the band (a pass), and a forged pass result.
    const forgedPass = { instrument: 'TEST-BAL-01', capture: 'MANUAL', weights: ws, mode: 'UNIFORMITY', result: 'PASS', late: false, recordedBy: me };
    expect(await verdict(x, 'p-tb12', check, { tamper: laxEntry('p-tb12', forgedPass, { verificationRequired: true }) })).toMatch(/^EBMR-TAB-300 .*(evaluation|ruleSets|sampledAtUs)/s);
    // The instrument without a use for this batch.
    expect(await verdict(x, 'p-tb12', { ...check, instrument: 'TEST-BAL-09' })).toBe('EBMR-TAB-300 TB12-INSTRUMENT');
    // Captured from the instrument with readings never claimed.
    expect(await verdict(x, 'p-tb12', { ...check, capture: 'DEVICE', readings: Array.from({ length: 20 }, () => randomUUID()) })).toBe('EBMR-TAB-300 TB12-DEVICE');
    // A container of the press, closed before the check (review 3c finding 3: a step of its own holds the press output).
    const box = await asOperator(x, async (cl) => (await cl.query<{ r: Json }>("select plant.open_container($1, 'COMPRESSION', 'kg', 'TEST-PRESS-01') as r", [x.d.runId])).rows[0]?.r ?? {});
    await asOperator(x, (cl) => cl.query('select plant.close_container($1, 12.5, $2)', [box['container_id'], box['version']]));
    // The honest check: 6 tablets outside the 5 % band of a 250 mg average: it fails, with its exception.
    expect(await verdict(x, 'p-tb12', check)).toBe('ok');
    expect(await sql<string>("select state as r from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = $1", [box['container_id']])).toBe('HELD');
    expect(await checks(x)).toEqual([['-', 'FAIL']]);
    const d = await entryData(x, 'p-tb12@', 'WEIGHT_CHECK');
    expect([d['result'], d['ruleSets'], ((d['evaluation'] as Json)['criteria'] as Json[])[0]]).toEqual([
      'FAIL', [{ code: 'IP-UOW', version: 1 }], { ruleSet: 'IP-UOW', version: 1, percent: '5', outside: 6, outsideDouble: 0, pass: false },
    ]);
    expect(await types(x, 'p-tb12@')).toEqual(['IPC_CHECK_FAILED', 'IPC_MANUAL_ENTRY']);
    expect((await stateOf(sbx, x.d.runId)).steps['p-tb12@']?.['verificationRequired']).toBe(true);
    // The same failing check forged without IPC_CHECK_FAILED (the handler stores the true data, raises nothing).
    const real = { ...d, sampledAtUs: undefined };
    expect(await verdict(x, 'p-tb12', check, { tamper: laxEntry('p-tb12', strip(real), { verificationRequired: true }) })).toMatch(/^EBMR-TAB-300 .*(sampledAtUs|IPC_)/s);
  });

  it('[DI-32][DI-31][PR-29] a weight read from the balance stands on the reading claimed for it in the same command, of that value in the entry\'s unit (kg read, mg recorded), and on no other', async () => {
    const x = await newRun();
    await x.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb11@' });
    expect(await verdict(x, 'p-tb11', { kind: 'RUN_START', press: 'TEST-PRESS-01' })).toBe('ok');
    const reading = async (value: string): Promise<string> => {
      const r = gw?.next({ deviceCode: 'TEST-BAL-01', serial: 'SIM-0001', purpose: 'CHECK', value });
      if (!gw || !r) throw new Error('SETUP: no gateway');
      const res = await gw.uplink([{ reading: r, delayUs: '1000' }]);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return r.readingId;
    };
    const claim = (ids: string[]) => async (c: PoolClient) => {
      await c.query("select tab.claim_readings($1::uuid[], 'DISP-1', 600000000, 'IPC')", [ids]);
    };
    const id1 = await reading('0.005');
    const group = (id: string, g: string): Entry => ({ kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'DEVICE', readings: [id], stream: 'L', groupWeight: g });
    expect(await verdict(x, 'p-tb11', group(id1, '5000'))).toBe('EBMR-TAB-300 TB11-DEVICE');
    const id2 = await reading('0.005');
    expect(await verdict(x, 'p-tb11', group(id2, '5001'), { before: claim([id2]) })).toBe('EBMR-TAB-300 TB11-DEVICE');
    const id3 = await reading('0.005');
    expect(await verdict(x, 'p-tb11', group(id3, '5000'), { before: claim([id3]) })).toBe('ok');
    const d = await entryData(x, 'p-tb11@', 'WEIGHT_CHECK');
    expect([d['capture'], d['readings'], d['result']]).toEqual(['DEVICE', [id3], 'PASS']);
    expect(await types(x, 'p-tb11@')).toEqual([]);
  });

  it('[INV-41][IN-34][PR-29] TB-12 weight variation: a first stage that fails its acceptance value waits for its second stage; a new first stage forged past the engine is refused; the second stage is evaluated by the database on every unit of both stages; the step closes only after it', async () => {
    const x = await newRun();
    await x.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb12d@' });
    const first = ['210.0', '290.0', '220.0', '280.0', '230.0', '270.0', '240.0', '260.0', '250.0', '250.0'];
    const check: Entry = { kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'MANUAL', weights: first, assay: '99.0', assayRef: 'TEST-LIMS-01' };
    expect(await verdict(x, 'p-tb12d', check)).toBe('ok');
    const d1 = await entryData(x, 'p-tb12d@', 'WEIGHT_CHECK');
    expect(d1['result']).toBe('SECOND_STAGE');
    // A second first stage, forged past the engine's refusal, is refused by the database (INV-41: never a new attempt).
    expect(await verdict(x, 'p-tb12d', { ...check, weights: Array.from({ length: 10 }, () => '250.0') }, { tamper: laxEntry('p-tb12d', {}) })).toBe('EBMR-TAB-300 TB12-SECOND-STAGE-PENDING');
    const firstId = await lastEntry(sbx, x.d.runId, 'p-tb12d@', 'WEIGHT_CHECK');
    const c = await sql<Json>('select recipe.batch_mbr_content($1) as r', [x.d.runId]);
    const old = await stateOf(sbx, x.d.runId);
    const closed = structuredClone(old);
    (closed.steps['p-tb12d@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.ipc_close_problem($1, $2, $3) as r', [c, old, closed])).toMatch(/TB12-SECOND-STAGE-PENDING/);
    const second: Entry = { kind: 'WEIGHT_SECOND_STAGE', check: firstId, instrument: 'TEST-BAL-01', capture: 'MANUAL', weights: Array.from({ length: 20 }, () => '250.0') };
    // A forged second stage that claims a pass on the first ten units only.
    expect(await verdict(x, 'p-tb12d', second, { tamper: laxEntry('p-tb12d', { ...strip(second), result: 'PASS' }, { verificationRequired: true }) })).toMatch(/^EBMR-TAB-300 /);
    expect(await verdict(x, 'p-tb12d', second)).toBe('ok');
    const d2 = await entryData(x, 'p-tb12d@', 'WEIGHT_SECOND_STAGE');
    expect([(d2['evaluation'] as Json)['n'], d2['result']]).toEqual([30, 'PASS']);
    const now = await stateOf(sbx, x.d.runId);
    const done = structuredClone(now);
    (done.steps['p-tb12d@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.ipc_close_problem($1, $2, $3) as r', [c, now, done])).toBeNull();
  });

  it('[IN-35][PR-29][DI-32] TB-13: breaking force read in kp judged in N, a defect fails the check with its exception; a forged pass is refused. TB-14: a loss above the limit asks for two more runs, a forged pass is refused. TB-15: the bath temperature is verified before the start and the time is measured by the database', async () => {
    const x = await newRun();
    for (const s of ['p-tb13@', 'p-tb14@', 'p-tb15@']) await x.d.ok('operator1', { type: 'START_STEP', stepKey: s });
    const phys = (defects: string[]): Entry => ({ kind: 'PHYSICAL_CHECK', instrument: 'TEST-HT-01', capture: 'MANUAL', tablets: ['7.5', '8.0', '7.8'].map((h) => ({ thickness: '3.40', hardness: h })), defects });
    expect(await verdict(x, 'p-tb13', phys(['CAPPING']), { tamper: laxEntry('p-tb13', { ...strip(phys(['CAPPING'])), result: 'PASS' }, { verificationRequired: true }) })).toMatch(/^EBMR-TAB-300 /);
    expect(await verdict(x, 'p-tb13', phys(['CAPPING']))).toBe('ok');
    const p = await entryData(x, 'p-tb13@', 'PHYSICAL_CHECK');
    expect([(p['evaluation'] as Json)['hardness'], p['result']]).toEqual([{ unit: 'N', mean: '76.1650', min: '73.549875', max: '78.4532', result: 'PASS' }, 'FAIL']);
    expect(await types(x, 'p-tb13@')).toEqual(['IPC_CHECK_FAILED', 'IPC_MANUAL_ENTRY']);
    const run = (initial: string, final: string, extra: Json = {}): Entry => ({ kind: 'FRIABILITY_RUN', instrument: 'TEST-FRB-01', capture: 'MANUAL', tablets: 26, initialMass: initial, finalMass: final, rotations: 100, rpm: '25.0', broken: false, ...extra });
    expect(await verdict(x, 'p-tb14', run('7.100', '7.050'), { tamper: laxEntry('p-tb14', strip(run('7.100', '7.050'))) })).toBe('EBMR-TAB-300 TB14-SAMPLE');
    expect(await verdict(x, 'p-tb14', run('6.500', '6.420'), { tamper: laxEntry('p-tb14', { ...strip(run('6.500', '6.420')), result: 'PASS' }, { verificationRequired: true }) })).toMatch(/^EBMR-TAB-300 /);
    expect(await verdict(x, 'p-tb14', run('6.500', '6.420'))).toBe('ok');
    expect([(await entryData(x, 'p-tb14@', 'FRIABILITY_RUN'))['reported'], (await entryData(x, 'p-tb14@', 'FRIABILITY_RUN'))['result']]).toEqual(['1.2', 'REPEAT']);
    expect(await verdict(x, 'p-tb14', run('6.500', '6.480'), { tamper: laxEntry('p-tb14', {}) })).toBe('EBMR-TAB-300 TB14-REPEAT-PENDING');
    const start = (t: string): Entry => ({ kind: 'DT_START', instrument: 'TEST-DT-01', capture: 'MANUAL', bathTemperature: t, stage: 'MAIN' });
    expect(await verdict(x, 'p-tb15', start('40.0'), { tamper: laxEntry('p-tb15', strip(start('40.0'))) })).toBe('EBMR-TAB-300 TB15-BATH-TEMP');
    expect(await verdict(x, 'p-tb15', start('37.0'))).toBe('ok');
    const end: Entry = { kind: 'DT_END', capture: 'MANUAL', units: Array.from({ length: 6 }, () => ({ disintegrated: true })) };
    // Ended within the 3 s limit at the database's time it passes; a forged elapsed time is refused.
    expect(await verdict(x, 'p-tb15', end, { tamper: laxEntry('p-tb15', { ...strip(end), elapsedSeconds: '1.000000', passed: 6, result: 'PASS', recordedBy: me }, { verificationRequired: true }) })).toMatch(/^EBMR-TAB-300 .*elapsedSeconds/s);
    await wait(3_200);
    expect(await verdict(x, 'p-tb15', end)).toBe('ok');
    const e = await entryData(x, 'p-tb15@', 'DT_END');
    expect([Number(e['elapsedSeconds']) > 3, e['passed'], e['result']]).toEqual([true, 0, 'FAIL']);
  });

  it('[IN-35][PR-29][PR-07] TB-11: the run starts only on a plant press in use for the batch; a passing check is recorded for its stream and vouches for the containers closed before it; a failing check holds every container of the press since the last passing check (the slice 1 hold), and a passing check cannot be recorded past the scheduler', async () => {
    const x = await newRun();
    await x.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb11@' });
    expect(await verdict(x, 'p-tb11', { kind: 'RUN_START', press: 'TEST-BAL-01' })).toBe('EBMR-TAB-300 TB11-PRESS');
    expect(await verdict(x, 'p-tb11', { kind: 'RUN_START', press: 'TEST-PRESS-01' })).toBe('ok');
    expect(await verdict(x, 'p-tb11', sweep('L'))).toBe('ok');
    expect(await verdict(x, 'p-tb11', sweep('R'))).toBe('ok');
    const open = (stream: string) => asOperator(x, async (c) => (await c.query<{ r: Json }>("select plant.open_container($1, 'COMPRESSION', 'kg', 'TEST-PRESS-01', $2) as r", [x.d.runId, stream])).rows[0]?.r ?? {});
    const close = (r: Json) => asOperator(x, (c) => c.query('select plant.close_container($1, 12.5, $2)', [r['container_id'], r['version']]));
    const state = async (r: Json) => sql<string>("select state as r from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = $1", [r['container_id']]);
    const c1 = await open('L');
    await close(c1);
    expect(await verdict(x, 'p-tb11', manualGroup('L', '5000.0'))).toBe('ok');
    expect(await checks(x)).toEqual([['L', 'PASS'], ['R', 'PASS'], ['L', 'PASS']]);
    // A passing check through the plant command directly, past the scheduler, is refused; a failing one is allowed.
    const direct = (result: string) => codeOfQuery(x, "select plant.record_ipc_check($1, 'TEST-PRESS-01', 'L', $2, 'operator says so')", [x.d.runId, result]);
    expect(await direct('PASS')).toBe('EBMR-TAB-302');
    const c2 = await open('L');
    await close(c2);
    const c3 = await open('R');
    expect(await state(c2)).toBe('CLOSED');
    // A failing group weight on L: the database records FAIL; every container of the press since the last pass is held
    // (the press discharges both streams together, the stricter default), the open one at its close.
    expect(await verdict(x, 'p-tb11', manualGroup('L', '5200.0'), { tamper: laxEntry('p-tb11', {}) })).toMatch(/^EBMR-TAB-300 /);
    expect(await verdict(x, 'p-tb11', manualGroup('L', '5200.0'))).toBe('ok');
    expect(await types(x, 'p-tb11@')).toEqual(['IPC_CHECK_FAILED', 'IPC_MANUAL_ENTRY', 'IPC_MANUAL_ENTRY', 'IPC_MANUAL_ENTRY', 'IPC_MANUAL_ENTRY']);
    expect((await checks(x)).at(-1)).toEqual(['L', 'FAIL']);
    expect([await state(c1), await state(c2)]).toEqual(['CLOSED', 'HELD']);
    expect(await sql<number>('select count(*)::int as r from plant.container_hold where container_id = $1', [c3['container_id']])).toBe(1);
    expect(await direct('FAIL')).toBe('ok');
  });

  it('[IN-35][PR-29][DI-28] TB-11 missed check at database time: the overdue checks are read at an instant (catalogue test: the alarm fires once the interval and grace have passed), recorded once as an alarm by the server sweeper job without any operator entry, and the next entry must list them with IPC_CHECK_MISSED, the database recording MISSED for each stream and holding its containers', async () => {
    const x = await newRun({ value: '2', unit: 's' }, { value: '1', unit: 's' });
    await x.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb11@' });
    expect(await verdict(x, 'p-tb11', { kind: 'RUN_START', press: 'TEST-PRESS-01' })).toBe('ok');
    expect(await verdict(x, 'p-tb11', sweep('L'))).toBe('ok');
    expect(await verdict(x, 'p-tb11', sweep('R'))).toBe('ok');
    const s = await stateOf(sbx, x.d.runId);
    const startUs = BigInt(String((Object.values(s.entries).find((e) => e['kind'] === 'RUN_START')?.['recordedAt'] as Json)['$u']));
    const at = (us: bigint) => sql<Json[]>("select tab.ipc_overdue_at($1, timestamp with time zone 'epoch' + $2::numeric * interval '1 microsecond') as r", [x.d.runId, us.toString()]);
    expect(await at(startUs + 3_000_000n)).toEqual([]);
    expect((await at(startUs + 3_000_001n))?.map((m) => [m['stepKey'], m['stream'], m['test'], m['dueUs']])).toEqual([
      ['p-tb11@', 'L', 'WEIGHT', (startUs + 2_000_000n).toString()],
      ['p-tb11@', 'R', 'WEIGHT', (startUs + 2_000_000n).toString()],
    ]);
    const c1 = await asOperator(x, async (c) => (await c.query<{ r: Json }>("select plant.open_container($1, 'COMPRESSION', 'kg', 'TEST-PRESS-01', 'R') as r", [x.d.runId])).rows[0]?.r ?? {});
    const c2 = await asOperator(x, async (c) => (await c.query<{ r: Json }>("select plant.open_container($1, 'COMPRESSION', 'kg', 'TEST-PRESS-01', 'L') as r", [x.d.runId])).rows[0]?.r ?? {});
    await asOperator(x, (c) => c.query('select plant.close_container($1, 12.5, $2)', [c2['container_id'], c2['version']]));
    await wait(3_500);
    // The server's sweeper job records the alarms at database time without any operator entry, once each.
    const sweeper = { ...(await openServiceSession(sbx.db, sbx.seed, 'sweeper')), correlationId: randomUUID() };
    const alarms = (await recordIpcOverdue(sbx.built.ctx, sweeper)).filter((a) => a.batchId === x.d.runId);
    expect(alarms.map((m) => [m.stepKey, m.stream, m.test])).toEqual([['p-tb11@', 'L', 'WEIGHT'], ['p-tb11@', 'R', 'WEIGHT']]);
    // Review 3c finding 4 (lead decision): the sweeper's alarm holds at once through plant.record_missed_ipc_check
    // (recipe-core 0541, EXECUTION.SWEEP only): MISSED per stream, the open container held at its close, the closed one
    // out of use before any entry of the run (its state moves to HELD with the next person's check).
    expect(alarms.map((m) => m.held)).toEqual([true, true]);
    expect((await checks(x)).slice(-2)).toEqual([['L', 'MISSED'], ['R', 'MISSED']]);
    // The press discharges both streams together (the stricter default): each stream's MISSED holds it.
    expect(await sql<number>('select count(*)::int as r from plant.container_hold where container_id = $1', [c1['container_id']])).toBe(2);
    expect(await sql<string>('select plant.container_usable_problem($1) as r', [c2['container_id']])).toMatch(/under a hold/);
    expect(await codeOfQuery(x, 'select plant.record_missed_ipc_check($1, \'TEST-PRESS-01\', \'L\', \'operator\')', [x.d.runId])).toBe('EBMR-IAM-040');
    expect((await recordIpcOverdue(sbx.built.ctx, sweeper)).filter((a) => a.batchId === x.d.runId)).toEqual([]);
    expect(await sql<number>('select count(*)::int as r from tab.ipc_overdue_alarm where batch_id = $1', [x.d.runId])).toBe(2);
    expect(await asOperator(x, async (c) => (await c.query<{ r: Json[] }>('select tab.record_ipc_overdue($1) as r', [x.d.runId])).rows[0]?.r)).toEqual([]);
    // The next entry without the missed checks (a forged engine) is refused; the honest one lists them.
    const late = manualGroup('L', '5000.0');
    // The honest engine's result with the missed checks and their exception taken out.
    const quiet = tamperHandler('p-tb11', {
      acceptEntry: (view, entry) => {
        const r = TB11.handler?.acceptEntry?.(view, entry);
        if (!r?.ok) throw new Error('SETUP: the honest engine refused');
        const { missed: _m, ...data } = r.data;
        void _m;
        return { ...r, data, exceptions: (r.exceptions ?? []).filter((e) => e.type !== 'IPC_CHECK_MISSED') };
      },
    });
    expect(await verdict(x, 'p-tb11', late, { tamper: quiet })).toMatch(/^EBMR-TAB-300 .*missed/s);
    expect(await verdict(x, 'p-tb11', late)).toBe('ok');
    const d = await entryData(x, 'p-tb11@', 'WEIGHT_CHECK');
    expect((d['missed'] as Json[]).map((m) => [m['stream'], m['test'], m['by']])).toEqual([['L', 'WEIGHT', 'TIME'], ['R', 'WEIGHT', 'TIME']]);
    expect(await types(x, 'p-tb11@')).toContain('IPC_CHECK_MISSED');
    expect((await checks(x)).slice(-3)).toEqual([['L', 'MISSED'], ['R', 'MISSED'], ['L', 'PASS']]);
    expect(await sql<number>('select count(*)::int as r from plant.container_hold where container_id = $1', [c1['container_id']])).toBeGreaterThanOrEqual(1);
  });

  it('[IN-35][PR-29] review 3c finding 4: a person who records the overdue alarm holds the stream\'s containers at that moment (MISSED through the container command), before any entry of the run', async () => {
    const x = await newRun({ value: '2', unit: 's' }, { value: '1', unit: 's' });
    await x.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb11@' });
    expect(await verdict(x, 'p-tb11', { kind: 'RUN_START', press: 'TEST-PRESS-01' })).toBe('ok');
    expect(await verdict(x, 'p-tb11', sweep('L'))).toBe('ok');
    expect(await verdict(x, 'p-tb11', sweep('R'))).toBe('ok');
    const box = await asOperator(x, async (c) => (await c.query<{ r: Json }>("select plant.open_container($1, 'COMPRESSION', 'kg', 'TEST-PRESS-01', 'L') as r", [x.d.runId])).rows[0]?.r ?? {});
    await asOperator(x, (c) => c.query('select plant.close_container($1, 12.5, $2)', [box['container_id'], box['version']]));
    await wait(3_500);
    const alarms = await asOperator(x, async (c) => (await c.query<{ r: Json[] }>('select tab.record_ipc_overdue($1) as r', [x.d.runId])).rows[0]?.r ?? []);
    expect(alarms.map((m) => [m['stream'], m['held']])).toEqual([['L', true], ['R', true]]);
    expect((await checks(x)).slice(-2)).toEqual([['L', 'MISSED'], ['R', 'MISSED']]);
    expect(await sql<string>("select state as r from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = $1", [box['container_id']])).toBe('HELD');
    expect(await sql<boolean>('select bool_and(held) as r from tab.ipc_overdue_alarm where batch_id = $1', [x.d.runId])).toBe(true);
  });

  it('[IN-35][PR-29][INV-41] TB-11 closes only after the run ended, with an end-of-run check of every stream and the sweeps done; the run\'s plan is held to the 30-min ceiling and its QRM references when it starts', async () => {
    const x = await newRun();
    await x.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb11@' });
    expect(await verdict(x, 'p-tb11', { kind: 'RUN_START', press: 'TEST-PRESS-01' })).toBe('ok');
    expect(await verdict(x, 'p-tb11', sweep('L'))).toBe('ok');
    const c = await sql<Json>('select recipe.batch_mbr_content($1) as r', [x.d.runId]);
    const close = async () => {
      const old = await stateOf(sbx, x.d.runId);
      const closed = structuredClone(old);
      (closed.steps['p-tb11@'] as Json)['status'] = 'AWAITING_VERIFICATION';
      return sql<string>('select tab.ipc_close_problem($1, $2, $3) as r', [c, old, closed]);
    };
    expect(await close()).toMatch(/TB11-RUNNING/);
    expect(await verdict(x, 'p-tb11', { kind: 'RUN_END' })).toBe('ok');
    // Read as a compression run (the MBR without process OTHER), stream R has no station sweep yet.
    const compression = JSON.parse(JSON.stringify(c).replace('"process":"OTHER",', '')) as Json;
    const old = await stateOf(sbx, x.d.runId);
    const closing = structuredClone(old);
    (closing.steps['p-tb11@'] as Json)['status'] = 'AWAITING_VERIFICATION';
    expect(await sql('select tab.ipc_close_problem($1, $2, $3) as r', [compression, old, closing])).toMatch(/TB11-NO-SWEEP/);
    expect(await verdict(x, 'p-tb11', sweep('R'))).toBe('ok');
    expect(await close()).toMatch(/TB11-END-CHECK/);
    expect(await verdict(x, 'p-tb11', manualGroup('L', '5000.0'))).toBe('ok');
    expect(await verdict(x, 'p-tb11', manualGroup('R', '5000.0'))).toBe('ok');
    expect(await close()).toBeNull();
    void old;
    const plan = (over: Json) => sql<string>('select tab.ipc_plan_problem($1) as r', [{ streams: [{ id: 'L' }], plan: [{ test: 'WEIGHT', every: { value: '25', unit: 'min' }, qrmRef: 'QRM-1' }], grace: { value: '5', unit: 'min' }, sweep: { stations: 2 }, ...over }]);
    expect(await plan({})).toBeNull();
    expect(await plan({ grace: { value: '6', unit: 'min' } })).toMatch(/TB11-CEILING/);
    expect(await plan({ plan: [{ test: 'WEIGHT', every: { value: '25', unit: 'min' } }] })).toMatch(/TB11-QRM/);
    expect(await plan({ sweep: undefined })).toMatch(/TB11-NO-SWEEP/);
  });

  it('[IN-35][PR-23] a compression run starts only at the first-off approval of its press: without a completed TB-10 set-up of that press in the batch its RUN_START is refused by the database; with one it starts', async () => {
    const x = await newRun();
    await x.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb11c@' });
    expect(await verdict(x, 'p-tb11c', { kind: 'RUN_START', press: 'TEST-PRESS-01' })).toBe('EBMR-TAB-300 TB11-FIRST-OFF');
    // The rule read on the run's state with a TB-10 step forged in: set up on the press and completed (approved).
    const c = await sql<Json>('select recipe.batch_mbr_content($1) as r', [x.d.runId]);
    const withTb10 = structuredClone(c) as Json;
    (((withTb10['procedure'] as Json)['body'] as Json)['children'] as Json[]).push({ ...phaseOf('p-tb10', 'TB-10', {}), equipment: [] });
    const s = await stateOf(sbx, x.d.runId);
    const forged = structuredClone(s) as Json & { steps: Record<string, Json>; entries: Record<string, Json> };
    forged.steps['p-tb10@'] = { step: 'p-tb10', status: 'COMPLETED', frames: [] };
    forged.entries['EN-900'] = { id: 'EN-900', kind: 'PRESS_SETUP', stepKey: 'p-tb10@', recordedSeq: 900, recordedAt: { $u: '1' }, data: { press: 'TEST-PRESS-01' } };
    const cfg = { streams: [{ id: 'L' }] };
    const problem = (st: Json, press: string) => sql<string>('select tab.ipc_first_off_problem($1, $2, $3, $4) as r', [withTb10, st, cfg, press]);
    expect(await problem(s, 'TEST-PRESS-01')).toMatch(/TB11-FIRST-OFF/);
    expect(await problem(forged, 'TEST-PRESS-01')).toBeNull();
    expect(await problem(forged, 'TEST-PRESS-02')).toMatch(/TB11-FIRST-OFF/);
    (forged.steps['p-tb10@'])['status'] = 'AWAITING_VERIFICATION';
    expect(await problem(forged, 'TEST-PRESS-01')).toMatch(/TB11-FIRST-OFF/);
    expect(await sql('select tab.ipc_first_off_problem($1, $2, $3, $4) as r', [withTb10, s, { process: 'OTHER' }, 'TEST-PRESS-01'])).toBeNull();
  });

  // Kept last: it adds rule sets to this database.
  it('[IN-34][DI-10][INV-41] review 3c finding 5: a batch market without a rule set or a recorded not-applicable decision fails closed; rule sets that give different procedures are refused; a repeat run keeps the rule sets its first run recorded', async () => {
    const at = '2026-10-10';
    expect(await sql<string[]>("select tab.ipc_uncovered('UNIFORMITY_OF_WEIGHT', '[\"IN\", \"US\"]', 'UNCOATED', $1) as r", [at])).toEqual([]);
    expect(await sql<string[]>("select tab.ipc_uncovered('UNIFORMITY_OF_WEIGHT', '[\"IN\", \"EU\"]', 'SUGAR_COATED', $1) as r", [at])).toEqual(['EU', 'IN']);
    expect(await sql<string[]>("select tab.ipc_uncovered('SUBDIVISION', '[\"EU\"]', 'UNCOATED', $1) as r", [at])).toEqual(['IN']);
    expect(await sql<Json>("select tab.ipc_rule_set_problem('SUBDIVISION', tab.ipc_rule_sets('SUBDIVISION', '[\"EU\"]', 'UNCOATED', $1, false), '[\"EU\"]', 'UNCOATED', $1, 'TB12') as r", [at])).toEqual({
      problem: expect.stringMatching(/market IN .*TB12-NO-RULE-SET/) as unknown,
    });
    const x = await newRun();
    await x.d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb14@' });
    const run = (initial: string, final: string, extra: Json = {}): Entry => ({ kind: 'FRIABILITY_RUN', instrument: 'TEST-FRB-01', capture: 'MANUAL', tablets: 26, initialMass: initial, finalMass: final, rotations: 100, rpm: '25.0', broken: false, ...extra });
    expect(await verdict(x, 'p-tb14', run('6.500', '6.420'))).toBe('ok');
    const first = await lastEntry(sbx, x.d.runId, 'p-tb14@', 'FRIABILITY_RUN');
    // A new version of the IP rule set becomes effective between the runs: the repeat keeps version 1.
    await arranged(
      `insert into tab.compendial_rule_set (code, version, test, pharmacopoeia, markets, tablet_types, params, confidence, source, effective_from)
       select code, 2, test, pharmacopoeia, markets, tablet_types, params, confidence, source, '2026-01-01' from tab.compendial_rule_set where code = 'IP-FRIABILITY' and version = 1`,
    );
    expect(await verdict(x, 'p-tb14', run('6.500', '6.480', { repeatOf: first }))).toBe('ok');
    expect((await entryData(x, 'p-tb14@', 'FRIABILITY_RUN'))['ruleSets']).toEqual([{ code: 'IP-FRIABILITY', version: 1 }]);
    // A second rule set bound for India with another procedure (150 rotations): a new first run is refused.
    await arranged(
      `insert into tab.compendial_rule_set (code, version, test, pharmacopoeia, markets, tablet_types, params, confidence, source, effective_from)
       select 'TESTX-FRIABILITY', 1, test, pharmacopoeia, markets, tablet_types, params || '{"rotations": 150}', 'LOW', 'test row', '2026-01-01' from tab.compendial_rule_set where code = 'IP-FRIABILITY' and version = 1`,
    );
    expect(await verdict(x, 'p-tb14', run('6.500', '6.490', { repeatOf: first }))).toBe('ok');
    expect(await verdict(x, 'p-tb14', run('6.500', '6.495'), { tamper: laxEntry('p-tb14', {}) })).toBe('EBMR-TAB-300 TB14-RULE-SETS-DIFFER');
  });
});

/** A statement of master data arranged by the superuser outside any command (replica role: no audit or guard triggers). */
async function arranged(text: string): Promise<void> {
  const c = await sbx.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(text);
    await c.query('commit');
  } finally {
    c.release();
  }
}

async function codeOfQuery(x: Ctx, text: string, params: unknown[]): Promise<string> {
  try {
    await asOperator(x, (c) => c.query(text, params));
    return 'ok';
  } catch (e) {
    return /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e))?.[1] ?? String(e);
  }
}

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
