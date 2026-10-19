/**
 * The review facts (Phase 6A slice 6A-5; recipe-core 1160; ADR 0020 point 3; draft controls PR-61, DI-51; D-6A-5-1 to
 * D-6A-5-3): report.review_fact_v1 gives each GMP batch record in the review queue that awaits QA review, or was QA
 * reviewed in the last 30 days, with its exceptions by severity, accepted post-entry corrections, linked deviations (not
 * cancelled), new operators and new or recently maintained units, and its review outcome so far; nothing in the review,
 * the exception register or release depends on the review priority the method computes from it.
 *
 * The batches are GMP batches issued from an effective master and executed as the engine's golden granulation run
 * written as the projection the execution writers keep (TEST FIXTURE, as in input-views.test.ts); the exception
 * register rows, register and review acts, the status-change events, the corrections and the units are TEST FIXTURE
 * rows written as the database owner with triggers off; the deviations are raised and linked through the site definers.
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
const dir = tempDir('analytics-review');
const ledger = tempLedger('analytics-review', dir.path);

let db: TestDatabase;
let w: World;
let erp: SeededActor;
let operator: SeededActor;
let master: { familyId: string; versionId: string; content: MbrContent };
interface Batch { id: string; number: string; state: Json; step: string; startedAt: string }
const b: Record<'rich' | 'recent' | 'old' | 'aborted' | 'running', Batch> = {} as never;
const tag = randomUUID().slice(0, 6).toUpperCase();
let linked: string;
let cancelled: string;

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

function executedRecord(): Json {
  const r = Run.issue(fixtureDefinition(FIXTURE), { inputs: FIXTURE_INPUTS[FIXTURE], variants: {} });
  expect(autopilot(r, GRANULATION_SCENARIO)).toBe('COMPLETE');
  return JSON.parse(JSON.stringify(encodeState(r.state))) as Json;
}
const us = (v: unknown): string => new Date(Number(BigInt((v as { $u: string }).$u) / 1000n)).toISOString();

const P1 = randomUUID();
const P2 = randomUUID();

/**
 * A batch issued and (unless `status` is null) brought to `status` with the executed record, its engine times moved
 * `days` later and its operator OP1 replaced by the persons given (the fixture's person ids are not uuids).
 */
async function batch(status: 'EXECUTION_COMPLETE' | 'ABORTED' | null, days = 0, persons: readonly string[] = []): Promise<Batch> {
  const id = await issuedBatch();
  const shifted = JSON.stringify(executedRecord()).replace(/"\$u":"(\d+)"/g, (_m, d: string) => `"$u":"${(BigInt(d) + BigInt(days) * 86_400_000_000n).toString()}"`);
  const state = JSON.parse(persons.length === 0 ? shifted : shifted.replace(/\["OP1"\]/g, JSON.stringify(persons))) as Json;
  if (status !== null) await fixture('update recipe.execution_state set state = $2::jsonb, status = $3 where batch_id = $1', [id, JSON.stringify(state), status]);
  const number = (await db.app.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [id])).rows[0]!.n;
  const [step, s] = Object.entries(state['steps'] as Record<string, Json>).find(([, x]) => x['startedAt'] !== undefined)!;
  return { id, number, state, step, startedAt: us(s['startedAt']) };
}

/** TEST FIXTURE: the status change the engine writes when the record completes (or is aborted), on its issue row. */
const ended = (id: string, to: string) =>
  fixture("insert into recipe.execution_event (batch_id, row_seq, idx, event_type, event) values ($1, 1, 9999, 'BATCH_STATUS_CHANGED', jsonb_build_object('to', $2::text))", [id, to]);

/** TEST FIXTURE: an execution command of `type` on the record, copied from its issue row. */
const command = (id: string, seq: number, type: string, accepted: boolean) =>
  fixture(`insert into recipe.execution_command
             select (jsonb_populate_record(null::recipe.execution_command, to_jsonb(c) || jsonb_build_object('seq', $2::bigint, 'command_id', $3::text, 'command_type', $4::text,
                                                                                                       'accepted', $5::boolean, 'kind', 'COMMAND',
                                                                                                       'refusal', case when $5::boolean then null else '{"code": "FIXTURE"}'::jsonb end))).*
               from recipe.execution_command c where c.batch_id = $1 and c.seq = 1`, [id, seq, `fx-${randomUUID()}`, type, accepted]);

const exception = (id: string, exceptionId: string, severity: 'CRITICAL' | 'ACTION' | 'ALERT') =>
  fixture(`insert into recipe.exception_register (batch_id, exception_id, row_seq, exception_type, category, severity, tier, title, raising_step_key, raising_step, raised_at, raised_at_us,
             raised_by, command_person, mandatory, qa_only, deviation_required, registration_relevant, release_blocking, blocks_until, raised_record, correlation_id)
           values ($1, $2, 1, 'LIMIT_EXCURSION', 'OUT_OF_LIMIT', $3, null, 'Out of limit', 's', 's', '2026-06-01 04:00:00+00', 1780286400000000,
                   'operator', gen_random_uuid(), true, $3 = 'CRITICAL', false, false, false, null, '{}', gen_random_uuid())`, [id, exceptionId, severity]);

const reviewAct = (id: string, act: string, cycle: number, recordedAt: string) =>
  fixture(`insert into recipe.batch_review_act (batch_id, cycle, act, signature_id, reason, person_id, account_id, role_code, correlation_id, recorded_at)
           values ($1, $2, $3, gen_random_uuid(), case when $3 = 'REOPENED' then 'reopened for a query' end, gen_random_uuid(), gen_random_uuid(), 'QA_REVIEWER', gen_random_uuid(), $4::timestamptz)`,
  [id, cycle, act, recordedAt]);

async function deviation(batchId: string, title: string): Promise<string> {
  const d = await w.run(operator, async (c) => (await c.query<{ r: { deviationId: string } }>('select site.raise_deviation($1::jsonb) as r', [
    JSON.stringify({ kind: 'DEVIATION', title, classification: 'MINOR', riskRationale: 'Assessed for the batch and its markets' }),
  ])).rows[0]!.r);
  await w.run(operator, (c) => c.query("select site.link_deviation($1, 'BATCH', $2)", [d.deviationId, batchId]));
  return d.deviationId;
}

/** TEST FIXTURE: a unit in a room, bound to `batch`'s first step; optionally an equipment event `daysBefore` its start. */
async function unit(code: string, batches: readonly Batch[], event?: { kind: string; daysBefore: number }): Promise<void> {
  const [area, eq] = [randomUUID(), randomUUID()];
  await fixture("insert into plant.area (id, code, kind, name, segregated, negative_pressure, recorded_by) values ($1, $2, 'ROOM', 'Room', false, false, gen_random_uuid())", [area, `RM-${code}`]);
  await fixture("insert into plant.equipment (id, code, name, class_code, kind, area_id, recorded_by) values ($1, $2, 'Unit', 'CL-PRESS', 'PROCESS', $3, gen_random_uuid())", [eq, code, area]);
  for (const x of batches) {
    await fixture('insert into plant.step_equipment (batch_id, step, equipment_id, use_id, person_id, account_id, correlation_id) values ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())',
      [x.id, x.step, eq]);
  }
  if (event) {
    await fixture(`insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id, recorded_at)
                   values ($1, $2, 'WO-1', 'Preventive maintenance', gen_random_uuid(), gen_random_uuid(), $3::timestamptz - make_interval(days => $4))`,
    [eq, event.kind, batches[batches.length - 1]!.startedAt, event.daysBefore]);
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
  // Slice 7c (DI-03, recipe-core 1250): a GMP batch is issued only on a release with an approved validation summary.
  await approveTestRelease(db);
  w = new World(db, await seedCast(db));
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
      JSON.stringify({ rule_code: `R-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'R{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
  );
  master = { familyId: v.familyId, versionId: v.versionId, content };
  b.rich = await batch('EXECUTION_COMPLETE', 0, [P1]);
  b.recent = await batch('EXECUTION_COMPLETE', 2, [P1]);
  b.old = await batch('EXECUTION_COMPLETE', 3);
  b.aborted = await batch('ABORTED', 1, [P1, P2]);
  b.running = await batch(null);

  // The exception-rich record: one critical, two action and one alert exception; two accepted corrections (CORRECT_ENTRY,
  // VOID_ATTEMPT) and a refused one; QA queried one item and escalated another (two findings); a reopen; a linked
  // deviation and a cancelled one; it completed with a status change.
  await exception(b.rich.id, 'EX-1', 'CRITICAL');
  await exception(b.rich.id, 'EX-2', 'ACTION');
  await exception(b.rich.id, 'EX-3', 'ACTION');
  await exception(b.rich.id, 'EX-4', 'ALERT');
  await command(b.rich.id, 9001, 'CORRECT_ENTRY', true);
  await command(b.rich.id, 9002, 'VOID_ATTEMPT', true);
  await command(b.rich.id, 9003, 'CORRECT_ENTRY', false);
  await command(b.rich.id, 9004, 'RECORD_ENTRY', true);
  for (const [ex, act] of [['EX-2', 'QUERIED'], ['EX-2', 'RESPONDED'], ['EX-3', 'ESCALATED']] as const) {
    await fixture(`insert into recipe.exception_register_act (batch_id, exception_id, act, by_person, by_account, role_code, deviation_ref, note, correlation_id)
                   values ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), 'QA_REVIEWER', case when $3 = 'ESCALATED' then 'DEV-1' end, 'a review note', gen_random_uuid())`, [b.rich.id, ex, act]);
  }
  await reviewAct(b.rich.id, 'REOPENED', 1, '2026-10-01T00:00:00Z');
  linked = await deviation(b.rich.id, 'Hardness drifted at compression');
  cancelled = await deviation(b.rich.id, 'Raised in error');
  await fixture("insert into site.deviation_event (deviation_id, event, reason, person_id, account_id) values ($1, 'CANCELLED', 'raised in error', gen_random_uuid(), gen_random_uuid())", [cancelled]);
  await ended(b.rich.id, 'EXECUTION_COMPLETE');
  await ended(b.aborted.id, 'ABORTED');
  // QA reviewed: one today (still covered, so its outcome is kept with a last score), one 40 days ago (no longer).
  await reviewAct(b.recent.id, 'QA_REVIEWED', 1, new Date().toISOString());
  await reviewAct(b.old.id, 'QA_REVIEWED', 1, new Date(Date.now() - 40 * 86_400_000).toISOString());

  // Units: U1 only on the rich record (new there); U2 on the rich and the (later) aborted record, maintained the day
  // before its use there (listed on both); U3 on both, repaired 10 days before (only where it was used first).
  await unit(`U1-${tag}`, [b.rich]);
  await unit(`U2-${tag}`, [b.rich, b.aborted], { kind: 'MAINTENANCE_ENDED', daysBefore: 1 });
  await unit(`U3-${tag}`, [b.rich, b.aborted], { kind: 'REPAIRED', daysBefore: 10 });
}, 900_000);

afterAll(async () => {
  await db?.drop();
  dir.cleanup();
});

interface FactRow {
  batch_id: string; batch_number: string; product_code: string; family_code: string; status: string; review_state: string; cycle: number; ended_at: Date | null;
  exceptions_critical: number; exceptions_major: number; exceptions_minor: number; corrections: number; deviations: number; new_operator: boolean; new_operators: number;
  new_equipment: boolean; new_equipment_codes: string[]; review_findings: number; review_reopenings: number; read_at: Date; data_as_of: Date;
}
const facts = async (): Promise<FactRow[]> =>
  asAnalytics<FactRow>('select * from report.review_fact_v1 where batch_id = any($1::uuid[]) order by batch_number', [Object.values(b).map((x) => x.id)]);

describe('the review facts (recipe-core 1160)', () => {
  it('[PR-61] report.review_fact_v1 lists the records awaiting QA review or reviewed in the last 30 days, with exceptions by severity, accepted corrections, deviations and the review outcome', async () => {
    const rows = await facts();
    expect(rows.map((r) => r.batch_id).sort()).toEqual([b.rich.id, b.recent.id, b.aborted.id].sort());
    const rich = rows.find((r) => r.batch_id === b.rich.id)!;
    expect(rich).toMatchObject({
      batch_number: b.rich.number, product_code: master.content.header.product.code, status: 'EXECUTION_COMPLETE', review_state: 'EXECUTION_COMPLETE', cycle: 2,
      exceptions_critical: 1, exceptions_major: 2, exceptions_minor: 1, corrections: 2, deviations: 1, review_findings: 2, review_reopenings: 1,
    });
    expect(rich.ended_at).toBeInstanceOf(Date);
    expect(rich.read_at).toBeInstanceOf(Date);
    expect(rich.data_as_of).toBeInstanceOf(Date);
    const recent = rows.find((r) => r.batch_id === b.recent.id)!;
    expect(recent).toMatchObject({ review_state: 'QA_REVIEWED', exceptions_critical: 0, exceptions_major: 0, exceptions_minor: 0, corrections: 0, deviations: 0, ended_at: null });
    expect(rows.find((r) => r.batch_id === b.aborted.id)).toMatchObject({ status: 'ABORTED', review_state: 'ABORTED' });
    expect(rows.find((r) => r.batch_id === b.aborted.id)!.ended_at).toBeInstanceOf(Date);
    expect(linked).not.toBe(cancelled);
  });

  it('[PR-61] a person new to the product and a unit new or maintained in the 7 days before its use are counted, never named as a person', async () => {
    const rows = await facts();
    // P1 worked first on the rich record (new there, not on the later ones); P2 first on the aborted record.
    const of = (id: string) => rows.find((r) => r.batch_id === id)!;
    expect([of(b.rich.id).new_operators, of(b.aborted.id).new_operators, of(b.recent.id).new_operators]).toEqual([1, 1, 0]);
    expect([of(b.rich.id).new_operator, of(b.aborted.id).new_operator, of(b.recent.id).new_operator]).toEqual([true, true, false]);
    const codes = (id: string): string[] => rows.find((r) => r.batch_id === id)!.new_equipment_codes.filter((c) => c.endsWith(tag));
    expect(codes(b.rich.id)).toEqual(expect.arrayContaining([`U1-${tag}`, `U2-${tag}`]));
    expect(codes(b.aborted.id)).toContain(`U2-${tag}`);
    // U3 was repaired 10 days before the aborted record's use: it is listed only where it was first used.
    expect(codes(b.rich.id)).toEqual([`U1-${tag}`, `U2-${tag}`, `U3-${tag}`]);
    expect(codes(b.aborted.id)).toEqual([`U2-${tag}`]);
    expect(codes(b.recent.id)).toEqual([]);
    expect(rows.find((r) => r.batch_id === b.rich.id)!.new_equipment).toBe(true);
    // The view's columns name no person.
    const { rows: cols } = await db.admin.query<{ c: string }>("select attname as c from pg_attribute where attrelid = 'report.review_fact_v1'::regclass and attnum > 0 order by attnum");
    expect(cols.map((c) => c.c).filter((c) => /person|account|operator_id|by_/.test(c))).toEqual([]);
  });

  it('[DI-51] the review facts are on the analytics role\'s allow-list and in the report catalogue; the role reads nothing behind them and the segregation check stays clean', async () => {
    const { rows } = await db.app.query<{ name: string; kind: string; version: number; owner_slice: string }>(
      "select name, kind, version, owner_slice from analytics.input_catalog_v1 where owner_slice = '6A-5' order by name");
    expect(rows).toEqual([{ name: 'report.review_fact_v1', kind: 'VIEW', version: 1, owner_slice: '6A-5' }]);
    const { rows: catalogued } = await db.admin.query("select 1 from report.view_registry where view_name = 'review_fact_v1' and version = 1");
    expect(catalogued).toHaveLength(1);
    for (const behind of ['select * from recipe.exception_register', 'select * from recipe.batch_review_act', 'select * from plant.equipment_event', 'select * from report.review_novelty()',
                          'select * from report.review_fact_batches()']) {
      await expect(asAnalytics(behind), behind).rejects.toThrow(/permission denied/);
    }
    expect(await segregationProblems(db.app)).toEqual([]);
    // The reporting role reads it as the other report views (D-6A-1-5).
    const { rows: reportable } = await db.admin.query<{ ok: boolean }>("select has_table_privilege('ebmr_report', 'report.review_fact_v1', 'SELECT') as ok");
    expect(reportable[0]!.ok).toBe(true);
  });

  it('[PR-61] no review, register or release function depends on the review priority', async () => {
    // No catalogue dependency on the priority view or on the output table behind it from outside the analytics schema.
    const { rows: edges } = await db.admin.query<{ dependent: string }>(`
      select pg_describe_object(d.classid, d.objid, 0) as dependent from pg_depend d
       where d.refclassid = 'pg_class'::regclass and d.refobjid in ('analytics.review_priority_v1'::regclass, 'analytics.output'::regclass, 'analytics.output_v1'::regclass)
         and d.classid = 'pg_rewrite'::regclass
         and (select c.relnamespace from pg_rewrite w join pg_class c on c.oid = w.ev_class where w.oid = d.objid) <> 'analytics'::regnamespace`);
    expect(edges).toEqual([]);
    // No routine outside the analytics schema names the priority, its output kind or its method.
    const { rows: bodies } = await db.admin.query<{ fn: string }>(`
      select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname not in ('pg_catalog', 'information_schema', 'analytics') and p.prosrc ~* '(review_priority|REVIEW\\.PRIORITY|REVIEW_PRIORITY)'`);
    expect(bodies).toEqual([]);
    // The scan covers the review, register and release routines: they exist and none reads the analytics schema.
    const { rows: gmp } = await db.admin.query<{ fn: string; reads: boolean }>(`
      select p.oid::regprocedure::text as fn, p.prosrc ~* '\\manalytics\\s*\\.' as reads from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('recipe', 'site', 'kernel', 'platform', 'iam') and p.proname ~ '(review|register|release|grel|disposition)'`);
    expect(gmp.map((g) => g.fn)).toEqual(expect.arrayContaining(['recipe.review_gate_problems(uuid,text)', 'recipe.batch_review_state(uuid)']));
    expect(gmp.length).toBeGreaterThan(20);
    expect(gmp.filter((g) => g.reads)).toEqual([]);
    // And the facts the method reads do not read the analytics schema either.
    const { rows: facts1160 } = await db.admin.query<{ fn: string }>(`
      select p.oid::regprocedure::text as fn from pg_proc p where p.pronamespace = 'report'::regnamespace and p.proname like 'review%' and p.prosrc ~* '\\manalytics\\s*\\.'`);
    expect(facts1160).toEqual([]);
  });

  it('[PR-61][DI-51] each record\'s facts are its own: its end, family, exceptions, deviations, findings and reopenings, and its units maintained within the 7 days up to its use', async () => {
    // The end: the time of the record's own command that carried the status change (each record's issue row).
    const issuedAt = async (id: string) => (await db.admin.query<{ t: Date }>('select report.us_at(now_us) as t from recipe.execution_command where batch_id = $1 and seq = 1', [id])).rows[0]!.t;
    const family = (await db.admin.query<{ code: string }>('select code from recipe.mbr_family where id = $1', [master.familyId])).rows[0]!.code;
    // TEST FIXTURE rows on the aborted record: an action exception and a deviation of its own.
    await exception(b.aborted.id, 'EX-9', 'ACTION');
    await deviation(b.aborted.id, 'Its own deviation');
    // Units used first on the rich record and again on the aborted one: U5 maintained exactly at the aborted record's use,
    // U6 exactly 7 days before; U7 with a CMMS work order completed exactly at the use, U8 exactly 7 days before, U9 with
    // one still open the day before (TEST FIXTURE rows).
    const startUs = BigInt(((b.aborted.state['steps'] as Record<string, Json>)[b.aborted.step]!['startedAt'] as { $u: string }).$u);
    const week = 7n * 86_400_000_000n;
    const unitOn = async (code: string): Promise<string> => {
      const [area, eq] = [randomUUID(), randomUUID()];
      await fixture("insert into plant.area (id, code, kind, name, segregated, negative_pressure, recorded_by) values ($1, $2, 'ROOM', 'Room', false, false, gen_random_uuid())", [area, `RM-${code}`]);
      await fixture("insert into plant.equipment (id, code, name, class_code, kind, area_id, recorded_by) values ($1, $2, 'Unit', 'CL-PRESS', 'PROCESS', $3, gen_random_uuid())", [eq, code, area]);
      for (const x of [b.rich, b.aborted]) {
        await fixture('insert into plant.step_equipment (batch_id, step, equipment_id, use_id, person_id, account_id, correlation_id) values ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())',
          [x.id, x.step, eq]);
      }
      return eq;
    };
    const event = (eq: string, atUs: bigint) => fixture(`insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id, recorded_at)
      values ($1, 'MAINTENANCE_ENDED', 'WO-2', 'Preventive maintenance', gen_random_uuid(), gen_random_uuid(), to_timestamp($2::numeric / 1000000))`, [eq, atUs.toString()]);
    const workOrder = (eq: string, status: string, atUs: bigint) => fixture(`insert into plant.cmms_work_order (equipment_id, work_order, kind, status, message_id, source_timestamp)
      values ($1, $2, 'PREVENTIVE', $3, gen_random_uuid(), to_timestamp($4::numeric / 1000000))`, [eq, `WO-${randomUUID().slice(0, 8)}`, status, atUs.toString()]);
    await event(await unitOn(`U5-${tag}`), startUs);
    await event(await unitOn(`U6-${tag}`), startUs - week);
    await workOrder(await unitOn(`U7-${tag}`), 'COMPLETED', startUs);
    await workOrder(await unitOn(`U8-${tag}`), 'COMPLETED', startUs - week);
    await workOrder(await unitOn(`U9-${tag}`), 'OPEN', startUs - 86_400_000_000n);

    const rows = await facts();
    const of = (id: string) => rows.find((r) => r.batch_id === id)!;
    expect(rows.filter((r) => r.batch_id === b.rich.id)).toHaveLength(1);
    expect(of(b.rich.id).ended_at?.toISOString()).toBe((await issuedAt(b.rich.id)).toISOString());
    expect(of(b.aborted.id).ended_at?.toISOString()).toBe((await issuedAt(b.aborted.id)).toISOString());
    expect(of(b.rich.id).family_code).toBe(family);
    expect(of(b.rich.id)).toMatchObject({ exceptions_major: 2, deviations: 1 });
    expect(of(b.aborted.id)).toMatchObject({ exceptions_major: 1, exceptions_critical: 0, exceptions_minor: 0, deviations: 1, review_findings: 0, review_reopenings: 0 });
    expect(of(b.recent.id)).toMatchObject({ new_equipment: false, new_equipment_codes: [], review_findings: 0, review_reopenings: 0 });
    const mine = (id: string) => of(id).new_equipment_codes.filter((c) => c.endsWith(tag) && /^U[5-9]-/.test(c));
    expect(mine(b.rich.id)).toEqual([`U5-${tag}`, `U6-${tag}`, `U7-${tag}`, `U8-${tag}`, `U9-${tag}`]);
    expect(mine(b.aborted.id)).toEqual([`U5-${tag}`, `U7-${tag}`]);
    // A QA review recorded exactly 30 days before the read is still covered: the old record's review moved to that instant
    // within one statement, so statement_timestamp() is the same for the move and the read (TEST FIXTURE, rolled back).
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query(`do $$ begin
        update recipe.batch_review_act set recorded_at = pg_catalog.statement_timestamp() - interval '30 days' where batch_id = '${b.old.id}' and act = 'QA_REVIEWED';
        if not exists (select 1 from report.review_fact_batches() f where f.batch_id = '${b.old.id}') then raise exception 'FIXTURE: a review exactly 30 days old is not covered'; end if;
        update recipe.batch_review_act set recorded_at = pg_catalog.statement_timestamp() - interval '30 days' - interval '1 microsecond' where batch_id = '${b.old.id}' and act = 'QA_REVIEWED';
        if exists (select 1 from report.review_fact_batches() f where f.batch_id = '${b.old.id}') then raise exception 'FIXTURE: a review older than 30 days is covered'; end if;
      end $$`);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});
