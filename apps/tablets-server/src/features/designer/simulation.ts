/**
 * Running the designer's simulation in a worker thread with a timeout, and the SimulationReportView (module C2;
 * plan section 8; DI-04 static verification evidence; DI-05: every simulation output carries the SIMULATION
 * watermark and nothing is written).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { sandbox } from '@ebmr/kernel';
import type { Instant, SimulationReportView, Watermark } from '@ebmr/api-contract';
import type { simulator } from '@ebmr/recipe-core/pure';
import { slotPool, type AcquireSlot } from './limits.ts';
import type { SimulationJob, SimulationResult } from './simulate-worker.ts';

export const DEFAULT_SIMULATION_TIMEOUT_MS = 20_000;

/**
 * How many simulations one server process runs at once (review P18). Each is a worker thread with a heap of up to
 * 512 MB and about one CPU while it runs; on the 4-CPU host two leave the GMP work (records, signatures, audit) room.
 */
export const DEFAULT_MAX_CONCURRENT_SIMULATIONS = 2;

/**
 * Takes one of the process's simulation slots: returns its release (idempotent), or null when `max` simulations are
 * already running (the caller refuses; nothing waits in a queue).
 */
export const acquireSimulationSlot: AcquireSlot = slotPool();

export type WorkerOutcome = SimulationResult | { ok: false; timeout: true; message: string };

/**
 * The worker's bootstrap, an ES module in a data: URL. The server runs from TypeScript source in Phase 2
 * (`node --import tsx`, or Vitest in tests) and loader hooks registered in the parent do not reach a worker's entry,
 * so the bootstrap loads the TypeScript worker through tsx's scoped import (tsImport). No fallback: without tsx the
 * simulation fails with a plain error, never silently. A bundled server replaces this.
 */
const BOOTSTRAP = `import { workerData } from 'node:worker_threads';
let api;
try {
  api = await import(workerData.loader);
} catch (error) {
  throw new Error('The simulation worker cannot start: the TypeScript loader tsx/esm/api could not be loaded (' + (error && error.message) + ').');
}
await api.tsImport(workerData.entry, workerData.base);`;

/** The file URL of tsx's ES-module API, from its package exports (resolved from this module). */
export function tsxLoaderUrl(): string {
  const require = createRequire(import.meta.url);
  let pkgPath: string;
  try {
    pkgPath = require.resolve('tsx/package.json');
  } catch (error) {
    throw new Error(`The simulation worker cannot start: the TypeScript loader tsx is not installed for the server (${error instanceof Error ? error.message : String(error)}).`, { cause: error });
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { exports?: Record<string, { import?: { default?: string } } | undefined> };
  const rel = pkg.exports?.['./esm/api']?.import?.default;
  if (!rel) throw new Error('The simulation worker cannot start: this tsx version has no ES-module API (tsx/esm/api).');
  return pathToFileURL(join(dirname(pkgPath), rel)).href;
}

/** Runs one simulation job in a fresh worker; terminates it after `timeoutMs`. Settles once the worker has stopped. */
export function simulateInWorker(job: SimulationJob, timeoutMs: number = DEFAULT_SIMULATION_TIMEOUT_MS): Promise<WorkerOutcome> {
  let loader: string;
  try {
    loader = tsxLoaderUrl();
  } catch (error) {
    return Promise.resolve({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
  return new Promise((resolve) => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(BOOTSTRAP)}`), {
      workerData: { loader, entry: new URL('./simulate-worker.ts', import.meta.url).href, base: import.meta.url, job },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let done = false;
    const finish = (outcome: WorkerOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // The caller's slot is held until the worker (and its heap) is gone, so the bound on running simulations holds.
      worker.terminate().then(
        () => resolve(outcome),
        () => resolve(outcome),
      );
    };
    const timer = setTimeout(() => finish({ ok: false, timeout: true, message: `the simulation did not finish within ${timeoutMs / 1000} s` }), timeoutMs);
    worker.once('message', (m: SimulationResult) => finish(m));
    worker.once('error', (e) => finish({ ok: false, message: e.message }));
    worker.once('exit', (code) => finish({ ok: false, message: `the simulation worker stopped (exit code ${code})` }));
  });
}

/** Covered / total over every coverage dimension, as a percentage with one decimal (exact, half up). */
export function coveragePercent(report: Pick<simulator.SimulationReport, 'coverage'>): string {
  const parts = Object.values(report.coverage);
  const covered = parts.reduce((n, p) => n + BigInt(p.covered), 0n);
  const total = parts.reduce((n, p) => n + BigInt(p.total), 0n);
  if (total === 0n) return '100.0';
  const tenths = (covered * 2000n + total) / (2n * total); // round(covered * 1000 / total), half up
  return `${tenths / 10n}.${tenths % 10n}`;
}

export function simulationWatermark(): Watermark {
  const w = sandbox.watermarkFor('SIMULATION');
  if (!w) throw new Error('the SIMULATION watermark is missing (DI-05)');
  return { text: w.text, source: w.source, notice: w.notice, control: w.control };
}

/** The view of a simulation report (plan section 4). */
export function simulationReportView(report: simulator.SimulationReport, simulatedAt: Instant): SimulationReportView {
  const runs = [
    ...report.paths.decisions.map((_d, i) => ({ pathId: `P${i + 1}`, outcome: 'COMPLETED', exceptions: [] as string[] })),
    ...report.paths.targeted.map((t, i) => ({ pathId: `T${i + 1}`, outcome: `TARGETED: ${t}`, exceptions: [] as string[] })),
  ];
  const problems: SimulationReportView['problems'] = report.problems.map((p) => ({ code: 'SIMULATION', message: p, path: null }));
  for (const [dimension, c] of Object.entries(report.coverage)) {
    for (const m of c.missing) problems.push({ code: `NOT_COVERED_${dimension.toUpperCase()}`, message: `${dimension}: ${m} is not reached by any simulated path`, path: m });
  }
  for (const g of report.golden) {
    if (g.status !== 'PASS') problems.push({ code: `GOLDEN_${g.status}`, message: `Golden case ${g.case}, ${g.calculation}: ${g.message}`, path: g.calculation });
  }
  return {
    watermark: simulationWatermark(),
    contentHash: report.contentHash,
    passed: report.passed,
    paths: report.paths.enumerated + report.paths.targeted.length,
    coverage: {
      nodes: { covered: report.coverage.steps.covered, total: report.coverage.steps.total },
      decisions: { covered: report.coverage.decisions.covered, total: report.coverage.decisions.total },
      percent: coveragePercent(report),
    },
    problems,
    runs,
    simulatedAt,
  };
}
