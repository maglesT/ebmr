/**
 * The page for an address the application does not have (app/not-found.tsx): it says so in plain words and, for a
 * link copied with a sentence's punctuation, offers the address without it. Found in the owner's demo run, where a
 * link ending in a full stop showed the router's bare "Not Found".
 */
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NotFoundPage, withoutTrailingPunctuation } from '../../src/app/not-found.tsx';
import { createAppRouter } from '../../src/app/router.tsx';

async function renderAt(path: string): Promise<void> {
  const root = createRootRoute({ component: Outlet, notFoundComponent: NotFoundPage });
  const floor = createRoute({ getParentRoute: () => root, path: '/floor', component: () => <p>floor</p> });
  const router = createRouter({ routeTree: root.addChildren([floor]), history: createMemoryHistory({ initialEntries: [path] }) });
  await router.load();
  render(<RouterProvider router={router} />);
}

describe('page not found', () => {
  it('a link with a sentence\'s full stop gets a plain page that offers the address without it', async () => {
    await renderAt('/floor.');
    expect(await screen.findByRole('heading', { name: 'This page does not exist' })).toBeTruthy();
    expect(screen.getByText('There is no page at /floor..')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open /floor instead (the address without the punctuation at its end)' }).getAttribute('href')).toBe('/floor');
    expect(screen.getByRole('link', { name: 'Go to the start page' }).getAttribute('href')).toBe('/');
  });

  it('an unknown address without trailing punctuation offers only the start page', async () => {
    await renderAt('/nowhere');
    expect(await screen.findByTestId('not-found')).toBeTruthy();
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/']);
  });

  it('the application router uses this page', () => {
    expect(createAppRouter().routeTree.options.notFoundComponent).toBe(NotFoundPage);
  });

  it('takes off only punctuation at the end, and never the whole path', () => {
    expect(withoutTrailingPunctuation('/floor.')).toBe('/floor');
    expect(withoutTrailingPunctuation('/floor/run/abc),')).toBe('/floor/run/abc');
    expect(withoutTrailingPunctuation('/floor/run/a.b')).toBeNull();
    expect(withoutTrailingPunctuation('/floor')).toBeNull();
    expect(withoutTrailingPunctuation('.')).toBeNull();
  });
});
