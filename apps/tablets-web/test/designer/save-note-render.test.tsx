/**
 * The change note of a new revision is the save dialog's own state (the same fix as the justify dialog, commit
 * f9fe0d55): a keystroke in the note re-renders the dialog, not the whole designer editor behind it. Before, each key
 * re-rendered the editor (about 70 ms each), so typing a note was slow and timed out under load. The editor's renders
 * are counted through gateSummary, which the editor's toolbar calls on every render once a report is on screen.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flow } from '@ebmr/recipe-core/pure';
import type * as FindingsPanelModule from '../../src/features/designer/components/FindingsPanel.tsx';
import { DesignerEditor } from '../../src/features/designer/DesignerPage.tsx';
import { finding, fixtureVersion, installFixtures, PALETTE, PERSON_ID, renderRouted, report } from './support.tsx';

const renders = vi.hoisted(() => ({ editor: 0 }));
vi.mock('../../src/features/designer/components/FindingsPanel.tsx', async (importOriginal) => {
  const original = await importOriginal<typeof FindingsPanelModule>();
  return {
    ...original,
    gateSummary: (...args: Parameters<typeof original.gateSummary>) => {
      renders.editor += 1;
      return original.gateSummary(...args);
    },
  };
});

let notes: string[] = [];
beforeEach(() => {
  window.localStorage.clear();
  notes = [];
  installFixtures({
    'designer.validate': () => report([finding({ key: 'GMP-LIMITS@lod', rule: 'GMP-LIMITS', severity: 'WARNING', controls: ['PR-08'], section: '6', subjectPath: ['parameters', 'lod'], nodeId: null, message: 'A limit warning (GMP-LIMITS; PR-08)' })]),
    'designer.saveContent': ({ body }: { body: { content: flow.MbrContent; note: string } }) => {
      notes.push(body.note);
      return fixtureVersion({ revision: 4, content: body.content as never, contentHash: flow.mbrContentHash(body.content) });
    },
  });
});
afterEach(() => {
  window.localStorage.clear();
});

describe('the save dialog keeps its change note to itself', () => {
  it('[DI-04] typing the change note does not re-render the designer editor per key; the note typed is the note saved', async () => {
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    const title = await screen.findByRole('textbox', { name: 'Title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Renamed title{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Save revision…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save revision 4' });
    // The check of the edited content has answered (the toolbar shows a report), so the editor is settled.
    await waitFor(() => expect(renders.editor).toBeGreaterThan(0), { timeout: 5_000 });
    const NOTE = 'Title corrected after review';
    const field = within(dialog).getByRole('textbox', { name: /Change note/ });
    const before = renders.editor;
    await userEvent.type(field, NOTE);
    // Per key the editor rendered once before the fix (28 keys, 28 renders or more); now at most a stray settle.
    expect(renders.editor - before).toBeLessThanOrEqual(2);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save revision' }));
    await waitFor(() => expect(notes).toEqual([NOTE]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('[DI-04] a reopened save dialog starts with an empty note', async () => {
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    const title = await screen.findByRole('textbox', { name: 'Title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Renamed title{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Save revision…' }));
    let dialog = await screen.findByRole('dialog', { name: 'Save revision 4' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Change note/ }), 'half a note');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Save revision…' }));
    dialog = await screen.findByRole('dialog', { name: 'Save revision 4' });
    expect(within(dialog).getByRole('textbox', { name: /Change note/ })).toHaveProperty('value', '');
  });
});
