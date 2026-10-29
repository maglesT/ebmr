/**
 * The links from a GMP batch's run and step screens (R10 #13, owner's rabeprazole demo): the output containers were
 * reachable only through a complaint lookup's forward trace, and a packaging order's line completion had no link from
 * its run. The run and the step link to the batch's containers; a packaging order's run also links to its line
 * completion and its bulk and finished lot. A sandbox test run has none of these screens.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunView } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { renderFloor, RUN_ID, stepFixtures, stepPath, stepVariant } from './support.tsx';

const runOf = (recordKind: 'PROCESSING' | 'PACKAGING'): RunView => {
  const r = structuredClone(example('run'));
  return { ...r, header: { ...r.header, runId: RUN_ID, recordKind } };
};

describe('links from a batch\'s run and step screens', () => {
  it('the run of a processing batch links to its output containers', async () => {
    const run = runOf('PROCESSING');
    renderFloor(`/runs/${RUN_ID}`, { installation: 'GMP', fixtures: { 'batches.batch': () => run, 'execution.run': run } });
    expect((await screen.findByTestId('containers-link')).getAttribute('href')).toBe(`/review/${RUN_ID}/containers`);
    expect(screen.queryByTestId('line-completion-link')).toBeNull();
  });

  it('the run of a packaging order links to its containers, its line completion and its bulk and finished lot', async () => {
    const run = runOf('PACKAGING');
    renderFloor(`/runs/${RUN_ID}`, { installation: 'GMP', fixtures: { 'batches.batch': () => run, 'execution.run': run } });
    expect((await screen.findByTestId('line-completion-link')).getAttribute('href')).toBe(`/labels/packaging/${RUN_ID}`);
    expect(screen.getByTestId('bulk-link').getAttribute('href')).toBe(`/planning/packaging/${RUN_ID}`);
    expect(screen.getByTestId('containers-link').getAttribute('href')).toBe(`/review/${RUN_ID}/containers`);
  });

  it('a step of a batch links to the batch\'s output containers', async () => {
    const view = stepVariant('step-g04-parameters', (v) => {
      v.run.recordKind = 'PROCESSING';
    });
    renderFloor(stepPath('p-blend@'), { installation: 'GMP', fixtures: { 'batches.step': () => view, ...stepFixtures(view) } });
    expect((await screen.findByTestId('containers-link')).getAttribute('href')).toBe(`/review/${view.run.runId}/containers`);
  });

  it('a sandbox test run has no containers or line completion screen to link to', async () => {
    renderFloor(`/runs/${RUN_ID}`, { fixtures: { 'execution.run': runOf('PACKAGING') } });
    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.queryByTestId('containers-link')).toBeNull();
    expect(screen.queryByTestId('line-completion-link')).toBeNull();
  });
});
