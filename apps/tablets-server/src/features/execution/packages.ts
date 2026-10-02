/**
 * Test packages (Phase 2 apps plan section 2, exchange directory; decision D5): the sandbox's inbox
 * `<exchange>/to-sandbox/<packageHash>.json`, written by the GMP designer's export (staged in .staging/ and
 * linked into place, so only complete top-level *.json files are read; .staging/, dot files and *.tmp are
 * ignored), the import, the issue form and the issue of a TEST- batch.
 *
 * Import fails closed: the package is parsed strictly with its hashes recomputed (TypeScript here, SQL again in
 * recipe.import_test_package), the file name must be the package hash, the source stamp must be the GMP
 * installation's (no watermark), and the MBR content must define for the sandbox with the package's own
 * justifications (an unexecutable version is refused with the engine's reasons).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import type { IssueFormView, TestPackageView } from '@ebmr/api-contract';
import type { z } from 'zod';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { defineForSandbox, importedPackages, Lru, type PackageRecord } from './runs.ts';

export const INBOX = 'to-sandbox';
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;

export function inboxDir(app: AppContext): string {
  return join(app.config.exchangeDir, INBOX);
}

export interface InboxPackage {
  fileName: string;
  packageId: string;
  pkg: execution.TestPackageV1 | null;
  problems: string[];
}

function originProblem(pkg: execution.TestPackageV1): string | null {
  if (pkg.source.installationKind !== 'GMP' || pkg.source.watermark !== null) {
    return `the package comes from a ${pkg.source.installationKind} installation${pkg.source.watermark ? ` (${pkg.source.watermark})` : ''}; only MBR versions exported from GMP are test-run (DI-05, INV-18)`;
  }
  return null;
}

function definitionProblems(pkg: execution.TestPackageV1): string[] {
  try {
    defineForSandbox(pkg.packageHash, pkg.content, pkg.justifications);
    return [];
  } catch (e) {
    if (e instanceof engine.EngineDefinitionError) return e.problems.map((p) => p.message);
    return [e instanceof Error ? e.message : String(e)];
  }
}

/** Reads and checks one inbox file (never throws for a bad file: its problems are returned). */
export async function readInboxFile(dir: string, fileName: string): Promise<InboxPackage> {
  const packageId = fileName.replace(/\.json$/, '');
  let json: unknown;
  try {
    const info = await stat(join(dir, fileName));
    if (!info.isFile()) return { fileName, packageId, pkg: null, problems: ['not a file'] };
    if (info.size > MAX_PACKAGE_BYTES) return { fileName, packageId, pkg: null, problems: [`the file is larger than ${MAX_PACKAGE_BYTES} bytes`] };
    json = JSON.parse(await readFile(join(dir, fileName), 'utf8'));
  } catch (e) {
    return { fileName, packageId, pkg: null, problems: [`the file cannot be read as JSON (${e instanceof Error ? e.message : String(e)})`] };
  }
  const parsed = execution.parseTestPackage(json, fileName);
  if (!parsed.ok) return { fileName, packageId, pkg: null, problems: parsed.problems };
  const origin = originProblem(parsed.pkg);
  const problems = [...(origin ? [origin] : []), ...definitionProblems(parsed.pkg)];
  return { fileName, packageId, pkg: parsed.pkg, problems };
}

const inboxCache = new Lru<string, InboxPackage>(64);

/** Top-level *.json files of the inbox (dot files, .staging/ and *.tmp ignored), checked (cached by name, size and time). */
export async function listInbox(app: AppContext): Promise<InboxPackage[]> {
  const dir = inboxDir(app);
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && d.name.endsWith('.json') && !d.name.startsWith('.')).map((d) => d.name).sort();
  } catch {
    return [];
  }
  const out: InboxPackage[] = [];
  for (const name of names) {
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (!info) continue;
    const key = `${dir}|${name}|${info.size}|${info.mtimeMs}`;
    let p = inboxCache.get(key);
    if (!p) {
      p = await readInboxFile(dir, name);
      inboxCache.set(key, p);
    }
    out.push(p);
  }
  return out;
}

const EMPTY_PRODUCT = { code: '', name: '', strength: '' };

export function packageView(app: AppContext, p: InboxPackage | null, imported: PackageRecord | undefined): TestPackageView {
  const pkg = p?.pkg ?? null;
  if (imported) {
    return {
      packageId: imported.packageHash,
      packageHash: imported.packageHash,
      fileName: imported.fileName,
      familyCode: imported.familyCode,
      product: imported.product,
      versionNumber: imported.versionNumber,
      revision: imported.revision,
      state: imported.versionState,
      contentHash: imported.contentHash,
      exportedAt: app.formatInstant(imported.exportedAtUs),
      exporter: `${imported.exporter.legalName} (${imported.exporter.loginName})`,
      sourceInstallation: imported.sourceInstallation,
      imported: true,
      importedAt: app.formatInstant(imported.importedAtUs),
      problem: null,
    };
  }
  return {
    packageId: p?.packageId ?? '',
    packageHash: pkg?.packageHash ?? '',
    fileName: p?.fileName ?? '',
    familyCode: pkg?.family.familyCode ?? '',
    product: pkg?.family.product ?? EMPTY_PRODUCT,
    versionNumber: pkg?.version.number ?? '',
    revision: pkg?.version.revision ?? 0,
    state: pkg?.version.state ?? '',
    contentHash: pkg?.contentHash ?? '',
    exportedAt: app.formatInstant(pkg ? BigInt(pkg.exportedAtUs) : 0n),
    exporter: pkg ? `${pkg.exporter.legalName} (${pkg.exporter.loginName})` : '',
    sourceInstallation: pkg?.source.installationKind ?? 'GMP',
    imported: false,
    importedAt: null,
    problem: p && p.problems.length > 0 ? p.problems.slice(0, 5).join('; ') : null,
  };
}

/** Inbox and imported packages (an imported package is shown once, as imported). */
export async function packageViews(app: AppContext): Promise<TestPackageView[]> {
  const imported = await importedPackages(app.pools.app);
  const byHash = new Map(imported.map((p) => [p.packageHash, p]));
  const out: TestPackageView[] = [];
  for (const p of await listInbox(app)) {
    const hash = p.pkg?.packageHash;
    if (hash && byHash.has(hash)) continue;
    out.push(packageView(app, p, undefined));
  }
  for (const p of imported) out.push(packageView(app, null, p));
  return out;
}

/** The inbox package to import (refusals are thrown). */
export async function packageToImport(app: AppContext, packageId: string): Promise<execution.TestPackageV1> {
  if (!HASH.test(packageId)) throw refusal(404, { code: 'EXE_NOT_FOUND', kind: 'STALE', whatHappened: 'The test package was not found.', why: 'A package id is the SHA-256 of the package.', controls: ['DI-05'], whatYouCanDo: ['Reload the list of packages.'] });
  const p = await readInboxFile(inboxDir(app), `${packageId}.json`);
  if (!p.pkg) {
    if (p.problems.some((x) => x.includes('ENOENT'))) {
      throw refusal(404, { code: 'EXE_NOT_FOUND', kind: 'STALE', whatHappened: 'The test package is not in the exchange inbox.', why: `${packageId}.json was not found.`, controls: ['DI-05'], whatYouCanDo: ['Export the MBR version again from the GMP designer.'] });
    }
    throw refusal(422, { code: 'EBMR-EXE-017', kind: 'INVALID_INPUT', whatHappened: 'The file is not a valid test package, or it was changed after export. Nothing was imported.', why: p.problems.slice(0, 8).join('; '), controls: ['DI-05', 'DI-37'], whatYouCanDo: ['Export the MBR version again from the GMP designer; never edit a package file.'], whoCanHelp: ['The MBR author'] });
  }
  const origin = originProblem(p.pkg);
  if (origin) throw refusal(422, { code: 'EBMR-EXE-018', kind: 'NOT_ALLOWED', whatHappened: 'Only MBR versions exported from the GMP installation are test-run. Nothing was imported.', why: origin, controls: ['DI-05', 'INV-18'], whatYouCanDo: ['Export the MBR version from the GMP designer.'], whoCanHelp: ['The MBR author'] });
  if (p.problems.length > 0) {
    throw refusal(422, { code: 'EBMR-EXE-020', kind: 'INVALID_INPUT', whatHappened: 'This MBR version cannot be executed as it is. Nothing was imported.', why: p.problems.slice(0, 8).join('; '), controls: ['DI-34'], whatYouCanDo: ['Correct the MBR version in the designer and export it again.'], whoCanHelp: ['The MBR author'] });
  }
  return p.pkg;
}

// ---------------------------------------------------------------------------------------------
// Issue

export function issueForm(pkg: PackageRecord, def: engine.BatchDefinition): z.infer<typeof IssueFormView> {
  const h = def.mbr.header;
  return {
    packageId: pkg.packageHash,
    // As the MBR content names it (the import refuses a package whose metadata differs, F03).
    product: { code: h.product.code, name: h.product.name, strength: h.product.strength },
    batchSizes: h.batchSizes.map((b) => ({ id: b.id, quantity: b.quantity.value, unit: b.quantity.unit, label: `${b.id}: ${b.quantity.value} ${b.quantity.unit}` })),
    markets: [...new Set(['IN', ...h.marketSet])].map((code) => ({ code, locked: code === 'IN' })),
    variants: h.variants.map((v) => ({ id: v.id, name: v.id, options: [...v.values] })),
    inputs: def.mbr.inputs.map((i: flow.ExternalInput) => ({ id: i.id, name: i.name, valueType: i.valueType, unit: i.unit ?? null, source: i.source, required: true })),
  };
}

/**
 * Checks the header facts before anything is allocated: every BATCH_HEADER and MASTER_DATA input is given (a
 * COUNT header input is a positive whole number), India is in the market set; then a pure engine issue at
 * `nowUs` with a placeholder number, so a refusal never consumes a TEST- number.
 */
export function checkIssue(def: engine.BatchDefinition, request: Omit<engine.IssueRequest, 'batchId' | 'batchNumber'>, nowUs: bigint): void {
  const missing = def.mbr.inputs.filter((i) => request.inputs[i.id] === undefined).map((i) => `${i.name} (${i.id})`);
  if (missing.length > 0) {
    throw refusal(422, { code: 'EBMR-EXE-085', kind: 'INVALID_INPUT', whatHappened: 'Every batch-header and master-data value must be given at issue. Nothing was issued.', why: `Missing: ${missing.join(', ')}.`, controls: ['PR-10', 'DI-10'], whatYouCanDo: ['Enter the missing values.'] });
  }
  const zero = def.mbr.inputs.filter((i) => i.valueType === 'COUNT' && request.inputs[i.id]?.value.kind === 'COUNT' && (request.inputs[i.id]?.value as { value: string }).value === '0').map((i) => `${i.name} (${i.id})`);
  if (zero.length > 0) {
    throw refusal(422, { code: 'EBMR-EXE-085', kind: 'INVALID_INPUT', whatHappened: 'A count at issue must be a positive whole number. Nothing was issued.', why: `Zero given for ${zero.join(', ')}.`, controls: ['PR-10', 'DI-30'], whatYouCanDo: ['Enter the count from the batch header.'] });
  }
  try {
    engine.issue(def, { ...request, batchId: '00000000-0000-4000-8000-000000000000', batchNumber: 'TEST-CHECK' }, { nowUs });
  } catch (e) {
    if (e instanceof engine.IssueRefusedError) {
      throw refusal(422, { code: e.code, kind: 'INVALID_INPUT', whatHappened: 'The batch cannot be issued with these values. Nothing was issued.', why: e.message, controls: ['PR-01', 'PR-10'], whatYouCanDo: ['Correct the values and issue again.'] });
    }
    throw e;
  }
}
