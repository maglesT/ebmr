/**
 * The migration-order check (6jc-R4; Phase 7 plan, slice 7-0): every migration a branch adds sorts after every
 * migration of its source on origin/main. The runner (packages/kernel/src/db/migrate.ts) applies the .sql files
 * directly in a source directory in `Array.prototype.sort()` order (UTF-16 code units of the file name), and an
 * installation already migrated to main never applies a file that sorts before the last one it applied in the order
 * a fresh database would. So a branch file that sorts at or below main's highest file of the same source would run
 * out of order on an upgrade, which is what happened in Phase 6.
 *
 * The branch side is the working tree (what the runner would apply, uncommitted files included); the main side is the
 * tree of origin/main as git holds it. Comparing with origin/main itself, not the merge base, also catches a branch
 * whose numbers were overtaken by a migration merged to main after the branch forked.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { ROOT } from './register.ts';

export interface MigrationListing {
  /** The source directory, relative to the repository root (e.g. packages/kernel/sql). */
  source: string;
  /** The .sql file names directly in it on the branch. */
  branch: readonly string[];
  /** The .sql file names directly in it on main. */
  main: readonly string[];
}

/** The runner's order of file names: what `Array.prototype.sort()` gives without a comparator. */
export const runnerOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One problem per branch file (not on main) that does not sort after the highest file of its source on main. */
export function migrationOrderProblems(listings: readonly MigrationListing[]): string[] {
  const problems: string[] = [];
  for (const { source, branch, main } of listings) {
    const onMain = new Set(main.filter((f) => f.endsWith('.sql')));
    const highest = [...onMain].sort(runnerOrder).at(-1);
    if (highest === undefined) continue;
    const added = branch.filter((f) => f.endsWith('.sql') && !onMain.has(f)).sort(runnerOrder);
    for (const f of added) {
      if (runnerOrder(f, highest) <= 0) problems.push(`${source}/${f} is added by the branch but sorts before ${source}/${highest}, the highest migration of ${source} on main`);
    }
  }
  return problems;
}

/** The migration source directories, as the handbook manifest lists them (docs/handbook/modules.yaml). */
export function migrationSources(root = ROOT): string[] {
  const doc = YAML.parse(readFileSync(join(root, 'docs/handbook/modules.yaml'), 'utf8')) as { migration_sources?: unknown };
  const sources = doc.migration_sources;
  if (!Array.isArray(sources) || sources.length === 0 || !sources.every((s) => typeof s === 'string')) {
    throw new Error('docs/handbook/modules.yaml: migration_sources must be a non-empty list of directories');
  }
  return sources;
}

const git = (root: string, args: string[]): { ok: boolean; out: string } => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: !r.error && r.status === 0, out: r.stdout ?? '' };
};

/** The commit of origin/main, or why there is none to compare with (no git, not a repository, ref not fetched). */
export function mainCommit(root = ROOT, ref = 'origin/main'): { commit: string } | { unavailable: string } {
  const probe = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!probe.ok) return { unavailable: `git is not available or ${root} is not a git work tree` };
  const r = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!r.ok) return { unavailable: `${ref} is not available in this checkout (fetch it: git fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main)` };
  return { commit: r.out.trim() };
}

/** The .sql file names directly in a source directory at a commit. */
export function filesAtCommit(root: string, commit: string, source: string): string[] {
  const r = git(root, ['ls-tree', '-z', '--name-only', commit, '--', `${source}/`]);
  if (!r.ok) throw new Error(`git ls-tree ${commit} ${source} failed`);
  return r.out
    .split('\0')
    .filter(Boolean)
    .map((p) => p.slice(source.length + 1))
    .filter((f) => f.endsWith('.sql') && !f.includes('/'));
}

/** The .sql file names directly in a source directory of the working tree, as the runner reads them. */
export function filesInWorkingTree(root: string, source: string): string[] {
  const dir = join(root, source);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')) : [];
}

/** The listings of every migration source: the working tree against the given commit of main. */
export function listings(root: string, commit: string, sources = migrationSources(root)): MigrationListing[] {
  return sources.map((source) => ({ source, branch: filesInWorkingTree(root, source), main: filesAtCommit(root, commit, source) }));
}
