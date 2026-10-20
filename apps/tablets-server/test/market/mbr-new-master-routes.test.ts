/**
 * Slice 7h, work package B (gap report B1-B4; decision D-P7R-16): the acts a new master record needs before its Prepared
 * signature, over HTTP with real sessions on a GMP designer server, and the sandbox test-run result package on a sandbox:
 *  - QA raises the change record and records a risk assessment (recipe.record_change_record, recipe.record_risk_assessment;
 *    MBR.CHANGE_RECORD); the author links the assessment and sets the draft's change record, effective-from and review due
 *    (recipe.link_risk_assessment, recipe.set_draft_attributes; MBR.AUTHOR). The right and every rule are the database's;
 *  - the author's start of the verification records the validator report, the simulation's sealed verification and the
 *    test vectors of the exact content (DI-04);
 *  - the sandbox exports a run's result write-once to to-gmp with its stamp and hash; GMP imports one only when its hash
 *    holds, it comes from a sandbox, it ran a test package GMP exported for this version and that content is still current
 *    (DI-05, INV-18), as the version's SANDBOX_RUN evidence.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result, type VersionView } from '@ebmr/api-contract';
import { execution } from '@ebmr/recipe-core';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { createFamily, edited, findPhase, saveContent, startDesignerServer, valueOf } from '../designer/support.ts';
import { dcMini, importAndIssue, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';

const M = routes.marketConfig;
let gmp: TestServer;
let exchange: string;
const as: Record<string, TestBrowser> = {};
const codeOf = (r: Result<unknown>): string => (r.ok ? 'OK' : r.error.kind === 'REFUSAL' ? r.error.envelope.refusal.code : JSON.stringify(r.error));
const whyOf = (r: Result<unknown>): string => (r.ok ? '' : r.error.kind === 'REFUSAL' ? `${r.error.envelope.refusal.whatHappened} ${r.error.envelope.refusal.why}` : JSON.stringify(r.error));
const tag = () => randomUUID().slice(0, 8).toUpperCase();
let families = 0;
const newDraft = async (): Promise<VersionView> => {
  families += 1;
  return createFamily(as['author'] as TestBrowser, { familyCode: `PCM-B${String(families)}-${tag()}`, product: { code: `PCM-B${String(families)}-${tag()}`, name: 'Paracetamol tablets', strength: '500 mg' } });
};

/** A result of a sandbox run of `pkg` as the sandbox builds it (its stamp unless overridden), complete and replayed identically. */
function resultOf(pkg: { packageHash: string; versionId: string; revision: number; contentHash: string }, overrides: Partial<execution.TestRunResultInput> = {}): execution.TestRunResultV1 {
  return execution.buildTestRunResult({
    source: { installationKind: 'SANDBOX', watermark: 'TEST, NOT GMP' },
    testPackage: { packageHash: pkg.packageHash, versionId: pkg.versionId, versionNumber: '1', revision: pkg.revision, contentHash: pkg.contentHash, familyCode: 'PCM' },
    run: { runId: randomUUID(), batchNumber: `TEST-B26-${String(1000 + families)}`, status: 'EXECUTION_COMPLETE' },
    coverage: { stepsTotal: '14', stepsFinished: '14', stagesTotal: '2', stagesSignedOff: '2', openExceptions: '0', replayRows: '120', replayIdentical: true, invariantViolations: [] },
    exporter: { personId: randomUUID(), legalName: 'TEST-Anil Kumar', loginName: 'anil.kumar' },
    exportedAtUs: '1790581503000000',
    ...overrides,
  });
}
const inInbox = (r: execution.TestRunResultV1): string => {
  writeFileSync(join(exchange, 'to-gmp', `${r.resultHash}.json`), `${JSON.stringify(r, null, 2)}\n`);
  return `${r.resultHash}.json`;
};

beforeAll(async () => {
  exchange = mkdtempSync(join(tmpdir(), 'ebmr-7h-b-'));
  for (const d of ['to-sandbox', 'to-gmp']) mkdirSync(join(exchange, d), { recursive: true });
  gmp = await startDesignerServer({ env: { EBMR_EXCHANGE_DIR: exchange } });
  for (const k of ['author', 'approver', 'regulatory']) as[k] = await gmp.asPersona(k);
}, 600_000);
afterAll(async () => {
  await gmp?.close();
  rmSync(exchange, { recursive: true, force: true });
});

describe('a new master record: change record, risk assessment, draft attributes', () => {
  it('[PR-06] QA raises the change record of a new master with its class, process impact and validation; the number is taken once; the MBR author holds no MBR.CHANGE_RECORD', async () => {
    const number = `CC-7H-${tag()}`;
    const cr = valueOf(await (as['approver'] as TestBrowser).call(M.recordChangeRecord, { body: { number, title: 'New master PCM 500', changeClass: 'MAJOR', processImpacting: true, validationRef: 'PV-7H-1' } }));
    expect(cr).toMatchObject({ number, title: 'New master PCM 500', changeClass: 'MAJOR', processImpacting: true });
    expect(cr.validations).toEqual([expect.objectContaining({ validationRef: 'PV-7H-1' })]);
    expect(valueOf(await (as['author'] as TestBrowser).call(M.changeRecords)).changeRecords.some((c) => c.number === number)).toBe(true);
    expect(codeOf(await (as['approver'] as TestBrowser).call(M.recordChangeRecord, { body: { number, title: 'Again', changeClass: 'MINOR', processImpacting: false } }))).toBe('EBMR-API-ALREADY-RECORDED');
    expect(codeOf(await (as['author'] as TestBrowser).call(M.recordChangeRecord, { body: { number: `CC-7H-${tag()}`, title: 'By the author', changeClass: 'MINOR', processImpacting: false } }))).toBe('EBMR-IAM-040');
  }, 120_000);

  it('[PR-07] QA records a versioned risk assessment; the author links it to the draft for listed elements, and the review shows it; QA holds no MBR.AUTHOR to link it', async () => {
    const v = await newDraft();
    const code = `RA-7H-${tag()}`;
    const ra = valueOf(await (as['approver'] as TestBrowser).call(M.recordRiskAssessment, { body: { code, version: '1', title: 'Process risk assessment', riskClass: 'MEDIUM', rationaleRef: 'QRM-7H' } }));
    expect(ra).toMatchObject({ code, version: '1', riskClass: 'MEDIUM', rationaleRef: 'QRM-7H', recordedBy: expect.objectContaining({ loginName: expect.any(String) }) });
    expect(valueOf(await (as['author'] as TestBrowser).call(M.riskAssessments)).riskAssessments.map((r) => r.riskAssessmentId)).toContain(ra.riskAssessmentId);
    expect(codeOf(await (as['approver'] as TestBrowser).call(M.recordRiskAssessment, { body: { code, version: '1', title: 'Again', riskClass: 'LOW', rationaleRef: 'QRM-X' } }))).toBe('EBMR-API-ALREADY-RECORDED');
    expect(codeOf(await (as['approver'] as TestBrowser).call(M.linkRiskAssessment, { params: { versionId: v.versionId }, body: { riskAssessmentId: ra.riskAssessmentId } }))).toBe('EBMR-IAM-040');
    const review = valueOf(await (as['author'] as TestBrowser).call(M.linkRiskAssessment, { params: { versionId: v.versionId }, body: { riskAssessmentId: ra.riskAssessmentId, subjects: ['blendTime'] } }));
    expect(review.riskAssessments).toEqual([expect.objectContaining({ riskAssessmentId: ra.riskAssessmentId, code, subjects: ['blendTime'] })]);
    // An id that names no risk assessment is the database's refusal.
    expect(codeOf(await (as['author'] as TestBrowser).call(M.linkRiskAssessment, { params: { versionId: v.versionId }, body: { riskAssessmentId: randomUUID() } }))).toBe('EBMR-RCP-061');
  }, 120_000);

  it('[PR-02][PR-05][PR-06] the author sets the draft\'s change record, effective-from and review due; a member left out keeps its value; an unknown change record is refused; QA holds no MBR.AUTHOR', async () => {
    const v = await newDraft();
    const cr = valueOf(await (as['approver'] as TestBrowser).call(M.recordChangeRecord, { body: { number: `CC-7H-${tag()}`, title: 'New master', changeClass: 'MAJOR', processImpacting: false } }));
    const r1 = valueOf(await (as['author'] as TestBrowser).call(M.setDraftAttributes, { params: { versionId: v.versionId }, body: { changeRecordId: cr.changeRecordId, effectiveFrom: '2026-01-01T00:00:00Z', reviewDue: '2028-12-31', reason: 'New master: its change record and dates' } }));
    expect(r1.draft.changeRecord).toEqual({ changeRecordId: cr.changeRecordId, number: cr.number, title: 'New master' });
    expect(r1.draft.effectiveFrom?.us).toBe('1767225600000000');
    expect(r1.draft.reviewDue).toBe('2028-12-31');
    const r2 = valueOf(await (as['author'] as TestBrowser).call(M.setDraftAttributes, { params: { versionId: v.versionId }, body: { reviewDue: '2029-06-30', reason: 'Review moved to June' } }));
    expect(r2.draft).toMatchObject({ changeRecord: { changeRecordId: cr.changeRecordId }, reviewDue: '2029-06-30' });
    expect(r2.draft.effectiveFrom?.us).toBe('1767225600000000');
    expect(codeOf(await (as['author'] as TestBrowser).call(M.setDraftAttributes, { params: { versionId: v.versionId }, body: { changeRecordId: randomUUID(), reason: 'wrong record' } }))).toBe('EBMR-RCP-060');
    expect(codeOf(await (as['approver'] as TestBrowser).call(M.setDraftAttributes, { params: { versionId: v.versionId }, body: { reviewDue: '2030-01-01', reason: 'by QA' } }))).toBe('EBMR-IAM-040');
  }, 120_000);
});

describe('verification evidence: recorded at the start, and the sandbox run returned as a result package', () => {
  it('[DI-04] starting the verification records the validator report, the sealed simulation and the author-confirmed test vectors of the exact content; only the sandbox run is then missing', async () => {
    const v = await newDraft();
    const started = valueOf(await (as['author'] as TestBrowser).call(routes.designer.startVerification, { params: { versionId: v.versionId }, body: { baseRevision: v.revision } }));
    expect(started.state).toBe('IN_VERIFICATION');
    const review = valueOf(await (as['author'] as TestBrowser).call(M.versionReview, { params: { versionId: v.versionId } }));
    expect(review.evidence.items).toEqual([
      { kind: 'VALIDATOR', result: 'PASS', problems: [] },
      { kind: 'VERIFICATION', result: 'PASS', problems: [] },
      { kind: 'TEST_VECTORS', result: 'PASS', problems: [] },
    ]);
    expect(review.evidence.contentHash).toBe(v.contentHash);
    expect(review.evidence.complete).toBe(false);
    expect(review.evidence.missing).toEqual(['a passing sandbox test run on this exact content (SANDBOX_RUN)']);
    const { rows } = await gmp.db.admin.query<{ kind: string; person: string }>("select kind, report ->> 'confirmedBy' as person from recipe.mbr_evidence where version_id = $1 and kind = 'TEST_VECTORS'", [v.versionId]);
    expect(rows.map((r) => r.person)).toEqual([gmp.seed.personas.find((p) => p.key === 'author')?.personId]);
  }, 180_000);

  it('[DI-05][INV-18][DI-04] GMP imports a sandbox result only when its hash holds, it comes from a sandbox and ran a package GMP exported for this version; the author records it as SANDBOX_RUN evidence (QA may not); the evidence is then complete', async () => {
    const v = await newDraft();
    const pkg = valueOf(await (as['author'] as TestBrowser).call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {} }));
    valueOf(await (as['author'] as TestBrowser).call(routes.designer.startVerification, { params: { versionId: v.versionId }, body: { baseRevision: v.revision } }));
    const ran = { packageHash: pkg.packageHash, versionId: v.versionId, revision: v.revision, contentHash: v.contentHash };
    const good = resultOf(ran);
    const file = inInbox(good);
    const listed = valueOf(await (as['author'] as TestBrowser).call(M.sandboxRunResults, { params: { versionId: v.versionId } }));
    expect(listed.results).toEqual([expect.objectContaining({ fileName: file, resultHash: good.resultHash, passed: true, runStatus: 'EXECUTION_COMPLETE', imported: false, problem: null })]);

    // Changed after export: the hash no longer holds.
    const tampered = { ...good, coverage: { ...good.coverage, stepsFinished: '15' } };
    const t = await (as['author'] as TestBrowser).call(M.importSandboxRunResult, { params: { versionId: v.versionId }, body: { text: JSON.stringify(tampered) } });
    expect(codeOf(t)).toBe('EBMR-API-RUN-RESULT-REFUSED');
    expect(whyOf(t)).toContain('changed after export');
    // A GMP stamp (or none) is not a sandbox's run (DI-05).
    const gmpStamped = resultOf(ran, { source: { installationKind: 'GMP', watermark: null } });
    expect(whyOf(await (as['author'] as TestBrowser).call(M.importSandboxRunResult, { params: { versionId: v.versionId }, body: { text: JSON.stringify(gmpStamped) } }))).toContain('only a sandbox');
    // A package GMP never exported for this version (INV-18).
    const foreign = resultOf({ ...ran, packageHash: 'f'.repeat(64) });
    expect(whyOf(await (as['author'] as TestBrowser).call(M.importSandboxRunResult, { params: { versionId: v.versionId }, body: { text: JSON.stringify(foreign) } }))).toContain('is not a test package this installation exported for this version');
    // A result file that is not in the inbox.
    expect(codeOf(await (as['author'] as TestBrowser).call(M.importSandboxRunResult, { params: { versionId: v.versionId }, body: { fileName: `${'0'.repeat(64)}.json` } }))).toBe('EBMR-API-NOT-FOUND');
    // QA holds no MBR.AUTHOR: the database refuses the evidence.
    expect(codeOf(await (as['approver'] as TestBrowser).call(M.importSandboxRunResult, { params: { versionId: v.versionId }, body: { fileName: file } }))).toBe('EBMR-IAM-040');
    const before = (await gmp.db.admin.query("select count(*)::int as n from recipe.mbr_evidence where version_id = $1 and kind = 'SANDBOX_RUN'", [v.versionId])).rows[0] as { n: number };
    expect(before.n).toBe(0);

    const review = valueOf(await (as['author'] as TestBrowser).call(M.importSandboxRunResult, { params: { versionId: v.versionId }, body: { fileName: file } }));
    expect(review.evidence.items.find((i) => i.kind === 'SANDBOX_RUN')).toEqual({ kind: 'SANDBOX_RUN', result: 'PASS', problems: [] });
    expect(review.evidence.complete).toBe(true);
    const { rows } = await gmp.db.admin.query<{ reference: string; report: Record<string, unknown> }>("select reference, report from recipe.mbr_evidence where version_id = $1 and kind = 'SANDBOX_RUN'", [v.versionId]);
    expect(rows[0]?.reference).toBe(good.run.runId);
    expect(rows[0]?.report).toMatchObject({ resultHash: good.resultHash, testPackageHash: pkg.packageHash, passed: true, batchNumber: good.run.batchNumber });
    expect(valueOf(await (as['author'] as TestBrowser).call(M.sandboxRunResults, { params: { versionId: v.versionId } })).results[0]?.imported).toBe(true);
  }, 180_000);

  it('[DI-04][INV-18] a run of an earlier revision is refused once the content changed; a run that did not pass is recorded as a failed sandbox run', async () => {
    const v = await newDraft();
    const pkg = valueOf(await (as['author'] as TestBrowser).call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {} }));
    const ran = { packageHash: pkg.packageHash, versionId: v.versionId, revision: v.revision, contentHash: v.contentHash };
    const failed = resultOf(ran, { run: { runId: randomUUID(), batchNumber: 'TEST-B26-0777', status: 'IN_PROGRESS' } });
    expect(failed.passed).toBe(false);
    const review = valueOf(await (as['author'] as TestBrowser).call(M.importSandboxRunResult, { params: { versionId: v.versionId }, body: { text: JSON.stringify(failed) } }));
    expect(review.evidence.items.find((i) => i.kind === 'SANDBOX_RUN')).toEqual({ kind: 'SANDBOX_RUN', result: 'FAIL', problems: ['the sandbox run did not pass'] });

    const saved = valueOf(await saveContent(as['author'] as TestBrowser, v, edited(v, (c) => (findPhase(c, 'p-disp-exc').name = 'Dispense the excipients')), 'renamed a step'));
    expect(saved.contentHash).not.toBe(v.contentHash);
    const stale = await (as['author'] as TestBrowser).call(M.importSandboxRunResult, { params: { versionId: v.versionId }, body: { text: JSON.stringify(resultOf(ran)) } });
    expect(codeOf(stale)).toBe('EBMR-API-RUN-RESULT-REFUSED');
    expect(whyOf(stale)).toContain('the content has changed since');
  }, 180_000);
});

describe('the sandbox: a run\'s result exported for GMP', () => {
  let sbx: ExecServer;
  beforeAll(async () => {
    sbx = await startExecServer();
  }, 600_000);
  afterAll(async () => {
    await sbx?.close();
  });

  it('[DI-05][INV-18] the run page exports the run\'s result write-once to to-gmp with the sandbox stamp and its hash; an unfinished run has not passed; GMP refuses a run of a package it never exported', async () => {
    const issuer = await sbx.asPersona('issuer');
    const pkg = writePackage(sbx, dcMini());
    const runId = await importAndIssue(sbx, issuer, pkg);
    const out = valueOf(await issuer.call(routes.execution.exportRunResult, { params: { runId }, body: {} }));
    expect(out.passed).toBe(false);
    expect(out.fileName).toBe(`${out.resultHash}.json`);
    const dir = join(sbx.exchangeDir, 'to-gmp');
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toEqual([out.fileName]);
    expect(readdirSync(join(dir, '.staging'))).toEqual([]);
    const text = readFileSync(join(dir, out.fileName), 'utf8');
    expect(text).toBe(out.fileText);
    const parsed = execution.parseTestRunResult(JSON.parse(text), out.fileName);
    expect(parsed.ok ? [] : parsed.problems).toEqual([]);
    if (!parsed.ok) return;
    expect(parsed.result.source).toEqual({ installationKind: 'SANDBOX', watermark: 'TEST, NOT GMP' });
    expect(parsed.result.testPackage).toMatchObject({ packageHash: pkg.packageHash, versionId: pkg.version.versionId, contentHash: pkg.contentHash });
    expect(parsed.result.run).toMatchObject({ runId, status: 'ISSUED' });
    expect(parsed.result.run.batchNumber).toMatch(/^TEST-/);
    expect(parsed.result.coverage).toMatchObject({ stepsFinished: '0', stagesSignedOff: '0', replayIdentical: true, invariantViolations: [] });
    // The GMP side: this run tested a version GMP does not know, from a package it never exported.
    const v = await newDraft();
    const moved = { ...parsed.result, testPackage: { ...parsed.result.testPackage, versionId: v.versionId } };
    const r = await (as['author'] as TestBrowser).call(M.importSandboxRunResult, { params: { versionId: v.versionId }, body: { text: JSON.stringify(moved) } });
    expect(whyOf(r)).toContain('changed after export');
    const asExported = await (as['author'] as TestBrowser).call(M.importSandboxRunResult, { params: { versionId: v.versionId }, body: { text } });
    expect(whyOf(asExported)).toContain('not this version');
  }, 300_000);
});
