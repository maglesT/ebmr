/**
 * Register CLI.
 *   import     catalogs -> compliance/controls/*.yaml (keeps decisions and build progress)
 *   validate   schema, IDs, requirement references, listed tests exist, catalog-test clauses (reviews F14, F15), and
 *              the files under compliance/validation/ (Phase 7 slice 7-0: schema, order, known controls and tests)
 *   pins       exact workspace pins (ADR 0015)
 *   trace      traceability matrix from a Vitest JSON report (--results <file>) and, when present, the
 *              Playwright JSON report (--playwright <file>; --require-playwright fails without it): passing tests
 *              per control, listed tests reported, every passing tagged test listed (review F15), each clause of a
 *              due control tested or deferred to a later phase
 *   sync-tests adds to each control's tests list the passing tests of the same reports tagged with it that the
 *              list does not name yet (review F15, round 2), and writes every list sorted
 *   sort-tests sorts each control's tests list (validate refuses an unsorted one)
 *   status     --bundle <file>: sets each control's build_status by D-P7-2 from an evidence bundle (only that field;
 *              the only writer of VERIFIED; Phase 7 slice 7c). validate refuses a VERIFIED the rule does not allow
 *              (with --bundle <file>, the whole rule; without, the part the files show).
 */
import { importCatalogs } from './import.ts';
import { checkPins, readManifests } from './pins.ts';
import { currentPhase, gateEditions, loadControls } from './register.ts';
import { existsSync, readFileSync } from 'node:fs';
import { appendListedTests, sortListedTests, testsToAdd } from './sync.ts';
import { buildTrace, readPlaywrightResults, readVitestResults, writeMatrix, type TestResult } from './trace.ts';
import { validateRegister } from './validate.ts';
import { parseBundle } from '../../../packages/validation-kit/src/index.ts';
import { applyStatuses, statusContext, verifiedProblems } from './build-status.ts';
import { validationFileErrors } from './validation-files.ts';

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
  // Optional golden-batch results (the CI golden job's own Vitest report, run on its libfaketime cluster): the golden
  // tests skip themselves in every other run, so a clause only a golden batch proves needs this report. Read beside
  // the main report, never merged into it: a skipped copy of a test cannot hide the golden job's passing one.
  const goldenFile = option('--golden');
  if (args.includes('--require-golden') && !(goldenFile && existsSync(goldenFile))) fail(command ?? 'register', [`--require-golden: no golden-batch report at ${goldenFile ?? '(no --golden file given)'}`]);
  const golden = goldenFile && existsSync(goldenFile) ? readVitestResults(goldenFile) : [];
  if (golden.length) console.log(`including ${golden.length} golden-batch results from ${goldenFile}`);
  return { results: [...readVitestResults(file), ...golden, ...e2e], e2e: e2e.length > 0 };
}

switch (command) {
  case 'import': {
    const { written } = importCatalogs();
    console.log(`imported ${written} controls into compliance/controls/`);
    break;
  }
  case 'validate': {
    const controls = loadControls();
    const errors = [...validateRegister(controls), ...validationFileErrors(undefined, controls)];
    const bundleFile = option('--bundle');
    if (errors.length === 0) errors.push(...verifiedProblems(controls, statusContext(), bundleFile ? parseBundle(JSON.parse(readFileSync(bundleFile, 'utf8'))) : undefined));
    if (errors.length) fail('register invalid', errors);
    console.log(`register valid: ${controls.length} controls and the compliance/validation files`);
    break;
  }
  case 'status': {
    const bundleFile = option('--bundle');
    if (!bundleFile) fail('status', ['--bundle <file> is required']);
    const controls = loadControls();
    const errors = [...validateRegister(controls), ...validationFileErrors(undefined, controls)];
    if (errors.length) fail('register invalid; no status written', errors);
    const changes = applyStatuses(controls, parseBundle(JSON.parse(readFileSync(bundleFile, 'utf8'))), statusContext());
    for (const ch of changes) console.log(`${ch.id}: ${ch.from} -> ${ch.to}${ch.reasons.length ? ` (${ch.reasons[0] ?? ''}${ch.reasons.length > 1 ? `; and ${String(ch.reasons.length - 1)} more` : ''})` : ''}`);
    console.log(`build status set from ${bundleFile}: ${String(changes.length)} control(s) changed`);
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
    const editions = gateEditions();
    const { results, e2e } = runResults();
    // Listed end-to-end tests are checked against the run only when the Playwright report is part of it.
    const report = buildTrace(loadControls(), results, phase, { e2e, editions });
    writeMatrix(report, phase, '.reports/trace-matrix.md', editions);
    if (report.skipped.length) {
      console.log(`${report.skipped.length} listed test(s) skipped themselves in this run, as their source allows (they prove nothing here):`);
      for (const s of report.skipped) console.log(`  - ${s}`);
    }
    if (report.errors.length) fail(`traceability check failed for phase ${phase}`, report.errors);
    const covered = report.rows.filter((r) => r.passing.length > 0).length;
    console.log(`traceability ok for phase ${phase} (editions: ${editions.join(', ')}): ${covered}/${report.rows.length} controls have passing tests; matrix in .reports/trace-matrix.md`);
    break;
  }
  case 'sync-tests': {
    const additions = testsToAdd(loadControls(), runResults().results);
    const added = appendListedTests(additions);
    for (const [id, entries] of additions) console.log(`${id}: ${entries.length} test(s) added to its list`);
    console.log(`added ${added} passing tagged test(s) to the controls' tests lists`);
    const sorted = sortListedTests(loadControls());
    if (sorted.length > 0) console.log(`sorted the tests lists of ${sorted.length} control(s)`);
    break;
  }
  case 'sort-tests': {
    const sorted = sortListedTests(loadControls());
    console.log(`sorted the tests lists of ${sorted.length} control(s)`);
    break;
  }
  default:
    fail('usage', ['register <import|validate|pins|trace --results file [--golden file] [--require-golden] [--playwright file] [--require-playwright]|sync-tests --results file [--golden file] [--playwright file]|sort-tests>']);
}
