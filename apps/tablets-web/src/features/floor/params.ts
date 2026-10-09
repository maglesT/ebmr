import { useParams, useSearch } from '@tanstack/react-router';

/** The current route's path parameters as text (the route tree is composed at run time, so they are untyped). */
export function useRouteParams(): Readonly<Record<string, string | undefined>> {
  const params: unknown = useParams({ strict: false });
  return (typeof params === 'object' && params !== null ? params : {}) as Readonly<Record<string, string | undefined>>;
}

/** The current location's search parameters as text (e.g. `package` on the packages inbox). */
export function useRouteSearch(): Readonly<Record<string, string | undefined>> {
  const search: unknown = useSearch({ strict: false });
  if (typeof search !== 'object' || search === null) return {};
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(search)) out[k] = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
  return out;
}
