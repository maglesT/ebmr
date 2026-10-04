/**
 * "Verify chain" shows only the answer of the latest verification (Phase 2 exit review F07; DI-23): while a
 * verification runs, and after one that fails (a refusal or a server that cannot be reached), no earlier "Chain
 * intact" verdict or its "Verified at" line stays on screen beside it. Control: a second answer "broken" replaces it.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import type { FetchLike } from '@ebmr/api-contract';
import { setTransport } from '../../src/api/client.ts';
import { routes as auditRoutes } from '../../src/features/audit/index.tsx';

const CHAIN = 'batch:b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const AT1 = { us: '1790586663000000', text: '28-SEP-2026 14:41:03 +05:30 (Asia/Kolkata)' };
const AT2 = { us: '1790586723000000', text: '28-SEP-2026 14:42:03 +05:30 (Asia/Kolkata)' };
const INTACT = 'Chain intact: 12 entries verified';
const NOT_FOUND = 'This audit chain has no entry this session is shown on this installation.';

type Second = 'refused' | 'network' | 'broken';
let verifyCalls = 0;
let second: Second = 'refused';
let release: (() => void) | null = null;

const respond = (status: number, body: unknown) => Promise.resolve({ status, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(body)) });

const transport: FetchLike = async (url) => {
  const u = new URL(url, 'http://t.local');
  if (u.pathname === '/api/audit/events') return respond(200, EXAMPLES['audit-events'].data);
  if (u.pathname.startsWith('/api/audit/chains/') && u.pathname.endsWith('/verify')) {
    verifyCalls += 1;
    if (verifyCalls === 1) return respond(200, { chainKey: CHAIN, ok: true, events: 12, problems: [], verifiedAt: AT1 });
    // The second verification waits until the test releases it.
    await new Promise<void>((r) => {
      release = r;
    });
    if (second === 'network') throw new TypeError('Failed to fetch');
    if (second === 'broken') return respond(200, { chainKey: CHAIN, ok: false, events: 12, problems: ['entry 7: hash mismatch'], verifiedAt: AT2 });
    return respond(404, {
      refusal: { code: 'AUDIT_CHAIN_NOT_FOUND', kind: 'STALE', whatHappened: NOT_FOUND, why: `No entry of chain ${CHAIN} is shown to this session: none was written on it here, or it is not shown to this session.`, controls: ['DI-22'], whatYouCanDo: [], whoCanHelp: [] },
      correlationId: 'c',
      retryable: false,
    });
  }
  return respond(404, {});
};

function renderAt(path: string) {
  const root = createRootRoute({ component: Outlet });
  const router = createRouter({ routeTree: root.addChildren(auditRoutes(root)), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** Verifies once (intact), starts a second verification and checks the screen while it runs. */
async function verifyTwice(): Promise<void> {
  renderAt(`/audit?chain=${encodeURIComponent(CHAIN)}`);
  await userEvent.click(await screen.findByRole('button', { name: 'Verify chain' }));
  expect(await screen.findByText(INTACT)).toBeTruthy();
  expect(screen.getByText(`Verified at ${AT1.text}`)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Verify chain' }));
  await waitFor(() => expect(release).not.toBeNull());
  expect(screen.getByRole('button', { name: 'Verifying…' })).toBeTruthy();
  expect(screen.queryByText(INTACT), 'an earlier verdict while verifying again').toBeNull();
  expect(screen.queryByText(`Verified at ${AT1.text}`)).toBeNull();
  release?.();
}

beforeEach(() => {
  verifyCalls = 0;
  release = null;
  setTransport(transport);
});

describe('F07: Verify chain shows only the answer of the latest verification', () => {
  it('[DI-23] a re-verification the server refuses (404) leaves no "Chain intact" beside the refusal', async () => {
    second = 'refused';
    await verifyTwice();
    expect(await screen.findByText(NOT_FOUND)).toBeTruthy();
    expect(screen.queryByText(INTACT)).toBeNull();
    expect(screen.queryByText(`Verified at ${AT1.text}`)).toBeNull();
  });

  it('[DI-23] a re-verification that cannot reach the server leaves no "Chain intact" beside the error', async () => {
    second = 'network';
    await verifyTwice();
    expect(await screen.findByText(/The server could not be reached/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Verify chain' })).toBeTruthy();
    expect(screen.queryByText(INTACT)).toBeNull();
    expect(screen.queryByText(`Verified at ${AT1.text}`)).toBeNull();
  });

  it('[DI-23] control: a re-verification answering "broken" replaces the verdict', async () => {
    second = 'broken';
    await verifyTwice();
    expect(await screen.findByText('Chain broken: 1 problem(s)')).toBeTruthy();
    expect(screen.getByText('entry 7: hash mismatch')).toBeTruthy();
    expect(screen.queryByText(INTACT)).toBeNull();
  });
});
