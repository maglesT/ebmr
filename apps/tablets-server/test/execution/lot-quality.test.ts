/**
 * Phase 7 slice 7o (R4, R8): a lot's approved assay result (what a potency-adjusted dispensing reads, TB-01; tablets
 * 0841) and a printed packaging lot's artwork version (what a printed-materials issue checks, G-21; tablets 0950) are
 * recorded on screen through routes, on both installations against each one's own register: before, only the demo seed
 * recorded them, so a company's own lots could not be dispensed potency-adjusted or issued as printed packaging.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { actorOfBrowser, refusalOf, startSigningServer, terminalOf, valueOf } from '../esig/support.ts';
import { confirmErpPending } from '../support/signed-acts.ts';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
let sbx: TestServer;

beforeAll(async () => {
  [gmp, sbx] = await Promise.all([startSigningServer('GMP', { stub: false }), startServer('SANDBOX')]);
}, 300_000);

afterAll(async () => {
  await Promise.all([gmp?.close(), sbx?.close()]);
});

describe('a lot\'s assay result and artwork version on screen (slice 7o)', () => {
  it('[PR-19][PR-32][DI-33][DI-05] the sandbox steward records a test lot\'s assay and a printed test lot\'s artwork; a later assay supersedes with a reason and the earlier stays; the artwork never changes; nothing reaches GMP', async () => {
    const steward = await sbx.asPersona('steward');
    const code = `TEST-L26-Q${randomBytes(2).toString('hex').toUpperCase()}`;
    valueOf(await steward.call(routes.execution.registerTestLot, { body: { lotCode: code, materialCode: 'MAT-FOIL-X', materialName: 'Printed foil (test)', expiresInDays: 365 } }));
    expect(valueOf(await steward.call(routes.execution.lotQuality, { params: { code } }))).toMatchObject({ lotCode: code, assay: null, artwork: null });
    const first = valueOf(await steward.call(routes.execution.recordLotAssay, { params: { code }, body: { basis: 'ANHYDROUS_WATER', assay: '99.2', water: '0.8', certificateRef: 'COA-1' } }));
    expect(first.assay).toMatchObject({ basis: 'ANHYDROUS_WATER', assay: '99.2', water: '0.8', certificateRef: 'COA-1' });
    // A missing value of the basis is the database's refusal (EBMR-EXE-242); a second result needs the reason.
    expect(refusalOf(await steward.call(routes.execution.recordLotAssay, { params: { code }, body: { basis: 'DRIED_LOD', assay: '98.0', certificateRef: 'COA-2', reason: 'Re-assayed' } })).why).toMatch(/EBMR-EXE-242|loss on drying/);
    expect(refusalOf(await steward.call(routes.execution.recordLotAssay, { params: { code }, body: { basis: 'AS_IS', assay: '98.5', certificateRef: 'COA-2' } })).why).toMatch(/supersedes|reason/);
    const second = valueOf(await steward.call(routes.execution.recordLotAssay, { params: { code }, body: { basis: 'AS_IS', assay: '98.5', certificateRef: 'COA-2', reason: 'Re-assayed after the retest' } }));
    expect(second.assay).toMatchObject({ basis: 'AS_IS', assay: '98.5', water: null });
    expect(Number((await sbx.db.admin.query<{ n: string }>('select count(*) as n from tab.lot_assay_result where sandbox_lot_code = $1', [code])).rows[0]?.n)).toBe(2);
    expect(valueOf(await steward.call(routes.execution.recordLotArtwork, { params: { code }, body: { artwork: 'ART-TEST-FOIL-1' } })).artwork).toBe('ART-TEST-FOIL-1');
    expect(refusalOf(await steward.call(routes.execution.recordLotArtwork, { params: { code }, body: { artwork: 'ART-TEST-FOIL-2' } })).why).toMatch(/never changes|already/);
    // Nothing of it in the GMP database; GMP names a TEST- lot as the sandbox's and never looks it up (DI-05).
    expect(Number((await gmp.db.admin.query<{ n: string }>("select count(*) as n from tab.lot_assay_result r join site.material_lot l on l.id = r.material_lot_id where l.lot_code = $1", [code])).rows[0]?.n)).toBe(0);
    const qc = await gmp.asPersona('qcAnalyst');
    expect(refusalOf(await qc.call(routes.execution.lotQuality, { params: { code } })).status).toBe(422);
  });

  it('[PR-19][PR-32][DI-17] on GMP the steward may not record a site lot\'s assay (QC.RESULT_RECORD); the QC analyst names approved LIMS results, never a typed value (tablets 1001); an artwork version is refused for a lot that is not printed packaging; QC records the lot\'s identity test result', async () => {
    // A material the ERP sends and QA confirms, and a lot of it received by stores (the receipt's own act).
    const t = randomBytes(3).toString('hex').toUpperCase();
    const code = `QL-${t}`;
    const erp = gmp.seed.services.find((x) => x.key === 'erpInterface');
    if (!erp) throw new Error('no ERP interface in the GMP seed');
    const creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(gmp.seed, erp.terminal).fingerprint };
    const material = { materialCode: `MAT-QL-${t}`, materialName: 'Excipient for the lot quality test', materialKind: 'EXCIPIENT' as const, unit: 'kg', maxRetestMonths: 24, erpReference: `SAP-QL-${t}` };
    valueOf(await gmp.browser().call(routes.quality.erpImport, { body: { ...creds, catalogue: { products: [], materials: [material], orders: [] } } }));
    await confirmErpPending(gmp);
    await withCommand(gmp.db.app, await actorOfBrowser(gmp, await gmp.asPersona('stores'), 'stores'), (c) =>
      c.query('select site.receive_lot($1::jsonb) as r', [JSON.stringify({ lotCode: code, materialCode: material.materialCode, quantity: '10.000', expiresAt: '2029-06-30T00:00:00Z' })]),
    );
    const steward = await gmp.asPersona('steward');
    expect(refusalOf(await steward.call(routes.execution.recordLotAssay, { params: { code }, body: { basis: 'AS_IS', assay: '99.0', certificateRef: 'COA-GMP-1' } })).status).toBe(422);
    const qc = await gmp.asPersona('qcAnalyst');
    // On GMP a typed value is refused: the values are the lot's approved LIMS results, named by id (tablets 1001).
    expect(refusalOf(await qc.call(routes.execution.recordLotAssay, { params: { code }, body: { basis: 'DRIED_LOD', assay: '99.4', lod: '0.5', certificateRef: 'COA-GMP-1' } })).why).toMatch(/typed value is refused/);
    expect(refusalOf(await qc.call(routes.execution.recordLotArtwork, { params: { code }, body: { artwork: 'ART-X-1' } })).why).toMatch(/not printed packaging/);
    // The identity test result on screen (the release route IDENTITY_TESTED stands on it); the steward may not.
    const lotId = (await gmp.db.admin.query<{ id: string }>('select id from site.material_lot where lot_code = $1', [code])).rows[0]?.id ?? '';
    expect(refusalOf(await steward.call(routes.quality.recordIdentityResult, { params: { lotId }, body: { result: 'PASS', methodReference: 'IR-01', testReference: `ID-${code}` } })).status).toBe(422);
    expect(valueOf(await qc.call(routes.quality.recordIdentityResult, { params: { lotId }, body: { result: 'PASS', methodReference: 'IR-01', testReference: `ID-${code}` } }))).toMatchObject({ result: 'PASS' });
    expect(Number((await gmp.db.admin.query<{ n: string }>("select count(*) as n from site.lot_identity_result where lot_id = $1 and result = 'PASS'", [lotId])).rows[0]?.n)).toBe(1);
  });
});
