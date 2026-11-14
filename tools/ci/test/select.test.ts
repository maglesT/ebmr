/**
 * The pull-request gate's selection (decision 0032): it may run more than a change needs, never less. A path no package
 * or rule accounts for runs everything; a changed package runs with every package that depends on it or reads it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ALL_E2E_GROUPS, E2E_GROUPS } from '../../e2e/groups.ts';
import {
  e2eGroupsOf,
  globToRegExp,
  groupOfSpec,
  matches,
  readE2eRules,
  readReferences,
  readWorkspaces,
  ROOT,
  select,
  sqlFunctionsOf,
  withDependents,
  type References,
  type Workspace,
} from '../src/select.ts';

const workspaces = readWorkspaces();
const references = readReferences(workspaces);
const e2eRules = readE2eRules();
const plan = (...changed: string[]) => select({ changed, workspaces, references, e2eRules });
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const INJECTABLE_GROUPS = ALL_E2E_GROUPS.filter((g) => g.startsWith('library-inj-'));

describe('globs', () => {
  it('[meta] ** spans directories, * stays within one, ? is one character', () => {
    expect(matches('docs/**', 'docs/a/b.md')).toBe(true);
    expect(matches('**/*.md', 'README.md')).toBe(true);
    expect(matches('**/*.md', 'packages/kernel/src/esig/README.md')).toBe(true);
    expect(matches('packages/*/test/**', 'packages/kernel/test/a/b.test.ts')).toBe(true);
    expect(matches('packages/*/test/**', 'packages/kernel/src/test.ts')).toBe(false);
    expect(matches('stryker*.config.mjs', 'stryker.phase6.config.mjs')).toBe(true);
    expect(matches('phase7/route-w*.spec.ts', 'phase7/route-w-2.spec.ts')).toBe(true);
    expect(matches('phase7/route-w*.spec.ts', 'phase7/x/route-w.spec.ts')).toBe(false);
    expect(globToRegExp('a.b').test('aXb')).toBe(false);
  });
});

describe('unit and database tests', () => {
  it('[meta] a changed package runs with every package that depends on it, directly or not', () => {
    const p = plan('packages/expr/src/decimal.ts');
    expect(p.unitAll).toBe(false);
    for (const d of ['packages/expr', 'packages/recipe-core', 'packages/api-contract', 'apps/tablets-server', 'apps/tablets-web', 'packages/ui-kit']) {
      expect(p.unitPaths).toContain(`${d}/test`);
    }
    const closure = withDependents(['packages/expr'], workspaces);
    for (const w of workspaces) if (w.deps.includes('@ebmr/expr')) expect(closure.has(w.dir)).toBe(true);
  });

  it('[meta] a SQL migration of a package runs every database test of that package and of its dependents', () => {
    const p = plan('packages/recipe-core/sql/1926_plant_use_end_reason.sql');
    expect(p.unitPaths).toEqual(expect.arrayContaining(['packages/recipe-core/test', 'apps/tablets-server/test', 'apps/injectables-server/test']));
    expect(p.golden).toBe(true);
  });

  it('[meta] edition SQL runs the packages whose code names editions/ (the test databases are built from it) and their dependents', () => {
    const p = plan('editions/injectables/sql/3020_x.sql');
    expect(p.unitAll).toBe(false);
    expect(p.unitPaths).toEqual(expect.arrayContaining(['packages/test-kit/test', 'apps/tablets-server/test']));
    expect(p.golden).toBe(true);
  });

  it('[meta] a path only another package\'s tests name runs those tests, not that package\'s dependents', () => {
    const ws: Workspace[] = [
      { dir: 'packages/a', name: '@ebmr/a', deps: [] },
      { dir: 'packages/b', name: '@ebmr/b', deps: ['@ebmr/a'] },
      { dir: 'tools/reader', name: '@ebmr/reader', deps: [] },
      { dir: 'tools/user', name: '@ebmr/user', deps: ['@ebmr/reader'] },
    ];
    const refs = new Map<string, References>([
      ['packages/a', { code: new Set(), tests: new Set() }],
      ['packages/b', { code: new Set(), tests: new Set() }],
      ['tools/reader', { code: new Set(), tests: new Set(['compliance/controls']) }],
      ['tools/user', { code: new Set(['compliance/rule-tables']), tests: new Set() }],
    ]);
    const sel = (...changed: string[]) => select({ changed, workspaces: ws, references: refs, e2eRules: [] });
    expect(sel('compliance/controls/DI-20.yaml').unitPaths.length).toBe(0); // the toy packages have no test directory
    expect(sel('compliance/controls/DI-20.yaml').reasons).toContain('tools/reader: names a changed path, its tests run');
    expect(sel('compliance/controls/DI-20.yaml').reasons.some((r) => r.startsWith('tools/user'))).toBe(false);
    expect(sel('compliance/rule-tables/x.yaml').reasons).toContain('tools/user: changed, or its code names a changed path; it and its dependents run');
    expect(sel('packages/a/src/x.ts').reasons).toContain('packages/a: changed, or its code names a changed path; it and its dependents run');
  });

  it('[meta] a root configuration file, a path in no package that nothing names, or no readable change runs every test', () => {
    for (const f of ['package.json', 'pnpm-lock.yaml', 'vitest.config.ts', 'tsconfig.base.json', '.dependency-cruiser.cjs', 'patches/x.patch', '.github/workflows/ci.yml', 'tools/ci/start-postgres.sh']) {
      expect(plan(f).unitAll).toBe(true);
    }
    expect(plan('newtop/thing.txt').unitAll).toBe(true);
    // ops/ is named by the packages that build the image: theirs run, with their dependents.
    expect(plan('ops/Dockerfile').unitAll).toBe(false);
    expect(plan().unitAll).toBe(true);
    expect(plan().golden).toBe(true);
    expect(plan().e2eGroups).toEqual(ALL_E2E_GROUPS);
  });

  it('[meta] documentation alone runs no test, but the packages that read it run theirs', () => {
    const p = plan('docs/decisions/0032-faster-merge-loop.md', 'PROGRESS.md');
    expect(p.unitAll).toBe(false);
    expect(p.e2eGroups).toEqual([]);
    expect(plan('docs/reviews/x.md').golden).toBe(false);
    // The handbook reads docs/handbook: its tests run.
    expect(plan('docs/handbook/index.md').unitPaths).toContain('tools/handbook/test');
  });

  it('[meta] the register\'s controls run the tools that read them', () => {
    expect(plan('compliance/controls/DI-20.yaml').unitPaths).toContain('tools/register/test');
  });
});

describe('end-to-end groups', () => {
  it('[meta] a path no rule maps runs every group, never none', () => {
    for (const f of ['apps/tablets-server/src/app.ts', 'packages/kernel/sql/0100_x.sql', 'apps/tablets-web/src/main.tsx', 'tools/e2e/global-setup.ts', '.github/workflows/ci.yml', 'compliance/rule-tables/x.yaml', 'something/new.ts']) {
      expect(e2eGroupsOf(f, e2eRules)).toBeNull();
      expect(plan(f).e2eGroups).toEqual(ALL_E2E_GROUPS);
    }
  });

  it('[meta] a spec runs its own group; a spec no group names runs in rest', () => {
    expect(plan('tools/e2e/specs/phase7/own-product-p3.spec.ts').e2eGroups).toEqual(['own-p3']);
    expect(plan('tools/e2e/specs/library/inj-syringe.spec.ts').e2eGroups).toEqual(['library-inj-routes']);
    expect(plan('tools/e2e/specs/esig/anything.spec.ts').e2eGroups).toEqual(['rest']);
    expect(groupOfSpec('tools/e2e/specs/phase7/route-w-two.spec.ts')).toBe('route-w');
  });

  it('[meta] the injectables edition runs the injectables groups and the tablets canary', () => {
    const p = plan('editions/injectables/sql/3020_x.sql');
    expect(p.e2eGroups).toEqual(expect.arrayContaining([...INJECTABLE_GROUPS, 'gmp-batches']));
    expect(p.e2eGroups).not.toContain('own-p3');
    expect(plan('packages/recipe-core/src/library/seed/injectables-lyo.ts').e2eGroups).toEqual(expect.arrayContaining(INJECTABLE_GROUPS));
    // Another seed file is not mapped: every group.
    expect(plan('packages/recipe-core/src/library/seed/coating.ts').e2eGroups).toEqual(ALL_E2E_GROUPS);
  });

  it('[meta] unit tests, documentation and tools the stack does not import run no group', () => {
    expect(plan('packages/kernel/test/esig/x.test.ts', 'docs/a.md', 'tools/register/src/trace.ts', 'compliance/controls/DI-20.yaml').e2eGroups).toEqual([]);
  });

  it('[meta] every rule of the map names known groups and every pattern matches a tracked file', () => {
    for (const r of e2eRules) {
      expect(r.why.length).toBeGreaterThan(10);
      if (r.groups !== 'spec') for (const g of r.groups) expect(ALL_E2E_GROUPS).toContain(g);
      for (const g of r.paths) expect(tracked.some((f) => matches(g, f)), `${g} matches no tracked file`).toBe(true);
    }
  });

  it('[meta] every spec file maps to exactly one group, as playwright.config.ts selects them', () => {
    const specs = tracked.filter((f) => f.startsWith('tools/e2e/specs/') && f.endsWith('.spec.ts'));
    expect(specs.length).toBeGreaterThan(50);
    for (const s of specs) {
      const rel = s.replace('tools/e2e/specs/', '');
      const named = Object.entries(E2E_GROUPS).filter(([, globs]) => globs.some((g) => matches(`**/${g}`, rel) || matches(g, rel)));
      expect(named.length, s).toBeLessThanOrEqual(1);
      expect(groupOfSpec(s)).toBe(named[0]?.[0] ?? 'rest');
    }
    for (const globs of Object.values(E2E_GROUPS)) for (const g of globs) expect(specs.some((s) => matches(g, s.replace('tools/e2e/specs/', ''))), g).toBe(true);
  });

  it('[meta] the workflow lists no end-to-end group of its own: the plan job reads groups.ts', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).not.toMatch(/ALL: route-w/);
  });
});

describe('SQL mutation of the changed guards', () => {
  it('[meta] a changed migration selects the guard functions it defines that a mutation target holds; deleted or plain files none', () => {
    const fns = sqlFunctionsOf(['packages/recipe-core/sql/1862_library_limits_judgement.sql']);
    expect(fns).toContain('recipe.library_limits_problem');
    expect(sqlFunctionsOf(['packages/recipe-core/sql/9999_gone.sql', 'docs/a.md'])).toEqual([]);
  });
});
