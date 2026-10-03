/**
 * Register CLI.
 *   import     catalogs -> compliance/controls/*.yaml (keeps decisions and build progress)
 *   validate   schema, IDs, requirement references, listed tests exist, catalog-test clauses (reviews F14, F15)
 *   pins       exact workspace pins (ADR 0015)
 *   trace      traceability matrix from a Vitest JSON report (--results <file>) and, when present, the
 *              Playwright JSON report (--playwright <file>): passing tests per control, listed tests reported,
 *              each clause of a due control tested or deferred to a later phase
 */
import { importCatalogs } from './import.ts';
import { checkPins, readManifests } from './pins.ts';
import { currentPhase, loadControls } from './register.ts';
import { existsSync } from 'node:fs';
import { buildTrace, readPlaywrightResults, readVitestResults, writeMatrix } from './trace.ts';
import { validateRegister } from './validate.ts';

function fail(title: string, errors: string[]): never {
  console.error(`${title}: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
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
    const idx = args.indexOf('--results');
    const file = idx >= 0 ? args[idx + 1] : undefined;
    if (!file) fail('trace', ['--results <vitest json> is required']);
    const phase = currentPhase();
    // Optional end-to-end results (the e2e job writes them; the unit job may not have them).
    const pwIdx = args.indexOf('--playwright');
    const pwFile = pwIdx >= 0 ? args[pwIdx + 1] : undefined;
    const e2e = pwFile && existsSync(pwFile) ? readPlaywrightResults(pwFile) : [];
    if (pwFile && e2e.length) console.log(`including ${e2e.length} end-to-end results from ${pwFile}`);
    // Listed end-to-end tests are checked against the run only when the Playwright report is part of it.
    const report = buildTrace(loadControls(), [...readVitestResults(file), ...e2e], phase, { e2e: e2e.length > 0 });
    writeMatrix(report, phase, '.reports/trace-matrix.md');
    if (report.errors.length) fail(`traceability check failed for phase ${phase}`, report.errors);
    const covered = report.rows.filter((r) => r.passing.length > 0).length;
    console.log(`traceability ok for phase ${phase}: ${covered}/${report.rows.length} controls have passing tests; matrix in .reports/trace-matrix.md`);
    break;
  }
  default:
    fail('usage', ['register <import|validate|pins|trace --results file>']);
}
