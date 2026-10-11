/**
 * The ERP stub's seeded catalogue (Phase 3 slice 5a; slice 5 plan D-S5-4; outline 4.6: the ERP owns the item master and
 * the orders). DEMO-ONLY data: the product master, the material master and production orders for the demo MBR
 * (dc-mini: paracetamol 500 mg tablets, batch sizes BS-100K = 60 kg and BS-50K = 30 kg). The order BOMs are the MBR's,
 * scaled exactly from its reference size (decimal text, never a JavaScript number), so the tablets server's database
 * accepts them at GMP issue (recipe-core 0602). The shapes are the tablets server's import route (POST /api/erp/import).
 */

export interface ErpProductRow {
  productCode: string;
  strength: string;
  productName: string;
  reprocessingPermitted?: boolean;
  betaLactam: boolean;
  shelfLifeMonths: number;
  erpReference: string;
}

export interface ErpMaterialRow {
  materialCode: string;
  materialName: string;
  materialKind: 'API' | 'EXCIPIENT' | 'PRIMARY_PACKAGING' | 'PRINTED_PACKAGING' | 'INTERMEDIATE' | 'FINISHED';
  unit: string;
  maxRetestMonths?: number;
  erpReference: string;
}

export interface ErpOrderRow {
  orderNo: string;
  siteCode: string;
  productCode: string;
  strength: string;
  batchSize: string;
  batchSizeUnit: string;
  bom: { materialCode: string; quantity: string; unit: string }[];
  erpReference: string;
}

export interface ErpCatalogue {
  products: ErpProductRow[];
  materials: ErpMaterialRow[];
  orders: ErpOrderRow[];
}

/** The demo MBR's BOM for its reference batch size (60 kg). */
const REFERENCE_KG = '60.000';
const REFERENCE_BOM: readonly { materialCode: string; quantity: string }[] = [
  { materialCode: 'MAT-PCM', quantity: '50.000' },
  { materialCode: 'MAT-MCC', quantity: '9.400' },
  { materialCode: 'MAT-MGS', quantity: '0.600' },
];

function parseDecimal(s: string): { n: bigint; scale: number } {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`not a decimal: ${s}`);
  const frac = m[2] ?? '';
  return { n: BigInt((m[1] ?? '0') + frac), scale: frac.length };
}

/** Exact decimal q x num / den in decimal text (the shortest scale that makes it exact); refused when none does. */
export function scaleDecimal(q: string, num: string, den: string): string {
  const a = parseDecimal(q);
  const b = parseDecimal(num);
  const c = parseDecimal(den);
  // value = a.n * b.n * 10^c.scale / (c.n * 10^(a.scale + b.scale))
  const top = a.n * b.n * 10n ** BigInt(c.scale);
  for (let extra = 0; extra <= 12; extra += 1) {
    const scaled = top * 10n ** BigInt(extra);
    if (scaled % c.n === 0n) {
      const scale = a.scale + b.scale + extra;
      const v = (scaled / c.n).toString().padStart(scale + 1, '0');
      return scale === 0 ? v : `${v.slice(0, v.length - scale)}.${v.slice(v.length - scale)}`;
    }
  }
  throw new Error(`${q} x ${num} / ${den} is not an exact decimal`);
}

/** A production order of the demo product for a batch of `batchKg` kg at `siteCode`. */
export function demoOrder(orderNo: string, batchKg: string, siteCode = 'SITE-1'): ErpOrderRow {
  return {
    orderNo,
    siteCode,
    productCode: 'PCM500',
    strength: '500 mg',
    batchSize: batchKg,
    batchSizeUnit: 'kg',
    bom: REFERENCE_BOM.map((b) => ({ materialCode: b.materialCode, quantity: scaleDecimal(b.quantity, batchKg, REFERENCE_KG), unit: 'kg' })),
    erpReference: `SAP-PP-${orderNo}`,
  };
}

/** The seeded catalogue: `orders` production orders (alternately 60 kg and 30 kg), numbered from `firstOrder`. */
export function erpCatalogue(opts: { siteCode?: string; orders?: number; firstOrder?: number } = {}): ErpCatalogue {
  const n = opts.orders ?? 4;
  const first = opts.firstOrder ?? 1;
  return {
    products: [
      { productCode: 'PCM500', strength: '500 mg', productName: 'Paracetamol tablets IP 500 mg', reprocessingPermitted: false, betaLactam: false, shelfLifeMonths: 36, erpReference: 'SAP-MM-FG-PCM500' },
    ],
    materials: [
      { materialCode: 'MAT-PCM', materialName: 'Paracetamol IP, direct-compression grade', materialKind: 'API', unit: 'kg', maxRetestMonths: 24, erpReference: 'SAP-MM-RM-PCM' },
      { materialCode: 'MAT-MCC', materialName: 'Microcrystalline cellulose PH 102', materialKind: 'EXCIPIENT', unit: 'kg', maxRetestMonths: 36, erpReference: 'SAP-MM-RM-MCC' },
      { materialCode: 'MAT-MGS', materialName: 'Magnesium stearate', materialKind: 'EXCIPIENT', unit: 'kg', maxRetestMonths: 36, erpReference: 'SAP-MM-RM-MGS' },
    ],
    orders: Array.from({ length: n }, (_, i) => demoOrder(`PO-DEMO-${String(first + i).padStart(4, '0')}`, i % 2 === 0 ? '60.000' : '30.000', opts.siteCode ?? 'SITE-1')),
  };
}

/** Posts the catalogue to the tablets server's import route as the ERP interface's service identity. */
export async function postCatalogue(
  serverUrl: string,
  identity: { loginName: string; serviceKey: string; fingerprint: string },
  catalogue: ErpCatalogue,
): Promise<{ products: number; materials: number; orders: number }> {
  const res = await fetch(new URL('/api/erp/import', serverUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...identity, catalogue }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`the import was refused (${String(res.status)}): ${text}`);
  return JSON.parse(text) as { products: number; materials: number; orders: number };
}
