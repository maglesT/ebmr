/**
 * Test harness of the validation and records screens (Phase 7 slice 7g-3): the feature's routes in a memory router on
 * the GMP installation, the test's own answers through the fixture fetch, a recording transport and a fake ceremony. No
 * server.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { FetchLike, Instant, SessionView } from '@ebmr/api-contract';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import { apiState, setTransport } from '../../src/api/client.ts';
import { fixturesFromExamples } from '../../src/api/examples.ts';
import { createFixtureFetch, type FixtureMap } from '../../src/api/fixture-fetch.ts';
import { CeremonyPortProvider } from '../../src/app/ports.tsx';
import * as validation from '../../src/features/validation/index.tsx';
import { signedCeremony } from '../office/support.tsx';

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

export const at = (us: string): Instant => ({ us, text: `18-OCT-2026 10:${us.slice(-2)}:00 +05:30 (Asia/Kolkata)` });
export const SHA = 'a'.repeat(64);
export const SHA2 = 'b'.repeat(64);

/** The descriptor the server would give for any action (tests that check it give their own). */
const describeAny = ({ body }: { body: unknown }) => {
  const a = (body as { action: { kind: string } }).action;
  return { kind: a.kind, aggregateType: 'test_aggregate', aggregateId: 'test-id', meaning: 'TEST_MEANING', expectedState: null };
};

export function renderValidation(path: string, opts: { fixtures?: FixtureMap; role?: string } = {}) {
  apiState.installation = 'GMP';
  const requests: Recorded[] = [];
  const role = opts.role ?? 'QA_REVIEWER';
  const session = { ...(EXAMPLES['session-office'].data as SessionView), role, roles: [role] };
  const fixtures = createFixtureFetch({ ...fixturesFromExamples('GMP'), 'esig.describe': describeAny, 'session.get': session, ...(opts.fixtures ?? {}) }, { installation: 'GMP' });
  const transport: FetchLike = async (url, init) => {
    const u = new URL(url, 'http://fixture.local');
    requests.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams.entries()), body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
    return fixtures(url, init);
  };
  setTransport(transport);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({ routeTree: root.addChildren(validation.routes(root)), history: createMemoryHistory({ initialEntries: [path] }) });
  const ceremony = signedCeremony();
  const utils = render(
    <QueryClientProvider client={qc}>
      <CeremonyPortProvider value={ceremony}>
        <RouterProvider router={router} />
      </CeremonyPortProvider>
    </QueryClientProvider>,
  );
  const posts = (p: string) => requests.filter((r) => r.method === 'POST' && r.path === p);
  const gets = (p: string) => requests.filter((r) => r.method === 'GET' && r.path === p);
  return { ...utils, requests, posts, gets, ceremony };
}
