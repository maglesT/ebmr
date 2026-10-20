/**
 * The master-data and configuration acts of slice 7h, work package C (gaps C1 to C5 of the hosted demo's gap report;
 * decision 0025: every act a person performs has a screen) over HTTP with real sessions and real signatures on a GMP
 * server. Each route runs the database's own function under the person's account; the right and every rule are the
 * database's, and these tests prove the routes reach them:
 *  - C1 a numbering rule of the site (site.define_batch_number_rule; BATCH_NUMBER.RULE_DEFINE; IN-18);
 *  - C2 a reference document version (tab.record_reference_document; MASTERDATA.CHANGE; DI-04);
 *  - C3 an EU importer, signed by QA (EU_IMPORTER_REGISTER, recipe.register_eu_importer; RECORD.QA_REVIEW; DI-39);
 *  - C4 a product of the plant's product list (plant.define_product; MASTERDATA.CHANGE; IN-26);
 *  - C5 every platform setting is offered by the settings screen's read and fits the change route (DI-09).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result, type SignableAction } from '@ebmr/api-contract';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

let gmp: TestServer;
const as: Record<string, TestBrowser> = {};
const codeOf = (r: Result<unknown>): string => (r.ok ? 'OK' : (refusalOf(r)?.code ?? JSON.stringify(r.error)));
const refused = (r: Result<unknown>): string => `${refusalOf(r)?.code ?? ''} ${refusalOf(r)?.why ?? ''}`;
const tag = () => randomUUID().slice(0, 8).toUpperCase();
const sign = (key: string, action: SignableAction) => signAction(gmp, as[key] as TestBrowser, key, action);
const b = (key: string): TestBrowser => as[key] as TestBrowser;

beforeAll(async () => {
  gmp = await startSigningServer('GMP');
  for (const k of ['steward', 'issuer', 'approver', 'qaApprover2']) as[k] = await gmp.asPersona(k);
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('C1: numbering rules on the batch-number register screen', () => {
  it('[IN-18][DI-17] the master-data steward defines a numbering rule of the site with its reason; it is listed with who defined it; the issuer holds no BATCH_NUMBER.RULE_DEFINE; a format without exactly one {SEQ:n} and a date in the past are refused', async () => {
    const ruleCode = `R7H-${tag()}`;
    const body = { ruleCode, productCode: `P7H-${tag()}`, batchKind: 'PROCESSING' as const, format: 'X{YY}{SEQ:5}', reason: 'Numbering SOP-QA-017 rev 3' };
    expect(codeOf(await b('issuer').call(routes.planning.defineBatchNumberRule, { body }))).toBe('EBMR-IAM-040');
    expect(refused(await b('steward').call(routes.planning.defineBatchNumberRule, { body: { ...body, format: 'X{YY}{SEQ:3}{SEQ:2}' } }))).toMatch(/EBMR-SITE-010 .*exactly one \{SEQ:n\}/);
    expect(refused(await b('steward').call(routes.planning.defineBatchNumberRule, { body: { ...body, effectiveFrom: '2020-01-01T00:00:00+05:30' } }))).toMatch(/EBMR-SITE-010 .*in the past/);
    const rule = valueOf(await b('steward').call(routes.planning.defineBatchNumberRule, { body }));
    expect(rule).toMatchObject({ ruleCode, siteCode: 'SITE-1', productCode: body.productCode, batchKind: 'PROCESSING', format: 'X{YY}{SEQ:5}', reason: body.reason, definedBy: { legalName: 'Neha Joshi' } });
    expect(rule.siteZone).not.toBe('');
    const listed = valueOf(await b('issuer').call(routes.planning.batchNumberRules)).rules.find((r) => r.ruleCode === ruleCode);
    expect(listed?.ruleId).toBe(rule.ruleId);
    // The rule code is the rule's for good: the same code again is refused.
    expect(refused(await b('steward').call(routes.planning.defineBatchNumberRule, { body: { ...body, productCode: `P7H-${tag()}` } }))).toMatch(/EBMR-SITE-010/);
  }, 120_000);
});

describe('C2: reference documents on the master-record screen', () => {
  it('[DI-04][DI-17] the master-data steward records a reference document version; the server hashes its body and the list shows that hash, effective; the QA MBR approver holds no MASTERDATA.CHANGE', async () => {
    const code = `SOP-7H-${tag()}`;
    const body = { kind: 'SOP' as const, code, version: '1', title: 'Line clearance of the packing line', effectiveFrom: '2024-01-01', summary: 'Removal of previous materials; independent check.' };
    expect(codeOf(await b('approver').call(routes.marketConfig.recordReferenceDocument, { body }))).toBe('EBMR-IAM-040');
    const rec = valueOf(await b('steward').call(routes.marketConfig.recordReferenceDocument, { body }));
    expect(rec.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const doc = valueOf(await b('approver').call(routes.designer.referenceDocuments)).documents.find((d) => d.code === code);
    expect(doc).toMatchObject({ refId: rec.documentId, kind: 'SOP', version: '1', title: body.title, hash: rec.contentHash, status: 'EFFECTIVE' });
    // The database refuses a date that is not a calendar date in the body it hashes (DI-04).
    expect((await b('steward').call(routes.marketConfig.recordReferenceDocument, { body: { ...body, version: '2', effectiveFrom: '2024-02-30' } })).ok).toBe(false);
  }, 120_000);
});

describe('C3: the EU importer on the qualified-person register screen (EU_IMPORTER_REGISTER)', () => {
  it('[DI-39][DI-17][DI-37] QA registers an EU importer by signing its definition (EU_IMPORTER_APPROVED); it is then offered for a QP registration; the QA MBR approver may not sign it; the code once and one importer per product', async () => {
    const code = `EUIMP-${tag()}`;
    const product = `PRD-${tag()}`;
    const action = { kind: 'EU_IMPORTER_REGISTER' as const, code, name: 'Example Import GmbH (TEST)', technicalAgreementRef: `TA-${code}`, miaNumber: 'DE-MIA-2026-123', publicKey: Buffer.alloc(32, 5).toString('base64'), products: [product] };
    // The QA MBR approver holds no RECORD.QA_REVIEW: nothing is signed or registered.
    expect(codeOf(await sign('approver', action))).not.toBe('OK');
    expect(valueOf(await b('qaApprover2').call(routes.marketConfig.qpRegister)).importers.map((i) => i.code)).not.toContain(code);
    expect(codeOf(await sign('qaApprover2', action))).toBe('OK');
    const reg = valueOf(await b('qaApprover2').call(routes.marketConfig.qpRegister));
    expect(reg.importers).toContainEqual({ code, name: action.name, miaNumber: 'DE-MIA-2026-123' });
    const { rows } = await gmp.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.eu_importer i join recipe.eu_importer_product p on p.importer_id = i.id where i.code = $1 and p.product_code = $2', [code, product]);
    expect(rows[0]?.n).toBe('1');
    // The same importer again is no longer NEW: nothing is signed.
    expect(codeOf(await sign('qaApprover2', action))).not.toBe('OK');
    // Another importer for a product already imported by this one is refused by the database; nothing is signed.
    expect(codeOf(await sign('qaApprover2', { ...action, code: `EUIMP-${tag()}`, technicalAgreementRef: 'TA-OTHER' }))).toBe('EBMR-DSP-062');
  }, 180_000);
});

describe('C4: the plant product list on the plant master-data screen', () => {
  it('[IN-26][DI-17] the master-data steward adds a product stating whether it is highly potent; it is listed with who recorded it and a tooling set can name it; the QA MBR approver holds no MASTERDATA.CHANGE', async () => {
    const code = `PRD-7H-${tag()}`;
    const body = { code, name: 'Atenolol tablets 50 mg', highlyPotent: true };
    expect(codeOf(await b('approver').call(routes.plant.defineProduct, { body }))).toBe('EBMR-IAM-040');
    const p = valueOf(await b('steward').call(routes.plant.defineProduct, { body }));
    expect(p).toMatchObject({ code, name: body.name, highlyPotent: true, recordedBy: { legalName: 'Neha Joshi' } });
    expect(valueOf(await b('issuer').call(routes.plant.products)).products.find((x) => x.code === code)?.highlyPotent).toBe(true);
    expect((await b('steward').call(routes.plant.defineProduct, { body })).ok).toBe(false);
    const set = valueOf(
      await b('steward').call(routes.plant.defineToolingSet, {
        body: { code: `TS-${tag()}`, product: code, type: 'B', shape: 'round 8 mm', upperEmbossing: 'A50', lowerEmbossing: 'plain', score: 'none', tips: 1, upperPunches: 45, lowerPunches: 45, dies: 45, strokeLimit: '1000000' },
      }),
    );
    expect(set.product).toBe(code);
  }, 120_000);
});

describe('C5: platform settings on the configuration screen', () => {
  it('[DI-09] every platform setting the database defines is offered by the settings read of the configuration screen, and its key fits the change route (one screen covers every setting)', async () => {
    const { rows } = await gmp.db.admin.query<{ key: string }>('select key from platform.setting_definition order by key');
    expect(rows.length).toBeGreaterThan(10);
    const offered = valueOf(await b('steward').call(routes.config.settings)).settings.map((s) => s.key);
    expect(offered).toEqual(rows.map((r) => r.key));
    const params = routes.config.setSetting.params;
    for (const { key } of rows) expect(params?.safeParse({ key }).success, key).toBe(true);
  }, 60_000);
});
