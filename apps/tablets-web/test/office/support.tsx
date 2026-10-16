/**
 * Test harness for the Phase 3 slice 6 office screens (planning, master data, plant, quality, "Choose a product"): the
 * features' routes in a memory router on the GMP installation, the contract examples through the fixture fetch, a
 * recording transport, a fake ceremony and the session's role. No server: every answer is an example or a test's own.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { FetchLike, RefusalEnvelope, SessionView } from '@ebmr/api-contract';
import { EXAMPLES, example } from '@ebmr/api-contract/examples';
import { apiState, setTransport } from '../../src/api/client.ts';
import { fixturesFromExamples } from '../../src/api/examples.ts';
import { createFixtureFetch, type FixtureMap } from '../../src/api/fixture-fetch.ts';
import { BadgeTapPortProvider, CeremonyPortProvider, type BadgeTapPort, type SignatureCeremonyPort } from '../../src/app/ports.tsx';
import * as designer from '../../src/features/designer/index.tsx';
import * as masterData from '../../src/features/master-data/index.tsx';
import * as planning from '../../src/features/planning/index.tsx';
import * as plant from '../../src/features/plant/index.tsx';
import * as quality from '../../src/features/quality/index.tsx';
import * as records from '../../src/features/records/index.tsx';
import * as pqr from '../../src/features/pqr/index.tsx';
import * as capa from '../../src/features/capa/index.tsx';
import * as config from '../../src/features/config/index.tsx';
import * as genealogy from '../../src/features/genealogy/index.tsx';
import * as governance from '../../src/features/governance/index.tsx';
import * as india from '../../src/features/india/index.tsx';
import * as integrations from '../../src/features/integrations/index.tsx';
import * as notifications from '../../src/features/notifications/index.tsx';
import * as release from '../../src/features/release/index.tsx';
import * as review from '../../src/features/review/index.tsx';

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

export function refusal(code: string, whatHappened: string, why = ''): { status: number; body: RefusalEnvelope } {
  return { status: 409, body: { refusal: { code, kind: 'NOT_ALLOWED', whatHappened, why, controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 'test', retryable: false } };
}

export function signedCeremony() {
  return {
    sign: vi.fn((req: Parameters<SignatureCeremonyPort['sign']>[0]) => {
      void req;
      return Promise.resolve({ status: 'SIGNED' as const, manifestation: example('manifestation'), result: null });
    }),
  } satisfies SignatureCeremonyPort;
}

export interface OfficeOptions {
  fixtures?: FixtureMap;
  role?: string;
  ceremony?: ReturnType<typeof signedCeremony>;
  /** The session's attribution: TAP models a shared kiosk (default NONE, an office PC). */
  attribution?: 'NONE' | 'TAP';
}

export const TAPPED = { method: 'BADGE_TAP' as const, badgeUid: 'TEST-BADGE-1', proof: { spki: 'AAAA', nonce: 'nonce-0123456789abcdef', sig: 'AAAA' } };

export function fakeTap() {
  return {
    requestTap: vi.fn((reason: string, request: { method: string; path: string; body: Record<string, unknown> }) => {
      void reason;
      void request;
      return Promise.resolve(TAPPED);
    }),
    offerSwitch: vi.fn(() => Promise.resolve(false)),
  } satisfies BadgeTapPort;
}

/** The descriptor the server would give for any action (tests that check it give their own). */
const describeAny = ({ body }: { body: unknown }) => {
  const a = (body as { action: { kind: string } }).action;
  return { kind: a.kind, aggregateType: 'test_aggregate', aggregateId: 'test-id', meaning: 'TEST_MEANING', expectedState: null };
};

export function renderOffice(path: string, opts: OfficeOptions = {}) {
  apiState.installation = 'GMP';
  const requests: Recorded[] = [];
  const session = { ...(EXAMPLES['session-office'].data as SessionView), ...(opts.role ? { role: opts.role, roles: [opts.role] } : {}), ...(opts.attribution ? { attribution: opts.attribution } : {}) };
  const fixtures = createFixtureFetch({ ...fixturesFromExamples('GMP'), 'esig.describe': describeAny, 'session.get': session, ...(opts.fixtures ?? {}) }, { installation: 'GMP' });
  const transport: FetchLike = async (url, init) => {
    const u = new URL(url, 'http://fixture.local');
    requests.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams.entries()), body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
    return fixtures(url, init);
  };
  setTransport(transport);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const root = createRootRoute({ component: () => <Outlet /> });
  const tree = root.addChildren([...planning.routes(root), ...masterData.routes(root), ...plant.routes(root), ...quality.routes(root), ...review.routes(root), ...release.routes(root), ...notifications.routes(root), ...designer.routes(root), ...records.routes(root), ...pqr.routes(root), ...india.routes(root), ...capa.routes(root), ...config.routes(root), ...integrations.routes(root), ...governance.routes(root), ...genealogy.routes(root)]);
  const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: [path] }) });
  const ceremony = opts.ceremony ?? signedCeremony();
  const tap = fakeTap();
  const utils = render(
    <QueryClientProvider client={qc}>
      <CeremonyPortProvider value={ceremony}>
        <BadgeTapPortProvider value={tap}>
          <RouterProvider router={router} />
        </BadgeTapPortProvider>
      </CeremonyPortProvider>
    </QueryClientProvider>,
  );
  const posts = (path: string) => requests.filter((r) => r.method === 'POST' && r.path === path);
  return { ...utils, requests, ceremony, tap, posts };
}
