/**
 * A run or step link copied with a sentence's full stop or comma (Phase 2 exit review F65). The not-found page of
 * 2b752ea helped only addresses that match no route: "/runs/<id>." matched the run route and got the server's "The
 * request was not in the expected form... Reload the page and try again" (400 SCHEMA, which a reload cannot fix), and
 * "/runs/<id>/steps/p-disp-clear@." got a step screen for a key no step can have. A floor address whose run id is not a
 * run id, or whose step key is not in the engine's form, is now the not-found page, which offers the address without
 * the punctuation; nothing is asked of the server for it.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { isRunId, isStepKey } from '../../src/features/floor/index.tsx';
import { renderFloor, RUN_ID, stepPath } from './support.tsx';

const offer = () => screen.getByRole('link', { name: /^Open .* instead/ }).getAttribute('href');

describe('a floor link with a sentence\'s punctuation (F65)', () => {
  it('[DI-34] a run link with a full stop is the not-found page offering the run, and asks the server nothing about it', async () => {
    const ui = renderFloor(`/runs/${RUN_ID}.`);
    expect(await screen.findByTestId('not-found')).toBeTruthy();
    expect(offer()).toBe(`/runs/${RUN_ID}`);
    expect(ui.requests.filter((r) => r.path.startsWith(`/api/test-runs/${RUN_ID}`))).toEqual([]);
  });

  it('[DI-34] a step link with a full stop is the not-found page offering the step, not a step screen', async () => {
    const ui = renderFloor(`${stepPath('p-disp-clear@')}.`);
    expect(await screen.findByTestId('not-found')).toBeTruthy();
    expect(decodeURIComponent(offer() ?? '')).toBe(`/runs/${RUN_ID}/steps/p-disp-clear@`);
    expect(screen.queryByTestId('step-card')).toBeNull();
    expect(ui.requests.filter((r) => r.path.includes('/steps/'))).toEqual([]);
  });

  it('[DI-34] the real step link still opens its step screen', async () => {
    renderFloor(stepPath('p-disp-clear@'));
    expect(await screen.findByTestId('step-card')).toBeTruthy();
    expect(screen.queryByTestId('not-found')).toBeNull();
  });

  it('[DI-34] a run id is a UUID; a step key is in the engine\'s own form', () => {
    expect([RUN_ID, `${RUN_ID}.`, 'abc'].map(isRunId)).toEqual([true, false, false]);
    expect(['p-disp-clear@', 'p-mix@loop=0', 'p-mix@sec=2/loop=10', 'p-disp-clear@.', 'p-disp-clear@,', 'p-mix@loop=0.', 'p-mix@loop=01', 'p-mix@loop=0/', '@', 'p-disp-clear'].map(isStepKey)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
