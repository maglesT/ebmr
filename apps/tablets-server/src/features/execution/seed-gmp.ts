/**
 * DEMO-ONLY seed of the GMP installation (Phase 3 slice 6c; slice 6 plan, demo seeds): the ERP catalogue of the demo
 * site (the product and material masters and open production orders, posted as the ERP interface's service identity),
 * then the material lots of the GB-T-01 formula received into quarantine by the warehouse, tested in LIMS-lite by the QC
 * analyst, the results approved by a second QC person (QC_RESULT_APPROVED) and the lots released on the identity-tested
 * route (MATERIAL_LOT_RELEASED), each act through its own command and, where the database asks for one, a real
 * electronic signature of the persona. The active lot's assay is recorded from its approved LIMS results (tablets 1001).
 * Never run on a production installation.
 *
 * Plant units, tooling and detectors come with the master-data commands of slice 6a; the case 2 residue lot of GB-T-01
 * comes from the residue reservation of a real source batch (GB-T-01's driver).
 */
import type pg from 'pg';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import type { FeatureSeedContext } from '../types.ts';
import { GBT01_LOTS, GBT01_MATERIALS, GBT01_ORDERS, GBT01_PRODUCT, type SeedMaterialLot } from './seed-gb-t-01.ts';

const SITE = 'SITE-1';

export interface ErpCatalogueSeed {
  products: Record<string, unknown>[];
  materials: Record<string, unknown>[];
  orders: Record<string, unknown>[];
}

/** The demo site's ERP catalogue: the dc-mini product (paracetamol 500 mg) and GB-T-01, with their materials and orders. */
export function demoErpCatalogue(): ErpCatalogueSeed {
  const pcm = (orderNo: string, kg: string, bom: [string, string][]) => ({
    orderNo, siteCode: SITE, productCode: 'PCM500', strength: '500 mg', batchSize: kg, batchSizeUnit: 'kg',
    bom: bom.map(([materialCode, quantity]) => ({ materialCode, quantity, unit: 'kg' })), erpReference: `SAP-PP-${orderNo}`,
  });
  return {
    products: [
      { productCode: 'PCM500', strength: '500 mg', productName: 'Paracetamol tablets IP 500 mg', reprocessingPermitted: false, betaLactam: false, shelfLifeMonths: 36, erpReference: 'SAP-MM-FG-PCM500' },
      GBT01_PRODUCT,
    ],
    materials: [
      { materialCode: 'MAT-PCM', materialName: 'Paracetamol IP, direct-compression grade', materialKind: 'API', unit: 'kg', maxRetestMonths: 24, erpReference: 'SAP-MM-RM-PCM' },
      { materialCode: 'MAT-MCC', materialName: 'Microcrystalline cellulose PH 102', materialKind: 'EXCIPIENT', unit: 'kg', maxRetestMonths: 36, erpReference: 'SAP-MM-RM-MCC' },
      { materialCode: 'MAT-MGS', materialName: 'Magnesium stearate', materialKind: 'EXCIPIENT', unit: 'kg', maxRetestMonths: 36, erpReference: 'SAP-MM-RM-MGS' },
      ...GBT01_MATERIALS,
    ],
    orders: [
      pcm('PO-DEMO-0001', '60.000', [['MAT-PCM', '50.000'], ['MAT-MCC', '9.400'], ['MAT-MGS', '0.600']]),
      pcm('PO-DEMO-0002', '30.000', [['MAT-PCM', '25.000'], ['MAT-MCC', '4.700'], ['MAT-MGS', '0.300']]),
      ...GBT01_ORDERS,
    ],
  };
}

async function inCommand<T>(pool: pg.Pool, actor: ActorContext, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return withCommand(pool, { ...actor, correlationId: globalThis.crypto.randomUUID() }, work);
}

/** Receives, tests, approves and releases one lot; returns its id. */
async function seedLot(ctx: FeatureSeedContext, lot: SeedMaterialLot): Promise<string> {
  const pool = ctx.pools.app;
  const received = await inCommand(pool, await ctx.actorFor('stores'), async (c) =>
    (await c.query<{ r: { lot_id: string } }>('select site.receive_lot($1::jsonb) as r', [
      JSON.stringify({ lotCode: lot.lotCode, materialCode: lot.materialCode, quantity: lot.quantity, expiresAt: lot.expiresAt, ...(lot.retestAt ? { retestAt: lot.retestAt } : {}) }),
    ])).rows[0]?.r,
  );
  const lotId = received?.lot_id;
  if (!lotId) throw new Error(`lot ${lot.lotCode} was not received`);
  const analyst = await ctx.actorFor('qcAnalyst');
  const resultIds: Record<string, string> = {};
  for (const t of lot.results) {
    const r = await inCommand(pool, analyst, async (c) =>
      (await c.query<{ r: { resultId: string; verdict: string } }>('select site.record_lot_test_result($1, $2::jsonb) as r', [
        lotId,
        JSON.stringify({ testCode: t.testCode, methodReference: t.methodReference, purpose: 'RELEASE', value: t.value, unit: t.unit, ...(t.lowerLimit ? { lowerLimit: t.lowerLimit } : {}), ...(t.upperLimit ? { upperLimit: t.upperLimit } : {}) }),
      ])).rows[0]?.r,
    );
    if (!r || r.verdict !== 'PASS') throw new Error(`the ${t.testCode} result of lot ${lot.lotCode} is not a passing result`);
    const sig = await ctx.signAs('qcApprover', { type: 'lot_test_result', id: r.resultId }, 'QC_RESULT_APPROVED', 'RECORDED');
    await inCommand(pool, await ctx.actorFor('qcApprover'), (c) => c.query('select site.approve_lot_test_result($1, $2)', [r.resultId, sig]));
    resultIds[t.testCode] = r.resultId;
  }
  await inCommand(pool, analyst, (c) => c.query("select site.record_identity_result($1, 'PASS', $2, $3)", [lotId, lot.identityMethod, `ID-${lot.lotCode}`]));
  if (lot.assay) {
    const a = lot.assay;
    await inCommand(pool, analyst, (c) =>
      c.query('select tab.record_lot_assay($1, $2, $3::jsonb, $4)', [
        lot.lotCode,
        SITE,
        JSON.stringify({ basis: a.basis, assayResultId: resultIds[a.assayTest], ...(a.waterTest ? { waterResultId: resultIds[a.waterTest] } : {}), certificateRef: `LIMS-${lot.lotCode}` }),
        null,
      ]),
    );
  }
  const sig = await ctx.signAs('qcApprover', { type: 'material_lot', id: lotId }, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
  await inCommand(pool, await ctx.actorFor('qcApprover'), async (c) => {
    const v = (await c.query<{ v: string }>("select version::text as v from platform.aggregate_state where aggregate_type = 'material_lot' and aggregate_id = $1", [lotId])).rows[0]?.v;
    await c.query("select site.change_lot_status($1, 'RELEASE', $2::bigint, $3, 'IDENTITY_TESTED')", [lotId, v, sig]);
  });
  return lotId;
}

export async function seedGmp(ctx: FeatureSeedContext): Promise<void> {
  if (ctx.installation !== 'GMP') return;
  const catalogue = demoErpCatalogue();
  ctx.log(`posting the ERP catalogue (${catalogue.products.length} products, ${catalogue.materials.length} materials, ${catalogue.orders.length} orders)`);
  await inCommand(ctx.pools.app, await ctx.serviceActorFor('erpInterface'), async (c) => {
    for (const p of catalogue.products) await c.query('select site.erp_receive_product($1::jsonb)', [JSON.stringify(p)]);
    for (const m of catalogue.materials) await c.query('select site.erp_receive_material($1::jsonb)', [JSON.stringify(m)]);
    for (const o of catalogue.orders) await c.query('select site.erp_receive_order($1::jsonb)', [JSON.stringify(o)]);
  });
  ctx.log(`receiving, testing and releasing ${GBT01_LOTS.length} GB-T-01 lots`);
  for (const lot of GBT01_LOTS) await seedLot(ctx, lot);
}
