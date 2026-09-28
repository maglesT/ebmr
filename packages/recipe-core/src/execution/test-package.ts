/**
 * The test-package exchange format `ebmr.mbr-test-package` version 1 (Phase 2 apps plan section 2,
 * exchange directory; decision D5): what the GMP designer writes to `to-sandbox/<packageHash>.json` and
 * the sandbox imports to test-run an MBR version. Pure (no I/O); the GMP exporter and the sandbox importer
 * share it, so both compute the same hashes.
 *
 * Members (strict: any other member refuses the package):
 *   format "ebmr.mbr-test-package", formatVersion 1;
 *   source {installationKind, watermark} as kernel sandbox.readInstallationStamp returns it (GMP, null);
 *   family {familyId, familyCode, product {code, name, strength}};
 *   version {versionId, number, revision, state};
 *   content (the MBR content JSON) and contentHash (SHA-256 of its canonical JSON, flow.mbrContentHash);
 *   justifications [{key, text, by}] (validator and engine definition warnings);
 *   exporter {personId, legalName, loginName}; exportedAtUs (database clock, epoch microseconds text);
 *   packageHash = SHA-256 of the canonical JSON of every other member; the file name is `<packageHash>.json`.
 */
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { parseMbr } from '../flow/parse.ts';
import type { MbrContent } from '../flow/model.ts';

export const TEST_PACKAGE_FORMAT = 'ebmr.mbr-test-package';
export const TEST_PACKAGE_FORMAT_VERSION = 1;

export interface TestPackageV1 {
  format: typeof TEST_PACKAGE_FORMAT;
  formatVersion: typeof TEST_PACKAGE_FORMAT_VERSION;
  source: { installationKind: 'GMP' | 'SANDBOX'; watermark: string | null };
  family: { familyId: string; familyCode: string; product: { code: string; name: string; strength: string } };
  version: { versionId: string; number: string; revision: number; state: string };
  content: MbrContent;
  contentHash: string;
  justifications: { key: string; text: string; by: string }[];
  exporter: { personId: string; legalName: string; loginName: string };
  exportedAtUs: string;
  packageHash: string;
}

export type TestPackageInput = Omit<TestPackageV1, 'format' | 'formatVersion' | 'contentHash' | 'packageHash'>;

/** SHA-256 (hex) of the canonical JSON of the package without its packageHash member. */
export function packageHashOf(pkg: Omit<TestPackageV1, 'packageHash'> | Record<string, unknown>): string {
  const rest = Object.fromEntries(Object.entries(pkg).filter(([k]) => k !== 'packageHash'));
  return sha256Hex(canonicalJson(rest));
}

/** Builds a package (hashes computed). */
export function buildTestPackage(input: TestPackageInput): TestPackageV1 {
  const base: Omit<TestPackageV1, 'packageHash'> = {
    format: TEST_PACKAGE_FORMAT,
    formatVersion: TEST_PACKAGE_FORMAT_VERSION,
    source: input.source,
    family: input.family,
    version: input.version,
    content: input.content,
    contentHash: sha256Hex(canonicalJson(input.content)),
    justifications: input.justifications,
    exporter: input.exporter,
    exportedAtUs: input.exportedAtUs,
  };
  return { ...base, packageHash: packageHashOf(base) };
}

export type ParsedPackage = { ok: true; pkg: TestPackageV1 } | { ok: false; problems: string[] };

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Parses a package strictly (fail closed): exact member sets, hashes recomputed, the file name checked
 * when given, and the MBR content parsed by the flow model. The GMP origin is checked by the importer.
 */
export function parseTestPackage(json: unknown, fileName?: string): ParsedPackage {
  const out: string[] = [];
  if (!exactMembers(json, ['format', 'formatVersion', 'source', 'family', 'version', 'content', 'contentHash', 'justifications', 'exporter', 'exportedAtUs', 'packageHash'], '$', out)) return { ok: false, problems: out };
  const p = json;
  if (p['format'] !== TEST_PACKAGE_FORMAT || p['formatVersion'] !== TEST_PACKAGE_FORMAT_VERSION) out.push(`$ is not an ${TEST_PACKAGE_FORMAT} version ${TEST_PACKAGE_FORMAT_VERSION}`);
  if (exactMembers(p['source'], ['installationKind', 'watermark'], '$.source', out)) {
    const s = p['source'];
    if (s['installationKind'] !== 'GMP' && s['installationKind'] !== 'SANDBOX') out.push('$.source.installationKind must be GMP or SANDBOX');
    if (s['watermark'] !== null && typeof s['watermark'] !== 'string') out.push('$.source.watermark must be text or null');
  }
  if (exactMembers(p['family'], ['familyId', 'familyCode', 'product'], '$.family', out)) {
    const f = p['family'];
    if (typeof f['familyId'] !== 'string' || !UUID.test(f['familyId'])) out.push('$.family.familyId must be a UUID');
    if (!text(f['familyCode'])) out.push('$.family.familyCode must be text');
    if (exactMembers(f['product'], ['code', 'name', 'strength'], '$.family.product', out)) {
      for (const k of ['code', 'name', 'strength']) if (!text(f['product'][k])) out.push(`$.family.product.${k} must be text`);
    }
  }
  if (exactMembers(p['version'], ['versionId', 'number', 'revision', 'state'], '$.version', out)) {
    const v = p['version'];
    if (typeof v['versionId'] !== 'string' || !UUID.test(v['versionId'])) out.push('$.version.versionId must be a UUID');
    if (!text(v['number'])) out.push('$.version.number must be text');
    if (typeof v['revision'] !== 'number' || !Number.isSafeInteger(v['revision']) || v['revision'] < 0) out.push('$.version.revision must be a whole number');
    if (!text(v['state'])) out.push('$.version.state must be text');
  }
  if (!Array.isArray(p['justifications'])) out.push('$.justifications must be a list');
  else
    p['justifications'].forEach((j, i) => {
      if (exactMembers(j, ['key', 'text', 'by'], `$.justifications[${i}]`, out)) for (const k of ['key', 'text', 'by']) if (!text(j[k])) out.push(`$.justifications[${i}].${k} must be text`);
    });
  if (exactMembers(p['exporter'], ['personId', 'legalName', 'loginName'], '$.exporter', out)) {
    const e = p['exporter'];
    if (typeof e['personId'] !== 'string' || !UUID.test(e['personId'])) out.push('$.exporter.personId must be a UUID');
    if (!text(e['legalName']) || !text(e['loginName'])) out.push('$.exporter needs a legal name and a login name');
  }
  if (typeof p['exportedAtUs'] !== 'string' || !/^[0-9]{1,19}$/.test(p['exportedAtUs'])) out.push('$.exportedAtUs must be epoch microseconds as text');
  if (typeof p['contentHash'] !== 'string' || !HEX64.test(p['contentHash'])) out.push('$.contentHash must be a SHA-256 hex digest');
  if (typeof p['packageHash'] !== 'string' || !HEX64.test(p['packageHash'])) out.push('$.packageHash must be a SHA-256 hex digest');
  if (out.length > 0) return { ok: false, problems: out };
  let contentHash: string;
  let packageHash: string;
  try {
    contentHash = sha256Hex(canonicalJson(p['content']));
    packageHash = packageHashOf(p);
  } catch (e) {
    return { ok: false, problems: [`the package has no canonical form: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (contentHash !== p['contentHash']) out.push('the MBR content does not match its content hash (changed after export)');
  if (packageHash !== p['packageHash']) out.push('the package does not match its package hash (changed after export)');
  if (fileName !== undefined && fileName !== `${String(p['packageHash'])}.json`) out.push(`the file name ${fileName} is not <packageHash>.json`);
  const mbr = parseMbr(p['content']);
  if (!mbr.ok) out.push(...mbr.problems.map((x) => `content ${x.path}: ${x.message}`));
  else if (sha256Hex(canonicalJson(mbr.mbr)) !== contentHash) out.push('the MBR content is not in the canonical form of the content model');
  if (out.length > 0 || !mbr.ok) return { ok: false, problems: out };
  return { ok: true, pkg: { ...(p as unknown as TestPackageV1), content: mbr.mbr } };
}
