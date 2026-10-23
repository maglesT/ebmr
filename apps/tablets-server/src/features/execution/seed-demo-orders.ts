/**
 * DEMO-ONLY production orders and lots for continuous and parallel production (Phase 7 slice 7k; requirement R5 of the
 * hosted-demo trials): several open ERP orders per demo product, processing and packaging, and lots enough for several
 * batches, posted by the GMP demo seed (seed-gmp.ts), so a demo load or a reset followed by a load leaves exactly these;
 * and the order templates the operations screen's "Send a production order" posts as the ERP interface (a new order
 * number each time). Every order states the master's own bill of materials for its batch size (the database compares
 * them at issue, recipe-core 0602). Pure data: no database access here.
 */
import { GBT01_BATCH_KG, GBT01_BOM, GBT01_PRODUCT, type SeedPackLot } from './seed-gb-t-01.ts';
import { GBT02_BATCH_KG, GBT02_BOM, GBT02_PRODUCT } from './seed-gb-t-02.ts';

const SITE = 'SITE-1';

export type DemoOrderKind = 'PROCESSING' | 'PACKAGING';

export interface DemoOrderTemplate {
  productCode: string;
  strength: string;
  productName: string;
  kind: DemoOrderKind;
  batchSize: string;
  batchSizeUnit: string;
  bom: readonly { materialCode: string; quantity: string; unit: string }[];
}

const kg = (bom: readonly (readonly [string, string])[]) => bom.map(([materialCode, quantity]) => ({ materialCode, quantity, unit: 'kg' }));

/** One bottle order of GB-T-02: 100 bottles of 30 tablets (3,000), the bottles issued by weight (12.5 g each). */
export const GBT02_BOTTLE_ORDER = { tablets: '3000', bottlesKg: '1.250', bottleMaterial: 'MAT-HDPE-60' } as const;

/** What "Send a production order" can send, one template per product and kind. */
export const DEMO_ORDER_TEMPLATES: readonly DemoOrderTemplate[] = [
  {
    productCode: 'PCM500', strength: '500 mg', productName: 'Paracetamol tablets IP 500 mg', kind: 'PROCESSING', batchSize: '60.000', batchSizeUnit: 'kg',
    bom: kg([['MAT-PCM', '50.000'], ['MAT-MCC', '9.400'], ['MAT-MGS', '0.600']]),
  },
  { productCode: GBT01_PRODUCT.productCode, strength: GBT01_PRODUCT.strength, productName: GBT01_PRODUCT.productName, kind: 'PROCESSING', batchSize: GBT01_BATCH_KG, batchSizeUnit: 'kg', bom: kg(GBT01_BOM) },
  { productCode: GBT02_PRODUCT.productCode, strength: GBT02_PRODUCT.strength, productName: GBT02_PRODUCT.productName, kind: 'PROCESSING', batchSize: GBT02_BATCH_KG, batchSizeUnit: 'kg', bom: kg(GBT02_BOM) },
  {
    productCode: GBT02_PRODUCT.productCode, strength: GBT02_PRODUCT.strength, productName: GBT02_PRODUCT.productName, kind: 'PACKAGING', batchSize: GBT02_BOTTLE_ORDER.tablets, batchSizeUnit: '{tbl}',
    bom: [{ materialCode: GBT02_BOTTLE_ORDER.bottleMaterial, quantity: GBT02_BOTTLE_ORDER.bottlesKg, unit: 'kg' }],
  },
];

/** The ERP order a template stands for, under `orderNo` (the shape of site.erp_receive_order and the ERP import route). */
export function demoOrder(t: DemoOrderTemplate, orderNo: string): Record<string, unknown> {
  return { orderNo, siteCode: SITE, productCode: t.productCode, strength: t.strength, batchSize: t.batchSize, batchSizeUnit: t.batchSizeUnit, bom: t.bom.map((b) => ({ ...b })), erpReference: `SAP-PP-${orderNo}` };
}

const template = (productCode: string, kind: DemoOrderKind): DemoOrderTemplate => {
  const t = DEMO_ORDER_TEMPLATES.find((x) => x.productCode === productCode && x.kind === kind);
  if (!t) throw new Error(`no demo order template for ${productCode} ${kind}`);
  return t;
};

/**
 * R5: the open orders the GMP demo seed posts besides the ones it always had (PCM500 PO-DEMO-0001/2, GB-T-01
 * PO-GBT01-0001/2): two GB-T-02 processing orders and two GB-T-02 bottle orders.
 */
export const DEMO_EXTRA_ORDERS: readonly Record<string, unknown>[] = [
  demoOrder(template(GBT02_PRODUCT.productCode, 'PROCESSING'), 'PO-GBT02-D001'),
  demoOrder(template(GBT02_PRODUCT.productCode, 'PROCESSING'), 'PO-GBT02-D002'),
  demoOrder(template(GBT02_PRODUCT.productCode, 'PACKAGING'), 'PO-GBT02-PK-D001'),
  demoOrder(template(GBT02_PRODUCT.productCode, 'PACKAGING'), 'PO-GBT02-PK-D002'),
];

/**
 * R5: GB-T-02's second lots (its first ones make two batches of 20 kg): enough for four more. They expire after the first
 * ones, so a first-expiring rule still points at the first lots while they last. GB-T-01's lots make three batches.
 */
const lot = (lotCode: string, materialCode: string, quantity: string, results: SeedPackLot['results'], identityMethod = 'IR-01'): SeedPackLot => ({
  lotCode, materialCode, quantity, expiresAt: '2030-06-30T00:00:00Z', identityMethod, results,
});
const lod = (v: string, max: string) => ({ testCode: 'LOD', methodReference: 'STP-LOD-01', value: v, unit: '%', upperLimit: max });
export const DEMO_EXTRA_LOTS: readonly SeedPackLot[] = [
  lot('GBT2-EXF-002', 'MAT-EXF', '40.000', [{ testCode: 'ASSAY', methodReference: 'STP-EXF-AS-01', value: '100.1', unit: '%', lowerLimit: '98.0', upperLimit: '102.0' }], 'IR-EXF-01'),
  lot('GBT2-MCC-002', 'MAT-MCC-102', '35.000', [lod('3.20', '5.0')]),
  lot('GBT2-CCS-002', 'MAT-CCS', '4.500', [lod('5.80', '10.0')]),
  lot('GBT2-SIO-002', 'MAT-SIO2', '1.000', [lod('1.30', '2.5')]),
  lot('GBT2-MGS-002', 'MAT-MGST', '2.000', [lod('3.00', '6.0')]),
  lot('GBT2-HDP-002', 'MAT-HDPE-60', '60.000', [{ testCode: 'DIMENSION', methodReference: 'STP-PM-DIM-01', value: '0', unit: '1', upperLimit: '0' }], 'VIS-PM-01'),
];
