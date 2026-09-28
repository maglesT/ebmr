/**
 * Day-1 spike of module C2 (Phase 2 apps plan section 8): the dc-mini template passes every validator gate against
 * the REAL adapters (reference documents in tab.reference_document; content minima from the kernel market engine
 * over the published tablets rule table, failing closed), simulates with full coverage, and defines as a batch in
 * the sandbox once C3's G-09/G-10 v1 are registered. The whole first clickable version depends on it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blocks, engine, flow, simulator, validator } from '@ebmr/recipe-core/pure';
import { loadValidationContext } from '../../src/features/designer/adapters/expressions.ts';
import { demoReferenceIndex } from '../../src/features/designer/reference-catalogue.ts';
import type { TestServer } from '../support/harness.ts';
import { publishTables, startDesignerServer, templateMbr } from './support.ts';

let server: TestServer;

beforeAll(async () => {
  // References recorded, rule tables NOT yet published: the fail-closed case is checked first.
  server = await startDesignerServer({ ruleTables: false });
});
afterAll(async () => {
  await server?.close();
});

describe('dc-mini template against the real adapters (day-1 spike)', () => {
  it('[INV-34][PR-03] without the published tablets rule table the market adapter fails closed and the template cannot pass', async () => {
    const mbr = templateMbr();
    const { context, minima } = await loadValidationContext(server.db.app, mbr);
    expect(minima).toEqual([expect.objectContaining({ kind: 'UNRESOLVED', ruleKey: 'tablets.*' })]);
    const report = validator.validateMbr(mbr, context);
    const mkt = report.findings.filter((f) => f.rule === 'MKT-MINIMA');
    expect(mkt).toHaveLength(1);
    expect(mkt[0]?.severity).toBe('ERROR');
    expect(mkt[0]?.message).toMatch(/tablets rule table is not published/);
    expect(validator.gate(report, []).passed).toBe(false);
  });

  it('[PR-03][INV-34][DI-04] passes every validator gate with zero errors and no unjustified warning', async () => {
    await publishTables(server);
    const mbr = templateMbr();
    const { context, minima, references } = await loadValidationContext(server.db.app, mbr);
    expect(minima).toEqual([]);
    expect(references.length).toBe(mbr.references.length);
    for (const r of mbr.references) expect(context.references.status(r), r.id).toBe('EFFECTIVE');
    const report = validator.validateMbr(mbr, context);
    expect(report.findings).toEqual([]);
    expect(report.errors).toBe(0);
    expect(report.contentHash).toBe(flow.mbrContentHash(mbr));
    expect(report.rules).toContain('MKT-MINIMA');
    const g = validator.gate(report, []);
    expect(g.passed).toBe(true);
    expect(g.unjustifiedWarnings).toEqual([]);
  });

  it('[DI-04][INV-19][INV-20][PR-08] simulates with full coverage of steps, limit bounds, time constraints and calculations', async () => {
    const mbr = templateMbr();
    const { context } = await loadValidationContext(server.db.app, mbr);
    const sim = simulator.simulate(mbr, context);
    expect(sim.problems).toEqual([]);
    expect(sim.passed).toBe(true);
    const c = sim.coverage;
    for (const part of [c.steps, c.decisions, c.limitBounds, c.guards, c.timeConstraints, c.calculations]) {
      expect(part.missing).toEqual([]);
      expect(part.covered).toBe(part.total);
    }
    expect(c.steps.total).toBe(14);
    expect(c.calculations.total).toBe(6);
    expect(sim.golden.every((g) => g.status === 'PASS')).toBe(true);
    const { evidence } = simulator.verifyMbr(mbr, context, []);
    expect(evidence.verdict).toBe('VERIFIED');
    expect(simulator.evidenceHolds(mbr, evidence)).toBe(true);
  });

  it('[INV-34][IN-52] the US variant (IN + US) resolves through the market engine and still passes', async () => {
    const mbr = templateMbr((j) => {
      (j['header'] as { marketSet: string[] }).marketSet = ['IN', 'US'];
    });
    const { context, minima } = await loadValidationContext(server.db.app, mbr);
    expect(minima).toEqual([]);
    const report = validator.validateMbr(mbr, context);
    expect(report.errors).toBe(0);
    expect(validator.gate(report, []).passed).toBe(true);
  });

  it('[DI-04] pins exactly the seeded DEMO-ONLY reference documents by version and hash', () => {
    const index = demoReferenceIndex();
    const mbr = templateMbr();
    for (const r of mbr.references) {
      const doc = index.get(r.code);
      expect(doc, r.code).toBeDefined();
      expect(r.kind).toBe(doc?.seed.kind);
      expect(r.version).toBe(doc?.seed.version);
      expect(r.hash).toBe(doc?.hash);
    }
  });

  it('uses the engine role vocabulary for performers, checkers, stage responsibles and the QA hold point', () => {
    const mbr = templateMbr();
    const roles = new Set<string>();
    flow.walk(mbr.procedure.body, (n) => {
      if (n.kind === 'phase') {
        if (n.signatures.perform) roles.add(n.signatures.perform.role);
        if (n.signatures.check) roles.add(n.signatures.check.role);
      }
      if (n.kind === 'stage') roles.add(n.responsibleRole);
      if (n.kind === 'holdPoint') roles.add(n.role);
    });
    expect([...roles].sort()).toEqual(['PRODUCTION_OPERATOR', 'PRODUCTION_SUPERVISOR', 'PRODUCTION_VERIFIER', 'QA']);
  });

  it('[DI-05] defines as a batch for the SANDBOX once G-09@1 and G-10@1 are registered (C3); until then only they are missing', () => {
    const mbr = templateMbr();
    const registry = blocks.genericBlockRegistry();
    const ready = registry.get('G-09', '1') !== undefined && registry.get('G-10', '1') !== undefined;
    const define = (): engine.BatchDefinition => engine.defineBatch(mbr, { registry, installation: 'SANDBOX' } as engine.DefineOptions);
    if (ready) {
      expect(define().steps.size).toBe(14);
      return;
    }
    let problems: engine.DefinitionProblem[] = [];
    try {
      define();
    } catch (error) {
      problems = (error as { problems?: engine.DefinitionProblem[] }).problems ?? [];
    }
    expect(problems.map((p) => `${p.code}@${p.subject}`).sort()).toEqual(['ENG-DEF-BLOCK@p-blend-clear', 'ENG-DEF-BLOCK@p-blend-status', 'ENG-DEF-BLOCK@p-disp-bal', 'ENG-DEF-BLOCK@p-disp-clear']);
  });
});
