/**
 * The quality feature on the GMP server (Phase 3 slice 5a step 5): deviation-lite and LIMS-lite routes run the person's
 * own command, and the ERP stub's import runs as the ERP interface's service identity; every rule is the database's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { quality } from '@ebmr/api-contract';
import { terminalOf } from '@ebmr/test-kit';
import { startServer, type TestServer } from '../support/harness.ts';
import { refusalOf, valueOf } from '../esig/support.ts';

let gmp: TestServer;

/** The shape apps/simulators/src/erp posts (apps never import each other): one product, one material, `orders` orders. */
function erpCatalogue(opts: { orders: number; firstOrder?: number }) {
  return {
    products: [{ productCode: 'PCM500', strength: '500 mg', productName: 'Paracetamol tablets IP 500 mg', betaLactam: false, shelfLifeMonths: 36, erpReference: 'SAP-MM-FG-PCM500' }],
    materials: [{ materialCode: 'MAT-PCM', materialName: 'Paracetamol IP', materialKind: 'API' as const, unit: 'kg', maxRetestMonths: 24, erpReference: 'SAP-MM-RM-PCM' }],
    orders: Array.from({ length: opts.orders }, (_, i) => ({
      orderNo: `PO-DEMO-${String((opts.firstOrder ?? 1) + i)}`, siteCode: 'SITE-1', productCode: 'PCM500', strength: '500 mg', batchSize: '60.000', batchSizeUnit: 'kg',
      bom: [{ materialCode: 'MAT-PCM', quantity: '50.000', unit: 'kg' }], erpReference: `SAP-PP-${String(i)}`,
    })),
  };
}

beforeAll(async () => {
  gmp = await startServer('GMP');
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('quality routes (GMP)', () => {
  it('[PR-49][PR-17] a QA person raises and investigates a deviation-lite record with a generated reference; the ERP interface imports its catalogue and nobody else can', async () => {
    const qa = await gmp.asPersona('qaInvestigator');
    const d = valueOf(await qa.call(quality.raiseDeviation, { body: { kind: 'DEVIATION', title: 'Label roll mix-up', classification: 'MINOR', riskRationale: 'Caught at line clearance; no product affected' } }));
    expect(d.ref).toMatch(/^DEV-SITE-1-\d{4}-\d{5}$/);
    expect(d.state).toBe('OPEN');
    const started = valueOf(await qa.call(quality.startInvestigation, { params: { deviationId: d.deviationId }, body: {} }));
    expect(started.state).toBe('UNDER_INVESTIGATION');
    // The initiator cannot cancel their own record (S7): the database refuses it.
    expect(refusalOf(await qa.call(quality.cancelDeviation, { params: { deviationId: d.deviationId }, body: { reason: 'raised in error' } }))?.why).toMatch(/EBMR-SITE-307|other than the initiator/);

    const erp = gmp.seed.services.find((s) => s.key === 'erpInterface');
    if (!erp) throw new Error('no ERP interface in the GMP seed');
    const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(gmp.seed, erp.terminal).fingerprint };
    const browser = gmp.browser();
    const out = valueOf(await browser.call(quality.erpImport, { body: { ...creds, catalogue: erpCatalogue({ orders: 2, firstOrder: 9001 }) } }));
    expect(out).toEqual({ products: 1, materials: 1, orders: 2 });
    const { rows } = await gmp.db.admin.query<{ n: string }>("select count(*)::text as n from site.erp_production_order where order_no in ('PO-DEMO-9001', 'PO-DEMO-9002')");
    expect(rows[0]?.n).toBe('2');
    // A wrong key is refused, and a person's credentials never write the ERP stub.
    expect((await browser.call(quality.erpImport, { body: { ...creds, serviceKey: `${creds.serviceKey}x`, catalogue: erpCatalogue({ orders: 0 }) } })).ok).toBe(false);
  });
});
