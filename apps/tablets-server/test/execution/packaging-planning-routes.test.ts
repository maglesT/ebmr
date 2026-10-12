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
import { openServiceSession } from '@ebmr/test-kit';
import { flow } from '@ebmr/recipe-core';
import { cell, reason } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { personaIn, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { G21_CONFIG } from '../blocks/packaging/db-support.ts';
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
    expect(card?.match).toMatchObject({ familyId: packFamilyId, recordKind: 'PACKAGING', packType: 'ALU-PVC-BLISTER', parents: [expect.objectContaining({ batchId: parentId, batchNumber: parentNumber, releaseForPackingProblem: expect.stringMatching(/H-PACK/) })] });
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
    expect(bulk).toMatchObject({ batchId, orderProblem: null, parent: { batchId: parentId, batchNumber: parentNumber, releaseForPackingProblem: expect.stringMatching(/H-PACK/) }, issued: [], containers: [] });
    const body = { labels: [`OC-${parentNumber}-1001`] };
    const tap = await tapFor(operator, personaIn(w.gmp, 'operator1'), 'POST', `/api/batches/${batchId}/bulk`, body);
    const refused = refusalOf(await operator.call(routes.batches.issueBulk, { params: { batchId }, body, attribution: tap }));
    expect([refused.code, refused.why]).toEqual(['EBMR-PKG-002', expect.stringMatching(/H-PACK/)]);
    expect(valueOf(await operator.call(routes.planning.packagingBulk, { params: { batchId } })).issued).toEqual([]);
    expect(refusalOf(await operator.call(routes.planning.packagingBulk, { params: { batchId: randomUUID() } })).status).toBe(404);
    // The processing batch is no packaging order: its bulk read is not found either.
    expect(refusalOf(await operator.call(routes.planning.packagingBulk, { params: { batchId: parentId } })).status).toBe(404);
  }, 120_000);
});
