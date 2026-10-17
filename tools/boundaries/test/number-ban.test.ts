/**
 * The analytics runner's number ban (eslint.config.js `runnerNumberBan`; ADR 0020 point 5): in
 * apps/tablets-server/src/analytics/ a value becomes a JavaScript number only through statOf in @ebmr/analytics, so
 * Number(), parseFloat, parseInt, Number.parseFloat and unary + are reported there, once each; the clock ban still
 * applies there, and other server files are not given the number ban.
 */
import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function ruleOf(file: string): Promise<unknown[]> {
  const config = (await eslint.calculateConfigForFile(file)) as Linter.Config;
  const entry = config.rules?.['no-restricted-syntax'];
  return Array.isArray(entry) ? entry : [entry];
}

function reports(rule: unknown[], code: string): string[] {
  const linter = new Linter();
  const messages = linter.verify(code, [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, rules: { 'no-restricted-syntax': rule as Linter.RuleEntry } }], 'probe.ts');
  expect(messages.filter((m) => m.fatal === true)).toEqual([]);
  return messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message);
}

const RUNNER = 'apps/tablets-server/src/analytics/runner.ts';
const OTHER = 'apps/tablets-server/src/platform/auth/device-proof.ts';
const isNumberBan = (m: string): boolean => /only through statOf/.test(m);

describe('analytics runner number ban (eslint.config.js)', () => {
  it.each([
    ['Number()', "export const v = Number('7.5');"],
    ['parseFloat', "export const v = parseFloat('7.5');"],
    ['parseInt', "export const v = parseInt('7', 10);"],
    ['Number.parseFloat', "export const v = Number.parseFloat('7.5');"],
    ['unary plus', "const t = '7.5'; export const v = +t;"],
  ])('[meta] %s is caught once in the analytics runner and not in another server file', async (_case, code) => {
    expect(reports(await ruleOf(RUNNER), code).filter(isNumberBan)).toHaveLength(1);
    expect(reports(await ruleOf(OTHER), code).filter(isNumberBan)).toHaveLength(0);
  });

  it('[meta] the clock ban still applies in the analytics runner; plain arithmetic passes', async () => {
    const rule = await ruleOf(RUNNER);
    expect(reports(rule, 'export const t = Date.now();').some((m) => /Date\.now is banned/.test(m))).toBe(true);
    expect(reports(rule, 'export const n = 3 - 1; export const m = -n;')).toEqual([]);
  });
});
