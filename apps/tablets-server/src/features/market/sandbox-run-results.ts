/**
 * The return of a sandbox test run to GMP (slice 7h, B4; decision D-P7R-16; outline 6.5; DI-04, DI-05, INV-18): the GMP
 * side of the `ebmr.test-run-result` v1 exchange (recipe-core execution/test-run-result.ts). The sandbox writes a result
 * write-once to `<exchange>/to-gmp/<resultHash>.json` from the run page (execution/run-result-export.ts); here the MBR
 * author lists the results of a version in that inbox and imports one, or uploads its text. The checks mirror the
 * sandbox's import of the outbound test package (execution/packages.ts), in the other direction:
 *  - the result is parsed strictly, its hash recomputed, and `passed` recomputed from the run status and coverage; a file
 *    from the inbox must be named by its hash;
 *  - its source stamp must be a sandbox's (SANDBOX with its watermark), and this installation must be GMP;
 *  - the test package it ran must be one this installation recorded as exported for this very version
 *    (tab.mbr_test_package_export), with the same content hash;
 *  - that content must still be the version's current content (any later edit voids the evidence; DI-04).
 * Then the run is recorded as the version's SANDBOX_RUN evidence (recipe.record_evidence, MBR.AUTHOR, in the person's
 * command); the database checks again that it ran on the current content, that it passed and that it has a coverage
 * report, and records PASS or FAIL. Nothing of the run itself becomes a GMP record: only the citation of the run, its
 * result hash and coverage (DI-05).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import type { SandboxRunResultView } from '@ebmr/api-contract';
import { sandbox } from '@ebmr/kernel';
import { execution, lifecycle } from '@ebmr/recipe-core';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';

type Db = pg.Pool | pg.PoolClient;

export const GMP_INBOX = 'to-gmp';
const MAX_RESULT_BYTES = 1_000_000;
const RESULT_FILE = /^[0-9a-f]{64}\.json$/;
const CONTROLS = ['DI-04', 'DI-05', 'INV-18'];

/** Why a result's origin is not a sandbox installation (null when it is). */
export function sandboxOriginProblem(result: execution.TestRunResultV1): string | null {
  if (result.source.installationKind !== 'SANDBOX' || result.source.watermark === null || result.source.watermark.trim() === '') {
    return `the result comes from a ${result.source.installationKind} installation${result.source.watermark ? ` (${result.source.watermark})` : ' with no watermark'}; only a sandbox's test-run result is cited as a sandbox run (DI-05, INV-18)`;
  }
  return null;
}

/** Why the result does not belong to this version as GMP exported it (null when it does); reads the GMP export record. */
async function gmpProblem(db: Db, versionId: string, result: execution.TestRunResultV1): Promise<string | null> {
  if (result.testPackage.versionId !== versionId) return `the run tested MBR version ${result.testPackage.versionId}, not this version`;
  const { rows } = await db.query<{ content_hash: string }>('select content_hash from tab.mbr_test_package_export where version_id = $1 and package_hash = $2', [versionId, result.testPackage.packageHash]);
  const exported = rows[0];
  if (!exported) return `test package ${result.testPackage.packageHash.slice(0, 12)} is not a test package this installation exported for this version (INV-18)`;
  if (exported.content_hash !== result.testPackage.contentHash) return 'the result names other content than the test package this installation exported (INV-18)';
  const current = (await db.query<{ h: string | null }>('select recipe.content_hash_of($1) as h', [versionId])).rows[0]?.h ?? null;
  if (current !== result.testPackage.contentHash) return `the run tested revision ${String(result.testPackage.revision)}, and the content has changed since: send the current revision to the sandbox and run it again (DI-04)`;
  return null;
}

interface InboxResult {
  fileName: string;
  result: execution.TestRunResultV1 | null;
  problems: string[];
}

async function readResultFile(dir: string, fileName: string): Promise<InboxResult> {
  try {
    const info = await stat(join(dir, fileName));
    if (!info.isFile()) return { fileName, result: null, problems: ['not a file'] };
    if (info.size > MAX_RESULT_BYTES) return { fileName, result: null, problems: [`the file is larger than ${String(MAX_RESULT_BYTES)} bytes`] };
    return parseText(await readFile(join(dir, fileName), 'utf8'), fileName);
  } catch (e) {
    return { fileName, result: null, problems: [`the file cannot be read (${e instanceof Error ? e.message : String(e)})`] };
  }
}

function parseText(text: string, fileName?: string): InboxResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { fileName: fileName ?? '', result: null, problems: [`the text is not JSON (${e instanceof Error ? e.message : String(e)})`] };
  }
  const parsed = execution.parseTestRunResult(json, fileName);
  if (!parsed.ok) return { fileName: fileName ?? '', result: null, problems: parsed.problems };
  const origin = sandboxOriginProblem(parsed.result);
  return { fileName: fileName ?? `${parsed.result.resultHash}.json`, result: parsed.result, problems: origin ? [origin] : [] };
}

/** The result hashes already recorded as SANDBOX_RUN evidence of this version (any content). */
async function importedHashes(db: Db, versionId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ h: string }>("select report ->> 'resultHash' as h from recipe.mbr_evidence where version_id = $1 and kind = 'SANDBOX_RUN' and report ? 'resultHash'", [versionId]);
  return new Set(rows.map((r) => r.h));
}

/** The results in `to-gmp/` that name this version, with the importer's checks (unreadable files name no version and are left out). */
export async function sandboxRunResults(app: AppContext, db: Db, versionId: string): Promise<SandboxRunResultView[]> {
  const dir = join(app.config.exchangeDir, GMP_INBOX);
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && RESULT_FILE.test(d.name)).map((d) => d.name).sort();
  } catch {
    return [];
  }
  const imported = await importedHashes(db, versionId);
  const out: SandboxRunResultView[] = [];
  for (const name of names) {
    const r = await readResultFile(dir, name);
    if (!r.result || r.result.testPackage.versionId !== versionId) continue;
    const problems = [...r.problems];
    const gmp = await gmpProblem(db, versionId, r.result);
    if (gmp) problems.push(gmp);
    out.push({
      fileName: name,
      resultHash: r.result.resultHash,
      runId: r.result.run.runId,
      batchNumber: r.result.run.batchNumber,
      runStatus: r.result.run.status,
      passed: r.result.passed,
      contentHash: r.result.testPackage.contentHash,
      exportedAt: app.formatInstant(BigInt(r.result.exportedAtUs)),
      exporter: `${r.result.exporter.legalName} (${r.result.exporter.loginName})`,
      imported: imported.has(r.result.resultHash),
      problem: problems.length > 0 ? problems.join('; ') : null,
    });
  }
  return out.sort((a, b) => (a.exportedAt.us < b.exportedAt.us ? 1 : -1));
}

const unusable = (problems: string[]) =>
  refusal(422, {
    code: 'EBMR-API-RUN-RESULT-REFUSED',
    kind: 'INVALID_INPUT',
    whatHappened: 'The sandbox test-run result was not imported. Nothing was recorded.',
    why: problems.slice(0, 5).join('; '),
    whatYouCanDo: ['Export the result again from the run page of the sandbox test run of this version\'s current revision, then import that file.'],
    whoCanHelp: ['QA'],
    controls: CONTROLS,
  });

/**
 * The result to import, checked: from the inbox by its file name, or from uploaded text. Throws a refusal naming every
 * problem; nothing is recorded for a result that fails a check.
 */
export async function resultToImport(app: AppContext, db: Db, versionId: string, source: { fileName?: string | undefined; text?: string | undefined }): Promise<execution.TestRunResultV1> {
  if ((source.fileName === undefined) === (source.text === undefined)) throw unusable(['give either the file name of a result in the exchange inbox or the uploaded text of a result, not both']);
  const stamp = await sandbox.readInstallationStamp(db);
  sandbox.assertGmpOrigin(stamp, 'The installation importing a sandbox test-run result');
  let r: InboxResult;
  if (source.fileName !== undefined) {
    const dir = join(app.config.exchangeDir, GMP_INBOX);
    const names = await readdir(dir).catch(() => [] as string[]);
    if (!names.includes(source.fileName)) {
      throw refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'INVALID_INPUT', whatHappened: 'There is no such test-run result in the exchange inbox. Nothing was recorded.', why: `${source.fileName} is not in ${GMP_INBOX}/.`, whatYouCanDo: ['Export the result from the sandbox run page, or upload its file.'], whoCanHelp: ['The system administrator'], controls: CONTROLS });
    }
    r = await readResultFile(dir, source.fileName);
  } else {
    r = parseText(source.text ?? '');
  }
  if (!r.result) throw unusable(r.problems);
  const gmp = await gmpProblem(db, versionId, r.result);
  const problems = [...r.problems, ...(gmp ? [gmp] : [])];
  if (problems.length > 0) throw unusable(problems);
  return r.result;
}

/** The SANDBOX_RUN report of a result (sql 0120: {contentHash, runId, sandbox, coverage, passed}, with the citation). */
export function sandboxRunReport(result: execution.TestRunResultV1): Record<string, unknown> {
  return {
    contentHash: result.testPackage.contentHash,
    runId: result.run.runId,
    sandbox: result.source.watermark ?? 'SANDBOX',
    coverage: result.coverage,
    passed: result.passed,
    batchNumber: result.run.batchNumber,
    runStatus: result.run.status,
    testPackageHash: result.testPackage.packageHash,
    resultHash: result.resultHash,
    exportedAtUs: result.exportedAtUs,
    exportedBy: result.exporter.loginName,
  };
}

/** Records the result as the version's SANDBOX_RUN evidence in the person's command (the database decides PASS or FAIL). */
export function recordSandboxRun(c: pg.PoolClient, versionId: string, result: execution.TestRunResultV1): Promise<lifecycle.EvidenceResult> {
  return lifecycle.recordEvidence(c, versionId, 'SANDBOX_RUN', sandboxRunReport(result));
}
