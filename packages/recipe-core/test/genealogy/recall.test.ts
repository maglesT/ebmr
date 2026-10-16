/**
 * The mock recall, the deviation impact query and the recurrence count in the database (Phase 6 slice 6d; recipe-core
 * 1012; IN-29, PR-57, PR-50, PR-49; defaults D-P6d-2, D-P6d-3, D-P6d-0-3, D-P6d-0-7, D-P6d-0-8, D-P6d-4, D-P6d-5). Every
 * act runs as the application role through the definers with real e-signatures; fixtures as in support.ts.
 *
 * Scenario: API lot A and excipient lot E -> batch G1 -> container C1 issued to packaging order P1 -> finished lot F1,
 * released and shipped by the ERP/WMS adapter to CUST-1 (300) and CUST-2 (200), and once through the Phase 4 ERP stub
 * route without an address (CUST-9, 50); 100 returned. Batch H also consumed E -> its order HP -> HL. Batch Z (another
 * product) consumed nothing of these.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signFor } from '../../../kernel/test/records/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { GenealogyWorld, refusal, unique, type Batch, type Lot } from './support.ts';

let db: TestDatabase;
let w: GenealogyWorld;
let A: Lot;
let E: Lot;
let F1: Lot;
let HL: Lot;
let G1: Batch;
let P1: Batch;
let H: Batch;
let HP: Batch;
let Z: Batch;
let stubShipment = '';

interface Result {
  batches: { batch_id: string; batch_number: string; depth: number }[];
  lots: { lot_id: string; lot_code: string; material_kind: string; unit: string; delivered: string; returned: string; outstanding: string; depth: number }[];
  consignees: { consignee_code: string; consignee_address: string | null; markets: string[]; shipments: { shipment_no: string; quantity: string }[] }[];
  incomplete: string[];
  counts: Record<string, number>;
}

beforeAll(async () => {
  db = await createTestDatabase();
  w = await GenealogyWorld.create(db);
  A = await w.materialLot('A', 'API', 'API-1');
  E = await w.materialLot('E', 'EXCIPIENT', 'EXC-1');
  G1 = await w.batch('G1', 'RCL-500');
  await w.consume(A, G1);
  await w.consume(E, G1);
  const c1 = await w.container('C1', G1);
  P1 = await w.batch('P1', 'RCL-500', G1);
  await w.bulkIssue(c1, G1, P1);
  F1 = await w.finishedLot('F1', P1);
  await w.released(F1);
  await w.ship(F1, 'CUST-1', '300');
  await w.ship(F1, 'CUST-2', '200');
  stubShipment = unique('SHSTUB');
  await w.run(w.cast.erp, 'select site.erp_record_shipment($1::jsonb) as r', [
    JSON.stringify({ shipmentNo: stubShipment, lotId: F1.id, market: 'IN', consigneeCode: 'CUST-9', consigneeName: 'Stub consignee', quantity: '50', unit: 'units', quarantine: false, erpReference: 'DN-STUB-1' }),
  ]);
  await w.run(w.cast.warehouse, 'select site.receive_returned_goods($1::jsonb) as r', [
    JSON.stringify({ originalLotId: F1.id, quantity: '100', reason: 'Recall exercise returns', returnedFrom: 'Distributor Pune' }),
  ]);
  H = await w.batch('H', 'RCL-500');
  await w.consume(E, H);
  HP = await w.batch('HP', 'RCL-500', H);
  HL = await w.finishedLot('HL', HP);
  Z = await w.batch('Z', 'OTHER-1');
}, 300_000);
afterAll(async () => {
  await db?.drop();
});

const run = (by = w.cast.qa, kind = 'LOT', id = A.id, asOf: string | null = null, informed = false, reference: string | null = null) =>
  w.run<string>(by, 'select recipe.run_mock_recall($1, $2, $3::timestamptz, $4, $5)::text as r', [kind, id, asOf, informed, reference]);
const stored = async (id: string) =>
  (await db.app.query<{ result: Result; result_sha256: string; as_of: string; subject_ref: string; authority_informed: boolean; authority_reference: string | null }>(
    'select result, result_sha256, as_of::text, subject_ref, authority_informed, authority_reference from recipe.mock_recall where id = $1', [id])).rows[0]!;
const reproduces = async (id: string) => (await db.app.query<{ r: boolean }>('select recipe.mock_recall_reproduces($1) as r', [id])).rows[0]!.r;

async function raise(title: string): Promise<{ deviationId: string; ref: string }> {
  return w.run(w.operator, 'select site.raise_deviation($1::jsonb) as r', [JSON.stringify({ kind: 'DEVIATION', title, classification: 'MINOR', riskRationale: 'A minor deviation for the test' })]);
}
const link = (d: string, kind: string, id: string) => w.run(w.operator, 'select site.link_deviation($1, $2, $3)::text as r', [d, kind, id]);

describe('mock recall (recipe-core 1012; IN-29, PR-57; D-P6d-2)', () => {
  it('[IN-29][PR-57] a mock recall from a lot lists the affected batches and lots, every consignee with what it was delivered, and the reconciliation of delivered against returned; it is stored with its as-of point and hash and reproduces', async () => {
    const id = await run();
    const m = await stored(id);
    expect(m.subject_ref).toBe(A.code);
    expect(m.authority_informed).toBe(false);
    const r = m.result;
    expect(r.batches.map((b) => [w.names.get(b.batch_id), b.depth])).toEqual([['G1', 1], ['P1', 2]]);
    const f1 = r.lots.find((l) => l.lot_id === F1.id)!;
    expect(f1).toMatchObject({ material_kind: 'FINISHED', unit: 'units', delivered: '550', returned: '100', outstanding: '450', depth: 3 });
    expect(r.lots.map((l) => l.material_kind).sort()).toEqual(['API', 'FINISHED', 'RETURNED']);
    expect(r.consignees.map((c) => [c.consignee_code, c.consignee_address, c.markets, c.shipments.map((s) => s.quantity)])).toEqual([
      ['CUST-1', 'CUST-1 Road, Pune', ['IN'], ['300']],
      ['CUST-2', 'CUST-2 Road, Pune', ['IN'], ['200']],
      ['CUST-9', null, ['IN'], ['50']],
    ]);
    // The stub route's record has no address: listed as incomplete (D-P6d-0-7).
    expect(r.incomplete).toEqual([stubShipment]);
    expect(r.counts).toEqual({ batches: 2, lots: 3, consignees: 3, shipments: 3, incomplete_records: 1 });
    expect(m.result_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await reproduces(id)).toBe(true);
    // A shipment after the run changes a new run, not this one: it still reproduces as of its own instant.
    await w.ship(F1, 'CUST-3', '25');
    expect(await reproduces(id)).toBe(true);
    const again = await stored(await run());
    expect(again.result_sha256).not.toBe(m.result_sha256);
    expect(again.result.consignees.map((c) => c.consignee_code)).toContain('CUST-3');
    // Repeated as of the first run's instant, the same hash (PR-57 as-of point).
    expect((await stored(await run(w.cast.qa, 'LOT', A.id, m.as_of))).result_sha256).toBe(m.result_sha256);
  });

  it('[IN-29] from a deviation: the subjects it linked by then, forward; the licensing-authority flag is recorded with its reference', async () => {
    const d = await raise('Granulation end point missed');
    expect(await refusal(run(w.cast.qa, 'DEVIATION', d.deviationId))).toMatch(/EBMR-RCL-004/);
    await link(d.deviationId, 'BATCH', G1.id);
    const id = await run(w.cast.qa, 'DEVIATION', d.deviationId, null, true, 'CDSCO/RECALL/2026/017');
    const m = await stored(id);
    expect(m).toMatchObject({ subject_ref: d.ref, authority_informed: true, authority_reference: 'CDSCO/RECALL/2026/017' });
    expect(m.result.batches.map((b) => [w.names.get(b.batch_id), b.depth])).toEqual([['G1', 0], ['P1', 1]]);
    expect(m.result.lots.map((l) => w.names.get(l.lot_id) ?? l.material_kind)).toEqual(['F1', 'RETURNED']);
  });

  it('[IN-29] the run refuses what is not a mock recall and the application role cannot write the tables', async () => {
    expect(await refusal(run(w.operator))).toMatch(/EBMR-IAM|RECALL\.MOCK_RUN|permission/i);
    expect(await refusal(run(w.cast.qa, 'BATCH', G1.id))).toMatch(/EBMR-RCL-001/);
    expect(await refusal(run(w.cast.qa, 'LOT', A.id, '2999-01-01T00:00:00Z'))).toMatch(/EBMR-RCL-002/);
    expect(await refusal(run(w.cast.qa, 'LOT', G1.id))).toMatch(/EBMR-RCL-003/);
    expect(await refusal(run(w.cast.qa, 'LOT', A.id, null, true, null))).toMatch(/EBMR-RCL-006/);
    expect(await refusal(run(w.cast.qa, 'LOT', A.id, null, false, 'REF-1'))).toMatch(/EBMR-RCL-006/);
    expect(await refusal(db.app.query("insert into recipe.mock_recall (subject_kind, subject_id, subject_ref, as_of, query_version, result, result_sha256, authority_informed, person_id, account_id, role_code, correlation_id) values ('LOT', gen_random_uuid(), 'X', now(), 1, '{}', repeat('a', 64), false, gen_random_uuid(), gen_random_uuid(), 'X', gen_random_uuid())"))).toMatch(/permission denied/);
    expect(await refusal(db.app.query('select recipe.mock_recall_result_v1($1, $2, now())', ['LOT', A.id]))).toMatch(/permission denied/);
  });

  it('[IN-29] the authorised person owns the mock recall: only the AP signs it off, with their own signature on the current content, once', async () => {
    const id = await run();
    const aggregate = { type: 'mock_recall', id };
    const apSig = await signFor(db, w.ap, aggregate, 'MOCK_RECALL_SIGNED_OFF', 'RUN');
    // QA holds no RECALL.MOCK_SIGN_OFF, even with the AP's signature in hand.
    expect(await refusal(w.run(w.cast.qa, 'select recipe.sign_off_mock_recall($1, $2)::text as r', [id, apSig]))).toMatch(/EBMR-IAM|RECALL\.MOCK_SIGN_OFF|permission/i);
    const ap2 = await (await import('../../../site-services/test/helpers.ts')).signerActor(db, 'AUTHORISED_PERSON');
    expect(await refusal(w.run(ap2, 'select recipe.sign_off_mock_recall($1, $2)::text as r', [id, apSig]))).toMatch(/EBMR-REL-013 .* recorded by the person who signed it/);
    const signOff = await w.run<string>(w.ap, 'select recipe.sign_off_mock_recall($1, $2)::text as r', [id, apSig]);
    expect(signOff).toMatch(/^[0-9a-f-]{36}$/);
    expect(await refusal(w.run(w.ap, 'select recipe.sign_off_mock_recall($1, $2)::text as r', [id, apSig]))).toMatch(/EBMR-RCL-011/);
    const { rows } = await db.app.query<{ role_code: string; result_sha256: string }>('select role_code, result_sha256 from recipe.mock_recall_signoff where mock_recall_id = $1', [id]);
    expect(rows).toEqual([{ role_code: 'AUTHORISED_PERSON', result_sha256: (await stored(id)).result_sha256 }]);
    // A mock recall never changes a lot (D-P6d-2): F1 is still released.
    expect((await db.admin.query<{ s: string }>('select site.lot_state($1) as s', [F1.id])).rows[0]!.s).toBe('RELEASED');
  });
});

describe('deviation impact query (recipe-core 1012; PR-50; D-P6d-3, D-P6d-4)', () => {
  /**
   * The independent query (D-P6d-3, test only): written separately from the service, batch to batch, with no
   * containers and no recipe.genealogy: the linked batches, then every batch reachable through the packaging register,
   * bulk issue (its parent batch column), reprocessing links, additions, and finished lots consumed elsewhere; the
   * shared-lot batches are the other consumers of the linked batches' input lots and what is reachable from them.
   */
  const INDEPENDENT = `
    with recursive linked as (
      select y.batch_id as b from site.deviation_link y where y.deviation_id = $1 and y.batch_id is not null
      union select f.batch_id from site.deviation_link y join site.finished_lot f on f.lot_id = y.subject_id where y.deviation_id = $1 and y.subject_kind = 'LOT'),
    step(a, b) as (
      select pl.batch_id, l.batch_id from recipe.batch_allocation_link pl join site.batch_number_allocation na on na.parent_allocation_id = pl.allocation_id join recipe.batch_allocation_link l on l.allocation_id = na.id
      union select parent_batch_id, order_batch_id from recipe.packaging_bulk_issue
      union select parent_batch_id, child_batch_id from recipe.batch_parent_link
      union select source_batch_id, batch_id from recipe.source_addition
      union select f.batch_id, c.batch_id from site.finished_lot f join site.lot_consumption c on c.lot_id = f.lot_id),
    reach(b) as (select b from linked union select s.b from reach r join step s on s.a = r.b),
    others as (select distinct c2.batch_id as b from site.lot_consumption c1 join site.lot_consumption c2 on c2.lot_id = c1.lot_id
                where c1.batch_id in (select b from linked) and c2.batch_id not in (select b from linked)),
    reach2(b) as (select b from others union select s.b from reach2 r join step s on s.a = r.b)
    select b::text, 'LINKED' as relation from linked
    union all select b::text, 'DOWNSTREAM' from reach where b not in (select b from linked)
    union all select b::text, 'SHARED_LOT' from reach2 where b not in (select b from reach)
    order by 1`;

  it('[PR-50] the impact query returns the expected batch set, checked against an independent query', async () => {
    const d = await raise('Wrong excipient grade suspected');
    await link(d.deviationId, 'BATCH', G1.id);
    const { rows } = await db.app.query<{ batch_id: string; batch_number: string; product_code: string; relation: string }>('select * from recipe.deviation_impact_batches($1, null)', [d.deviationId]);
    expect(rows.map((r) => [w.names.get(r.batch_id), r.relation])).toEqual([['G1', 'LINKED'], ['P1', 'DOWNSTREAM'], ['H', 'SHARED_LOT'], ['HP', 'SHARED_LOT']]);
    expect(rows[0]).toMatchObject({ batch_number: G1.number, product_code: 'RCL-500' });
    expect(rows.map((r) => r.batch_id)).not.toContain(Z.id);
    const independent = (await db.admin.query<{ b: string; relation: string }>(INDEPENDENT, [d.deviationId])).rows;
    expect(rows.map((r) => `${r.batch_id} ${r.relation}`).sort()).toEqual(independent.map((r) => `${r.b} ${r.relation}`).sort());
    // A lot link: the batch of a linked finished lot counts as linked; the as-of point leaves out later links.
    const d2 = await raise('Complaint on a finished lot');
    const before = await w.now();
    await link(d2.deviationId, 'LOT', HL.id);
    const { rows: viaLot } = await db.app.query<{ batch_id: string; relation: string }>('select batch_id, relation from recipe.deviation_impact_batches($1, null)', [d2.deviationId]);
    expect(viaLot.map((r) => [w.names.get(r.batch_id), r.relation])).toEqual([['HP', 'LINKED']]);
    expect((await db.admin.query<{ b: string; relation: string }>(INDEPENDENT, [d2.deviationId])).rows.map((r) => `${r.b} ${r.relation}`)).toEqual([`${HP.id} LINKED`]);
    expect((await db.app.query('select * from recipe.deviation_impact_batches($1, $2::timestamptz)', [d2.deviationId, before])).rows).toEqual([]);
    expect(await refusal(db.app.query('select * from recipe.deviation_impact_batches(gen_random_uuid(), null)'))).toMatch(/EBMR-RCL-015/);
  });
});

describe('deviation recurrence (recipe-core 1012; PR-49; D-P6d-5)', () => {
  const finding = (deviationId: string, category: string) =>
    w.fixture(
      `insert into site.deviation_finding (deviation_id, assignable_cause, cause, root_cause_category, recorded_by_person, recorded_by_account)
       values ($1, $2, 'The cause found by the investigation', $3, gen_random_uuid(), gen_random_uuid())`,
      [deviationId, category !== 'NOT_DETERMINED', category],
    );
  const recurrence = async (lot: Lot) =>
    (await db.app.query<{ r: { warning: boolean; threshold: number; items: { ref: string; root_cause_category: string | null; occurrences: number; warning: boolean; others: { ref: string }[] }[] } }>(
      'select recipe.deviation_recurrence($1) as r', [lot.id])).rows[0]!.r;

  it('[PR-49] the recurrence count of a lot\'s deviation: the same root-cause category on the same product, a warning from the third occurrence', async () => {
    const lots: Lot[] = [];
    for (const n of ['R1', 'R2', 'R3', 'R4']) lots.push(await w.finishedLot(n, await w.batch(`${n}-P`, 'REC-500')));
    const other = await w.finishedLot('O1', await w.batch('O1-P', 'OTH-500'));
    const devs: { deviationId: string; ref: string }[] = [];
    for (const [i, lot] of [lots[0]!, lots[1]!].entries()) {
      const d = await raise(`Tablet weight drift ${i.toString()}`);
      await link(d.deviationId, 'LOT', lot.id);
      await finding(d.deviationId, 'EQUIPMENT');
      devs.push(d);
    }
    // Another product's deviation of the same category, one of another category, and one not determined: not counted.
    const o = await raise('Weight drift on another product');
    await link(o.deviationId, 'LOT', other.id);
    await finding(o.deviationId, 'EQUIPMENT');
    const h = await raise('Wrong reel loaded');
    await link(h.deviationId, 'LOT', lots[3]!.id);
    await finding(h.deviationId, 'HUMAN_ERROR');
    const second = await recurrence(lots[1]!);
    expect(second.warning).toBe(false);
    expect(second.items.map((x) => [x.ref, x.root_cause_category, x.occurrences, x.warning])).toEqual([[devs[1]!.ref, 'EQUIPMENT', 2, false]]);
    // The third occurrence: the warning.
    const d3 = await raise('Tablet weight drift 2');
    await link(d3.deviationId, 'LOT', lots[2]!.id);
    const before = await recurrence(lots[2]!);
    expect(before.items.map((x) => [x.root_cause_category, x.occurrences, x.warning])).toEqual([[null, 0, false]]);
    await finding(d3.deviationId, 'EQUIPMENT');
    const third = await recurrence(lots[2]!);
    expect(third.warning).toBe(true);
    expect(third.threshold).toBe(3);
    expect(third.items.map((x) => [x.ref, x.occurrences, x.warning, x.others.map((y) => y.ref)])).toEqual([[d3.ref, 3, true, [devs[0]!.ref, devs[1]!.ref]]]);
    expect((await recurrence(lots[3]!)).items.map((x) => [x.root_cause_category, x.occurrences, x.warning])).toEqual([['HUMAN_ERROR', 1, false]]);
    const nd = await raise('Unexplained hardness drop');
    await link(nd.deviationId, 'LOT', lots[3]!.id);
    await finding(nd.deviationId, 'NOT_DETERMINED');
    expect((await recurrence(lots[3]!)).items.find((x) => x.ref === nd.ref)).toMatchObject({ occurrences: 0, warning: false });
  });
});
