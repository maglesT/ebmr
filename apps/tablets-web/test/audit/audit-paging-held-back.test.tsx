/**
 * Review finding P11 (DI-22), the viewer side: a list across chains (here: one person's entries) can stop before
 * entries that an action in progress may yet add. A page that ends early (fewer entries than asked for, yet a next
 * cursor; empty or not) says so, keeps "Load more entries", and the next page brings the entries once the action has
 * finished, continuing from the same cursor.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import type { FetchLike } from '@ebmr/api-contract';
import { setTransport } from '../../src/api/client.ts';
import { routes as auditRoutes } from '../../src/features/audit/index.tsx';

const PERSON = '7a1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e11';

/** Renders the person view of the audit viewer with a transport that answers the entry lists in turn. */
function renderPersonView(answers: unknown[]): string[] {
  const asked: string[] = [];
  const transport: FetchLike = (url, init) => {
    const u = new URL(url, 'http://t.local');
    asked.push(`${init.method} ${u.pathname}${u.search}`);
    const body = u.pathname === '/api/audit/events' ? answers.shift() : undefined;
    if (!body) return Promise.resolve({ status: 404, headers: { get: () => null }, text: () => Promise.resolve('{}') });
    return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(body)) });
  };
  setTransport(transport);
  const root = createRootRoute({ component: Outlet });
  const router = createRouter({ routeTree: root.addChildren(auditRoutes(root)), history: createMemoryHistory({ initialEntries: [`/audit?person=${PERSON}`] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return asked;
}

describe('P11: a page held back by an action in progress', () => {
  afterEach(() => {
    cleanup();
  });

  it('[DI-22] a page that ends early with some entries says the rest are still being written; the note goes once the list is complete', async () => {
    const early = { ...EXAMPLES['audit-events'].data, nextCursor: '41' };
    expect(early.events.length).toBeGreaterThan(0);
    expect(early.events.length).toBeLessThan(100);
    const asked = renderPersonView([early, { events: [], nextCursor: null }]);

    expect(await screen.findByText('Step 2.1.4 Blend verified by TEST-Kavya Reddy (VERIFIED)')).toBeTruthy();
    expect(screen.getByText(/still being written by an action in progress/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Load more entries' }));
    await waitFor(() => {
      expect(screen.queryByText(/still being written by an action in progress/)).toBeNull();
    });
    expect(screen.queryByRole('button', { name: 'Load more entries' })).toBeNull();
    expect(asked).toEqual([`GET /api/audit/events?personId=${PERSON}&limit=100`, `GET /api/audit/events?personId=${PERSON}&cursor=41&limit=100`]);
  });

  it('[DI-22] an empty page with a next cursor says entries are still being written; "Load more" continues from the same cursor', async () => {
    const asked: string[] = [];
    const answers = [{ events: [], nextCursor: '41' }, EXAMPLES['audit-events'].data];
    const transport: FetchLike = (url, init) => {
      const u = new URL(url, 'http://t.local');
      asked.push(`${init.method} ${u.pathname}${u.search}`);
      const body = u.pathname === '/api/audit/events' ? answers.shift() : undefined;
      if (!body) return Promise.resolve({ status: 404, headers: { get: () => null }, text: () => Promise.resolve('{}') });
      return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(body)) });
    };
    setTransport(transport);
    const root = createRootRoute({ component: Outlet });
    const router = createRouter({ routeTree: root.addChildren(auditRoutes(root)), history: createMemoryHistory({ initialEntries: [`/audit?person=${PERSON}`] }) });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/still being written by an action in progress/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Load more entries' }));
    expect(await screen.findByText('Step 2.1.4 Blend verified by TEST-Kavya Reddy (VERIFIED)')).toBeTruthy();
    expect(screen.queryByText(/still being written by an action in progress/)).toBeNull();
    expect(asked).toEqual([`GET /api/audit/events?personId=${PERSON}&limit=100`, `GET /api/audit/events?personId=${PERSON}&cursor=41&limit=100`]);
  });
});
