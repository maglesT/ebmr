/**
 * Phase 4 slice 2c (recipe-core 0760 to 0762): a packaging order planned over HTTP from an issued processing batch, its
 * read on the planning screens, its issue, and its bulk read and issue. Every rule is the database's (the packaging
 * number of the processing batch, the master's secondary-packaging step, the release for packing before bulk); the
 * routes only carry them. Run as the application role through the routes, in the seed personas' own sessions.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type SignatureCredentials } from '@ebmr/api-contract';
import { sha256Hex } from '@ebmr/expr';
import { toDbContext, withCommand } from '@ebmr/kernel';
import { freshTap, openPersonaSession, openServiceSession } from '@ebmr/test-kit';
import { flow } from '@ebmr/recipe-core';
import { cell, reason } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { personaIn, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { G21_CONFIG } from '../blocks/packaging/db-support.ts';
import { asSetup } from '../blocks/compression/plant-support.ts';
import { actorOf, gmpLifecycleWorld, INPUTS, LINE, SITE, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';

type Json = Record<string, unknown>;
let w: GmpBatchWorld;
let issuer: TestBrowser;
let operator: TestBrowser;
let parentId: string;
let parentNumber: string;
let packFamilyId: string;
let packContent: flow.MbrContent;

const PACK_SIZE = 'PO-100K';
const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };

/** The processing master as a packaging master of the same product: its pack type and a TB-24 cartoning step first. */
function packagingContent(base: flow.MbrContent): flow.MbrContent {
  const m = JSON.parse(JSON.stringify(base)) as Json;
  const header = m['header'] as Json;
  header['family'] = `${String(header['family'])}-PK`;
  header['recordKind'] = 'PACKAGING';
  header['packType'] = 'ALU-PVC-BLISTER';
  // A pack count, so the ERP order of the packaging order matches the packaging master only.
  header['batchSizes'] = [{ id: PACK_SIZE, quantity: { value: '100000', unit: '{tbl}' } }];
  const stage = ((((m['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
  const prep = ((stage['children'] as Json[])[0] as Json)['body'] as Json;
  const phase = (id: string, type: string, config: Json, signatures: Json = SIGNATURES): Json => ({
    kind: 'phase', id, name: `Packing step ${id}`, block: { type, version: '1' }, config,
    records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [], signatures, significant: true, riskClass: 'HIGH',
  });
  const tb24 = phase('p-tb24', 'TB-24', {
    unit: 'TEST-LINE-CTN-P1', devices: [{ id: 'CW', kind: 'CHECKWEIGHER' }], examination: { every: { value: '1', unit: 'h' }, inRunSample: '5', endSample: '20' },
    cartonsPerShipper: '20', ssccPrefix: '089012345', printedStep: 'p-g21',
  });
  // As the packing-gate test arranges it (tablets 1102): printed materials (G-21), cartoning (TB-24) and coded surplus (G-23).
  prep['children'] = [
    {
      kind: 'parallel', id: 'par-pack',
      branches: [
        { id: 'br-g21', name: 'Printed materials', body: phase('p-g21', 'G-21', G21_CONFIG) },
        { id: 'br-tb24', name: 'Cartoning', body: tb24 },
        { id: 'br-destroy', name: 'Coded surplus', body: phase('p-destroy', 'G-23', {}, { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } }) },
      ],
    },
    ...(prep['children'] as Json[]),
  ];
  const parsed = flow.parseMbr(m);
  if (!parsed.ok) throw new Error(`the packaging master does not parse: ${JSON.stringify(parsed.problems.slice(0, 3))}`);
  return parsed.mbr;
}

beforeAll(async () => {
  w = await startGmpBatchWorld();
  [issuer, operator] = await Promise.all([w.gmp.asPersona('issuer'), w.gmp.asPersona('operator1')]);
  parentId = await w.issued(issuer);
  parentNumber = (await w.gmp.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [parentId])).rows[0]?.n ?? '';
  // The packaging master of the product: approved and authorised at the site, line and size; its packaging numbering rule.
  const world = await gmpLifecycleWorld(w.gmp);
  packContent = packagingContent(w.content);
  const v = await world.approvedVersion(packContent);
  await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, PACK_SIZE)], regulatoryBasis: 'IN: registration on file' });
  packFamilyId = v.familyId;
  const steward = await actorOf(w.gmp, 'steward');
  await world.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `P-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: packContent.header.product.code, batch_kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
    reason('packaging numbering rule for the test'),
  );
}, 600_000);
afterAll(async () => {
  await w?.close();
});

const password = (k: string): SignatureCredentials => ({ kind: 'PASSWORD', loginName: personaIn(w.gmp, k).loginName, password: personaIn(w.gmp, k).password });

describe('packaging orders over HTTP (Phase 4 slice 2c)', () => {
  it('[INV-27][IN-18] a packaging order is planned over HTTP from an issued processing batch: the planning read offers the packaging master with its pack type and parent batches, the plan takes the register\'s packaging number of that batch, an unknown parent is refused, and the order is issued like any batch', async () => {
    const orderNo = await postOrder(w.gmp.db.app, await openServiceSession(w.gmp.db, w.gmp.seed, 'erpInterface'), packContent, PACK_SIZE);
    const card = valueOf(await issuer.call(routes.planning.orders)).orders.find((o) => o.orderNo === orderNo);
    expect(card?.match).toMatchObject({ familyId: packFamilyId, recordKind: 'PACKAGING', packType: 'ALU-PVC-BLISTER', parents: [expect.objectContaining({ batchId: parentId, batchNumber: parentNumber, releaseForPackingProblem: (expect.stringMatching(/H-PACK/) as unknown) })] });
    const body = { familyId: packFamilyId, markets: ['IN'], site: SITE, line: LINE, batchSize: PACK_SIZE, erpOrder: orderNo };
    expect(refusalOf(await issuer.call(routes.planning.planPackagingOrder, { body: { ...body, parentBatchId: randomUUID() } })).code).toBe('EBMR-EXE-198');
    // A processing batch's own planning route plans no packaging order (it names no parent).
    expect(refusalOf(await issuer.call(routes.execution.planBatch, { body: { familyId: packFamilyId, markets: ['IN'], site: SITE, line: LINE, batchSize: PACK_SIZE } })).code).toBe('EBMR-EXE-198');
    const planned = valueOf(await issuer.call(routes.planning.planPackagingOrder, { body: { ...body, parentBatchId: parentId } }));
    expect(planned).toMatchObject({ batchNumber: `${parentNumber}/P01`, familyCode: packContent.header.family, markets: ['IN'] });
    const listed = valueOf(await issuer.call(routes.planning.packagingOrders)).orders.find((o) => o.batchId === planned.batchId);
    expect(listed).toMatchObject({ status: 'PLANNED', packType: 'ALU-PVC-BLISTER', parentBatchId: parentId, parentBatchNumber: parentNumber, bulkContainers: 0 });
    // The issue: the issuer's ISSUED signature through the ceremony, as for any GMP batch.
    const preview = valueOf(await issuer.call(routes.esig.content, { query: { aggregateType: 'batch_issue', aggregateId: planned.batchId, intent: 'ISSUED' } }));
    const action = { kind: 'GMP_BATCH_ISSUE' as const, batchId: planned.batchId, reason: { code: 'PRODUCTION_PLAN', text: 'Packaging order issued for the plan' }, variants: {}, inputs: INPUTS };
    const challenge = valueOf(
      await issuer.call(routes.esig.createChallenge, { body: { aggregateType: 'batch_issue', aggregateId: planned.batchId, contentVersion: preview.contentVersion, meaning: 'ISSUED', clientContentHash: sha256Hex(preview.canonicalText), action } }),
    );
    const sign = { challengeId: challenge.challengeId, credentials: password('issuer'), action };
    valueOf(await issuer.call(routes.esig.sign, { body: { ...sign, proof: await issuer.proof('POST', '/api/esig/sign', sign) } }));
    expect(valueOf(await issuer.call(routes.planning.packagingOrders)).orders.find((o) => o.batchId === planned.batchId)?.status).toBe('ISSUED');
  }, 300_000);

  it('[IN-26][INV-27] the bulk read of a packaging order names its processing batch and why it is not released for packing; the bulk issue over HTTP is refused until then and records nothing; an unknown order is not found', async () => {
    const order = valueOf(await issuer.call(routes.planning.packagingOrders)).orders.find((o) => o.parentBatchId === parentId && o.status === 'ISSUED');
    expect(order).toBeDefined();
    const batchId = order?.batchId ?? '';
    const bulk = valueOf(await operator.call(routes.planning.packagingBulk, { params: { batchId } }));
    expect(bulk).toMatchObject({ batchId, orderProblem: null, parent: { batchId: parentId, batchNumber: parentNumber, releaseForPackingProblem: (expect.stringMatching(/H-PACK/) as unknown) }, issued: [], containers: [] });
    const body = { labels: [`OC-${parentNumber}-1001`] };
    const tap = await tapFor(operator, personaIn(w.gmp, 'operator1'), 'POST', `/api/batches/${batchId}/bulk`, body);
    const refused = refusalOf(await operator.call(routes.batches.issueBulk, { params: { batchId }, body, attribution: tap }));
    expect([refused.code, refused.why]).toEqual(['EBMR-PKG-002', (expect.stringMatching(/H-PACK/) as unknown)]);
    expect(valueOf(await operator.call(routes.planning.packagingBulk, { params: { batchId } })).issued).toEqual([]);
    expect(refusalOf(await operator.call(routes.planning.packagingBulk, { params: { batchId: randomUUID() } })).status).toBe(404);
    // The processing batch is no packaging order: its bulk read is not found either.
    expect(refusalOf(await operator.call(routes.planning.packagingBulk, { params: { batchId: parentId } })).status).toBe(404);
  }, 120_000);

  it('[PR-46][PR-57][PR-38] the bulk of a packaging order is the processing batch\'s final output only (its last stage\'s containers): earlier stages\' containers and the inspection rejects (a sort result\'s reject or a disposal\'s container) are neither offered nor issued, for every writer (R10 #4; tablets 1770)', async () => {
    const order = valueOf(await issuer.call(routes.planning.packagingOrders)).orders.find((o) => o.parentBatchId === parentId && o.status === 'ISSUED');
    const batchId = order?.batchId ?? '';
    // ARRANGED (the container commands, the engine and the hold point are proven elsewhere): QA released the batch for
    // packing (H-PACK), and its closed containers, in the order they were opened: granules, coated tablets, two inspection
    // reject containers (one destroyed by a disposal entry, one reusable residue named by the sort result) and the bulk.
    const [p] = (await w.gmp.db.admin.query<{ p: string; s: string }>("select recipe.batch_product(id) ->> 'code' as p, recipe.batch_product(id) ->> 'strength' as s from recipe.batch_execution where id = $1", [parentId])).rows;
    const made: Record<string, { id: string; label: string }> = {};
    for (const [n, [key, stage, unit, hoursAgo]] of ([['granules', 'GRANULATION', 'kg', 9], ['coated', 'COATING', 'kg', 7], ['destroyed', 'INSPECTION', 'kg', 5], ['residue', 'INSPECTION', 'kg', 4], ['bulk', 'INSPECTION', 'units', 3]] as const).entries()) {
      const id = randomUUID();
      const label = `OC-${parentNumber}-${String(7101 + n)}`;
      await asSetup(w.gmp, `with c as (insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, quantity_unit, opened_by_person, opened_by_account, opened_at)
                                       values ($1, $2, $3, $4, $5, $6, $7, $8, $1, $1, clock_timestamp() - make_interval(hours => $9::int)) returning id),
                                 x as (insert into plant.container_close (container_id, net_quantity, person_id, account_id, basis, weighing) select id, 10, id, id, 'WEIGHED', '{}'::jsonb from c returning container_id)
                            insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version)
                            select 'output_container', container_id, 'output_container', 1, 'RELEASED_BY_QA', 3 from x`,
        [id, label, parentId, parentNumber, p!.p, p!.s, stage, unit, hoursAgo]);
      made[key] = { id, label };
    }
    const entries = {
      'e-sort': { id: 'e-sort', stepKey: 'p-insp@', kind: 'SORT_RESULT', recordedSeq: 900001, data: { rejects: [{ category: 'DESTRUCTION', container: made['destroyed']!.id }, { category: 'REUSABLE_RESIDUE', container: made['residue']!.id }] } },
      'e-destroy': { id: 'e-destroy', stepKey: 'p-destroy@', kind: 'DISPOSAL', recordedSeq: 900002, data: { category: 'DESTRUCTION', container: made['destroyed']!.label } },
    };
    const hPack = { key: 'H-PACK@', step: 'H-PACK', status: 'COMPLETED', disposition: { value: 'APPROVED', positive: true }, signatures: [{ id: randomUUID(), meaning: 'QA_HOLD_POINT', role: 'HOLD_POINT', valid: true }] };
    await asSetup(w.gmp, `update recipe.execution_state set state = jsonb_set(state || jsonb_build_object('entries', coalesce(state -> 'entries', '{}'::jsonb) || $2::jsonb), '{steps,H-PACK@}', $3::jsonb)
                           where batch_id = $1`, [parentId, JSON.stringify(entries), JSON.stringify(hPack)]);
    // The read offers the bulk alone.
    const read = valueOf(await operator.call(routes.planning.packagingBulk, { params: { batchId } }));
    expect(read.parent?.releaseForPackingProblem).toBeNull();
    expect(read.containers.map((c) => [c.label, c.issueProblem])).toEqual([[made['bulk']!.label, null]]);
    // The issue of any other container is refused by the database, through the route and for a writer past it.
    const issue = async (label: string) => {
      const body = { labels: [label] };
      return operator.call(routes.batches.issueBulk, { params: { batchId }, body, attribution: await tapFor(operator, personaIn(w.gmp, 'operator1'), 'POST', `/api/batches/${batchId}/bulk`, body) });
    };
    for (const key of ['granules', 'coated', 'destroyed', 'residue']) {
      const r = refusalOf(await issue(made[key]!.label));
      expect([key, r.code, r.why]).toEqual([key, 'EBMR-PKG-007', expect.stringMatching(key === 'destroyed' || key === 'residue' ? /holds rejects of batch .*never packed/ : /not the bulk of batch .*last stage \(INSPECTION\)/)]);
    }
    const actor = { ...(await openPersonaSession(w.gmp.db, w.gmp.seed, 'operator2')), authEventId: await freshTap(w.gmp.db, w.gmp.seed, 'operator2'), reasonCode: 'TEST', reasonText: 'reject issue by a writer past the server' };
    const c = await w.gmp.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(actor))]);
      await expect(c.query('select recipe.issue_packaging_bulk($1, $2)', [batchId, [made['destroyed']!.label]])).rejects.toThrow(/EBMR-PKG-007 container .* holds rejects/);
    } finally {
      await c.query('rollback');
      c.release();
    }
    expect(valueOf(await operator.call(routes.planning.packagingBulk, { params: { batchId } })).issued).toEqual([]);
    // The bulk itself is issued.
    valueOf(await issue(made['bulk']!.label));
    expect(valueOf(await operator.call(routes.planning.packagingBulk, { params: { batchId } })).issued.map((i) => i.label)).toEqual([made['bulk']!.label]);
  }, 180_000);

  it('[INV-21][PR-38] the processing record locks when its bulk reconciliation closes, and it closes by itself at the first disposition of a lot packed from it once every packaging order is closed and no bulk is left (what is left is earlier stages\' output or rejects, held by the closure); with bulk left it stays open for production (R10 #5; tablets 1771)', async () => {
    const order = valueOf(await issuer.call(routes.planning.packagingOrders)).orders.find((o) => o.parentBatchId === parentId && o.bulkContainers > 0);
    const orderId = order?.batchId ?? '';
    const lockOf = async (batch: string) => (await w.gmp.db.admin.query<{ event: string; cause: string; lot_id: string | null }>('select event, cause, lot_id from recipe.record_lock_event where batch_id = $1 order by seq', [batch])).rows;
    // ARRANGED: the processing batch and its one packaging order complete (the engine's end is proven elsewhere), and one
    // more container of the last stage closed and never issued: bulk left over.
    await asSetup(w.gmp, "update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = any ($1::uuid[])", [[parentId, orderId]]);
    const [p] = (await w.gmp.db.admin.query<{ p: string; s: string }>("select recipe.batch_product(id) ->> 'code' as p, recipe.batch_product(id) ->> 'strength' as s from recipe.batch_execution where id = $1", [parentId])).rows;
    const spare = randomUUID();
    await asSetup(w.gmp, `with c as (insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, quantity_unit, opened_by_person, opened_by_account, opened_at)
                                     values ($1, $2, $3, $4, $5, $6, 'INSPECTION', 'units', $1, $1, clock_timestamp() - interval '2 hours') returning id),
                               x as (insert into plant.container_close (container_id, net_quantity, person_id, account_id, basis, weighing) select id, 10, id, id, 'WEIGHED', '{}'::jsonb from c returning container_id)
                          insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version)
                          select 'output_container', container_id, 'output_container', 1, 'RELEASED_BY_QA', 3 from x`,
      [spare, `OC-${parentNumber}-7106`, parentId, parentNumber, p!.p, p!.s]);
    expect(await lockOf(parentId)).toEqual([]);
    const ap = await actorOf(w.gmp, 'qcuAuthoriser');
    // With bulk left, production decides what happens to it (its own close, with the reason): nothing closes by itself.
    expect((await w.gmp.db.admin.query<{ r: boolean }>('select recipe.bulk_reconciliation_close_at_disposition($1, gen_random_uuid(), $2, $3) as r', [parentId, ap.personId, ap.accountId])).rows[0]?.r).toBe(false);
    expect(await lockOf(parentId)).toEqual([]);
    // ARRANGED: QA rejected the spare container; then the order's finished lot is released.
    await asSetup(w.gmp, "update platform.aggregate_state set state = 'REJECTED' where aggregate_type = 'output_container' and aggregate_id = $1", [spare]);
    const stores = await actorOf(w.gmp, 'stores');
    const lotId = await withCommand(w.gmp.db.admin, { ...stores, correlationId: randomUUID() }, async (c) =>
      (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
        JSON.stringify({ batchId: orderId, batchNumber: order?.batchNumber, edition: 'TABLETS', siteCode: SITE, productCode: w.content.header.product.code, productName: 'Bulk lock product',
                         strength: '500 mg', markets: ['IN'], quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
      ])).rows[0]!.id);
    // TEST FIXTURE: the decision row as the release act writes it (proven in the release tests), every trigger on but the departments' notice.
    await withCommand(w.gmp.db.admin, { ...ap, correlationId: randomUUID() }, async (c) => {
      await c.query('alter table recipe.manufacturer_release_decision disable trigger zzzn_notify_departments');
      await c.query(`insert into recipe.manufacturer_release_decision (lot_id, decision, signature_id, epoch, checklist, checklist_hash, content_hash, person_id, account_id, role_code, correlation_id)
                     values ($1, 'RELEASED', gen_random_uuid(), repeat('0', 64), '{"items": []}', repeat('0', 64), 'fixture', $2, $3, 'AUTHORISED_PERSON', gen_random_uuid())`, [lotId, ap.personId, ap.accountId]);
      await c.query('alter table recipe.manufacturer_release_decision enable trigger zzzn_notify_departments');
    });
    expect(await lockOf(orderId)).toEqual([{ event: 'LOCKED', cause: 'FIRST_DISPOSITION', lot_id: lotId }]);
    expect(await lockOf(parentId)).toEqual([{ event: 'LOCKED', cause: 'BULK_RECONCILIATION_CLOSED', lot_id: lotId }]);
    const [r] = (await w.gmp.db.admin.query<{ issued: unknown; left: number; reason: string | null; person: string }>(
      'select issued, cardinality(remaining_containers) as left, remaining_held_reason as reason, person_id::text as person from recipe.bulk_reconciliation where batch_id = $1', [parentId])).rows;
    expect(r).toEqual({ issued: [{ quantity: '10', unit: 'units' }], left: 4, reason: expect.stringMatching(/no bulk for packing is left/) as unknown, person: ap.personId });
    // The record screen shows it locked at the closure.
    expect(valueOf(await issuer.call(routes.records.lock, { params: { batchId: parentId } }))).toMatchObject({ state: 'LOCKED', cause: 'BULK_RECONCILIATION_CLOSED' });
  }, 180_000);
});
