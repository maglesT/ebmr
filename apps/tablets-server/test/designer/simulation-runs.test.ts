/**
 * The simulation report view names what became of each simulated path (review F54; DI-04 static verification
 * evidence, DI-05 SIMULATION output). The simulator counts the paths that end with an exception (a loop driven to its
 * maximum: paths.withExceptions) and records each path's decisions; the view listed every path as an exception-free
 * COMPLETED run, and the targeted runs twice. The review's reproducers (designer-ui-simulation-run-exceptions and its
 * verification through the real worker) are ported here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { simulator } from '@ebmr/recipe-core/pure';
import { flow } from '@ebmr/recipe-core/pure';
import granulation from '../../../../packages/recipe-core/test/fixtures/tablet-granulation-compression.mbr.json' with { type: 'json' };
import { loadValidationContext } from '../../src/features/designer/adapters/expressions.ts';
import { pathExceptions, simulateInWorker, simulationReportView } from '../../src/features/designer/simulation.ts';
import type { TestServer } from '../support/harness.ts';
import { startDesignerServer } from './support.ts';

let server: TestServer;

beforeAll(async () => {
  server = await startDesignerServer();
});
afterAll(async () => {
  await server?.close();
});

const AT = { us: '0', text: 'now' };

async function granulationReport(): Promise<simulator.SimulationReport> {
  const parsed = flow.parseMbr(structuredClone(granulation));
  if (!parsed.ok) throw new Error('fixture does not parse');
  const loaded = await loadValidationContext(server.db.app, parsed.mbr);
  const out = await simulateInWorker({ content: parsed.mbr, asOf: loaded.asOf, references: loaded.references, minimaRequest: loaded.minimaRequest, minima: loaded.minima, engineRoles: loaded.engineRoles });
  if (!out.ok) throw new Error(out.message);
  return out.report;
}

describe('simulated runs and the exceptions they end with (review F54)', () => {
  it('[DI-04][DI-05] each path that drives the drying loop to its maximum is shown with that exception; the count equals the simulator\'s', async () => {
    const report = await granulationReport();
    expect(report.paths.withExceptions, 'the granulation master has paths that exhaust the drying loop').toBeGreaterThan(0);
    const view = simulationReportView(report, AT);
    const flagged = view.runs.filter((r) => r.exceptions.length > 0);
    expect(flagged.length).toBe(report.paths.withExceptions);
    for (const r of flagged) {
      expect(r.outcome).toMatch(/^COMPLETED WITH EXCEPTION/);
      for (const e of r.exceptions) expect(e).toMatch(/^LOOP_EXHAUSTED: loop L-DRY \(.*\) reached its maximum of \d+ iterations without meeting its exit condition$/);
    }
    // Every other run completed without one.
    for (const r of view.runs.filter((x) => x.exceptions.length === 0)) expect(r.outcome).toMatch(/^COMPLETED(, TARGETED: .+)?$/);
    // By the simulator's own decisions: exactly the paths that decided EXHAUSTED carry an exception.
    report.paths.decisions.forEach((d, i) => expect((view.runs[i]?.exceptions.length ?? 0) > 0, `run ${view.runs[i]?.pathId}`).toBe(d.some((x) => x.endsWith('=EXHAUSTED'))));
  });

  it('[DI-04] each simulated path is listed once: the enumerated ones as P-n, the targeted ones as T-n with the option they target', async () => {
    const report = await granulationReport();
    const view = simulationReportView(report, AT);
    expect(view.runs.length).toBe(report.paths.enumerated + report.paths.targeted.length);
    expect(view.runs.length).toBe(view.paths);
    expect(new Set(view.runs.map((r) => r.pathId)).size).toBe(view.runs.length);
    expect(view.runs.filter((r) => r.pathId.startsWith('P'))).toHaveLength(report.paths.enumerated);
    const targeted = view.runs.filter((r) => r.pathId.startsWith('T'));
    expect(targeted.map((r) => /TARGETED: (.+)$/.exec(r.outcome)?.[1])).toEqual(report.paths.targeted);
  });

  it('[DI-04] a path the simulator reports as not completed is shown so, never as COMPLETED; the exception text reads the loop, its context and maximum', () => {
    const base: simulator.SimulationReport = {
      simulatorVersion: '1.0.0',
      languageVersion: '1',
      contentHash: 'c'.repeat(64),
      paths: {
        exact: '3',
        enumerated: 2,
        bound: 10000,
        boundHit: false,
        message: 'All 3 paths enumerated',
        decisions: [['loop-test:L-DRY@#1=EXIT'], ['loop-test:L-DRY@#1=CONTINUE', 'loop-test:L-DRY@L-DRY=2#2=EXHAUSTED'], ['xor-split:ALT@=b']],
        withExceptions: 1,
        targeted: ['xor-split:ALT=b'],
      },
      limits: [],
      guards: [],
      time: [],
      golden: [],
      coverage: { steps: { covered: 1, total: 1, missing: [] }, decisions: { covered: 1, total: 1, missing: [] }, limitBounds: { covered: 0, total: 0, missing: [] }, guards: { covered: 0, total: 0, missing: [] }, timeConstraints: { covered: 0, total: 0, missing: [] }, calculations: { covered: 0, total: 0, missing: [] } },
      problems: ['a path did not complete: loop-test:L-DRY@#1=EXIT'],
      passed: false,
      reportHash: 'd'.repeat(64),
    };
    expect(simulationReportView(base, AT).runs).toEqual([
      { pathId: 'P1', outcome: 'DID NOT COMPLETE', exceptions: [] },
      { pathId: 'P2', outcome: 'COMPLETED WITH EXCEPTION', exceptions: ['LOOP_EXHAUSTED: loop L-DRY (L-DRY=2) reached its maximum of 2 iterations without meeting its exit condition'] },
      { pathId: 'T1', outcome: 'COMPLETED, TARGETED: xor-split:ALT=b', exceptions: [] },
    ]);
    expect(pathExceptions(['loop-test:lib/L-X@R=1/lib/L-X=3#3=EXHAUSTED'])).toEqual(['LOOP_EXHAUSTED: loop lib/L-X (R=1/lib/L-X=3) reached its maximum of 3 iterations without meeting its exit condition']);
  });
});
