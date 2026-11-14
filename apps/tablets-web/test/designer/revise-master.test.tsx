/**
 * Demo report r13 bug 2: the designer offers "Start a new version…" on an APPROVED or RETIRED version and "Return to
 * draft…" on a version in verification, submitted or checked. Each dialog waits for the person's reason and sends it;
 * the new version is opened, and a returned version is editable again.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VersionView } from '@ebmr/api-contract';
import { DesignerEditor } from '../../src/features/designer/DesignerPage.tsx';
import { fixtureVersion, installFixtures, PALETTE, PERSON_ID, renderRouted, report } from './support.tsx';

const NEW_ID = '7c0e7f1e-3b0a-4f3e-9d5b-2a1c4e6f8a90';
let sent: { route: string; params: unknown; body: unknown }[] = [];

beforeEach(() => {
  window.localStorage.clear();
  sent = [];
  installFixtures({
    'designer.validate': () => report([]),
    'designer.deriveVersion': ({ params, body }: { params: unknown; body: unknown }) => {
      sent.push({ route: 'derive', params, body });
      return { ...fixtureVersion(), versionId: NEW_ID, number: '2', state: 'DRAFT' };
    },
    'designer.returnToDraft': ({ params, body }: { params: unknown; body: unknown }) => {
      sent.push({ route: 'return', params, body });
      return { ...fixtureVersion(), state: 'DRAFT' };
    },
  });
});
afterEach(() => {
  window.localStorage.clear();
});

const disabled = (b: HTMLElement) => b.hasAttribute('disabled') || b.getAttribute('data-disabled') === 'true';

describe('revising an approved master and returning a version to draft (demo report r13, bug 2)', () => {
  it('[PR-06][DI-22] an APPROVED version offers "Start a new version…": the dialog waits for the reason, sends it and opens the new DRAFT', async () => {
    const v: VersionView = { ...fixtureVersion(), state: 'APPROVED' };
    const root = createRootRoute({ component: () => <DesignerEditor initial={v} palette={PALETTE} personId={PERSON_ID} /> });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Return to draft…' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Start a new version…' }, { timeout: 5_000 }));
    const dialog = await screen.findByRole('dialog', { name: /Start a new version/ });
    const confirm = within(dialog).getByRole('button', { name: 'Start the new version' });
    expect(disabled(confirm)).toBe(true);
    await userEvent.type(within(dialog).getByRole('textbox', { name: /What changes, and why/ }), 'Blend yield basis corrected, CR-2026-031');
    await userEvent.click(confirm);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ route: 'derive', params: { versionId: v.versionId }, body: { reason: { code: 'MBR_REVISION', text: 'Blend yield basis corrected, CR-2026-031' } } });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/mbr/versions/${NEW_ID}`));
  });

  it('[DI-22][DI-37] a version IN VERIFICATION offers "Return to draft…": the dialog waits for the reason, sends it, and the version is editable again', async () => {
    renderRouted(() => <DesignerEditor initial={{ ...fixtureVersion(), state: 'IN_VERIFICATION' }} palette={PALETTE} personId={PERSON_ID} />);
    expect(await screen.findByText(/This version is IN VERIFICATION/, undefined, { timeout: 5_000 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start a new version…' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Return to draft…' }));
    const dialog = await screen.findByRole('dialog', { name: /Return version .* to draft/ });
    const confirm = within(dialog).getByRole('button', { name: 'Return to draft' });
    expect(disabled(confirm)).toBe(true);
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Why is this version returned to draft?' }), 'Golden case G-BLEND-YIELD needs the new input');
    await userEvent.click(confirm);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ route: 'return', params: { versionId: fixtureVersion().versionId }, body: { reason: { code: 'RETURNED_TO_DRAFT', text: 'Golden case G-BLEND-YIELD needs the new input' } } });
    await waitFor(() => expect(screen.queryByText(/This version is IN VERIFICATION/)).toBeNull());
    expect(screen.getByRole('button', { name: 'Discard draft…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Return to draft…' })).toBeNull();
  });

  it('[PR-06] a DRAFT offers neither; a WITHDRAWN version offers neither', async () => {
    const { unmount } = renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    expect(await screen.findByRole('button', { name: 'Discard draft…' }, { timeout: 5_000 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start a new version…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Return to draft…' })).toBeNull();
    unmount();
    renderRouted(() => <DesignerEditor initial={{ ...fixtureVersion(), state: 'WITHDRAWN' }} palette={PALETTE} personId={PERSON_ID} />);
    expect(await screen.findByText(/This version is WITHDRAWN/, undefined, { timeout: 5_000 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start a new version…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Return to draft…' })).toBeNull();
  });

  it('[DI-04] a DRAFT\'s golden case is edited on screen (demo report r13, bug 3): a value changed and an input added make the version unsaved', async () => {
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    const value = await screen.findByRole('textbox', { name: 'Expected granYield in G-GRAN-YIELD' }, { timeout: 5_000 });
    expect((value as HTMLInputElement).value).toBe('98.05 %');
    await userEvent.clear(value);
    await userEvent.type(value, '98.10 %{Enter}');
    expect(await screen.findByText('Unsaved changes')).toBeTruthy();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Item to add to G-GRAN-YIELD' }), 'batchSizeTablets');
    await userEvent.type(screen.getByRole('textbox', { name: 'Value with unit for G-GRAN-YIELD' }), '200000');
    await userEvent.click(screen.getByRole('button', { name: 'Add to G-GRAN-YIELD' }));
    expect(await screen.findByRole('textbox', { name: 'Given batchSizeTablets in G-GRAN-YIELD' })).toBeTruthy();
  });

  it('[DI-04][PR-06] an APPROVED version shows its golden cases read-only', async () => {
    renderRouted(() => <DesignerEditor initial={{ ...fixtureVersion(), state: 'APPROVED' }} palette={PALETTE} personId={PERSON_ID} />);
    expect(await screen.findByRole('table', { name: 'Golden case G-GRAN-YIELD' }, { timeout: 5_000 })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Expected granYield in G-GRAN-YIELD' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to G-GRAN-YIELD' })).toBeNull();
  });
});
