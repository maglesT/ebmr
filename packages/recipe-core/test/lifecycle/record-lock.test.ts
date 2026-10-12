/**
 * Phase 4 slice 5b (recipe-core 0870 to 0872; D-5-7, D-5-8): the bulk reconciliation of a processing record locks it, a
 * locked record refuses every write in the database, an amendment (QA, a linked open deviation or a change record)
 * appends and re-locks with a signature; bulk across several packaging orders and the maximum hold of bright stock
 * (PR-38). Every act runs as the application role through the definers with real e-signatures of seeded people; each
 * rule is also tried around (direct writes as the role, a superuser's write past the definers, the wrong role, an
 * administrator, a stale signature).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withProtectedNumbers } from '../../../kernel/src/continuity/numbers.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { signFor } from '../../../kernel/test/records/helpers.ts';
import { seedActor, seedAdministration, seedServiceActor, type SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import * as containers from '../../src/containers/index.ts';
import * as execution from '../../src/execution/index.ts';
import type * as lc from '../../src/lifecycle/index.ts';
import type { BlockVersion } from '../../src/blocks/contract.ts';
import { define, FIXTURE_INPUTS, FIXTURE_JUSTIFICATIONS, testRegistry } from '../engine/support.ts';
import { familyOrder } from './gmp-support.ts';
import { cell, reason, seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;
let steward: SeededActor;
let erp: SeededActor;
let operator: SeededActor;
let head: SeededActor;
let qa: SeededActor;
let qa2: SeededActor;
let admin: SeededActor;
const dir = tempDir('record-lock');
const ledger = tempLedger('record-lock', dir.path);

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  ({ admin } = await seedAdministration(db));
  steward = await seedActor(db, { roleCode: 'MASTER_DATA_STEWARD', legalName: 'Mira Steward' });
  erp = await seedServiceActor(db, { kind: 'INTEGRATION', source: 'INTEGRATION', roleCode: 'ERP_INTERFACE', name: 'ERP interface' });
  operator = await seedActor(db, { roleCode: 'OPERATOR', legalName: 'Om Operator', roomCode: 'DISP-01' });
  head = await seedActor(db, { roleCode: 'HEAD_OF_PRODUCTION', legalName: 'Hari Head' });
  qa = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Qamar Investigator' });
  qa2 = await seedActor(db, { roleCode: 'QA_REVIEWER', legalName: 'Quentin Approver' });
}, 300_000);

afterAll(async () => {
  await db.drop();
  dir.cleanup();
});

const SITE = 'SITE-1';
type Json = Record<string, unknown>;
type Fixture = 'tablet-granulation-compression' | 'tablet-blister-packaging';
const SIZE: Record<Fixture, string> = { 'tablet-granulation-compression': 'BS-200K', 'tablet-blister-packaging': 'PO-20K' };
const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, params)).rows as T[];

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const m = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e));
    return m?.[1] ?? (e instanceof Error ? e.message : String(e));
  }
}

function without(content: unknown, types: readonly string[]): unknown {
  if (Array.isArray(content)) {
    return content.filter((x) => !(x && typeof x === 'object' && types.includes(String(((x as Json)['block'] as Json | undefined)?.['type'])))).map((x) => without(x, types));
  }
  if (content && typeof content === 'object') return Object.fromEntries(Object.entries(content).map(([k, v]) => [k, without(v, types)]));
  return content;
}

/** TEST STAND-IN for the tablets edition's TB-24 (as in packaging-issue.test.ts): a packaging master needs a completion block. */
const TB24_STAND_IN: BlockVersion = (() => {
  const g = testRegistry().get('G-16', '1');
  if (!g) throw new Error('G-16 version 1 is not registered');
  return { ...g, type: 'TB-24', edition: 'tablets', title: 'TEST STAND-IN: secondary packaging (TB-24)' };
})();
const registry = testRegistry().extend(TB24_STAND_IN);

function withSecondaryPacking(content: unknown): unknown {
  const c = JSON.parse(JSON.stringify(content)) as unknown;
  let done = false;
  const walk = (n: unknown): void => {
    if (done) return;
    if (Array.isArray(n)) {
      const i = n.findIndex((x) => (x as Json | null)?.['id'] === 'p-line-check');
      if (i >= 0) {
        n.splice(i + 1, 0, { ...(n[i] as Json), id: 'p-tb24-standin', name: 'Secondary packaging (stand-in)', block: { type: 'TB-24', version: '1' }, records: [] });
        done = true;
        return;
      }
      n.forEach(walk);
    } else if (n && typeof n === 'object') Object.values(n).forEach(walk);
  };
  walk(c);
  if (!done) throw new Error('the packaging fixture has no line check step');
  return c;
}

async function master(name: Fixture, product?: string): Promise<{ familyId: string; product: string }> {
  const m = uniqueContent(name, ['IN']);
  m.header.product = { ...m.header.product, code: (product ?? m.header.product.code).toUpperCase() };
  const stripped = without(m, ['G-09', 'G-10']);
  const content = (name === 'tablet-blister-packaging' ? withSecondaryPacking(stripped) : stripped) as MbrContent;
  const v = await w.approvedVersion(content);
  const def: lc.MarketAuthorisationDefinition = { versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, 'L1', SIZE[name])], regulatoryBasis: 'IN: registration on file' };
  await w.authorise(def);
  const kind = name === 'tablet-blister-packaging' ? 'PACKAGING' : 'PROCESSING';
  await w.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({
        rule_code: `R-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: kind,
        format: kind === 'PACKAGING' ? '{PARENT}/P{SEQ:2}' : 'L{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3',
      }),
    ]),
  );
  return { familyId: v.familyId, product: content.header.product.code };
}

async function plan(batchId: string, def: Partial<execution.GmpBatchPlan> & { familyId: string; batchSize: string }): Promise<execution.PlannedGmpBatch> {
  const erpOrder = def.erpOrder ?? (await familyOrder(db, erp, def.familyId, def.batchSize));
  return withProtectedNumbers(db.app, await cmd(db, w.cast.issuer), ledger, (c) => execution.prepareGmpIssue(c, batchId, { markets: ['IN'], site: SITE, line: 'L1', ...def, erpOrder }));
}

async function issue(batchId: string, name: Fixture): Promise<void> {
  const signatureId = await w.sign(w.cast.issuer, 'batch_issue', batchId, 'ISSUED', 'PLANNED');
  await w.run(
    w.cast.issuer,
    (c) =>
      execution.issueGmpBatch(c, {
        batchId,
        signatureId,
        define: (content) => define(content, { installation: 'GMP', justifications: FIXTURE_JUSTIFICATIONS, registry }),
        request: {
          inputs: FIXTURE_INPUTS[name],
          ...(name === 'tablet-blister-packaging' ? { variants: { packDestination: 'IN-DOMESTIC' } } : {}),
          issuedBy: { id: w.cast.issuer.personId, kind: 'PERSON', roles: [] },
        },
      }),
    reason('batch issued for the test'),
  );
}

/** Superuser arrangement with triggers off (containers, stored states: their own commands are proven elsewhere). */
async function arrange(sql: string, params: unknown[]): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    await c.query(sql, params);
    await c.query('commit');
  } finally {
    c.release();
  }
}

/** An output container of `batch` in `state`, closed `hoursAgo` hours ago with `net` kg (none: still open). */
async function container(batch: string, state: string, net: string | null = '25.000', hoursAgo = 0): Promise<{ id: string; label: string }> {
  const id = randomUUID();
  const [b] = await q<{ n: string; p: string; s: string }>("select batch_number as n, (recipe.batch_product(id) ->> 'code') as p, (recipe.batch_product(id) ->> 'strength') as s from recipe.batch_execution where id = $1", [batch]);
  const label = `OC-${b?.n ?? 'X'}-${String(1000 + Math.floor(Math.random() * 8999))}`;
  await arrange(
    `insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, quantity_unit, opened_by_person, opened_by_account)
     values ($1, $2, $3, $4, $5, $6, 'COMPRESSION', 'kg', $1, $1)`,
    [id, label, batch, b?.n, b?.p, b?.s],
  );
  if (net !== null) {
    await arrange(
      `insert into plant.container_close (container_id, net_quantity, person_id, account_id, basis, weighing, closed_at)
       values ($1, $2::numeric, $1, $1, 'WEIGHED', '{}'::jsonb, clock_timestamp() - make_interval(hours => $3::int))`,
      [id, net, hoursAgo],
    );
  }
  await arrange(
    "insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version) values ('output_container', $1, 'output_container', 1, $2, 3)",
    [id, net === null ? 'OPEN' : state],
  );
  return { id, label };
}

async function hPack(batch: string): Promise<void> {
  const inst = { key: 'H-PACK@', step: 'H-PACK', status: 'COMPLETED', disposition: { value: 'APPROVED', positive: true }, signatures: [{ id: randomUUID(), meaning: 'QA_HOLD_POINT', role: 'HOLD_POINT', valid: true }] };
  await arrange("update recipe.execution_state set state = jsonb_set(state, '{steps,H-PACK@}', $2::jsonb) where batch_id = $1", [batch, JSON.stringify(inst)]);
}

/** The execution status of a batch, as its engine would leave it (arranged). */
async function setStatus(batch: string, status: string): Promise<void> {
  await arrange('update recipe.execution_state set status = $2 where batch_id = $1', [batch, status]);
}

async function processingWithOrders(n: number): Promise<{ parent: string; orders: string[]; product: string }> {
  const proc = await master('tablet-granulation-compression');
  const pack = await master('tablet-blister-packaging', proc.product);
  const parent = randomUUID();
  await plan(parent, { familyId: proc.familyId, batchSize: SIZE['tablet-granulation-compression'] });
  await issue(parent, 'tablet-granulation-compression');
  await hPack(parent);
  const orders: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const order = randomUUID();
    await plan(order, { familyId: pack.familyId, batchSize: SIZE['tablet-blister-packaging'], parentBatch: parent });
    await issue(order, 'tablet-blister-packaging');
    orders.push(order);
  }
  return { parent, orders, product: proc.product };
}

const lockState = async (batch: string): Promise<string> => (await q<{ s: string }>('select recipe.record_lock_state($1) as s', [batch]))[0]!.s;
const closeBulk = (who: SeededActor, batch: string, why: string | null) => w.run(who, (c) => c.query('select recipe.close_bulk_reconciliation($1, $2)', [batch, why]));
const bulk = (who: SeededActor, order: string, labels: string[]) => w.run(who, (c) => containers.issuePackagingBulk(c, order, labels));

async function deviationOn(batch: string): Promise<string> {
  const d = await w.run(operator, async (c) =>
    (await c.query<{ r: { deviationId: string } }>('select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind: 'DEVIATION', title: 'Record or hold finding', classification: 'MINOR', riskRationale: 'Documentation finding; assessed by QA' }),
    ])).rows[0]!.r,
  );
  await w.run(operator, (c) => c.query("select site.link_deviation($1, 'BATCH', $2)", [d.deviationId, batch]));
  return d.deviationId;
}

/** QA classifies the deviation, records NONE for IN on each link and signs the impact: IMPACT_ASSESSED. */
async function assessed(deviationId: string): Promise<void> {
  const due = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 28)).toISOString().slice(0, 10);
  await w.run(qa, (c) => c.query('select site.start_deviation_investigation($1, $2::jsonb)', [deviationId, JSON.stringify({ classification: 'MINOR', riskRationale: 'QA classification after the first review', ownerPersonId: qa.personId, dueDate: due })]));
  const links = await q<{ id: string }>('select id from site.deviation_link where deviation_id = $1', [deviationId]);
  for (const l of links) {
    await w.run(qa, (c) => c.query('select site.record_deviation_impact($1, $2::jsonb)', [deviationId, JSON.stringify({ linkId: l.id, market: 'IN', impact: 'NONE', rationale: 'Assessed against the investigation' })]));
  }
  const sig = await signFor(db, qa2, { type: 'deviation', id: deviationId }, 'DEVIATION_IMPACT_ASSESSED', 'UNDER_INVESTIGATION');
  await w.run(qa2, (c) => c.query('select site.assess_deviation_impact($1, $2)', [deviationId, sig]));
}

/** A superuser's write past every definer: the lock trigger still refuses it. */
async function superuserWrite(sql: string, params: unknown[]): Promise<string> {
  return codeOf(db.admin.query(sql, params));
}

describe('bulk across packaging orders and the bulk reconciliation (PR-38, INV-21; recipe-core 0870, 0871)', () => {
  it('[PR-38][INV-27] the bulk of one processing batch is issued across several packaging orders, each container once, never more than produced: a container issued to one order is refused to another; a forged quantity is refused for every writer; the role writes none', async () => {
    const { parent, orders } = await processingWithOrders(2);
    const [o1, o2] = orders as [string, string];
    const a = await container(parent, 'RELEASED_BY_QA', '25.000');
    const b = await container(parent, 'RELEASED_BY_QA', '30.500');
    await bulk(operator, o1, [a.label]);
    await bulk(operator, o2, [b.label]);
    expect(await codeOf(bulk(operator, o2, [a.label]))).toBe('EBMR-PKG-005');
    expect(await q('select order_batch_id as o, quantity::text as q from recipe.packaging_bulk_issue where parent_batch_id = $1 order by quantity', [parent])).toEqual([
      { o: o1, q: '25.000' },
      { o: o2, q: '30.500' },
    ]);
    // A writer past the definer (a superuser) records a quantity other than the container's closed net: refused.
    const c = await container(parent, 'RELEASED_BY_QA', '10.000');
    const forged = await db.admin.connect();
    try {
      await forged.query('begin');
      await forged.query('select kernel.set_actor_context($1::jsonb)', [JSON.stringify({
        person_id: '00000000-0000-0000-0000-000000000000', account_id: '00000000-0000-0000-0000-000000000000', role_code: 'TEST_FIXTURE',
        session_id: '00000000-0000-0000-0000-000000000000', source: 'SYSTEM', site_zone: 'UTC', correlation_id: randomUUID(), legal_name: 'Test fixture',
        reason_code: 'TEST_FIXTURE', reason_text: 'a writer past the definers' })]);
      const ch = (await forged.query<{ id: string }>("insert into plant.container_charge (container_id, batch_id, stage, purpose, scanned_label, person_id, account_id) values ($1, $2, 'PACKAGING', 'PACK', 'x', $2, $2) returning id", [c.id, o1])).rows[0]!.id;
      expect(await codeOf(forged.query("insert into recipe.packaging_bulk_issue (order_batch_id, parent_batch_id, container_id, charge_id, quantity, unit, person_id, account_id) values ($1, $2, $3, $4, 99, 'kg', $1, $1)", [o1, parent, c.id, ch]))).toBe('EBMR-LCK-014');
    } finally {
      await forged.query('rollback');
      forged.release();
    }
    expect(await codeOf(db.app.query("insert into recipe.packaging_bulk_issue (order_batch_id, parent_batch_id, container_id, charge_id, quantity, unit, person_id, account_id) values ($1, $2, $3, gen_random_uuid(), 10, 'kg', $1, $1)", [o1, parent, c.id]))).toMatch(/permission denied/);
  });

  it('[INV-21][PR-38] the bulk reconciliation closes only with the batch complete, every packaging order closed, no container open and a reason for the bulk left; by production approval, never an operator or an administrator; it records produced, issued and left and locks the record once', async () => {
    const { parent, orders } = await processingWithOrders(2);
    const [o1, o2] = orders as [string, string];
    const a = await container(parent, 'RELEASED_BY_QA', '25.000');
    const left = await container(parent, 'RELEASED_BY_QA', '12.250');
    const open = await container(parent, 'OPEN', null);
    await bulk(operator, o1, [a.label]);
    expect(await codeOf(closeBulk(head, parent, 'Left over bulk held for review'))).toBe('EBMR-LCK-011');
    await setStatus(parent, 'EXECUTION_COMPLETE');
    const why = await closeBulk(head, parent, 'Left over bulk held for review').catch((e: Error) => e.message);
    expect(why).toMatch(/EBMR-LCK-011 .*packaging order .* is IN_PROGRESS|EBMR-LCK-011 .*packaging order .* is ISSUED/);
    expect(why).toContain(`container ${open.label} is still open`);
    await setStatus(o1, 'EXECUTION_COMPLETE');
    await setStatus(o2, 'CANCELLED');
    expect(await closeBulk(head, parent, 'x').catch((e: Error) => e.message)).toMatch(/EBMR-LCK-011 .*still open/);
    await arrange("insert into plant.container_close (container_id, net_quantity, person_id, account_id, basis, weighing) values ($1, 5, $1, $1, 'WEIGHED', '{}'::jsonb)", [open.id]);
    await arrange("update platform.aggregate_state set state = 'CLOSED' where aggregate_type = 'output_container' and aggregate_id = $1", [open.id]);
    expect(await codeOf(closeBulk(head, parent, 'short'))).toBe('EBMR-LCK-012');
    expect(await codeOf(closeBulk(operator, parent, 'Left over bulk held for review'))).toBe('EBMR-IAM-040');
    expect(await codeOf(closeBulk(admin, parent, 'Left over bulk held for review'))).toBe('EBMR-IAM-042');
    expect(await lockState(parent)).toBe('UNLOCKED');
    await closeBulk(head, parent, 'Left over bulk held for a later order under review');
    expect(await lockState(parent)).toBe('LOCKED');
    const [r] = await q<{ produced: unknown; issued: unknown; remaining: unknown; left: string[]; reason: string }>(
      'select produced, issued, remaining, array(select x from unnest(remaining_containers::text[]) x order by x collate "C") as left, remaining_held_reason as reason from recipe.bulk_reconciliation where batch_id = $1', [parent]);
    expect(r).toEqual({
      produced: [{ quantity: '42.250', unit: 'kg' }], issued: [{ quantity: '25.000', unit: 'kg' }], remaining: [{ quantity: '17.250', unit: 'kg' }],
      left: [left.id, open.id].sort(), reason: 'Left over bulk held for a later order under review',
    });
    expect(await q('select event, cause from recipe.record_lock_event where batch_id = $1', [parent])).toEqual([{ event: 'LOCKED', cause: 'BULK_RECONCILIATION_CLOSED' }]);
    expect(await closeBulk(head, parent, 'Left over bulk held again').catch((e: Error) => e.message)).toMatch(/EBMR-LCK-011 .*already closed/);
    // A packaging record locks at its lot's disposition, never by a bulk reconciliation.
    expect(await closeBulk(head, o1, 'Left over bulk held for review').catch((e: Error) => e.message)).toMatch(/EBMR-LCK-011 .*packaging record/);
  });

  it('[INV-21] a locked record refuses every write in the database: engine commands, entries and state, containers, closes and in-process checks, bulk issued from it and a new packaging order; for a superuser past the definers too; the role writes no lock', async () => {
    const { parent, orders } = await processingWithOrders(1);
    const [o1] = orders as [string];
    const a = await container(parent, 'RELEASED_BY_QA', '25.000');
    const spare = await container(parent, 'RELEASED_BY_QA', '20.000');
    await bulk(operator, o1, [a.label]);
    await setStatus(parent, 'EXECUTION_COMPLETE');
    await setStatus(o1, 'EXECUTION_COMPLETE');
    await closeBulk(head, parent, 'Left over bulk held for a later order under review');
    // The engine's append path: a command row, an event row, the state.
    expect(await superuserWrite("insert into recipe.execution_command (batch_id, seq, kind, command_id, command_type, command, command_hash, actor_person, actor_account, actor_role, source, session_id) values ($1, 999, 'COMMAND', $2, 'RECORD_ENTRY', '{}', repeat('0', 64), $1, $1, 'OPERATOR', 'UI', $1)", [parent, randomUUID()])).toBe('EBMR-LCK-001');
    expect(await superuserWrite("update recipe.execution_state set status = 'IN_PROGRESS' where batch_id = $1", [parent])).toBe('EBMR-LCK-001');
    // Containers, their closes and in-process checks, the bulk issued from it.
    expect(await superuserWrite("insert into plant.output_container (label_code, batch_id, batch_number, product_code, strength, stage, quantity_unit, opened_by_person, opened_by_account) select 'OC-' || batch_number || '-9999', id, batch_number, 'P', '1 mg', 'COMPRESSION', 'kg', id, id from recipe.batch_execution where id = $1", [parent])).toBe('EBMR-LCK-001');
    expect(await superuserWrite('delete from plant.container_close where container_id = $1', [spare.id])).toBe('EBMR-LCK-001');
    const o2 = randomUUID();
    const proc = (await q<{ f: string }>('select family_id as f from recipe.stub_batch where id = $1', [o1]))[0]!.f;
    expect(await plan(o2, { familyId: proc, batchSize: SIZE['tablet-blister-packaging'], parentBatch: parent }).catch((e: Error) => e.message)).toMatch(/EBMR-LCK-001 .* is LOCKED: .*a new packaging order of its bulk/);
    expect(await codeOf(bulk(operator, o1, [spare.label]))).toMatch(/EBMR-PKG-001|EBMR-LCK-001/);
    expect(await superuserWrite("insert into recipe.packaging_bulk_issue (order_batch_id, parent_batch_id, container_id, charge_id, quantity, unit, person_id, account_id) values ($1, $2, $3, gen_random_uuid(), 20, 'kg', $1, $1)", [o1, parent, spare.id])).toBe('EBMR-LCK-001');
    // The role writes no lock and calls no internal lock function.
    expect(await codeOf(db.app.query("insert into recipe.record_lock_event (batch_id, seq, event, amendment_id, person_id, account_id) values ($1, 2, 'AMENDMENT_CLOSED', gen_random_uuid(), $1, $1)", [parent]))).toMatch(/permission denied/);
    expect(await codeOf(db.app.query("select recipe.record_lock_append($1, 'AMENDMENT_CLOSED', null, null, gen_random_uuid(), $1, $1)", [parent]))).toMatch(/permission denied/);
    expect(await superuserWrite('delete from recipe.record_lock_event where batch_id = $1', [parent])).not.toBe('ok');
    expect(await lockState(parent)).toBe('LOCKED');
  });
});

describe('the amendment of a locked record (INV-21, R-04; recipe-core 0872)', () => {
  async function lockedProcessing(): Promise<string> {
    const { parent, orders } = await processingWithOrders(1);
    await setStatus(parent, 'EXECUTION_COMPLETE');
    await setStatus(orders[0]!, 'CANCELLED');
    await closeBulk(head, parent, null);
    return parent;
  }
  const openId = async (batch: string, kind: string, basis: string): Promise<string> => (await q<{ a: string }>("select recipe.record_lock_next_id($1, 'OPEN', $2, $3) as a", [batch, kind, basis]))[0]!.a;
  const closeId = async (batch: string): Promise<string> => (await q<{ a: string }>("select recipe.record_lock_next_id($1, 'CLOSE', null, null) as a", [batch]))[0]!.a;
  const open = (who: SeededActor, batch: string, kind: string, basis: string, sig: string, text = 'Untranscribed check found at review') =>
    w.run(who, (c) => c.query("select recipe.open_record_amendment($1, $2, $3, 'LATE_ENTRY', $4, $5)", [batch, kind, basis, text, sig]));
  const entry = (who: SeededActor, batch: string, n: number, kind = 'LATE_ENTRY') =>
    w.run(who, (c) => c.query("select recipe.append_amendment_entry($1, $2, $3, 'Step s-blend: blend time', 'Blend time read from the paper log', '12 min', 'Transcribed from paper log PL-7 under the deviation')", [batch, n, kind]));
  const close = (who: SeededActor, batch: string, n: number, sig: string) =>
    w.run(who, (c) => c.query("select recipe.close_record_amendment($1, $2, 'The late entry restores the record; no product impact', $3)", [batch, n, sig]));

  it('[INV-21][R-04] QA opens an amendment of a LOCKED record only, under an open deviation linked to it or a change record, with a reason and its own AMENDMENT_OPENED signature; never an operator or an administrator, never on an unlocked record', async () => {
    const batch = await lockedProcessing();
    const unlocked = (await processingWithOrders(0)).parent;
    const dev = await deviationOn(batch);
    const otherDev = await deviationOn(unlocked);
    const fake = randomUUID();
    expect(await codeOf(open(qa, unlocked, 'DEVIATION', otherDev, fake))).toBe('EBMR-LCK-031');
    expect(await codeOf(open(qa, batch, 'DEVIATION', otherDev, fake))).toBe('EBMR-LCK-033');
    expect(await codeOf(open(qa, batch, 'COMPLAINT', dev, fake))).toBe('EBMR-LCK-032');
    expect(await codeOf(open(qa, batch, 'CHANGE_RECORD', randomUUID(), fake))).toBe('EBMR-LCK-032');
    expect(await codeOf(open(qa, batch, 'DEVIATION', dev, fake, 'short'))).toBe('EBMR-LCK-034');
    expect(await codeOf(open(operator, batch, 'DEVIATION', dev, fake))).toBe('EBMR-IAM-040');
    expect(await codeOf(open(admin, batch, 'DEVIATION', dev, fake))).toBe('EBMR-IAM-042');
    const aid = await openId(batch, 'DEVIATION', dev);
    expect(aid).toBe(`${batch}/1/OPEN/DEVIATION/${dev}`);
    const sig = await signFor(db, qa, { type: 'record_lock', id: aid }, 'AMENDMENT_OPENED', 'LOCKED');
    // Another QA person cannot record the signature of the first (DI-14).
    expect(await codeOf(open(qa2, batch, 'DEVIATION', dev, sig))).toBe('EBMR-REL-013');
    await open(qa, batch, 'DEVIATION', dev, sig);
    expect(await lockState(batch)).toBe('UNDER_AMENDMENT');
    expect(await q('select number, basis_kind, deviation_id, suspended_lots::text from recipe.record_amendment where batch_id = $1', [batch])).toEqual([{ number: 1, basis_kind: 'DEVIATION', deviation_id: dev, suspended_lots: '{}' }]);
    expect(await q('select count(*)::int as n from recipe.amendment_market_task where batch_id = $1', [batch])).toEqual([{ n: 0 }]);
    // One amendment open at a time; the record is still not written by its own paths.
    expect(await codeOf(open(qa, batch, 'DEVIATION', dev, fake))).toBe('EBMR-LCK-031');
    expect(await superuserWrite("update recipe.execution_state set status = 'IN_PROGRESS' where batch_id = $1", [batch])).toBe('EBMR-LCK-001');
    // A change record is a basis too (on another locked record).
    const other = await lockedProcessing();
    const cr = (await q<{ id: string }>('select id from recipe.change_record order by recorded_at limit 1'))[0]!.id;
    const crSig = await signFor(db, qa2, { type: 'record_lock', id: await openId(other, 'CHANGE_RECORD', cr) }, 'AMENDMENT_OPENED', 'LOCKED');
    await open(qa2, other, 'CHANGE_RECORD', cr, crSig);
    expect(await lockState(other)).toBe('UNDER_AMENDMENT');
  });

  it('[INV-21] the amendment appends numbered entries, never edits; production appends them (never an operator or an administrator); QA closes it with AMENDMENT_CLOSED over the entries as they stand, by a person who appended none: the record is LOCKED again', async () => {
    const batch = await lockedProcessing();
    const dev = await deviationOn(batch);
    const sig = await signFor(db, qa, { type: 'record_lock', id: await openId(batch, 'DEVIATION', dev) }, 'AMENDMENT_OPENED', 'LOCKED');
    await open(qa, batch, 'DEVIATION', dev, sig);
    expect(await codeOf(entry(head, batch, 2))).toBe('EBMR-LCK-040');
    expect(await codeOf(entry(operator, batch, 1))).toBe('EBMR-IAM-040');
    expect(await codeOf(entry(head, batch, 1, 'EDIT'))).toBe('EBMR-LCK-041');
    expect(await codeOf(entry(admin, batch, 1))).toBe('EBMR-IAM-042');
    await entry(head, batch, 1);
    expect(await q('select seq, kind, value, role_code from recipe.record_amendment_entry where batch_id = $1', [batch])).toEqual([{ seq: 1, kind: 'LATE_ENTRY', value: '12 min', role_code: 'HEAD_OF_PRODUCTION' }]);
    expect(await superuserWrite("update recipe.record_amendment_entry set value = '15 min' where batch_id = $1", [batch])).not.toBe('ok');
    expect(await codeOf(db.app.query("insert into recipe.record_amendment_entry (amendment_id, batch_id, seq, kind, target, body, reason, person_id, account_id) select id, batch_id, 9, 'NOTE', 't', 'b', 'reason text here', batch_id, batch_id from recipe.record_amendment where batch_id = $1", [batch]))).toMatch(/permission denied/);
    const cid = await closeId(batch);
    expect(cid).toBe(`${batch}/1/CLOSE`);
    const stale = await signFor(db, qa2, { type: 'record_lock', id: cid }, 'AMENDMENT_CLOSED', 'UNDER_AMENDMENT');
    await entry(head, batch, 1, 'NOTE');
    expect(await close(qa2, batch, 1, stale).catch((e: Error) => e.message)).toMatch(/EBMR-REL-013 signature .* is CONTENT_MISMATCH/);
    expect(await codeOf(close(operator, batch, 1, stale))).toBe('EBMR-IAM-040');
    expect(await lockState(batch)).toBe('UNDER_AMENDMENT');
    // (In the ceremony a refused act rolls its signature back; here the stale one stays, so another QA person signs.)
    const fresh = await signFor(db, qa, { type: 'record_lock', id: cid }, 'AMENDMENT_CLOSED', 'UNDER_AMENDMENT');
    await close(qa, batch, 1, fresh);
    expect(await lockState(batch)).toBe('LOCKED');
    expect(await q('select event from recipe.record_lock_event where batch_id = $1 order by seq', [batch])).toEqual([{ event: 'LOCKED' }, { event: 'AMENDMENT_OPENED' }, { event: 'AMENDMENT_CLOSED' }]);
    expect(await codeOf(entry(head, batch, 1))).toBe('EBMR-LCK-040');
    expect(await superuserWrite("update recipe.execution_state set status = 'IN_PROGRESS' where batch_id = $1", [batch])).toBe('EBMR-LCK-001');
    // The next amendment is number 2.
    expect(await openId(batch, 'DEVIATION', dev)).toBe(`${batch}/2/OPEN/DEVIATION/${dev}`);
  });
});

describe('the maximum hold of bright stock (PR-38; recipe-core 0871)', () => {
  it('[PR-38] master data sets the product\'s maximum hold (a whole number of hours, with a reason; never an operator or an administrator); bulk past it is not issued until a deviation linked to the order is assessed by QA; no maximum set checks none; packaging start reads the same rule', async () => {
    const { parent, orders, product } = await processingWithOrders(2);
    const [o1, o2] = orders as [string, string];
    const strength = (await q<{ s: string }>("select recipe.batch_product($1) ->> 'strength' as s", [parent]))[0]!.s;
    const set = (who: SeededActor, hours: number | null, why = 'Hold study HS-01: sealed drums') => w.run(who, (c) => c.query('select recipe.set_bright_stock_hold($1, $2, $3, $4)', [product, strength, hours, why]));
    const old = await container(parent, 'RELEASED_BY_QA', '20.000', 50);
    const older = await container(parent, 'RELEASED_BY_QA', '20.000', 60);
    const fresh = await container(parent, 'RELEASED_BY_QA', '20.000', 1);
    // No maximum set: none is checked (D-5b-2).
    await bulk(operator, o2, [older.label]);
    expect(await q('select recipe.bright_stock_hold_problem($1) as p', [o2])).toEqual([{ p: null }]);
    expect(await codeOf(set(operator, 24))).toBe('EBMR-IAM-040');
    expect(await codeOf(set(admin, 24))).toBe('EBMR-IAM-042');
    expect(await codeOf(set(steward, 0))).toBe('EBMR-LCK-020');
    expect(await codeOf(set(steward, 24, 'short'))).toBe('EBMR-LCK-020');
    await set(steward, 24);
    expect(await q('select max_hold_hours from recipe.bright_stock_max_hold where product_code = $1', [product])).toEqual([{ max_hold_hours: 24 }]);
    expect(await bulk(operator, o1, [old.label]).catch((e: Error) => e.message)).toMatch(/EBMR-PKG-006 container .* closed 50 hours ago, past the maximum hold of 24 hours/);
    await bulk(operator, o1, [fresh.label]);
    // Packaging start (tablets 1190 reads it): the order holding bulk past the hold has a problem now.
    expect((await q<{ p: string | null }>('select recipe.bright_stock_hold_problem($1) as p', [o2]))[0]!.p).toMatch(/past the maximum hold of 24 hours/);
    expect(await q('select recipe.bright_stock_hold_problem($1) as p', [o1])).toEqual([{ p: null }]);
    // A deviation linked to the order and still open does not cover it; once QA assessed it, it does.
    const dev = await deviationOn(o1);
    expect(await codeOf(bulk(operator, o1, [old.label]))).toBe('EBMR-PKG-006');
    await assessed(dev);
    await bulk(operator, o1, [old.label]);
    expect(await q('select count(*)::int as n from recipe.packaging_bulk_issue where order_batch_id = $1', [o1])).toEqual([{ n: 2 }]);
    // The latest version wins.
    await set(steward, 100);
    expect(await q('select recipe.bright_stock_hold_problem($1) as p', [o2])).toEqual([{ p: null }]);
    expect(await codeOf(db.app.query("insert into recipe.bright_stock_max_hold (product_code, strength, max_hold_hours, reason, person_id, account_id) values ($1, $2, 9999, 'reason text here', $3, $3)", [product, strength, steward.personId]))).toMatch(/permission denied/);
  });
});
