/**
 * Test harness of the operations screens (Phase 7 slice 7g-4): the operations and integrations routes in a memory router,
 * answers from the contract's examples and the test's own fixtures, a recording transport. No server.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { FetchLike, Instant, SessionView } from '@ebmr/api-contract';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import { apiState, setTransport } from '../../src/api/client.ts';
import { fixturesFromExamples } from '../../src/api/examples.ts';
import { createFixtureFetch, type FixtureMap } from '../../src/api/fixture-fetch.ts';
import * as integrations from '../../src/features/integrations/index.tsx';
import * as operations from '../../src/features/operations/index.tsx';

export interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

export const at = (us: string): Instant => ({ us, text: `18-OCT-2026 10:${us.slice(-2)}:00 +05:30 (Asia/Kolkata)` });

export function refusalAnswer(status: number, code: string, whatHappened: string, why = '') {
  return { status, body: { refusal: { code, kind: 'NOT_ALLOWED', whatHappened, why, controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 'test', retryable: false } };
}

export function renderOperations(path: string, opts: { installation?: 'GMP' | 'SANDBOX'; fixtures?: FixtureMap } = {}) {
  const installation = opts.installation ?? 'GMP';
  apiState.installation = installation;
  const requests: Recorded[] = [];
  const session = { ...(EXAMPLES['session-office'].data as SessionView), role: 'SYSTEM_ADMINISTRATOR', roles: ['SYSTEM_ADMINISTRATOR'] };
  const fixtures = createFixtureFetch({ ...fixturesFromExamples(installation), 'session.get': session, ...(opts.fixtures ?? {}) }, { installation });
  const transport: FetchLike = async (url, init) => {
    const u = new URL(url, 'http://fixture.local');
    requests.push({ method: init.method, path: u.pathname, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
    return fixtures(url, init);
  };
  setTransport(transport);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const tree = root.addChildren([...operations.routes(root), ...integrations.routes(root)]);
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
  const utils = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const posts = (p: string) => requests.filter((r) => r.method === 'POST' && r.path === p);
  return { ...utils, requests, posts };
}
