/**
 * The records routes and acts over HTTP (Phase 4 slice 5b; contract ns/records-lock.ts; recipe-core 0870 to 0873,
 * tablets 1190, 1199): the bulk reconciliation of a processing batch closed by production (the record locks), the lock
 * and its amendment opened and closed by QA through the ceremony (RECORD_LOCK_ACT, the aggregate id read by the server),
 * entries appended by production, the bright-stock maximum hold set by master data, and every refusal from the database.
 * The batch is a real GMP batch, issued; its execution end is arranged (the engine paths are proven elsewhere).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type SignableAction } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { refusalOf, valueOf } from '../esig/support.ts';
import { actorOf, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import type { TestBrowser } from '../support/harness.ts';
import { describeAction, signAction } from '../support/signed-acts.ts';

let w: GmpBatchWorld;
let head: TestBrowser;
let qa: TestBrowser;
let qa2: TestBrowser;
let steward: TestBrowser;
let batchId: string;
let deviationId: string;
let containerId: string;

beforeAll(async () => {
  w = await startGmpBatchWorld();
  const issuer = await w.gmp.asPersona('issuer');
  [head, qa, qa2, steward] = await Promise.all([w.gmp.asPersona('head1'), w.gmp.asPersona('qaInvestigator'), w.gmp.asPersona('qaApprover2'), w.gmp.asPersona('steward')]);
  batchId = await w.issued(issuer);
  // ARRANGED: the batch's execution is complete (the engine's own end is proven by the execution tests).
  await w.gmp.db.admin.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = $1", [batchId]);
  // ARRANGED: one closed output container released by QA and never issued (the container paths are proven elsewhere).
  const fx = await w.gmp.db.admin.connect();
  try {
    await fx.query('begin');
    await fx.query("set local session_replication_role = 'replica'");
    const [b] = (await fx.query<{ n: string; p: string; s: string }>("select batch_number as n, recipe.batch_product(id) ->> 'code' as p, recipe.batch_product(id) ->> 'strength' as s from recipe.batch_execution where id = $1", [batchId])).rows;
    containerId = randomUUID();
    await fx.query(`insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, quantity_unit, opened_by_person, opened_by_account)
                    values ($1, $2, $3, $4, $5, $6, 'COMPRESSION', 'kg', $1, $1)`, [containerId, `OC-${b!.n}-4711`, batchId, b!.n, b!.p, b!.s]);
    await fx.query("insert into plant.container_close (container_id, net_quantity, person_id, account_id, basis, weighing) values ($1, 12.500, $1, $1, 'WEIGHED', '{}'::jsonb)", [containerId]);
    await fx.query("insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version) values ('output_container', $1, 'output_container', 1, 'RELEASED_BY_QA', 3)", [containerId]);
    await fx.query('commit');
  } finally {
    fx.release();
  }
  const operator = await actorOf(w.gmp, 'qaInvestigator');
  deviationId = await withCommand(w.gmp.db.app, { ...operator, correlationId: randomUUID() }, async (c) => {
    const d = (await c.query<{ r: { deviationId: string } }>('select site.raise_deviation($1::jsonb) as r', [
      JSON.stringify({ kind: 'DEVIATION', title: 'Record finding after closure', classification: 'MINOR', riskRationale: 'Documentation finding; assessed by QA' }),
    ])).rows[0]!.r.deviationId;
    await c.query("select site.link_deviation($1, 'BATCH', $2)", [d, batchId]);
    return d;
  });
}, 600_000);
afterAll(async () => {
  await w?.close();
});

const codeOf = (r: Awaited<ReturnType<typeof signAction>>): string => (r.ok ? 'ok' : (refusalOf(r)?.why.match(/EBMR-[A-Z]+-\d{3}/)?.[0] ?? refusalOf(r)?.code ?? 'refused'));

describe('records routes over HTTP (outline 5.2.10; INV-21, PR-38)', () => {

  it('[INV-21] production closes the bulk reconciliation of a complete processing batch and the record locks; QA cannot close it; the lock and the list show it; an unknown batch is 404', async () => {
    const before = valueOf(await head.call(routes.records.bulk, { params: { batchId } }));
    expect(before).toMatchObject({ batchId, recordKind: 'PROCESSING', closeProblems: [], closure: null, lockState: 'UNLOCKED', orders: [],
                                   produced: [{ quantity: '12.500', unit: 'kg' }], issued: [], remaining: [{ quantity: '12.500', unit: 'kg' }] });
    expect(before.containers).toEqual([expect.objectContaining({ containerId, quantity: '12.500', unit: 'kg', state: 'RELEASED_BY_QA', orderBatchId: null, orderBatchNumber: null })]);
    expect(before.containers[0]!.closedAt).toBeTruthy();
    expect(refusalOf(await qa.call(routes.records.closeBulk, { params: { batchId }, body: {} })).code).toBe('EBMR-IAM-040');
    // Bulk is left: production closes only with the reason it is held (EBMR-LCK-012), and the reason is recorded.
    expect(refusalOf(await head.call(routes.records.closeBulk, { params: { batchId }, body: {} }))).toMatchObject({ code: 'EBMR-LCK-012', why: expect.stringMatching(/1 container\(s\) of bulk are left/) as string });
    const after = valueOf(await head.call(routes.records.closeBulk, { params: { batchId }, body: { remainingHeldReason: 'Left over bulk held for a later order under review' } }));
    expect(after).toMatchObject({ lockState: 'LOCKED', closeProblems: ['the bulk reconciliation is already closed'],
                                  closure: { closedBy: { legalName: 'Lakshmi Iyengar', role: 'HEAD_OF_PRODUCTION' }, remainingHeldReason: 'Left over bulk held for a later order under review' } });
    expect(after.closure!.closedAt).toBeTruthy();
    const again = refusalOf(await head.call(routes.records.closeBulk, { params: { batchId }, body: { remainingHeldReason: 'Left over bulk held for a later order under review' } }));
    expect(again).toMatchObject({ code: 'EBMR-LCK-011', why: expect.stringMatching(/already closed/) as string });
    const lock = valueOf(await qa.call(routes.records.lock, { params: { batchId } }));
    expect(lock).toMatchObject({ state: 'LOCKED', cause: 'BULK_RECONCILIATION_CLOSED', amendments: [], nextAmendmentNumber: 1, openAmendmentNumber: null, releasedLots: [] });
    expect(valueOf(await qa.call(routes.records.locks, { query: { state: 'LOCKED' } })).records.map((r) => r.batchId)).toContain(batchId);
    expect(valueOf(await qa.call(routes.records.locks, { query: { state: 'UNDER_AMENDMENT' } })).records.map((r) => r.batchId)).not.toContain(batchId);
    const unknown = randomUUID();
    expect(refusalOf(await qa.call(routes.records.lock, { params: { batchId: unknown } }))).toMatchObject({
      status: 404, code: 'EBMR-LCK-030', why: expect.stringContaining(unknown) as string, whatYouCanDo: [expect.stringMatching(/./) as string],
    });
    // Every read needs a session.
    const anon = w.gmp.browser();
    expect(refusalOf(await anon.call(routes.records.locks, { query: {} })).status).toBe(401);
    expect(refusalOf(await anon.call(routes.records.lock, { params: { batchId } })).status).toBe(401);
    expect(refusalOf(await anon.call(routes.records.bulk, { params: { batchId } })).status).toBe(401);
    expect(refusalOf(await anon.call(routes.records.brightStockHolds)).status).toBe(401);
  });

  it('[INV-21][R-04] QA opens an amendment through the ceremony (the server reads its number), production appends an entry, another QA person closes it over the entries: LOCKED again; a malformed act signs nothing', async () => {
    const open: SignableAction = { kind: 'RECORD_LOCK_ACT', act: 'AMENDMENT_OPEN', batchId, input: { deviationId, reason: { code: 'LATE_ENTRY', text: 'Untranscribed check found at review' } } };
    expect(await describeAction(qa, open)).toMatchObject({ aggregateType: 'record_lock', aggregateId: `${batchId}/1/OPEN/DEVIATION/${deviationId}`, meaning: 'AMENDMENT_OPENED', expectedState: 'LOCKED' });
    expect(codeOf(await signAction(w.gmp, qa, 'qaInvestigator', { ...open, input: { deviationId } }))).toBe('EBMR-API-ACT-INPUT');
    expect(codeOf(await signAction(w.gmp, qa, 'qaInvestigator', { ...open, input: { ...open.input, statement: 'not for an opening' } }))).toBe('EBMR-API-ACT-INPUT');
    expect(codeOf(await signAction(w.gmp, head, 'head1', open))).not.toBe('ok');
    expect(codeOf(await signAction(w.gmp, qa, 'qaInvestigator', open))).toBe('ok');
    const opened = valueOf(await qa.call(routes.records.lock, { params: { batchId } }));
    expect(opened).toMatchObject({ state: 'UNDER_AMENDMENT', openAmendmentNumber: 1, nextAmendmentNumber: 2 });
    expect(opened.amendments[0]).toMatchObject({ number: 1, state: 'OPEN', basis: { kind: 'DEVIATION', id: deviationId }, openedBy: { legalName: 'Divya Menon', role: 'QA_REVIEWER' }, entries: [], tasks: [] });

    const entry = { kind: 'LATE_ENTRY' as const, target: 'Step s-blend: blend time', text: 'Blend time read from the paper log', value: '12 min', reason: 'Transcribed from paper log PL-7 under the deviation' };
    expect(refusalOf(await qa.call(routes.records.appendAmendmentEntry, { params: { batchId, number: '1' }, body: entry })).code).toBe('EBMR-IAM-040');
    expect(refusalOf(await head.call(routes.records.appendAmendmentEntry, { params: { batchId, number: '2' }, body: entry })).code).toBe('EBMR-LCK-040');
    const amended = valueOf(await head.call(routes.records.appendAmendmentEntry, { params: { batchId, number: '1' }, body: entry }));
    expect(amended.entries).toEqual([expect.objectContaining({ seq: 1, kind: 'LATE_ENTRY', value: '12 min', by: expect.objectContaining({ legalName: 'Lakshmi Iyengar', role: 'HEAD_OF_PRODUCTION' }) as unknown })]);

    const close: SignableAction = { kind: 'RECORD_LOCK_ACT', act: 'AMENDMENT_CLOSE', batchId, input: { statement: 'The late entry restores the record; no product impact' } };
    expect(await describeAction(qa2, close)).toMatchObject({ aggregateId: `${batchId}/1/CLOSE`, meaning: 'AMENDMENT_CLOSED', expectedState: 'UNDER_AMENDMENT' });
    expect(codeOf(await signAction(w.gmp, qa2, 'qaApprover2', { ...close, input: {} }))).toBe('EBMR-API-ACT-INPUT');
    expect(codeOf(await signAction(w.gmp, qa2, 'qaApprover2', close))).toBe('ok');
    const closed = valueOf(await qa.call(routes.records.lock, { params: { batchId } }));
    expect(closed).toMatchObject({ state: 'LOCKED', openAmendmentNumber: null });
    expect(closed.amendments[0]).toMatchObject({ state: 'CLOSED', closedBy: { legalName: 'Arvind Rao' }, closingStatement: 'The late entry restores the record; no product impact' });
    // Nothing open to close: the record to be signed does not exist.
    expect(codeOf(await signAction(w.gmp, qa2, 'qaApprover2', close))).not.toBe('ok');
    // A second amendment: an entry goes to the amendment named, never to the first.
    const open2: SignableAction = { ...open, input: { deviationId, reason: { code: 'CORRECTION', text: 'Second finding under the same deviation' } } };
    expect(await describeAction(qa, open2)).toMatchObject({ aggregateId: `${batchId}/2/OPEN/DEVIATION/${deviationId}` });
    expect(codeOf(await signAction(w.gmp, qa, 'qaInvestigator', open2))).toBe('ok');
    const second = valueOf(await head.call(routes.records.appendAmendmentEntry, { params: { batchId, number: '2' }, body: { ...entry, text: 'Second correction', reason: 'Corrected from the paper log PL-8 under the deviation' } }));
    expect(second).toMatchObject({ number: 2, state: 'OPEN', entries: [expect.objectContaining({ seq: 1, text: 'Second correction' }) as unknown] });
  });

  it('[PR-38] master data sets a product\'s maximum hold for bright stock (a new version each time, the latest shown); production cannot; a number travels as text', async () => {
    const product = `HOLD-${randomUUID().slice(0, 6).toUpperCase()}`;
    const body = { productCode: product, strength: '500 mg', maxHoldHours: '720', reason: 'Hold study HS-01: sealed drums, 30 days' };
    expect(refusalOf(await head.call(routes.records.setBrightStockHold, { body })).code).toBe('EBMR-IAM-040');
    expect(valueOf(await steward.call(routes.records.setBrightStockHold, { body }))).toMatchObject({ productCode: product, strength: '500 mg', maxHoldHours: '720', setBy: { legalName: 'Neha Joshi' } });
    expect(valueOf(await steward.call(routes.records.setBrightStockHold, { body: { ...body, maxHoldHours: '480' } }))).toMatchObject({ maxHoldHours: '480' });
    const holds = valueOf(await qa.call(routes.records.brightStockHolds)).holds.filter((h) => h.productCode === product);
    expect(holds).toEqual([expect.objectContaining({ maxHoldHours: '480' })]);
    // The strength is kept as the database keeps it (trimmed), and the hold is found again under it.
    expect(valueOf(await steward.call(routes.records.setBrightStockHold, { body: { ...body, strength: '  250 mg ', maxHoldHours: '96' } }))).toMatchObject({ productCode: product, strength: '250 mg', maxHoldHours: '96' });
    // The batch's own product: its bulk view shows the maximum hold in force.
    const bp = (await w.gmp.db.admin.query<{ p: string; s: string }>("select recipe.batch_product($1) ->> 'code' as p, recipe.batch_product($1) ->> 'strength' as s", [batchId])).rows[0]!;
    valueOf(await steward.call(routes.records.setBrightStockHold, { body: { productCode: bp.p, strength: bp.s, maxHoldHours: '720', reason: 'Hold study HS-02 for the batch product' } }));
    expect(valueOf(await head.call(routes.records.bulk, { params: { batchId } })).maxHold).toMatchObject({ productCode: bp.p, strength: bp.s, maxHoldHours: '720' });
  });
});
