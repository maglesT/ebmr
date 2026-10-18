/**
 * Reads of the floor (module C4): TanStack Query over GET routes only. Commands never go through a query or
 * mutation cache (their bodies carry attribution); after a command the affected reads are refreshed, and the
 * step view the server returned is put in place as is (the server's post-commit view, verdicts included), unless a
 * newer view of the step is already on show or the view was computed for someone other than the person signed in
 * now; a read of the step begun before the commit never replaces it.
 */
import { useQuery, useQueryClient, type QueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useEffect } from 'react';
import { routes, type AnyRoute, type CallInput, type RouteResponse, type StepScreenView } from '@ebmr/api-contract';
import { ApiError, queryKey } from '../../api/hooks.ts';
import { callRead } from './family.ts';
import { SESSION_CHANGE_EVENT, type SessionChangeDetail, type SignedInNow, type Viewer } from './session.tsx';

export const stepQueryKey = (runId: string, stepKey: string) => queryKey(routes.execution.step, { params: { runId, stepKey } });
export const runQueryKey = (runId: string) => queryKey(routes.execution.run, { params: { runId } });

/**
 * A floor read on this installation's route family (family.ts): the query key is the execution route's on both
 * installations, so invalidations and the post-commit view work the same; the request goes to /api/batches/* on GMP.
 */
export function useFloorRead<R extends AnyRoute>(
  route: R,
  input?: Pick<CallInput<R>, 'params' | 'query'>,
  options: Omit<UseQueryOptions<RouteResponse<R>, ApiError>, 'queryKey' | 'queryFn'> = {},
) {
  return useQuery<RouteResponse<R>, ApiError>({
    ...options,
    queryKey: queryKey(route, input),
    queryFn: async ({ signal }) => {
      const r = await callRead(route, { ...(input ?? {}), signal });
      if (!r.ok) throw new ApiError(r.error);
      return r.value;
    },
  });
}

export function useStepView(runId: string, stepKey: string) {
  return useFloorRead(routes.execution.step, { params: { runId, stepKey } }, { refetchInterval: 30_000 });
}

export function useRunView(runId: string) {
  return useFloorRead(routes.execution.run, { params: { runId } }, { refetchInterval: 30_000 });
}

/**
 * Whether a step view was computed for `who`: the server computes the "You" line and the actions (availability and
 * reasons) for the person signed in and the role they work as. A view naming nobody is nobody's (INV-40, DI-34).
 */
export function isViewFor(view: StepScreenView, who: Viewer | null): boolean {
  const identity = view.run.identity;
  return who !== null && who.personId !== null && identity !== null && identity.personId === who.personId && identity.role === who.role;
}

/**
 * Puts the server's post-commit step view in place, unless the cache already holds a newer view of that step (run
 * version). A read of the step still on its way is cancelled first: it may have been read before the commit, and
 * its answer would put the older view back until the next poll (DI-28).
 *
 * The view in a command's or a signature's answer was computed for the person who sent it. It is put in place only
 * while that person (and role) is still the one signed in, checked when the answer arrives and again right before it
 * is put, since the person can change while the read is cancelled: after a kiosk switch, lock or sign-out it would
 * show the next person the previous one's "You" line and actions (INV-40, DI-34; review P44).
 *
 * Returns whether the view was put in place; when it was not, the caller reads the step again.
 */
export async function applyStepView(qc: QueryClient, view: StepScreenView, signedInNow: SignedInNow): Promise<boolean> {
  if (!isViewFor(view, signedInNow())) return false;
  const key = stepQueryKey(view.run.runId, view.step.stepKey);
  await qc.cancelQueries({ queryKey: key });
  if (!isViewFor(view, signedInNow())) return false;
  const cached = qc.getQueryData<StepScreenView>(key);
  if (cached && cached.run.version > view.run.version) return false;
  qc.setQueryData(key, view);
  return true;
}

/** Refreshes everything a command on a run may have changed (the step itself too, unless its view came back). */
export async function refreshRun(qc: QueryClient, opts: { steps: boolean }): Promise<void> {
  const ids = [routes.execution.run.id, routes.execution.runs.id, routes.execution.workQueue.id, routes.batches.workQueue.id, routes.execution.timeline.id, ...(opts.steps ? [routes.execution.step.id] : [])];
  await Promise.all(ids.map((id) => qc.invalidateQueries({ queryKey: [id] })));
}

/** Every read of the floor screens. */
export const FLOOR_READS = [
  routes.execution.step.id,
  routes.execution.run.id,
  routes.execution.runs.id,
  routes.execution.workQueue.id,
  routes.execution.timeline.id,
  routes.execution.lot.id,
  routes.execution.issueForm.id,
  routes.execution.testPackages.id,
] as const;

/**
 * After an unlock, the floor reads again what the record holds: while the session was locked every read was
 * refused, and an answer to an entry sent before the lock may have arrived meanwhile (DI-28). A change of person
 * drops every cached read at the app level (app/session-reads.tsx), so no screen shows what was computed for the
 * previous person.
 */
export function useRefreshReadsAfterUnlock(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<Partial<SessionChangeDetail> | undefined>).detail;
      if (detail?.reason !== 'UNLOCK') return;
      for (const id of FLOOR_READS) void qc.invalidateQueries({ queryKey: [id] });
    };
    window.addEventListener(SESSION_CHANGE_EVENT, listener);
    return () => window.removeEventListener(SESSION_CHANGE_EVENT, listener);
  }, [qc]);
}

/** Mounts useRefreshReadsAfterUnlock (inside the floor Provider). */
export function RefreshReadsAfterUnlock(): null {
  useRefreshReadsAfterUnlock();
  return null;
}
