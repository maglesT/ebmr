/**
 * The migration set of an earlier release (slice 7d; DI-46 clause 2, DI-48 clause 1): which migration files a database
 * of that release has applied, by namespace, name and SHA-256, so the upgrade drill can build a database at that release
 * from the files of this tree. A released migration is never edited (the runner refuses a changed checksum), so the
 * files a release had are byte-identical here; `releaseSources` refuses to build the old state when one is not.
 *
 *   node --import tsx tools/drills/src/release-manifest.ts <git ref> <out.json>
 *
 * writes the manifest of a git ref (the Phase 6A exit: bc46d55, `fixtures/release-6a-migrations.json`).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MigrationSource } from '@ebmr/kernel';

export interface ReleaseManifest {
  /** What release the set is (e.g. "Phase 6A exit"). */
  release: string;
  /** The commit the files were read from. */
  commit: string;
  files: { namespace: string; name: string; sha256: string }[];
}

const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** The migration directories of a Tablets database by the runner's namespace (test-kit editionMigrationSources). */
export const MIGRATION_DIRS: Readonly<Record<string, string>> = {
  kernel: 'packages/kernel/sql',
  'site-services': 'packages/site-services/sql',
  'recipe-core': 'packages/recipe-core/sql',
  tablets: 'apps/tablets-server/sql',
};

export const RELEASE_6A_MANIFEST = fileURLToPath(new URL('../fixtures/release-6a-migrations.json', import.meta.url));

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** The manifest of a git ref, read with `git show` (no checkout). */
export function manifestOfRef(ref: string, release: string): ReleaseManifest {
  const commit = execFileSync('git', ['rev-parse', ref], { cwd: REPO, encoding: 'utf8' }).trim();
  const files: ReleaseManifest['files'] = [];
  for (const [namespace, dir] of Object.entries(MIGRATION_DIRS)) {
    const names = execFileSync('git', ['ls-tree', '--name-only', `${commit}:${dir}`], { cwd: REPO, encoding: 'utf8' })
      .split('\n')
      .filter((n) => n.endsWith('.sql'))
      .sort();
    for (const name of names) {
      const body = execFileSync('git', ['show', `${commit}:${dir}/${name}`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
      files.push({ namespace, name, sha256: sha256(body) });
    }
  }
  return { release, commit, files };
}

export function readManifest(file = RELEASE_6A_MANIFEST): ReleaseManifest {
  return JSON.parse(readFileSync(file, 'utf8')) as ReleaseManifest;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Migration sources that apply exactly the manifest's files, from `sources` (the current tree's). Throws when a file
 * of the manifest is missing here or differs from the release's bytes: the old state would not be that release's.
 */
export function releaseSources(manifest: ReleaseManifest, sources: MigrationSource[]): MigrationSource[] {
  const byNamespace = new Map<string, string[]>();
  for (const f of manifest.files) byNamespace.set(f.namespace, [...(byNamespace.get(f.namespace) ?? []), f.name]);
  const problems: string[] = [];
  for (const f of manifest.files) {
    const source = sources.find((s) => s.namespace === f.namespace);
    if (!source) {
      problems.push(`${f.namespace}: no migration source`);
      continue;
    }
    let body: Buffer;
    try {
      body = readFileSync(join(source.directory, f.name));
    } catch {
      problems.push(`${f.namespace}/${f.name} is missing`);
      continue;
    }
    if (sha256(body) !== f.sha256) problems.push(`${f.namespace}/${f.name} differs from release ${manifest.commit.slice(0, 7)} (a released migration was edited)`);
  }
  if (problems.length > 0) throw new Error(`the migrations of ${manifest.release} cannot be rebuilt from this tree:\n  ${problems.join('\n  ')}`);
  return sources
    .filter((s) => byNamespace.has(s.namespace))
    .map((s) => ({ ...s, include: new RegExp(`^(${(byNamespace.get(s.namespace) ?? []).map(escape).join('|')})$`) }));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [ref, out] = process.argv.slice(2);
  if (!ref || !out) {
    console.error('usage: release-manifest.ts <git ref> <out.json> [release name]');
    process.exit(2);
  }
  const m = manifestOfRef(ref, process.argv[4] ?? `release at ${ref}`);
  writeFileSync(out, `${JSON.stringify(m, null, 2)}\n`);
  console.log(`${String(m.files.length)} migrations of ${m.commit} written to ${out}`);
}
