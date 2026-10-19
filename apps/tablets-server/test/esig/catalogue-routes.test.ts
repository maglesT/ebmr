/**
 * The signature catalogue and the record-seal keys from the screens (Phase 7 slice 7g-3, WP1; contract ns/esig.ts;
 * kernel 0210, 0220, 1195). A customer signature point and a new version of a meaning type are written only under an
 * approved change record covering ESIG_MEANING, by a person holding MBR.APPROVE (DI-09); a seal key is retired by the
 * system administrator (SYSTEM.CONFIGURE) with the reason. A person without the right is refused by the database.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { esig, withCommand } from '@ebmr/kernel';
import { passwordActor } from '@ebmr/test-kit';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { approvedChangeRecord, codeIn, signedIn, type Signed } from '../validation/acts-support.ts';
import { SEAL_KEY_ID, startSigningServer, valueOf } from './support.ts';

let server: TestServer;
let steward: TestBrowser;
let qa: TestBrowser;
let approver: TestBrowser;
let admin: Signed;

beforeAll(async () => {
  server = await startSigningServer('GMP');
  [steward, qa, approver] = await Promise.all([server.asPersona('steward'), server.asPersona('qaInvestigator'), server.asPersona('approver')]);
  admin = await signedIn(server, 'SYSTEM_ADMINISTRATOR', 'Arun Pillai');
}, 600_000);
afterAll(async () => {
  await server?.close();
});

const definition = { category: 'RECORDS' as const, roleClass: 'APPROVER' as const, title: 'Archive transfer approved', meaningText: 'Archive transfer approved by', permissions: ['RECORD.DISPOSAL_APPROVE'] };

describe('the signature catalogue (kernel 0210, 1195)', () => {
  it('[DI-09] QA\'s MBR approver adds a customer signature point under an approved change record covering ESIG_MEANING; without one, or without the right, nothing is added', async () => {
    const reason = 'archive transfer needs its own signature point';
    expect(codeIn(await approver.call(routes.esig.addMeaningType, { body: { code: 'ARCHIVE_TRANSFER_APPROVED', definition, changeRecord: 'CR-NONE', reason } }))).toMatch(/^EBMR-CFG-00\d$/);
    const number = await approvedChangeRecord(server, steward, qa, ['ESIG_MEANING'], 'ESIGMT');
    expect(codeIn(await steward.call(routes.esig.addMeaningType, { body: { code: 'ARCHIVE_TRANSFER_APPROVED', definition, changeRecord: number, reason } }))).toBe('EBMR-IAM-040');
    const added = valueOf(await approver.call(routes.esig.addMeaningType, { body: { code: 'ARCHIVE_TRANSFER_APPROVED', definition, changeRecord: number, reason } }));
    expect(added).toMatchObject({ code: 'ARCHIVE_TRANSFER_APPROVED', version: '1', origin: 'CUSTOMER', status: 'ACTIVE', permissions: ['RECORD.DISPOSAL_APPROVE'], reauth: 'ALL_COMPONENTS' });

    // A new version (who may sign); then the customer type is retired. Each needs the change record and a reason.
    const v2 = valueOf(await approver.call(routes.esig.configureMeaningType, { params: { code: 'ARCHIVE_TRANSFER_APPROVED' }, body: { changes: { permissions: ['RECORD.DISPOSAL_APPROVE', 'RECORD.LEGAL_HOLD'] }, changeRecord: number, reason: 'legal hold holders sign too' } }));
    expect(v2).toMatchObject({ version: '2', permissions: ['RECORD.DISPOSAL_APPROVE', 'RECORD.LEGAL_HOLD'] });
    expect(codeIn(await steward.call(routes.esig.configureMeaningType, { params: { code: 'ARCHIVE_TRANSFER_APPROVED' }, body: { changes: { status: 'RETIRED' }, changeRecord: number, reason: 'retire' } }))).toBe('EBMR-IAM-040');
    const v3 = valueOf(await approver.call(routes.esig.configureMeaningType, { params: { code: 'ARCHIVE_TRANSFER_APPROVED' }, body: { changes: { status: 'RETIRED' }, changeRecord: number, reason: 'no longer used' } }));
    expect(v3).toMatchObject({ version: '3', status: 'RETIRED' });
    const listed = valueOf(await qa.call(routes.esig.meaningTypes)).meaningTypes;
    expect(listed.find((m) => m.code === 'ARCHIVE_TRANSFER_APPROVED')).toMatchObject({ version: '3', status: 'RETIRED' });
    expect(listed.find((m) => m.code === 'VALIDATION_SUMMARY_APPROVED')).toMatchObject({ origin: 'VENDOR' });
  });

  it('[DI-09] a minimum (vendor) type is never retired, even under an approved change record', async () => {
    const number = await approvedChangeRecord(server, steward, qa, ['ESIG_MEANING'], 'ESIGMIN');
    const r = await approver.call(routes.esig.configureMeaningType, { params: { code: 'VALIDATION_SUMMARY_APPROVED' }, body: { changes: { status: 'RETIRED' }, changeRecord: number, reason: 'try to retire a minimum type' } });
    expect(r.ok).toBe(false);
    expect(valueOf(await qa.call(routes.esig.meaningTypes)).meaningTypes.find((m) => m.code === 'VALIDATION_SUMMARY_APPROVED')).toMatchObject({ status: 'ACTIVE' });
  });
});

describe('the record-seal keys (kernel 0220)', () => {
  it('the system administrator retires a seal key with the reason and its change record; QA holds no SYSTEM.CONFIGURE and retires nothing', async () => {
    const keyId = `test-retire-${randomUUID().slice(0, 8)}`;
    const setup = await passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'a second seal key', correlationId: randomUUID() });
    await withCommand(server.db.app, setup, (c) => esig.registerSealKey(c, esig.hmacSealKey(keyId, Buffer.alloc(32, 7)), 'DEMO-ONLY second test seal key'));
    expect(valueOf(await qa.call(routes.esig.sealKeys)).sealKeys.map((k) => k.keyId)).toEqual(expect.arrayContaining([SEAL_KEY_ID, keyId]));
    expect(codeIn(await qa.call(routes.esig.retireSealKey, { params: { keyId }, body: { changeRecord: 'CR-KEYS-1', reason: 'key rotated' } }))).toBe('EBMR-IAM-040');
    const after = valueOf(await admin.browser.call(routes.esig.retireSealKey, { params: { keyId }, body: { changeRecord: 'CR-KEYS-1', reason: 'key rotated' } }));
    expect(after.sealKeys.find((k) => k.keyId === keyId)?.retired).toMatchObject({ reason: 'key rotated' });
    expect(after.sealKeys.find((k) => k.keyId === SEAL_KEY_ID)?.retired).toBeNull();
  });
});
