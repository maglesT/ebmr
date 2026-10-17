/**
 * The genealogy in the database (Phase 6 slice 6d; recipe-core 1010, 1011; site services 0960, 0961; PR-57, IN-07,
 * IN-29; defaults D-P6d-1, D-P6d-0-1 to D-P6d-0-7). Every trace runs as the application role through recipe.genealogy;
 * the fixtures are described in world.ts.
 *
 * The seeded scenario (split, merge, rework, recovery):
 *   API lot A and excipient lot E -> processing batch G1 -> containers C1, C2, C3 (C3 merged into C2);
 *   G1's packaging orders P1 and P2 (the register), C1 issued to P1 and C2 to P2 (the split);
 *   G2 reprocesses G1 (whole batch), G3 receives a reprocessing addition from G1;
 *   P1 consumed packaging material lot PM; finished lots F1 (P1) and F2 (P2), shipped by the ERP/WMS adapter;
 *   returned goods R of F1 chemically recovered into M; G4 consumed M; its packaging order P4 and finished lot F4;
 *   an unrelated API lot B -> batch X (never in A's genealogy).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { GenealogyWorld, refusal, type Batch, type Lot } from './world.ts';

let db: TestDatabase;
let w: GenealogyWorld;
const s = {} as Record<'A' | 'E' | 'B' | 'PM' | 'F1' | 'F2' | 'F4' | 'R' | 'M', Lot> & Record<'G1' | 'G2' | 'G3' | 'G4' | 'P1' | 'P2' | 'P4' | 'X', Batch> & { C1: string; C2: string; C3: string };
const sent: Record<string, unknown>[] = [];
let beforeSecondShipments = '';

beforeAll(async () => {
  db = await createTestDatabase();
  w = await GenealogyWorld.create(db);
  s.A = await w.materialLot('A', 'API', 'API-1');
  s.E = await w.materialLot('E', 'EXCIPIENT', 'EXC-1');
  s.B = await w.materialLot('B', 'API', 'API-1');
  s.PM = await w.materialLot('PM', 'PRIMARY_PACKAGING', 'BLISTER-1', 'units');
  s.G1 = await w.batch('G1');
  await w.consume(s.A, s.G1);
  await w.consume(s.E, s.G1);
  await w.consume(s.A, s.G1, '2'); // a second consumption of the same lot: still one edge
  s.C1 = await w.container('C1', s.G1);
  s.C2 = await w.container('C2', s.G1);
  s.C3 = await w.container('C3', s.G1);
  await w.merge(s.C3, s.C2);
  s.P1 = await w.batch('P1', 'GEN-500', s.G1);
  s.P2 = await w.batch('P2', 'GEN-500', s.G1);
  await w.bulkIssue(s.C1, s.G1, s.P1);
  await w.bulkIssue(s.C2, s.G1, s.P2);
  await w.consume(s.PM, s.P1);
  s.G2 = await w.batch('G2');
  await w.reprocessed(s.G1, s.G2);
  s.G3 = await w.batch('G3');
  await w.addition(s.G1, s.G3, s.C3, 'REPROCESSING_ADDITION');
  s.F1 = await w.finishedLot('F1', s.P1);
  s.F2 = await w.finishedLot('F2', s.P2);
  await w.released(s.F1);
  await w.released(s.F2);
  sent.push((await w.ship(s.F1, 'CUST-1', '300')).payload);
  sent.push((await w.ship(s.F1, 'CUST-2', '200')).payload);
  beforeSecondShipments = await w.now();
  sent.push((await w.ship(s.F2, 'CUST-2', '150')).payload);
  sent.push((await w.ship(s.F2, 'CUST-3', '50')).payload);
  const r = await w.recover('F1', s.F1, '100');
  s.R = r.returned;
  s.M = r.recovered;
  s.G4 = await w.batch('G4');
  await w.consume(s.M, s.G4, '40');
  s.P4 = await w.batch('P4', 'GEN-500', s.G4);
  s.F4 = await w.finishedLot('F4', s.P4);
  s.X = await w.batch('X');
  await w.consume(s.B, s.X);
}, 300_000);
afterAll(async () => {
  await db?.drop();
});

describe('genealogy traversal (recipe.genealogy; PR-57)', () => {
  it('[PR-57] a seeded split, merge and rework scenario returns exactly the expected nodes', async () => {
    const rows = await w.trace('LOT', s.A.id, 'FORWARD');
    const shipments = sent.map((p) => `S:${String(p['shipmentId'])}`);
    expect(w.nodes(rows)).toEqual(['A', 'C1', 'C2', 'C3', 'F1', 'F1-recovered', 'F1-returned', 'F2', 'F4', 'G1', 'G2', 'G3', 'G4', 'P1', 'P2', 'P4', ...shipments].sort());
    expect(w.lines(rows)).toEqual([
      'A <- - (-) @0',
      'G1 <- A (CONSUMED) @1',
      'C1 <- G1 (OUTPUT) @2', 'C2 <- G1 (OUTPUT) @2', 'C3 <- G1 (OUTPUT) @2',
      'P1 <- G1 (PACKAGING_ORDER) @2', 'P2 <- G1 (PACKAGING_ORDER) @2',
      'G2 <- G1 (REPROCESSED) @2', 'G3 <- G1 (REPROCESSING_ADDITION) @2',
      // the split: each bulk container reaches its own order; the merge: C3 into C2 (both reached before, edges kept)
      'P1 <- C1 (BULK_ISSUE) @2', 'P2 <- C2 (BULK_ISSUE) @2', 'C2 <- C3 (MERGED) @2',
      'F1 <- P1 (FINISHED) @3', 'F2 <- P2 (FINISHED) @3',
      `${shipments[0]!} <- F1 (SHIPPED) @4`, `${shipments[1]!} <- F1 (SHIPPED) @4`, `${shipments[2]!} <- F2 (SHIPPED) @4`, `${shipments[3]!} <- F2 (SHIPPED) @4`,
      'F1-returned <- F1 (RETURNED) @4',
      'F1-recovered <- F1-returned (RECOVERED) @5',
      'G4 <- F1-recovered (CONSUMED) @6',
      'P4 <- G4 (PACKAGING_ORDER) @7',
      'F4 <- P4 (FINISHED) @8',
    ].sort());
    // Set semantics: every edge once (A was consumed twice by G1).
    expect(new Set(rows.map((r) => `${r.node_id}|${r.parent_id ?? ''}|${r.edge_kind ?? ''}`)).size).toBe(rows.length);
    // Backward from F4: through the recovery and the returned goods to the API lot, never to the unrelated lot B.
    const back = await w.trace('LOT', s.F4.id, 'BACKWARD');
    expect(w.nodes(back)).toEqual(['A', 'C1', 'E', 'F1', 'F1-recovered', 'F1-returned', 'F4', 'G1', 'G4', 'P1', 'P4', 'PM'].sort());
    expect(w.lines(back)).toContain('F1-returned <- F1-recovered (RECOVERED) @4');
    expect(w.lines(back)).toContain('C1 <- P1 (BULK_ISSUE) @7');
    expect(w.nodes(back)).not.toContain('B');
  });

  it('[PR-57] a forward trace from a component lot lists every consignee, matching an ERP extract', async () => {
    const rows = await w.trace('LOT', s.A.id, 'FORWARD');
    const ids = rows.filter((r) => r.node_kind === 'SHIPMENT').map((r) => r.node_id);
    const { rows: traced } = await db.app.query<{ consignee_code: string; lot_code: string; quantity: string; consignee_address: string; shipped_at: string; product_name: string; strength: string; dosage_form: string }>(
      `select consignee_code, lot_code, quantity::text, consignee_address, to_char(shipped_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as shipped_at,
              product_name, strength, dosage_form
         from site.erp_shipment where id = any ($1::uuid[]) order by shipment_no`,
      [ids],
    );
    // The ERP extract: what the ERP sent, in shipment-number order.
    const extract = [...sent].sort((a, b) => String(a['shipmentId']).localeCompare(String(b['shipmentId'])));
    expect(traced.map((t) => [t.consignee_code, t.lot_code, t.quantity, t.consignee_address])).toEqual(
      extract.map((p) => [p['consigneeCode'], p['lotNumber'], (p['quantity'] as { value: string }).value, p['consigneeAddress']]),
    );
    expect(new Set(traced.map((t) => t.consignee_code))).toEqual(new Set(['CUST-1', 'CUST-2', 'CUST-3']));
    // The distribution record's product fields are the eBMR's own (D-P6d-0-6), the date the ERP's.
    for (const t of traced) expect(t).toMatchObject({ product_name: 'Product GEN-500', strength: '500 mg', dosage_form: 'TABLET', shipped_at: '2026-09-21T14:13:20Z' });
  });

  it('[IN-07] from a finished batch, every input lot and every customer shipment', async () => {
    const back = await w.trace('BATCH', s.P1.id, 'BACKWARD');
    expect(back.filter((r) => r.node_kind === 'LOT').map((r) => w.names.get(r.node_id)).sort()).toEqual(['A', 'E', 'PM']);
    const fwd = await w.trace('BATCH', s.P1.id, 'FORWARD');
    const shipments = fwd.filter((r) => r.node_kind === 'SHIPMENT').map((r) => w.names.get(r.node_id)).sort();
    expect(shipments).toEqual(sent.filter((p) => p['lotNumber'] === s.F1.code).map((p) => `S:${String(p['shipmentId'])}`).sort());
    expect(shipments).toHaveLength(2);
  });

  it('[IN-29] from a defective API lot, every finished batch including those with recovered material', async () => {
    const rows = await w.trace('LOT', s.A.id, 'FORWARD');
    const finished = rows.filter((r) => r.node_kind === 'LOT' && [s.F1.id, s.F2.id, s.F4.id].includes(r.node_id)).map((r) => w.names.get(r.node_id)).sort();
    expect(finished).toEqual(['F1', 'F2', 'F4']);
    // F4 contains recovered material from F1's returned goods: the trace names that path.
    expect(w.lines(rows)).toEqual(expect.arrayContaining(['F1-recovered <- F1-returned (RECOVERED) @5', 'G4 <- F1-recovered (CONSUMED) @6']));
    // The suspension cascade follows the same recovered-material edge (recipe-core 1011): F4 is downstream of A.
    const { rows: down } = await db.admin.query<{ lots: string[] }>("select recipe.genealogy_downstream_lots('LOT', $1)::text[] as lots", [s.A.id]);
    expect(down[0]!.lots).toEqual(expect.arrayContaining([s.F1.id, s.F2.id, s.F4.id]));
    expect(down[0]!.lots).not.toContain(s.A.id);
    // Only the recovery of a lot on the path is followed: from the unrelated lot B (consumed by X, which made no finished
    // lot) nothing is downstream, F1's recovered material and F4 included (mutation triage, genealogy_downstream_lots#10, #11).
    const { rows: fromB } = await db.admin.query<{ lots: string[] }>("select recipe.genealogy_downstream_lots('LOT', $1)::text[] as lots", [s.B.id]);
    expect(fromB[0]!.lots).toEqual([]);
  });

  it('[PR-57] the as-of point: a trace as of an earlier instant leaves out what was recorded after it, and repeats exactly', async () => {
    const then = await w.trace('LOT', s.A.id, 'FORWARD', beforeSecondShipments);
    const names = w.nodes(then);
    expect(names).toContain(`S:${String(sent[1]!['shipmentId'])}`);
    expect(names).not.toContain(`S:${String(sent[2]!['shipmentId'])}`);
    expect(names).not.toContain('F1-returned');
    expect(names).not.toContain('F4');
    expect(w.lines(await w.trace('LOT', s.A.id, 'FORWARD', beforeSecondShipments))).toEqual(w.lines(then));
    // A node recorded after the instant cannot start a trace as of it; the future is refused.
    expect(await refusal(w.trace('LOT', s.F4.id, 'BACKWARD', beforeSecondShipments))).toMatch(/EBMR-GEN-002 there is no lot/);
    expect(await refusal(w.trace('LOT', s.A.id, 'FORWARD', '2999-01-01T00:00:00Z'))).toMatch(/EBMR-GEN-003/);
  });

  it('[PR-57] a cycle ends with each edge once, a genealogy deeper than 64 levels is refused rather than cut short, and bad input is refused', async () => {
    const b = await w.batch('CYC');
    const c5 = await w.container('C5', b);
    const c6 = await w.container('C6', b);
    await w.merge(c5, c6);
    await w.merge(c6, c5);
    const rows = await w.trace('BATCH', b.id, 'FORWARD');
    expect(w.lines(rows)).toEqual(['C5 <- C6 (MERGED) @1', 'C5 <- CYC (OUTPUT) @1', 'C6 <- C5 (MERGED) @1', 'C6 <- CYC (OUTPUT) @1', 'CYC <- - (-) @0']);
    // A chain of 66 whole-batch reprocessings.
    const chain: Batch[] = [await w.batch('D0')];
    for (let i = 1; i <= 66; i += 1) {
      chain.push(await w.batch(`D${i.toString()}`));
      await w.reprocessed(chain[i - 1]!, chain[i]!);
    }
    expect((await w.trace('BATCH', chain[2]!.id, 'FORWARD')).length).toBe(65);
    expect(await refusal(w.trace('BATCH', chain[0]!.id, 'FORWARD'))).toMatch(/EBMR-GEN-004 .* deeper than 64 levels/);
    expect(await refusal(w.trace('BATCH', chain[66]!.id, 'BACKWARD'))).toMatch(/EBMR-GEN-004/);
    expect(await refusal(w.trace('LOT', s.A.id, 'SIDEWAYS' as 'FORWARD'))).toMatch(/EBMR-GEN-001/);
    expect(await refusal(w.trace('PALLET' as 'LOT', s.A.id, 'FORWARD'))).toMatch(/EBMR-GEN-002/);
    expect(await refusal(w.trace('BATCH', s.A.id, 'FORWARD'))).toMatch(/EBMR-GEN-002 there is no batch/);
  });

  it('[PR-57] the genealogy has no table of its own and the application role cannot write the edges or call the internal step', async () => {
    expect((await db.admin.query("select count(*)::int as n from pg_tables where schemaname = 'recipe' and tablename like '%genealog%'")).rows[0]).toEqual({ n: 0 });
    expect(await refusal(db.app.query("select * from recipe.genealogy_step(array['LOT'], array[$1::uuid], 'FORWARD', now())", [s.A.id]))).toMatch(/permission denied/);
    expect(await refusal(db.app.query('insert into site.chemical_recovery (returned_lot_id, recovered_lot_id, assessment_id, returned_quantity, returned_unit, process_reference, recorded_by_person, recorded_by_account, correlation_id) values ($1, $2, gen_random_uuid(), 1, \'units\', \'x\', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', [s.R.id, s.A.id]))).toMatch(/permission denied/);
    expect(await refusal(db.app.query("update site.erp_shipment set consignee_address = 'elsewhere'"))).toMatch(/permission denied/);
  });
});

describe('performance (outline risk 6)', () => {
  it('[PR-57] the genealogy of a seeded large site is traced within seconds', async () => {
    // One excipient lot consumed by 300 batches; each batch with 10 containers, 2 packaging orders (one bulk container
    // each), their finished lots, and the batch's input lots (3 more each).
    const common = await w.materialLot('COMMON', 'EXCIPIENT', 'EXC-COMMON');
    await w.fixture(
      `with b as (select gen_random_uuid() as id, 'PERF-' || g || '-T' as number from generate_series(1, 300) g),
            e as (insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint, policy,
                                                      policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person,
                                                      issued_by_account, correlation_id)
                  select b.id, b.number, repeat('a', 64), repeat('a', 64), 'SANDBOX', 'SANDBOX_TEST_RUN', '1', repeat('a', 64), '{}', repeat('a', 64), '{}', '{IN}', 'BS',
                         'SITE-1', 'Asia/Kolkata', 0, gen_random_uuid(), gen_random_uuid(), gen_random_uuid() from b returning id, batch_number),
            c as (insert into site.lot_consumption (lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after,
                                                    market_set, identity_basis, consumed_by_person, consumed_by_account, xact_id)
                  select $1, gen_random_uuid(), e.id, e.batch_number, 'TABLETS', 'EXC-COMMON', 1, 'kg', 1000, 999, '{IN}', 'INTERMEDIATE', gen_random_uuid(), gen_random_uuid(), 1 from e returning batch_id)
       insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, quantity_unit, opened_by_person, opened_by_account)
       select gen_random_uuid(), 'OC-' || e.batch_number || '-' || lpad(k::text, 4, '0'), e.id, e.batch_number, 'GEN-500', '500 mg', 'COMPRESSION', 'kg', gen_random_uuid(), gen_random_uuid()
         from e, generate_series(1, 10) k`,
      [common.id],
    );
    await w.fixture(
      `with o as (select c.batch_id as parent, gen_random_uuid() as order_id, c.id as container, row_number() over (partition by c.batch_id order by c.label_code) as k
                    from plant.output_container c join site.lot_consumption x on x.batch_id = c.batch_id and x.lot_id = $1),
            o2 as materialized (select * from o where k <= 2),
            ch as (insert into plant.container_charge (container_id, batch_id, stage, purpose, scanned_label, person_id, account_id)
                   select o2.container, o2.order_id, 'PACKAGING', 'PACK', 'x', gen_random_uuid(), gen_random_uuid() from o2 returning id, container_id, batch_id),
            bi as (insert into recipe.packaging_bulk_issue (order_batch_id, parent_batch_id, container_id, charge_id, quantity, unit, person_id, account_id)
                   select ch.batch_id, o2.parent, ch.container_id, ch.id, 1, 'kg', gen_random_uuid(), gen_random_uuid() from ch join o2 on o2.container = ch.container_id returning order_batch_id),
            ml as (insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                                  received_by_person, received_by_account, correlation_id)
                   select gen_random_uuid(), 'SITE-1', 'PERF-F-' || upper(left(replace(bi.order_batch_id::text, '-', ''), 24)), 'GEN-500', 'Perf tablets', 'FINISHED', 1000, 'units',
                          '2030-01-01T00:00:00Z', gen_random_uuid(), gen_random_uuid(), bi.order_batch_id from bi returning id, correlation_id)
       insert into site.finished_lot (lot_id, batch_id, batch_number, edition, product_code, strength, markets, posted_by_person, posted_by_account)
       select ml.id, ml.correlation_id, 'PERF-P', 'TABLETS', 'GEN-500', '500 mg', '{IN}', gen_random_uuid(), gen_random_uuid() from ml`,
      [common.id],
    );
    await w.fixture(
      `with x as (select batch_id from site.lot_consumption where lot_id = $1),
            l as (insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                                  received_by_person, received_by_account, correlation_id)
                  select gen_random_uuid(), 'SITE-1', 'PERF-I-' || upper(left(replace(x.batch_id::text, '-', ''), 24)) || '-' || k, 'API-PERF', 'Perf API', 'API', 1000, 'kg',
                         '2030-01-01T00:00:00Z', gen_random_uuid(), gen_random_uuid(), x.batch_id from x, generate_series(1, 3) k returning id, correlation_id)
       insert into site.lot_consumption (lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after,
                                         market_set, identity_basis, consumed_by_person, consumed_by_account, xact_id)
       select l.id, gen_random_uuid(), l.correlation_id, 'PERF', 'TABLETS', 'API-PERF', 1, 'kg', 1000, 999, '{IN}', 'INTERMEDIATE', gen_random_uuid(), gen_random_uuid(), 1 from l`,
      [common.id],
    );
    const t0 = process.hrtime.bigint();
    const fwd = await w.trace('LOT', common.id, 'FORWARD');
    const t1 = process.hrtime.bigint();
    const lot = fwd.find((r) => r.node_kind === 'LOT' && r.depth === 4)!;
    const back = await w.trace('LOT', lot.node_id, 'BACKWARD');
    const t2 = process.hrtime.bigint();
    expect(fwd.filter((r) => r.node_kind === 'BATCH' && r.depth === 1)).toHaveLength(300);
    expect(fwd.filter((r) => r.node_kind === 'CONTAINER')).toHaveLength(3000);
    expect(fwd.filter((r) => r.node_kind === 'LOT' && r.depth === 4)).toHaveLength(600);
    // Backward from one finished lot: its order, the bulk container, the batch, the common lot and the batch's own three API lots.
    expect(back.filter((r) => r.node_kind === 'LOT' && r.depth > 0)).toHaveLength(4);
    const ms = (a: bigint, b: bigint) => Number((b - a) / 1_000_000n);
    expect(ms(t0, t1), `forward trace of ${fwd.length.toString()} edges`).toBeLessThan(5000);
    expect(ms(t1, t2)).toBeLessThan(2000);
  }, 120_000);
});
