/**
 * The limit module's README (src/limits/README.md) is where a reviewer reads the module's API. Round 2 of the Phase 2
 * exit review (regressions) found it still documenting `operatorMayClear`, a member review F13 had removed from
 * LimitEvaluation. This test keeps the README's references true; it proves no limit behaviour (that is
 * tiers.test.ts and all-apply.test.ts), so it carries no control tag:
 *  - every TypeScript name in a code span (camelCase, PascalCase or UPPER_SNAKE, also `Type.member`) is declared or
 *    used in the code (comments left out) of the limit module or of a module it imports;
 *  - every source file it names exists in the module, every test file in test/limits, and the test glob it gives
 *    matches the limit tests.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const LIMITS = join(ROOT, 'packages/recipe-core/src/limits');
const README = readFileSync(join(LIMITS, 'README.md'), 'utf8');

function withoutComments(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** The module's own files and every file outside the module they import (e.g. ../flow/expression-port.ts). */
function moduleFiles(): string[] {
  const own = readdirSync(LIMITS).filter((f) => f.endsWith('.ts')).map((f) => join(LIMITS, f));
  const imported = own.flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/from '(\.\.\/[^']+\.ts)'/g)].map((m) => join(dirname(f), m[1] ?? '')),
  );
  return [...new Set([...own, ...imported])];
}

const CODE = moduleFiles()
  .map((f) => withoutComments(readFileSync(f, 'utf8')))
  .join('\n');

function declared(word: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`).test(CODE);
}

/** The code spans of the README (`...`, also across a line break), fenced code blocks left out. */
function codeSpans(): string[] {
  const prose = README.replace(/```[\s\S]*?```/g, '');
  return [...prose.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? '').replace(/\s+/g, ' ').trim());
}

/** Names a reader takes for TypeScript: camelCase with a capital, PascalCase, or UPPER_SNAKE; plain words are prose. */
function typeScriptNames(span: string): string[] {
  if (/[/]/.test(span)) return [];
  return [...span.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]).filter((w) => /[A-Z]/.test(w));
}

describe('the limit module README (PR-08) names only what the module declares', () => {
  it('every TypeScript name in a code span is in the code of the limit module or a module it imports', () => {
    const names = [...new Set(codeSpans().flatMap(typeScriptNames))];
    expect(names.length, 'SETUP: the README names the API').toBeGreaterThan(15);
    for (const known of ['LimitEvaluation', 'evaluateLimits', 'TIER_REQUIREMENTS', 'compareToBound', 'REGISTRATION_RELEVANT_DEVIATION']) {
      expect(names, `SETUP: the README names ${known}`).toContain(known);
    }
    expect(names.filter((n) => !declared(n)), 'names the README gives that the code does not have').toEqual([]);
  });

  it('every source or test file it names exists, and its test glob matches the limit tests', () => {
    const spans = codeSpans();
    const named = spans.filter((s) => /^[\w.-]+\.ts$/.test(s));
    const sources = named.filter((f) => !f.endsWith('.test.ts'));
    const tests = named.filter((f) => f.endsWith('.test.ts'));
    const testDir = join(ROOT, 'packages/recipe-core/test/limits');
    expect(sources.length, 'SETUP: the README names source files').toBeGreaterThan(1);
    expect(sources.filter((f) => !existsSync(join(LIMITS, f))), 'source files the README names that do not exist').toEqual([]);
    expect(tests.filter((f) => !existsSync(join(testDir, f))), 'test files the README names that do not exist').toEqual([]);
    expect(spans, 'SETUP: the README gives the test glob').toContain('test/limits/*.test.ts');
    expect(readdirSync(testDir).filter((f) => f.endsWith('.test.ts'))).toEqual(expect.arrayContaining(['tiers.test.ts', 'all-apply.test.ts']));
  });
});
