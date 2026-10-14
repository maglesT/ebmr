/**
 * Exit review HIGH-3 on the GMP installation (tablets 1102; recipe-core 0701): a packing step runs only on bulk issued
 * to its batch. Bulk is issued only to a packaging order whose processing batch QA released for packing (H-PACK), from
 * its usable containers (recipe-core test/lifecycle/packaging-issue.test.ts proves the issue). So the first entry of a
 * TB-24 step, as of a TB-23 step and a TB-21 run start, is refused in a GMP batch with no bulk issued: here a processing
 * batch, which can never take bulk. Run as the application role through the routes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { routes } from '@ebmr/api-contract';
import { toDbContext } from '@ebmr/kernel';
import { freshTap, openPersonaSession } from '@ebmr/test-kit';
import { personaIn, tapFor } from '../../esig/support.ts';
import { refusalOf, RunDriver } from '../../execution/support.ts';
import { gmpContent, startGmpBatchWorld, type GmpBatchWorld } from '../../support/gmp-world.ts';
import { asSetup } from '../compression/plant-support.ts';
import { occupiedLine } from '../blister/db-support.ts';
import { ARTWORK_SET, G21_CONFIG } from './db-support.ts';

type Json = Record<string, unknown>;
let w: GmpBatchWorld;

const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };
const phase = (id: string, type: string, config: Json): Json => ({
  kind: 'phase', id, name: `Packing step ${id}`, block: { type, version: '1' }, config,
  records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [], signatures: SIGNATURES, significant: true, riskClass: 'HIGH',
});

/** dc-mini as a GMP master with, first in its dispensing preparation, a G-21 step and a TB-24 cartoning step beside it. */
const content = () =>
  gmpContent((m) => {
    (m['header'] as Json)['marketSet'] = ['IN', 'US'];
    const stage = ((((m['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
    const prep = ((stage['children'] as Json[])[0] as Json)['body'] as Json;
    const tb24 = phase('p-tb24', 'TB-24', {
      unit: 'TEST-LINE-CTN-H3', devices: [{ id: 'CW', kind: 'CHECKWEIGHER' }], examination: { every: { value: '1', unit: 'h' }, inRunSample: '5', endSample: '20' },
      cartonsPerShipper: '20', ssccPrefix: '089012345', printedStep: 'p-g21',
    });
    prep['children'] = [
      { kind: 'parallel', id: 'par-pack', branches: [{ id: 'br-g21', name: 'Printed materials', body: phase('p-g21', 'G-21', G21_CONFIG) }, { id: 'br-tb24', name: 'Cartoning', body: tb24 },
          { id: 'br-destroy', name: 'Coded surplus', body: { ...phase('p-destroy', 'G-23', {}), signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } } } }] },
      ...(prep['children'] as Json[]),
    ];
  });

beforeAll(async () => {
  w = await startGmpBatchWorld(content());
  vi.useFakeTimers({ toFake: ['performance'] });
  // The cartoning line's PROCESS unit (arranged, clean and qualified; the plant commands are proven in recipe-core).
  await asSetup(w.gmp, `insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, recorded_by)
                        values ('CL-LINE-H3', 'PROCESS', 'Cartoning line (test)', interval '72 hours', interval '48 hours', false, gen_random_uuid())`);
  await asSetup(w.gmp, "insert into plant.equipment (code, name, class_code, kind, recorded_by) values ('TEST-LINE-CTN-H3', 'Cartoning line', 'CL-LINE-H3', 'PROCESS', gen_random_uuid())");
}, 600_000);
afterAll(async () => {
  vi.useRealTimers();
  await w?.close();
});

describe('a packing step needs bulk issued to its batch (exit review HIGH-3; tablets 1102)', () => {
  it('[INV-27][IN-18][PR-37] on GMP the first entry of a cartoning step (TB-24) in a batch with no bulk issued is refused by the database (EBMR-TAB-395), and nothing is recorded', async () => {
    const issuer = await w.gmp.asPersona('issuer');
    const batchId = await w.issued(issuer);
    // The line runs this batch now, on a passed and verified clearance for it and its artwork set (arranged; tablets 0988).
    const batchNumber = (await w.gmp.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [batchId])).rows[0]?.n ?? '';
    await occupiedLine(w.gmp, batchId, 'TEST-LINE-CTN-H3', batchNumber, ARTWORK_SET);
    const d = new RunDriver(w.gmp, batchId, { operator1: await w.gmp.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb24@' });
    const before = await d.version('operator1');
    const r = await d.command('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-tb24@', entry: { kind: 'BLOCK_ENTRY', entryKind: 'CHALLENGE', data: { device: 'CW', trigger: 'START', result: 'PASS' } } });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(refusalOf(r))).toMatch(/EBMR-TAB-395/);
    expect(await d.version('operator1')).toBe(before);
    const { rows } = await w.gmp.db.admin.query<{ n: string }>("select count(*)::text as n from recipe.execution_state s, jsonb_each(s.state -> 'entries') e where s.batch_id = $1 and e.value ->> 'stepKey' = 'p-tb24@'", [batchId]);
    expect(rows[0]?.n).toBe('0');
    // Bulk is issued over HTTP only to a packaging order: this processing batch takes none (recipe-core 0701).
    const operator = d.browser('operator1');
    const body = { labels: [`OC-${batchNumber}-1001`] };
    vi.advanceTimersByTime(7_000);
    const tap = await tapFor(operator, personaIn(w.gmp, 'operator1'), 'POST', `/api/batches/${batchId}/bulk`, body);
    const refused = refusalOf(await operator.call(routes.batches.issueBulk, { params: { batchId }, body, attribution: tap }));
    expect([refused?.code, refused?.why]).toEqual(['EBMR-PKG-001', expect.stringMatching(/batch .* is no packaging order/)]);
  }, 300_000);

  it('[PR-38] packaging start (the first entry of a cartoning step) on bulk past the product\'s maximum hold for bright stock is refused by the database (EBMR-TAB-395); within the hold it is not', async () => {
    const issuer = await w.gmp.asPersona('issuer');
    const batchId = await w.issued(issuer);
    const [b] = (await w.gmp.db.admin.query<{ n: string; p: string; s: string }>("select batch_number as n, recipe.batch_product(id) ->> 'code' as p, recipe.batch_product(id) ->> 'strength' as s from recipe.batch_execution where id = $1", [batchId])).rows;
    await occupiedLine(w.gmp, batchId, 'TEST-LINE-CTN-H3', b!.n, ARTWORK_SET);
    // ARRANGED: bulk issued to the batch from a container closed 50 hours ago (the issue itself is proven in recipe-core), and
    // a maximum hold of 24 hours for the product (master data's act is proven there too).
    const container = randomUUID();
    await asSetup(w.gmp, `with c as (insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, quantity_unit, opened_by_person, opened_by_account)
                                     values ($1, 'OC-' || $2 || '-7001', gen_random_uuid(), $2, $3, $4, 'COMPRESSION', 'kg', $1, $1) returning id),
                               x as (insert into plant.container_close (container_id, net_quantity, person_id, account_id, basis, weighing, closed_at)
                                     select id, 25, id, id, 'WEIGHED', '{}'::jsonb, clock_timestamp() - interval '50 hours' from c returning container_id)
                          insert into recipe.packaging_bulk_issue (order_batch_id, parent_batch_id, container_id, charge_id, quantity, unit, person_id, account_id)
                          select $5, gen_random_uuid(), container_id, gen_random_uuid(), 25, 'kg', $1, $1 from x`, [container, b!.n, b!.p, b!.s, batchId]);
    const hold = (hours: number) => asSetup(w.gmp, "insert into recipe.bright_stock_max_hold (product_code, strength, max_hold_hours, reason, person_id, account_id) values ($1, $2, $3, 'Hold study for the test', gen_random_uuid(), gen_random_uuid())", [b!.p, b!.s, hours]);
    await hold(24);
    const d = new RunDriver(w.gmp, batchId, { operator1: await w.gmp.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-tb24@' });
    const entry = { type: 'RECORD_ENTRY', stepKey: 'p-tb24@', entry: { kind: 'BLOCK_ENTRY', entryKind: 'CHALLENGE', data: { device: 'CW', trigger: 'START', result: 'PASS' } } } as const;
    const before = await d.version('operator1');
    const r = await d.command('operator1', entry);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(refusalOf(r))).toMatch(/EBMR-TAB-395.*past its maximum hold.*maximum hold of 24 hours/);
    expect(await d.version('operator1')).toBe(before);
    // Which entries start packing (the check itself, asked directly with a content of one step of each kind): a TB-21 run
    // start, every one; the first entry of a TB-23 or TB-24 step; nothing else.
    const steps = { kind: 'sequence', children: [['s21', 'TB-21'], ['s24', 'TB-24'], ['s21b', 'G-21']].map(([id, type]) => ({ kind: 'phase', id, block: { type, version: '1' } })) };
    const ask = async (batch: string, old: Json, add: Json): Promise<string | null> =>
      (await w.gmp.db.admin.query<{ p: string | null }>('select tab.packaging_run_problem($1, $2::jsonb, $3::jsonb, $4::jsonb) as p', [
        batch, JSON.stringify({ procedure: steps }), JSON.stringify({ entries: old }), JSON.stringify({ entries: { ...old, ...add } }),
      ])).rows[0]!.p;
    const e = (stepKey: string, kind: string, seq: number): Json => ({ stepKey, kind, recordedSeq: seq });
    const past = /starts packing on bright stock past its maximum hold/;
    expect(await ask(batchId, {}, { n1: e('s21@', 'RUN_START', 1) })).toMatch(past);
    expect(await ask(batchId, { o1: e('s21@', 'RUN_START', 1) }, { n2: e('s21@', 'RUN_START', 2) })).toMatch(past);
    expect(await ask(batchId, {}, { n1: e('s21@', 'COUNT', 1) })).toBeNull();
    expect(await ask(batchId, {}, { n1: e('s21b@', 'RUN_START', 1) })).toBeNull();
    expect(await ask(batchId, {}, { n1: e('s24@', 'CHALLENGE', 1) })).toMatch(past);
    expect(await ask(batchId, { o1: e('s24@', 'CHALLENGE', 1) }, { n2: e('s24@', 'CHALLENGE', 2) })).toBeNull();
    expect(await ask(batchId, { o1: e('s21@', 'RUN_START', 1) }, {})).toBeNull();
    expect(await ask(randomUUID(), {}, { n1: e('s21@', 'RUN_START', 1) })).toMatch(/starts packing, and no bulk was issued to this batch/);
    // The latest version of the maximum wins: within 100 hours the line starts.
    await hold(100);
    const again = await d.command('operator1', entry);
    expect(again.ok).toBe(true);
  }, 300_000);

  it('[INV-27][IN-18] bulk is issued only to a batch that exists as an issued GMP batch', async () => {
    const actor = { ...(await openPersonaSession(w.gmp.db, w.gmp.seed, 'operator1')), authEventId: await freshTap(w.gmp.db, w.gmp.seed, 'operator1'), reasonCode: 'TEST', reasonText: 'bulk issue kill test' };
    const c = await w.gmp.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(actor))]);
      const unknown = randomUUID();
      await expect(c.query('select recipe.issue_packaging_bulk($1, $2)', [unknown, ['OC-X-1001']])).rejects.toThrow(`EBMR-PKG-001 batch ${unknown} is no issued GMP batch`);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});
