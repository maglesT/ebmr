/**
 * The MBR test package (module C2; decision D5; DI-05): the exact current content of a version, written once to the
 * exchange directory for a sandbox test run. No process holds credentials for both databases; the sandbox import
 * (C3) recomputes both hashes, requires the GMP stamp and defines the batch for the SANDBOX.
 *
 * Format `ebmr.mbr-test-package` v1 (C3's builder and strict parser in recipe-core execution/test-package.ts):
 *   format, formatVersion           "ebmr.mbr-test-package", 1
 *   source                          {installationKind, watermark} from kernel sandbox.readInstallationStamp (GMP, null)
 *   family                          {familyId, familyCode, product {code, name, strength}}
 *   version                         {versionId, number, revision, state}
 *   content, contentHash            the MbrContent JSON and its SHA-256 over canonical JSON (flow.mbrContentHash)
 *   justifications                  [{key, text, by}] recorded warning justifications (key `${rule}@${subject}`)
 *   exporter                        {personId, legalName, loginName}
 *   exportedAtUs                    epoch microseconds from the database clock, as digits
 *   packageHash                     SHA-256 over the canonical JSON of every other member; also the file name
 *
 * Writing (DI-05: a recorded export and its file stay together, review P14 and P65):
 *  - inside the export command, the staged packages of earlier recorded exports are published first
 *    (publishRecordedStaged); while one of them cannot be, the command records nothing (no new export piles up on
 *    the audit trail behind one that has not reached the inbox);
 *  - `to-sandbox/.staging/<hash>.<random>.tmp` is created exclusively and fsynced, and the inbox must take a hard
 *    link of it (proveInboxLinkable, a dot-file probe the inbox never reads) before the export is recorded
 *    (tab.record_test_package_export, with its entry on the version's audit chain): on an exchange share without
 *    hard links nothing is recorded, however often the export is tried;
 *  - only after the command committed is the staged file hard-linked to `to-sandbox/<packageHash>.json` (link fails
 *    if the name exists, so a package file is write-once) and the staging name removed. Nothing reaches
 *    `to-sandbox/` for an export that is not recorded;
 *  - a file is linked to that name only after its text was checked to be exactly the recorded package (package hash
 *    recomputed), and a file already under that name counts as published only when it holds that package. A staged
 *    file changed on disk is never published: the package is staged again from the text the command stored, when
 *    that text is at hand, and otherwise the export stays unpublished. A final name holding other content is left
 *    as it is and reported, never replaced (docs/operations/test-package-exchange.md);
 *  - one export at a time passes the gate and records (a transaction advisory lock the export command takes first),
 *    so a burst of exports cannot all pass the gate before any of them is recorded;
 *  - a staged file is removed only when its command surely did not commit: its work failed, or the database
 *    refused the commit and shows no such export. When the commit may have happened (an answer lost with the
 *    connection) the staged file stays, and it is published once the export shows as recorded. When the link fails
 *    after the commit, the staged file stays too: a resend with the same idempotency key publishes it (re-staged from
 *    the package text kept in the command's stored result when the staged file is gone), and every staged package
 *    whose export is recorded is published by the next export and at start-up, after checking its package hash.
 */
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type pg from 'pg';
import { execution } from '@ebmr/recipe-core';

/** The package type and builder are C3's (recipe-core execution/test-package.ts), shared with the importer. */
export type TestPackage = execution.TestPackageV1;

/**
 * Builds the package with the shared builder and checks that the content hash it computes is the saved revision's
 * hash (the content travels exactly as saved).
 */
export function buildTestPackage(input: execution.TestPackageInput, savedContentHash: string): TestPackage {
  const pkg = execution.buildTestPackage(input);
  if (pkg.contentHash !== savedContentHash) {
    throw new Error(`the package content hash ${pkg.contentHash} is not the saved content hash ${savedContentHash}; nothing was exported (DI-04)`);
  }
  return pkg;
}

export const packageFileName = (pkg: Pick<TestPackage, 'packageHash'>): string => `${pkg.packageHash}.json`;

export interface StagedPackage {
  fileName: string;
  finalPath: string;
  stagedPath: string;
}

/** A recorded export as the export command stores its result: where it was staged, and the exact file text. */
export interface RecordedExport extends StagedPackage {
  packageHash: string;
  /** The package file's text, byte for byte as staged (JSON of the package, two-space indent, final newline). */
  fileText: string;
}

/** The text of a package file. */
export const packageFileText = (pkg: TestPackage): string => `${JSON.stringify(pkg, null, 2)}\n`;

const STAGED = /^([0-9a-f]{64})\.[0-9a-f-]{36}\.tmp$/;

/** Writes one staging file in `<toSandbox>/.staging` (exclusive create, fsync). */
async function writeStaged(toSandbox: string, packageHash: string, text: string): Promise<string> {
  const staging = join(toSandbox, '.staging');
  await mkdir(staging, { recursive: true });
  const stagedPath = join(staging, `${packageHash}.${randomUUID()}.tmp`);
  const fh = await open(stagedPath, 'wx', 0o640);
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  return stagedPath;
}

/** Writes the package to the staging directory (exclusive create, fsync). */
export async function stagePackage(exchangeDir: string, pkg: TestPackage): Promise<StagedPackage & { fileText: string }> {
  const dir = join(exchangeDir, 'to-sandbox');
  const fileName = packageFileName(pkg);
  const fileText = packageFileText(pkg);
  const stagedPath = await writeStaged(dir, pkg.packageHash, fileText);
  return { fileName, finalPath: join(dir, fileName), stagedPath, fileText };
}

const codeOf = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;

/** The text of the file at `path`, or null when there is no such file. */
async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null;
    throw error;
  }
}

/** True when `text` is a package file whose package hash is `packageHash` (members recomputed, not read). */
function holdsPackage(text: string, packageHash: string): boolean {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    return pkg['packageHash'] === packageHash && execution.packageHashOf(pkg) === packageHash;
  } catch {
    return false;
  }
}

/**
 * Whether the recorded package is published: its final file exists and holds exactly that package. A final file
 * with other content takes the write-once name from the package: that throws (it is never counted as published, and
 * never replaced or removed here).
 */
async function isPublished(finalPath: string, packageHash: string): Promise<boolean> {
  const text = await readIfExists(finalPath);
  if (text === null) return false;
  if (!holdsPackage(text, packageHash)) {
    throw new Error(`the inbox file ${basename(finalPath)} is not the recorded package ${packageHash}; it was left as it is and the package was not published (DI-05)`);
  }
  return true;
}

/**
 * Links a staged file, whose text the caller has checked to be the package, to its final, write-once name. When the
 * link fails because the final file is there already (EEXIST, or ENOENT after a concurrent publish of the same
 * staged file linked it and removed the staging name), the package is published only if that file holds it.
 */
async function linkStaged(stagedPath: string, finalPath: string, packageHash: string): Promise<void> {
  try {
    await link(stagedPath, finalPath);
  } catch (error) {
    if (!(await isPublished(finalPath, packageHash))) throw error;
  }
  await unlink(stagedPath).catch(() => undefined);
}

/** The sandbox inbox takes no hard link of a staged package: the export is not recorded. */
export class InboxUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InboxUnavailableError';
  }
}

/**
 * Proves, before an export is recorded, that the sandbox inbox takes the hard link that will publish the staged
 * package: the staged file is linked under a probe name in `to-sandbox/` (a dot file ending in .tmp, which the
 * inbox never reads) and the probe is removed again. Throws InboxUnavailableError when the link fails (a share
 * without hard links, no permission, no space), so nothing is recorded for a package that could not be published.
 */
export async function proveInboxLinkable(staged: StagedPackage): Promise<void> {
  const probe = join(dirname(staged.finalPath), `.link-check.${randomUUID()}.tmp`);
  try {
    await link(staged.stagedPath, probe);
  } catch (error) {
    throw new InboxUnavailableError(
      `the sandbox inbox ${dirname(staged.finalPath)} does not take a hard link of the staged package (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
  await unlink(probe).catch(() => undefined);
}

/** How a publish went: whether the package had to be staged again, because its staged file was gone or changed. */
export interface Publication {
  restaged: 'MISSING' | 'ALTERED' | null;
}

/**
 * Publishes the package of a recorded export under its final, write-once name. Idempotent: when the final file holds
 * the package nothing is written (a final file with other content throws). The staged file is linked only when it
 * holds the recorded package; when it is gone, or changed on disk, the package is staged again from the recorded
 * file text (after checking that it is the recorded package) and that copy is linked; the changed file is removed.
 */
export async function publishPackage(rec: RecordedExport): Promise<Publication> {
  if (await isPublished(rec.finalPath, rec.packageHash)) {
    await unlink(rec.stagedPath).catch(() => undefined);
    return { restaged: null };
  }
  const stagedText = await readIfExists(rec.stagedPath);
  if (stagedText !== null && holdsPackage(stagedText, rec.packageHash)) {
    await linkStaged(rec.stagedPath, rec.finalPath, rec.packageHash);
    return { restaged: null };
  }
  if (!holdsPackage(rec.fileText, rec.packageHash)) throw new Error(`the stored text of test package ${rec.packageHash} is not that package; it was not published (DI-05)`);
  const stagedPath = await writeStaged(dirname(rec.finalPath), rec.packageHash, rec.fileText);
  await linkStaged(stagedPath, rec.finalPath, rec.packageHash);
  if (stagedText !== null) await unlink(rec.stagedPath).catch(() => undefined);
  return { restaged: stagedText === null ? 'MISSING' : 'ALTERED' };
}

/** Removes the staged file of an export whose command surely did not commit (never one of a recorded export). */
export async function discardStaged(staged: StagedPackage | undefined): Promise<void> {
  if (staged) await unlink(staged.stagedPath).catch(() => undefined);
}

/** True when an export with this package hash is recorded (committed) in tab.mbr_test_package_export. */
export async function exportIsRecorded(db: pg.Pool | pg.PoolClient, packageHash: string): Promise<boolean> {
  const { rows } = await db.query<{ recorded: boolean }>('select exists (select 1 from tab.mbr_test_package_export where package_hash = $1) as recorded', [packageHash]);
  return rows[0]?.recorded === true;
}

/**
 * True when a failed command surely did not commit: the database itself answered with an error (an SQLSTATE with its
 * severity), outside the classes that leave the outcome open (08 connection, 57 operator intervention, 58 system,
 * XX internal). An error without one (a dropped connection, a timeout in the client) may hide a commit.
 */
export function surelyRolledBack(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; e !== null && typeof e === 'object' && depth < 8; depth += 1) {
    const { code, severity, cause } = e as { code?: unknown; severity?: unknown; cause?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && typeof severity === 'string') return !/^(08|57|58|XX)/.test(code);
    e = cause;
  }
  return false;
}

export interface Reconciliation {
  /** File names published now. */
  published: string[];
  /** Staged files of recorded exports that could not be published (they stay staged). */
  problems: string[];
}

/**
 * Publishes every staged package whose export is recorded (tab.mbr_test_package_export) but whose file is not in
 * `to-sandbox/` yet: a publish that failed, or was cut off, after its command committed. A staged file is published
 * only when its content is the recorded package (package hash recomputed), and a final file counts as published only
 * when it holds that package; anything else is reported as a problem and left as it is. A staged file of an export
 * that is not recorded (a command still running, or one that failed) is never published nor touched.
 */
export async function publishRecordedStaged(db: pg.Pool | pg.PoolClient, exchangeDir: string): Promise<Reconciliation> {
  const toSandbox = join(exchangeDir, 'to-sandbox');
  const staging = join(toSandbox, '.staging');
  let names: string[];
  try {
    names = await readdir(staging);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return { published: [], problems: [] };
    throw error;
  }
  const byHash = new Map<string, string[]>();
  for (const name of names) {
    const hash = STAGED.exec(name)?.[1];
    if (hash) byHash.set(hash, [...(byHash.get(hash) ?? []), name]);
  }
  const out: Reconciliation = { published: [], problems: [] };
  if (byHash.size === 0) return out;
  const { rows } = await db.query<{ package_hash: string; file_name: string }>(
    'select package_hash, file_name from tab.mbr_test_package_export where package_hash = any($1::text[])',
    [[...byHash.keys()]],
  );
  for (const r of rows) {
    const finalPath = join(toSandbox, r.file_name);
    for (const name of byHash.get(r.package_hash) ?? []) {
      const stagedPath = join(staging, name);
      try {
        if (await isPublished(finalPath, r.package_hash)) {
          await unlink(stagedPath).catch(() => undefined);
          continue;
        }
        const text = await readIfExists(stagedPath);
        if (text === null) {
          // Removed meanwhile: by a concurrent publish of the same package, or by someone else.
          if (!(await isPublished(finalPath, r.package_hash))) out.problems.push(`${name}: the staged file disappeared before its package was published (DI-05)`);
          continue;
        }
        if (!holdsPackage(text, r.package_hash)) {
          out.problems.push(`${name}: the staged file is not the recorded package ${r.package_hash} (changed on disk); it was left as it is and not published (DI-05)`);
          continue;
        }
        await linkStaged(stagedPath, finalPath, r.package_hash);
        out.published.push(r.file_name);
      } catch (error) {
        out.problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return out;
}
