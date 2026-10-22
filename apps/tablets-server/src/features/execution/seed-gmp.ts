/**
 * DEMO-ONLY seed of the GMP installation (Phase 3 slice 6c; slice 6 plan, demo seeds): the ERP catalogue of the demo
 * site (the product and material masters and open production orders, posted as the ERP interface's service identity),
 * then the approved specification of each GB-T-01 material (Phase 4 slice 2b) and the material lots of the GB-T-01 formula
 * received into quarantine by the warehouse, tested in LIMS-lite against it by the QC
 * analyst (each with its receipt record, its manufacturer approved by QA and its containers examined), the results approved by a second QC person (QC_RESULT_APPROVED) and the lots released on the identity-tested
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
import { DEMO_EXTRA_LOTS } from './seed-demo-orders.ts';
import { GBT02_LOTS, GBT02_MATERIALS, GBT02_PRODUCT, GBT02_VENDOR_LOT } from './seed-gb-t-02.ts';
import { GBT01_LOTS, GBT01_MATERIALS, GBT01_ORDERS, GBT01_PACK_LOTS, GBT01_PACK_MATERIALS, GBT01_PRODUCT, type SeedMaterialLot, type SeedPackLot } from './seed-gb-t-01.ts';

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
      GBT02_PRODUCT,
    ],
    materials: [
      { materialCode: 'MAT-PCM', materialName: 'Paracetamol IP, direct-compression grade', materialKind: 'API', unit: 'kg', maxRetestMonths: 24, erpReference: 'SAP-MM-RM-PCM' },
      { materialCode: 'MAT-MCC', materialName: 'Microcrystalline cellulose PH 102', materialKind: 'EXCIPIENT', unit: 'kg', maxRetestMonths: 36, erpReference: 'SAP-MM-RM-MCC' },
      { materialCode: 'MAT-MGS', materialName: 'Magnesium stearate', materialKind: 'EXCIPIENT', unit: 'kg', maxRetestMonths: 36, erpReference: 'SAP-MM-RM-MGS' },
      ...GBT01_MATERIALS,
      ...GBT01_PACK_MATERIALS,
      ...GBT02_MATERIALS,
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

/**
 * The approved specification of a lot's material (Phase 4 slice 2b, site services 0840): its tests and limits are the
 * seeded lot's, each required, citing IP 2022 (in-house methods their document version); drafted by the QC analyst and
 * approved by the head of QC (SPECIFICATION_APPROVED). A lot's results take their limits from it.
 */
async function seedSpecification(ctx: FeatureSeedContext, lot: SeedMaterialLot): Promise<void> {
  const pool = ctx.pools.app;
  const tests = lot.results.map((t) => ({
    testCode: t.testCode, methodReference: t.methodReference, unit: t.unit, ...(t.lowerLimit ? { lowerLimit: t.lowerLimit } : {}), ...(t.upperLimit ? { upperLimit: t.upperLimit } : {}),
    required: true, pharmacopoeia: 'IP', edition: '2022', sampleQuantity: '0.050', sampleUnit: 'kg',
  }));
  const draft = await inCommand(pool, await ctx.actorFor('qcAnalyst'), async (c) =>
    (await c.query<{ r: { specificationId: string } }>('select site.draft_specification($1::jsonb) as r', [
      JSON.stringify({ materialCode: lot.materialCode, title: `Specification of ${lot.materialCode}`, monographReference: `IP 2022 monograph for ${lot.materialCode}`, tests }),
    ])).rows[0]?.r.specificationId,
  );
  if (!draft) throw new Error(`the specification of ${lot.materialCode} was not drafted`);
  const sig = await ctx.signAs('qcApprover', { type: 'specification', id: draft }, 'SPECIFICATION_APPROVED', 'DRAFT');
  await inCommand(pool, await ctx.actorFor('qcApprover'), (c) => c.query('select site.approve_specification($1, $2)', [draft, sig]));
}

/** Receives, tests, approves and releases one lot; returns its id. */
async function seedLot(ctx: FeatureSeedContext, lot: SeedPackLot, route: 'IDENTITY_TESTED' | 'VENDOR_HISTORY' = 'IDENTITY_TESTED'): Promise<string> {
  const pool = ctx.pools.app;
  const received = await inCommand(pool, await ctx.actorFor('stores'), async (c) =>
    (await c.query<{ r: { lot_id: string } }>('select site.receive_lot($1::jsonb) as r', [
      JSON.stringify({ lotCode: lot.lotCode, materialCode: lot.materialCode, quantity: lot.quantity, expiresAt: lot.expiresAt, ...(lot.retestAt ? { retestAt: lot.retestAt } : {}) }),
    ])).rows[0]?.r,
  );
  const lotId = received?.lot_id;
  if (!lotId) throw new Error(`lot ${lot.lotCode} was not received`);
  await completeReceipt(ctx, lotId, lot);
  const analyst = await ctx.actorFor('qcAnalyst');
  const resultIds: Record<string, string> = {};
  for (const t of lot.results) {
    const r = await inCommand(pool, analyst, async (c) =>
      (await c.query<{ r: { resultId: string; verdict: string } }>('select site.record_lot_test_result($1, $2::jsonb) as r', [
        lotId,
        JSON.stringify({ testCode: t.testCode, methodReference: t.methodReference, purpose: 'RELEASE', value: t.value, unit: t.unit }),
      ])).rows[0]?.r,
    );
    if (!r || r.verdict !== 'PASS') throw new Error(`the ${t.testCode} result of lot ${lot.lotCode} is not a passing result`);
    const sig = await ctx.signAs('qcApprover', { type: 'lot_test_result', id: r.resultId }, 'QC_RESULT_APPROVED', 'RECORDED');
    await inCommand(pool, await ctx.actorFor('qcApprover'), (c) => c.query('select site.approve_lot_test_result($1, $2)', [r.resultId, sig]));
    resultIds[t.testCode] = r.resultId;
  }
  if (route === 'IDENTITY_TESTED') await inCommand(pool, analyst, (c) => c.query("select site.record_identity_result($1, 'PASS', $2, $3)", [lotId, lot.identityMethod, `ID-${lot.lotCode}`]));
  // A printed packaging lot carries the artwork version QC checked it against at receipt (PR-32; tablets 0950).
  if (lot.artwork) await inCommand(pool, analyst, (c) => c.query('select tab.record_lot_artwork($1, $2, $3)', [lot.lotCode, SITE, lot.artwork]));
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
    await c.query("select site.change_lot_status($1, 'RELEASE', $2::bigint, $3, $4)", [lotId, v, sig, route]);
  });
  return lotId;
}

/** The demo manufacturer of every seeded material (approved by QA, PR-17). */
const DEMO_MANUFACTURER = 'MFR-DEMO';

/**
 * QA approves the demo manufacturer for a material (site services 0910: the approved-manufacturer register, PR-17), with
 * its MANUFACTURER_APPROVED signature, unless it is approved already.
 */
async function approveManufacturer(ctx: FeatureSeedContext, materialCode: string): Promise<void> {
  const pool = ctx.pools.app;
  const { rows } = await pool.query<{ ok: boolean }>('select site.manufacturer_approved($1, $2, $3) as ok', [SITE, materialCode, DEMO_MANUFACTURER]);
  if (rows[0]?.ok) return;
  const qa = await ctx.actorFor('qaInvestigator');
  const id = await inCommand(pool, qa, async (c) =>
    (await c.query<{ id: string }>('select site.propose_approved_manufacturer($1::jsonb) as id', [
      JSON.stringify({ materialCode, manufacturerCode: DEMO_MANUFACTURER, manufacturerName: 'Demo Pharma Chem Pvt Ltd', basis: 'Demo supplier qualification file and on-site audit (DEMO-ONLY)' }),
    ])).rows[0]?.id,
  );
  if (!id) throw new Error(`the manufacturer of ${materialCode} was not proposed`);
  const sig = await ctx.signAs('qaInvestigator', { type: 'approved_manufacturer', id }, 'MANUFACTURER_APPROVED', 'PROPOSED');
  await inCommand(pool, await ctx.actorFor('qaInvestigator'), (c) => c.query('select site.approve_manufacturer($1, $2)', [id, sig]));
}

/** The receipt record of a seeded lot (delivery, supplier, supplier batch, manufacturer, one container) and its examination by stores (PR-17). */
async function completeReceipt(ctx: FeatureSeedContext, lotId: string, lot: SeedPackLot): Promise<void> {
  const pool = ctx.pools.app;
  await approveManufacturer(ctx, lot.materialCode);
  const stores = await ctx.actorFor('stores');
  await inCommand(pool, stores, (c) =>
    c.query('select site.record_lot_receipt($1, $2::jsonb)', [
      lotId,
      JSON.stringify({ deliveryId: `GRN-${lot.lotCode}`, supplierCode: 'SUP-DEMO', supplierLot: `SB-${lot.lotCode}`, manufacturerCode: DEMO_MANUFACTURER, containers: '1', deliveryNoteName: lot.materialCode }),
    ]),
  );
  await inCommand(pool, await ctx.actorFor('stores'), (c) =>
    c.query('select site.record_receipt_examination($1, $2::jsonb)', [lotId, JSON.stringify({ containersExamined: '1', outcome: 'ACCEPTABLE' })]),
  );
}

/**
 * The QA MBR approver confirms every master version the ERP posted that is not in effect on its own (site-services
 * 0802: a new code, or a changed controlled value), each with its own ERP_MASTER_CONFIRMED signature.
 */
async function confirmErpMasters(ctx: FeatureSeedContext): Promise<void> {
  const pool = ctx.pools.app;
  const { rows } = await pool.query<{ v: { masterKind: 'PRODUCT' | 'MATERIAL'; versionId: string } }>('select x.v from jsonb_array_elements(site.erp_master_pending()) x(v)');
  ctx.log(`confirming ${rows.length} ERP master versions (QA, ERP_MASTER_CONFIRMED)`);
  for (const { v } of rows) {
    const sig = await ctx.signAs('approver', { type: 'erp_master', id: `${v.masterKind}/${v.versionId}` }, 'ERP_MASTER_CONFIRMED', 'PENDING');
    await inCommand(pool, await ctx.actorFor('approver'), (c) => c.query('select site.confirm_erp_master($1, $2, $3)', [v.masterKind, v.versionId, sig]));
  }
}

/** QA enables the vendor-history route of excipient `materialCode` at the site, with its signed justification (IN-24 (c)). */
async function enableVendorRoute(ctx: FeatureSeedContext, materialCode: string): Promise<void> {
  const pool = ctx.pools.app;
  const qa = await ctx.actorFor('qaInvestigator');
  const routeId = await inCommand(pool, qa, async (c) =>
    (await c.query<{ r: string }>("select site.propose_vendor_route($1, 'EXCIPIENT', $2, $3) as r", [
      materialCode, 'Twenty consecutive lots of this supplier tested in full with every result inside the specification', 'STAT-VR-MCC102-01',
    ])).rows[0]?.r,
  );
  if (!routeId) throw new Error(`the vendor-history route of ${materialCode} was not proposed`);
  const sig = await ctx.signAs('qaInvestigator', { type: 'vendor_route', id: routeId }, 'VENDOR_ROUTE_ENABLED', 'PROPOSED');
  await inCommand(pool, await ctx.actorFor('qaInvestigator'), (c) => c.query('select site.enable_vendor_route($1, $2)', [routeId, sig]));
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
  await confirmErpMasters(ctx);
  ctx.log(`receiving, testing and releasing ${GBT01_LOTS.length + GBT01_PACK_LOTS.length} GB-T-01 lots`);
  for (const lot of [...GBT01_LOTS, ...GBT01_PACK_LOTS]) {
    await seedSpecification(ctx, lot);
    await seedLot(ctx, lot);
  }
  // GB-T-02 (Phase 4 slice 7b): its lots, one microcrystalline cellulose lot of them released on the India-only
  // vendor-history route QA enabled for the material with its statistical justification (IN-24 (c)).
  ctx.log(`receiving, testing and releasing ${GBT02_LOTS.length + 1} GB-T-02 lots`);
  const specified = new Set<string>(GBT01_LOTS.map((l) => l.materialCode));
  for (const lot of GBT02_LOTS) {
    if (!specified.has(lot.materialCode)) await seedSpecification(ctx, lot);
    specified.add(lot.materialCode);
    await seedLot(ctx, lot);
  }
  await enableVendorRoute(ctx, GBT02_VENDOR_LOT.materialCode);
  await seedLot(ctx, GBT02_VENDOR_LOT, 'VENDOR_HISTORY');
  // R5 (slice 7k): GB-T-02's second lots, so the demo makes several batches in a row and in parallel (their materials'
  // specifications are seeded above; they expire after the first lots).
  ctx.log(`receiving, testing and releasing ${DEMO_EXTRA_LOTS.length} more GB-T-02 lots (R5)`);
  for (const lot of DEMO_EXTRA_LOTS) await seedLot(ctx, lot);
}
