/**
 * What the floor reads again after an act (R10 #7, owner's rabeprazole demo): a QA disposition given from one screen left
 * another step's card offering "Disposition the exception (QA)" (Sign was then refused, the exception being closed;
 * DI-26), and the run overview showed its "N open" marks for a few seconds. After each act every step and run read other
 * than the view the server returned is read again, and a read not on screen now is dropped, so it is never shown again
 * as it was before the act.
 */
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { StepScreenView } from '@ebmr/api-contract';
import { refreshRun, runQueryKey, stepQueryKey } from '../../src/features/floor/queries.ts';
import { RUN_ID, stepVariant } from './support.tsx';

const at = (stepKey: string): StepScreenView =>
  stepVariant('step-g04-parameters', (v) => {
    v.step.stepKey = stepKey;
  });

describe('the reads after an act on a run', () => {
  it('[DI-34] keeps the step view the act returned, reads the steps on screen again and drops the step and run reads not on screen', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const returned = at('p-blend@');
    const shown = at('p-disp-clear@');
    const reads: string[] = [];
    const fetchOf = (name: string, data: unknown) => () => {
      reads.push(name);
      return Promise.resolve(data);
    };
    // The step whose view came back with the act, and a step on screen (each with an observer, as a mounted screen has).
    qc.setQueryData(stepQueryKey(RUN_ID, 'p-blend@'), returned);
    const keep = new QueryObserver(qc, { queryKey: stepQueryKey(RUN_ID, 'p-blend@'), queryFn: fetchOf('returned', returned), staleTime: Infinity });
    const keepOff = keep.subscribe(() => undefined);
    qc.setQueryData(stepQueryKey(RUN_ID, 'p-disp-clear@'), shown);
    const onScreen = new QueryObserver(qc, { queryKey: stepQueryKey(RUN_ID, 'p-disp-clear@'), queryFn: fetchOf('shown', shown), staleTime: Infinity });
    const onScreenOff = onScreen.subscribe(() => undefined);
    // A step and the run read earlier and not on screen now: their cached answers predate the act.
    qc.setQueryData(stepQueryKey(RUN_ID, 'p-g21@'), at('p-g21@'));
    qc.setQueryData(runQueryKey(RUN_ID), { exceptions: [{ exceptionId: 'EX-1', status: 'OPEN' }] });

    await refreshRun(qc, { steps: true, keep: returned });

    expect(reads).toEqual(['shown']);
    expect(qc.getQueryData(stepQueryKey(RUN_ID, 'p-blend@'))).toBe(returned);
    expect(qc.getQueryState(stepQueryKey(RUN_ID, 'p-blend@'))?.isInvalidated).toBe(false);
    expect(qc.getQueryData(stepQueryKey(RUN_ID, 'p-g21@'))).toBeUndefined();
    expect(qc.getQueryData(runQueryKey(RUN_ID))).toBeUndefined();
    keepOff();
    onScreenOff();
  });
});
