/**
 * The deviation-rate inputs (Phase 6A slice 6A-2; recipe-core 1130; ADR 0020 point 3; draft controls DI-51, DI-52;
 * D-6A-10, D-6A-2-6 to D-6A-2-9): report.deviation_fact_v1 attributes each deviation linked to a GMP batch record to the
 * step of the exception it was linked to, with that step's unit, room and consumed lots and the shift it falls in; a
 * deviation linked to the batch only is unattributed but for its shift; a cancelled one is left out. report.step_shift_v1
 * gives the shift of each executed step. The shifts are the platform setting site.shift_boundaries, changed only under a
 * change record and refused when malformed. The PQR extract is unchanged by analytics being present (D-6A-18).
 *
 * The batches are GMP batches issued from an effective master, executed as the engine's golden granulation run written
 * as the projection the execution writers keep (TEST FIXTURE, as in input-views.test.ts); the deviations are raised and
 * linked through the site definers; the exception register row and the unit, room and lot rows are TEST FIXTURE rows.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveChangeRecord, raiseChangeRecord } from '../../../kernel/src/config/change-control.ts';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { withCommand, type ActorContext } from '../../../kernel/src/db/command.ts';
import { segregationProblems } from '../../../kernel/src/sandbox/provision.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { seedActor, seedAdministration, seedServiceActor, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { signFor } from '../../../kernel/test/records/helpers.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../../../kernel/test/support/db.ts';
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
const dir = tempDir('analytics-rates');
const ledger = tempLedger('analytics-rates', dir.path);

let db: TestDatabase;
let w: World;
let erp: SeededActor;
let operator: SeededActor;
let owner: SeededActor;
let qa: SeededActor;
let master: { familyId: string; versionId: string; content: MbrContent };
const batches: { id: string; number: string; state: Json; step: string }[] = [];
const tag = randomUUID().slice(0, 6).toUpperCase();
let attributed: { id: string; ref: string };
let batchOnly: { id: string; ref: string };
let cancelled: { id: string; ref: string };
let from: string;
let to: string;

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

/** Statements as the software release (what a migration does), in one transaction. */
async function asRelease(statements: { text: string; values?: unknown[] }[]): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query(`select kernel.set_actor_context(jsonb_build_object('person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
      'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM', 'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
      'legal_name', 'Test fixture (analytics)', 'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'test fixture'))`);
    for (const s of statements) await c.query(s.text, s.values ?? []);
    await c.query('select kernel.set_actor_context(null)');
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
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

function executedRecord(): Json {
  const r = Run.issue(fixtureDefinition(FIXTURE), { inputs: FIXTURE_INPUTS[FIXTURE], variants: {} });
  expect(autopilot(r, GRANULATION_SCENARIO)).toBe('COMPLETE');
  return JSON.parse(JSON.stringify(encodeState(r.state))) as Json;
}

const us = (v: unknown): string => new Date(Number(BigInt((v as { $u: string }).$u) / 1000n)).toISOString();

async function deviation(batchId: string, title: string): Promise<{ id: string; ref: string }> {
  const d = await w.run(operator, async (c) => (await c.query<{ r: { deviationId: string } }>('select site.raise_deviation($1::jsonb) as r', [
    JSON.stringify({ kind: 'DEVIATION', title, classification: 'MINOR', riskRationale: 'Assessed for the batch and its markets' }),
  ])).rows[0]!.r);
  await w.run(operator, (c) => c.query("select site.link_deviation($1, 'BATCH', $2)", [d.deviationId, batchId]));
  const ref = (await db.admin.query<{ ref: string }>('select ref from site.deviation where id = $1', [d.deviationId])).rows[0]!.ref;
  return { id: d.deviationId, ref };
}

const again = <T extends ActorContext>(ctx: T): T => ({ ...ctx, correlationId: randomUUID() });
async function approvedRecord(areas: string[]): Promise<string> {
  const num = `CR-${randomBytes(4).toString('hex').toUpperCase()}`;
  await withCommand(db.app, again(owner), (c) => raiseChangeRecord(c, { number: num, title: `Change ${num}`, description: 'site shifts for the analytics test', areas }));
  const sig = await signFor(db, qa, { type: 'config_change_record', id: num }, 'CONFIG_CHANGE_APPROVED', 'OPEN');
  await withCommand(db.app, again(qa), (c) => approveChangeRecord(c, num, sig));
  return num;
}
const setShifts = (value: string, changeRecord: string) =>
  withCommand(db.app, { ...withReason(owner, 'CONFIG_CHANGE', 'site shift pattern'), changeRecord }, (c) => c.query("select platform.set_setting('site.shift_boundaries', $1)", [value]));

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  ({ owner } = await seedAdministration(db));
  qa = await seedActor(db, { roleCode: 'QA_REVIEWER' });
  const steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator', roomCode: 'DISP-01' });
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
  for (let k = 0; k < 2; k++) {
    const id = await issuedBatch();
    const state = executedRecord();
    await fixture("update recipe.execution_state set state = $2::jsonb, status = 'EXECUTION_COMPLETE' where batch_id = $1", [id, JSON.stringify(state)]);
    const number = (await db.app.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [id])).rows[0]!.n;
    const step = Object.entries(state['steps'] as Record<string, Json>).find(([, s]) => s['startedAt'] !== undefined)![0];
    batches.push({ id, number, state, step });
  }
  const b = batches[0]!;
  // The first step of batch 1 ran on a unit in a room and consumed a supplier's lot (TEST FIXTURE rows).
  const [area, eq, lot, consumption] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await fixture("insert into plant.area (id, code, kind, name, segregated, negative_pressure, recorded_by) values ($1, $2, 'ROOM', 'Compression room', false, false, gen_random_uuid())", [area, `RM-${tag}`]);
  await fixture("insert into plant.equipment (id, code, name, class_code, kind, area_id, recorded_by) values ($1, $2, 'Tablet press', 'CL-PRESS', 'PROCESS', $3, gen_random_uuid())", [eq, `PR-${tag}`, area]);
  await fixture("insert into plant.step_equipment (batch_id, step, equipment_id, use_id, person_id, account_id, correlation_id) values ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [b.id, b.step, eq]);
  const entries = (b.state['entries'] ?? {}) as Record<string, Json>;
  const entryKey = Object.entries(entries).find(([, e]) => e['stepKey'] === b.step)?.[0] ?? 'fixture-entry';
  if (!(entryKey in entries)) {
    entries[entryKey] = { id: entryKey, stepKey: b.step, kind: 'FIXTURE', data: {}, enteredBy: randomUUID(), recordedAt: { $u: '1' }, recordedSeq: 1 };
    await fixture('update recipe.execution_state set state = $2::jsonb where batch_id = $1', [b.id, JSON.stringify({ ...b.state, entries })]);
  }
  await fixture(`insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, supplier, received_quantity, unit, expires_at, received_by_person, received_by_account, correlation_id)
                 values ($1, 'SITE-1', $2, 'API-1', 'Active', 'API', 'SUP-7', 10, 'kg', '2029-01-01', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`, [lot, `API-${tag}`]);
  await fixture(`insert into site.lot_consumption (id, lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after, market_set, identity_basis, consumed_by_person, consumed_by_account, xact_id)
                 values ($1, $2, gen_random_uuid(), $3, $4, 'TABLETS', 'API-1', 1, 'kg', 10, 9, array['IN'], 'IDENTITY_RESULT', gen_random_uuid(), gen_random_uuid(), 1)`, [consumption, lot, b.id, b.number]);
  await fixture('insert into recipe.consumption_entry (consumption_id, batch_id, entry_key) values ($1, $2, $3)', [consumption, b.id, entryKey]);

  // Deviations: one linked to an exception raised at that step (the exception and its link act are TEST FIXTURE rows,
  // at 09:30 site time, shift A), one linked to batch 2 only, one cancelled.
  attributed = await deviation(b.id, 'Hardness drifted at compression');
  await fixture(`insert into recipe.exception_register (batch_id, exception_id, row_seq, exception_type, category, severity, tier, title, raising_step_key, raising_step, raised_at, raised_at_us,
                   raised_by, command_person, mandatory, qa_only, deviation_required, registration_relevant, release_blocking, blocks_until, raised_record, correlation_id)
                 values ($1, 'EX-1', 1, 'LIMIT_EXCURSION', 'OUT_OF_LIMIT', 'ACTION', 'ALERT', 'Hardness out of limit', $2, $2, '2026-06-01 04:00:00+00', 1780286400000000,
                         'operator', gen_random_uuid(), true, false, true, false, true, 'DEVIATION', '{}', gen_random_uuid())`, [b.id, b.step]);
  await fixture(`insert into recipe.exception_register_act (batch_id, exception_id, act, row_seq, by_person, by_account, role_code, deviation_ref, correlation_id)
                 values ($1, 'EX-1', 'DEVIATION_LINKED', 2, gen_random_uuid(), gen_random_uuid(), 'OPERATOR', $2, gen_random_uuid())`, [b.id, attributed.ref]);
  batchOnly = await deviation(batches[1]!.id, 'Label reconciliation gap');
  cancelled = await deviation(batches[1]!.id, 'Raised in error');
  await fixture("insert into site.deviation_event (deviation_id, event, reason, person_id, account_id) values ($1, 'CANCELLED', 'raised in error', gen_random_uuid(), gen_random_uuid())", [cancelled.id]);
  const { rows } = await db.admin.query<{ f: string; t: string }>('select (current_date - 3)::text as f, (current_date + 3)::text as t');
  from = rows[0]!.f;
  to = rows[0]!.t;
}, 900_000);

afterAll(async () => {
  await db?.drop();
  dir.cleanup();
});

interface DevRow {
  deviation_id: string; deviation_ref: string; classification: string; batch_id: string; batch_number: string; step: string | null; equipment_code: string | null;
  room_code: string | null; material_lot: string | null; supplier_code: string | null; shift: string;
}

describe('the deviation-rate inputs (recipe-core 1130)', () => {
  it('[DI-51] report.deviation_fact_v1 attributes a deviation to the step of its exception with the unit, room, lots and shift; one linked to the batch only is unattributed; a cancelled one is left out', async () => {
    const rows = await asAnalytics<DevRow>('select * from report.deviation_fact_v1 where batch_id = any($1::uuid[]) order by deviation_ref', [batches.map((b) => b.id)]);
    expect(rows.map((r) => r.deviation_id).sort()).toEqual([attributed.id, batchOnly.id].sort());
    const a = rows.find((r) => r.deviation_id === attributed.id)!;
    // 04:00 UTC is 09:30 in Asia/Kolkata (the seeded site zone): shift A of the default pattern.
    expect(a).toMatchObject({ deviation_ref: attributed.ref, classification: 'MINOR', batch_id: batches[0]!.id, batch_number: batches[0]!.number, step: batches[0]!.step,
                              equipment_code: `PR-${tag}`, room_code: `RM-${tag}`, material_lot: `API-${tag}`, supplier_code: 'SUP-7', shift: 'A' });
    const o = rows.find((r) => r.deviation_id === batchOnly.id)!;
    expect(o).toMatchObject({ batch_id: batches[1]!.id, step: null, equipment_code: null, room_code: null, material_lot: null, supplier_code: null });
    expect(['A', 'B', 'C']).toContain(o.shift);
  });

  it('[DI-51] report.step_shift_v1 gives the shift of each executed step; the shifts are a setting changed only under a change record, and a malformed one is refused', async () => {
    const rows = await asAnalytics<{ batch_id: string; step: string; started_at: Date; shift: string }>('select batch_id, step, started_at, shift from report.step_shift_v1 where batch_id = $1', [batches[0]!.id]);
    const steps = Object.entries(batches[0]!.state['steps'] as Record<string, Json>).filter(([, s]) => s['startedAt'] !== undefined);
    expect(rows.map((r) => r.step).sort()).toEqual(steps.map(([k]) => k).sort());
    const shiftAt = async (instant: string): Promise<string> => (await db.admin.query<{ s: string }>('select report.shift_of($1::timestamptz) as s', [instant])).rows[0]!.s;
    for (const r of rows) expect(r.shift, r.step).toBe(await shiftAt(r.started_at.toISOString()));
    expect(rows[0]!.started_at.toISOString()).toBe(us((steps.find(([k]) => k === rows[0]!.step)![1])['startedAt']));
    // Site time Asia/Kolkata (+05:30): 00:29 UTC is 05:59 (shift C, past midnight), 00:30 UTC is 06:00 (A), 08:30 UTC 14:00 (B).
    expect([await shiftAt('2026-06-01T00:29:00Z'), await shiftAt('2026-06-01T00:30:00Z'), await shiftAt('2026-06-01T08:30:00Z'), await shiftAt('2026-06-01T16:30:00Z')]).toEqual(['C', 'A', 'B', 'C']);
    // Without a change record the setting is refused; with one a malformed value is refused, a valid one takes effect.
    await expect(withCommand(db.app, withReason(owner, 'CONFIG_CHANGE', 'x'), (c) => c.query("select platform.set_setting('site.shift_boundaries', 'D=07:00,N=19:00')"))).rejects.toThrow(/EBMR-CFG-001/);
    const number = await approvedRecord(['PLATFORM_SETTING']);
    for (const bad of ['A=06:00,B=05:00', 'A=06:00,A=14:00', 'A=6:00', 'a=06:00', '', 'A=06:00;B=14:00', 'A=24:00']) {
      await expect(setShifts(bad, number), bad).rejects.toThrow(/EBMR-ANA-020|EBMR-PLAT-021/);
    }
    await setShifts('D=07:00,N=19:00', number);
    expect([await shiftAt('2026-06-01T01:29:00Z'), await shiftAt('2026-06-01T01:30:00Z'), await shiftAt('2026-06-01T13:30:00Z')]).toEqual(['N', 'D', 'N']);
    const shifted = await asAnalytics<{ shift: string }>('select shift from report.deviation_fact_v1 where deviation_id = $1', [attributed.id]);
    expect(shifted.map((r) => r.shift)).toEqual(['D']);
    await setShifts('A=06:00,B=14:00,C=22:00', number);
  });

  it('[DI-51] the inputs are on the analytics role\'s allow-list; it reads them and nothing behind them, and the segregation check stays clean', async () => {
    const { rows } = await db.app.query<{ name: string; kind: string; version: number; owner_slice: string }>(
      "select name, kind, version, owner_slice from analytics.input_catalog_v1 where owner_slice = '6A-2' order by name");
    expect(rows).toEqual(['report.deviation_fact_v1', 'report.step_shift_v1'].map((name) => ({ name, kind: 'VIEW', version: 1, owner_slice: '6A-2' })));
    for (const behind of ['select * from site.deviation', 'select * from site.deviation_link', 'select * from recipe.exception_register_act', "select report.shift_of(now())",
                          "select report.shift_boundaries_problem('A=06:00')", 'select * from recipe.exception_register']) {
      await expect(asAnalytics(behind), behind).rejects.toThrow(/permission denied/);
    }
    expect(await segregationProblems(db.app)).toEqual([]);
    // The setting's own rule holds for every writer: the database owner cannot store a malformed value either.
    await expect(db.admin.query("insert into platform.setting_value (key, value, set_by_person, reason_code) values ('site.shift_boundaries', 'X', 'x', 'X')")).rejects.toThrow(/EBMR-ANA-020|EBMR-CFG/);
  });

  it('[DI-51] the PQR extract\'s content and hash are unchanged with analytics present', async () => {
    const product = master.content.header.product.code;
    const extract = async (): Promise<{ text: string; sha: string }> => {
      const t = (await db.admin.query<{ t: string }>('select recipe.pqr_extract_v2($1, $2::date, $3::date)::text as t', [product, from, to])).rows[0]!.t;
      return { text: t, sha: createHash('sha256').update(t).digest('hex') };
    };
    const before = await extract();
    expect(JSON.parse(before.text)).toBeTruthy();
    // Analytics present: an SPC method in force and a finished run with a chart about the product's item and a flag
    // about a batch of the period, written as the analytics role through its functions (as the runner writes them).
    await asRelease([{
      text: `insert into analytics.method_version (method, version, status, title, intended_use, acceptance, parameters, parameters_sha256, code_identity, validation_ref)
             values ('SPC.IMR', 1, 'EFFECTIVE', 'I-MR', 'advisory chart', '{}', '{}', repeat('a', 64), '@ebmr/analytics 0.1.0 (commit test)', 'VAL-6A-2')`,
    }]);
    const inputs = JSON.stringify([{ view: 'report.cpp_value_v1', version: 1, filter: null, data_as_of: '2026-10-17T00:00:00Z', rows: 1, sha256: 'b'.repeat(64) }]);
    const runtime = JSON.stringify({ package: '@ebmr/analytics 0.1.0', commit: 'test', node: process.version, libraries: {} });
    const [run] = await asAnalytics<{ id: string }>("select analytics.begin_run('SPC.IMR', 1, null, 'ON_DEMAND', $1::jsonb, $2::jsonb)::text as id", [inputs, runtime]);
    const subject = `${product}|x|hardness`;
    await asAnalytics("select analytics.record_output($1, 'PRODUCT_ITEM', $2, 'CONTROL_CHART', '{\"centre\": 90.5}', '[]')", [run!.id, subject]);
    await asAnalytics("select analytics.record_flag($1, null, 'BATCH', $2, 'NELSON_1', 'ATTENTION', '[{\"code\": \"NELSON_1\", \"text\": \"a point beyond 3 sigma\"}]')", [run!.id, batches[0]!.id]);
    await asAnalytics("select analytics.finish_run($1, $2, '{}')", [run!.id, 'c'.repeat(64)]);
    const after = await extract();
    expect(after.text).toBe(before.text);
    expect(after.sha).toBe(before.sha);
    // And the extract reads nothing of analytics: no function of the PQR names the schema (the DI-51 dependency proof).
    const { rows } = await db.admin.query<{ n: number }>("select count(*)::integer as n from pg_proc where proname like 'pqr%' and prosrc ~* 'analytics\\s*\\.'");
    expect(rows[0]!.n).toBe(0);
  });
});
