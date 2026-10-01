/**
 * The ESLint clock ban (eslint.config.js `clockBan`, ADR 0006/0007): outside the named clock modules, tools, tests and
 * simulators, no code reads the process clock through Date. Date.now passed by reference reads it too: ProofTickets took
 * `Date.now` as its default clock and the ban, which matched only a call, let it through (final verifier, follow-up
 * round 4). Date() called without new, Date.call, a copy of Date, `const { now } = Date` and Date reached through
 * globalThis read it as well, and the ban did not see them (round-1 verifier of clock-and-tag): Date is now allowed only
 * where it cannot read the clock. The selectors are run on probes with the rule as the repository's configuration
 * computes it for each file; each form is reported once, by the selector named.
 */
import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const eslint = new ESLint({ cwd: root });

/** The no-restricted-syntax entry the repository's configuration gives a file, normalised to an array. */
async function clockRule(file: string): Promise<unknown[]> {
  const config = (await eslint.calculateConfigForFile(file)) as Linter.Config;
  const entry = config.rules?.['no-restricted-syntax'];
  return Array.isArray(entry) ? entry : [entry];
}

const isOff = (rule: unknown[]): boolean => rule[0] === 0 || rule[0] === 'off';

/** The clock-ban reports for a probe under that rule; a probe that does not parse fails the test. */
function reports(rule: unknown[], code: string): string[] {
  const linter = new Linter();
  const messages = linter.verify(code, [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, rules: { 'no-restricted-syntax': rule as Linter.RuleEntry } }], 'probe.ts');
  expect(messages.filter((m) => m.fatal === true)).toEqual([]);
  return messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message);
}

const SERVER_FILE = 'apps/tablets-server/src/platform/auth/device-proof.ts';

/** Which selector of the ban a report comes from, by its message. */
function selectorOf(message: string): string {
  if (/Date\.now is banned/.test(message)) return 'now';
  if (/argument-less new Date\(\)/.test(message)) return 'new';
  if (/Date is only constructed with a value/.test(message)) return 'value';
  if (/Reach Date by its own name/.test(message)) return 'member';
  return message;
}

describe('clock ban (eslint.config.js)', () => {
  it.each([
    ['a default clock', 'export class Tickets { constructor(private readonly now: () => number = Date.now) {} }', ['now']],
    ['a clock assigned', 'export const now: () => number = Date.now;', ['now']],
    ['a callback', 'export const times = [1, 2].map(Date.now);', ['now']],
    ['a bound copy (Date passed to bind is reported too)', 'export const now = Date.now.bind(Date);', ['now', 'value']],
    ['a call', 'export const t = Date.now();', ['now']],
    ['an optional call', 'export const t = Date?.now();', ['now']],
    ['a computed member', "export const t = Date['now']();", ['now']],
  ])('[meta] Date.now is caught once in domain code: %s', async (_case, code, expected) => {
    const found = reports(await clockRule(SERVER_FILE), code);
    expect(found.map(selectorOf)).toEqual(expected);
  });

  it.each([
    ['Date() without new', 'export const s = Date();', 'value'],
    ['Date() without new, with an argument it ignores', 'export const s = Date(0);', 'value'],
    ['an optional call of Date', 'export const s = Date?.();', 'value'],
    ['Date.call', 'export const s = Date.call(null);', 'value'],
    ['a destructured now', 'export const { now } = Date;', 'value'],
    ['a destructured now, renamed', 'export const { now: read } = Date;', 'value'],
    ['a destructuring assignment', 'export let read: () => number = () => 0; ({ now: read } = Date);', 'value'],
    ['a destructuring parameter default', 'export function at({ now } = Date): number { return now(); }', 'value'],
    ['a copy of Date', 'const D = Date; export const t = D.now();', 'value'],
    ['Date passed as a value', 'export const d = Reflect.construct(Date, []);', 'value'],
    ['a subclass of Date', 'export class Clock extends Date {}', 'value'],
    ['Date destructured from globalThis', 'export const { Date: D } = globalThis;', 'value'],
    ['Date destructured from globalThis, shorthand', 'export const { Date } = globalThis;', 'value'],
    ['globalThis.Date.now', 'export const t = globalThis.Date.now();', 'member'],
    ["globalThis['Date']", "export const t = globalThis['Date'].now();", 'member'],
    ['new globalThis.Date()', 'export const d = new globalThis.Date();', 'member'],
    ['globalThis.Date()', 'export const s = globalThis.Date();', 'member'],
    ['Date through a copy of globalThis', 'const g = globalThis; export const t = g.Date.now();', 'member'],
    ['new Date() without arguments', 'export const d = new Date();', 'new'],
    ['new Date without parentheses', 'export const d = new Date;', 'new'],
    ['new Date() with spread arguments', 'export const d = new Date(...([] as []));', 'new'],
  ])('[meta] Date is caught once in domain code where it can read the clock: %s', async (_case, code, expected) => {
    const found = reports(await clockRule(SERVER_FILE), code);
    expect(found.map(selectorOf)).toEqual([expected]);
  });

  it('[meta] Date where it cannot read the clock, and other now(), are not caught', async () => {
    const rule = await clockRule(SERVER_FILE);
    const allowed = [
      'export const d = new Date(0);',
      "export const e = new Date('2026-10-01T00:00:00Z');",
      "export const ms = Date.parse('2026-10-01T00:00:00Z');",
      'export const utc = Date.UTC(2026, 9, 1);',
      'export const iso = Date.prototype.toISOString;',
      'export const isDate = (x: unknown): x is Date => x instanceof Date;',
      'export interface Stamp { at: Date; all: Date[]; byId: Map<string, Date>; Date: string }',
      'export type Reader = typeof Date.now;',
      'export type Ctor = typeof Date;',
      'export const labels = { Date: 1 };',
      'export class Row { Date = 1; Dated(): Date { return new Date(1); } }',
      'export const p = performance.now();',
      'declare const clock: { now(): number }; export const c = clock.now();',
      'declare const Dates: { now(): number }; export const n = Dates.now;',
    ].join('\n');
    expect(reports(rule, allowed)).toEqual([]);
  });

  it('[meta] the ban is on in the apps and packages and off only in the clock modules, tools, tests and simulators', async () => {
    const on = [
      SERVER_FILE,
      'apps/tablets-server/src/platform/auth/change-tickets.ts',
      'apps/tablets-web/src/main.tsx',
      'apps/site-gateway/src/index.ts',
      'packages/recipe-core/src/engine/engine.ts',
    ];
    for (const file of on) expect(isOff(await clockRule(file)), file).toBe(false);
    const off = [
      'apps/tablets-server/src/platform/clock.ts',
      'apps/tablets-web/src/app/clock.ts',
      'apps/site-gateway/src/clock.ts',
      'packages/kernel/src/time/index.ts',
      'apps/tablets-server/test/session/device-nonce-limit.test.ts',
      'tools/register/src/cli.ts',
      'apps/simulators/src/index.ts',
    ];
    for (const file of off) expect(isOff(await clockRule(file)), file).toBe(true);
  });
});
