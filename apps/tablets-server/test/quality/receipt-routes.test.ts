/**
 * The receipt routes over HTTP (Phase 6 slice 6a, builder A; contract ns/receipt.ts; site services 0910 to 0915; PR-17,
 * DI-31): stores receive a delivery with its supplier batches, QA keeps the approved-manufacturer register (the approval
 * through the e-signature ceremony, MATERIAL_SOURCE_ACT), the examiner records the examination, and the receipt view
 * shows whether the lot may be issued as the database decides it.
 */
import { randomUUID } from 'node:crypto';
import { routes } from '@ebmr/api-contract';
import { terminalOf } from '@ebmr/test-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestServer } from '../support/harness.ts';
import { confirmErpPending, signAction } from '../support/signed-acts.ts';

/** Asymmetric matchers, typed for the object literals they sit in. */
const matching = (re: RegExp): string => expect.stringMatching(re) as string;
const like = <T extends Record<string, unknown>>(o: T): T => expect.objectContaining(o as never) as T;

const Q = routes.quality;
let gmp: TestServer;
const MATERIAL = `MAT-RC-${randomUUID().slice(0, 6).toUpperCase()}`;

beforeAll(async () => {
  gmp = await startSigningServer('GMP');
  const erp = gmp.seed.services.find((s) => s.key === 'erpInterface');
  if (!erp) throw new Error('no ERP interface in the GMP seed');
  const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(gmp.seed, erp.terminal).fingerprint };
  const material = { materialCode: MATERIAL, materialName: 'Receipt test API', materialKind: 'API' as const, unit: 'kg', maxRetestMonths: 24, erpReference: `SAP-${MATERIAL}` };
  valueOf(await gmp.browser().call(Q.erpImport, { body: { ...creds, catalogue: { products: [], materials: [material], orders: [] } } }));
  await confirmErpPending(gmp);
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

const batch = (supplierLot: string, manufacturerCode: string) => ({ supplierLot, manufacturerCode, containers: '2', quantity: { value: '25.000', unit: 'kg' }, expiresAt: '2030-06-30T00:00:00+05:30' });

describe('receipt routes (PR-17)', () => {
  it('[PR-17] stores receive a delivery of three supplier batches as three lots; QA approves the manufacturer with its signature; the examined lot is free to issue and the unapproved one is blocked', async () => {
    const [stores, qa] = await Promise.all([gmp.asPersona('stores'), gmp.asPersona('qaInvestigator')]);
    // QA proposes the manufacturer; it is not yet approved.
    const proposed = valueOf(await qa.call(Q.proposeApprovedManufacturer, { body: { materialCode: MATERIAL, manufacturerCode: 'MFR-OK', manufacturerName: 'Approved Chem Ltd', basis: 'Qualification file QF-2026-021 and audit AR-2026-09' } }));
    expect(proposed.state).toBe('PROPOSED');
    // Stores cannot propose (MATERIAL.QA_DISPOSITION).
    expect(refusalOf(await stores.call(Q.proposeApprovedManufacturer, { body: { materialCode: MATERIAL, manufacturerCode: 'MFR-X', manufacturerName: 'X', basis: 'no basis at all here' } }))?.code).toMatch(/EBMR-(IAM|PLAT)-\d{3}/);
    const signed = await signAction(gmp, qa, 'qaInvestigator', { kind: 'MATERIAL_SOURCE_ACT', act: 'MANUFACTURER_APPROVE', approvedManufacturerId: proposed.approvedManufacturerId });
    expect(signed.ok ? 'ok' : JSON.stringify(signed.error)).toBe('ok');
    const register = valueOf(await qa.call(Q.approvedManufacturers, { query: { materialCode: MATERIAL } })).manufacturers;
    expect(register).toEqual([like({ manufacturerCode: 'MFR-OK', state: 'APPROVED', approvedBy: like({ loginName: 'divya.menon' }) })]);
    // The delivery: three supplier batches, the third from a manufacturer not on the register.
    const deliveryId = `GRN-${randomUUID().slice(0, 6)}`;
    const received = valueOf(await stores.call(Q.receiveDelivery, { body: { deliveryId, materialCode: MATERIAL, supplierCode: 'SUP-1', deliveryNoteName: 'Receipt test API', supplierBatches: [batch('SB-1', 'MFR-OK'), batch('SB-2', 'MFR-OK'), batch('SB-3', 'MFR-NOPE')] } }));
    expect(received.lots.map((l) => [l.supplierLot, l.manufacturerApproved])).toEqual([['SB-1', true], ['SB-2', true], ['SB-3', false]]);
    const [first, , third] = received.lots;
    if (!first || !third) throw new Error('lots missing');
    // Not examined yet: the receipt view says why the lot cannot be issued.
    expect(valueOf(await stores.call(Q.lotReceipt, { params: { lotId: first.lotId } }))).toMatchObject({ deliveryId, supplierLot: 'SB-1', containers: '2', source: 'MANUAL', examination: null, issueProblem: matching(/^EBMR-SITE-917 .* were not examined at receipt/) });
    const examined = valueOf(await stores.call(Q.examineLotReceipt, { params: { lotId: first.lotId }, body: { containersExamined: '2', outcome: 'ACCEPTABLE' } }));
    expect(examined).toMatchObject({ examination: { containersExamined: '2', outcome: 'ACCEPTABLE', by: like({ loginName: 'manoj.pillai' }) }, issueProblem: null, manufacturerApprovedNow: true });
    valueOf(await stores.call(Q.examineLotReceipt, { params: { lotId: third.lotId }, body: { containersExamined: '2', outcome: 'ACCEPTABLE' } }));
    expect(valueOf(await stores.call(Q.lotReceipt, { params: { lotId: third.lotId } }))).toMatchObject({ manufacturerApprovedAtReceipt: false, issueProblem: matching(/^EBMR-SITE-918 lot .* names manufacturer MFR-NOPE/) });
    // A WMS correction route on a receipt stores entered by hand is refused (not interface-captured).
    expect(refusalOf(await stores.call(Q.correctLotReceipt, { params: { lotId: first.lotId }, body: { field: 'containers', value: '3', reason: 'recount' } }))?.code).toBe('EBMR-SITE-923');
    // QA withdraws the approval: the examined lot is blocked again.
    const withdrawn = valueOf(await qa.call(Q.withdrawManufacturerApproval, { params: { approvedManufacturerId: proposed.approvedManufacturerId }, body: { reason: 'Audit AR-2026-11 found gaps' } }));
    expect(withdrawn).toMatchObject({ state: 'WITHDRAWN', withdrawal: { reason: 'Audit AR-2026-11 found gaps' } });
    expect(valueOf(await stores.call(Q.lotReceipt, { params: { lotId: first.lotId } })).issueProblem).toMatch(/^EBMR-SITE-918/);
  });

  it('[PR-17] a lot received without a receipt record gets one by route; its view refuses issue until then', async () => {
    const stores = await gmp.asPersona('stores');
    const lotCode = `L-RC-${randomUUID().slice(0, 6).toUpperCase()}`;
    const lot = valueOf(await stores.call(Q.receiveLot, { body: { materialCode: MATERIAL, lotCode, supplier: 'SUP-1', supplierLot: `S-${lotCode}`, quantity: '10.000', expiresAt: '2030-06-30T00:00:00+05:30' } }));
    expect(refusalOf(await stores.call(Q.lotReceipt, { params: { lotId: lot.lotId } }))).toMatchObject({ status: 404, code: 'NO_RECEIPT_RECORD' });
    const view = valueOf(await stores.call(Q.recordLotReceipt, { params: { lotId: lot.lotId }, body: { deliveryId: `GRN-${lotCode}`, supplierCode: 'SUP-1', supplierLot: `S-${lotCode}`, manufacturerCode: 'MFR-OK', containers: '1' } }));
    expect(view).toMatchObject({ lotCode, supplierLot: `S-${lotCode}`, containers: '1', received: { value: '10.000', unit: 'kg' }, issueProblem: matching(/^EBMR-SITE-917/) });
    expect(refusalOf(await stores.call(Q.recordLotReceipt, { params: { lotId: lot.lotId }, body: { deliveryId: 'GRN-AGAIN', supplierCode: 'SUP-1', supplierLot: `S-${lotCode}`, manufacturerCode: 'MFR-OK', containers: '1' } }))?.code).toBe('EBMR-SITE-915');
  });
});
