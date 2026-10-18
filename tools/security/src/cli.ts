/**
 * Security verification commands (slice 7d; docs/security/pentest-checklist.md). Exit 0 PASS, 1 FAIL, 2 usage.
 *
 *   node --import tsx tools/security/src/cli.ts hardening [--database-url URL] [--env-file FILE] [--allow-ports 443,5432]
 *        [--break-glass postgres] [--out DIR]
 *   node --import tsx tools/security/src/cli.ts licences [--out DIR]
 *   node --import tsx tools/security/src/cli.ts secrets [--out DIR]
 *   node --import tsx tools/security/src/cli.ts release --out DIR [--key-file FILE]     (SBOM, manifest, signatures)
 *   node --import tsx tools/security/src/cli.ts verify --dir DIR                         (the signatures of a release)
 *
 * `release` signs with the release key (--key-file, or EBMR_RELEASE_SIGNING_KEY holding the PEM): a KMS or HSM key at
 * deployment. Without one it makes a DEMO-ONLY key for the run and says so in the manifest; its public key is written
 * beside the signatures, so the signatures prove the files are the ones signed, not who signed them.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PERSONAS } from '@ebmr/test-kit';
import { renderHardeningMarkdown, runHardeningCheck } from './hardening.ts';
import { buildSbom, licenceFindings, pnpmLicences, REPO, scanRepository, schemaReleaseOfFiles, signBytes, signingKey, spkiSha256, verifyBytes, type ReleaseManifest } from './supply-chain.ts';

function envFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m?.[1]) out[m[1]] = (m[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const execHash = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const git = (...args: string[]): string => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();

function write(dir: string | undefined, name: string, text: string): void {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      'database-url': { type: 'string' },
      'env-file': { type: 'string' },
      'allow-ports': { type: 'string' },
      'break-glass': { type: 'string' },
      out: { type: 'string' },
      dir: { type: 'string' },
      'key-file': { type: 'string' },
    },
  });
  if (command === 'hardening') {
    const report = await runHardeningCheck({
      ...(values['database-url'] ? { databaseUrl: values['database-url'] } : {}),
      serverEnv: values['env-file'] ? envFile(values['env-file']) : {},
      allowedPorts: (values['allow-ports'] ?? '').split(',').filter((x) => x !== '').map(Number),
      breakGlassRoles: (values['break-glass'] ?? 'postgres').split(','),
      demoLoginNames: PERSONAS.map((p) => p.loginName),
    });
    for (const c of report.checks) console.log(`${c.status.padEnd(14)} ${c.id.padEnd(13)} ${c.evidence}`);
    console.log(`hardening check: ${report.result}`);
    write(values.out, 'hardening.json', `${JSON.stringify(report, null, 2)}\n`);
    write(values.out, 'hardening.md', renderHardeningMarkdown(report));
    return report.result === 'PASS' ? 0 : 1;
  }
  if (command === 'licences') {
    const findings = licenceFindings(pnpmLicences(false), pnpmLicences(true));
    const denied = findings.filter((f) => f.status === 'DENIED');
    const counts = findings.reduce<Record<string, number>>((m, f) => ({ ...m, [f.status]: (m[f.status] ?? 0) + 1 }), {});
    console.log(`licences: ${Object.entries(counts).map(([k, v]) => `${k} ${String(v)}`).join(', ')}`);
    for (const f of findings.filter((x) => x.status === 'REVIEWED' || x.status === 'DENIED')) console.log(`  ${f.status} ${f.package} (${f.licence}${f.production ? ', production' : ''})${f.note ? `: ${f.note}` : ''}`);
    write(values.out, 'licences.json', `${JSON.stringify(findings, null, 2)}\n`);
    return denied.length === 0 ? 0 : 1;
  }
  if (command === 'secrets') {
    const hits = scanRepository();
    const open = hits.filter((h) => h.allowed === null);
    console.log(`secret scan: ${String(hits.length)} hits, ${String(hits.length - open.length)} allowlisted, ${String(open.length)} open`);
    for (const h of open) console.log(`  ${h.pattern} ${h.path}:${String(h.line)}`);
    write(values.out, 'secrets.json', `${JSON.stringify(hits, null, 2)}\n`);
    return open.length === 0 ? 0 : 1;
  }
  if (command === 'release') {
    const out = values.out;
    if (!out) throw new Error('--out is required');
    const commit = git('rev-parse', 'HEAD');
    const commitTime = git('show', '-s', '--format=%cI', 'HEAD');
    const product = { name: 'Batchwright Tablets', version: (JSON.parse(readFileSync(join(REPO, 'apps/tablets-server/package.json'), 'utf8')) as { version: string }).version };
    const lockfile = readFileSync(join(REPO, 'pnpm-lock.yaml'), 'utf8');
    const sbom = `${JSON.stringify(buildSbom({ lockfile, licences: pnpmLicences(false), production: pnpmLicences(true), commit, commitTime, product }), null, 2)}\n`;
    write(out, 'sbom.cdx.json', sbom);
    const pem = values['key-file'] ? readFileSync(values['key-file'], 'utf8') : process.env['EBMR_RELEASE_SIGNING_KEY'];
    const key = signingKey(pem && pem.trim() !== '' ? pem : undefined);
    const fileEntry = (path: string, bytes: Buffer) => ({ path, sha256: execHash(bytes), bytes: bytes.length });
    const manifest: ReleaseManifest = {
      kind: 'ebmr.release-manifest',
      version: 1,
      product,
      commit,
      commitTime,
      schemaRelease: schemaReleaseOfFiles(),
      files: [fileEntry('sbom.cdx.json', Buffer.from(sbom)), fileEntry('pnpm-lock.yaml', Buffer.from(lockfile))],
      signingKey: { kind: key.kind, spkiSha256: spkiSha256(key.publicPem) },
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    write(out, 'release-manifest.json', manifestText);
    write(out, 'release-manifest.json.sig', `${signBytes(key.key, Buffer.from(manifestText))}\n`);
    write(out, 'sbom.cdx.json.sig', `${signBytes(key.key, Buffer.from(sbom))}\n`);
    write(out, 'release-signing-key.pub.pem', key.publicPem);
    console.log(`release ${commit.slice(0, 12)} schema release ${manifest.schemaRelease.slice(0, 16)}: SBOM with ${String((JSON.parse(sbom) as { components: unknown[] }).components.length)} components, signed (${key.kind}) into ${out}`);
    return 0;
  }
  if (command === 'verify') {
    const dir = values.dir;
    if (!dir) throw new Error('--dir is required');
    const pub = readFileSync(join(dir, 'release-signing-key.pub.pem'), 'utf8');
    const manifestText = readFileSync(join(dir, 'release-manifest.json'));
    const manifest = JSON.parse(manifestText.toString('utf8')) as ReleaseManifest;
    const problems: string[] = [];
    if (!verifyBytes(pub, manifestText, readFileSync(join(dir, 'release-manifest.json.sig'), 'utf8').trim())) problems.push('the manifest signature does not verify');
    if (!verifyBytes(pub, readFileSync(join(dir, 'sbom.cdx.json')), readFileSync(join(dir, 'sbom.cdx.json.sig'), 'utf8').trim())) problems.push('the SBOM signature does not verify');
    if (spkiSha256(pub) !== manifest.signingKey.spkiSha256) problems.push('the public key is not the one the manifest names');
    const sbomEntry = manifest.files.find((f) => f.path === 'sbom.cdx.json');
    if (sbomEntry?.sha256 !== execHash(readFileSync(join(dir, 'sbom.cdx.json')))) problems.push('the SBOM is not the one the manifest names');
    console.log(problems.length === 0 ? `release ${manifest.commit.slice(0, 12)} verified (${manifest.signingKey.kind} key ${manifest.signingKey.spkiSha256.slice(0, 16)})` : problems.join('\n'));
    return problems.length === 0 ? 0 : 1;
  }
  throw new Error(`unknown command ${command ?? '(none)'}: hardening | licences | secrets | release | verify`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  },
);
