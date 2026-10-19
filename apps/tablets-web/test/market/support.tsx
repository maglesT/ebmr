/**
 * Test harness for the slice 7g WP3 screens: the market, master-records and designer features' routes in a memory router
 * on the GMP installation, the contract examples through the fixture fetch, a recording transport, a fake ceremony and
 * the session's role (as test/office/support.tsx, with the market feature).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { FetchLike, SessionView } from '@ebmr/api-contract';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import { apiState, setTransport } from '../../src/api/client.ts';
import { fixturesFromExamples } from '../../src/api/examples.ts';
import { createFixtureFetch, type FixtureMap } from '../../src/api/fixture-fetch.ts';
import { BadgeTapPortProvider, CeremonyPortProvider } from '../../src/app/ports.tsx';
import * as designer from '../../src/features/designer/index.tsx';
import * as market from '../../src/features/market/index.tsx';
import * as masterRecords from '../../src/features/master-records/index.tsx';
import { fakeTap, signedCeremony, type Recorded } from '../office/support.tsx';

const describeAny = ({ body }: { body: unknown }) => {
  const a = (body as { action: { kind: string } }).action;
  return { kind: a.kind, aggregateType: 'test_aggregate', aggregateId: 'test-id', meaning: 'TEST_MEANING', expectedState: null };
};

export function renderMarket(path: string, opts: { fixtures?: FixtureMap; role?: string; ceremony?: ReturnType<typeof signedCeremony> } = {}) {
  apiState.installation = 'GMP';
  const requests: Recorded[] = [];
  const session = { ...(EXAMPLES['session-office'].data as SessionView), ...(opts.role ? { role: opts.role, roles: [opts.role] } : {}) };
  const fixtures = createFixtureFetch({ ...fixturesFromExamples('GMP'), 'esig.describe': describeAny, 'session.get': session, ...(opts.fixtures ?? {}) }, { installation: 'GMP' });
  const transport: FetchLike = async (url, init) => {
    const u = new URL(url, 'http://fixture.local');
    requests.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams.entries()), body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
    return fixtures(url, init);
  };
  setTransport(transport);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const tree = root.addChildren([...market.routes(root), ...masterRecords.routes(root), ...designer.routes(root)]);
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
  const ceremony = opts.ceremony ?? signedCeremony();
  const utils = render(
    <QueryClientProvider client={qc}>
      <CeremonyPortProvider value={ceremony}>
        <BadgeTapPortProvider value={fakeTap()}>
          <RouterProvider router={router} />
        </BadgeTapPortProvider>
      </CeremonyPortProvider>
    </QueryClientProvider>,
  );
  const posts = (p: string) => requests.filter((r) => r.method === 'POST' && r.path === p);
  return { ...utils, requests, ceremony, posts };
}
