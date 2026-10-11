/**
 * The ERP stub's seeded catalogue (slice 5a, D-S5-4): every order's BOM names catalogue materials in their units, with
 * the demo MBR's quantities scaled exactly to its batch size; decimals travel as text.
 */
import { describe, expect, it } from 'vitest';
import { demoOrder, erpCatalogue, scaleDecimal } from '../../src/erp/catalogue.ts';

describe('ERP stub catalogue', () => {
  it('scales the reference BOM exactly and keeps decimals as text', () => {
    expect(scaleDecimal('50.000', '30.000', '60.000')).toBe('25.000000');
    expect(scaleDecimal('9.400', '60.000', '60.000')).toBe('9.400000');
    expect(scaleDecimal('0.600', '30', '60')).toBe('0.300');
    expect(() => scaleDecimal('1', '1', '3')).toThrow(/not an exact decimal/);
    expect(demoOrder('PO-X', '30.000').bom.map((b) => b.quantity)).toEqual(['25.000000', '4.700000', '0.300000']);
  });

  it('every order names materials of the catalogue in their units, once each, for the catalogue product', () => {
    const c = erpCatalogue({ orders: 3 });
    expect(c.orders.map((o) => o.orderNo)).toEqual(['PO-DEMO-0001', 'PO-DEMO-0002', 'PO-DEMO-0003']);
    for (const o of c.orders) {
      expect(c.products.some((p) => p.productCode === o.productCode && p.strength === o.strength)).toBe(true);
      expect(new Set(o.bom.map((b) => b.materialCode)).size).toBe(o.bom.length);
      for (const b of o.bom) {
        const m = c.materials.find((x) => x.materialCode === b.materialCode);
        expect(m?.unit).toBe(b.unit);
        expect(b.quantity).toMatch(/^\d+(\.\d+)?$/);
      }
    }
    expect(c.products[0]?.reprocessingPermitted).toBe(false);
  });
});
