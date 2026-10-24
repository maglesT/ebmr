/**
 * Slice 7o (lead's decision (d); R4, R8): the ERP simulator's "Send a production order" offers, besides the demo products,
 * every product whose current master version is approved and holds an active market authorisation: a company's own
 * product made on screen gets its order without a code change. The order states the master's own BOM for the family's
 * first approved batch size (exact decimals), so the database's comparison at planning (recipe-core 0602) accepts it.
 * A product with no approved and authorised master is not offered.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { authorisedTemplates, orderTemplates, postProductionOrder, prepareProductionOrder } from '../../src/features/operations/erp-orders.ts';
import { valueOf } from '../esig/support.ts';
import { BATCH_SIZE, LINE, SITE, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';

let w: GmpBatchWorld;
const keysDir = mkdtempSync(join(tmpdir(), 'ebmr-7o-keys-'));

beforeAll(async () => {
  w = await startGmpBatchWorld(undefined, { EBMR_KEYS_DIR: keysDir });
  writeFileSync(join(keysDir, 'gmp-seed.json'), JSON.stringify(w.gmp.seed));
}, 300_000);

afterAll(async () => {
  await w?.close();
});

describe('production orders of any approved and authorised product (slice 7o)', () => {
  it('[PR-04][DI-17] the approved master with an active authorisation is offered with its own BOM for its first batch size; the order posted is planned against without a mismatch', async () => {
    const app = w.gmp.built.ctx;
    const product = w.content.header.product.code;
    const own = (await authorisedTemplates(app)).filter((t) => t.productCode === product);
    expect(own.map((t) => t.kind)).toEqual(['PROCESSING']);
    expect(own[0]?.bom.map((b) => b.materialCode).sort()).toEqual(w.content.bom.map((b) => b.material).sort());
    expect((await orderTemplates(app)).some((t) => t.productCode === product && t.kind === 'PROCESSING')).toBe(true);
    // A product without an approved, authorised master is not offered.
    expect((await authorisedTemplates(app)).some((t) => t.productCode === 'NO-SUCH-PRODUCT')).toBe(false);

    const prepared = await prepareProductionOrder(app, product, 'PROCESSING', 'idem-7o-order-1');
    await postProductionOrder(app, prepared);
    const issuer = await w.gmp.asPersona('issuer');
    const planned = valueOf(await issuer.call(routes.execution.planBatch, { body: { familyId: w.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: BATCH_SIZE } }));
    const { rows } = await w.gmp.db.admin.query<{ order_no: string }>('select order_no from recipe.batch_erp_order where batch_id = $1', [planned.batchId]);
    expect(rows.map((r) => r.order_no)).toEqual([prepared.view.orderNo]);
  });
});
