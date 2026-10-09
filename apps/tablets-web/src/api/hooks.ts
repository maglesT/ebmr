/**
 * TanStack Query over the typed client, for GET routes only (reads). Commands and anything that carries a
 * credential, a PIN or a proof are called directly with `api.call` in event handlers and never enter a query
 * or mutation cache (plan section 4). No optimistic GMP updates: after a command, invalidate the affected keys.
 */
import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import type { AnyRoute, CallError, CallInput, RouteResponse } from '@ebmr/api-contract';
import { api } from './client.ts';

export class ApiError extends Error {
  constructor(readonly error: CallError) {
    super(error.kind === 'REFUSAL' ? error.envelope.refusal.whatHappened : error.kind);
    this.name = 'ApiError';
  }
}

/** The query key of a GET route and its inputs; invalidate by `[route.id]` to refetch every variant. */
export function queryKey<R extends AnyRoute>(route: R, input?: Pick<CallInput<R>, 'params' | 'query'>): readonly unknown[] {
  return [route.id, input?.params ?? {}, input?.query ?? {}];
}

export function useApiQuery<R extends AnyRoute>(
  route: R,
  input?: Pick<CallInput<R>, 'params' | 'query'>,
  options: Omit<UseQueryOptions<RouteResponse<R>, ApiError>, 'queryKey' | 'queryFn'> = {},
) {
  if (route.method !== 'GET') throw new Error(`useApiQuery is for GET routes; ${route.id} is ${route.method}`);
  return useQuery<RouteResponse<R>, ApiError>({
    ...options,
    queryKey: queryKey(route, input),
    queryFn: async ({ signal }) => {
      const r = await api.call(route, { ...(input ?? {}), signal } as CallInput<R>);
      if (!r.ok) throw new ApiError(r.error);
      return r.value;
    },
  });
}
