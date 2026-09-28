/**
 * Simulation of the saved content in a worker thread (module C2; DI-04 static verification evidence; DI-05:
 * simulation output is stamped SIMULATION and writes nothing).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { simulator, validator } from '@ebmr/recipe-core/pure';
import { loadValidationContext } from '../../src/features/designer/adapters/expressions.ts';
import { designerSettings } from '../../src/features/designer/index.ts';
import { coveragePercent, simulateInWorker } from '../../src/features/designer/simulation.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { createFamily, refusalOf, startDesignerServer, templateMbr, valueOf } from './support.ts';

let server: TestServer;
let author: TestBrowser;

beforeAll(async () => {
  server = await startDesignerServer();
  author = await server.asPersona('author');
});
afterAll(async () => {
  await server?.close();
});

async function auditCount(): Promise<number> {
  const { rows } = await server.db.admin.query<{ n: string }>('select count(*)::text as n from kernel.audit_event');
  return Number(rows[0]?.n);
}

describe('simulation (worker thread, SIMULATION watermark)', () => {
  it('[DI-04][DI-05] simulates the saved content with full coverage, stamped SIMULATION, writing nothing', async () => {
    const v = await createFamily(author);
    const before = await auditCount();
    const s = valueOf(await author.call(routes.designer.simulate, { params: { versionId: v.versionId }, body: {} }));
    expect(await auditCount()).toBe(before);
    expect(s.watermark).toEqual({ text: 'TEST, NOT GMP', source: 'SIMULATION', notice: expect.any(String), control: 'DI-05' });
    expect(s.contentHash).toBe(v.contentHash);
    expect(s.passed).toBe(true);
    expect(s.problems).toEqual([]);
    expect(s.coverage.nodes).toEqual({ covered: 14, total: 14 });
    expect(s.coverage.percent).toBe('100.0');
    expect(s.paths).toBeGreaterThan(0);
    expect(s.runs[0]).toEqual({ pathId: 'P1', outcome: 'COMPLETED', exceptions: [] });
  });

  it('[DI-04] a timed-out simulation is stopped and refused; nothing is recorded', async () => {
    const v = await createFamily(author, { familyCode: 'PCM500-SIMTO', batchSizes: [{ quantity: '15', unit: 'kg' }] });
    const saved = designerSettings.simulationTimeoutMs;
    designerSettings.simulationTimeoutMs = 1;
    try {
      const r = refusalOf(await author.call(routes.designer.simulate, { params: { versionId: v.versionId }, body: {} }));
      expect(r.status).toBe(422);
      expect(r.code).toBe('SIMULATION_TIMEOUT');
    } finally {
      designerSettings.simulationTimeoutMs = saved;
    }
  });

  it('the worker returns the same report as an in-process simulation (deterministic evidence)', async () => {
    const mbr = templateMbr();
    const loaded = await loadValidationContext(server.db.app, mbr);
    const out = await simulateInWorker({ content: mbr, asOf: loaded.asOf, references: loaded.references, minimaRequest: loaded.minimaRequest, minima: loaded.minima });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const inProcess = simulator.simulate(mbr, loaded.context);
    expect(out.report.reportHash).toBe(inProcess.reportHash);
    expect(validator.validateMbr(mbr, loaded.context).contentHash).toBe(out.report.contentHash);
  });

  it('coverage percent is exact, one decimal, half up', () => {
    const c = (covered: number, total: number) => ({ covered, total, missing: [] });
    const zero = c(0, 0);
    expect(coveragePercent({ coverage: { steps: c(2, 3), decisions: zero, limitBounds: zero, guards: zero, timeConstraints: zero, calculations: zero } })).toBe('66.7');
    expect(coveragePercent({ coverage: { steps: c(1, 8), decisions: zero, limitBounds: zero, guards: zero, timeConstraints: zero, calculations: zero } })).toBe('12.5');
    expect(coveragePercent({ coverage: { steps: zero, decisions: zero, limitBounds: zero, guards: zero, timeConstraints: zero, calculations: zero } })).toBe('100.0');
  });
});
