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
 * Writing: `to-sandbox/.staging/<hash>.<random>.tmp` is created exclusively and fsynced inside the export command;
 * after the command commits, it is hard-linked to `to-sandbox/<packageHash>.json` (link fails if the name exists,
 * so a package file is write-once) and the staging name is removed. A failed command removes the staging file.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
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

/** Writes the package to the staging directory (exclusive create, fsync). */
export async function stagePackage(exchangeDir: string, pkg: TestPackage): Promise<StagedPackage> {
  const dir = join(exchangeDir, 'to-sandbox');
  const staging = join(dir, '.staging');
  await mkdir(staging, { recursive: true });
  const fileName = packageFileName(pkg);
  const stagedPath = join(staging, `${pkg.packageHash}.${randomUUID()}.tmp`);
  const fh = await open(stagedPath, 'wx', 0o640);
  try {
    await fh.writeFile(`${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { fileName, finalPath: join(dir, fileName), stagedPath };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Publishes a staged package under its final, write-once name. Idempotent when the final file already exists. */
export async function publishPackage(staged: StagedPackage): Promise<void> {
  if (!(await exists(staged.finalPath))) await link(staged.stagedPath, staged.finalPath);
  await unlink(staged.stagedPath).catch(() => undefined);
}

export async function discardStaged(staged: StagedPackage | undefined): Promise<void> {
  if (staged) await unlink(staged.stagedPath).catch(() => undefined);
}
