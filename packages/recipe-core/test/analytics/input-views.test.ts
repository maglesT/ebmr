/**
 * The analytics input views v1 (Phase 6A slice 6A-1; recipe-core 1115; ADR 0020 point 3; draft controls DI-51, DI-52;
 * D-6A-1-2 to D-6A-1-5): report.batch_fact_v1, report.cpp_value_v1 and report.step_use_v1 give the GMP batch records'
 * facts, critical values and step use as the source's exact decimal text, recomputable from the records and their
 * issued masters; they are on the analytics role's allow-list with report.batch_outcome_v1, the role reads them and
 * nothing behind them, and the segregation check stays clean.
 *
 * The batches are GMP batches issued from an effective master (as release/pqr-extract.test.ts builds them); each record
 * as executed is the engine's golden granulation run written as the projection the execution writers keep (TEST
 * FIXTURE, superuser with triggers off: the floor flow itself is proven by the engine and execution tests). The unit
 * binding, the room, the material lot and its consumption are fixture rows the same way.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { segregationProblems } from '../../../kernel/src/sandbox/provision.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { approveTestRelease } from '../../../kernel/test/support/validation.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as execution from '../../src/execution/index.ts';
import { encodeState } from '../../src/engine/codec.ts';
import { autopilot, define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS, fixtureDefinition, GRANULATION_SCENARIO, Run } from '../engine/support.ts';
import { gmpOrderFor } from '../lifecycle/gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from '../lifecycle/support.ts';

type Json = Record<string, unknown>;
const ANALYTICS_LOGIN = { name: 'ebmr_analytics', password: 'ebmr_analytics' };
const SITE = 'SITE-1';
const BS = 'BS-200K';
const FIXTURE = 'tablet-granulation-compression';
const dir = tempDir('analytics-inputs');
const ledger = tempLedger('analytics-inputs', dir.path);

let db: TestDatabase;
let w: World;
let erp: SeededActor;
let master: { familyId: string; versionId: string; content: MbrContent };
const batches: { id: string; number: string; state: Json }[] = [];

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

function without(content: unknown, types: readonly string[]): unknown {
  if (Array.isArray(content)) {
    return content.filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Json)['block'] as Json | undefined)?.['type'])))).map((x) => without(x, types));
  }
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
  return content;
}

async function issuedBatch(): Promise<string> {
  const batchId = randomUUID();
  const erpOrder = await gmpOrderFor(db, erp, master.content, BS);
  await cmd(db, w.cast.issuer).then((ctx) =>
    withProtectedNumbers(db.app, ctx, ledger, (c) => execution.prepareGmpIssue(c, batchId, { familyId: master.familyId, markets: ['IN'], site: SITE, line: 'L1', batchSize: BS, erpOrder })),
  );
  const signatureId = await w.sign(w.cast.issuer, 'batch_issue', batchId, 'ISSUED', 'PLANNED');
  await w.run(
    w.cast.issuer,
    (c) => execution.issueGmpBatch(c, {
      batchId,
      signatureId,
      define: (x) => define(x, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS }),
      request: { inputs: FIXTURE_INPUTS[FIXTURE], issuedBy: { id: w.cast.issuer.personId, kind: 'PERSON', roles: [] } },
    }),
    reason('batch issued for the test'),
  );
  return batchId;
}

/** The record as executed on the floor: the golden granulation run, with this batch's own hardness. */
function executedRecord(hardness: string): Json {
  const r = Run.issue(fixtureDefinition(FIXTURE), { inputs: FIXTURE_INPUTS[FIXTURE], variants: {} });
  const scenario = { ...GRANULATION_SCENARIO, value: (item: string, step: string, frames: Parameters<NonNullable<typeof GRANULATION_SCENARIO.value>>[2], run: Run) =>
    item === 'hardness' ? { kind: 'DECIMAL' as const, value: hardness, unit: 'N' } : GRANULATION_SCENARIO.value?.(item, step, frames, run) };
  expect(autopilot(r, scenario)).toBe('COMPLETE');
  return JSON.parse(JSON.stringify(encodeState(r.state))) as Json;
}

const us = (v: unknown): string | null => {
  const d = (v as { $u?: string } | undefined)?.$u;
  return d === undefined ? null : new Date(Number(BigInt(d) / 1000n)).toISOString();
};

beforeAll(async () => {
  db = await createTestDatabase();
  // Slice 7c (DI-03, recipe-core 1250): a GMP batch is issued only on a release with an approved validation summary.
  await approveTestRelease(db);
  w = new World(db, await seedCast(db));
  const steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  const m = uniqueContent(FIXTURE, ['IN']);
  m.header.product = { ...m.header.product, code: m.header.product.code.toUpperCase() };
  const content = without(m, ['G-09', 'G-10']) as MbrContent;
  const v = await w.approvedVersion(content);
  await w.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, 'L1', BS)], regulatoryBasis: 'IN: registration on file' });
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `A-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'A{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
  );
  master = { familyId: v.familyId, versionId: v.versionId, content };
  for (const hardness of ['85', '91']) {
    const id = await issuedBatch();
    const state = executedRecord(hardness);
    await fixture("update recipe.execution_state set state = $2::jsonb, status = 'EXECUTION_COMPLETE' where batch_id = $1", [id, JSON.stringify(state)]);
    const number = (await db.app.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [id])).rows[0]!.n;
    batches.push({ id, number, state });
  }
}, 900_000);

afterAll(async () => {
  await db?.drop();
  dir.cleanup();
});

interface CppRow {
  batch_id: string; kind: string; item: string; step: string; attempt: number; reading: number | null; role: string | null; value_text: string; unit: string | null;
  lower_text: string | null; upper_text: string | null; target_text: string | null; limit_tier: string | null; failed: boolean; recorded_at: Date; ref: string;
}

/** The critical numeric values recomputed in TypeScript from one stored record and its issued master. */
function recompute(batchId: string, content: MbrContent, state: Json): Omit<CppRow, 'recorded_at'>[] {
  const tiers = ['REGISTERED', 'VALIDATED', 'INTERNAL_ACTION', 'ALERT'];
  const outer = (def: Json | undefined) => {
    const ranges = (((def?.['limits'] as Json | undefined)?.['ranges'] ?? []) as Json[]).slice().sort((a, b) => tiers.indexOf(String(a['tier'])) - tiers.indexOf(String(b['tier'])));
    const r = ranges[0];
    return { lower_text: ((r?.['low'] as Json | undefined)?.['value'] as string | undefined) ?? null, upper_text: ((r?.['high'] as Json | undefined)?.['value'] as string | undefined) ?? null,
             limit_tier: (r?.['tier'] as string | undefined) ?? null };
  };
  const params = new Map((content.parameters as unknown as Json[]).map((p) => [String(p['id']), p]));
  const calcs = new Map((content.calculations as unknown as Json[]).map((c) => [String(c['id']), c]));
  const out: Omit<CppRow, 'recorded_at'>[] = [];
  const push = (kind: string, ref: string, item: string, step: string, attempt: number, value: Json, def: Json | undefined, role: string | null, failed: boolean, masterUnit: string | null) => {
    const texts: [number | null, unknown][] = value['kind'] === 'SERIES' ? (value['values'] as string[]).map((t, i) => [i + 1, t]) : ['DECIMAL', 'COUNT'].includes(String(value['kind'])) ? [[null, value['value']]] : [];
    for (const [reading, text] of texts) {
      if (typeof text !== 'string' || !/^-?\d+(\.\d+)?$/.test(text)) continue;
      out.push({ batch_id: batchId, kind, item, step, attempt, reading, role, value_text: text, unit: (value['unit'] as string | undefined) ?? masterUnit,
                 ...outer(def), target_text: (def?.['target'] as string | undefined) ?? null, failed, ref });
    }
  };
  for (const [ref, pt] of Object.entries((state['points'] ?? {}) as Record<string, Json>)) {
    const p = params.get(String(pt['item']));
    if (!p || pt['status'] !== 'VALID' || pt['kind'] !== 'VALUE' || p['criticality'] !== 'CRITICAL' || !['PROCESS_PARAMETER', 'IPC', 'PROCESS_ENDPOINT'].includes(String(p['role']))) continue;
    push('PARAMETER', ref, String(pt['item']), String(pt['stepKey']), Number(pt['attempt']), pt['value'] as Json, p, String(p['role']), pt['failed'] === true, (p['unit'] as string | undefined) ?? null);
  }
  for (const [ref, dv] of Object.entries((state['derived'] ?? {}) as Record<string, Json>)) {
    const c = calcs.get(String(dv['calculation']));
    if (!c || dv['status'] !== 'CURRENT' || c['criticality'] !== 'CRITICAL') continue;
    push('CALCULATION', ref, String(dv['calculation']), String(dv['stepKey']), 1, dv['value'] as Json, c, null, dv['failed'] === true, ((c['output'] as Json | undefined)?.['unit'] as string | undefined) ?? null);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return out.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.item, b.item) || cmp(a.step, b.step) || a.attempt - b.attempt || cmp(a.ref, b.ref) || (a.reading ?? 0) - (b.reading ?? 0));
}

describe('the analytics input views (recipe-core 1115)', () => {
  it('[DI-51][DI-52] report.cpp_value_v1 gives every critical value of a GMP batch record as the source\'s decimal text with the issued master\'s outermost limits, recomputable from the record', async () => {
    const rows = await asAnalytics<CppRow>('select * from report.cpp_value_v1 where batch_id = any($1::uuid[])', [batches.map((b) => b.id)]);
    const content = (await db.admin.query<{ c: MbrContent }>('select recipe.batch_mbr_content($1) as c', [batches[0]!.id])).rows[0]!.c;
    for (const b of batches) {
      const mine = rows.filter((r) => r.batch_id === b.id);
      const recomputed = recompute(b.id, content, b.state);
      const cmp = (a: string, x: string) => (a < x ? -1 : a > x ? 1 : 0);
      const shown = mine.map(({ recorded_at: _r, ...rest }) => { void _r; return Object.fromEntries(Object.entries(rest).filter(([k]) => !['batch_number', 'read_at', 'data_as_of'].includes(k))); });
      expect(shown.sort((a, x) => cmp(String(a['kind']), String(x['kind'])) || cmp(String(a['item']), String(x['item'])) || cmp(String(a['step']), String(x['step']))
        || Number(a['attempt']) - Number(x['attempt']) || cmp(String(a['ref']), String(x['ref'])) || Number(a['reading'] ?? 0) - Number(x['reading'] ?? 0))).toEqual(recomputed);
      // Each value's time is the point's own recorded time.
      for (const r of mine.filter((x) => x.kind === 'PARAMETER')) {
        expect(r.recorded_at.toISOString(), r.ref).toBe(us(((b.state['points'] as Record<string, Json>)[r.ref] as Json)['recordedAt']));
      }
    }
    // The values the plan names: the hardness IPC of each batch as recorded, its INTERNAL_ACTION limits (outer to the
    // alert tier); the endpoint's VALIDATED limits; one row per reading of the 20 tablet weights.
    const hardness = rows.filter((r) => r.item === 'hardness').map((r) => [r.batch_id, r.value_text, r.lower_text, r.upper_text, r.limit_tier, r.role]);
    expect(hardness).toEqual(expect.arrayContaining([[batches[0]!.id, '85', '60', '120', 'INTERNAL_ACTION', 'IPC'], [batches[1]!.id, '91', '60', '120', 'INTERNAL_ACTION', 'IPC']]));
    expect(rows.find((r) => r.item === 'lod')).toMatchObject({ role: 'PROCESS_ENDPOINT', lower_text: '2.0', upper_text: '3.5', limit_tier: 'VALIDATED', unit: '%' });
    const weights = rows.filter((r) => r.batch_id === batches[0]!.id && r.item === 'tabletWeight');
    expect(weights.length % 20).toBe(0);
    expect(weights.length).toBeGreaterThan(0);
    expect(weights.slice(0, 20).map((r) => r.reading)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(rows.some((r) => r.kind === 'CALCULATION' && r.item === 'granYield' && r.role === null)).toBe(true);
    // Every value is text the decimal grammar accepts: no number ever leaves the view.
    for (const r of rows) expect(typeof r.value_text === 'string' && /^-?\d+(\.\d+)?$/.test(r.value_text), r.ref).toBe(true);
  });

  it('[DI-51] report.batch_fact_v1 gives each GMP batch with its product, master version and family, status and release', async () => {
    const row = async (id: string) => (await asAnalytics<Json>('select batch_id, batch_number, product_code, strength, mbr_version_id, family_code, record_kind, status, released from report.batch_fact_v1 where batch_id = $1', [id]))[0];
    const family = (await db.admin.query<{ code: string }>('select code from recipe.mbr_family where id = $1', [master.familyId])).rows[0]!.code;
    expect(await row(batches[0]!.id)).toEqual({
      batch_id: batches[0]!.id, batch_number: batches[0]!.number, product_code: master.content.header.product.code, strength: master.content.header.product.strength,
      mbr_version_id: master.versionId, family_code: family, record_kind: 'PROCESSING', status: expect.any(String) as unknown, released: false,
    });
    // Released once its finished lot carries the manufacturer's RELEASED decision (TEST FIXTURE rows).
    const lot = randomUUID();
    await fixture(`insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at, received_by_person, received_by_account, correlation_id)
                   values ($1, 'SITE-1', $2, 'FG-1', 'Finished tablets', 'FINISHED', 1000, '{tbl}', '2029-01-01', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`, [lot, `FG-${lot.slice(0, 8).toUpperCase()}`]);
    await fixture(`insert into site.finished_lot (lot_id, batch_id, batch_number, edition, product_code, strength, markets, posted_by_person, posted_by_account)
                   values ($1, $2, $3, 'TABLETS', 'X', '40 mg', array['IN'], gen_random_uuid(), gen_random_uuid())`, [lot, batches[0]!.id, batches[0]!.number]);
    await fixture(`insert into recipe.manufacturer_release_decision (lot_id, decision, signature_id, epoch, checklist, checklist_hash, content_hash, person_id, account_id, role_code, correlation_id)
                   values ($1, 'RELEASED', gen_random_uuid(), repeat('a', 64), '{}', repeat('b', 64), 'x', gen_random_uuid(), gen_random_uuid(), 'AUTHORISED_PERSON', gen_random_uuid())`, [lot]);
    expect(await row(batches[0]!.id)).toMatchObject({ released: true });
    expect(await row(batches[1]!.id)).toMatchObject({ released: false });
  });

  it('[DI-51] report.step_use_v1 gives each executed step with its unit, room, times, persons and consumed lots', async () => {
    const b = batches[0]!;
    const steps = b.state['steps'] as Record<string, Json>;
    const executed = Object.entries(steps).filter(([, s]) => us(s['startedAt']) !== null);
    const [key, si] = executed[0]!;
    // A unit in a room bound to the first step, and a material lot consumed by an entry of that step (TEST FIXTURE rows).
    const tag = randomUUID().slice(0, 6).toUpperCase();
    const [area, eq, lot, consumption] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await fixture("insert into plant.area (id, code, kind, name, segregated, negative_pressure, recorded_by) values ($1, $2, 'ROOM', 'Granulation room', false, false, gen_random_uuid())", [area, `RM-${tag}`]);
    await fixture("insert into plant.equipment (id, code, name, class_code, kind, area_id, recorded_by) values ($1, $2, 'High-shear granulator', 'CL-RMG', 'PROCESS', $3, gen_random_uuid())", [eq, `RMG-${tag}`, area]);
    await fixture("insert into plant.step_equipment (batch_id, step, equipment_id, use_id, person_id, account_id, correlation_id) values ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [b.id, key, eq]);
    const entries = (b.state['entries'] ?? {}) as Record<string, Json>;
    const entryKey = Object.entries(entries).find(([, e]) => e['stepKey'] === key)?.[0] ?? 'fixture-entry';
    if (!(entryKey in entries)) {
      entries[entryKey] = { id: entryKey, stepKey: key, kind: 'FIXTURE', data: {}, enteredBy: randomUUID(), recordedAt: { $u: '1' }, recordedSeq: 1 };
      await fixture('update recipe.execution_state set state = $2::jsonb where batch_id = $1', [b.id, JSON.stringify({ ...b.state, entries })]);
    }
    await fixture(`insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, supplier, received_quantity, unit, expires_at, received_by_person, received_by_account, correlation_id)
                   values ($1, 'SITE-1', $2, 'API-1', 'Active', 'API', 'SUP-7', 10, 'kg', '2029-01-01', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`, [lot, `API-${tag}`]);
    await fixture(`insert into site.lot_consumption (id, lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after, market_set, identity_basis, consumed_by_person, consumed_by_account, xact_id)
                   values ($1, $2, gen_random_uuid(), $3, $4, 'TABLETS', 'API-1', 1, 'kg', 10, 9, array['IN'], 'IDENTITY_RESULT', gen_random_uuid(), gen_random_uuid(), 1)`, [consumption, lot, b.id, b.number]);
    await fixture('insert into recipe.consumption_entry (consumption_id, batch_id, entry_key) values ($1, $2, $3)', [consumption, b.id, entryKey]);

    const rows = await asAnalytics<{ step: string; step_id: string; equipment_code: string | null; equipment_type: string | null; room_code: string | null; started_at: Date; ended_at: Date | null; person_ids: string[]; material_lots: unknown }>(
      'select step, step_id, equipment_code, equipment_type, room_code, started_at, ended_at, person_ids, material_lots from report.step_use_v1 where batch_id = $1', [b.id]);
    expect(new Set(rows.map((r) => r.step))).toEqual(new Set(executed.map(([k]) => k)));
    const first = rows.find((r) => r.step === key)!;
    expect(first).toMatchObject({ step_id: si['step'], equipment_code: `RMG-${tag}`, equipment_type: 'CL-RMG', room_code: `RM-${tag}`, material_lots: [{ lot: `API-${tag}`, supplier: 'SUP-7' }] });
    expect(first.started_at.toISOString()).toBe(us(si['startedAt']));
    const persons = [...new Set([...(si['performers'] as string[]), ...(si['dataEnterers'] as string[]), ...(si['correctors'] as string[])])]
      .filter((p) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p)).sort();
    expect(first.person_ids.slice().sort()).toEqual(persons);
    // A step without a unit binding: one row, no unit.
    expect(rows.filter((r) => r.step !== key).every((r) => r.equipment_code === null && Array.isArray(r.material_lots))).toBe(true);
  });

  it('[DI-51] the inputs are on the analytics role\'s allow-list; it reads them and nothing behind them, and the segregation check stays clean', async () => {
    const { rows } = await db.app.query<{ name: string; kind: string; version: number; owner_slice: string }>(
      "select name, kind, version, owner_slice from analytics.input_catalog_v1 where owner_slice = '6A-1' order by name");
    expect(rows).toEqual(['report.batch_fact_v1', 'report.batch_outcome_v1', 'report.cpp_value_v1', 'report.step_use_v1'].map((name) => ({ name, kind: 'VIEW', version: 1, owner_slice: '6A-1' })));
    for (const r of rows) await expect(asAnalytics(`select count(*) from ${r.name}`), r.name).resolves.toHaveLength(1);
    for (const behind of ['select * from recipe.execution_state', 'select * from site.lot_consumption', 'select * from plant.step_equipment', 'select report.engine_instant(null)',
                          'select * from report.cpp_values_of(null, null, null)', 'select * from report.exception_v1']) {
      await expect(asAnalytics(behind), behind).rejects.toThrow(/permission denied/);
    }
    expect(await segregationProblems(db.app)).toEqual([]);
  });

  it('[DI-51][DI-52] the inputs read each batch\'s own record, events, release, unit, room occupancy and consumption, and only GMP batches', async () => {
    type Step = { step: string; room_code: string | null; equipment_code: string | null; material_lots: unknown; started_at: Date };
    const [a, b] = [batches[0]!, batches[1]!];
    const tag = randomUUID().slice(0, 6).toUpperCase();
    // A sandbox run carrying a copy of A's record (TEST FIXTURE): no input view shows it, and no GMP batch reads its record.
    const sandbox = randomUUID();
    await fixture(`insert into recipe.batch_execution select (jsonb_populate_record(null::recipe.batch_execution, to_jsonb(x) || jsonb_build_object(
                     'id', $2::uuid, 'batch_number', $3::text, 'installation', 'SANDBOX', 'purpose', 'SANDBOX_TEST_RUN', 'package_hash', repeat('c', 64),
                     'control_recipe_id', null, 'issue_signature_id', null))).* from recipe.batch_execution x where x.id = $1`, [a.id, sandbox, `SBX-${tag}`]);
    await fixture(`insert into recipe.execution_state select (jsonb_populate_record(null::recipe.execution_state, to_jsonb(s) || jsonb_build_object('batch_id', $2::uuid))).*
                     from recipe.execution_state s where s.batch_id = $1`, [a.id, sandbox]);
    for (const view of ['report.batch_fact_v1', 'report.cpp_value_v1', 'report.step_use_v1']) {
      expect(await asAnalytics(`select 1 from ${view} where batch_id = $1`, [sandbox]), view).toEqual([]);
    }

    // Completion: the time of the command whose own event moved the batch to EXECUTION_COMPLETE (TEST FIXTURE commands and
    // events; earlier commands and another batch's command of the same number carry earlier times).
    const command = (batch: string, seq: number, nowUs: string) => fixture(
      `insert into recipe.execution_command select (jsonb_populate_record(null::recipe.execution_command, to_jsonb(c) || jsonb_build_object(
         'seq', $2::bigint, 'command_id', $4::text, 'now_us', $3::bigint, 'kind', 'COMMAND'))).* from recipe.execution_command c where c.batch_id = $1 order by c.seq limit 1`,
      [batch, seq, nowUs, `fixture-${randomUUID()}`]);
    const event = (batch: string, seq: number, to: string) => fixture(
      "insert into recipe.execution_event (batch_id, row_seq, idx, event_type, event) values ($1, $2, 0, 'BATCH_STATUS_CHANGED', $3::jsonb)", [batch, seq, JSON.stringify({ to })]);
    await command(a.id, 1001, '1100000000000000');
    await event(a.id, 1001, 'IN_EXECUTION');
    await command(a.id, 1002, '1200000000000000');
    await event(a.id, 1002, 'EXECUTION_COMPLETE');
    await command(b.id, 1002, '1000000000000000');
    await event(b.id, 1002, 'IN_EXECUTION');
    const completed = async (id: string) => (await asAnalytics<{ completed_at: Date | null }>('select completed_at from report.batch_fact_v1 where batch_id = $1', [id]))[0]?.completed_at;
    expect((await completed(a.id))?.toISOString()).toBe(new Date(1_200_000_000_000).toISOString());
    expect(await completed(b.id)).toBeNull();
    // Released only by a RELEASED decision on the batch's own finished lot: B's lot without a decision is not.
    const lot = randomUUID();
    await fixture(`insert into site.finished_lot (lot_id, batch_id, batch_number, edition, product_code, strength, markets, posted_by_person, posted_by_account)
                   values ($1, $2, $3, 'TABLETS', 'X', '40 mg', array['IN'], gen_random_uuid(), gen_random_uuid())`, [lot, b.id, b.number]);
    expect((await asAnalytics<{ released: boolean }>('select released from report.batch_fact_v1 where batch_id = $1', [b.id]))[0]?.released).toBe(false);

    // Step use: one row per executed step of the batch's own record; the bound unit's own room; the lot only on its step.
    const executedOf = (state: Json) => Object.entries(state['steps'] as Record<string, Json>).filter(([, x]) => us(x['startedAt']) !== null);
    const rowsOf = (id: string) => asAnalytics<Step>('select step, room_code, equipment_code, material_lots, started_at from report.step_use_v1 where batch_id = $1', [id]);
    const aRows = await rowsOf(a.id);
    expect(aRows.length).toBe(executedOf(a.state).length);
    const bound = aRows.filter((r) => r.equipment_code !== null);
    expect(bound).toHaveLength(1);
    expect(aRows.filter((r) => r !== bound[0]).map((r) => r.material_lots)).toEqual(aRows.slice(1).map(() => []));

    // Room occupancy of B: R_A from exactly the start of B's first step until exactly the start of its next one; another
    // batch's occupancy in R_X covering both (TEST FIXTURE rows).
    const startUs = (x: Json) => (x['startedAt'] as { $u: string }).$u;
    const bSteps = executedOf(b.state).sort(([, x], [, y]) => Number(BigInt(startUs(x)) - BigInt(startUs(y))));
    const firstStart = startUs(bSteps[0]![1]);
    const next = bSteps.find(([, x]) => BigInt(startUs(x)) > BigInt(firstStart))!;
    const [roomA, roomX, occA, occX] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const [id, code] of [[roomA, `RA-${tag}`], [roomX, `RX-${tag}`]]) {
      await fixture("insert into plant.area (id, code, kind, name, segregated, negative_pressure, recorded_by) values ($1, $2, 'ROOM', 'Room', false, false, gen_random_uuid())", [id, code]);
    }
    const occupy = (id: string, area: string, batch: string, ref: string, fromUs: string) => fixture(
      `insert into plant.area_occupancy (id, area_id, exclusive, batch_id, batch_ref, product_code, stage, clearance_id, started_by, started_at)
       values ($1, $2, true, $3, $4, 'X', 'S', gen_random_uuid(), gen_random_uuid(), to_timestamp($5::numeric / 1000000))`, [id, area, batch, ref, fromUs]);
    await occupy(occA, roomA, b.id, b.number, firstStart);
    await fixture('insert into plant.area_occupancy_end (occupancy_id, ended_by, ended_at) values ($1, gen_random_uuid(), to_timestamp($2::numeric / 1000000))', [occA, startUs(next[1])]);
    await occupy(occX, roomX, a.id, a.number, String(BigInt(firstStart) - 86_400_000_000n));
    const bRoom = (await db.admin.query<{ r: string | null }>('select room_code as r from recipe.batch_execution where id = $1', [b.id])).rows[0]?.r ?? null;
    const bRows = await rowsOf(b.id);
    expect(bRows.length).toBe(executedOf(b.state).length);
    const atFirst = bRows.filter((r) => r.started_at.getTime() === Number(BigInt(firstStart) / 1000n));
    expect(atFirst.length).toBeGreaterThan(0);
    expect(atFirst.map((r) => r.room_code)).toEqual(atFirst.map(() => `RA-${tag}`));
    expect(bRows.find((r) => r.step === next[0])?.room_code).toBe(bRoom);
  });

  it('[DI-52] a critical value is read with its own definition\'s limits, a single value as one reading, and an engine instant only from its text', async () => {
    const b = batches[0]!;
    const content = (await db.admin.query<{ c: Json }>('select recipe.batch_mbr_content($1) as c', [b.id])).rows[0]!.c;
    const values = async (c: Json, st: Json) => (await db.admin.query<{ kind: string; item: string; ref: string; reading: number | null; lower_text: string | null; upper_text: string | null; limit_tier: string | null }>(
      'select kind, item, ref, reading, lower_text, upper_text, limit_tier from report.cpp_values_of($1, $2::jsonb, $3::jsonb)', [b.number, JSON.stringify(c), JSON.stringify(st)])).rows;
    const base = await values(content, b.state);
    const calc = base.find((r) => r.kind === 'CALCULATION')!;
    // The calculation given limits of its own: its value is read with them, not another calculation's.
    const calcs = (content['calculations'] as Json[]).map((k) => (k['id'] === calc.item ? { ...k, limits: { ranges: [{ tier: 'ALERT', low: { value: '95.0' }, high: { value: '101.0' } }] } } : k));
    expect((await values({ ...content, calculations: calcs }, b.state)).find((r) => r.ref === calc.ref)).toMatchObject({ lower_text: '95.0', upper_text: '101.0', limit_tier: 'ALERT' });
    // A single (DECIMAL) value that also carries a values array is still one reading.
    const hardness = base.find((r) => r.item === 'hardness')!;
    const points = b.state['points'] as Record<string, Json>;
    const point = points[hardness.ref]!;
    const state = { ...b.state, points: { ...points, [hardness.ref]: { ...point, value: { ...(point['value'] as Json), values: ['1.0', '2.0'] } } } };
    expect((await values(content, state)).filter((r) => r.ref === hardness.ref).map((r) => r.reading)).toEqual([null]);
    // An engine instant is its microseconds as text; a number or other text is no instant.
    const instant = async (v: unknown) => (await db.admin.query<{ t: Date | null }>('select report.engine_instant($1::jsonb) as t', [JSON.stringify(v)])).rows[0]?.t;
    expect((await instant({ $u: '1000000' }))?.toISOString()).toBe('1970-01-01T00:00:01.000Z');
    expect(await instant({ $u: 1000000 })).toBeNull();
    expect(await instant({ $u: 'soon' })).toBeNull();
  });
});
