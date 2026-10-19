/**
 * Supply-chain checks of the release (slice 7d; ASVS V10.3, V14.2; DI-13): the licence scan of every installed
 * dependency against the release's licence policy, the secret scan of every tracked file, the SBOM (CycloneDX 1.5 JSON
 * from pnpm-lock.yaml with each package's licence and integrity hash), and the release manifest (commit, schema
 * release, the SHA-256 of the SBOM, the lockfile and every migration) with Ed25519 signatures over the manifest and the
 * SBOM. The signing key is the release key: a KMS or HSM key at deployment; here, without one, a DEMO-ONLY key made for
 * the run, whose public key is published beside the signatures and named as such in the manifest.
 */
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { config } from '@ebmr/kernel';

export const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------------------------------------------------

/** Permissive licences any dependency may carry. */
export const ALLOWED_LICENCES = new Set(['MIT', 'ISC', 'BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0', 'Unlicense', 'Zlib', 'BSL-1.0', 'OFL-1.1', 'CC0-1.0', 'Python-2.0', 'WTFPL']);
/** Licences a development tool may carry (never shipped): file-level copyleft and data licences. */
export const DEV_ONLY_LICENCES = new Set(['MPL-2.0', 'CC-BY-4.0']);
/** Packages whose licence field is missing but whose licence text was read (the reviewer's note). */
export const REVIEWED_LICENCES: Readonly<Record<string, string>> = {
  'humanize@0.0.9': 'MIT: the package ships an MIT LICENSE file but declares no licence field (a node-opcua dependency).',
  'precond@0.2.3': 'MIT: its README grants the MIT licence; no licence field (a node-opcua dependency).',
};

export interface LicenceFinding {
  package: string;
  licence: string;
  production: boolean;
  status: 'ALLOWED' | 'DEV_ONLY' | 'REVIEWED' | 'DENIED';
  note?: string;
}

/** Whether an SPDX-like expression is satisfied by `ok` (OR: one side; AND: both sides; parentheses ignored). */
export function expressionAllowed(expr: string, ok: (id: string) => boolean): boolean {
  const e = expr.replace(/[()]/g, ' ').trim();
  if (/\bOR\b/.test(e)) return e.split(/\bOR\b/).some((x) => expressionAllowed(x, ok));
  if (/\bAND\b/.test(e)) return e.split(/\bAND\b/).every((x) => expressionAllowed(x, ok));
  return ok(e.trim());
}

type LicenceList = Record<string, { name: string; versions: string[] }[]>;

export function licenceFindings(all: LicenceList, production: LicenceList): LicenceFinding[] {
  const prod = new Set(Object.values(production).flatMap((list) => list.flatMap((p) => p.versions.map((v) => `${p.name}@${v}`))));
  const out: LicenceFinding[] = [];
  for (const [licence, list] of Object.entries(all)) {
    for (const p of list) {
      for (const v of p.versions) {
        const id = `${p.name}@${v}`;
        if (p.name.startsWith('@ebmr/')) continue;
        const isProd = prod.has(id);
        const reviewed = REVIEWED_LICENCES[id];
        const status: LicenceFinding['status'] = expressionAllowed(licence, (x) => ALLOWED_LICENCES.has(x)) ? 'ALLOWED'
          : !isProd && expressionAllowed(licence, (x) => ALLOWED_LICENCES.has(x) || DEV_ONLY_LICENCES.has(x)) ? 'DEV_ONLY'
            : reviewed ? 'REVIEWED' : 'DENIED';
        out.push({ package: id, licence, production: isProd, status, ...(reviewed ? { note: reviewed } : {}) });
      }
    }
  }
  return out.sort((a, b) => a.package.localeCompare(b.package));
}

export function pnpmLicences(prod: boolean): LicenceList {
  const out = execFileSync('pnpm', ['licenses', 'list', '--json', ...(prod ? ['--prod'] : [])], { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(out) as LicenceList;
}

// ---------------------------------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------------------------------

export const SECRET_PATTERNS: readonly { id: string; re: RegExp }[] = [
  { id: 'PEM_PRIVATE_KEY', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
  { id: 'AWS_ACCESS_KEY', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'GITHUB_TOKEN', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { id: 'SLACK_TOKEN', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'GOOGLE_API_KEY', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'ANTHROPIC_KEY', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'PRIVATE_KEY_FIELD', re: /"(?:privateKeyPkcs8|privateKey|secret|serviceKey)"\s*:\s*"[A-Za-z0-9+/=_-]{32,}"/ },
  { id: 'URL_PASSWORD', re: /\b(?:postgres(?:ql)?|https?|amqps?|mqtts?):\/\/[A-Za-z0-9_.-]+:[^@\s/'"`]{3,}@/ },
];

/**
 * Committed hits that are not secrets, each with the reason: the development cluster's well-known credentials (in the
 * test set-ups and the docs), and test vectors whose keys exist for the test only.
 */
export const SECRET_ALLOWLIST: readonly { id: string; path: RegExp; match?: RegExp; reason: string }[] = [
  { id: 'URL_PASSWORD', path: /.*/, match: /:\/\/(?:ebmr_[a-z_]+|postgres|user|backup|app):(?:ebmr_[a-z_]+|ebmr_dev|secret|password|pw|PASSWORD|\$\{?[A-Z_]+\}?|<[^>]+>|\*{3,})@/, reason: 'the development cluster\'s documented credentials, a placeholder, or a masked password' },
  { id: 'PRIVATE_KEY_FIELD', path: /^packages\/integration-sdk\/fixtures\/feed-signature-v1\.json$/, reason: 'test vectors of the gateway feed signature: a key made for the test only (interfaces 7-0 section 9)' },
  { id: 'PRIVATE_KEY_FIELD', path: /(^|\/)(test|fixtures)\//, reason: 'a key made for a test run (TEST-ONLY)' },
  { id: 'PEM_PRIVATE_KEY', path: /(^|\/)(test|fixtures)\//, reason: 'a key made for a test run (TEST-ONLY)' },
  { id: 'PEM_PRIVATE_KEY', path: /\.(ts|md)$/, match: /BEGIN (?:RSA |EC )?PRIVATE KEY-----['"`]|-----BEGIN PRIVATE KEY-----\\n|PRIVATE KEY-----\/|PRIVATE KEY-----`/, reason: 'the marker as text in code or docs (a parser or a check), not a key' },
];

export interface SecretHit {
  path: string;
  line: number;
  pattern: string;
  allowed: string | null;
}

export function scanText(path: string, text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  text.split('\n').forEach((line, i) => {
    for (const p of SECRET_PATTERNS) {
      const m = p.re.exec(line);
      if (!m) continue;
      const allow = SECRET_ALLOWLIST.find((a) => a.id === p.id && a.path.test(path) && (!a.match || a.match.test(line)));
      hits.push({ path, line: i + 1, pattern: p.id, allowed: allow?.reason ?? null });
    }
  });
  return hits;
}

/** Every tracked file (git ls-files), text only, up to 4 MB, the lockfile excluded (integrity hashes, no secrets). */
export function scanRepository(root = REPO): SecretHit[] {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter((f) => f !== '' && f !== 'pnpm-lock.yaml');
  const hits: SecretHit[] = [];
  for (const f of files) {
    const p = join(root, f);
    if (!existsSync(p) || statSync(p).size > 4 * 1024 * 1024) continue;
    const buf = readFileSync(p);
    if (buf.subarray(0, 8000).includes(0)) continue;
    hits.push(...scanText(f, buf.toString('utf8')));
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------------------------------
// SBOM
// ---------------------------------------------------------------------------------------------------------------------

interface LockPackage {
  resolution?: { integrity?: string; tarball?: string };
}

function lockKeyToNameVersion(key: string): { name: string; version: string } | null {
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  return { name: key.slice(0, at), version: key.slice(at + 1).replace(/\(.*$/, '') };
}

const purlOf = (name: string, version: string): string => (name.startsWith('@') ? `pkg:npm/${encodeURIComponent(name.slice(0, name.indexOf('/')))}${name.slice(name.indexOf('/'))}@${version}` : `pkg:npm/${name}@${version}`);

export interface Sbom {
  bomFormat: 'CycloneDX';
  specVersion: '1.5';
  serialNumber: string;
  version: 1;
  metadata: { timestamp: string; component: { type: 'application'; name: string; version: string; 'bom-ref': string }; properties: { name: string; value: string }[] };
  components: { type: 'library'; 'bom-ref': string; name: string; version: string; purl: string; scope: 'required' | 'optional'; licenses?: { expression: string }[]; hashes?: { alg: 'SHA-512'; content: string }[] }[];
}

export function buildSbom(opts: { lockfile: string; licences: LicenceList; production: LicenceList; commit: string; commitTime: string; product: { name: string; version: string } }): Sbom {
  const lock = parseYaml(opts.lockfile) as { packages?: Record<string, LockPackage> };
  const licenceOf = new Map<string, string>();
  for (const [licence, list] of Object.entries(opts.licences)) for (const p of list) for (const v of p.versions) licenceOf.set(`${p.name}@${v}`, licence);
  const prod = new Set(Object.values(opts.production).flatMap((list) => list.flatMap((p) => p.versions.map((v) => `${p.name}@${v}`))));
  const components: Sbom['components'] = [];
  for (const [key, pkg] of Object.entries(lock.packages ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const nv = lockKeyToNameVersion(key);
    if (!nv) continue;
    const id = `${nv.name}@${nv.version}`;
    const integrity = pkg.resolution?.integrity;
    const licence = licenceOf.get(id);
    components.push({
      type: 'library',
      'bom-ref': purlOf(nv.name, nv.version),
      name: nv.name,
      version: nv.version,
      purl: purlOf(nv.name, nv.version),
      scope: prod.has(id) ? 'required' : 'optional',
      ...(licence && licence !== 'Unknown' ? { licenses: [{ expression: licence }] } : REVIEWED_LICENCES[id] ? { licenses: [{ expression: 'MIT' }] } : {}),
      ...(integrity?.startsWith('sha512-') ? { hashes: [{ alg: 'SHA-512' as const, content: Buffer.from(integrity.slice(7), 'base64').toString('hex') }] } : {}),
    });
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${uuidFrom(sha256(`${opts.commit}:${opts.lockfile}`))}`,
    version: 1,
    metadata: {
      timestamp: opts.commitTime,
      component: { type: 'application', name: opts.product.name, version: opts.product.version, 'bom-ref': `ebmr:${opts.product.name}@${opts.product.version}` },
      properties: [{ name: 'ebmr:commit', value: opts.commit }, { name: 'ebmr:lockfile-sha256', value: sha256(opts.lockfile) }],
    },
    components,
  };
}

/** A UUID (version 5 layout) from a hex digest: the SBOM's serial number follows the commit and the lockfile. */
function uuidFrom(hex: string): string {
  const h = hex.slice(0, 32).split('');
  h[12] = '5';
  h[16] = ((parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Release manifest and signatures
// ---------------------------------------------------------------------------------------------------------------------

export const MIGRATION_DIRS: Readonly<Record<string, string>> = {
  kernel: 'packages/kernel/sql',
  'site-services': 'packages/site-services/sql',
  'recipe-core': 'packages/recipe-core/sql',
  tablets: 'apps/tablets-server/sql',
};

/** The schema release of this tree's migration files, as platform.schema_release() computes it from the ledger. */
export function schemaReleaseOfFiles(root = REPO): string {
  const rows: { namespace: string; name: string; checksum: string }[] = [];
  for (const [namespace, dir] of Object.entries(MIGRATION_DIRS)) {
    for (const name of readdirSync(join(root, dir)).filter((f) => f.endsWith('.sql')).sort()) rows.push({ namespace, name, checksum: sha256(readFileSync(join(root, dir, name))) });
  }
  return config.releaseOfLedger(rows);
}

export interface ReleaseManifest {
  kind: 'ebmr.release-manifest';
  version: 1;
  product: { name: string; version: string };
  commit: string;
  commitTime: string;
  schemaRelease: string;
  files: { path: string; sha256: string; bytes: number }[];
  signingKey: { kind: 'RELEASE_KEY' | 'DEMO-ONLY ephemeral'; spkiSha256: string };
}

export function signingKey(pem: string | undefined): { key: KeyObject; publicPem: string; kind: ReleaseManifest['signingKey']['kind'] } {
  if (pem) {
    const key = createPrivateKey(pem);
    return { key, publicPem: createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString(), kind: 'RELEASE_KEY' };
  }
  const pair = generateKeyPairSync('ed25519');
  return { key: pair.privateKey, publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), kind: 'DEMO-ONLY ephemeral' };
}

export const spkiSha256 = (publicPem: string): string => sha256(createPublicKey(publicPem).export({ type: 'spki', format: 'der' }));

export function signBytes(key: KeyObject, bytes: Buffer): string {
  return sign(null, bytes, key).toString('base64');
}

export function verifyBytes(publicPem: string, bytes: Buffer, signatureB64: string): boolean {
  return verify(null, bytes, createPublicKey(publicPem), Buffer.from(signatureB64, 'base64'));
}
