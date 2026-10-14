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
import { withCommand } from '../../../kernel/src/db/command.ts';
import { tempDir, tempLedger } from '../../../kernel/test/continuity/helpers.ts';
import { cmd } from '../../../kernel/test/esig/helpers.ts';
import { signFor } from '../../../kernel/test/records/helpers.ts';
import { seedActor, seedAdministration, seedServiceActor, withReason, type SeededActor } from '../../../kernel/test/identity/seed.ts';
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
let owner: SeededActor;
const dir = tempDir('record-lock');
const ledger = tempLedger('record-lock', dir.path);

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
  ({ admin, owner } = await seedAdministration(db));
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
    const foreign = await container(o1, 'RELEASED_BY_QA', '10.000');
    const mergedAway = await container(parent, 'RELEASED_BY_QA', '10.000');
    await arrange('insert into plant.container_merge (source_id, target_id, person_id, account_id) values ($1, $2, $1, $1)', [mergedAway.id, c.id]);
    const forged = await db.admin.connect();
    try {
      await forged.query('begin');
      await forged.query('select kernel.set_actor_context($1::jsonb)', [JSON.stringify({
        person_id: '00000000-0000-0000-0000-000000000000', account_id: '00000000-0000-0000-0000-000000000000', role_code: 'TEST_FIXTURE',
        session_id: '00000000-0000-0000-0000-000000000000', source: 'SYSTEM', site_zone: 'UTC', correlation_id: randomUUID(), legal_name: 'Test fixture',
        reason_code: 'TEST_FIXTURE', reason_text: 'a writer past the definers' })]);
      const ch = (await forged.query<{ id: string }>("insert into plant.container_charge (container_id, batch_id, stage, purpose, scanned_label, person_id, account_id) values ($1, $2, 'PACKAGING', 'PACK', 'x', $2, $2) returning id", [c.id, o1])).rows[0]!.id;
      const tryIssue = async (containerId: string, quantity: string, unit: string): Promise<string> => {
        await forged.query('savepoint forged');
        try {
          return await codeOf(forged.query('insert into recipe.packaging_bulk_issue (order_batch_id, parent_batch_id, container_id, charge_id, quantity, unit, person_id, account_id) values ($1, $2, $3, $4, $5, $6, $1, $1)',
            [o1, parent, containerId, ch, quantity, unit]));
        } finally {
          await forged.query('rollback to savepoint forged');
        }
      };
      expect(await tryIssue(c.id, '99', 'kg')).toBe('EBMR-LCK-014');
      // Nor its net in another unit, nor a container of another batch at its own net.
      expect(await tryIssue(c.id, '10', 'g')).toBe('EBMR-LCK-014');
      expect(await tryIssue(foreign.id, '10', 'kg')).toBe('EBMR-LCK-014');
      // Its own net in its unit passes this check.
      expect(await tryIssue(c.id, '10', 'kg')).toBe('ok');
      // A container merged into another is no longer produced bulk of its own: issuing it too would issue more than the batch
      // produced (PR-38).
      await forged.query('savepoint merged');
      await forged.query("insert into recipe.packaging_bulk_issue (order_batch_id, parent_batch_id, container_id, charge_id, quantity, unit, person_id, account_id) values ($1, $2, $3, $4, 10, 'kg', $1, $1)", [o1, parent, c.id, ch]);
      const ch2 = (await forged.query<{ id: string }>("insert into plant.container_charge (container_id, batch_id, stage, purpose, scanned_label, person_id, account_id) values ($1, $2, 'PACKAGING', 'PACK', 'x', $2, $2) returning id", [mergedAway.id, o1])).rows[0]!.id;
      expect(await codeOf(forged.query("insert into recipe.packaging_bulk_issue (order_batch_id, parent_batch_id, container_id, charge_id, quantity, unit, person_id, account_id) values ($1, $2, $3, $4, 10, 'kg', $1, $1)", [o1, parent, mergedAway.id, ch2])))
        .toBe('EBMR-LCK-015');
      await forged.query('rollback to savepoint merged');
    } finally {
      await forged.query('rollback');
      forged.release();
    }
    expect(await codeOf(db.app.query("insert into recipe.packaging_bulk_issue (order_batch_id, parent_batch_id, container_id, charge_id, quantity, unit, person_id, account_id) values ($1, $2, $3, gen_random_uuid(), 10, 'kg', $1, $1)", [o1, parent, c.id]))).toMatch(/permission denied/);
  }, 300_000);

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
  }, 300_000);

  it('[PR-38][INV-21] each container of the bulk is accounted for once: issued, merged, charged, open, rejected or left; the totals add only the closed nets of the dispositions asked; a packaging order still planned keeps the reconciliation open', async () => {
    const { parent, orders } = await processingWithOrders(1);
    const [o1] = orders as [string];
    const issued = await container(parent, 'RELEASED_BY_QA', '25.000');
    await bulk(operator, o1, [issued.label]);
    const merged = await container(parent, 'RELEASED_BY_QA', '3.000');
    const charged = await container(parent, 'RELEASED_BY_QA', '4.000');
    const open = await container(parent, 'OPEN', null);
    const rejected = await container(parent, 'REJECTED', '2.000');
    const left = await container(parent, 'RELEASED_BY_QA', '7.500');
    // TEST FIXTURE: a merge and a charge as plant's commands record them (proven in the container tests).
    await arrange('insert into plant.container_merge (source_id, target_id, person_id, account_id) values ($1, $2, $1, $1)', [merged.id, left.id]);
    await arrange("insert into plant.container_charge (container_id, batch_id, stage, purpose, scanned_label, person_id, account_id) values ($1, $2, 'BLENDING', 'CHARGE', 'x', $1, $1)", [charged.id, parent]);
    const disposition = async (id: string) => (await q<{ d: string }>('select recipe.bulk_container_disposition($1) as d', [id]))[0]!.d;
    expect([await disposition(issued.id), await disposition(merged.id), await disposition(charged.id), await disposition(open.id), await disposition(rejected.id), await disposition(left.id)])
      .toEqual(['ISSUED', 'MERGED', 'CHARGED', 'OPEN', 'REJECTED', 'LEFT']);
    const totals = async (d: string[]) => (await q<{ t: unknown }>('select recipe.bulk_totals($1, $2) as t', [parent, d]))[0]!.t;
    expect(await totals(['ISSUED', 'CHARGED', 'REJECTED', 'LEFT'])).toEqual([{ quantity: '38.500', unit: 'kg' }]);
    expect(await totals(['LEFT'])).toEqual([{ quantity: '7.500', unit: 'kg' }]);
    expect(await totals(['MERGED'])).toEqual([{ quantity: '3.000', unit: 'kg' }]);
    expect(await totals(['OPEN'])).toEqual([]);
    // Another batch's bulk is not this one's.
    const other = (await processingWithOrders(0)).parent;
    await container(other, 'RELEASED_BY_QA', '100.000');
    expect(await totals(['LEFT'])).toEqual([{ quantity: '7.500', unit: 'kg' }]);
    // A packaging order planned and not issued keeps the reconciliation open (its planned status), as an issued one does (its execution status).
    const planned = randomUUID();
    const fam = (await q<{ f: string }>('select family_id as f from recipe.stub_batch where id = $1', [o1]))[0]!.f;
    await plan(planned, { familyId: fam, batchSize: SIZE['tablet-blister-packaging'], parentBatch: parent });
    await setStatus(parent, 'EXECUTION_COMPLETE');
    const plannedNumber = (await q<{ n: string }>('select batch_number as n from recipe.stub_batch where id = $1', [planned]))[0]!.n;
    const o1Number = (await q<{ n: string }>('select batch_number as n from recipe.stub_batch where id = $1', [o1]))[0]!.n;
    const problems = (await q<{ p: string[] }>('select recipe.bulk_close_problems($1) as p', [parent]))[0]!.p.join(' | ');
    expect(problems).toContain(`packaging order ${plannedNumber} is PLANNED`);
    expect(problems).toMatch(new RegExp(`packaging order ${o1Number} is (ISSUED|IN_PROGRESS)`));
    expect(problems).toContain(`container ${open.label} is still open`);
    expect((await q<{ k: string }>('select recipe.batch_family_kind($1) as k', [planned]))[0]!.k).toBe('PACKAGING');
    expect((await q<{ k: string }>('select recipe.batch_family_kind($1) as k', [parent]))[0]!.k).toBe('PROCESSING');
    const none = randomUUID();
    expect((await q<{ p: string[] }>('select recipe.bulk_close_problems($1) as p', [none]))[0]!.p).toEqual([`${none} is no GMP batch`]);
    // Bulk goes only to a packaging order that is issued or running: not to one only planned, nor to one complete, nor to the processing batch itself.
    const toOrder = (order: string) => bulk(operator, order, [left.label]).catch((e: Error) => e.message);
    expect(await toOrder(planned)).toMatch(new RegExp(`EBMR-PKG-001 batch ${planned} is no issued GMP batch`));
    expect(await toOrder(parent)).toMatch(/EBMR-PKG-001 batch .* is no packaging order/);
    expect(await toOrder(randomUUID())).toMatch(/EBMR-PKG-001 batch .* is no issued GMP batch/);
    // The issue locks the container's state (a hold recorded concurrently is seen or waits): it waits for a transaction holding
    // that container's state, and not for one holding another container's.
    const spare = await container(parent, 'RELEASED_BY_QA', '1.000');
    const unrelated = await container(parent, 'RELEASED_BY_QA', '1.000');
    const issueWhileHeld = async (held: string, label: string): Promise<string> => {
      const holder = await db.admin.connect();
      try {
        await holder.query('begin');
        await holder.query("select 1 from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = $1 for update", [held]);
        return await w.run(operator, async (c) => {
          await c.query("set local lock_timeout = '1s'");
          await c.query('select recipe.issue_packaging_bulk($1, $2::text[])', [o1, [label]]);
          return 'issued';
        }).catch((e: Error & { code?: string }) => e.code ?? e.message);
      } finally {
        await holder.query('rollback');
        holder.release();
      }
    };
    expect(await issueWhileHeld(spare.id, spare.label)).toBe('55P03');
    expect(await issueWhileHeld(unrelated.id, spare.label)).toBe('issued');
    // The labels: one or more, each once, none missing.
    const labels = (l: (string | null)[] | null) => codeOf(w.run(operator, (c) => c.query('select recipe.issue_packaging_bulk($1, $2::text[])', [o1, l])));
    for (const l of [[], null, [left.label, left.label], [left.label, null]]) expect(await labels(l), JSON.stringify(l)).toBe('EBMR-PKG-003');
    await setStatus(o1, 'EXECUTION_COMPLETE');
    expect(await toOrder(o1)).toMatch(new RegExp(`EBMR-PKG-001 batch ${o1Number} is EXECUTION_COMPLETE`));
  }, 300_000);

  it('[INV-21][PR-38] the reconciliation closes with no reason when all the bulk went to packaging (none is kept then), with a reason of 10 characters when bulk is left; it serialises with the engine and the containers', async () => {
    const ready = async (): Promise<{ parent: string; o1: string; number: string }> => {
      const { parent, orders } = await processingWithOrders(1);
      const a = await container(parent, 'RELEASED_BY_QA', '25.000');
      await bulk(operator, orders[0]!, [a.label]);
      await setStatus(parent, 'EXECUTION_COMPLETE');
      await setStatus(orders[0]!, 'EXECUTION_COMPLETE');
      return { parent, o1: orders[0]!, number: (await q<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [parent]))[0]!.n };
    };
    expect(await codeOf(closeBulk(head, randomUUID(), null))).toBe('EBMR-LCK-010');
    const all = await ready();
    // The problems name this batch.
    const leftOpen = await container(all.parent, 'OPEN', null);
    expect(await closeBulk(head, all.parent, null).catch((e: Error) => e.message)).toMatch(new RegExp(`EBMR-LCK-011 the bulk reconciliation of batch ${all.number} cannot be closed: container ${leftOpen.label} is still open`));
    await arrange('delete from plant.output_container where id = $1', [leftOpen.id]);
    // Serialised: while another transaction holds the batch's engine state, or one of its containers, the closure waits.
    for (const lock of ['select 1 from recipe.execution_state where batch_id = $1 for update', 'select 1 from plant.output_container where batch_id = $1 for update']) {
      const holder = await db.admin.connect();
      try {
        await holder.query('begin');
        await holder.query(lock, [all.parent]);
        const waited = await w.run(head, async (c) => {
          await c.query("set local lock_timeout = '1s'");
          return c.query('select recipe.close_bulk_reconciliation($1, null)', [all.parent]);
        }).then(() => 'closed', (e: Error & { code?: string }) => e.code ?? e.message);
        expect(waited, lock).toBe('55P03');
      } finally {
        await holder.query('rollback');
        holder.release();
      }
    }
    await closeBulk(head, all.parent, null);
    expect(await q('select issued = produced as same, remaining, remaining_held_reason as reason from recipe.bulk_reconciliation where batch_id = $1', [all.parent])).toEqual([{ same: true, remaining: [], reason: null }]);
    const reasoned = await ready();
    await closeBulk(head, reasoned.parent, 'A reason given though nothing is left');
    expect(await q('select remaining_held_reason as reason from recipe.bulk_reconciliation where batch_id = $1', [reasoned.parent])).toEqual([{ reason: null }]);
    const left = await ready();
    await container(left.parent, 'RELEASED_BY_QA', '5.000');
    expect(await codeOf(closeBulk(head, left.parent, '123456789'))).toBe('EBMR-LCK-012');
    await closeBulk(head, left.parent, '1234567890');
    expect(await q('select remaining_held_reason as reason from recipe.bulk_reconciliation where batch_id = $1', [left.parent])).toEqual([{ reason: '1234567890' }]);
  }, 300_000);

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
  }, 300_000);
});

describe('who closes an amendment (INV-21; outline 7.2 S10; recipe-core 0872)', () => {
  it('[INV-21] a person who appended an entry does not close the amendment, even where the site lets one role do both (EBMR-LCK-043)', async () => {
    const both = await seedActor(db, { roleCode: 'STAGE_RESPONSIBLE', legalName: 'Bala Both' });
    const request = await withCommand(db.app, withReason(admin), async (c) =>
      (await c.query<{ id: string }>("select iam.add_role_permission('STAGE_RESPONSIBLE', 'RECORD.QA_REVIEW', 'the site lets the stage responsible review records') as id")).rows[0]!.id);
    await withCommand(db.app, withReason(owner), (c) => c.query("select iam.decide_role_permission($1, true, 'approved for the closing test')", [request]));
    const { parent, orders } = await processingWithOrders(1);
    await setStatus(parent, 'EXECUTION_COMPLETE');
    await setStatus(orders[0]!, 'CANCELLED');
    await closeBulk(head, parent, null);
    const dev = await deviationOn(parent);
    const aid = (await q<{ a: string }>("select recipe.record_lock_next_id($1, 'OPEN', 'DEVIATION', $2) as a", [parent, dev]))[0]!.a;
    const sig = await signFor(db, qa, { type: 'record_lock', id: aid }, 'AMENDMENT_OPENED', 'LOCKED');
    await w.run(qa, (c) => c.query("select recipe.open_record_amendment($1, 'DEVIATION', $2, 'LATE_ENTRY', 'Untranscribed check found at review', $3)", [parent, dev, sig]));
    await w.run(both, (c) => c.query("select recipe.append_amendment_entry($1, 1, 'NOTE', 'Step s-blend', 'Blend time read again', null, 'Read from the paper log PL-9')", [parent]));
    expect(await codeOf(w.run(both, (c) => c.query("select recipe.close_record_amendment($1, 1, 'The note restores the record; no impact', $2)", [parent, randomUUID()])))).toBe('EBMR-LCK-043');
    // Another person of that role passes this check (and meets the signature check next).
    const other = await seedActor(db, { roleCode: 'STAGE_RESPONSIBLE', legalName: 'Bina Other' });
    expect(await codeOf(w.run(other, (c) => c.query("select recipe.close_record_amendment($1, 1, 'The note restores the record; no impact', $2)", [parent, randomUUID()])))).toBe('EBMR-REL-013');
  }, 300_000);
});

describe('the lock at the first disposition (INV-21; D-5-7; recipe-core 0870)', () => {
  it('[INV-21] a manufacturer decision locks the record of the lot\'s own batch; a finished lot posted for a batch that is no record of this system locks nothing and is not refused', async () => {
    const warehouse = await seedActor(db, { roleCode: 'WAREHOUSE_LABELLING', legalName: 'Wasim Warehouse' });
    const ap = await seedActor(db, { roleCode: 'AUTHORISED_PERSON', legalName: 'Anita Authorised' });
    const { parent } = await processingWithOrders(0);
    const post = async (batchId: string, number: string) =>
      withCommand(db.admin, await cmd(db, warehouse), async (c) =>
        (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
          JSON.stringify({ batchId, batchNumber: number, edition: 'TABLETS', siteCode: SITE, productCode: 'LOCK-TEST', productName: 'Lock test product',
                           strength: '500 mg', markets: ['IN'], quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
        ])).rows[0]!.id);
    const number = (await q<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [parent]))[0]!.n;
    const own = await post(parent, number);
    const foreign = await post(randomUUID(), 'EXT-0042');
    // TEST FIXTURE: the decision rows as the release act writes them (proven in the release tests), every trigger on but the departments' notice.
    const decide = async (lotId: string) =>
      withCommand(db.admin, await cmd(db, ap), async (c) => {
        await c.query('alter table recipe.manufacturer_release_decision disable trigger zzzn_notify_departments');
        await c.query(`insert into recipe.manufacturer_release_decision (lot_id, decision, signature_id, epoch, checklist, checklist_hash, content_hash, person_id, account_id, role_code, correlation_id)
                       values ($1, 'RELEASED', gen_random_uuid(), repeat('0', 64), '{"items": []}', repeat('0', 64), 'fixture', $2, $3, 'AUTHORISED_PERSON', gen_random_uuid())`, [lotId, ap.personId, ap.accountId]);
        await c.query('alter table recipe.manufacturer_release_decision enable trigger zzzn_notify_departments');
      });
    await decide(foreign);
    await decide(own);
    expect(await q('select event, cause, lot_id from recipe.record_lock_event where batch_id = $1', [parent])).toEqual([{ event: 'LOCKED', cause: 'FIRST_DISPOSITION', lot_id: own }]);
    expect(await q('select count(*)::int as n from recipe.record_lock_event where lot_id = $1', [foreign])).toEqual([{ n: 0 }]);
  }, 180_000);
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
  type Content = { exists: boolean; state?: string; content?: Record<string, unknown>; involved?: string[] };
  const content = async (id: string): Promise<Content> => (await q<{ c: Content }>('select recipe.record_lock_content($1) as c', [id]))[0]!.c;
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
    expect(await codeOf(open(qa, randomUUID(), 'DEVIATION', dev, fake))).toBe('EBMR-LCK-030');
    // A deviation linked to a lot made from this record is a basis; one linked only to another lot is not.
    const poster = await seedActor(db, { roleCode: 'WAREHOUSE_LABELLING', legalName: 'Lata Labeller' });
    const lotOf = async (batchId: string, number: string) =>
      withCommand(db.admin, await cmd(db, poster), async (c) =>
        (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
          JSON.stringify({ batchId, batchNumber: number, edition: 'TABLETS', siteCode: SITE, productCode: 'LOCK-TEST', productName: 'Lock test product',
                           strength: '500 mg', markets: ['IN'], quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
        ])).rows[0]!.id);
    const lotDeviation = async (lotId: string): Promise<string> => {
      const d = await w.run(operator, async (c) => (await c.query<{ r: { deviationId: string } }>('select site.raise_deviation($1::jsonb) as r', [
        JSON.stringify({ kind: 'DEVIATION', title: 'Finding on a lot', classification: 'MINOR', riskRationale: 'Documentation finding; assessed by QA' }),
      ])).rows[0]!.r.deviationId);
      await w.run(operator, (c) => c.query("select site.link_deviation($1, 'LOT', $2)", [d, lotId]));
      return d;
    };
    const batchNumber = (await q<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [batch]))[0]!.n;
    expect(await codeOf(open(qa, batch, 'DEVIATION', await lotDeviation(await lotOf(randomUUID(), 'EXT-0043')), fake))).toBe('EBMR-LCK-033');
    expect(await codeOf(open(qa, batch, 'DEVIATION', await lotDeviation(await lotOf(batch, batchNumber)), fake))).toBe('EBMR-REL-013');
    // Only an open deviation is a basis: an unknown one, or one cancelled, is not.
    expect(await codeOf(open(qa, batch, 'DEVIATION', randomUUID(), fake))).toBe('EBMR-LCK-032');
    const cancelled = await deviationOn(batch);
    await w.run(qa, (c) => c.query('select site.cancel_deviation($1, $2)', [cancelled, 'raised against the wrong batch record']));
    expect(await codeOf(open(qa, batch, 'DEVIATION', cancelled, fake))).toBe('EBMR-LCK-032');
    expect(await codeOf(open(qa, batch, 'CHANGE_RECORD', null as unknown as string, fake))).toBe('EBMR-LCK-032');
    // The reason: a code of 1 to 64 characters and a text of at least 10; a valid one reaches the signature check (EBMR-REL-013).
    const reasoned = (code: string | null, text: string | null) =>
      codeOf(w.run(qa, (c) => c.query("select recipe.open_record_amendment($1, 'DEVIATION', $2, $3, $4, $5)", [batch, dev, code, text, fake])));
    expect(await reasoned('  ', 'Untranscribed check found at review')).toBe('EBMR-LCK-034');
    expect(await reasoned(null, 'Untranscribed check found at review')).toBe('EBMR-LCK-034');
    expect(await reasoned('X'.repeat(65), 'Untranscribed check found at review')).toBe('EBMR-LCK-034');
    expect(await reasoned('LATE_ENTRY', null)).toBe('EBMR-LCK-034');
    expect(await reasoned('LATE_ENTRY', '123456789')).toBe('EBMR-LCK-034');
    expect(await reasoned('X'.repeat(64), '1234567890')).toBe('EBMR-REL-013');
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
    const crId = await openId(other, 'CHANGE_RECORD', cr);
    expect(await content(crId)).toMatchObject({ exists: true, state: 'LOCKED', content: { act: 'AMENDMENT_OPEN', amendment_number: 1, basis: { kind: 'CHANGE_RECORD', id: cr }, lock_state: 'LOCKED' } });
    const crSig = await signFor(db, qa2, { type: 'record_lock', id: crId }, 'AMENDMENT_OPENED', 'LOCKED');
    await open(qa2, other, 'CHANGE_RECORD', cr, crSig);
    expect(await lockState(other)).toBe('UNDER_AMENDMENT');
    expect(await content(crId)).toMatchObject({ exists: true, state: 'RECORDED' });
    expect(await content(`${other}/1/OPEN/DEVIATION/${cr}`)).toEqual({ exists: false });
  }, 300_000);

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
    // The record QA signs to close it: the entries as they stand, the open amendment's state, the people who appended.
    expect(await content(cid)).toMatchObject({ exists: true, state: 'UNDER_AMENDMENT', involved: [head.personId],
                                              content: { act: 'AMENDMENT_CLOSE', amendment_number: 1, basis_kind: 'DEVIATION', basis_id: dev } });
    expect(((await content(cid)).content!['entries'] as unknown[]).length).toBe(1);
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
    // The next amendment is number 2; nothing is open to close.
    expect(await openId(batch, 'DEVIATION', dev)).toBe(`${batch}/2/OPEN/DEVIATION/${dev}`);
    expect(await closeId(batch)).toBeNull();
    // Amendment 2: each part of an entry is checked on its own, at its limits; the entries are numbered within their amendment.
    const sig2 = await signFor(db, qa, { type: 'record_lock', id: await openId(batch, 'DEVIATION', dev) }, 'AMENDMENT_OPENED', 'LOCKED');
    await open(qa, batch, 'DEVIATION', dev, sig2);
    const add = (b: string, kind: string | null, target: string | null, text: string | null, value: string | null, why: string | null) =>
      codeOf(w.run(head, (c) => c.query('select recipe.append_amendment_entry($1, 2, $2, $3, $4, $5, $6)', [b, kind, target, text, value, why])));
    const ok = ['NOTE', 'Step s-blend', 'Blend time read again', null, 'Read from the paper log'] as const;
    expect(await add(randomUUID(), ...ok)).toBe('EBMR-LCK-030');
    // The closed amendment 1 takes no entry while amendment 2 is open.
    expect(await codeOf(entry(head, batch, 1))).toBe('EBMR-LCK-040');
    for (const bad of [[null, ok[1], ok[2], ok[3], ok[4]], [ok[0], null, ok[2], ok[3], ok[4]], [ok[0], '  ', ok[2], ok[3], ok[4]], [ok[0], 'x'.repeat(201), ok[2], ok[3], ok[4]],
                       [ok[0], ok[1], null, ok[3], ok[4]], [ok[0], ok[1], '  ', ok[3], ok[4]], [ok[0], ok[1], 'x'.repeat(4001), ok[3], ok[4]],
                       [ok[0], ok[1], ok[2], '  ', ok[4]], [ok[0], ok[1], ok[2], 'x'.repeat(201), ok[4]], [ok[0], ok[1], ok[2], ok[3], null], [ok[0], ok[1], ok[2], ok[3], '123456789']] as [string | null, string | null, string | null, string | null, string | null][]) {
      expect(await add(batch, ...bad), JSON.stringify(bad).slice(0, 80)).toBe('EBMR-LCK-041');
    }
    for (const good of [[ok[0], 'x'.repeat(200), ok[2], ok[3], ok[4]], [ok[0], ok[1], 'x'.repeat(4000), ok[3], ok[4]], [ok[0], ok[1], ok[2], 'x'.repeat(200), ok[4]],
                        [ok[0], ok[1], ok[2], ok[3], '1234567890']] as [string, string, string, string | null, string][]) {
      expect(await add(batch, ...good)).toBe('ok');
    }
    expect(await q('select seq from recipe.record_amendment_entry where batch_id = $1 and amendment_id = (select id from recipe.record_amendment where batch_id = $1 and number = 2) order by seq', [batch]))
      .toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]);
    // The closing statement: at least 10 characters; a valid one reaches the signature check.
    const closeWith = (statement: string | null) => codeOf(w.run(qa2, (c) => c.query('select recipe.close_record_amendment($1, 2, $2, $3)', [batch, statement, randomUUID()])));
    expect(await closeWith(null)).toBe('EBMR-LCK-042');
    expect(await closeWith('123456789')).toBe('EBMR-LCK-042');
    expect(await closeWith('1234567890')).toBe('EBMR-REL-013');
    expect(await codeOf(w.run(qa2, (c) => c.query("select recipe.close_record_amendment($1, 2, 'A statement long enough', $2)", [randomUUID(), randomUUID()])))).toBe('EBMR-LCK-030');
    expect(await codeOf(w.run(qa2, (c) => c.query("select recipe.close_record_amendment($1, 1, 'A statement long enough', $2)", [batch, randomUUID()])))).toBe('EBMR-LCK-040');
    // Appending and closing take the record's row lock (entries are numbered under it): while another transaction holds the
    // record, both wait for it.
    const holder = await db.admin.connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from recipe.batch_execution where id = $1 for update', [batch]);
      const waits = (who: SeededActor, sql: string) =>
        w.run(who, async (c) => {
          await c.query("set local lock_timeout = '1s'");
          return c.query(sql, [batch, randomUUID()]);
        }).then(() => 'ran', (e: Error & { code?: string }) => e.code ?? e.message);
      expect(await waits(head, "select recipe.append_amendment_entry($1, 2, 'NOTE', 'Step s-blend', 'Blend time read again', null, 'Read from the paper log') where $2::uuid is not null")).toBe('55P03');
      expect(await waits(qa2, "select recipe.close_record_amendment($1, 2, 'A statement long enough', $2)")).toBe('55P03');
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    // The records as signed stay readable; a number, act or basis that is not the record's is none.
    expect(await content(`${batch}/1/OPEN/DEVIATION/${dev}`)).toMatchObject({ exists: true, state: 'RECORDED', content: { amendment_number: 1 } });
    expect(await content(`${batch}/1/CLOSE`)).toMatchObject({ exists: true, state: 'RECORDED' });
    expect(await content(`${batch}/2/OPEN/DEVIATION/${dev}`)).toMatchObject({ exists: true, state: 'RECORDED', content: { amendment_number: 2, basis: { kind: 'DEVIATION', id: dev } } });
    expect(await content(`${batch}/3/OPEN/DEVIATION/${dev}`)).toMatchObject({ exists: true, state: 'UNDER_AMENDMENT', content: { amendment_number: 3 } });
    for (const id of [`${batch}/1/OPEN/DEVIATION/${randomUUID()}`, `${batch}/1/OPEN/CHANGE_RECORD/${dev}`, `${batch}/1/OPEN`, `${batch}/1/CLOSE/DEVIATION/${dev}`,
                      `${batch}/3/CLOSE`, `${batch}/4/OPEN/DEVIATION/${dev}`, `${randomUUID()}/1/CLOSE`, `${batch}/3/OPEN/DEVIATION/${randomUUID()}`]) {
      expect(await content(id), id).toEqual({ exists: false });
    }
  }, 300_000);
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
    // Each part on its own, at its limits.
    const hold = (p: string | null, st: string | null, h: number | null, why: string | null) =>
      codeOf(w.run(steward, (c) => c.query('select recipe.set_bright_stock_hold($1, $2, $3, $4)', [p, st, h, why])));
    for (const bad of [[null, '1 mg', 24, 'Hold study HS-09'], ['lower-case', '1 mg', 24, 'Hold study HS-09'], ['HOLD-LIMITS', null, 24, 'Hold study HS-09'],
                       ['HOLD-LIMITS', '   ', 24, 'Hold study HS-09'], ['HOLD-LIMITS', 'x'.repeat(65), 24, 'Hold study HS-09'], ['HOLD-LIMITS', '1 mg', null, 'Hold study HS-09'],
                       ['HOLD-LIMITS', '1 mg', 100000, 'Hold study HS-09'], ['HOLD-LIMITS', '1 mg', 24, null], ['HOLD-LIMITS', '1 mg', 24, '123456789']] as [string | null, string | null, number | null, string | null][]) {
      expect(await hold(...bad), JSON.stringify(bad).slice(0, 60)).toBe('EBMR-LCK-020');
    }
    for (const good of [['HOLD-LIMITS', 'x'.repeat(64), 1, '1234567890'], ['HOLD-LIMITS', '1 mg', 99999, 'Hold study HS-09']] as [string, string, number, string][]) {
      expect(await hold(...good)).toBe('ok');
    }
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
    // The role kept with the act is the actor's own (DI-22): even a writer past the definer cannot claim another; none given, it is filled.
    const holdAs = async (role: string | null): Promise<string> =>
      withCommand(db.admin, await cmd(db, steward), async (c) =>
        (await c.query<{ r: string }>("insert into recipe.bright_stock_max_hold (product_code, strength, max_hold_hours, reason, person_id, account_id, role_code) values ('HOLD-ROLE', '1 mg', 10, 'role test of the hold', $1, $2, $3) returning role_code as r",
          [steward.personId, steward.accountId, role])).rows[0]!.r).catch((e: Error) => e.message);
    expect(await holdAs('HEAD_OF_PRODUCTION')).toMatch(/EBMR-LCK-060/);
    expect(await holdAs('MASTER_DATA_STEWARD')).toBe('MASTER_DATA_STEWARD');
    expect(await holdAs(null)).toBe('MASTER_DATA_STEWARD');
    // A deviation linked to the held container covers it once assessed (the link carries the container's batch); one linked to
    // a container of another batch does not.
    const onContainer = async (containerId: string): Promise<string> => {
      const d = await w.run(operator, async (c) => (await c.query<{ r: { deviationId: string } }>('select site.raise_deviation($1::jsonb) as r', [
        JSON.stringify({ kind: 'DEVIATION', title: 'Bulk held past its maximum', classification: 'MINOR', riskRationale: 'Hold assessed by QA' }),
      ])).rows[0]!.r.deviationId);
      await w.run(operator, (c) => c.query("select site.link_deviation($1, 'CONTAINER', $2)", [d, containerId]));
      await assessed(d);
      return d;
    };
    const elsewhere = await container((await processingWithOrders(0)).parent, 'RELEASED_BY_QA', '20.000', 1);
    await onContainer(elsewhere.id);
    expect((await q<{ p: string | null }>('select recipe.bright_stock_hold_problem($1) as p', [o2]))[0]!.p).toMatch(/past the maximum hold of 24 hours/);
    const covering = await onContainer(older.id);
    expect(await q('select batch_id from site.deviation_link where deviation_id = $1', [covering])).toEqual([{ batch_id: parent }]);
    expect(await q('select recipe.bright_stock_hold_problem($1) as p', [o2])).toEqual([{ p: null }]);
    // The latest version wins.
    await set(steward, 100);
    expect(await q('select recipe.bright_stock_hold_problem($1) as p', [o2])).toEqual([{ p: null }]);
    // A hold of another product of the same strength is not this product's.
    await w.run(steward, (c) => c.query('select recipe.set_bright_stock_hold($1, $2, 1, $3)', ['OTHER-HOLD', strength, 'Hold study HS-10 of another product']));
    expect(await q('select recipe.bright_stock_max_hold_of($1, $2) as h', [product, strength])).toEqual([{ h: 100 }]);
    expect(await q('select recipe.bright_stock_hold_problem($1) as p', [o2])).toEqual([{ p: null }]);
    expect(await codeOf(db.app.query("insert into recipe.bright_stock_max_hold (product_code, strength, max_hold_hours, reason, person_id, account_id) values ($1, $2, 9999, 'reason text here', $3, $3)", [product, strength, steward.personId]))).toMatch(/permission denied/);
  }, 180_000);
});
