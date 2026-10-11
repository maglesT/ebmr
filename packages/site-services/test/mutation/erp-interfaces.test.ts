/**
 * The ERP interfaces of site services, rule by rule (SQL mutation group "erp-interfaces": site services 0732, 0750,
 * 0751). These tests close the gaps the Phase 3 exit SQL mutation run found in test/lots and test/quality: each refusal
 * of a malformed material master, product master or production order and of a lot receipt on its own, with its code,
 * and the master version a receipt reads.
 *
 * Controls: PR-17, PR-18, IN-24; invariant INV-13.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { receiveLot, type LotReceipt } from '../../src/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers.ts';
import { refusal, seedCast, unique, World } from '../lots/support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 300_000);
afterAll(async () => {
  await db.drop();
});

const erp = (fn: string, p: unknown): Promise<string> => refusal(w.run(w.cast.erp, (c) => c.query(`select site.${fn}($1::jsonb)`, [p === undefined ? null : JSON.stringify(p)])));
const receive = (p: unknown): Promise<string> =>
  refusal(w.run(w.cast.warehouse, (c) => c.query('select site.receive_lot($1::jsonb)', [p === null ? null : JSON.stringify(p)])));

describe('the material master (site services 0750)', () => {
  it('[PR-17] a master row is an object; a maximum retest interval, when given, is whole months', async () => {
    const ok = { materialCode: unique('MM'), materialName: 'Lactose', materialKind: 'EXCIPIENT', unit: 'kg', erpReference: 'ERP-1' };
    expect(await erp('erp_receive_material', undefined)).toMatch(/EBMR-SITE-170/);
    expect(await erp('erp_receive_material', ['not', 'an', 'object'])).toMatch(/EBMR-SITE-170/);
    expect(await erp('erp_receive_material', { ...ok, maxRetestMonths: '1.5' })).toMatch(/EBMR-SITE-170/);
    expect(await erp('erp_receive_material', { ...ok, maxRetestMonths: 0 })).toMatch(/EBMR-SITE-170/);
    expect(await erp('erp_receive_material', ok)).toBe('');
    expect(await erp('erp_receive_material', { ...ok, materialCode: unique('MM'), maxRetestMonths: 24 })).toBe('');
  });

  it('[PR-17] the master of a material is its latest version, never another material\'s', async () => {
    const a = unique('MA');
    const b = unique('MB');
    await w.material(a, 'Old name', 'API');
    await w.material(a, 'New name', 'API', 'g', 12);
    await w.material(b, 'Other', 'EXCIPIENT');
    const { rows } = await db.app.query<{ m: unknown }>('select site.material_master_of($1) as m', [a]);
    expect(rows[0]?.m).toEqual({ materialName: 'New name', materialKind: 'API', unit: 'g', maxRetestMonths: 12 });
  });
});

describe('a lot receipt (site services 0750)', () => {
  it('[PR-17][PR-18][INV-13] each refusal on its own: no details, an unknown material, a kind, name or unit the master does not hold, a quantity that is not a decimal, no or a past expiry', async () => {
    const code = unique('MR');
    await w.material(code, 'Microcrystalline cellulose', 'EXCIPIENT', 'kg');
    const lot = { lotCode: unique('L'), materialCode: code, quantity: '10.000', expiresAt: '2030-01-01T00:00:00Z' };
    expect(await receive(null)).toMatch(/EBMR-SITE-103 the lot details are required/);
    expect(await receive('a lot')).toMatch(/EBMR-SITE-103 the lot details are required/);
    expect(await receive({ ...lot, materialCode: unique('NOPE') })).toMatch(/EBMR-SITE-171/);
    expect(await receive({ ...lot, materialKind: 'API' })).toMatch(/EBMR-SITE-172/);
    expect(await receive({ ...lot, materialName: 'Lactose' })).toMatch(/EBMR-SITE-172/);
    expect(await receive({ ...lot, unit: 'g' })).toMatch(/EBMR-SITE-172/);
    expect(await receive({ ...lot, quantity: '-1' })).toMatch(/EBMR-SITE-103 the received quantity is a positive decimal/);
    expect(await receive({ ...lot, quantity: '1e3' })).toMatch(/EBMR-SITE-103 the received quantity is a positive decimal/);
    const { expiresAt: _e, ...noExpiry } = lot;
    void _e;
    expect(await receive(noExpiry)).toMatch(/EBMR-SITE-104/);
    expect(await receive({ ...lot, expiresAt: '2020-01-01T00:00:00Z' })).toMatch(/EBMR-SITE-104/);
    // The master's own kind, name and unit given explicitly are accepted.
    expect(await receive({ ...lot, materialKind: 'EXCIPIENT', materialName: 'Microcrystalline cellulose', unit: 'kg' })).toBe('');
  });

  it('[PR-17][IN-24] a material is one kind at a site: a receipt of a material whose lots are of another kind, or that has a vendor route while no longer an excipient, is refused', async () => {
    const code = unique('MK');
    await w.receive('EXCIPIENT', { materialCode: code });
    // The master now says API: the lots received as excipient stand against it.
    await w.material(code, `Material ${code}`, 'API');
    expect(await receive({ lotCode: unique('L'), materialCode: code, quantity: '1', expiresAt: '2030-01-01T00:00:00Z' })).toMatch(/EBMR-SITE-105/);
    // A material with a vendor route whose master now says API (no lot of another kind at this site is needed).
    const routed = unique('MV');
    await w.material(routed, `Material ${routed}`, 'EXCIPIENT');
    await w.enableVendorHistory(routed);
    await w.material(routed, `Material ${routed}`, 'API');
    expect(await receive({ lotCode: unique('L'), materialCode: routed, quantity: '1', expiresAt: '2030-01-01T00:00:00Z' })).toMatch(/EBMR-SITE-105/);
    // An excipient with a vendor route and lots of its own kind is received.
    const fine = unique('MF');
    await w.receive('EXCIPIENT', { materialCode: fine });
    await w.enableVendorHistory(fine);
    const lot = await w.run(w.cast.warehouse, (c) =>
      receiveLot(c, { lotCode: unique('L'), materialCode: fine, quantity: '2.5', expiresAt: '2030-01-01T00:00:00Z' } as LotReceipt),
    );
    expect(lot.lotId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('the product master and production orders (site services 0732, 0751)', () => {
  it('[PR-17] a product master row is an object with a whole-month shelf life and a boolean beta-lactam flag', async () => {
    const ok = { productCode: unique('P'), strength: '10 mg', productName: 'Product', betaLactam: false, shelfLifeMonths: 24, erpReference: 'ERP-P' };
    expect(await erp('erp_receive_product', undefined)).toMatch(/EBMR-SITE-340/);
    expect(await erp('erp_receive_product', [ok])).toMatch(/EBMR-SITE-340/);
    expect(await erp('erp_receive_product', { ...ok, shelfLifeMonths: 0 })).toMatch(/EBMR-SITE-340/);
    const { shelfLifeMonths: _s, ...noShelfLife } = ok;
    void _s;
    expect(await erp('erp_receive_product', noShelfLife)).toMatch(/EBMR-SITE-340/);
    expect(await erp('erp_receive_product', ok)).toBe('');
  });

  it('[PR-17] a production order names a decimal batch size and a BOM of at least one line, each line exactly {materialCode, quantity, unit}, each material once', async () => {
    const line = { materialCode: 'API-1', quantity: '1.5', unit: 'kg' };
    const order = (over: Record<string, unknown> = {}) => ({
      orderNo: unique('PO'), siteCode: 'SITE-1', productCode: 'P1', strength: '10 mg', batchSize: '200', batchSizeUnit: 'kg', bom: [line], erpReference: 'ERP-O', ...over,
    });
    expect(await erp('erp_receive_order', undefined)).toMatch(/EBMR-SITE-175/);
    expect(await erp('erp_receive_order', [order()])).toMatch(/EBMR-SITE-175/);
    expect(await erp('erp_receive_order', order({ batchSize: '2e2' }))).toMatch(/EBMR-SITE-175/);
    expect(await erp('erp_receive_order', order({ bom: 'API-1' }))).toMatch(/EBMR-SITE-175/);
    expect(await erp('erp_receive_order', order({ bom: [] }))).toMatch(/EBMR-SITE-175/);
    expect(await erp('erp_receive_order', order({ bom: ['API-1'] }))).toMatch(/EBMR-SITE-176/);
    expect(await erp('erp_receive_order', order({ bom: [{ ...line, materialCode: 'api-1' }] }))).toMatch(/EBMR-SITE-176/);
    expect(await erp('erp_receive_order', order({ bom: [{ ...line, quantity: 1.5 }] }))).toMatch(/EBMR-SITE-176/);
    expect(await erp('erp_receive_order', order({ bom: [{ ...line, quantity: '1,5' }] }))).toMatch(/EBMR-SITE-176/);
    expect(await erp('erp_receive_order', order({ bom: [{ ...line, unit: '' }] }))).toMatch(/EBMR-SITE-176/);
    expect(await erp('erp_receive_order', order({ bom: [{ ...line, note: 'x' }] }))).toMatch(/EBMR-SITE-176/);
    expect(await erp('erp_receive_order', order({ bom: [line, { ...line, quantity: '2' }] }))).toMatch(/EBMR-SITE-176 a material appears once/);
    expect(await erp('erp_receive_order', order({ bom: [line, { ...line, materialCode: 'EXC-1' }] }))).toBe('');
  });
});
