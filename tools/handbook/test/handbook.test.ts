import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runChecks } from '../src/check.ts';
import { anchors, slug } from '../src/links.ts';
import { dbObjects, definesSymbol } from '../src/sql.ts';
import { parseRoutes, pathsIn } from '../src/sources.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const YAML = [
  'migration_sources: [packages/p/sql]',
  'migration_header_from: {packages/p/sql: 2}',
  'pending: []',
  'modules:',
  '  - id: a',
  '    title: A',
  '    page: modules/a.md',
  '    package: packages/p',
  '    migrations:',
  "      packages/p/sql: ['^0001_', '^0002_']",
  '    src: [packages/p/src]',
  '',
].join('\n');

/** A small repository: one package with two migrations, one source file, a handbook with a README and a module page. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ebmr-handbook-'));
  const base: Record<string, string> = {
    'docs/handbook/README.md': '# Handbook\n\n| Page | Covers |\n|---|---|\n| [a](modules/a.md) | the package |\n',
    'docs/handbook/modules/a.md': '# Module a\n\n## Main functions\n\nSee [p.f](../../../packages/p/sql/0001_x.sql#sym=p.f).\n',
    'docs/handbook/modules.yaml': YAML,
    'packages/p/sql/0001_x.sql': '-- Creates p.f. create function p.ghost() is only a comment.\ncreate function p.f() returns int language sql as $$ select 1 $$;\n',
    'packages/p/sql/0002_y.sql': 'create table p.t (id int);\ncreate trigger aa_guard before update on p.t for each row execute function p.f();\n',
    'compliance/controls/README.txt': 'controls\n',
    'packages/p/src/x.ts': 'export function foo(): number {\n  return 1;\n}\n',
  };
  for (const [rel, text] of Object.entries({ ...base, ...files })) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

/** The fixture's problems (the generated pages are checked as they would be written; nothing is on disk). */
function problems(files: Record<string, string>): string[] {
  return runChecks(fixture(files)).problems;
}

describe('handbook generated pages', () => {
  it('[meta] the generator renders the code map and the three reference pages over the current code, none of them committed', () => {
    const { generated } = runChecks(ROOT);
    const pages = ['code-map.md', 'reference/db-catalogue.md', 'reference/control-map.md', 'reference/error-codes.md'].map((p) => `docs/handbook/${p}`);
    expect([...generated.keys()].sort()).toEqual([...pages].sort());
    for (const p of pages) expect(generated.get(p)?.length ?? 0).toBeGreaterThan(200);
    const tracked = execFileSync('git', ['ls-files', '--', ...pages], { cwd: ROOT, encoding: 'utf8' });
    expect(tracked).toBe('');
  });

  it('[meta] every migration, feature, contract file and screen folder belongs to a module, and every handbook link resolves', () => {
    expect(runChecks(ROOT).problems).toEqual([]);
  });
});

describe('handbook checker on a fixture', () => {
  it('[meta] a clean fixture passes', () => {
    expect(problems({})).toEqual([]);
  });

  it('[meta] reports an unclaimed migration by name', () => {
    const out = problems({ 'packages/p/sql/0003_new.sql': '-- Handbook: modules/a.md\nselect 1;\n' });
    expect(out).toContain('unclaimed migration: packages/p/sql/0003_new.sql (no module in modules.yaml matches it)');
  });

  it('[meta] a migration above the mark must name its handbook page', () => {
    const yaml = (h: string) => ({
      'packages/p/sql/0003_new.sql': `${h}select 1;\n`,
      'docs/handbook/modules.yaml': YAML.replace("'^0002_'", "'^0002_', '^0003_'"),
    });
    expect(problems(yaml('-- a header\n')).join('\n')).toMatch(/0003_new\.sql: a new migration names its handbook page/);
    expect(problems(yaml('-- a header\n-- Handbook: modules/a.md\n'))).toEqual([]);
  });

  it('[meta] the guides\' links are checked as the handbook\'s are (slice 7e): a broken file link and a wrong anchor are reported, right ones pass', () => {
    const ok = problems({ 'docs/guides/user-guide/README.md': '# Guide\n\n## Tasks\n\n[runbook](../../handbook/modules/a.md#main-functions) [tasks](#tasks)\n' });
    expect(ok).toEqual([]);
    const out = problems({ 'docs/guides/user-guide/README.md': '# Guide\n\n[gone](02-gone.md) [anchor](../../handbook/modules/a.md#no-such-heading)\n' });
    expect(out).toHaveLength(2);
    expect(out.join('\n')).toMatch(/docs\/guides\/user-guide\/README\.md: link 02-gone\.md: docs\/guides\/user-guide\/02-gone\.md does not exist/);
    expect(out.join('\n')).toMatch(/has no heading #no-such-heading/);
  });

  it('[meta] the link checker catches a broken file link', () => {
    const out = problems({ 'docs/handbook/modules/a.md': '# Module a\n\nSee [gone](../../../packages/p/sql/0009_gone.sql).\n' });
    expect(out.join('\n')).toMatch(/link \.\.\/\.\.\/\.\.\/packages\/p\/sql\/0009_gone\.sql: packages\/p\/sql\/0009_gone\.sql does not exist/);
  });

  it('[meta] the link checker catches a missing symbol, and a symbol named only in a comment does not count', () => {
    const out = problems({
      'docs/handbook/modules/a.md':
        '# Module a\n\n[f](../../../packages/p/sql/0001_x.sql#sym=p.f) [g](../../../packages/p/sql/0001_x.sql#sym=p.ghost) [foo](../../../packages/p/src/x.ts#sym=foo) [bar](../../../packages/p/src/x.ts#sym=bar)\n',
    });
    expect(out).toHaveLength(2);
    expect(out.join('\n')).toMatch(/does not define p\.ghost/);
    expect(out.join('\n')).toMatch(/does not define bar/);
  });

  it('[meta] a TypeScript symbol counts only as a top-level declaration, not in a comment, a string, a regular expression or a function body', () => {
    const ts = [
      '// const inComment = 1;',
      "const s = 'const inString = 1'; const re = /['\"]+$/u;",
      'export function outer(): number {',
      '  const local = 1;',
      '  return local;',
      '}',
      'export interface Shape { a: number }',
      '',
    ].join('\n');
    expect(definesSymbol('x.ts', ts, 'outer')).toBe(true);
    expect(definesSymbol('x.ts', ts, 'Shape')).toBe(true);
    expect(definesSymbol('x.ts', ts, 're')).toBe(true);
    for (const name of ['inComment', 'inString', 'local']) expect(definesSymbol('x.ts', ts, name)).toBe(false);
  });

  it('[meta] a link with a malformed percent-encoding is reported, not a crash', () => {
    const out = problems({ 'docs/handbook/modules/a.md': '# Module a\n\nSee [bad](../../../packages/p/sql/0001_x.sql#sym=%E0%A4%A).\n' });
    expect(out.join('\n')).toMatch(/malformed percent-encoding/);
  });

  it('[meta] a migration source without a header mark is reported', () => {
    const out = problems({ 'docs/handbook/modules.yaml': YAML.replace('migration_header_from: {packages/p/sql: 2}', 'migration_header_from: {}') });
    expect(out.join('\n')).toMatch(/0001_x\.sql: its source packages\/p\/sql has no migration_header_from mark/);
  });

  it('[meta] the link checker catches a wrong anchor and accepts a right one', () => {
    const out = problems({
      'docs/handbook/README.md': '# Handbook\n\n| Page | Covers |\n|---|---|\n| [a](modules/a.md) | the package |\n\n[ok](modules/a.md#main-functions) [bad](modules/a.md#main-function) [line](../../packages/p/src/x.ts#L1)\n',
    });
    expect(out).toHaveLength(2);
    expect(out.join('\n')).toMatch(/has no heading #main-function$/m);
    expect(out.join('\n')).toMatch(/line-number links drift/);
  });

  it('[meta] links inside code are not checked, and a pending page may be missing', () => {
    const yaml = YAML.replace('pending: []', 'pending: [modules/b.md]');
    const out = problems({
      'docs/handbook/modules.yaml': yaml,
      'docs/handbook/modules/a.md': '# Module a\n\n`[x](nowhere.md)`\n\n```\n[y](nowhere.md)\n```\n\n[b](b.md) [c](c.md)\n',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/docs\/handbook\/modules\/c\.md does not exist/);
  });

  it('[meta] a module page must exist and be linked from the README', () => {
    const out = problems({ 'docs/handbook/README.md': '# Handbook\n' });
    expect(out).toContain('module a: page modules/a.md is not linked from docs/handbook/README.md');
  });

  it('[meta] a package folder without a module is reported', () => {
    const out = problems({ 'packages/q/src/index.ts': 'export const q = 1;\n' });
    expect(out).toContain("packages/q has no module in modules.yaml (set some module's package to it)");
  });
});

describe('handbook parsers', () => {
  it('[meta] reads the objects a migration creates, without comments, with a trigger named on its table', () => {
    const objs = dbObjects('-- create function x.no()\ncreate or replace function s.f(a int) returns int as $$ select 1 $$;\ncreate table if not exists s.t (a int);\ncreate trigger aa_g\n  before update on s.t for each row execute function s.f();\n');
    expect(objs).toEqual([
      { kind: 'function', name: 's.f' },
      { kind: 'table', name: 's.t' },
      { kind: 'trigger', name: 'aa_g on s.t' },
    ]);
    expect(definesSymbol('a.sql', 'create function S.F() returns int;', 's.f')).toBe(true);
    expect(definesSymbol('a.ts', 'export interface Thing {}', 'Thing')).toBe(true);
  });

  it('[meta] reads the routes of a contract file', () => {
    const text = "export const x = {\n  a: defineRoute({\n    id: 'x.a',\n    method: 'GET',\n    path: '/api/x',\n  }),\n};\n";
    expect(parseRoutes('ns/x.ts', text)).toEqual([{ id: 'x.a', method: 'GET', path: '/api/x', file: 'ns/x.ts' }]);
  });

  it('[meta] reads the paths a control names, bare migration names in the folder of the path before them', () => {
    expect(pathsIn('packages/r/sql/0200_a.sql, 0210_b.sql (writers)')).toEqual(['packages/r/sql/0200_a.sql', 'packages/r/sql/0210_b.sql']);
  });

  it('[meta] makes GitHub heading slugs', () => {
    expect(slug('Main functions and guards (with `esig.sign`)')).toBe('main-functions-and-guards-with-esigsign');
    expect([...anchors('# A\n## B\n## B\n```\n# not\n```\n')]).toEqual(['a', 'b', 'b-1']);
  });
});
