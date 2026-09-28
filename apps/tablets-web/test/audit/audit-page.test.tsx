/**
 * The audit trail viewer screens (module C1; plan section 11; DI-22, DI-23): the chain list, a chain's entries with
 * who, when and why, "Verify chain", and the deep-link helpers other modules use. Read-only: no control edits,
 * disables or removes anything.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import type { FetchLike } from '@ebmr/api-contract';
import { setTransport } from '../../src/api/client.ts';
import { auditHref, auditLink, routes as auditRoutes } from '../../src/features/audit/index.tsx';
import { parseAuditSearch } from '../../src/features/audit/links.ts';

const seen: string[] = [];
const transport: FetchLike = (url, init) => {
  const u = new URL(url, 'http://t.local');
  seen.push(`${init.method} ${u.pathname}${u.search}`);
  let body: unknown;
  if (u.pathname === '/api/audit/chains') body = { chains: [{ chainKey: 'batch:b2c3', label: 'Batch b2c3', events: 12, lastAt: { us: '1790586663000000', text: '28-SEP-2026 14:41:03 +05:30 (Asia/Kolkata)' } }] };
  else if (u.pathname === '/api/audit/events') body = EXAMPLES['audit-events'].data;
  else if (u.pathname.startsWith('/api/audit/chains/') && u.pathname.endsWith('/verify')) body = { chainKey: 'batch:b2c3', ok: true, events: 12, problems: [], verifiedAt: { us: '1790586663000000', text: '28-SEP-2026 14:41:03 +05:30 (Asia/Kolkata)' } };
  else return Promise.resolve({ status: 404, headers: { get: () => null }, text: () => Promise.resolve('{}') });
  return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(body)) });
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

beforeEach(() => {
  seen.length = 0;
  setTransport(transport);
});

describe('audit trail viewer', () => {
  it('[DI-22] the chain list links to each chain', async () => {
    renderAt('/audit');
    const link = await screen.findByRole('link', { name: 'Batch b2c3' });
    expect(link.getAttribute('href')).toBe('/audit?chain=batch%3Ab2c3');
    expect(screen.getByText(/12 entries/)).toBeTruthy();
  });

  it('[DI-22][DI-23] a chain shows its entries with who, when and why, and verifies the chain; nothing can be edited', async () => {
    renderAt('/audit?chain=batch%3Ab2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e');
    expect(await screen.findByText('Step 2.1.4 Blend verified by TEST-Kavya Reddy (VERIFIED)')).toBeTruthy();
    expect(screen.getAllByText(/Who: TEST-Kavya Reddy \(test-verifier-1\), VERIFIER · Terminal: TEST-KIOSK-BLEND-1/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/28-SEP-2026 14:41:03 \+05:30 \(Asia\/Kolkata\) · 2026-09-28 09:11:03\.000000 UTC/).length).toBeGreaterThan(0);
    expect(seen).toContain('GET /api/audit/events?chainKey=batch%3Ab2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e&limit=100');
    await userEvent.click(screen.getByRole('button', { name: 'Verify chain' }));
    expect(await screen.findByText('Chain intact: 12 entries verified')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /edit|delete|remove|disable|purge/i })).toBeNull();
    expect(seen.every((s) => s.startsWith('GET '))).toBe(true);
  });

  it('[DI-22] deep links for other screens: chain, command and person', () => {
    expect(auditLink({ chain: 'mbr_version:v-1' })).toEqual({ to: '/audit', search: { chain: 'mbr_version:v-1' } });
    expect(auditHref({ chain: 'batch:r-1' })).toBe('/audit?chain=batch%3Ar-1');
    expect(auditHref({ correlation: 'c-1', person: '' })).toBe('/audit?correlation=c-1');
    expect(auditHref()).toBe('/audit');
    expect(parseAuditSearch({ chain: 'batch:x', person: 5, correlation: '' })).toEqual({ chain: 'batch:x' });
  });
});
