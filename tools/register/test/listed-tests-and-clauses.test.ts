/**
 * What the register says about tests (reviews F14 and F15): every test a control lists exists, statically
 * (validate) and in the run (trace); and a due control is proven clause by clause of its catalog test, each clause
 * by a listed test that passed or by a deferral to a phase that has not started.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadControls, type ControlRecord } from '../src/register.ts';
import { declaredTests, names, reportedPath } from '../src/test-index.ts';
import { buildTrace, readPlaywrightResults, readVitestResults, writeMatrix, type TestResult } from '../src/trace.ts';
import { clauseErrors, validateRegister, words } from '../src/validate.ts';

const control = (id: string): ControlRecord => {
  const c = loadControls().find((x) => x.id === id);
  if (!c) throw new Error(`no control ${id}`);
  return c;
};

/** A passed (or other) result at the place an entry names: `<file> > <describe> > ... > <title>`. */
const result = (entry: string, status: TestResult['status'] = 'passed'): TestResult => {
  const [file = '', ...rest] = entry.split(' > ');
  return { name: rest.join(' '), status, file, path: reportedPath(file, rest.slice(0, -1), rest.at(-1) ?? '') };
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
    for (const id of ['DI-10', 'DI-34']) expect(at(id, 'packages/recipe-core/test/blocks/golden.test.ts').some((e) => e.endsWith('G-01..G-05, G-07..G-20 (G-09@1 and G-10@1 sandbox only), G-22..G-24'))).toBe(true);
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
    // Another test of the same title elsewhere is not the listed one.
    expect(errs([result('packages/x/test/b.test.ts > d > [DI-20] listed')])).toHaveLength(1);
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
      `PR-01 clause 2 has no passing test and no deferral: "${second?.clause ?? ''}"`,
    ]);
    // A due control that maps no clause fails; the review's reproducer: one arbitrary tagged test.
    const unmapped: ControlRecord = { ...pr01, tests: [] };
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
