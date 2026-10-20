/**
 * The test-run result exchange format `ebmr.test-run-result` version 1 (slice 7h, decision D-P7R-16; outline 6.5;
 * DI-04, DI-05, INV-18): what the sandbox writes to `to-gmp/<resultHash>.json` when a test run of an imported MBR test
 * package is exported from its run page, and what the GMP installation imports as the SANDBOX_RUN verification evidence
 * of the MBR version the package came from. It mirrors the outbound `ebmr.mbr-test-package` (test-package.ts): pure (no
 * I/O), shared by the sandbox exporter and the GMP importer so both compute the same hash; a source stamp from kernel
 * sandbox.readInstallationStamp (here the sandbox's, which GMP requires); write-once under its hash.
 *
 * Members (strict: any other member refuses the result):
 *   format "ebmr.test-run-result", formatVersion 1;
 *   source {installationKind, watermark}: the exporting installation's stamp (SANDBOX, "TEST, NOT GMP");
 *   testPackage {packageHash, versionId, versionNumber, revision, contentHash, familyCode}: the GMP test package the run
 *     executed, as the sandbox imported it (the GMP importer requires a package it exported for that version);
 *   run {runId, batchNumber, status}: the test run (its TEST- number and its batch status when exported);
 *   coverage {stepsTotal, stepsFinished, stagesTotal, stagesSignedOff, openExceptions, replayRows, replayIdentical,
 *     invariantViolations}: counts as digits; the replay of the stored rows (identical or not) and the invariant problems;
 *   passed: true only when the run is EXECUTION_COMPLETE, the replay is identical and no invariant is violated;
 *   exporter {personId, legalName, loginName}; exportedAtUs (database clock, epoch microseconds as digits);
 *   resultHash = SHA-256 of the canonical JSON of every other member; the file name is `<resultHash>.json`.
 */
import { canonicalJson, sha256Hex } from '@ebmr/expr';

export const TEST_RUN_RESULT_FORMAT = 'ebmr.test-run-result';
export const TEST_RUN_RESULT_FORMAT_VERSION = 1;

export interface TestRunCoverage {
  stepsTotal: string;
  stepsFinished: string;
  stagesTotal: string;
  stagesSignedOff: string;
  openExceptions: string;
  replayRows: string;
  replayIdentical: boolean;
  invariantViolations: string[];
}

export interface TestRunResultV1 {
  format: typeof TEST_RUN_RESULT_FORMAT;
  formatVersion: typeof TEST_RUN_RESULT_FORMAT_VERSION;
  source: { installationKind: 'GMP' | 'SANDBOX'; watermark: string | null };
  testPackage: { packageHash: string; versionId: string; versionNumber: string; revision: number; contentHash: string; familyCode: string };
  run: { runId: string; batchNumber: string; status: string };
  coverage: TestRunCoverage;
  passed: boolean;
  exporter: { personId: string; legalName: string; loginName: string };
  exportedAtUs: string;
  resultHash: string;
}

export type TestRunResultInput = Omit<TestRunResultV1, 'format' | 'formatVersion' | 'passed' | 'resultHash'>;

/** SHA-256 (hex) of the canonical JSON of the result without its resultHash member. */
export function resultHashOf(result: Omit<TestRunResultV1, 'resultHash'> | Record<string, unknown>): string {
  const rest = Object.fromEntries(Object.entries(result).filter(([k]) => k !== 'resultHash'));
  return sha256Hex(canonicalJson(rest));
}

/** Whether a run with this status and coverage passed: complete, replayed identically, no invariant violated. */
export function runPassed(status: string, coverage: Pick<TestRunCoverage, 'replayIdentical' | 'invariantViolations'>): boolean {
  return status === 'EXECUTION_COMPLETE' && coverage.replayIdentical && coverage.invariantViolations.length === 0;
}

/** Builds a result (passed derived, never given; hash computed). */
export function buildTestRunResult(input: TestRunResultInput): TestRunResultV1 {
  const base: Omit<TestRunResultV1, 'resultHash'> = {
    format: TEST_RUN_RESULT_FORMAT,
    formatVersion: TEST_RUN_RESULT_FORMAT_VERSION,
    source: input.source,
    testPackage: input.testPackage,
    run: input.run,
    coverage: input.coverage,
    passed: runPassed(input.run.status, input.coverage),
    exporter: input.exporter,
    exportedAtUs: input.exportedAtUs,
  };
  return { ...base, resultHash: resultHashOf(base) };
}

export type ParsedTestRunResult = { ok: true; result: TestRunResultV1 } | { ok: false; problems: string[] };

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^[0-9]{1,19}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function exactMembers(v: unknown, members: readonly string[], path: string, out: string[]): v is Record<string, unknown> {
  if (!isRecord(v)) {
    out.push(`${path} must be an object`);
    return false;
  }
  for (const k of Object.keys(v)) if (!members.includes(k)) out.push(`${path}.${k} is not a member of the format`);
  for (const k of members) if (!(k in v)) out.push(`${path}.${k} is missing`);
  return true;
}

const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Parses a result strictly (fail closed): exact member sets, the result hash recomputed, `passed` recomputed from the
 * run status and coverage, and the file name checked when given. The origin (a sandbox stamp) and the GMP facts (a
 * recorded export of this version, the current content) are checked by the importer.
 */
export function parseTestRunResult(json: unknown, fileName?: string): ParsedTestRunResult {
  const out: string[] = [];
  const top = ['format', 'formatVersion', 'source', 'testPackage', 'run', 'coverage', 'passed', 'exporter', 'exportedAtUs', 'resultHash'];
  if (!exactMembers(json, top, '$', out)) return { ok: false, problems: out };
  const p = json;
  if (p['format'] !== TEST_RUN_RESULT_FORMAT || p['formatVersion'] !== TEST_RUN_RESULT_FORMAT_VERSION) out.push(`$ is not an ${TEST_RUN_RESULT_FORMAT} version ${TEST_RUN_RESULT_FORMAT_VERSION}`);
  if (exactMembers(p['source'], ['installationKind', 'watermark'], '$.source', out)) {
    const s = p['source'];
    if (s['installationKind'] !== 'GMP' && s['installationKind'] !== 'SANDBOX') out.push('$.source.installationKind must be GMP or SANDBOX');
    if (s['watermark'] !== null && typeof s['watermark'] !== 'string') out.push('$.source.watermark must be text or null');
  }
  if (exactMembers(p['testPackage'], ['packageHash', 'versionId', 'versionNumber', 'revision', 'contentHash', 'familyCode'], '$.testPackage', out)) {
    const t = p['testPackage'];
    if (typeof t['packageHash'] !== 'string' || !HEX64.test(t['packageHash'])) out.push('$.testPackage.packageHash must be a SHA-256 hex digest');
    if (typeof t['contentHash'] !== 'string' || !HEX64.test(t['contentHash'])) out.push('$.testPackage.contentHash must be a SHA-256 hex digest');
    if (typeof t['versionId'] !== 'string' || !UUID.test(t['versionId'])) out.push('$.testPackage.versionId must be a UUID');
    if (!text(t['versionNumber']) || !text(t['familyCode'])) out.push('$.testPackage needs a version number and a family code');
    if (typeof t['revision'] !== 'number' || !Number.isSafeInteger(t['revision']) || t['revision'] < 0) out.push('$.testPackage.revision must be a whole number');
  }
  if (exactMembers(p['run'], ['runId', 'batchNumber', 'status'], '$.run', out)) {
    const r = p['run'];
    if (typeof r['runId'] !== 'string' || !UUID.test(r['runId'])) out.push('$.run.runId must be a UUID');
    if (!text(r['batchNumber']) || !text(r['status'])) out.push('$.run needs a batch number and a status');
  }
  const counts = ['stepsTotal', 'stepsFinished', 'stagesTotal', 'stagesSignedOff', 'openExceptions', 'replayRows'];
  if (exactMembers(p['coverage'], [...counts, 'replayIdentical', 'invariantViolations'], '$.coverage', out)) {
    const c = p['coverage'];
    for (const k of counts) if (typeof c[k] !== 'string' || !DIGITS.test(c[k])) out.push(`$.coverage.${k} must be a count as digits`);
    if (typeof c['replayIdentical'] !== 'boolean') out.push('$.coverage.replayIdentical must be true or false');
    if (!Array.isArray(c['invariantViolations']) || c['invariantViolations'].some((v) => typeof v !== 'string')) out.push('$.coverage.invariantViolations must be a list of texts');
  }
  if (typeof p['passed'] !== 'boolean') out.push('$.passed must be true or false');
  if (exactMembers(p['exporter'], ['personId', 'legalName', 'loginName'], '$.exporter', out)) {
    const e = p['exporter'];
    if (typeof e['personId'] !== 'string' || !UUID.test(e['personId'])) out.push('$.exporter.personId must be a UUID');
    if (!text(e['legalName']) || !text(e['loginName'])) out.push('$.exporter needs a legal name and a login name');
  }
  if (typeof p['exportedAtUs'] !== 'string' || !DIGITS.test(p['exportedAtUs'])) out.push('$.exportedAtUs must be epoch microseconds as text');
  if (typeof p['resultHash'] !== 'string' || !HEX64.test(p['resultHash'])) out.push('$.resultHash must be a SHA-256 hex digest');
  if (out.length > 0) return { ok: false, problems: out };
  let resultHash: string;
  try {
    resultHash = resultHashOf(p);
  } catch (e) {
    return { ok: false, problems: [`the result has no canonical form: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (resultHash !== p['resultHash']) out.push('the result does not match its result hash (changed after export)');
  const r = p as unknown as TestRunResultV1;
  if (r.passed !== runPassed(r.run.status, r.coverage)) out.push('$.passed is not what the run status and its coverage give');
  if (fileName !== undefined && fileName !== `${r.resultHash}.json`) out.push(`the file name ${fileName} is not <resultHash>.json`);
  if (out.length > 0) return { ok: false, problems: out };
  return { ok: true, result: r };
}
