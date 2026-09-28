import { useParams } from '@tanstack/react-router';

/** The current route's path parameters as text (the route tree is composed at run time, so they are untyped). */
export function useRouteParams(): Readonly<Record<string, string | undefined>> {
  const params: unknown = useParams({ strict: false });
  return (typeof params === 'object' && params !== null ? params : {}) as Readonly<Record<string, string | undefined>>;
}
