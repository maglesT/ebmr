/**
 * The finished lot posted with the database's expiry (SQL mutation group "india-expiry": tablets 1201,
 * tab.post_finished_lot; decision 0012). These tests close the gaps the Phase 4 focused mutation run found: each refusal
 * of tab.post_finished_lot on its own (not a GMP batch; not a packaging order whose execution is complete; a unit that
 * is no UCUM code; an expiry that cannot be computed), and the lot it posts: the product name of the product master, the
 * order's own markets and the expiry at the end of the database's expiry date in the site's zone.
 * The packaging order is planned and issued over HTTP from a packaging master of the world's product, as in
 * test/release/grel-tablets-items.test.ts; its completion is written by the superuser, as every completing path writes it.
 *
 * Controls: PR-43 (one expiry rule), PR-45 and IN-05 (a) (finished lot from a completed packaging order).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type SignatureCredentials } from '@ebmr/api-contract';
import { sha256Hex } from '@ebmr/expr';
import { withCommand } from '@ebmr/kernel';
import { openServiceSession } from '@ebmr/test-kit';
import { flow } from '@ebmr/recipe-core';
import { cell, reason } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { postOrder } from '../../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { actorOfBrowser, personaIn, valueOf } from '../esig/support.ts';
import { asSetup } from '../blocks/compression/plant-support.ts';
import { G21_CONFIG } from '../blocks/packaging/db-support.ts';
import { actorOf, gmpLifecycleWorld, INPUTS, LINE, SITE, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';

type Json = Record<string, unknown>;
let w: GmpBatchWorld;
let parentId: string;
let orderId: string;
let orderNumber: string;
const PACK_SIZE = 'PO-100K';
const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };

function phase(id: string, type: string, config: Json, signatures: Json = SIGNATURES): Json {
  return { kind: 'phase', id, name: `Packing step ${id}`, block: { type, version: '1' }, config, records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [], signatures, significant: true, riskClass: 'HIGH' };
}

/** The processing master as a packaging master of the same product (as in test/release/grel-tablets-items.test.ts). */
function packagingContent(base: flow.MbrContent): flow.MbrContent {
  const m = JSON.parse(JSON.stringify(base)) as Json;
  const header = m['header'] as Json;
  header['family'] = `${String(header['family'])}-PK`;
  header['recordKind'] = 'PACKAGING';
  header['packType'] = 'ALU-PVC-BLISTER';
  header['batchSizes'] = [{ id: PACK_SIZE, quantity: { value: '100000', unit: '{tbl}' } }];
  const stage = ((((m['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
  const prep = ((stage['children'] as Json[])[0] as Json)['body'] as Json;
  const tb24 = phase('p-tb24', 'TB-24', {
    unit: 'TEST-LINE-CTN-R1', devices: [{ id: 'CW', kind: 'CHECKWEIGHER' }], examination: { every: { value: '1', unit: 'h' }, inRunSample: '5', endSample: '20' },
    cartonsPerShipper: '20', ssccPrefix: '089012345', printedStep: 'p-g21',
  });
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

async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
/** tab.post_finished_lot as the stores persona, in its own command. */
async function post(batch: string, unit = 'packs'): Promise<string> {
  const stores = await w.gmp.asPersona('stores');
  return withCommand(w.gmp.db.app, { ...(await actorOfBrowser(w.gmp, stores, 'stores')), correlationId: randomUUID() }, async (c) =>
    (await c.query<{ id: string }>('select tab.post_finished_lot($1, $2, $3) as id', [batch, '40', unit])).rows[0]!.id);
}
const statusOf = async (batch: string): Promise<string> => (await w.gmp.db.admin.query<{ s: string }>('select status as s from recipe.execution_state where batch_id = $1', [batch])).rows[0]!.s;

beforeAll(async () => {
  w = await startGmpBatchWorld();
  const issuer = await w.gmp.asPersona('issuer');
  parentId = await w.issued(issuer);
  const world = await gmpLifecycleWorld(w.gmp);
  const packContent = packagingContent(w.content);
  const v = await world.approvedVersion(packContent);
  await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, PACK_SIZE)], regulatoryBasis: 'IN: registration on file' });
  const steward = await actorOf(w.gmp, 'steward');
  await world.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [
      JSON.stringify({ rule_code: `P-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: packContent.header.product.code, batch_kind: 'PACKAGING', format: '{PARENT}/P{SEQ:2}', site_zone: 'Asia/Kolkata', reason: 'Numbering SOP-QA-017 rev 3' }),
    ]),
    reason('packaging numbering rule for the test'),
  );
  const orderNo = await postOrder(w.gmp.db.app, await openServiceSession(w.gmp.db, w.gmp.seed, 'erpInterface'), packContent, PACK_SIZE);
  const planned = valueOf(await issuer.call(routes.planning.planPackagingOrder, { body: { familyId: v.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: PACK_SIZE, erpOrder: orderNo, parentBatchId: parentId } }));
  orderId = planned.batchId;
  orderNumber = planned.batchNumber;
  const preview = valueOf(await issuer.call(routes.esig.content, { query: { aggregateType: 'batch_issue', aggregateId: orderId, intent: 'ISSUED' } }));
  const action = { kind: 'GMP_BATCH_ISSUE' as const, batchId: orderId, reason: { code: 'PRODUCTION_PLAN', text: 'Packaging order issued for the plan' }, variants: {}, inputs: INPUTS };
  const challenge = valueOf(
    await issuer.call(routes.esig.createChallenge, { body: { aggregateType: 'batch_issue', aggregateId: orderId, contentVersion: preview.contentVersion, meaning: 'ISSUED', clientContentHash: sha256Hex(preview.canonicalText), action } }),
  );
  const password: SignatureCredentials = { kind: 'PASSWORD', loginName: personaIn(w.gmp, 'issuer').loginName, password: personaIn(w.gmp, 'issuer').password };
  const sign = { challengeId: challenge.challengeId, credentials: password, action };
  valueOf(await issuer.call(routes.esig.sign, { body: { ...sign, proof: await issuer.proof('POST', '/api/esig/sign', sign) } }));
}, 900_000);

afterAll(async () => {
  await w?.close();
});

describe('posting the finished lot of a packaging order (tablets 1201, tab.post_finished_lot)', () => {
  it('[PR-45] [IN-05] [PR-43] each refusal on its own, then the lot with the master\'s product name, the order\'s markets and the database\'s expiry', async () => {
    expect(await messageOf(post(randomUUID()))).toMatch(/EBMR-TAB-850 batch .* is not a GMP batch of this installation/);
    const parentStatus = await statusOf(parentId);
    expect(await messageOf(post(parentId))).toMatch(new RegExp(`EBMR-TAB-850 batch .* is PROCESSING ${parentStatus}: a finished lot is posted from a packaging order whose execution is complete`));
    const orderStatus = await statusOf(orderId);
    expect(orderStatus).not.toBe('EXECUTION_COMPLETE');
    expect(await messageOf(post(orderId))).toMatch(new RegExp(`EBMR-TAB-850 batch .* is PACKAGING ${orderStatus}: a finished lot is posted`));

    // Arranged: the order complete (the completion gates, tablets 0952 and 1230, are proven in blocks/packaging).
    const c = await w.gmp.db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = $1", [orderId]);
      await c.query('commit');
    } finally {
      c.release();
    }
    expect(await messageOf(post(orderId, 'two words'))).toMatch(/EBMR-TAB-851 the unit of the posted quantity is a UCUM code/);
    // The world's product has no product master yet: no shelf life, so no expiry.
    expect(await messageOf(post(orderId))).toMatch(new RegExp(`EBMR-TAB-852 the expiry of batch ${orderNumber.replace(/[/.]/g, '\\$&')} cannot be computed`));

    // The ERP posts the product master (12 months) and QA confirms it.
    const product = w.content.header.product;
    const world = await gmpLifecycleWorld(w.gmp);
    const erp = await openServiceSession(w.gmp.db, w.gmp.seed, 'erpInterface');
    const version = await withCommand(w.gmp.db.app, { ...erp, correlationId: randomUUID() }, async (c) =>
      (await c.query<{ id: string }>('select site.erp_receive_product($1::jsonb) as id', [
        JSON.stringify({ productCode: product.code, strength: product.strength, productName: `Master name of ${product.code}`, betaLactam: false, shelfLifeMonths: 12, erpReference: `ERP-${product.code}` }),
      ])).rows[0]!.id);
    const state = (await w.gmp.db.app.query<{ s: string }>("select site.erp_master_state('PRODUCT', $1) as s", [version])).rows[0]!.s;
    if (state === 'PENDING') {
      const sig = await world.sign(world.cast.qa, 'erp_master', `PRODUCT/${version}`, 'ERP_MASTER_CONFIRMED', 'PENDING');
      await world.run(world.cast.qa, (c) => c.query("select site.confirm_erp_master('PRODUCT', $1, $2)", [version, sig]));
    }
    // TEST FIXTURE: every other batch planned for other markets than the order's (superuser, triggers off), so the markets the lot takes
    // can only be the order's own.
    await asSetup(w.gmp, "update recipe.stub_batch set markets = array['IN', 'US'] where id <> $1", [orderId]);
    const lot = await post(orderId);
    const row = (await w.gmp.db.admin.query<{ name: string; markets: string[]; ok: boolean }>(
      `select l.material_name as name, f.markets,
              l.expires_at = (((recipe.batch_expiry(f.batch_id) ->> 'expiryDate')::date + 1)::timestamp at time zone kernel.site_zone()) - interval '1 microsecond' as ok
         from site.finished_lot f join site.material_lot l on l.id = f.lot_id where f.lot_id = $1`, [lot])).rows[0]!;
    expect(row).toEqual({ name: `Master name of ${product.code}`, markets: ['IN'], ok: true });
    const stub = (await w.gmp.db.admin.query<{ m: string[] }>('select markets as m from recipe.stub_batch where id = $1', [orderId])).rows[0]!.m;
    expect(row.markets).toEqual(stub);
  });
});
