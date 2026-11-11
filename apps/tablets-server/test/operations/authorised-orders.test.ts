/**
 * Slice 7o (lead's decision (d); R4, R8): the ERP simulator's "Send a production order" offers, besides the demo products,
 * every product whose current master version is approved and holds an active market authorisation: a company's own
 * product made on screen gets its order without a code change. The order states the master's own BOM for the family's
 * first approved batch size (exact decimals), so the database's comparison at planning (recipe-core 0602) accepts it.
 * A product with no approved and authorised master is not offered.
 *
 * Owner retest N-1 (10 November 2026): the master here has a material on two lines (a bilayer tablet's binder in each
 * layer): the order names it once with the two lines summed and scaled (site 0751 EBMR-SITE-176 refuses a material
 * twice), and planning's comparison (recipe-core 1877) accepts it.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { authorisedTemplates, orderTemplates, postProductionOrder, prepareProductionOrder } from '../../src/features/operations/erp-orders.ts';
import { valueOf } from '../esig/support.ts';
import { BATCH_SIZE, LINE, SITE, gmpContent, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';

type Json = Record<string, unknown>;

/** MAT-MCC on two lines: BOM-MCC 5.400 kg and BOM-MCC-2 4.000 kg (9.400 kg in all, as dc-mini's one line), both consumed where BOM-MCC was. */
function twoLines(m: Json): void {
  const bom = m['bom'] as Json[];
  const i = bom.findIndex((b) => b['id'] === 'BOM-MCC');
  bom[i] = { ...bom[i], quantity: { value: '5.400', unit: 'kg' } };
  bom.splice(i + 1, 0, { ...bom[i], id: 'BOM-MCC-2', quantity: { value: '4.000', unit: 'kg' } });
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      const o = n as Json;
      const c = o['consumes'];
      if (Array.isArray(c) && c.includes('BOM-MCC')) c.splice(c.indexOf('BOM-MCC') + 1, 0, 'BOM-MCC-2');
      Object.values(o).forEach(walk);
    }
  };
  walk(m);
}

let w: GmpBatchWorld;
const keysDir = mkdtempSync(join(tmpdir(), 'ebmr-7o-keys-'));

beforeAll(async () => {
  w = await startGmpBatchWorld(gmpContent(twoLines), { EBMR_KEYS_DIR: keysDir });
  writeFileSync(join(keysDir, 'gmp-seed.json'), JSON.stringify(w.gmp.seed));
}, 300_000);

afterAll(async () => {
  await w?.close();
});

describe('production orders of any approved and authorised product (slice 7o)', () => {
  it('[PR-04][DI-17] the approved master (a material on two lines) with an active authorisation is offered with its own BOM for its first batch size; the order posted is planned against without a mismatch', async () => {
    const app = w.gmp.built.ctx;
    const product = w.content.header.product.code;
    const own = (await authorisedTemplates(app)).filter((t) => t.productCode === product);
    expect(own.map((t) => t.kind)).toEqual(['PROCESSING']);
    expect(own[0]?.bom.map((b) => b.materialCode)).toEqual([...new Set(w.content.bom.map((b) => b.material))].sort());
    // [PR-04] N-1: the material on two master lines is one order line, the two lines summed and scaled (9.400 kg per 60 kg reference).
    expect(w.content.bom.filter((b) => b.material === 'MAT-MCC')).toHaveLength(2);
    expect(own[0]?.bom.find((b) => b.materialCode === 'MAT-MCC')).toEqual({ materialCode: 'MAT-MCC', quantity: '9.4', unit: 'kg' });
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
