import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { controlTypes, coveredRows, parseCatalog, parseFields } from '../src/catalog-parser.ts';
import { checkPins } from '../src/pins.ts';
import { idsInText } from '../src/phases.ts';
import { loadControls, loadRequirements } from '../src/register.ts';
import { buildTrace, readPlaywrightResults, type TestResult } from '../src/trace.ts';
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
  it('[meta] is valid: 241 controls, schema, references to requirement rows', () => {
    expect(validateRegister()).toEqual([]);
    expect(loadControls()).toHaveLength(241);
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

  it('[meta] passes when a tagged test passes, and ignores controls due later', () => {
    expect(buildTrace([{ ...control, target_phase: 1 }], [pass('[DI-22] audit entry holds all fields')], 1).errors).toEqual([]);
    expect(buildTrace([{ ...control, target_phase: 4 }], [], 1).errors).toEqual([]);
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
