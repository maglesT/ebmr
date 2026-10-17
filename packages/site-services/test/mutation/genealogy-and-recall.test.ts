/**
 * The genealogy, the mock recall and the deviation impact query, rule by rule (SQL mutation group
 * "genealogy-and-recall": recipe-core 1010 to 1012, 1090, 1091). The scenario tests (genealogy/*.test.ts) show each
 * working; these take the rules the Phase 6 mutation run found unproven, where a change could silently drop a lot, a
 * consignee or a depth level from a recall, or loosen the AP's sign-off:
 *
 * - the as-of point is inclusive everywhere: in a world where every event happened at one instant T, the genealogy,
 *   the mock recall and the impact query as of exactly T hold every edge, lot and batch (an exclusive comparison would
 *   drop them, PR-57, IN-29, PR-50); every edge kind is checked one node at a time in both directions, with decoys (a
 *   package not sealed, a container charged into its own batch) that must not become edges, and the recall's
 *   reconciliation counts each lot's own deliveries and returns only;
 * - a trace starts only from a node that exists as of the instant, of every kind (PR-57);
 * - the AP's sign-off of a mock recall: an unknown run, a run that no longer reproduces, a signer in another role than
 *   the AP's, and the state another run's content is signed in (IN-29, DI-37).
 *
 * Fixtures, not proofs, as in genealogy/world.ts: event rows are written by the superuser with triggers off; the
 * instant T is set the same way (session_replication_role = replica bypasses the database-time triggers).
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import { signFor } from '../../../kernel/test/records/helpers.ts';
import { createTestDatabase, signerActor, type TestDatabase } from '../helpers.ts';
import { GenealogyWorld, refusal, unique, type Batch, type Lot } from '../genealogy/world.ts';

/** The one instant every event of the instant world happened at (whole seconds: issued_at_us goes through to_timestamp). */
const T = '2025-06-01T08:00:00Z';
const T_PLUS = '2025-06-01T08:00:01Z';
const FUTURE = '2999-01-01T00:00:00Z';

let db: TestDatabase;
let w: GenealogyWorld;

// The instant world.
let A: Lot;
let E: Lot;
let F1: Lot;
let RET: Lot;
let REC: Lot;
let LIN: Lot;
let G1: Batch;
let G2: Batch;
let H: Batch;
let R: Batch;
let X: Batch;
let Y: Batch;
let K: Batch;
let P1: Batch;
let B6: Batch;
let B10: Batch;
let C1 = '';
let C2 = '';
let C3 = '';
let S1 = '';
let S2 = '';
let TP = '';
let TU = '';
let TIN = '';
let D = '';

/** [from kind, from id, to kind, to id, edge] in the FORWARD orientation. */
type Edge = [string, string, string, string, string];
let EDGES: Edge[] = [];
let NODES: [string, string][] = [];

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const SEAL = `${'A'.repeat(85)}A==`;

async function transferPackage(lot: Lot, sealed: boolean): Promise<string> {
  const id = randomUUID();
  const payload = `package ${id}`;
  await w.fixture(
    `insert into site.transfer_package (id, package_no, lot_id, origin_installation, destination_installation, quantity, unit, payload, payload_sha256,
                                        prepared_by_person, prepared_by_account, correlation_id)
     values ($1, $2, $3, 'INST-A', 'INST-B', 10, 'units', $4, $5, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    [id, unique('TP'), lot.id, payload, sha(payload)],
  );
  if (sealed) {
    await w.fixture(
      `insert into site.transfer_package_seal (package_id, seal, key_fingerprint, sealed_by_person, sealed_by_account)
       values ($1, $2, $3, gen_random_uuid(), gen_random_uuid())`,
      [id, SEAL, sha('key')],
    );
  }
  return id;
}

async function transferReceipt(lot: Lot): Promise<string> {
  const packageId = randomUUID();
  const payload = `inbound ${packageId}`;
  await w.fixture(
    `insert into site.transfer_receipt (package_id, package_no, origin_installation, origin_lot_id, origin_lot_code, origin_state, payload, payload_sha256, seal,
                                        key_fingerprint, lot_id, hold_until, markets, received_by_person, received_by_account, correlation_id)
     values ($1, $2, 'INST-C', gen_random_uuid(), 'ORIGIN-LOT', 'RELEASED', $3, $4, $5, $6, $7, '2030-01-01T00:00:00Z', '{IN}',
             gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    [packageId, unique('TIN'), payload, sha(payload), SEAL, sha('key'), lot.id],
  );
  return w.name(packageId, 'TIN');
}

async function charge(container: string, batch: Batch): Promise<void> {
  await w.fixture(
    `insert into plant.container_charge (container_id, batch_id, stage, purpose, scanned_label, person_id, account_id)
     select $1, $2, 'BLENDING', 'CHARGE', o.label_code, gen_random_uuid(), gen_random_uuid() from plant.output_container o where o.id = $1`,
    [container, batch.id],
  );
}

async function raise(title: string): Promise<{ deviationId: string; ref: string }> {
  return w.run(w.operator, 'select site.raise_deviation($1::jsonb) as r', [JSON.stringify({ kind: 'DEVIATION', title, classification: 'MINOR', riskRationale: 'A minor deviation for the test' })]);
}
const link = (d: string, kind: string, id: string) => w.run(w.operator, 'select site.link_deviation($1, $2, $3)::text as r', [d, kind, id]);

const STAMPED: [string, string][] = [
  ['site.material_lot', 'received_at'], ['site.lot_consumption', 'consumed_at'], ['site.returned_goods', 'received_at'],
  ['site.chemical_recovery', 'recorded_at'], ['site.erp_shipment', 'recorded_at'], ['site.transfer_package_seal', 'sealed_at'],
  ['site.transfer_receipt', 'received_at'], ['plant.output_container', 'opened_at'], ['recipe.batch_parent_link', 'recorded_at'],
  ['recipe.source_addition', 'recorded_at'], ['recipe.batch_allocation_link', 'recorded_at'], ['site.finished_lot', 'posted_at'],
  ['plant.container_merge', 'recorded_at'], ['recipe.packaging_bulk_issue', 'recorded_at'], ['plant.container_charge', 'recorded_at'],
  ['site.deviation', 'raised_at'], ['site.deviation_link', 'linked_at'],
];

beforeAll(async () => {
  db = await createTestDatabase();
  w = await GenealogyWorld.create(db);
  A = await w.materialLot('A', 'API', 'API-1');
  E = await w.materialLot('E', 'EXCIPIENT', 'EXC-1');
  LIN = await w.materialLot('LIN', 'API', 'API-1');
  G1 = await w.batch('G1', 'INS-500');
  G2 = await w.batch('G2', 'INS-500');
  H = await w.batch('H', 'INS-500');
  R = await w.batch('R', 'INS-500');
  X = await w.batch('X', 'INS-500');
  Y = await w.batch('Y', 'INS-500');
  K = await w.batch('K', 'INS-500');
  P1 = await w.batch('P1', 'INS-500', G1);
  B6 = await w.batch('B6', 'INS-500');
  B10 = await w.batch('B10', 'INS-500');
  await w.consume(A, G1);
  await w.consume(E, G1);
  await w.consume(E, G2);
  await w.consume(E, H);
  C1 = await w.container('C1', G1);
  C2 = await w.container('C2', G2);
  C3 = await w.container('C3', G2);
  await w.merge(C2, C3);
  await w.bulkIssue(C1, G1, P1);
  await charge(C2, K);
  await charge(C3, G2); // into its own batch: no edge
  await w.reprocessed(G1, R);
  await w.addition(G1, X, C1, 'REPROCESSING_ADDITION');
  await w.addition(G2, Y, C2, 'RECOVERY');
  F1 = await w.finishedLot('F1', P1);
  await w.released(F1);
  S1 = (await w.ship(F1, 'CUST-1', '300')).shipmentId;
  S2 = (await w.ship(F1, 'CUST-2', '200')).shipmentId;
  ({ returned: RET, recovered: REC } = await w.recover('F1', F1, '100'));
  TP = w.name(await transferPackage(F1, true), 'TP');
  TU = w.name(await transferPackage(F1, false), 'TU');
  TIN = await transferReceipt(LIN);
  const d = await raise('Excipient grade suspected');
  D = d.deviationId;
  await link(D, 'BATCH', G1.id);
  await link(D, 'BATCH', G2.id);
  await link(D, 'LOT', F1.id);
  // Every event at T.
  for (const [table, column] of STAMPED) await w.fixture(`update ${table} set ${column} = $1::timestamptz`, [T]);
  await w.fixture('update recipe.batch_execution set issued_at_us = (extract(epoch from $1::timestamptz) * 1000000)::bigint', [T]);
  // B6 is issued at T and linked to its allocation a second later; B10 the other way round.
  await w.fixture('update recipe.batch_allocation_link set recorded_at = $2::timestamptz where batch_id = $1', [B6.id, T_PLUS]);
  await w.fixture('update recipe.batch_execution set issued_at_us = (extract(epoch from $2::timestamptz) * 1000000)::bigint where id = $1', [B10.id, T_PLUS]);

  EDGES = [
    ['LOT', A.id, 'BATCH', G1.id, 'CONSUMED'], ['LOT', E.id, 'BATCH', G1.id, 'CONSUMED'], ['LOT', E.id, 'BATCH', G2.id, 'CONSUMED'],
    ['LOT', E.id, 'BATCH', H.id, 'CONSUMED'],
    ['BATCH', G1.id, 'CONTAINER', C1, 'OUTPUT'], ['BATCH', G2.id, 'CONTAINER', C2, 'OUTPUT'], ['BATCH', G2.id, 'CONTAINER', C3, 'OUTPUT'],
    ['CONTAINER', C2, 'CONTAINER', C3, 'MERGED'], ['CONTAINER', C1, 'BATCH', P1.id, 'BULK_ISSUE'], ['CONTAINER', C2, 'BATCH', K.id, 'CHARGED'],
    ['BATCH', G1.id, 'BATCH', R.id, 'REPROCESSED'], ['BATCH', G1.id, 'BATCH', X.id, 'REPROCESSING_ADDITION'], ['BATCH', G2.id, 'BATCH', Y.id, 'RECOVERY_ADDITION'],
    ['BATCH', G1.id, 'BATCH', P1.id, 'PACKAGING_ORDER'], ['BATCH', P1.id, 'LOT', F1.id, 'FINISHED'],
    ['LOT', F1.id, 'SHIPMENT', S1, 'SHIPPED'], ['LOT', F1.id, 'SHIPMENT', S2, 'SHIPPED'],
    ['LOT', F1.id, 'LOT', RET.id, 'RETURNED'], ['LOT', RET.id, 'LOT', REC.id, 'RECOVERED'],
    ['LOT', F1.id, 'TRANSFER', TP, 'TRANSFERRED'], ['TRANSFER', TIN, 'LOT', LIN.id, 'TRANSFER_RECEIVED'],
  ];
  NODES = [
    ...[A, E, F1, RET, REC, LIN].map((l): [string, string] => ['LOT', l.id]),
    ...[G1, G2, H, R, X, Y, K, P1].map((b): [string, string] => ['BATCH', b.id]),
    ...[C1, C2, C3].map((c): [string, string] => ['CONTAINER', c]),
    ...[S1, S2].map((s): [string, string] => ['SHIPMENT', s]),
    ...[TP, TU, TIN].map((t): [string, string] => ['TRANSFER', t]),
  ];
}, 300_000);
afterAll(async () => {
  await db?.drop();
});

const nm = (id: string): string => w.names.get(id) ?? id;
const line = (fk: string, fi: string, tk: string, ti: string, e: string): string => `${fk}:${nm(fi)} -> ${tk}:${nm(ti)} ${e}`;

async function step(kind: string, id: string, direction: 'FORWARD' | 'BACKWARD', asOf: string): Promise<string[]> {
  const { rows } = await db.admin.query<{ from_kind: string; from_id: string; to_kind: string; to_id: string; edge_kind: string }>(
    'select * from recipe.genealogy_step(array[$1]::text[], array[$2]::uuid[], $3, $4::timestamptz)', [kind, id, direction, asOf]);
  return rows.map((r) => line(r.from_kind, r.from_id, r.to_kind, r.to_id, r.edge_kind)).sort();
}

const trace = (kind: string, id: string, direction = 'FORWARD', asOf: string | null = T) =>
  db.app.query<{ node_kind: string; node_id: string; depth: number }>('select * from recipe.genealogy($1, $2, $3, $4::timestamptz)', [kind, id, direction, asOf]);

describe('the as-of point is inclusive: every event at T is in a trace as of T (PR-57)', () => {
  it('[PR-57][IN-29] every edge kind, from each node in both directions as of the instant it happened, and nothing else (no unsealed package, no charge into the own batch)', async () => {
    for (const [kind, id] of NODES) {
      const forward = EDGES.filter((e) => e[0] === kind && e[1] === id).map((e) => line(e[0], e[1], e[2], e[3], e[4])).sort();
      const backward = EDGES.filter((e) => e[2] === kind && e[3] === id).map((e) => line(e[2], e[3], e[0], e[1], e[4])).sort();
      expect([nm(id), await step(kind, id, 'FORWARD', T)]).toEqual([nm(id), forward]);
      expect([nm(id), await step(kind, id, 'BACKWARD', T)]).toEqual([nm(id), backward]);
    }
    // The world is complete: a full trace forward of A as of T reaches every lot, shipment and the outbound transfer.
    const { rows } = await trace('LOT', A.id);
    expect([...new Set(rows.map((r) => nm(r.node_id)))].sort()).toEqual(
      ['A', 'C1', 'F1', 'F1-recovered', 'F1-returned', 'G1', 'P1', 'R', 'TP', 'X', ...[S1, S2].map(nm)].sort());
  });

  it('[PR-57] a trace starts from a node of each kind that exists as of the instant it came to be, and from nothing else', async () => {
    for (const [kind, id] of [['LOT', A.id], ['CONTAINER', C1], ['SHIPMENT', S1], ['TRANSFER', TP], ['TRANSFER', TIN], ['BATCH', B6.id], ['BATCH', B10.id]] as const) {
      expect([kind, nm(id), (await trace(kind, id)).rows[0]]).toMatchObject([kind, nm(id), { node_kind: kind, node_id: id, depth: 0 }]);
    }
    // No node of that id, or a package prepared but never sealed nor received here.
    for (const [kind, id] of [['LOT', randomUUID()], ['BATCH', randomUUID()], ['CONTAINER', randomUUID()], ['SHIPMENT', randomUUID()], ['TRANSFER', randomUUID()], ['TRANSFER', TU]]) {
      expect([kind, await refusal(trace(kind!, id!, 'FORWARD', null))]).toEqual([kind, expect.stringMatching(/EBMR-GEN-002 there is no/)]);
    }
  });

  it('[IN-29][PR-57] a mock recall as of T holds every lot with its deliveries in the lot\'s unit and its own returns only, and the outbound transfer', async () => {
    const id = await w.run<string>(w.cast.qa, 'select recipe.run_mock_recall($1, $2, $3::timestamptz, false, null)::text as r', ['LOT', A.id, T]);
    const { rows } = await db.app.query<{ result: { lots: { lot_id: string; depth: number; delivered: string; returned: string; outstanding: string }[]; transfers: { transfer_id: string }[] } }>(
      'select result from recipe.mock_recall where id = $1', [id]);
    const r = rows[0]!.result;
    expect(r.lots.map((l) => [nm(l.lot_id), l.depth, l.delivered, l.returned, l.outstanding])).toEqual([
      ['A', 0, '0', '0', '0'], ['F1', 3, '500', '100', '400'], ['F1-returned', 4, '0', '0', '0'], ['F1-recovered', 5, '0', '0', '0'],
    ]);
    expect(r.transfers.map((t) => nm(t.transfer_id))).toEqual(['TP']);
    // From the deviation raised and linked at T.
    const fromDeviation = await w.run<string>(w.cast.qa, 'select recipe.run_mock_recall($1, $2, $3::timestamptz, false, null)::text as r', ['DEVIATION', D, T]);
    const dev = (await db.app.query<{ result: { batches: { batch_id: string }[] } }>('select result from recipe.mock_recall where id = $1', [fromDeviation])).rows[0]!.result;
    expect(dev.batches.map((b) => nm(b.batch_id)).sort()).toEqual(['G1', 'G2', 'K', 'P1', 'R', 'X', 'Y']);
  });

  it('[PR-50] the impact query as of T: two linked batches and a linked finished lot, what is downstream of them, and the other consumers of their input lots', async () => {
    const { rows } = await db.app.query<{ batch_id: string; relation: string }>('select batch_id, relation from recipe.deviation_impact_batches($1, $2::timestamptz)', [D, T]);
    expect(rows.map((r) => `${r.relation} ${nm(r.batch_id)}`).sort()).toEqual(
      ['LINKED G1', 'LINKED G2', 'LINKED P1', 'DOWNSTREAM K', 'DOWNSTREAM R', 'DOWNSTREAM X', 'DOWNSTREAM Y', 'SHARED_LOT H'].sort());
    expect(await refusal(db.app.query('select * from recipe.deviation_impact_batches($1, $2::timestamptz)', [D, FUTURE]))).toMatch(/EBMR-RCL-002/);
  });
});

describe('the AP\'s sign-off of a mock recall (IN-29, DI-37)', () => {
  let N: Lot;
  const runNow = () => w.run<string>(w.cast.qa, 'select recipe.run_mock_recall($1, $2, null, false, null)::text as r', ['LOT', N.id]);
  const signOff = (actor: SeededActor, id: string, sig: string) => w.run<string>(actor, 'select recipe.sign_off_mock_recall($1, $2)::text as r', [id, sig]);
  const content = async (id: string) => (await db.admin.query<{ s: string }>("select recipe.mock_recall_content($1) ->> 'state' as s", [id])).rows[0]!.s;

  beforeAll(async () => {
    N = await w.materialLot('N', 'API', 'API-5');
    await w.consume(N, await w.batch('NB', 'NOW-500'));
  });

  it('[IN-29] an unknown run is refused for itself', async () => {
    expect(await refusal(signOff(w.ap, randomUUID(), randomUUID()))).toMatch(/EBMR-RCL-010/);
  });

  it('[IN-29][DI-37] signing one run off leaves another in state RUN, so the other is still signed in the state it is in', async () => {
    const first = await runNow();
    const second = await runNow();
    const sig = await signFor(db, w.ap, { type: 'mock_recall', id: first }, 'MOCK_RECALL_SIGNED_OFF', 'RUN');
    expect(await signOff(w.ap, first, sig)).toMatch(/^[0-9a-f-]{36}$/);
    expect([await content(first), await content(second)]).toEqual(['SIGNED_OFF', 'RUN']);
  });

  it('[IN-29][DI-37] a run that no longer reproduces as of its own instant (a transaction straddled it) is not signed off, even with a valid signature', async () => {
    const id = await runNow();
    const asOf = (await db.admin.query<{ t: string }>('select as_of::text as t from recipe.mock_recall where id = $1', [id])).rows[0]!.t;
    // A consumption committed after the run but stamped before its as-of point.
    await w.fixture(
      `insert into site.lot_consumption (lot_id, reservation_id, batch_id, batch_number, edition, material_code, quantity, unit, quantity_before, quantity_after,
                                         market_set, identity_basis, consumed_by_person, consumed_by_account, xact_id, consumed_at)
       select $1, gen_random_uuid(), $2, 'NB2', 'TABLETS', 'API-5', 1, 'kg', 1000, 999, '{IN}', 'INTERMEDIATE', gen_random_uuid(), gen_random_uuid(), 1, $3::timestamptz - interval '1 second'`,
      [N.id, (await w.batch('NB2', 'NOW-500')).id, asOf],
    );
    expect((await db.app.query<{ r: boolean }>('select recipe.mock_recall_reproduces($1) as r', [id])).rows[0]!.r).toBe(false);
    const sig = await signFor(db, w.ap, { type: 'mock_recall', id }, 'MOCK_RECALL_SIGNED_OFF', 'RUN');
    expect(await refusal(signOff(w.ap, id, sig))).toMatch(/EBMR-RCL-012/);
  });

  // Last in the file: it gives a second role the sign-off permission.
  it('[IN-29] a signer holding the sign-off permission through another role than the AP\'s is refused', async () => {
    await w.fixture("insert into iam.role_permission (role_code, permission_code) values ('QA_REVIEWER', 'RECALL.MOCK_SIGN_OFF') on conflict do nothing");
    const qa = await signerActor(db, 'QA_REVIEWER', 'QA reviewer given the sign-off');
    const id = await runNow();
    const sig = await signFor(db, qa, { type: 'mock_recall', id }, 'MOCK_RECALL_SIGNED_OFF', 'RUN');
    expect(await refusal(signOff(qa, id, sig))).toMatch(/EBMR-RCL-013/);
  });
});
