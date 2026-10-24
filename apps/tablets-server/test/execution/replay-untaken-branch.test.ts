/**
 * Phase 7 slice 7o (found by the R4 browser run of a company's own product): a run with an alternative whose untaken
 * branch is not applicable replays identically. The replay check asked every phase of the state for its stored signable
 * content, excusing only one nobody had worked on yet (pending or enabled); a phase created not applicable is never
 * worked on either, so its content is never stored (storedOnCreation), and the sandbox test run of the copied
 * wet-granulation master (the supervisor's choice of no extra fluid, no rework) was exported as not passed. Every other
 * content check stands: a stored content that is not the state's, or a stored aggregate not in the state, still fails.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execution } from '@ebmr/recipe-core';
import { runContext } from '../../src/features/execution/runs.ts';
import { dcMiniVariant, importAndIssue, startExecServer, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

describe('the replay of a run with an untaken branch (slice 7o)', () => {
  it('[DI-37][INV-18] a run whose untaken branch is not applicable replays identically; its phase has no stored content and needs none', async () => {
    const content = dcMiniVariant((prep, c) => {
      (c['header'] as Record<string, unknown>)['variants'] = [{ id: 'booth', values: ['A', 'B'] }];
      const sop = prep.find((x) => x['id'] === 'p-disp-sop');
      if (!sop) throw new Error('SETUP: no SOP step');
      const alt = {
        kind: 'alternative', id: 'alt-booth', decision: { mode: 'ISSUE_VARIANT', variant: 'booth' },
        branches: [{ id: 'a', name: 'Booth A', variantValues: ['A'], body: { ...sop, id: 'p-alt-sop', name: 'Read the booth A SOP' } }, { id: 'b', name: 'Booth B', variantValues: ['B'] }],
      };
      return [alt, ...prep];
    });
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content), undefined, { booth: 'B' });
    const state = (await execution.loadState(sbx.db.admin, runId))?.state;
    expect(state?.steps['p-alt-sop@']?.status, 'SETUP: the untaken branch').toBe('NOT_APPLICABLE');
    const run = await runContext(sbx.db.admin, runId);
    const report = await execution.replayExecution(sbx.db.admin, run.def, runId);
    expect(report.contentProblems).toEqual([]);
    expect(report).toMatchObject({ identical: true, firstDifference: null, invariantViolations: [] });
  }, 300_000);
});
