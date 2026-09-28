/**
 * Running the designer's simulation in a worker thread with a timeout, and the SimulationReportView (module C2;
 * plan section 8; DI-04 static verification evidence; DI-05: every simulation output carries the SIMULATION
 * watermark and nothing is written).
 */
import { Worker } from 'node:worker_threads';
import { sandbox } from '@ebmr/kernel';
import type { Instant, SimulationReportView, Watermark } from '@ebmr/api-contract';
import type { simulator } from '@ebmr/recipe-core/pure';
import type { SimulationJob, SimulationResult } from './simulate-worker.ts';

export const DEFAULT_SIMULATION_TIMEOUT_MS = 20_000;

export type WorkerOutcome = SimulationResult | { ok: false; timeout: true; message: string };

/** Runs one simulation job in a fresh worker; terminates it after `timeoutMs`. */
export function simulateInWorker(job: SimulationJob, timeoutMs: number = DEFAULT_SIMULATION_TIMEOUT_MS): Promise<WorkerOutcome> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./simulate-worker-boot.mjs', import.meta.url), {
      workerData: { entry: new URL('./simulate-worker.ts', import.meta.url).href, job },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let done = false;
    const finish = (outcome: WorkerOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(outcome);
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
  const problems = report.problems.map((p) => ({ code: 'SIMULATION', message: p, path: null }));
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
