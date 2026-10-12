/**
 * The EU QP batch package, the QP's read-only access and the ERP shipping interlock over HTTP (Phase 4 slice 4b; contract
 * ns/qp-shipping.ts; kernel 1160, site services 0870). QA assembles the package of a released lot (true copies of the
 * processing and packaging records and the release, the documents), signs it through the ceremony
 * (QP_PACKAGE_ACT, TRUE_COPY_VERIFIED) and grants a QP account access; the QP lists and downloads it and the copy verifies
 * offline against the registered hash; the QP account reaches nothing else. The ERP stub asks and ships through the
 * interlock with its service identity.
 *
 * Fixtures, not proofs: two real GMP batches are issued; the second stands in as the processing batch the first packs
 * (recipe.packaging_parent_of answers it for this lot; the packaging-order path is the edition's), and the manufacturer
 * release is arranged as its act leaves it (decision row, the lot RELEASED), because the release act itself is proven by
 * the release tests.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { records, withCommand } from '@ebmr/kernel';
import { terminalOf } from '@ebmr/test-kit';
import { refusalOf, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { actorOf, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import type { TestBrowser } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

let w: GmpBatchWorld;
let qa: TestBrowser;
let lotId: string;
let creds: { loginName: string; serviceKey: string; fingerprint: string };

async function fixture(sql: string, params: unknown[]): Promise<void> {
  const c = await w.gmp.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(sql, params);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  w = await startGmpBatchWorld();
  const issuer = await w.gmp.asPersona('issuer');
  qa = await w.gmp.asPersona('qaInvestigator');
  const packaging = await w.issued(issuer);
  const processing = await w.issued(issuer);
  const number = (await w.gmp.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [packaging])).rows[0]!.n;
  const stores = await actorOf(w.gmp, 'stores');
  lotId = await withCommand(w.gmp.db.admin, { ...stores, correlationId: randomUUID() }, async (c) =>
    (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId: packaging, batchNumber: number, edition: 'TABLETS', siteCode: 'SITE-1', productCode: w.content.header.product.code, productName: 'QP package product',
                       strength: '500 mg', markets: ['IN', 'EU'], quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
    ])).rows[0]!.id,
  );
  await w.gmp.db.admin.query(`
    create schema stub_qp;
    create table stub_qp.parent (child uuid primary key, parent uuid not null);
    alter schema stub_qp owner to ebmr_owner; alter table stub_qp.parent owner to ebmr_owner;
    create or replace function recipe.packaging_parent_of(p_order uuid) returns uuid
    language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
      select coalesce((select s.parent from stub_qp.parent s where s.child = p_order),
                      (select pl.batch_id from recipe.batch_allocation_link l join site.batch_number_allocation a on a.id = l.allocation_id
                         join recipe.batch_allocation_link pl on pl.allocation_id = a.parent_allocation_id where l.batch_id = p_order limit 1))
    $$;`);
  await w.gmp.db.admin.query('insert into stub_qp.parent (child, parent) values ($1, $2)', [packaging, processing]);
  // The state the AP's release leaves: its decision row (audited, in the release chain) and the lot RELEASED.
  const ap = await actorOf(w.gmp, 'qcuAuthoriser');
  // The departments' notification (IN-39) needs the real signature; it is not what this file proves.
  await withCommand(w.gmp.db.admin, { ...ap, correlationId: randomUUID() }, async (c) => {
    await c.query('alter table recipe.manufacturer_release_decision disable trigger zzzn_notify_departments');
    await c.query(`insert into recipe.manufacturer_release_decision (lot_id, decision, signature_id, epoch, checklist, checklist_hash, content_hash, person_id, account_id, role_code, correlation_id)
             values ($1, 'RELEASED', gen_random_uuid(), repeat('0', 64), '{"items": []}', repeat('0', 64), 'fixture', $2, $3, 'AUTHORISED_PERSON', gen_random_uuid())`, [lotId, ap.personId, ap.accountId]);
    await c.query('alter table recipe.manufacturer_release_decision enable trigger zzzn_notify_departments');
  });
  await fixture("update platform.aggregate_state set state = 'RELEASED' where aggregate_type = 'material_lot' and aggregate_id = $1", [lotId]);
  const erp = w.gmp.seed.services.find((s) => s.key === 'erpInterface');
  if (!erp) throw new Error('no ERP interface in the GMP seed');
  creds = { loginName: erp.loginName, serviceKey: erp.serviceKey, fingerprint: terminalOf(w.gmp.seed, erp.terminal).fingerprint };
}, 600_000);
afterAll(async () => {
  await w?.close();
});

describe('the EU QP batch package over HTTP (DI-41, DI-14)', () => {
  it('[DI-41][DI-14] QA assembles and signs the package of a released lot; the QP lists and downloads it, the copy verifies against the registered hash, and the QP account reaches nothing else', async () => {
    const before = valueOf(await qa.call(routes.qpPackage.lot, { params: { lotId } }));
    expect(before).toMatchObject({ lotId, assembleProblems: [], packages: [], accesses: [] });
    const pkg = valueOf(await qa.call(routes.qpPackage.assemble, { params: { lotId }, body: {} }));
    expect(pkg).toMatchObject({ lotId, state: 'ASSEMBLED', issuedBy: null });
    expect(pkg.sections.map((s) => s.role)).toEqual(expect.arrayContaining(['PROCESSING_RECORD', 'PACKAGING_RECORD', 'AUDIT_TRAIL_REVIEW', 'POST_ENTRY_CHANGES', 'DEVIATIONS', 'RELEASE', 'COA']));
    const stored = (await w.gmp.db.admin.query<{ h: string }>('select package_sha256 as h from records.qp_package where id = $1', [pkg.packageId])).rows[0]?.h;
    expect(stored).toBe(pkg.packageSha256);

    // Before it is issued, no access is granted.
    const qpPerson = await grantedPerson(w.gmp, 'EU_QP_READER', 'Dr. Anna Weber');
    const validToUs = ((await w.gmp.db.admin.query<{ us: string }>("select (extract(epoch from clock_timestamp() + interval '7 days') * 1000000)::bigint::text as us")).rows[0]!.us);
    const grant = { accountId: qpPerson.accountId, validToUs, reason: 'TA-2026-01: lot for import' };
    expect(JSON.stringify(refusalOf(await qa.call(routes.qpPackage.grantAccess, { params: { packageId: pkg.packageId }, body: grant })))).toMatch(/EBMR-REC-086|issued QP batch package only/);
    valueOf(await signAction(w.gmp, qa, 'qaInvestigator', { kind: 'QP_PACKAGE_ACT', act: 'ISSUE', packageId: pkg.packageId }));
    const access = valueOf(await qa.call(routes.qpPackage.grantAccess, { params: { packageId: pkg.packageId }, body: grant }));
    expect(access).toMatchObject({ lotId, state: 'LIVE', accountId: qpPerson.accountId, reads: 0 });
    expect(valueOf(await qa.call(routes.qpPackage.lot, { params: { lotId } })).packages[0]).toMatchObject({ state: 'ISSUED' });

    const qp = await loginOf(w.gmp, qpPerson);
    const list = valueOf(await qp.call(routes.qpPackage.readerPackages, {}));
    expect(list.packages.map((p) => p.packageId)).toEqual([pkg.packageId]);
    const file = valueOf(await qp.call(routes.qpPackage.readerFile, { params: { packageId: pkg.packageId } }));
    expect(records.verifyQpPackageText(file.content, { packageSha256: pkg.packageSha256 })).toMatchObject({ ok: true, reference: 'MATCHED' });
    // Read-only, one lot: every other route is closed to the QP account; another package id is refused by the database.
    for (const r of [await qp.call(routes.release.queue, { query: {} }), await qp.call(routes.qpPackage.lot, { params: { lotId } }), await qp.call(routes.erpShipping.lot, { params: { lotId } })]) {
      expect(refusalOf(r)).toMatchObject({ status: 403, code: 'QP_READER_SCOPE' });
    }
    expect(JSON.stringify(refusalOf(await qp.call(routes.qpPackage.readerFile, { params: { packageId: randomUUID() } })))).toMatch(/EBMR-REC-090|is open to this account/);
    expect(valueOf(await qa.call(routes.qpPackage.revokeAccess, { params: { accessId: access.accessId }, body: { reason: 'Lot certified' } }))).toMatchObject({ state: 'REVOKED', reads: 1 });
    expect(JSON.stringify(refusalOf(await qp.call(routes.qpPackage.readerFile, { params: { packageId: pkg.packageId } })))).toMatch(/EBMR-REC-090|is open to this account/);
  });
});

describe('the ERP shipping interlock over HTTP (INV-42)', () => {
  it('[INV-42][IN-05] the ERP asks before it ships: India ships after the release; the EU waits for its disposition and the named importer; a refused shipment records nothing', async () => {
    const browser = w.gmp.browser();
    const shipment = { lotId, market: 'IN' as const, consigneeCode: 'CUST-IN-01', consigneeName: 'Distributor India', quantity: '400', unit: 'units', quarantine: false };
    expect(valueOf(await browser.call(routes.erpShipping.check, { body: { ...creds, shipment } }))).toEqual({ allowed: true, problems: [] });
    const eu = { ...shipment, market: 'EU' as const, consigneeCode: 'IMP-DE-01', consigneeName: 'Importer GmbH', quarantine: true };
    const euCheck = valueOf(await browser.call(routes.erpShipping.check, { body: { ...creds, shipment: eu } }));
    expect(euCheck.allowed).toBe(false);
    expect(euCheck.problems.join(' ')).toMatch(/EU disposition of lot .* is NOT_READY/);
    expect(euCheck.problems.join(' ')).toMatch(/no EU importer is named for product/);
    const refused = await browser.call(routes.erpShipping.record, { body: { ...creds, shipment: { ...eu, shipmentNo: 'SH-EU-1', erpReference: 'DN-1' } } });
    expect(refused.ok).toBe(false);
    const ok = valueOf(await browser.call(routes.erpShipping.record, { body: { ...creds, shipment: { ...shipment, shipmentNo: `SH-${randomUUID().slice(0, 8).toUpperCase()}`, erpReference: 'DN-2' } } }));
    expect(ok).toMatchObject({ lotId, market: 'IN', manufacturerState: 'RELEASED', dispositionState: 'RELEASED', quantity: '400' });
    expect((await browser.call(routes.erpShipping.check, { body: { ...creds, serviceKey: `${creds.serviceKey}x`, shipment } })).ok).toBe(false);
    const listed = valueOf(await qa.call(routes.erpShipping.lot, { params: { lotId } }));
    expect(listed.shipments.map((s) => s.shipmentId)).toEqual([ok.shipmentId]);
  });
});
