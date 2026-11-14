/**
 * What a pull request's gate runs (owner decision 0032, the faster merge loop): the tests of the changed packages and
 * of every package that depends on them or reads their files, the golden batches when the tablets server's tests are
 * among them, the end-to-end groups tools/ci/e2e-map.json maps the changed paths to (a path it does not map runs every
 * group), and the SQL mutation run of the guard functions the change defines. Any doubt selects more, never less: a
 * changed path that belongs to no package and that no rule names runs every test.
 *
 * The full run (a push to main, the nightly schedule, a run by hand without e2e_groups) runs everything; this module
 * is used only on a pull request.
 *
 * Usage: tsx tools/ci/src/select.ts --base <sha> --head <sha> [--github-output <file>]
 *        tsx tools/ci/src/select.ts --files <file with one path per line>
 * Prints the plan as JSON; with --github-output also writes the job outputs ci.yml reads.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ALL_E2E_GROUPS, E2E_GROUPS } from '../../e2e/groups.ts';
import { findFunctions } from '../../sql-mutation/src/sql-scan.ts';
import { TARGETS } from '../../sql-mutation/src/targets.ts';

export const ROOT = resolve(new URL('../../../', import.meta.url).pathname);

/** A workspace package: its directory (e.g. packages/kernel), its name and its internal dependencies. */
export interface Workspace {
  dir: string;
  name: string;
  deps: string[];
}

export interface E2eRule {
  why: string;
  paths: string[];
  groups: string[] | 'spec';
}

export interface Plan {
  /** True when every Vitest test runs (a root file, or a path no package or rule accounts for). */
  unitAll: boolean;
  /** The test directories to run when unitAll is false (e.g. packages/kernel/test). */
  unitPaths: string[];
  golden: boolean;
  e2eGroups: string[];
  /** Guard functions (schema.name) the change defines that a mutation target holds. */
  sqlFunctions: string[];
  /** Why each selection was made, one line per reason (printed in the job log). */
  reasons: string[];
}

/** Files whose change can alter any test (root configuration, the CI workflow, the runner scripts): every test. */
const ROOT_CONFIG = /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|vitest[^/]*\.ts|eslint\.config\.js|\.nvmrc|\.npmrc|\.dependency-cruiser\.cjs|patches\/.*|\.github\/workflows\/ci\.yml|tools\/ci\/[^/]+\.sh)$/;
/** Paths that hold no code any test executes, unless a package's files name them (then that package's tests run). */
const NO_UNIT_TEST = /(^docs\/|\.md$|^LICENSE$|^\.claude\/|^\.graphifyignore$|^\.editorconfig$|^\.gitignore$|^\.dockerignore$)/;
/** A path a package's source or tests name: a top directory and, when given, its first segment. */
const PATH_REFERENCE = /(?<![A-Za-z0-9_.-])(packages|apps|editions|tools|compliance|docs|ops|\.github)\/([A-Za-z0-9_.-]*)/g;
const under = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);
const SCANNED = /\.(ts|tsx|js|mjs|cjs|json|yaml|yml|sh)$/;

/** A glob as a regular expression: ** any run of characters (with /), * any run without /, ? one character. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? '';
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        out += '(?:.*/)?';
      } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export const matches = (glob: string, path: string): boolean => globToRegExp(glob).test(path);

export function readWorkspaces(root: string = ROOT): Workspace[] {
  const out: Workspace[] = [];
  for (const top of ['packages', 'apps', 'tools']) {
    for (const d of readdirSync(join(root, top))) {
      const file = join(root, top, d, 'package.json');
      if (!existsSync(file)) continue;
      const p = JSON.parse(readFileSync(file, 'utf8')) as { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = Object.keys({ ...p.dependencies, ...p.devDependencies }).filter((k) => k.startsWith('@ebmr/'));
      out.push({ dir: `${top}/${d}`, name: p.name, deps });
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

function* filesUnder(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === 'fixtures-out') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* filesUnder(p);
    else if (SCANNED.test(e)) yield p;
  }
}

/** The paths outside a package that its files name: `code` from what it ships or runs, `tests` from its tests only. */
export interface References {
  code: Set<string>;
  tests: Set<string>;
}

/**
 * Per package, the paths outside it that its files name (comments included, so any doubt counts): test-kit building
 * the databases from editions/, a test reading another package's SQL, the register reading compliance/, the handbook
 * reading packages/. A change under a path a package's code names counts as a change of that package (its dependents
 * run too); under a path only its tests name, its own tests run.
 */
export function readReferences(workspaces: readonly Workspace[], root: string = ROOT): Map<string, References> {
  const refs = new Map<string, References>();
  for (const w of workspaces) {
    const r: References = { code: new Set(), tests: new Set() };
    for (const e of readdirSync(join(root, w.dir))) {
      const p = join(root, w.dir, e);
      if (statSync(p).isDirectory()) {
        if (e === 'node_modules') continue;
        for (const f of filesUnder(p)) addReferences(readFileSync(f, 'utf8'), e === 'test' ? r.tests : r.code);
      } else if (SCANNED.test(e)) addReferences(readFileSync(p, 'utf8'), r.code);
    }
    for (const set of [r.code, r.tests]) for (const x of [...set]) if (under(x, w.dir) || under(w.dir, x)) set.delete(x);
    refs.set(w.dir, r);
  }
  return refs;
}

export function addReferences(text: string, into: Set<string>): void {
  for (const m of text.matchAll(PATH_REFERENCE)) {
    const top = m[1] ?? '';
    const first = (m[2] ?? '').replace(/\.+$/, '');
    into.add(first === '' ? top : `${top}/${first}`);
  }
}

/** The packages that depend on any of `dirs`, directly or not, with `dirs` themselves. */
export function withDependents(dirs: Iterable<string>, workspaces: readonly Workspace[]): Set<string> {
  const byName = new Map(workspaces.map((w) => [w.name, w]));
  const out = new Set(dirs);
  for (let grew = true; grew; ) {
    grew = false;
    for (const w of workspaces) {
      if (out.has(w.dir)) continue;
      if (w.deps.some((d) => { const dep = byName.get(d); return dep !== undefined && out.has(dep.dir); })) {
        out.add(w.dir);
        grew = true;
      }
    }
  }
  return out;
}

/** The group a spec file under tools/e2e/specs runs in. */
export function groupOfSpec(path: string): string {
  const rel = path.replace(/^tools\/e2e\/specs\//, '');
  for (const [group, globs] of Object.entries(E2E_GROUPS)) if (globs.some((g) => matches(`**/${g}`, rel) || matches(g, rel))) return group;
  return 'rest';
}

/** The end-to-end groups of one changed path; null when no rule maps it (then every group runs). */
export function e2eGroupsOf(path: string, rules: readonly E2eRule[]): Set<string> | null {
  let hit = false;
  const out = new Set<string>();
  for (const r of rules) {
    if (!r.paths.some((g) => matches(g, path))) continue;
    hit = true;
    if (r.groups === 'spec') out.add(groupOfSpec(path));
    else for (const g of r.groups) out.add(g);
  }
  return hit ? out : null;
}

export function readE2eRules(root: string = ROOT): E2eRule[] {
  return (JSON.parse(readFileSync(join(root, 'tools/ci/e2e-map.json'), 'utf8')) as { rules: E2eRule[] }).rules;
}

/** The guard functions a changed SQL file defines that a SQL mutation target holds (deleted files define none). */
export function sqlFunctionsOf(paths: readonly string[], root: string = ROOT): string[] {
  const targeted = new Set(TARGETS.flatMap((t) => t.functions));
  const out = new Set<string>();
  for (const p of paths) {
    if (!p.endsWith('.sql') || !existsSync(join(root, p))) continue;
    for (const f of findFunctions(readFileSync(join(root, p), 'utf8'), p)) if (targeted.has(f.name)) out.add(f.name);
  }
  return [...out].sort();
}

export interface SelectInput {
  changed: readonly string[];
  workspaces: readonly Workspace[];
  references: ReadonlyMap<string, References>;
  e2eRules: readonly E2eRule[];
  /** The functions of the changed SQL files a mutation target holds (sqlFunctionsOf). */
  sqlFunctions?: readonly string[];
}

export function select(input: SelectInput): Plan {
  const reasons: string[] = [];
  let unitAll = false;
  const changedPkgs = new Set<string>();
  const readers = new Set<string>();
  const e2e = new Set<string>();
  let e2eAll = false;

  if (input.changed.length === 0) {
    reasons.push('no changed files could be read: everything runs');
    return { unitAll: true, unitPaths: [], golden: true, e2eGroups: [...ALL_E2E_GROUPS], sqlFunctions: [...(input.sqlFunctions ?? [])], reasons };
  }
  for (const path of input.changed) {
    const owner = input.workspaces.find((w) => under(path, w.dir));
    const named = (pick: (r: References) => Set<string>): string[] =>
      [...input.references].filter(([, r]) => [...pick(r)].some((x) => under(path, x))).map(([dir]) => dir);
    const codeReaders = named((r) => r.code);
    const testReaders = named((r) => r.tests);
    const readBy = [...codeReaders, ...testReaders];
    for (const d of codeReaders) changedPkgs.add(d);
    for (const d of testReaders) readers.add(d);
    // A package's own Markdown (a README, a module note) is documentation: its own tests run (they may read it), and the
    // packages that name it; not its dependents.
    if (ROOT_CONFIG.test(path)) {
      unitAll = true;
      reasons.push(`${path}: configuration every test runs under, every test runs`);
    } else if (owner) {
      if (path.endsWith('.md') && !/(^|\/)test\//.test(path)) readers.add(owner.dir);
      else changedPkgs.add(owner.dir);
    } else if (readBy.length === 0 && !NO_UNIT_TEST.test(path)) {
      unitAll = true;
      reasons.push(`${path}: in no package and named by none, every test runs`);
    }

    const groups = e2eGroupsOf(path, input.e2eRules);
    if (groups === null) {
      if (!e2eAll) reasons.push(`${path}: no rule of tools/ci/e2e-map.json maps it, every end-to-end group runs`);
      e2eAll = true;
    } else for (const g of groups) e2e.add(g);
  }

  const withDeps = withDependents(changedPkgs, input.workspaces);
  for (const d of [...changedPkgs].sort()) reasons.push(`${d}: changed, or its code names a changed path; it and its dependents run`);
  for (const d of [...readers].sort()) if (!withDeps.has(d)) reasons.push(`${d}: names a changed path, its tests run`);
  const selected = new Set([...withDeps, ...readers]);
  const unitPaths = unitAll ? [] : [...selected].sort().filter((d) => existsSync(join(ROOT, d, 'test'))).map((d) => `${d}/test`);
  const golden = unitAll || selected.has('apps/tablets-server');
  if (golden) reasons.push('the tablets server is among the tested packages: the golden batches run');
  const e2eGroups = e2eAll ? [...ALL_E2E_GROUPS] : ALL_E2E_GROUPS.filter((g) => e2e.has(g));
  return { unitAll, unitPaths, golden, e2eGroups, sqlFunctions: [...(input.sqlFunctions ?? [])], reasons };
}

/** The files a pull request changes: the diff from the merge base of base and head (a merge of main adds none). */
export function changedFiles(base: string, head: string, root: string = ROOT): string[] {
  const out = execFileSync('git', ['diff', '--name-only', '--no-renames', `${base}...${head}`], { cwd: root, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function main(args: string[]): void {
  const option = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const filesArg = option('--files');
  const base = option('--base');
  const head = option('--head');
  let changed: string[] = [];
  try {
    if (filesArg) changed = readFileSync(filesArg, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    else if (base && head) changed = changedFiles(base, head);
  } catch (e) {
    console.error(`could not read the changed files (${String(e)}): everything runs`);
    changed = [];
  }
  const workspaces = readWorkspaces();
  const plan = select({ changed, workspaces, references: readReferences(workspaces), e2eRules: readE2eRules(), sqlFunctions: sqlFunctionsOf(changed) });
  console.log(`${changed.length} changed file(s)`);
  for (const r of plan.reasons) console.log(`  - ${r}`);
  console.log(JSON.stringify({ ...plan, reasons: undefined }, null, 2));
  const out = option('--github-output');
  if (out) {
    appendFileSync(out, [
      `unit_all=${plan.unitAll}`,
      `unit_paths=${plan.unitPaths.join(' ')}`,
      `golden=${plan.golden}`,
      `groups=${JSON.stringify(plan.e2eGroups)}`,
      `sql_functions=${plan.sqlFunctions.join(',')}`,
      '',
    ].join('\n'));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main(process.argv.slice(2));
