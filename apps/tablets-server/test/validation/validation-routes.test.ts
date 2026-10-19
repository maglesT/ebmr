/**
 * The validation screens' routes (Phase 7 slice 7g-3, WP1; contract ns/validation.ts; kernel 1300, 1381; decision
 * D-P7R-5): the approved system description and an interface described under an approved change record (DI-06, DI-09),
 * the validation summary with its problem, its document and QA's signed approval (DI-03, DI-37), the shipped evidence
 * bundle and the validation pack generated from it, and the IQ run here and stored with its SHA-256. Each act is refused
 * to a person without the right, by the database function it calls.
 */
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { passwordActor } from '@ebmr/test-kit';
import { refusalOf, startSigningServer, terminalOf, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';
import { approvedChangeRecord, codeIn, okOf, type Signed, signedIn } from './acts-support.ts';

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages', 'validation-kit', 'fixtures', 'example-bundle.json');

let server: TestServer;
let steward: TestBrowser;
let qa: TestBrowser;
let csv: Signed;
let admin: Signed;

beforeAll(async () => {
  server = await startSigningServer('GMP', { env: { EBMR_VALIDATION_BUNDLE: BUNDLE } });
  [steward, qa] = await Promise.all([server.asPersona('steward'), server.asPersona('qaInvestigator')]);
  csv = await signedIn(server, 'CSV_DI_LEAD', 'Kavya Iyer');
  admin = await signedIn(server, 'SYSTEM_ADMINISTRATOR', 'Arun Pillai');
}, 600_000);
afterAll(async () => {
  await server?.close();
});

const running = async (): Promise<string> => (await server.db.admin.query<{ r: string }>('select platform.schema_release() as r')).rows[0]!.r;

describe('the system description (kernel 1300)', () => {
  it('[DI-06][DI-09] the CSV lead describes an interface under an approved change record; without one, or without the right, nothing is written', async () => {
    const body = { adapterCode: 'QMS-TEST-1', sourceSystem: 'QMS' as const, endpointHost: 'qms.plant.example', transport: 'MTLS' as const, signedFeed: false, status: 'DESCRIBED' as const, reason: 'QMS interface goes live' };
    expect(codeIn(await csv.browser.call(routes.validation.describeInterface, { body: { ...body, changeRecord: 'CR-NONE' } }))).toMatch(/^EBMR-CFG-00\d$/);
    const number = await approvedChangeRecord(server, steward, qa, ['SYSTEM_DESCRIPTION'], 'SYSDESC');
    // The steward holds no CONFIG.SYSTEM_DESCRIPTION: the database refuses the act.
    expect(codeIn(await steward.call(routes.validation.describeInterface, { body: { ...body, changeRecord: number } }))).toBe('EBMR-IAM-040');
    const after = valueOf(await csv.browser.call(routes.validation.describeInterface, { body: { ...body, changeRecord: number } }));
    expect(after.interfaces.find((i) => i.adapterCode === 'QMS-TEST-1')).toMatchObject({ sourceSystem: 'QMS', endpointHost: 'qms.plant.example', transport: 'MTLS', status: 'DESCRIBED' });
    const read = valueOf(await qa.call(routes.validation.systemDescription));
    expect(read.interfaces.map((i) => i.adapterCode)).toContain('QMS-TEST-1');
    expect(Array.isArray(read.undescribed)).toBe(true);
  });

  it('[DI-18] the system administrator does not describe interfaces (administrators are independent of GMP records)', async () => {
    const number = await approvedChangeRecord(server, steward, qa, ['SYSTEM_DESCRIPTION'], 'SYSADM');
    const r = await admin.browser.call(routes.validation.describeInterface, {
      body: { adapterCode: 'LIMS-TEST-1', sourceSystem: 'LIMS', endpointHost: 'lims.plant.example', transport: 'MTLS', signedFeed: false, status: 'DESCRIBED', changeRecord: number, reason: 'LIMS live' },
    });
    expect(r.ok).toBe(false);
    expect(valueOf(await qa.call(routes.validation.systemDescription)).interfaces.map((i) => i.adapterCode)).not.toContain('LIMS-TEST-1');
  });
});

describe('the validation summary (kernel 1300)', () => {
  it('[DI-03] the summary page shows the running release, its problem and the summary document of the shipped bundle (for another release here, so not approvable)', async () => {
    const v = valueOf(await qa.call(routes.validation.summary));
    expect(v.runningRelease).toBe(await running());
    const problem = (await server.db.admin.query<{ p: string | null }>('select platform.validation_summary_problem() as p')).rows[0]?.p ?? null;
    expect(v.problem).toBe(problem);
    expect(v.document).toMatchObject({ path: 'validation-summary.md', forRunningRelease: false });
    expect(v.document?.markdown.length).toBeGreaterThan(100);
    expect(v.documentProblem).toMatch(/Only the running release's summary is approved here/);
  });

  it('[DI-03][DI-37] QA approves the running release\'s summary with a signature bound to the release and the document\'s SHA-256; the problem clears', async () => {
    const release = await running();
    const sha = createHash('sha256').update('validation summary of the test release').digest('hex');
    const action = { kind: 'VALIDATION_SUMMARY_APPROVE' as const, schemaRelease: release, summarySha256: sha, title: 'Validation summary 1.0.0' };
    // The steward holds no VALIDATION.APPROVE_SUMMARY: nothing is signed.
    expect((await signAction(server, steward, 'steward', action)).ok).toBe(false);
    expect(okOf(await signAction(server, qa, 'qaInvestigator', action))).toBe(true);
    const v = valueOf(await qa.call(routes.validation.summary));
    expect(v.problem).toBeNull();
    expect(v.approvals).toContainEqual(expect.objectContaining({ schemaRelease: release, summarySha256: sha, title: 'Validation summary 1.0.0', approvedBy: 'Divya Menon' }));
    const { rows } = await server.db.admin.query<{ meaning_code: string; aggregate_id: string }>(
      "select meaning_code, aggregate_id from esig.signature where aggregate_type = 'validation_summary' and aggregate_id = $1", [`${release}@${sha}`]);
    expect(rows).toEqual([{ meaning_code: 'VALIDATION_SUMMARY_APPROVED', aggregate_id: `${release}@${sha}` }]);
    // Approved once: a second approval of the same document is refused and signs nothing.
    expect((await signAction(server, qa, 'qaInvestigator', action)).ok).toBe(false);
  });

  it('[DI-03] a summary of another release is refused by the database; nothing is signed', async () => {
    const action = { kind: 'VALIDATION_SUMMARY_APPROVE' as const, schemaRelease: 'a'.repeat(64), summarySha256: 'b'.repeat(64), title: 'Other release' };
    expect((await signAction(server, qa, 'qaInvestigator', action)).ok).toBe(false);
    const { rows } = await server.db.admin.query("select 1 from esig.signature where aggregate_id = $1", [`${'a'.repeat(64)}@${'b'.repeat(64)}`]);
    expect(rows).toEqual([]);
  });
});

describe('the evidence bundle, the validation pack and the IQ', () => {
  it('the shipped bundle and every document of the pack generated from it are read and downloaded with their SHA-256', async () => {
    const v = valueOf(await qa.call(routes.validation.evidence));
    expect(v).toMatchObject({ configured: true, problem: null, fileName: 'example-bundle.json' });
    expect(v.documents.map((d) => d.id)).toEqual(expect.arrayContaining(['urs', 'iq', 'oq', 'validation-summary']));
    const bundle = valueOf(await qa.call(routes.validation.evidenceFile, { query: { path: 'bundle.json' } }));
    expect(bundle.sha256).toBe(createHash('sha256').update(bundle.content).digest('hex'));
    const md = v.documents.find((d) => d.id === 'urs')?.files[0];
    if (!md) throw new Error('the pack has the URS');
    const doc = valueOf(await qa.call(routes.validation.evidenceFile, { query: { path: md.path } }));
    expect(doc.sha256).toBe(md.sha256);
    expect(refusalOf(await qa.call(routes.validation.evidenceFile, { query: { path: 'no-such.md' } })).status).toBe(404);
  });

  it('[DI-03] the CSV lead runs the IQ against the shipped bundle; the record is stored with its SHA-256 and each check; without the right nothing is run', async () => {
    expect(codeIn(await steward.call(routes.validation.runIq, { body: { reason: 'IQ after install' } }))).toBe('EBMR-IAM-040');
    expect(codeIn(await admin.browser.call(routes.validation.runIq, { body: { reason: 'IQ after install' } }))).toBe('EBMR-IAM-042');
    const rec = valueOf(await csv.browser.call(routes.validation.runIq, { body: { reason: 'IQ after install' } }));
    expect(rec.checks.map((c) => c.id)).toEqual(['IQ-01', 'IQ-02', 'IQ-03', 'IQ-04', 'IQ-05', 'IQ-06', 'IQ-07', 'IQ-08', 'IQ-09', 'IQ-10', 'IQ-11']);
    // The example bundle is another release: the IQ fails by name, and says so.
    expect(rec.passed).toBe(false);
    expect(rec.checks.find((c) => c.id === 'IQ-01')?.passed).toBe(false);
    expect(rec.checks.find((c) => c.id === 'IQ-11')?.passed).toBe(true);
    expect(rec.by).toBe('Kavya Iyer');
    const file = valueOf(await qa.call(routes.validation.iqRecordFile, { params: { iqId: rec.iqId } }));
    expect(createHash('sha256').update(file.content).digest('hex')).toBe(rec.recordSha256);
    expect(valueOf(await qa.call(routes.validation.iqRecords)).records.map((r) => r.iqId)).toContain(rec.iqId);
  });

  it('[DI-03] the database stores an IQ record only with the SHA-256 of its text, and only as the checks wrote it for this database (kernel 1381)', async () => {
    const actor = await passwordActor(server.db, csv.person, terminalOf(server.seed, 'PC-QA-01').fingerprint, { reasonCode: 'TEST', reasonText: 'IQ record guard', correlationId: randomUUID() });
    const store = (text: string, sha: string) => withCommand(server.db.app, { ...actor, correlationId: randomUUID() }, (c) => c.query('select platform.record_iq($1, $2, $3)', [text, sha, 'e'.repeat(64)]));
    const sha = (t: string) => createHash('sha256').update(t).digest('hex');
    const ok = JSON.stringify({ kind: 'iq', passed: false, summary: '1 of 1 IQ checks failed', checks: [{ id: 'IQ-01', passed: false }], installation: { database: server.database } });
    await expect(store(ok, 'f'.repeat(64))).rejects.toThrow(/EBMR-VAL-020/);
    const other = JSON.stringify({ kind: 'iq', passed: false, summary: 'x', checks: [{ id: 'IQ-01', passed: false }], installation: { database: 'another' } });
    await expect(store(other, sha(other))).rejects.toThrow(/EBMR-VAL-021/);
    const claims = JSON.stringify({ kind: 'iq', passed: true, summary: 'all passed', checks: [{ id: 'IQ-01', passed: false }], installation: { database: server.database } });
    await expect(store(claims, sha(claims))).rejects.toThrow(/EBMR-VAL-022/);
    await expect(store(ok, sha(ok))).resolves.toBeDefined();
  });
});
