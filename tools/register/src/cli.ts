/**
 * Register CLI.
 *   import     catalogs -> compliance/controls/*.yaml (keeps decisions and build progress)
 *   validate   schema, IDs, requirement references, listed tests exist, catalog-test clauses (reviews F14, F15)
 *   pins       exact workspace pins (ADR 0015)
 *   trace      traceability matrix from a Vitest JSON report (--results <file>) and, when present, the
 *              Playwright JSON report (--playwright <file>; --require-playwright fails without it): passing tests
 *              per control, listed tests reported, every passing tagged test listed (review F15), each clause of a
 *              due control tested or deferred to a later phase
 *   sync-tests adds to each control's tests list the passing tests of the same reports tagged with it that the
 *              list does not name yet (review F15, round 2)
 */
import { importCatalogs } from './import.ts';
import { checkPins, readManifests } from './pins.ts';
import { currentPhase, loadControls } from './register.ts';
import { existsSync } from 'node:fs';
import { appendListedTests, testsToAdd } from './sync.ts';
import { buildTrace, readPlaywrightResults, readVitestResults, writeMatrix, type TestResult } from './trace.ts';
import { validateRegister } from './validate.ts';

function fail(title: string, errors: string[]): never {
  console.error(`${title}: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);

const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

/** The run's results: the Vitest report and, when present (or required), the Playwright report. */
function runResults(): { results: TestResult[]; e2e: boolean } {
  const file = option('--results');
  if (!file) fail(command ?? 'register', ['--results <vitest json> is required']);
  // Optional end-to-end results (the e2e job writes them; the checks job does not have them).
  const pwFile = option('--playwright');
  const e2e = pwFile && existsSync(pwFile) ? readPlaywrightResults(pwFile) : [];
  if (args.includes('--require-playwright') && e2e.length === 0) fail(command ?? 'register', [`--require-playwright: no end-to-end results in ${pwFile ?? '(no --playwright file given)'}`]);
  if (pwFile && e2e.length) console.log(`including ${e2e.length} end-to-end results from ${pwFile}`);
  return { results: [...readVitestResults(file), ...e2e], e2e: e2e.length > 0 };
}

switch (command) {
  case 'import': {
    const { written } = importCatalogs();
    console.log(`imported ${written} controls into compliance/controls/`);
    break;
  }
  case 'validate': {
    const errors = validateRegister();
    if (errors.length) fail('register invalid', errors);
    console.log(`register valid: ${loadControls().length} controls`);
    break;
  }
  case 'pins': {
    const errors = checkPins(readManifests());
    if (errors.length) fail('pin check failed', errors);
    console.log('all internal dependencies are pinned to exact workspace versions');
    break;
  }
  case 'trace': {
    const phase = currentPhase();
    const { results, e2e } = runResults();
    // Listed end-to-end tests are checked against the run only when the Playwright report is part of it.
    const report = buildTrace(loadControls(), results, phase, { e2e });
    writeMatrix(report, phase, '.reports/trace-matrix.md');
    if (report.errors.length) fail(`traceability check failed for phase ${phase}`, report.errors);
    const covered = report.rows.filter((r) => r.passing.length > 0).length;
    console.log(`traceability ok for phase ${phase}: ${covered}/${report.rows.length} controls have passing tests; matrix in .reports/trace-matrix.md`);
    break;
  }
  case 'sync-tests': {
    const additions = testsToAdd(loadControls(), runResults().results);
    const added = appendListedTests(additions);
    for (const [id, entries] of additions) console.log(`${id}: ${entries.length} test(s) added to its list`);
    console.log(`added ${added} passing tagged test(s) to the controls' tests lists`);
    break;
  }
  default:
    fail('usage', ['register <import|validate|pins|trace --results file [--playwright file] [--require-playwright]|sync-tests --results file [--playwright file]>']);
}
