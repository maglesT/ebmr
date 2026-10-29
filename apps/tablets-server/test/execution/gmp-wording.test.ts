/**
 * Slice 7u (R10 #10; owner demo of 25 October 2026): on a GMP batch the weighing's lot hint said "(TEST- lots only)" and
 * a refusal said "recorded in the test run". The guidance the GMP installation serves speaks of the batch, the sandbox
 * keeps its own wording, and the entry forms' hints name TEST- lots and batches in the sandbox only.
 */
import { describe, expect, it } from 'vitest';
import { engine } from '@ebmr/recipe-core';
import { rtwProcessingContent } from '../../src/cli/demo-route-masters.ts';
import { EXPRESSIONS } from '../../src/features/designer/adapters/expressions.ts';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../src/features/edition-blocks.ts';
import { EXECUTION_GUIDANCE } from '../../src/features/execution/guidance.ts';
import { entryFormsOf } from '../../src/features/execution/views.ts';
import { forInstallation, GuidanceCatalogue } from '../../src/platform/http/guidance.ts';

const catalogue = (installation: 'GMP' | 'SANDBOX'): GuidanceCatalogue => {
  const c = new GuidanceCatalogue(installation);
  c.register('execution', EXECUTION_GUIDANCE);
  return c;
};

describe('no sandbox wording on the GMP installation (R10 #10)', () => {
  it('[DI-05][DI-34] a GMP refusal of the engine says the refusal is recorded in the batch; the sandbox says the test run', () => {
    expect(catalogue('GMP').lookup('ENG-ORDER')?.whatHappened).toBe('The batch rules do not allow this now. The refusal is recorded in the batch; nothing else changed.');
    expect(catalogue('SANDBOX').lookup('ENG-ORDER')?.whatHappened).toMatch(/recorded in the test run/);
    // Every execution guidance the GMP installation serves is free of "test run" naming the batch at hand.
    const gmp = catalogue('GMP');
    for (const code of gmp.codes()) {
      const e = gmp.lookup(code);
      const text = [e?.whatHappened ?? '', ...(e?.whatYouCanDo ?? [])].join(' ').replace(/sandbox test runs?|test runs? in the sandbox/gi, '');
      expect(text, code).not.toMatch(/\btest runs?\b/i);
    }
    // The sandbox's own test runs keep their name where the text speaks of them.
    expect(forInstallation('Issue GMP batches on the GMP installation and test runs in the sandbox.', 'GMP')).toBe('Issue GMP batches on the GMP installation and test runs in the sandbox.');
    expect(forInstallation('Export the result from the run page of the sandbox test run.', 'GMP')).toBe('Export the result from the run page of the sandbox test run.');
    expect(forInstallation('Test runs and the test run.', 'GMP')).toBe('Batches and the batch.');
  });

  it('[DI-05] the weighing lot hint and the previous batch hint name TEST- lots and batches in the sandbox only', () => {
    const def = engine.defineBatch(rtwProcessingContent('RTW-WG-TEST', ['IN']), { registry: tabletsBlockRegistry(), catalog: tabletsBlockCatalog, expressions: EXPRESSIONS, installation: 'GMP', justifications: [] });
    const hints = (installation: 'GMP' | 'SANDBOX'): string[] =>
      [...def.steps.values()].flatMap((s) => entryFormsOf(def, s, installation)).flatMap((f) => f.fields.map((x) => x.description ?? ''));
    expect(hints('GMP').filter((h) => /TEST-|test batch/.test(h))).toEqual([]);
    expect(hints('GMP')).toContain('Scan the lot label');
    expect(hints('SANDBOX')).toContain('Scan the lot label (TEST- lots only)');
  });
});
