/**
 * The gb-t-01 template (Phase 3 slice 6d; D-S6-5): the golden batch's master passes every validator gate against the real
 * adapters (its DEMO-ONLY reference documents, the published rule tables), defines as a GMP batch with the tablets
 * registry, and simulates with full coverage; its golden cases are the hand worksheet's numbers
 * (test/golden/gb-t-01/README.md), each matching the calculation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { simulator, validator, type flow } from '@ebmr/recipe-core/pure';
import { define } from '../../../../packages/recipe-core/test/engine/support.ts';
import { loadValidationContext } from '../../src/features/designer/adapters/expressions.ts';
import { TEMPLATES } from '../../src/features/designer/templates/index.ts';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../src/features/edition-blocks.ts';
import type { TestServer } from '../support/harness.ts';
import { startDesignerServer } from './support.ts';

let server: TestServer;
beforeAll(async () => {
  server = await startDesignerServer();
}, 300_000);
afterAll(async () => {
  await server?.close();
});

const mbr = (): flow.MbrContent => {
  const t = TEMPLATES.get('gb-t-01');
  if (!t) throw new Error('no gb-t-01 template');
  return structuredClone(t.content);
};

describe('the gb-t-01 template against the real adapters', () => {
  it('[PR-03][DI-04] passes every validator gate with no finding, and defines as a GMP batch with the tablets blocks', async () => {
    const m = mbr();
    const { context } = await loadValidationContext(server.db.app, m);
    const report = validator.validateMbr(m, context);
    expect(report.findings).toEqual([]);
    expect(validator.gate(report, []).passed).toBe(true);
    expect(() => define(m, { registry: tabletsBlockRegistry(), catalog: tabletsBlockCatalog, installation: 'GMP' })).not.toThrow();
  });

  it('[DI-04][INV-19] simulates with full coverage; every golden case (the hand worksheet) matches its calculation', async () => {
    const m = mbr();
    const { context } = await loadValidationContext(server.db.app, m);
    const sim = simulator.simulate(m, context);
    expect(sim.problems).toEqual([]);
    expect(sim.passed).toBe(true);
    for (const part of Object.values(sim.coverage)) expect(part.missing).toEqual([]);
    expect(sim.golden.map((g) => `${g.case} ${g.calculation} ${g.status} ${g.expected}`).sort()).toEqual(
      [
        'G-BLEND blendIn PASS 82.750 kg',
        'G-BLEND blendYield PASS 99.47 %',
        'G-COAT coatGain PASS 2.93 %',
        'G-COMP compAcc PASS 99.54 %',
        'G-COMP compT PASS 83.660 kg',
        'G-COMP compYield PASS 96.72 %',
        'G-COMP compYieldAB PASS 97.47 %',
        'G-DISP dispRecon PASS 100.00 %',
        'G-DISP dispStd PASS 86.509 kg',
        'G-DISP dispTotal PASS 86.510 kg',
        'G-GRAN granOut PASS 77.150 kg',
        'G-GRAN granYield PASS 98.83 %',
        'G-GRAN intraSolids PASS 78.060 kg',
        'G-INSP inspYield PASS 99.78 %',
      ].sort(),
    );
  });
});
