/**
 * The test-run result package (slice 7h, B4; decision D-P7R-16; outline 6.5; DI-05): the sandbox side of the
 * `ebmr.test-run-result` v1 exchange (recipe-core execution/test-run-result.ts), the return of a test run to the GMP
 * version whose test package it executed. Exported from the run page; the GMP author imports it
 * (market/sandbox-run-results.ts) as the version's SANDBOX_RUN evidence.
 *
 * The result carries the sandbox's installation stamp (kernel sandbox.readInstallationStamp: SANDBOX, "TEST, NOT GMP"),
 * the imported test package it ran (hash, version, content hash), the run's TEST- number and status, its coverage (steps
 * and stages finished, open exceptions) and a replay of its stored rows (identical or not, invariant problems); it passed
 * only when the run is EXECUTION_COMPLETE, the replay is identical and no invariant is violated. As the outbound package
 * is, it is written write-once under its hash: staged in `to-gmp/.staging/` (exclusive create, fsync) and hard-linked
 * to `to-gmp/<resultHash>.json` (a link fails when the name exists; a file already there counts only when it holds this
 * result). The file text is returned too, for a download when the GMP host does not share the exchange folder. Nothing
 * is written into the sandbox database: the export is a read of the run.
 */
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunResultExportView } from '@ebmr/api-contract';
import { sandbox } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import type { AppContext } from '../../platform/context.ts';
import { dbNowUs } from '../../platform/db/commands.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { notFound, runContext, type Db } from './runs.ts';

export const OUTBOX = 'to-gmp';

/** The text of a result file (JSON, two-space indent, final newline). */
export const resultFileText = (r: execution.TestRunResultV1): string => `${JSON.stringify(r, null, 2)}\n`;

/** Builds the run's result from its stored state and a replay of its rows (pure of writes). */
export async function buildRunResult(db: Db, runId: string, exporter: { personId: string; legalName: string; loginName: string }): Promise<execution.TestRunResultV1> {
  const run = await runContext(db, runId);
  if (!run.pkg) throw notFound('test run');
  const stored = await execution.loadState(db, runId);
  if (!stored) throw notFound('test run');
  const stamp = await sandbox.readInstallationStamp(db);
  if (stamp.installationKind !== 'SANDBOX') {
    throw refusal(422, { code: 'EBMR-SBX-013', kind: 'NOT_ALLOWED', whatHappened: 'A test-run result is exported from a sandbox only.', why: `This installation is ${stamp.installationKind}.`, controls: ['DI-05'], whatYouCanDo: ['Export the result on the sandbox.'] });
  }
  const { rows } = await db.query<{ version_id: string | null }>("select package -> 'version' ->> 'versionId' as version_id from recipe.test_package where package_hash = $1", [run.pkg.packageHash]);
  const versionId = rows[0]?.version_id;
  if (!versionId) throw notFound('test package of this run');
  const replay = await execution.replayExecution(db, run.def, runId);
  const state = stored.state;
  const steps = Object.values(state.steps);
  const stages = Object.values(state.stages);
  const count = (n: number): string => String(n);
  return execution.buildTestRunResult({
    source: stamp,
    testPackage: { packageHash: run.pkg.packageHash, versionId, versionNumber: run.pkg.versionNumber, revision: run.pkg.revision, contentHash: run.pkg.contentHash, familyCode: run.pkg.familyCode },
    run: { runId, batchNumber: state.header.batchNumber, status: state.status },
    coverage: {
      stepsTotal: count(steps.length),
      stepsFinished: count(steps.filter((s) => engine.TERMINAL_STEP_STATUSES.includes(s.status)).length),
      stagesTotal: count(stages.length),
      stagesSignedOff: count(stages.filter((s) => s.signOff?.valid === true).length),
      openExceptions: count(Object.values(state.exceptions).filter((e) => e.status === 'OPEN').length),
      replayRows: count(replay.rows),
      replayIdentical: replay.identical && replay.contentProblems.length === 0,
      invariantViolations: [...replay.invariantViolations],
    },
    exporter,
    exportedAtUs: (await dbNowUs(db)).toString(),
  });
}

/** True when `text` is the result whose hash is `resultHash` (members recomputed, not read). */
function holdsResult(text: string, resultHash: string): boolean {
  try {
    const r = JSON.parse(text) as Record<string, unknown>;
    return r['resultHash'] === resultHash && execution.resultHashOf(r) === resultHash;
  } catch {
    return false;
  }
}

/** Writes the result write-once to `<exchange>/to-gmp/<resultHash>.json` (staged, fsynced, hard-linked). */
export async function writeRunResult(exchangeDir: string, result: execution.TestRunResultV1): Promise<{ fileName: string; fileText: string }> {
  const dir = join(exchangeDir, OUTBOX);
  const staging = join(dir, '.staging');
  await mkdir(staging, { recursive: true });
  const fileName = `${result.resultHash}.json`;
  const fileText = resultFileText(result);
  const stagedPath = join(staging, `${result.resultHash}.${randomUUID()}.tmp`);
  const fh = await open(stagedPath, 'wx', 0o640);
  try {
    await fh.writeFile(fileText, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await link(stagedPath, join(dir, fileName));
  } catch (error) {
    const there = await readFile(join(dir, fileName), 'utf8').catch(() => null);
    if (there === null || !holdsResult(there, result.resultHash)) throw error;
  } finally {
    await unlink(stagedPath).catch(() => undefined);
  }
  return { fileName, fileText };
}

/** The export route's work: the result built for the signed-in person and written for GMP. */
export async function exportRunResult(app: AppContext, db: Db, runId: string, who: { personId: string; legalName: string; loginName: string }): Promise<RunResultExportView> {
  const result = await buildRunResult(db, runId, { personId: who.personId, legalName: who.legalName, loginName: who.loginName });
  const { fileName, fileText } = await writeRunResult(app.config.exchangeDir, result);
  return { fileName, resultHash: result.resultHash, passed: result.passed, fileText };
}
