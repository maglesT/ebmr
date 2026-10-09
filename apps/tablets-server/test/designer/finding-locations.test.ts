/**
 * Where a validator finding is placed in the designer document (findings.ts; review F46). The validator names the
 * steps a library call brings in by their expanded id ("call/inner", as flow.numberMbr numbers them and the document
 * shows their rows), so a finding on such a step must lead to that row (section 8, node "call/inner"), not to the
 * title section with no place to go.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flow, validator } from '@ebmr/recipe-core/pure';
import granulation from '../../../../packages/recipe-core/test/fixtures/tablet-granulation-compression.mbr.json' with { type: 'json' };
import { loadValidationContext } from '../../src/features/designer/adapters/expressions.ts';
import { findingViews, locateFinding } from '../../src/features/designer/findings.ts';
import type { TestServer } from '../support/harness.ts';
import { startDesignerServer } from './support.ts';

let server: TestServer;

beforeAll(async () => {
  server = await startDesignerServer();
});
afterAll(async () => {
  await server?.close();
});

/** The granulation fixture with the step of library element LIB-LOD given a risk class outside the scale (re-pinned). */
function libraryStepWithFinding(): flow.MbrContent {
  const r = flow.parseMbr(structuredClone(granulation));
  if (!r.ok) throw new Error('fixture does not parse');
  const c = r.mbr;
  const element = c.library.find((e) => e.ref === 'LIB-LOD');
  const ref = c.references.find((x) => x.id === 'LIB-LOD');
  if (!element || element.body.kind !== 'phase' || !ref) throw new Error('fixture changed: no LIB-LOD element');
  element.body.riskClass = 'NOT-ON-THE-SCALE';
  ref.hash = flow.libraryElementHash(element);
  return c;
}

describe('finding locations in the designer document (review F46)', () => {
  it('[PR-02][DI-34] a finding of the validator on a step a library call brings in leads to that step\'s row (section 8, node "c-lod/lod-test")', async () => {
    const c = libraryStepWithFinding();
    const { context } = await loadValidationContext(server.db.app, c);
    const report = validator.validateMbr(c, context);
    const onStep = report.findings.filter((f) => f.subject === 'c-lod/lod-test');
    expect(onStep.map((f) => f.rule)).toContain('GMP-RISK');
    const views = findingViews(c, onStep, new Map());
    for (const v of views) {
      expect(v.section).toBe('8');
      expect(v.nodeId).toBe('c-lod/lod-test');
      expect(v.subjectPath.at(-1)).toBe('c-lod/lod-test');
      expect(v.subjectPath).toContain('c-lod');
    }
  });

  it('[PR-02] the library call itself and the steps of the procedure keep their places; the element\'s own body has no row to jump to', () => {
    const c = libraryStepWithFinding();
    expect(locateFinding(c, { rule: 'FLOW-LIBRARY', subject: 'c-lod' })).toEqual(expect.objectContaining({ section: '8', nodeId: 'c-lod' }));
    expect(locateFinding(c, { rule: 'GMP-RISK', subject: 'p-drymix' })).toEqual(expect.objectContaining({ section: '8', nodeId: 'p-drymix' }));
    expect(locateFinding(c, { rule: 'GMP-RISK', subject: 'lod-test' })).toEqual({ section: '8', subjectPath: ['library', 'LIB-LOD', 'lod-test'], nodeId: null });
  });
});
