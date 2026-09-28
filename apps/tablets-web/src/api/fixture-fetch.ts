/**
 * createFixtureFetch (plan section 4; module C4 works against it before the sandbox server exists): a FetchLike
 * that answers contract routes from example fixtures, with the installation header, so the screens run on the
 * same typed client and schemas as against the live server.
 */
import { allRoutes, routes, type AnyRoute, type FetchLike, type InstallationKind } from '@ebmr/api-contract';

/** A response body, or {status, body} for another status than 200. */
export type FixtureAnswer = unknown;
export type FixtureHandler = (req: { params: Record<string, string>; query: Record<string, string>; body: unknown }) => FixtureAnswer;
/** Route id -> a fixed answer or a function of the request. */
export type FixtureMap = Readonly<Record<string, unknown>>;

function matcher(route: AnyRoute): { re: RegExp; names: string[] } {
  const names: string[] = [];
  const re = new RegExp(`^${route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, n: string) => {
    names.push(n);
    return '([^/]+)';
  })}$`);
  return { re, names };
}

const isAnswer = (v: unknown): v is { status: number; body: unknown } => typeof v === 'object' && v !== null && 'status' in v && 'body' in v;

export function createFixtureFetch(fixtures: FixtureMap, opts: { installation: InstallationKind; delayMs?: number }): FetchLike {
  const table = allRoutes(routes).map((r) => ({ route: r, ...matcher(r) }));
  return async (url, init) => {
    const u = new URL(url, 'http://fixture.local');
    const hit = table.find((t) => t.route.method === init.method && t.re.test(u.pathname));
    const headers = { get: (n: string) => (n.toLowerCase() === 'x-ebmr-installation' ? opts.installation : null) };
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (!hit || !(hit.route.id in fixtures)) {
      const envelope = { refusal: { code: 'NOT_FOUND', kind: 'NOT_ENABLED', whatHappened: `No fixture for ${init.method} ${u.pathname}.`, why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 'fixture', retryable: false };
      return { status: 404, headers, text: () => Promise.resolve(JSON.stringify(envelope)) };
    }
    const m = hit.re.exec(u.pathname);
    const params = Object.fromEntries(hit.names.map((n, i) => [n, decodeURIComponent(m?.[i + 1] ?? '')]));
    const query = Object.fromEntries(u.searchParams.entries());
    const body: unknown = init.body ? JSON.parse(init.body) : undefined;
    const entry = fixtures[hit.route.id];
    const answer = typeof entry === 'function' ? (entry as FixtureHandler)({ params, query, body }) : entry;
    const { status, body: payload } = isAnswer(answer) ? answer : { status: 200, body: answer };
    return { status, headers, text: () => Promise.resolve(JSON.stringify(payload)) };
  };
}
