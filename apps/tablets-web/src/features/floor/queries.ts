/**
 * Reads of the floor (module C4): TanStack Query over GET routes only. Commands never go through a query or
 * mutation cache (their bodies carry attribution); after a command the affected reads are refreshed, and the
 * step view the server returned is put in place as is (the server's post-commit view, verdicts included).
 */
import type { QueryClient } from '@tanstack/react-query';
import { routes, type StepScreenView } from '@ebmr/api-contract';
import { queryKey, useApiQuery } from '../../api/hooks.ts';

export const stepQueryKey = (runId: string, stepKey: string) => queryKey(routes.execution.step, { params: { runId, stepKey } });
export const runQueryKey = (runId: string) => queryKey(routes.execution.run, { params: { runId } });

export function useStepView(runId: string, stepKey: string) {
  return useApiQuery(routes.execution.step, { params: { runId, stepKey } }, { refetchInterval: 30_000 });
}

export function useRunView(runId: string) {
  return useApiQuery(routes.execution.run, { params: { runId } }, { refetchInterval: 30_000 });
}

/** Puts the server's post-commit step view in place. */
export function applyStepView(qc: QueryClient, view: StepScreenView): void {
  qc.setQueryData(stepQueryKey(view.run.runId, view.step.stepKey), view);
}

/** Refreshes everything a command on a run may have changed (the step itself too, unless its view came back). */
export async function refreshRun(qc: QueryClient, opts: { steps: boolean }): Promise<void> {
  const ids = [routes.execution.run.id, routes.execution.runs.id, routes.execution.workQueue.id, routes.execution.timeline.id, ...(opts.steps ? [routes.execution.step.id] : [])];
  await Promise.all(ids.map((id) => qc.invalidateQueries({ queryKey: [id] })));
}
