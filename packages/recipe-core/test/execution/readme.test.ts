/**
 * The execution store's README (src/execution/README.md) is where a reviewer reads what the database enforces and
 * which test proves it (round-1 verification item docs-accuracy: the README had fallen behind the migrations). This
 * test keeps its references true; the behaviour it describes is proved by the tests it lists, not here:
 *  - every migration it cites (`sql 0299`, `sql 0280, 0299`, `tablets sql 0300`) exists;
 *  - every SQL name it gives in a code span (`check_hold_point_changes`, `zz_execution_system_facts`,
 *    `iam.auth_event_use`) is defined or used by a migration, and every TypeScript name (`touchedAggregates`,
 *    `proposedDecision`) by the source or a migration;
 *  - every EBMR-EXE code it cites is raised somewhere, and every code the execution migrations and the store raise
 *    falls in a row of its code table;
 *  - every source file or document it names by a relative path (`verify.ts`, `../lifecycle`) exists;
 *  - every test file it names exists, and it names every test file of the store's own test directories
 *    (packages/recipe-core/test/execution and apps/tablets-server/test/execution).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const README = readFileSync(join(ROOT, 'packages/recipe-core/src/execution/README.md'), 'utf8');

const DIRS = {
  recipeSql: join(ROOT, 'packages/recipe-core/sql'),
  tabletsSql: join(ROOT, 'apps/tablets-server/sql'),
  kernelSql: join(ROOT, 'packages/kernel/sql'),
  siteSql: join(ROOT, 'packages/site-services/sql'),
  recipeSrc: join(ROOT, 'packages/recipe-core/src'),
  serverSrc: join(ROOT, 'apps/tablets-server/src'),
  recipeTests: join(ROOT, 'packages/recipe-core/test'),
  serverTests: join(ROOT, 'apps/tablets-server/test'),
};

/** Files under `dir` (recursively) whose name ends with `suffix`, as paths relative to `dir`. */
function filesIn(dir: string, suffix: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith(suffix) && !f.includes('node_modules'));
}

function corpus(dirs: string[], suffix: string): string {
  return dirs.flatMap((d) => filesIn(d, suffix).map((f) => readFileSync(join(d, f), 'utf8'))).join('\n');
}

const SQL = corpus([DIRS.recipeSql, DIRS.tabletsSql, DIRS.kernelSql, DIRS.siteSql], '.sql');
const SOURCE = corpus([DIRS.recipeSrc, DIRS.serverSrc], '.ts');

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentions(text: string, word: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${escape(word)}(?![A-Za-z0-9_])`).test(text);
}

/** The code spans of the README (`...`, also across a line break), fenced code blocks left out. */
function codeSpans(): string[] {
  const prose = README.replace(/```[\s\S]*?```/g, '');
  return [...prose.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? '').replace(/\s+/g, ' ').trim());
}

/** The migrations the README cites: "sql 0280, 0299", "sql/0210", "tablets sql 0300"; a range "0200-0249" is skipped. */
function citedMigrations(): { recipe: Set<string>; tablets: Set<string> } {
  const out = { recipe: new Set<string>(), tablets: new Set<string>() };
  for (const m of README.matchAll(/\b(tablets )?sql[ /]((?:\d{4}(?:-\d{4})?)(?:(?:, and |, | and )\d{4}(?:-\d{4})?)*)/g)) {
    const into = m[1] ? out.tablets : out.recipe;
    for (const n of (m[2] ?? '').split(/, and |, | and /)) if (!n.includes('-')) into.add(n);
  }
  return out;
}

/** The rows of the README's table of EBMR-EXE codes: "| 040-049 | ... |" as [low, high]. */
function codeTable(): Array<[number, number]> {
  return [...README.matchAll(/^\| (\d{3})-(\d{3}) \|/gm)].map((m) => [Number(m[1]), Number(m[2])]);
}

function codesIn(text: string): Set<string> {
  return new Set([...text.matchAll(/EBMR-EXE-(\d{3})/g)].map((m) => m[1] ?? ''));
}

describe('the execution store README points only at what exists and lists every test of the store', () => {
  it('every migration it cites exists', () => {
    const { recipe, tablets } = citedMigrations();
    expect(recipe.size, 'SETUP: the README cites recipe-core migrations').toBeGreaterThan(10);
    expect(tablets.size, 'SETUP: the README cites tablets migrations').toBeGreaterThan(0);
    const recipeFiles = filesIn(DIRS.recipeSql, '.sql');
    const tabletsFiles = filesIn(DIRS.tabletsSql, '.sql');
    expect([...recipe].filter((n) => !recipeFiles.some((f) => f.startsWith(`${n}_`))), 'recipe-core migrations cited but missing').toEqual([]);
    expect([...tablets].filter((n) => !tabletsFiles.some((f) => f.startsWith(`${n}_`))), 'tablets migrations cited but missing').toEqual([]);
  });

  it('every SQL name in a code span is in a migration, and every TypeScript name is in the source or a migration', () => {
    const spans = codeSpans();
    const sqlNames = spans
      .map((s) => /^((?:[a-z]+\.)?[a-z][a-z0-9]*_[a-z0-9_]*)(?:\([^)]*\))?$/.exec(s)?.[1])
      .filter((s): s is string => s !== undefined);
    const tsNames = spans.map((s) => /^([A-Za-z][a-z0-9]*[A-Z][A-Za-z0-9]*)$/.exec(s)?.[1]).filter((s): s is string => s !== undefined);
    expect(sqlNames.length, 'SETUP: the README names SQL functions, tables and triggers').toBeGreaterThan(40);
    expect(tsNames.length, 'SETUP: the README names TypeScript functions and members').toBeGreaterThan(5);
    expect([...new Set(sqlNames)].filter((n) => !mentions(SQL, n)), 'SQL names no migration has').toEqual([]);
    expect([...new Set(tsNames)].filter((n) => !mentions(SOURCE, n) && !mentions(SQL, n)), 'TypeScript names neither the source nor a migration has').toEqual([]);
  });

  it('every file or directory it names by a relative path exists', () => {
    const here = join(ROOT, 'packages/recipe-core/src/execution');
    const paths = codeSpans().filter((s) => /^(\.\.\/[\w./-]+|[\w./-]+\.(ts|md))$/.test(s) && !s.endsWith('.test.ts'));
    expect(paths.length, 'SETUP: the README names source files and documents').toBeGreaterThan(4);
    const found = (p: string) => [here, join(here, '..'), ROOT].some((base) => existsSync(join(base, p)));
    expect(paths.filter((p) => !found(p)), 'paths the README names that do not exist').toEqual([]);
  });

  it('every EBMR-EXE code it cites is raised somewhere, and every code the store raises has a row in its code table', () => {
    const raisedByStore = new Set([
      ...codesIn(corpus([DIRS.recipeSql, DIRS.tabletsSql], '.sql')),
      ...codesIn(corpus([join(DIRS.recipeSrc, 'execution'), join(DIRS.serverSrc, 'features/execution')], '.ts')),
    ]);
    const everywhere = new Set([...codesIn(SQL), ...codesIn(SOURCE)]);
    const cited = codesIn(README);
    const rows = codeTable();
    expect(rows.length, 'SETUP: the README has its table of codes').toBeGreaterThan(5);
    expect([...cited].filter((c) => !everywhere.has(c)), 'codes the README cites that nothing raises').toEqual([]);
    expect([...raisedByStore].filter((c) => !rows.some(([lo, hi]) => Number(c) >= lo && Number(c) <= hi)), 'codes without a row in the table').toEqual([]);
  });

  it('every test file it names exists, and it names every test file of the store\'s test directories', () => {
    const named = codeSpans().filter((s) => /^[\w./-]+\.test\.ts$/.test(s));
    const all = [
      ...filesIn(DIRS.recipeTests, '.test.ts').map((f) => join('packages/recipe-core/test', f)),
      ...filesIn(DIRS.serverTests, '.test.ts').map((f) => join('apps/tablets-server/test', f)),
    ];
    expect(named.length, 'SETUP: the README lists tests').toBeGreaterThan(20);
    expect(named.filter((n) => !all.some((f) => f.endsWith(`/${n}`))), 'test files the README names that do not exist').toEqual([]);
    const own = [
      ...filesIn(join(DIRS.recipeTests, 'execution'), '.test.ts'),
      ...filesIn(join(DIRS.serverTests, 'execution'), '.test.ts'),
    ].map((f) => basename(f));
    const namedBase = new Set(named.map((n) => basename(n)));
    expect(own.filter((f) => !namedBase.has(f)).sort(), 'test files of the store that the README does not list').toEqual([]);
  });
});
