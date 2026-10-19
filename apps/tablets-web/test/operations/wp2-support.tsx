/**
 * Test harness of the screens of slice 7g, work package 2: the operations, administration, integrations and transfers
 * routes in a memory router, answers from the contract's examples and the test's own fixtures, a recording transport, a
 * fake ceremony (it signs) and a fake badge tap. No server.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { FetchLike, SessionView } from '@ebmr/api-contract';
import { EXAMPLES, example } from '@ebmr/api-contract/examples';
import { apiState, setTransport } from '../../src/api/client.ts';
import { fixturesFromExamples } from '../../src/api/examples.ts';
import { createFixtureFetch, type FixtureMap } from '../../src/api/fixture-fetch.ts';
import { BadgeTapPortProvider, CeremonyPortProvider, type BadgeTapPort, type SignatureCeremonyPort } from '../../src/app/ports.tsx';
import * as administration from '../../src/features/administration/index.tsx';
import * as integrations from '../../src/features/integrations/index.tsx';
import * as operations from '../../src/features/operations/index.tsx';
import * as transfers from '../../src/features/transfers/index.tsx';

export interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

export const ME = '0b8f1c2a-1111-4c7d-8e9f-0a1b2c3d4e01';

/** The session of person ME in `role` on an office PC. */
export function sessionIn(role: string, personId = ME): SessionView {
  const base = EXAMPLES['session-office'].data as SessionView;
  return { ...base, person: { ...base.person, personId, role }, role, roles: [role] };
}

export function render7g(path: string, opts: { role: string; installation?: 'GMP' | 'SANDBOX'; fixtures?: FixtureMap; personId?: string }) {
  const installation = opts.installation ?? 'GMP';
  apiState.installation = installation;
  const requests: Recorded[] = [];
  const describeAny = ({ body }: { body: unknown }) => {
    const a = (body as { action: { kind: string } }).action;
    return { kind: a.kind, aggregateType: 'test_aggregate', aggregateId: 'test-id', meaning: 'TEST_MEANING', expectedState: null };
  };
  const fixtures = createFixtureFetch({ ...fixturesFromExamples(installation), 'esig.describe': describeAny, 'session.get': sessionIn(opts.role, opts.personId), ...(opts.fixtures ?? {}) }, { installation });
  const transport: FetchLike = async (url, init) => {
    const u = new URL(url, 'http://fixture.local');
    requests.push({ method: init.method, path: u.pathname, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
    return fixtures(url, init);
  };
  setTransport(transport);
  const ceremony = {
    sign: vi.fn((req: Parameters<SignatureCeremonyPort['sign']>[0]) => {
      void req;
      return Promise.resolve({ status: 'SIGNED' as const, manifestation: example('manifestation'), result: null });
    }),
  } satisfies SignatureCeremonyPort;
  const tap = {
    requestTap: vi.fn(() => Promise.resolve({ method: 'BADGE_TAP' as const, badgeUid: 'TEST-BADGE-1', proof: { spki: 'AAAA', nonce: 'nonce-0123456789abcdef', sig: 'AAAA' } })),
    offerSwitch: vi.fn(() => Promise.resolve(false)),
  } satisfies BadgeTapPort;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const tree = root.addChildren([...operations.routes(root), ...administration.routes(root), ...integrations.routes(root), ...transfers.routes(root)]);
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
  const utils = render(
    <QueryClientProvider client={qc}>
      <CeremonyPortProvider value={ceremony}>
        <BadgeTapPortProvider value={tap}>
          <RouterProvider router={router} />
        </BadgeTapPortProvider>
      </CeremonyPortProvider>
    </QueryClientProvider>,
  );
  const posts = (p: string) => requests.filter((r) => r.method === 'POST' && r.path === p);
  return { ...utils, requests, ceremony, posts };
}
