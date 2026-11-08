import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { controlTypes, coveredRows, parseCatalog, parseFields } from '../src/catalog-parser.ts';
import { checkPins } from '../src/pins.ts';
import { idsInText } from '../src/phases.ts';
import { gateEditions, loadControls, loadRequirements, type ControlRecord } from '../src/register.ts';
import { reportedPath } from '../src/test-index.ts';
import { buildTrace, deferralStarted, readPlaywrightResults, type TestResult } from '../src/trace.ts';
import { validateRegister } from '../src/validate.ts';

describe('catalog parser', () => {
  it('[meta] reads the three label styles used by the catalogs', () => {
    const a = parseFields(['**Covers:** n1, n2', '**Type:** ENFORCED.', '**Behaviour:**', '- does a thing']);
    const b = parseFields(['- Covers: n3', '- Type: CONFIGURABLE', '- Behaviour: text']);
    const d = parseFields(['- **Covers:** n4', '- **Edition:** tablets. **Type:** DESIGN-CHOICE', '- **Behaviour:** (x) text']);
    expect(coveredRows(a['Covers'])).toEqual([1, 2]);
    expect(controlTypes(b['Type'])).toEqual(['CONFIGURABLE']);
    expect(d['Edition']).toBe('tablets');
    expect(controlTypes(d['Type'])).toEqual(['DESIGN_CHOICE']);
  });

  it('[meta] keeps a qualifier written in brackets before the colon', () => {
    const f = parseFields(['- **Behaviour (EU profile, default):**', '  - any positive fails']);
    expect(f['Behaviour']).toContain('(EU profile, default)');
    expect(f['Behaviour']).toContain('any positive fails');
  });

  it('[meta] splits controls by heading and records the group', () => {
    const md = '## Theme 1: People\n\n### ST-07: Role check\n- **Covers:** n5\n- **Type:** ENFORCED\n- **Behaviour:** checks\n\n---\n';
    const [c] = parseCatalog(md, 'C');
    expect(c?.id).toBe('ST-07');
    expect(c?.group).toBe('Theme 1: People');
  });

  it('[meta] expands ID ranges written in the outline', () => {
    const ids = idsInText('DI-12 to DI-14, PR-01 to PR-02, ST-01..ST-03 and IN-52');
    expect([...ids].sort()).toEqual(['DI-12', 'DI-13', 'DI-14', 'IN-52', 'PR-01', 'PR-02', 'ST-01', 'ST-02', 'ST-03']);
  });
});

describe('control register', () => {
  it('[meta] is valid: 265 controls (the drafts IN-53, DI-51, DI-52, DI-53 and PR-61 and the API edition controls AS-01 to AS-10, AS-14 to AS-21 and AS-24 included), schema, references to requirement rows', () => {
    expect(validateRegister()).toEqual([]);
    expect(loadControls()).toHaveLength(265);
  });

  it('[meta] every requirement row is used by a control or documented as not an eBMR function', () => {
    const used = new Set(loadControls().flatMap((c) => c.requirement_rows));
    const unused = loadRequirements().filter((r) => !used.has(r.n)).map((r) => r.n);
    // 11 rows are not eBMR functions (facility design, supply notifications, etc.); see the catalogs' notes.
    expect(unused.length).toBeLessThanOrEqual(11);
  });
});

describe('traceability rules', () => {
  const control = loadControls().find((c) => c.id === 'DI-22');
  if (!control) throw new Error('DI-22 missing');
  const pass = (name: string): TestResult => ({ name, status: 'passed', file: 'x' });

  it('[meta] fails when a control due in the current phase has no passing test', () => {
    const report = buildTrace([{ ...control, target_phase: 1 }], [], 1);
    expect(report.errors.join()).toContain('DI-22');
  });

  it('[meta] passes when the listed test of each catalog-test clause passes, and ignores controls due later', () => {
    // Since review F14/F15 a tagged test alone is not enough: the control lists it and a clause names it.
    const entry = 'packages/kernel/test/audit/x.test.ts > [DI-22] audit entry holds all fields';
    const proven = { ...control, target_phase: 1, tests: [entry], clauses: [{ clause: control.catalog_test, tests: [entry] }] };
    const passed: TestResult = { ...pass('[DI-22] audit entry holds all fields'), path: reportedPath('packages/kernel/test/audit/x.test.ts', [], '[DI-22] audit entry holds all fields') };
    expect(buildTrace([proven], [passed], 1).errors).toEqual([]);
    expect(buildTrace([{ ...control, target_phase: 4, tests: [] }], [], 1).errors).toEqual([]);
  });

  it('[meta] decision 0011: a control whose every clause is deferred with a reason to a phase not started is DEFERRED, not failing; it fails again once that phase starts, or when one clause is not deferred or has no reason', () => {
    const deferral = { phase: 6, reason: 'documentation-type control: the SOP set is written in Phase 6' };
    const fully = { ...control, target_phase: 4, tests: [], clauses: [{ clause: control.catalog_test, deferred: deferral }, { clause: 'a second clause', deferred: deferral }] };
    expect(buildTrace([fully], [], 4).errors).toEqual([]);
    expect(buildTrace([fully], [], 4).rows[0]?.clauses.map((k) => k.state)).toEqual(['DEFERRED', 'DEFERRED']);
    // The phase it is deferred to starts: the deferral is refused and the control needs its passing test again.
    const started = buildTrace([fully], [], 6).errors.join('\n');
    expect(started).toContain('DI-22 (target phase 4) has no passing test');
    expect(started).toContain('deferred to phase 6, which has started');
    // One clause not deferred: the control still needs a passing test, and the clause its own.
    const partly = { ...fully, clauses: [{ clause: control.catalog_test, deferred: deferral }, { clause: 'a second clause', tests: [] }] };
    expect(buildTrace([partly], [], 4).errors.join('\n')).toContain('DI-22 (target phase 4) has no passing test');
    // A deferral without a reason defers nothing.
    const noReason = { ...fully, clauses: [{ clause: control.catalog_test, deferred: { phase: 6, reason: '  ' } }] };
    expect(buildTrace([noReason], [], 4).errors.join('\n')).toContain('DI-22 (target phase 4) has no passing test');
  });

  it('[meta] rejects tests that cite an unknown control', () => {
    expect(buildTrace([control], [pass('[DI-99] nonsense')], 0).errors.join()).toContain('unknown control DI-99');
  });

  it('[meta] flags a DONT_FOLLOW control that tests still enforce', () => {
    const rejected = { ...control, expert_decision: { status: 'DONT_FOLLOW' as const, pack_version: '0.9' } };
    expect(buildTrace([rejected], [pass('[DI-22] still enforced')], 7).errors.join()).toContain('DONT_FOLLOW');
  });
});

describe('exact pins (ADR 0015)', () => {
  const kernel = { name: '@ebmr/kernel', version: '0.1.0' };
  it('[meta] accepts an exact workspace pin equal to the package version', () => {
    expect(checkPins([kernel, { name: '@ebmr/app', version: '0.1.0', dependencies: { '@ebmr/kernel': 'workspace:0.1.0' } }])).toEqual([]);
  });
  it('[meta] refuses ranges and mismatched versions', () => {
    expect(checkPins([kernel, { name: 'a', version: '1.0.0', dependencies: { '@ebmr/kernel': 'workspace:*' } }])).toHaveLength(1);
    expect(checkPins([kernel, { name: 'b', version: '1.0.0', dependencies: { '@ebmr/kernel': 'workspace:0.0.9' } }])).toHaveLength(1);
  });
});

describe('end-to-end results (Playwright JSON)', () => {
  it('[meta] reads specs per project, nested suites included, and treats the last retry as the outcome', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-pw-'));
    const file = join(dir, 'playwright.json');
    writeFileSync(
      file,
      JSON.stringify({
        suites: [
          {
            title: 'smoke/smoke.spec.ts',
            suites: [
              {
                title: 'smoke',
                specs: [
                  { title: '[DI-05] sandbox shows the watermark', file: 'smoke/smoke.spec.ts', tests: [{ projectName: 'kiosk', results: [{ status: 'failed' }, { status: 'passed' }] }] },
                  { title: '[DI-13] cookies', file: 'smoke/smoke.spec.ts', tests: [{ projectName: 'office', results: [{ status: 'timedOut' }] }] },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(readPlaywrightResults(file)).toEqual([
      { name: 'smoke/smoke.spec.ts smoke [DI-05] sandbox shows the watermark (kiosk)', status: 'passed', file: 'smoke/smoke.spec.ts' },
      { name: 'smoke/smoke.spec.ts smoke [DI-13] cookies (office)', status: 'failed', file: 'smoke/smoke.spec.ts' },
    ]);
  });
});

describe('editions in the trace gate (decision 0010)', () => {
  const all = loadControls();
  const find = (id: string) => {
    const c = all.find((x) => x.id === id);
    if (!c) throw new Error(`${id} missing`);
    return c;
  };
  const injectablesOnly = all.find((c) => c.editions.length === 1 && c.editions[0] === 'injectables');
  if (!injectablesOnly) throw new Error('no injectables-only control');
  const shared = find('DI-22');
  const phaseFile = (body: string): string => {
    const file = join(mkdtempSync(join(tmpdir(), 'ebmr-phase-')), 'phase.yaml');
    writeFileSync(file, body);
    return file;
  };

  it('[meta] with the gate on tablets, an injectables-only control at a started phase is not due, while a shared control still is', () => {
    const bare = (c: ControlRecord): ControlRecord => {
      const rest: ControlRecord = { ...c, target_phase: 5, tests: [] };
      delete rest.clauses;
      return rest;
    };
    const due = bare(injectablesOnly);
    const both = bare(shared);
    const tablets = buildTrace([due, both], [], 6, { editions: ['tablets'] }).errors.join('\n');
    expect(tablets).not.toContain(injectablesOnly.id);
    expect(tablets).toContain(`${shared.id} (target phase 5) has no passing test`);
    // Without the filter (both editions) the injectables-only control is due again.
    expect(buildTrace([due], [], 6).errors.join()).toContain(`${injectablesOnly.id} (target phase 5) has no passing test`);
    expect(buildTrace([due], [], 6, { editions: ['tablets', 'injectables'] }).errors.join()).toContain(injectablesOnly.id);
    // Its deferrals wait with the edition; a shared control's deferral to a started phase still fails.
    const deferral = { phase: 5, reason: 'x' };
    const clauses = [{ clause: injectablesOnly.catalog_test, deferred: deferral }];
    expect(buildTrace([{ ...due, clauses }], [], 6, { editions: ['tablets'] }).errors).toEqual([]);
    // A shared control's deferral to a started phase other than the Injectables phase still fails.
    const toSix = { phase: 6, reason: 'x' };
    expect(buildTrace([{ ...both, target_phase: 4, clauses: [{ clause: shared.catalog_test, deferred: toSix }] }], [], 6, { editions: ['tablets'] }).errors.join()).toContain('deferred to phase 6, which has started');
  });

  it('[meta] Phase 6 plan question 7: a deferral to phase 5 (Injectables) has not started while the gate leaves injectables out, at any current phase; it has once the edition is in the gate', () => {
    const deferral = { phase: 5, reason: 'Injectables only' };
    const withClause = { ...shared, target_phase: 4, tests: [], clauses: [{ clause: shared.catalog_test, deferred: deferral }] };
    const withScope = { ...shared, target_phase: 4, deferred_scope: [{ scope: 'the filling suite', phase: 5, reason: 'Injectables only' }] };
    for (const phase of [5, 6, 7]) {
      expect(buildTrace([withClause], [], phase, { editions: ['tablets'] }).errors).toEqual([]);
      expect(buildTrace([withScope], [], phase, { editions: ['tablets'] }).errors.join()).not.toContain('which has started');
      expect(buildTrace([withClause], [], phase, { editions: ['tablets', 'injectables'] }).errors.join()).toContain('deferred to phase 5, which has started');
      expect(buildTrace([withScope], [], phase, { editions: ['tablets', 'injectables'] }).errors.join()).toContain('deferred to phase 5, which has started');
    }
    // Before phase 5 it has not started either way; another phase is unaffected by the edition.
    expect(buildTrace([withClause], [], 4, { editions: ['tablets', 'injectables'] }).errors).toEqual([]);
    expect(deferralStarted(5, 6, ['tablets'])).toBe(false);
    expect(deferralStarted(5, 6, ['tablets', 'injectables'])).toBe(true);
    expect(deferralStarted(5, 4, ['tablets', 'injectables'])).toBe(false);
    expect(deferralStarted(6, 6, ['tablets'])).toBe(true);
    expect(deferralStarted(7, 6, ['tablets'])).toBe(false);
  });

  it('[meta] the filter leaves out only the gate: a failing test tagged with an injectables-only control still fails the trace', () => {
    const failing: TestResult = { name: `[${injectablesOnly.id}] fails`, status: 'failed', file: 'x' };
    expect(buildTrace([injectablesOnly], [failing], 6, { editions: ['tablets'] }).errors.join()).toContain(`${injectablesOnly.id} has failing tests`);
  });

  it('[meta] phase.yaml lists the editions: absent means both, an empty list or an unknown edition is refused', () => {
    expect(gateEditions()).toEqual(['tablets']);
    expect(gateEditions(phaseFile('current_phase: 4\n'))).toEqual(['tablets', 'injectables']);
    expect(gateEditions(phaseFile('current_phase: 4\neditions: [tablets, injectables]\n'))).toEqual(['tablets', 'injectables']);
    expect(() => gateEditions(phaseFile('current_phase: 4\neditions: []\n'))).toThrow(/non-empty/);
    expect(() => gateEditions(phaseFile('current_phase: 4\neditions: [tablet]\n'))).toThrow(/unknown edition tablet/);
  });

  it('[meta] every control due by phase 4 belongs to the tablets edition, so the filter changes nothing before the Phase 6 raise', () => {
    expect(all.filter((c) => c.target_phase <= 4 && !c.editions.includes('tablets')).map((c) => c.id)).toEqual([]);
  });
});
