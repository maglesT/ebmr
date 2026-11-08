/**
 * Demo finding D-3: the designer offers "Discard draft…" on a DRAFT version only; the dialog sends the author's reason
 * (code DRAFT_DISCARDED and the typed text) and waits for it; the version the server answers is shown, read-only.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesignerEditor } from '../../src/features/designer/DesignerPage.tsx';
import { fixtureVersion, installFixtures, PALETTE, PERSON_ID, renderRouted, report } from './support.tsx';

let sent: { params: unknown; body: unknown }[] = [];

beforeEach(() => {
  window.localStorage.clear();
  sent = [];
  installFixtures({
    'designer.validate': () => report([]),
    'designer.discardDraft': ({ params, body }: { params: unknown; body: unknown }) => {
      sent.push({ params, body });
      return { ...fixtureVersion(), state: 'WITHDRAWN' };
    },
  });
});
afterEach(() => {
  window.localStorage.clear();
});

describe('discard a draft (demo finding D-3)', () => {
  it('[DI-22][DI-24] the author discards a DRAFT with a reason: the button waits for the reason, the request carries it, and the version is then read-only', async () => {
    const v = fixtureVersion();
    renderRouted(() => <DesignerEditor initial={v} palette={PALETTE} personId={PERSON_ID} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Discard draft…' }, { timeout: 5_000 }));
    const dialog = await screen.findByRole('dialog', { name: /Discard draft/ });
    const confirm = within(dialog).getByRole('button', { name: 'Discard the draft' });
    expect(confirm.hasAttribute('disabled') || confirm.getAttribute('data-disabled') === 'true').toBe(true);
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Why is this draft discarded?' }), 'Started from the wrong template.');
    await userEvent.click(confirm);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ params: { versionId: v.versionId }, body: { reason: { code: 'DRAFT_DISCARDED', text: 'Started from the wrong template.' } } });
    expect(await screen.findByText(/This version is WITHDRAWN: it can no longer be edited/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Discard draft…' })).toBeNull();
  });

  it('[DI-24] a version that is not a DRAFT offers no discard', async () => {
    renderRouted(() => <DesignerEditor initial={{ ...fixtureVersion(), state: 'APPROVED' }} palette={PALETTE} personId={PERSON_ID} />);
    expect(await screen.findByText(/This version is APPROVED/, undefined, { timeout: 5_000 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Discard draft…' })).toBeNull();
  });
});
