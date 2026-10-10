/**
 * What the register says about tests (reviews F14 and F15): every test a control lists exists, statically
 * (validate) and in the run (trace); every test tagged with a control that passed is in its list (trace; sync-tests
 * adds them from the run); and a due control is proven clause by clause of its catalog test, each clause by a listed
 * test that passed or by a deferral to a phase that has not started.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROLS_DIR, loadControls, ROOT, type ControlRecord } from '../src/register.ts';
import { appendListedTests, testsToAdd } from '../src/sync.ts';
import { declaredIn, declaredTests, entryOf, fileOfEntry, names, reportedPath, type DeclaredTest } from '../src/test-index.ts';
import { buildTrace, controlTags, readPlaywrightResults, readVitestResults, writeMatrix, type TestResult } from '../src/trace.ts';
import { clauseErrors, validateRegister, words } from '../src/validate.ts';

const control = (id: string): ControlRecord => {
  const c = loadControls().find((x) => x.id === id);
  if (!c) throw new Error(`no control ${id}`);
  return c;
};

/** A passed (or other) result at the place an entry names: `<file> > <describe> > ... > <title>`. */
const result = (entry: string, status: TestResult['status'] = 'passed'): TestResult => {
  const [file = '', ...rest] = entry.split(' > ');
  return { name: rest.join(' '), status, file, path: reportedPath(file, rest.slice(0, -1), rest.at(-1) ?? ''), entry };
};

describe('listed tests exist (review F15)', () => {
  const SRC = `
    describe('outer', () => {
      describe('inner', () => {
        it('[DI-20] a literal title', () => {});
        it.each(['a', 'b'])('[DI-20] each %s title', () => {});
      });
      for (const k of ['x']) test(\`[DI-20] built \${k} here\`, () => {});
      it.skipIf(true)('[DI-20] skipped when', () => {});
    });
    test.describe('pw', () => { test('[DI-20] a spec', { tag: '@kiosk' }, async () => {}); });
    test.step('not a test', async () => {});
  `;

  it('[meta] a listed test names its file, its describes in order (each may be left out) and its title; a title built from data is a pattern', () => {
    const tests = declaredTests('x/a.test.ts', SRC);
    const hits = (entry: string): number => tests.filter((t) => names(entry, t)).length;
    expect(tests.map((t) => t.exact)).toEqual([true, false, false, true, true]);
    // A test written out in full is also known as a control lists it, and by its full name (which carries the tags).
    expect(tests.map((t) => t.entry)).toEqual(['x/a.test.ts > outer > inner > [DI-20] a literal title', null, null, 'x/a.test.ts > outer > [DI-20] skipped when', 'x/a.test.ts > pw > [DI-20] a spec']);
    expect(tests[0]?.name).toBe('outer inner [DI-20] a literal title');
    expect(tests.map((t) => t.runs)).toEqual(['always', 'always', 'always', 'conditionally', 'always']);
    expect(hits('x/a.test.ts > outer > inner > [DI-20] a literal title')).toBe(1);
    expect(hits('x/a.test.ts > inner > [DI-20] a literal title')).toBe(1);
    expect(hits('x/a.test.ts > [DI-20] a literal title')).toBe(1);
    expect(hits('x/a.test.ts > inner > outer > [DI-20] a literal title')).toBe(0);
    expect(hits('x/a.test.ts > other > [DI-20] a literal title')).toBe(0);
    expect(hits('x/a.test.ts > outer > inner > [DI-20] each b title')).toBe(1);
    expect(hits('x/a.test.ts > outer > [DI-20] built x here')).toBe(1);
    expect(hits('x/a.test.ts > outer > [DI-20] skipped when')).toBe(1);
    expect(hits('x/a.test.ts > pw > [DI-20] a spec')).toBe(1);
    expect(hits('y/a.test.ts > pw > [DI-20] a spec')).toBe(0);
    // A part built from data never swallows the separator, so a wrong describe cannot hide in it.
    expect(hits('x/a.test.ts > outer > [DI-20] built inner > x here')).toBe(0);
    expect(hits('x/a.test.ts > not a test')).toBe(0);
  });

  it('[meta] the register validator refuses a listed test whose file does not declare it, or that names no file (review F15)', () => {
    const controls = loadControls();
    const forged = controls.map((c) =>
      c.id === 'DI-20'
        ? { ...c, tests: [...c.tests, 'packages/kernel/test/identity/devices-sessions.test.ts > [DI-20] no such test', 'nowhere/none.test.ts > [DI-20] x', 'no file at all'] }
        : c,
    );
    const errors = validateRegister(forged).filter((e) => e.startsWith('DI-20: lists a test that does not exist'));
    expect(errors).toHaveLength(3);
    expect(errors.join('\n')).toContain('no such file nowhere/none.test.ts');
    expect(errors.join('\n')).toContain('not of the form');
  });

  it('[meta] the four stale entries of the review name the tests as they are now (review F15; DI-17, DI-19, DI-37, DI-10, DI-34)', () => {
    const at = (id: string, file: string): string[] => control(id).tests.filter((e) => e.startsWith(file));
    expect(at('DI-17', 'packages/kernel/test/integration/authorization.test.ts').some((e) => e.endsWith('every function of market, records, continuity, site services and the platform that the application may call and that can write checks a known permission'))).toBe(true);
    expect(at('DI-19', 'apps/tablets-server/test/access/attribution.test.ts')).toContain('apps/tablets-server/test/access/attribution.test.ts > [DI-19][INV-40] taps are limited per minute per terminal and badge (TAP_LIMIT)');
    for (const id of ['DI-10', 'DI-34']) expect(at(id, 'packages/recipe-core/test/blocks/golden.test.ts').some((e) => e.endsWith('G-01..G-20 (G-09@1 and G-10@1 sandbox only, G-09@2 and G-10@2 from site services, G-06 since slice 3a), G-21 since slice 4a, G-22..G-24'))).toBe(true);
    expect(validateRegister().filter((e) => e.includes('lists a test that does not exist'))).toEqual([]);
  });

  it('[meta] DI-20 lists every test tagged with it, the product\'s room and device tests among them (review F15)', () => {
    const listed = control('DI-20').tests;
    for (const t of [
      'apps/tablets-server/test/devices/claim.test.ts > DeviceReadingPort.claim > [DI-20] a reading from a scale in another room is refused, with an alert that survives the refused command',
      'apps/tablets-server/test/devices/ingest.test.ts > ingestion > [DI-20] a reading from an instrument not bound to this gateway is refused',
      'apps/tablets-server/test/devices/ingest.test.ts > ingestion > [DI-20] a reading with a serial that is not the registered one is refused',
      'apps/tablets-server/test/devices/routes.test.ts > capture > [DI-20] a terminal in another room cannot trigger or watch this scale',
      'tools/e2e/specs/devices/devices.spec.ts > devices > [DI-20] a kiosk in another room lists no scale of DISP-1, and the server refuses it a capture from and the live view of TEST-BAL-01',
    ]) {
      expect(listed).toContain(t);
    }
    expect(listed.length).toBeGreaterThanOrEqual(80);
  });

  it('[meta] the trace refuses a listed test the run did not report, or one that did not run; end-to-end ones only with the Playwright report (review F15)', () => {
    const base = { ...control('DI-20'), target_phase: 7 };
    const vitest = 'packages/x/test/a.test.ts > d > [DI-20] listed';
    const e2e = 'tools/e2e/specs/x/x.spec.ts > [DI-20] e2e listed';
    const c = { ...base, tests: [vitest, e2e] };
    const errs = (results: TestResult[], e2eRun = false): string[] => buildTrace([c], results, 1, { e2e: e2eRun }).errors;
    expect(errs([])).toEqual([`DI-20 lists a test the run did not report: "${vitest}"`]);
    expect(errs([result(vitest, 'skipped')])).toEqual([`DI-20 lists a test that did not run (skipped): "${vitest}"`]);
    expect(errs([result(vitest)])).toEqual([]);
    // Another test of the same title elsewhere is not the listed one (and, tagged and passing, must be listed itself).
    expect(errs([result('packages/x/test/b.test.ts > d > [DI-20] listed')])).toEqual([
      `DI-20 lists a test the run did not report: "${vitest}"`,
      'DI-20 does not list a test tagged with it that passed (register sync-tests adds it): "packages/x/test/b.test.ts > d > [DI-20] listed"',
    ]);
    expect(errs([result(vitest)], true)).toEqual([`DI-20 lists a test the run did not report: "${e2e}"`]);
    expect(errs([result(vitest), result(e2e)], true)).toEqual([]);
  });

  it('[meta] Vitest and Playwright results carry the place a control lists them by (review F15)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-trace-'));
    writeFileSync(
      join(dir, 'vitest.json'),
      JSON.stringify({ testResults: [{ name: join(process.cwd(), 'packages/x/test/a.test.ts'), assertionResults: [{ fullName: 'd [DI-20] t', title: '[DI-20] t', ancestorTitles: ['d'], status: 'passed' }] }] }),
    );
    writeFileSync(
      join(dir, 'playwright.json'),
      JSON.stringify({
        config: { rootDir: join(process.cwd(), 'tools/e2e/specs') },
        suites: [{ title: 'x/x.spec.ts', file: 'x/x.spec.ts', suites: [{ title: 'outer', specs: [{ title: '[DI-20] s', file: 'x/x.spec.ts', tests: [{ projectName: 'kiosk', results: [{ status: 'passed' }] }] }] }] }],
      }),
    );
    const [v] = readVitestResults(join(dir, 'vitest.json'));
    const [p] = readPlaywrightResults(join(dir, 'playwright.json'));
    expect(v?.path && names('packages/x/test/a.test.ts > d > [DI-20] t', v.path)).toBe(true);
    expect(p?.path && names('tools/e2e/specs/x/x.spec.ts > outer > [DI-20] s', p.path)).toBe(true);
    expect(p?.path && names('tools/e2e/specs/x/x.spec.ts > [DI-20] s', p.path)).toBe(true);
  });
});

/** The test files of the Vitest projects and the end-to-end specs (vitest.config.ts, tools/e2e/playwright.config.ts). */
function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const d of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${d.name}`;
      if (d.isDirectory()) {
        if (d.name !== 'node_modules' && d.name !== 'fixtures') walk(rel);
      } else if (/\.(test|spec)\.tsx?$/.test(d.name)) out.push(rel);
    }
  };
  for (const top of ['packages', 'apps', 'tools']) {
    for (const d of readdirSync(join(ROOT, top), { withFileTypes: true })) {
      if (d.isDirectory() && existsSync(join(ROOT, top, d.name, 'test'))) walk(`${top}/${d.name}/test`);
    }
  }
  walk('tools/e2e/specs');
  return out.sort();
}

describe('every passing tagged test is listed (review F15, round 2)', () => {
  const C = 'packages/x/test/a.test.ts';
  const listed = `${C} > d > [DI-20] listed`;
  const base: ControlRecord = { ...control('DI-20'), target_phase: 7, tests: [listed] };
  delete base.clauses;
  const unlisted = (entry: string): string => `DI-20 does not list a test tagged with it that passed (register sync-tests adds it): "${entry}"`;

  it('[meta] the trace refuses a passing test tagged with a control that the control does not list, titles built from data and end-to-end tests included', () => {
    const errs = (results: TestResult[], c: ControlRecord = base): string[] => buildTrace([c], results, 1, { e2e: true }).errors;
    expect(errs([result(listed)])).toEqual([]);
    // A tagged test the list does not name, whether its title is literal or built from data (golden.test.ts).
    expect(errs([result(listed), result(`${C} > d > [DI-20] another`)])).toEqual([unlisted(`${C} > d > [DI-20] another`)]);
    expect(errs([result(listed), result(`${C} > G-07@1 > [DI-20] built from data`)])).toEqual([unlisted(`${C} > G-07@1 > [DI-20] built from data`)]);
    // The tag may be on a describe around it: the test's full name carries it.
    const inDescribe: TestResult = { name: 'devices [DI-20] rooms a scale elsewhere', status: 'passed', file: C, path: reportedPath(C, ['devices [DI-20] rooms'], 'a scale elsewhere'), entry: `${C} > devices [DI-20] rooms > a scale elsewhere` };
    expect(errs([result(listed), inDescribe])).toEqual([unlisted(`${C} > devices [DI-20] rooms > a scale elsewhere`)]);
    // Listed under a shorter name (a describe left out), it is listed.
    expect(errs([result(listed), inDescribe], { ...base, tests: [listed, `${C} > a scale elsewhere`] })).toEqual([]);
    // Only passing tests: a skipped one need not be listed, a failing one fails the trace anyway.
    expect(errs([result(listed), result(`${C} > d > [DI-20] skipped`, 'skipped')])).toEqual([]);
    expect(errs([result(listed), result(`${C} > d > [DI-20] failing`, 'failed')])).toEqual([`DI-20 has failing tests: d [DI-20] failing`]);
    // Each control the test is tagged with lists it; a control not due yet too.
    const other: ControlRecord = { ...control('DI-41'), target_phase: 9, tests: [] };
    delete other.clauses;
    expect(buildTrace([base, other], [result(listed), result(`${C} > d > [DI-20][DI-41] both`)], 1).errors).toEqual([
      unlisted(`${C} > d > [DI-20][DI-41] both`),
      'DI-41 does not list a test tagged with it that passed (register sync-tests adds it): "packages/x/test/a.test.ts > d > [DI-20][DI-41] both"',
    ]);
    // An end-to-end test from the Playwright report, once per project.
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-trace-'));
    writeFileSync(
      join(dir, 'playwright.json'),
      JSON.stringify({
        config: { rootDir: join(ROOT, 'tools/e2e/specs') },
        suites: [{ title: 'x/x.spec.ts', file: 'x/x.spec.ts', suites: [{ title: 'outer', specs: [{ title: '[DI-20] s', file: 'x/x.spec.ts', tests: [{ projectName: 'kiosk', results: [{ status: 'passed' }] }, { projectName: 'office', results: [{ status: 'passed' }] }] }] }] }],
      }),
    );
    expect(errs([result(listed), ...readPlaywrightResults(join(dir, 'playwright.json'))])).toEqual([unlisted('tools/e2e/specs/x/x.spec.ts > outer > [DI-20] s')]);
  });

  it('[meta] sync-tests adds every passing tagged test a list lacks after the entries already there, in file order, and nothing that did not pass', () => {
    const results = [
      result('packages/y/test/b.test.ts > [DI-20] second file'),
      result(`${C} > d > [DI-20] first`),
      result(listed),
      result(`${C} > d > [DI-20] skipped`, 'skipped'),
      result(`${C} > d > [DI-20] failing`, 'failed'),
      result(`${C} > d > [DI-41] other control`),
      result(`${C} > d > [DI-20] then`),
      result(`${C} > d > [DI-20] then`),
      result(`${C} > [DI-99] unknown control`),
    ];
    const di41: ControlRecord = { ...control('DI-41'), tests: [] };
    const add = testsToAdd([base, di41], results);
    expect([...add]).toEqual([
      ['DI-20', [`${C} > d > [DI-20] first`, `${C} > d > [DI-20] then`, 'packages/y/test/b.test.ts > [DI-20] second file']],
      ['DI-41', [`${C} > d > [DI-41] other control`]],
    ]);
    // Written into the YAML, after the listed entries and in their style; an empty list becomes a block list.
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-sync-'));
    // DI-20 as `base` (one listed test), DI-41 with an empty list.
    for (const [id, tests] of [['DI-20', `tests:\n  - "${listed}"\n`], ['DI-41', 'tests: []\n']] as const) {
      copyFileSync(join(CONTROLS_DIR, `${id}.yaml`), join(dir, `${id}.yaml`));
      writeFileSync(join(dir, `${id}.yaml`), readFileSync(join(dir, `${id}.yaml`), 'utf8').replace(/^tests:\n(?: {2}- .*\n)+/m, tests));
    }
    const before = loadControls(dir);
    expect(appendListedTests(add, dir)).toBe(4);
    const after = loadControls(dir);
    expect(after[0]?.tests).toEqual([...(before[0]?.tests ?? []), ...(add.get('DI-20') ?? [])]);
    expect(after[1]?.tests).toEqual([`${C} > d > [DI-41] other control`]);
    expect(readFileSync(join(dir, 'DI-41.yaml'), 'utf8')).toContain(`tests:\n  - "${C} > d > [DI-41] other control"\n`);
    // Everything else in the file is as it was.
    expect({ ...after[0], tests: [] }).toEqual({ ...before[0], tests: [] });
    // Once listed, the trace is satisfied and a second sync adds nothing.
    const synced = after.map((c) => ({ ...c, target_phase: 7 }));
    expect(buildTrace(synced, results.filter((r) => !r.name.includes('[DI-99]') && r.status !== 'failed'), 1).errors).toEqual([]);
    expect([...testsToAdd(after, results)]).toEqual([]);
  });

  it('[meta] every control lists each test tagged with it that a test file declares in full and that may run (one that may skip itself at run time included); titles built from data are the trace\'s to check', () => {
    const controls = new Map(loadControls().map((c) => [c.id, c]));
    const missing: string[] = [];
    let tagged = 0;
    for (const file of testFiles()) {
      const declared: DeclaredTest[] = declaredTests(file, readFileSync(join(ROOT, file), 'utf8'));
      for (const t of declared) {
        if (!t.exact || t.runs === 'never' || t.name === null) continue;
        for (const id of controlTags(t.name)) {
          const c = controls.get(id);
          if (!c) continue;
          tagged++;
          if (!c.tests.some((e) => names(e, t))) missing.push(`${id}: ${t.entry ?? ''}`);
        }
      }
    }
    expect(tagged).toBeGreaterThan(2500);
    expect(missing).toEqual([]);
    // The ones the review counted: DI-37, IN-52 and DI-14 list every test tagged with them, not a third.
    for (const [id, n] of [['DI-37', 190], ['IN-52', 200], ['DI-14', 135]] as const) expect(control(id).tests.length, id).toBeGreaterThanOrEqual(n);
  });

  it('[meta] the trace with --require-playwright fails without end-to-end results (the CI job that has both reports)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-cli-'));
    writeFileSync(join(dir, 'vitest.json'), JSON.stringify({ testResults: [] }));
    const cli = (...extra: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'tools/register/src/cli.ts'), 'trace', '--results', join(dir, 'vitest.json'), ...extra], { cwd: ROOT, encoding: 'utf8' });
    const missing = cli('--playwright', join(dir, 'none.json'), '--require-playwright');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`--require-playwright: no end-to-end results in ${join(dir, 'none.json')}`);
    writeFileSync(join(dir, 'empty.json'), JSON.stringify({ suites: [] }));
    expect(cli('--playwright', join(dir, 'empty.json'), '--require-playwright').stderr).toContain('--require-playwright: no end-to-end results in');
  });

  it('[meta] a listed test is named as a run reports it: file, every describe, title', () => {
    expect(entryOf('a/b.test.ts', ['x', 'y'], '[DI-20] t')).toBe('a/b.test.ts > x > y > [DI-20] t');
    expect(entryOf('a/b.test.ts', [], '[DI-20] t')).toBe('a/b.test.ts > [DI-20] t');
  });
});

describe('a listed test that skips itself at run time (review F15, round 3)', () => {
  // Tests that are skipped while the run goes on: the trace must neither refuse them listed when they are skipped nor
  // let them go unlisted when they pass (that is the deadlock the round-2 verifier found for DI-47 on 29 February).
  const F = 'x/s.test.ts';
  const SRC = `
    const needs = (ctx: TestContext, step: string): void => ctx.skip(!done.has(step), step);
    function deeper(c: TestContext): void { needs(c, 'x'); }
    const names = (c: TestContext): string => c.task.name;
    describe('d', () => {
      it('[DI-47] the context skips it', async (ctx) => { if (leap) ctx.skip(); });
      it('[DI-47] a destructured skip', async ({ skip }) => { if (leap) skip(); });
      it('[DI-47] a renamed destructured skip', async ({ skip: pass }) => { pass(leap); });
      it('[DI-47] a helper it hands its context to', async (ctx) => { needs(ctx, 'a'); });
      it('[DI-47] a helper of a helper', async (t) => { deeper(t); });
      it('[DI-47] skip destructured in the body', async (ctx) => { const { skip } = ctx; skip(); });
      it('[DI-47] the context used for something else', async (ctx) => { expect(names(ctx)).toBeTruthy(); queue.skip(); });
      it.each([{ skip: 1 }])('[DI-47] an each row with a skip $skip', ({ skip }) => { expect(skip).toBe(1); });
      it.skip('[DI-47] skipped outright', (ctx) => { ctx.skip(); });
      it.todo('[DI-47] todo');
    });
    describe('hooked', () => {
      beforeEach((ctx) => { if (leap) ctx.skip(); });
      it('[DI-47] under a beforeEach that skips', () => {});
    });
    describe.skip('outright', () => { it('[DI-47] in a skipped describe', (ctx) => { ctx.skip(); }); });
    test.describe('pw', () => {
      test('[DI-20] testInfo skips it', async ({ page }, testInfo) => { testInfo.skip(cond, 'why'); });
      test('[DI-20] a test.skip annotation in its body', async ({ page }) => { test.skip(cond, 'why'); });
      test.fixme('[DI-20] fixme outright', async () => {});
    });
    test.describe('pw group', () => {
      test.skip(({ browserName }) => browserName === 'webkit', 'why');
      test('[DI-20] in a group with a skip annotation', async () => {});
    });
  `;
  const declared = (file: string): DeclaredTest[] | null => (file === F ? declaredTests(F, SRC) : null);

  it('[meta] a test that may skip itself at run time runs conditionally: its context\'s skip, directly, destructured or in a function of the file it hands the context to; a beforeEach that skips; Playwright\'s testInfo.skip and test.skip annotations', () => {
    const runs = Object.fromEntries((declared(F) ?? []).map((t) => [String(t.entry), t.runs] as const));
    expect(runs).toEqual({
      [`${F} > d > [DI-47] the context skips it`]: 'conditionally',
      [`${F} > d > [DI-47] a destructured skip`]: 'conditionally',
      [`${F} > d > [DI-47] a renamed destructured skip`]: 'conditionally',
      [`${F} > d > [DI-47] a helper it hands its context to`]: 'conditionally',
      [`${F} > d > [DI-47] a helper of a helper`]: 'conditionally',
      [`${F} > d > [DI-47] skip destructured in the body`]: 'conditionally',
      [`${F} > d > [DI-47] the context used for something else`]: 'always',
      // An .each test's parameters are its row, not the context; its title is built from data.
      null: 'always',
      [`${F} > d > [DI-47] skipped outright`]: 'never',
      [`${F} > d > [DI-47] todo`]: 'never',
      [`${F} > hooked > [DI-47] under a beforeEach that skips`]: 'conditionally',
      [`${F} > outright > [DI-47] in a skipped describe`]: 'never',
      [`${F} > pw > [DI-20] testInfo skips it`]: 'conditionally',
      [`${F} > pw > [DI-20] a test.skip annotation in its body`]: 'conditionally',
      [`${F} > pw > [DI-20] fixme outright`]: 'never',
      [`${F} > pw group > [DI-20] in a group with a skip annotation`]: 'conditionally',
    });
    // A Playwright annotation is not a test.
    expect(declared(F)).toHaveLength(16);
    // The tests of the review: DI-47 on 29 February, DI-13 without TLS, the platform hook when it is not installed,
    // the restore-event steps of a partial run.
    const real = (file: string, title: string): string | undefined =>
      declaredTests(file, readFileSync(join(ROOT, file), 'utf8')).find((t) => t.entry?.endsWith(title))?.runs;
    expect(real('packages/kernel/test/mutation/retention-and-purge.test.ts', '[DI-47][INV-22] on its retain-until date a record is still kept (EBMR-REC-031); from the next site day it may be disposed of')).toBe('conditionally');
    expect(real('packages/kernel/test/continuity/security-baseline.test.ts', '[DI-13] an encrypted session passes the server-side check (when the database server offers TLS)')).toBe('conditionally');
    expect(real('packages/kernel/test/continuity/security-baseline.test.ts', '[DI-13] a non-TLS database session is refused by the server-side check')).toBe('always');
    expect(real('packages/kernel/test/esig/platform-hook.test.ts', '[DI-37][INV-04] a signature applied in an earlier state of the record never authorises a transition out of a later one')).toBe('conditionally');
    expect(real('packages/kernel/test/mutation/protected-numbers.test.ts', '[DI-45][INV-27] completion refuses malformed high-water marks and a margin that is not positive (EBMR-CONT-022)')).toBe('conditionally');
    expect(real('packages/kernel/test/mutation/protected-numbers.test.ts', '[DI-45][INV-08][INV-27] a restore event that does not exist is never approved, approvable or completable')).toBe('always');
  });

  it('[meta] the trace accepts a listed test reported skipped only when its source lets it be skipped at run time, and a skipped test proves no clause', () => {
    const at = (title: string): string => `${F} > d > ${title}`;
    const skips = at('[DI-47] the context skips it');
    const always = at('[DI-47] the context used for something else');
    const outright = at('[DI-47] skipped outright');
    const c: ControlRecord = { ...control('DI-47'), target_phase: 7, tests: [skips, always, outright] };
    delete c.clauses;
    const errs = (results: TestResult[], k: ControlRecord = c, phase = 1): string[] => buildTrace([k], results, phase, { declared }).errors;
    const did = (entry: string): string => `DI-47 lists a test that did not run (skipped): "${entry}"`;
    // Skipped as its source allows: accepted (and reported as skipped); an always-running test or one skipped
    // outright: refused, as before.
    expect(errs([result(skips, 'skipped'), result(always), result(outright, 'skipped')])).toEqual([did(outright)]);
    expect(buildTrace([c], [result(skips, 'skipped'), result(always), result(outright, 'skipped')], 1, { declared }).skipped).toEqual([`DI-47: ${skips}`]);
    expect(errs([result(skips), result(always, 'skipped'), result(outright, 'skipped')])).toEqual([did(always), did(outright)]);
    // Without the source (a file that is not there), a skipped listed test is refused.
    expect(buildTrace([c], [result(skips, 'skipped'), result(always)], 1, { declared: () => null }).errors).toEqual([did(skips), `DI-47 lists a test the run did not report: "${outright}"`]);
    // A skipped test is no proof: a due control whose clause names only it fails while it is skipped.
    const due: ControlRecord = { ...c, target_phase: 1, tests: [skips, always], clauses: [{ clause: c.catalog_test, tests: [skips] }] };
    expect(errs([result(skips, 'skipped'), result(always)], due)).toEqual([`DI-47 clause 1 has no passing test and no deferral: "${c.catalog_test}"`]);
    expect(errs([result(skips), result(always)], due)).toEqual([]);
    // Passing, it must still be listed.
    expect(errs([result(skips), result(always)], { ...c, tests: [always] })).toEqual([
      `DI-47 does not list a test tagged with it that passed (register sync-tests adds it): "${skips}"`,
    ]);
  });

  it('[meta] no listed test that may skip itself at run time blocks the trace: each control passes with all of them skipped (DI-47 on 29 February, DI-13 without TLS, DI-37, DI-45)', () => {
    const controls = loadControls();
    const fromSource = declaredIn(ROOT);
    const conditional = (entry: string): boolean => (fromSource(fileOfEntry(entry)) ?? []).some((d) => d.runs === 'conditionally' && names(entry, d));
    const listed = controls.flatMap((c) => c.tests.filter(conditional).map((e) => `${c.id}: ${e}`));
    expect(listed).toEqual(
      expect.arrayContaining([
        'DI-47: packages/kernel/test/mutation/retention-and-purge.test.ts > INV-22 retain-until boundary > [DI-47][INV-22] on its retain-until date a record is still kept (EBMR-REC-031); from the next site day it may be disposed of',
        'DI-13: packages/kernel/test/continuity/security-baseline.test.ts > [DI-13] an encrypted session passes the server-side check (when the database server offers TLS)',
        'DI-37: packages/kernel/test/esig/platform-hook.test.ts > platform SIGNATURE hook adapter > [DI-37][INV-04] a signature applied in an earlier state of the record never authorises a transition out of a later one',
      ]),
    );
    expect(listed.length).toBeGreaterThanOrEqual(13);
    for (const c of controls.filter((k) => k.tests.some(conditional))) {
      // Only this control is in the register here, so the results carry no other control's tag.
      const other = new RegExp(`\\[(?!${c.id}\\])(?:DI|PR|ST|IN)-\\d{2}\\]`, 'g');
      const results = c.tests.map((t) => {
        const r = result(t, conditional(t) ? 'skipped' : 'passed');
        return { ...r, name: r.name.replace(other, '') };
      });
      for (const phase of [1, 2]) {
        const report = buildTrace([c], results, phase, { e2e: true });
        expect(report.errors, `${c.id} at phase ${phase}`).toEqual([]);
        expect(report.skipped, `${c.id} at phase ${phase}`).toEqual(c.tests.filter(conditional).map((e) => `${c.id}: ${e}`));
      }
    }
  });
});

describe('catalog-test clauses (review F14)', () => {
  it('[meta] the clauses of a control are its catalog test word for word; a deferral comes after the target phase; a control with a deferred part stays SPECIFIED', () => {
    const pr01 = control('PR-01');
    const clauses = pr01.clauses ?? [];
    expect(clauseErrors(pr01)).toEqual([]);
    expect(clauseErrors({ ...pr01, clauses: clauses.slice(0, 1) }).join()).toContain('word for word');
    expect(clauseErrors({ ...pr01, clauses: [{ ...clauses[0], clause: 'Creating a batch at any size is refused.' }, ...clauses.slice(1)] }).join()).toContain('word for word');
    expect(clauseErrors({ ...pr01, clauses: [clauses[0] ?? { clause: '' }, { clause: clauses[1]?.clause ?? '', deferred: { phase: 2, reason: 'not later at all' } }] }).join()).toContain('not after the control\'s target phase 2');
    expect(clauseErrors({ ...pr01, build_status: 'IMPLEMENTED' }).join()).toContain('build_status IMPLEMENTED while 1 part(s)');
    expect(clauseErrors({ ...pr01, clauses: [{ clause: clauses[0]?.clause ?? '', tests: ['not/listed.test.ts > x'] }, clauses[1] ?? { clause: '' }] }).join()).toContain('names a test that is not in its tests list');
    const di33 = control('DI-33');
    expect(clauseErrors({ ...di33, deferred_scope: [{ scope: 'reprocessing and recovery', phase: 2, reason: 'not later at all' }] }).join()).toContain('not after the control\'s target phase 2');
  });

  it('[meta] one passing test that carries the tag is no longer proof: a due control fails on a clause with no passing test and no deferral (review F14)', () => {
    const pr01 = control('PR-01');
    const [first, second] = pr01.clauses ?? [];
    const batchSize = first?.tests?.[0] ?? '';
    // Only PR-01 is in this register, so the results carry no other control's tag.
    const own = (r: TestResult): TestResult => ({ ...r, name: r.name.replace(/\[(?!PR-01\])[A-Z]+-\d{2}\]/g, '') });
    const passing = [result(batchSize), ...pr01.tests.filter((t) => t !== batchSize).map((t) => result(t))].map(own);
    // With the packaging clause deferred to phase 3, PR-01 passes the phase 2 gate on its batch-size tests...
    expect(buildTrace([pr01], passing, 2).errors).toEqual([]);
    // ... and fails the phase 3 gate until that clause is tested.
    expect(buildTrace([pr01], passing, 3).errors).toEqual([`PR-01 clause 2 is deferred to phase 3, which has started: "${second?.clause ?? ''}"`]);
    // A clause that names tests needs one of them to pass, whatever else passes with the tag.
    const untested = { ...pr01, clauses: [first ?? { clause: '' }, { clause: second?.clause ?? '', tests: [pr01.tests[2] ?? ''] }] };
    const only = passing.filter((r) => r.path && !names(pr01.tests[2] ?? '', r.path));
    expect(buildTrace([untested], [...only, result('packages/z.test.ts > [PR-01] anything')], 2).errors).toEqual([
      `PR-01 lists a test the run did not report: "${pr01.tests[2] ?? ''}"`,
      'PR-01 does not list a test tagged with it that passed (register sync-tests adds it): "packages/z.test.ts > [PR-01] anything"',
      `PR-01 clause 2 has no passing test and no deferral: "${second?.clause ?? ''}"`,
    ]);
    // A due control that maps no clause fails; the review's reproducer: one arbitrary tagged test.
    const unmapped: ControlRecord = { ...pr01, tests: ['x/y.test.ts > [PR-01] anything'] };
    delete unmapped.clauses;
    expect(buildTrace([unmapped], [result('x/y.test.ts > [PR-01] anything')], 2).errors).toEqual([
      'PR-01 (target phase 2) does not map its catalog test to clauses with tests or deferrals',
    ]);
  });

  it('[meta] every control due by phase 2 maps each catalog-test clause to listed tests or a deferral to a later phase; the six of the review record theirs (review F14)', () => {
    const due = loadControls().filter((c) => c.target_phase <= 2 && c.expert_decision.status !== 'DONT_FOLLOW');
    expect(due.length).toBeGreaterThanOrEqual(36);
    for (const c of due) {
      expect(c.clauses, c.id).toBeDefined();
      expect(words((c.clauses ?? []).map((k) => k.clause).join(' ')), c.id).toBe(words(c.catalog_test));
      for (const k of c.clauses ?? []) expect(k.deferred ? k.deferred.phase > 2 : (k.tests?.length ?? 0) > 0, `${c.id}: ${k.clause}`).toBe(true);
    }
    const deferredTo = (id: string, part: string): number | undefined => control(id).clauses?.find((k) => k.clause.includes(part))?.deferred?.phase;
    expect(deferredTo('PR-01', 'packaging order')).toBe(3);
    expect(deferredTo('DI-34', 'disposition before review')).toBe(4);
    expect(deferredTo('PR-08', 'release screen')).toBe(4);
    expect(deferredTo('DI-04', 'PLC')).toBe(3);
    expect(deferredTo('PR-07', 'Three deviations')).toBe(4);
    expect(control('DI-33').deferred_scope?.find((d) => /reprocessing/i.test(d.scope))?.phase).toBe(3);
  });

  it('[meta] the matrix prints each control\'s build status and each clause with its state, and the scope deferred beyond the catalog test (review F14)', () => {
    const controls = loadControls().filter((c) => ['PR-01', 'DI-33'].includes(c.id));
    const report = buildTrace(controls, controls.flatMap((c) => c.tests.map((t) => result(t))), 2);
    const file = join(mkdtempSync(join(tmpdir(), 'ebmr-matrix-')), 'm.md');
    writeMatrix(report, 2, file);
    const md = readFileSync(file, 'utf8');
    expect(md).toMatch(/^\| PR-01 \| Master record scope and keying \| tablets, injectables \| 2 \| PENDING \| SPECIFIED \| \d+ \| 1 tested, 1 deferred \|$/m);
    expect(md).toContain('| PR-01 | 2. A packaging order for a pack type with no approved packaging master is refused. | DEFERRED to phase 3 | phase 3: No packaging master');
    expect(md).toMatch(/\| PR-01 \| 1\. Creating a batch at a size that no approved master lists is refused\. \| TESTED \| 2 of 2 listed tests passed \|/);
    expect(md).toMatch(/\| DI-33 \| Reprocessing and recovery[^|]*\| 3 \|/);
    expect(md).toMatch(/^\| DI-33 \| Calculations and reprocessing \|.*\| SPECIFIED \| \d+ \| 2 tested; 1 scope deferred \|$/m);
  });
});
