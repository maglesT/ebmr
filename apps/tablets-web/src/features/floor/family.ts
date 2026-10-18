/**
 * The one switch between the two route families of the floor (Phase 3 slice 6, D-S6-1): a GMP installation answers
 * `/api/batches/*` (namespace `batches`), the sandbox `/api/test-runs/*` (namespace `execution`); each answers 404 for
 * the other's. Both mount the same handlers and return the same views, so the screens keep one set of query keys (the
 * execution route ids) and only the request goes to the installation's own family. The installation is the one the
 * server's meta reported at start-up (apiState.installation), fixed for the life of the page.
 */
import { routes, type AnyRoute, type CallInput, type Result, type RouteResponse } from '@ebmr/api-contract';
import { api, apiState } from '../../api/client.ts';

/** This page runs on the GMP installation (else the sandbox, or not known yet: the sandbox family). */
export function isGmpFloor(): boolean {
  return apiState.installation === 'GMP';
}

/** Execution (sandbox) read -> the batches (GMP) read with the same view, and how its path parameters are renamed. */
const GMP_READS: Readonly<Record<string, AnyRoute>> = {
  [routes.execution.runs.id]: routes.batches.list,
  [routes.execution.run.id]: routes.batches.batch,
  [routes.execution.step.id]: routes.batches.step,
  [routes.execution.timeline.id]: routes.batches.timeline,
};

/** `runId` is the GMP batch's `batchId` (a GMP batch's id is its run id). */
export function gmpParams(params: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!params) return params;
  const { runId, ...rest } = params;
  return runId === undefined ? rest : { ...rest, batchId: runId };
}

/** The route a floor read goes to on this installation (the execution route itself on the sandbox). */
export function readRoute(route: AnyRoute): AnyRoute {
  return isGmpFloor() ? (GMP_READS[route.id] ?? route) : route;
}

/** Calls a floor read on this installation's family (same response schema on both). */
export async function callRead<R extends AnyRoute>(route: R, input: Pick<CallInput<R>, 'params' | 'query'> & { signal?: AbortSignal }): Promise<Result<RouteResponse<R>>> {
  const target = readRoute(route);
  if (target === route) return api.call(route, input as CallInput<R>);
  const params = gmpParams(input.params as Record<string, string> | undefined);
  const r = (await api.call(target, { ...input, ...(params ? { params } : {}) })) as unknown as Result<RouteResponse<R>>;
  // The one view whose wrapper differs: the batches list answers `{ batches }` where the test runs answer `{ runs }`
  // (the same RunSummaryView items). Without this the GMP floor's runs page read `runs` of nothing and failed
  // (slice 7d, found by the accessibility audit: A11Y-4).
  if (r.ok && route.id === routes.execution.runs.id) {
    const { batches } = r.value as unknown as { batches: unknown };
    return { ...r, value: { runs: batches } as unknown as RouteResponse<R> };
  }
  return r;
}

/** The command route of a run on this installation and its path parameters. */
export function commandRoute(runId: string): { route: typeof routes.execution.command; params: { runId: string } } {
  if (!isGmpFloor()) return { route: routes.execution.command, params: { runId } };
  // Same body and response schema (CommandResultView); only the path and its parameter name differ.
  return { route: routes.batches.command as unknown as typeof routes.execution.command, params: { batchId: runId } as unknown as { runId: string } };
}
