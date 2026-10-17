/**
 * The golden batch profile's inputs (Phase 6A slice 6A-6; recipe-core 1170; ADR 0020 point 3; draft controls DI-51,
 * DI-52; DI-32; D-6A-6-1, D-6A-6-2, D-6A-6-7): report.series_ref_v1 names each GMP batch step's native series on its
 * unit within the step's binding window, report.series_samples_v1 gives that window's samples exactly as received,
 * and report.analytics_reference_v1 the reference sets in force from the configuration store. They are on the analytics
 * role's allow-list, the role reads them and nothing behind them, and the segregation check stays clean.
 *
 * The press is served by an enrolled OPC UA endpoint and its chunks arrive through the adapter's real command
 * (plant.receive_series_chunk), as in the 6b tests. The batch is the plant tests' batch (TEST FIXTURE, superuser with
 * triggers off), turned into a GMP batch record the same way, because the input views hold GMP batches only.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { segregationProblems } from '../../../kernel/src/sandbox/provision.ts';
import { envelopeFor, nowUs, receive, registerAdapter, type TestAdapter } from '../../../kernel/test/integrations/support.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as plant from '../../src/plant/index.ts';
import { servedByEndpoint } from '../equipment-data/support.ts';
import { PlantWorld, seedPlantCast } from '../plant/support.ts';

const ANALYTICS_LOGIN = { name: 'ebmr_analytics', password: 'ebmr_analytics' };
const STEP = 'p-compress@1';
const TAG = 'force.main_kN';

let db: TestDatabase;
let w: PlantWorld;
let opcua: TestAdapter;

async function asAnalytics<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: urlFor(db.name, ANALYTICS_LOGIN) });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

/** TEST FIXTURE: rows written as the database owner with triggers off. */
async function fixture(sql: string, params: unknown[] = []): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(sql, params);
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
type Sample = { sourceTime: string; serverTime: string | null; raw: string; value: string | null; status: string };
function chunk(subjectCode: string, chunkNo: string, samples: Sample[], tag = TAG, unit = 'kN') {
  const c = { subjectKind: 'EQUIPMENT', subjectCode, tag, unit, chunkNo, samples };
  return { ...c, chunkHash: sha([[c.subjectKind, c.subjectCode, c.tag, c.unit, c.chunkNo].join('|'), ...samples.map((s) => [s.sourceTime, s.serverTime ?? '', s.raw, s.value ?? '', s.status].join('|'))].join('\n')) };
}
const send = (payload: unknown) => receive(db, opcua, 'plant.receive_series_chunk', envelopeFor(opcua, 'opcua.series_chunk', payload));

interface Bound { press: { id: string; code: string }; batchId: string; useId: string }

/** A served press in use by a GMP batch record with `step` bound to it. */
async function boundPress(label: string, step = STEP): Promise<Bound> {
  const press = await w.press();
  await servedByEndpoint(db, opcua, await w.room(), [press.code]);
  const product = await w.product();
  await w.clean('EQUIPMENT', press.code, 'MAJOR');
  const useId = await w.startUse(press.code, label, product);
  const b = await w.batch(label, product);
  await w.run(w.cast.operator, (c) => c.query('select plant.bind_step_equipment($1, $2, $3)', [b.id, step, press.code]));
  await fixture(`update recipe.batch_execution set installation = 'GMP', purpose = 'GMP_BATCH', package_hash = null, control_recipe_id = gen_random_uuid(),
                        issue_signature_id = gen_random_uuid() where id = $1`, [b.id]);
  return { press, batchId: b.id, useId };
}

let main: Bound;
let t0: bigint;
let chunkIds: string[];

beforeAll(async () => {
  db = await createTestDatabase();
  w = new PlantWorld(db, await seedPlantCast(db));
  opcua = await registerAdapter(db, 'OPCUA');
  main = await boundPress('GBP-1');
  // Sample times from the binding's own database time: the window opens at the binding and closes when the use ends.
  t0 = BigInt((await db.admin.query<{ us: string }>("select (extract(epoch from bound_at) * 1000000)::bigint::text as us from plant.step_equipment where batch_id = $1", [main.batchId])).rows[0]!.us);
  // One sample ten seconds before the binding (outside the step's window, in a chunk that reaches into it), then
  // GOOD, UNCERTAIN and BAD samples in the window, over two chunks.
  const r1 = await send(chunk(main.press.code, '1', [
    { sourceTime: (t0 - 10_000_000n).toString(), serverTime: null, raw: '0.50', value: '0.50', status: '0x00000000' },
    { sourceTime: (t0 + 1_000n).toString(), serverTime: (t0 + 1_050n).toString(), raw: '1.25E1', value: '12.50', status: '0x00000000' },
    { sourceTime: (t0 + 2_000n).toString(), serverTime: null, raw: '12.61', value: '12.61', status: '0x40000000' },
  ]));
  const r2 = await send(chunk(main.press.code, '2', [
    { sourceTime: (t0 + 3_000n).toString(), serverTime: null, raw: 'NaN', value: null, status: '0x80000000' },
    { sourceTime: (t0 + 4_000n).toString(), serverTime: null, raw: '12.70', value: '12.70', status: '0x00000000' },
  ]));
  chunkIds = [String(r1['seriesId']), String(r2['seriesId'])];
}, 600_000);

afterAll(async () => {
  await db?.drop();
});

interface RefRow {
  batch_id: string; batch_number: string; step: string; equipment_code: string; equipment_type: string; tag: string; unit: string; ended: boolean; window_to: Date | null;
  chunk_ids: string[]; released: boolean; deviations: number; alarms: number; read_at: Date; data_as_of: Date;
}

describe('the golden batch profile inputs (recipe-core 1170)', () => {
  it('[DI-51][DI-52] report.series_ref_v1 names each GMP batch step\'s native series on its unit, with its chunks, release, deviations and step alarms', async () => {
    const [open] = await asAnalytics<RefRow>('select * from report.series_ref_v1 where batch_id = $1', [main.batchId]);
    expect(open).toMatchObject({ step: STEP, equipment_code: main.press.code, tag: TAG, unit: 'kN', ended: false, window_to: null, recency: null, released: false, deviations: 0, alarms: 0 });
    expect([...open!.chunk_ids].sort()).toEqual([...chunkIds].sort());
    expect(open!.equipment_type).toBe((await db.admin.query<{ c: string }>('select class_code as c from plant.equipment where id = $1', [main.press.id])).rows[0]!.c);
    expect(open!.read_at).toBeInstanceOf(Date);
    // The use ends: the window closes.
    await w.run(w.cast.operator, (c) => plant.endEquipmentUse(c, main.useId));
    const [closed] = await asAnalytics<RefRow>('select * from report.series_ref_v1 where batch_id = $1', [main.batchId]);
    // The latest (and only) ended window of its scope (D-6A-6-12).
    expect(closed).toMatchObject({ ended: true, recency: 1 });
    expect(closed!.window_to).toBeInstanceOf(Date);
    // The same rows for the reporting role (report catalogue) and the application role.
    expect((await db.app.query('select count(*)::int as n from report.series_ref_v1 where batch_id = $1', [main.batchId])).rows[0]).toEqual({ n: 1 });
    const { rows: cat } = await db.admin.query("select view_name, version from report.view_registry where view_name = 'series_ref_v1'");
    expect(cat).toEqual([{ view_name: 'series_ref_v1', version: 1 }]);
  });

  it('[DI-32] report.series_samples_v1 gives the window\'s samples exactly as received, oldest first, with their quality', async () => {
    const rows = await asAnalytics<{ source_us: string; raw_text: string; value_text: string | null; status_code: string; status: string; chunk_id: string; source_time: Date }>(
      'select source_us, raw_text, value_text, status_code, status, chunk_id::text, source_time from report.series_samples_v1($1, $2, $3)', [main.batchId, STEP, TAG]);
    expect(rows.map(({ source_time: _t, ...r }) => { void _t; return r; })).toEqual([
      { source_us: (t0 + 1_000n).toString(), raw_text: '1.25E1', value_text: '12.50', status_code: '0x00000000', status: 'GOOD', chunk_id: chunkIds[0] },
      { source_us: (t0 + 2_000n).toString(), raw_text: '12.61', value_text: '12.61', status_code: '0x40000000', status: 'UNCERTAIN', chunk_id: chunkIds[0] },
      { source_us: (t0 + 3_000n).toString(), raw_text: 'NaN', value_text: null, status_code: '0x80000000', status: 'BAD', chunk_id: chunkIds[1] },
      { source_us: (t0 + 4_000n).toString(), raw_text: '12.70', value_text: '12.70', status_code: '0x00000000', status: 'GOOD', chunk_id: chunkIds[1] },
    ]);
    expect(rows[0]!.source_time.getTime()).toBe(Number((t0 + 1_000n) / 1000n));
    // The samples are those of the native chunks as stored (DI-32): the same raw text the chunk holds.
    const stored = (await db.admin.query<{ samples: Sample[] }>('select samples from plant.series where id = $1', [chunkIds[0]])).rows[0]!.samples;
    expect(stored[1]).toMatchObject({ raw: rows[0]!.raw_text, value: rows[0]!.value_text });
  });

  it('a step without a series gives no profile', async () => {
    const other = await boundPress('GBP-2', 'p-blend@1');
    // Bound to a unit that sent nothing: no series reference, no samples, so no curve and no profile.
    expect(await asAnalytics('select * from report.series_ref_v1 where batch_id = $1', [other.batchId])).toEqual([]);
    expect(await asAnalytics('select * from report.series_samples_v1($1, $2, $3)', [other.batchId, 'p-blend@1', TAG])).toEqual([]);
    // A step of a batch with a series, but another step or tag, has none either; nor a sandbox batch.
    expect(await asAnalytics('select * from report.series_samples_v1($1, $2, $3)', [main.batchId, 'p-other@1', TAG])).toEqual([]);
    expect(await asAnalytics('select * from report.series_samples_v1($1, $2, $3)', [main.batchId, STEP, 'force.pre_kN'])).toEqual([]);
    const sbx = await w.press();
    await servedByEndpoint(db, opcua, await w.room(), [sbx.code]);
    const product = await w.product();
    await w.clean('EQUIPMENT', sbx.code, 'MAJOR');
    await w.startUse(sbx.code, 'GBP-SBX', product);
    const b = await w.batch('GBP-SBX', product);
    await w.run(w.cast.operator, (c) => c.query('select plant.bind_step_equipment($1, $2, $3)', [b.id, STEP, sbx.code]));
    const t = BigInt(nowUs());
    await send(chunk(sbx.code, '1', [{ sourceTime: (t + 1_000_000n).toString(), serverTime: null, raw: '1', value: '1', status: '0x00000000' }]));
    expect(await asAnalytics('select * from report.series_ref_v1 where batch_id = $1', [b.id])).toEqual([]);
    expect(await asAnalytics('select * from report.series_samples_v1($1, $2, $3)', [b.id, STEP, TAG])).toEqual([]);
  });

  it('[DI-52] report.analytics_reference_v1 gives the reference sets in force from the configuration store, and none retired', async () => {
    const release = `kernel.set_actor_context(jsonb_build_object('person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
      'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM', 'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
      'legal_name', 'Test fixture (analytics)', 'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'test fixture'))`;
    const c = await db.admin.connect();
    const setId = randomUUID();
    const model = { method: 'GBP.DTW_BAND', note: `m-${randomBytes(3).toString('hex')}` };
    const modelSha = sha(JSON.stringify(model));
    try {
      await c.query('begin');
      await c.query(`select ${release}`);
      const runtime = { package: '@ebmr/analytics 0.1.0', commit: 'test', node: process.version, libraries: {} };
      await c.query(`insert into analytics.method_version (method, version, status, title, intended_use, acceptance, parameters, parameters_sha256, code_identity, validation_ref)
                     values ('GBP.DTW_BAND', 1, 'EFFECTIVE', 'Profile', 'advisory', '{}', '{}', repeat('a', 64), '@ebmr/analytics 0.1.0', 'VAL-1')`);
      const inputs = [{ view: 'report.series_ref_v1', version: 1, filter: null, data_as_of: '2026-10-12T04:40:00Z', rows: 0, sha256: 'a'.repeat(64) }];
      const run = (await c.query<{ id: string }>("select analytics.begin_run('GBP.DTW_BAND', 1, null, 'ON_DEMAND', $1::jsonb, $2::jsonb)::text as id", [JSON.stringify(inputs), JSON.stringify(runtime)])).rows[0]!.id;
      const out = (await c.query<{ id: string }>("select analytics.record_output($1, 'EQUIPMENT_STEP_TAG', 'X', 'MODEL_CANDIDATE', $2::jsonb, '[]')::text as id",
        [run, JSON.stringify({ model, modelSha256: modelSha })])).rows[0]!.id;
      await c.query("select analytics.finish_run($1, repeat('b', 64), '{}')", [run]);
      await c.query(`insert into analytics.reference_set (id, method, scope, batch_ids, candidate_output, model, model_sha256, status)
                     values ($1, 'GBP.DTW_BAND', '{"tag": "force.main_kN"}', array[$2::uuid], $3, $4::jsonb, $5, 'EFFECTIVE')`, [setId, main.batchId, out, JSON.stringify(model), modelSha]);
      await c.query('select kernel.set_actor_context(null)');
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
    const [row] = await asAnalytics<{ reference_set_id: string; method: string; scope: unknown; batch_ids: string[]; model: unknown; model_sha256: string; change_record: string | null }>(
      'select * from report.analytics_reference_v1 where reference_set_id = $1', [setId]);
    expect(row).toMatchObject({ method: 'GBP.DTW_BAND', scope: { tag: 'force.main_kN' }, batch_ids: [main.batchId], model, model_sha256: modelSha, change_record: null });
    // Retired, it is no longer in force.
    const c2 = await db.admin.connect();
    try {
      await c2.query('begin');
      await c2.query(`select ${release}`);
      await c2.query(`insert into analytics.reference_set (id, method, scope, batch_ids, candidate_output, model, model_sha256, status)
                      select id, method, scope, batch_ids, candidate_output, model, model_sha256, 'RETIRED' from analytics.reference_set where id = $1`, [setId]);
      await c2.query('select kernel.set_actor_context(null)');
      await c2.query('commit');
    } finally {
      c2.release();
    }
    expect(await asAnalytics('select * from report.analytics_reference_v1 where reference_set_id = $1', [setId])).toEqual([]);
  });

  it('[DI-51] the inputs are on the analytics role\'s allow-list, which reads nothing behind them; the segregation check stays clean', async () => {
    const { rows } = await db.admin.query("select name, kind, version, owner_slice from analytics.input_catalog_v1 where owner_slice = '6A-6' order by name");
    expect(rows).toEqual([
      { name: 'report.analytics_reference_v1', kind: 'VIEW', version: 1, owner_slice: '6A-6' },
      { name: 'report.series_ref_v1', kind: 'VIEW', version: 1, owner_slice: '6A-6' },
      { name: 'report.series_samples_v1(uuid,text,text)', kind: 'FUNCTION', version: 1, owner_slice: '6A-6' },
    ]);
    for (const q of ['select * from plant.series limit 1', 'select * from platform.config_version limit 1', 'select * from report.step_windows_v1()',
                     'select * from plant.series_in_context(gen_random_uuid(), null, null)', 'select * from analytics.reference_set limit 1']) {
      await expect(asAnalytics(q), q).rejects.toThrow(/permission denied/);
    }
    // The views and the samples function are read-only: STABLE row functions.
    const { rows: vol } = await db.admin.query<{ fn: string; v: string }>(
      `select p.oid::regprocedure::text as fn, p.provolatile as v from pg_proc p
        where p.oid in ('report.series_ref_rows_v1()'::regprocedure, 'report.series_samples_v1(uuid,text,text)'::regprocedure,
                        'report.analytics_reference_rows_v1()'::regprocedure, 'report.step_windows_v1()'::regprocedure) order by 1`);
    expect(vol.map((r) => r.v)).toEqual(['s', 's', 's', 's']);
    expect(await segregationProblems(db.admin)).toEqual([]);
  });
});
