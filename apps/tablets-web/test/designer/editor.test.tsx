/**
 * The designer screen in the browser (module C2), against fixture answers: findings mapped to document locations
 * and jumping there, limits edited as decimal text through DecimalField, keyboard editing with undo, the unsaved
 * draft (decision D7) and saving a revision with its change note and stale-revision refusal.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flow } from '@ebmr/recipe-core/pure';
import { DesignerEditor } from '../../src/features/designer/DesignerPage.tsx';
import { clearAllDrafts, draftKey, legacyDraftKey, loadDraft, saveDraft } from '../../src/features/designer/model/draft.ts';
import { finding, fixtureContent, fixtureVersion, installFixtures, PALETTE, PERSON_ID, renderRouted, report, VERSION_ID } from './support.tsx';

let validated: unknown[] = [];

function fixtures(extra: Record<string, unknown> = {}): void {
  validated = [];
  installFixtures({
    'designer.validate': ({ body }: { body: { content: unknown } }) => {
      validated.push(body.content);
      return report([
        finding({ key: 'GMP-STAGE-CLEARANCE@p-disp-clear', nodeId: 'p-disp-clear', subjectPath: ['procedure', 'S-DISP', 'p-disp-clear'], message: 'Clearance problem (GMP-STAGE-CLEARANCE; PR-03)' }),
        finding({ key: 'GMP-LIMITS@lod', rule: 'GMP-LIMITS', severity: 'WARNING', controls: ['PR-08'], section: '6', subjectPath: ['parameters', 'lod'], nodeId: null, message: 'A limit warning (GMP-LIMITS; PR-08)' }),
      ]);
    },
    ...extra,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  fixtures();
});
afterEach(() => {
  window.localStorage.clear();
});

const lastValidated = (): flow.MbrContent => validated.at(-1) as flow.MbrContent;

describe('designer screen', () => {
  it('[PR-03] findings are grouped by document section and jump to their place in the document', async () => {
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    const panel = await screen.findByRole('region', { name: 'Findings in section 8 Procedure' }, { timeout: 10000 });
    expect(screen.getByRole('region', { name: 'Findings in section 6 Parameters and limits' })).toBeTruthy();
    expect(within(panel).getByText('Clearance problem (GMP-STAGE-CLEARANCE; PR-03)')).toBeTruthy();
    const row = document.getElementById('mbr-node-p-disp-clear') as HTMLElement;
    expect(row.getAttribute('data-severity')).toBe('ERROR');
    await userEvent.click(within(panel).getByRole('button', { name: /Go to step 1\.1\.1/ }));
    expect(await screen.findByRole('heading', { name: /Step 1\.1\.1: Clear the room or line/ })).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('mbr-node-p-disp-clear'));
    await userEvent.click(screen.getByRole('tab', { name: /Findings/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Go to parameters \/ lod \(section 6\)/ }));
    await waitFor(() => expect(document.activeElement?.id).toBe('mbr-item-lod'));
  });

  it('[PR-08] a limit is edited as decimal text; letters are not accepted and nothing but a decimal string enters the content', async () => {
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    const field = await screen.findByRole('textbox', { name: 'Loss on drying of granules, validated, upper limit' });
    expect((field as HTMLInputElement).value).toBe('3.5');
    await userEvent.clear(field);
    await userEvent.type(field, '3.6x0');
    expect((field as HTMLInputElement).value).toBe('3.60');
    fireEvent.blur(field);
    await waitFor(() => {
      const high = lastValidated()?.parameters.find((p) => p.id === 'lod')?.limits?.ranges.find((r) => r.tier === 'VALIDATED')?.high;
      expect(high).toEqual({ value: '3.60', inclusive: true });
    });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    await userEvent.clear(field);
    await userEvent.type(field, '3.');
    fireEvent.blur(field);
    expect(await screen.findByText(/decimal/i, { selector: '[slot="errorMessage"], [class*="error"]' })).toBeTruthy();
  });

  it('edits the procedure by keyboard: Delete removes the step, Ctrl+Z brings it back, Alt+Arrow moves it', async () => {
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    const row = await screen.findByRole('row', { name: /Step 1\.1\.1 Dispensing booth clearance/ });
    act(() => row.focus());
    fireEvent.keyDown(row, { key: 'Delete' });
    await waitFor(() => expect(document.getElementById('mbr-node-p-disp-clear')).toBeNull());
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(document.getElementById('mbr-node-p-disp-clear')).not.toBeNull());
    const again = document.getElementById('mbr-node-p-disp-clear') as HTMLElement;
    act(() => again.focus());
    fireEvent.keyDown(again, { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(screen.getByRole('row', { name: /Step 1\.1\.2 Dispensing booth clearance/ })).toBeTruthy());
    await waitFor(() => {
      const ids: string[] = [];
      flow.walk(lastValidated().procedure.body, (n) => {
        if (n.kind === 'phase') ids.push(n.id);
      });
      expect(ids.slice(0, 2)).toEqual(['p-disp-bal', 'p-disp-clear']);
    });
  });

  it('[DI-04] a read-only version (not a DRAFT) cannot be edited', async () => {
    renderRouted(() => <DesignerEditor initial={fixtureVersion({ state: 'IN_VERIFICATION' })} palette={PALETTE} personId={PERSON_ID} />);
    expect(await screen.findByText(/This version is IN VERIFICATION: it can no longer be edited/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save revision…' }).hasAttribute('disabled') || screen.getByRole('button', { name: 'Save revision…' }).getAttribute('data-disabled') === 'true').toBe(true);
    expect(screen.queryByRole('textbox', { name: 'Loss on drying of granules, validated, upper limit' })).toBeNull();
  });
});

describe('unsaved draft (decision D7)', () => {
  it('keeps only the unsaved content, keyed by person, version and base revision; nothing else is stored', async () => {
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    const title = await screen.findByRole('textbox', { name: 'Title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Edited title{Enter}');
    await waitFor(() => expect(window.localStorage.getItem(draftKey(PERSON_ID, VERSION_ID))).not.toBeNull());
    const stored = JSON.parse(window.localStorage.getItem(draftKey(PERSON_ID, VERSION_ID)) as string) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['baseHash', 'baseRevision', 'content', 'format', 'formatVersion', 'personId', 'versionId']);
    expect(stored['baseRevision']).toBe(3);
    expect(stored['personId']).toBe(PERSON_ID);
    const content = stored['content'] as flow.MbrContent;
    expect(content.header.title).toBe('Edited title');
    expect(flow.parseMbr(content).ok).toBe(true);
    // The content is MBR content only (the model's members), with no version state, evidence records,
    // justification records, signature records, credentials or tokens anywhere in the stored value.
    expect(Object.keys(content).sort()).toEqual(Object.keys(fixtureContent()).sort());
    for (const k of ['state', 'justifications', 'savedBy', 'contentHash', 'signatureId', 'manifestation', 'csrfToken', 'password', 'pin', 'secret', 'token']) {
      expect(JSON.stringify(stored)).not.toContain(`"${k}":`);
    }
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith('ebmr'))).toEqual([draftKey(PERSON_ID, VERSION_ID)]);
  });

  it('offers a stored draft, and a restored draft is labelled UNSAVED until saved', async () => {
    const content = fixtureContent();
    content.header.title = 'Draft from yesterday';
    saveDraft({ personId: PERSON_ID, versionId: VERSION_ID, baseRevision: 3, baseHash: fixtureVersion().contentHash, content });
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    expect(await screen.findByText('Unsaved changes from an earlier session were found in this browser.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Restore unsaved changes' }));
    expect(await screen.findByText('UNSAVED (restored draft)')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Draft from yesterday');
  });

  it('a draft based on an older revision cannot be applied, only discarded', async () => {
    saveDraft({ personId: PERSON_ID, versionId: VERSION_ID, baseRevision: 2, baseHash: 'b'.repeat(64), content: fixtureContent() });
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    expect(await screen.findByText('An unsaved draft in this browser is out of date.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restore unsaved changes' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Discard the old draft' }));
    expect(window.localStorage.getItem(draftKey(PERSON_ID, VERSION_ID))).toBeNull();
  });
});

describe('a leftover draft and who may see it (review F50)', () => {
  const LIMITS = 'table[aria-label="Limits of Loss on drying of granules"]';
  const OTHER_AUTHOR = '0b9a8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d';
  const CHECKER = '5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716';

  /** Unsaved edits of revision 3 (title and the LOD upper limit 9.9 instead of the saved 3.5), made by `personId`. */
  function storeDraft(personId: string): void {
    const draft = fixtureContent();
    draft.header.title = 'Unsaved edits of another author';
    const high = draft.parameters.find((p) => p.id === 'lod')?.limits?.ranges.find((r) => r.tier === 'VALIDATED')?.high;
    if (!high) throw new Error('fixture changed');
    high.value = '9.9';
    saveDraft({ personId, versionId: VERSION_ID, baseRevision: 3, baseHash: fixtureVersion().contentHash, content: draft });
  }

  async function showsTheSavedContent(): Promise<void> {
    await waitFor(() => expect(document.querySelector(LIMITS)).not.toBeNull());
    expect(document.querySelector(LIMITS)?.textContent ?? '').not.toContain('9.9');
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toContain('Unsaved edits of another author');
    expect(screen.queryByRole('button', { name: 'Restore unsaved changes' })).toBeNull();
  }

  for (const state of ['IN_VERIFICATION', 'APPROVED'] as const) {
    it(`[DI-04][PR-02] a checker opening an ${state} version on the PC where an author left unsaved edits sees the saved content, never the draft`, async () => {
      storeDraft(OTHER_AUTHOR);
      renderRouted(() => <DesignerEditor initial={fixtureVersion({ state })} palette={PALETTE} personId={CHECKER} />);
      expect(await screen.findByText(/it can no longer be edited/)).toBeTruthy();
      await showsTheSavedContent();
      expect(screen.queryByText(/unsaved changes/i)).toBeNull();
      // The author's draft is theirs: it stays under their id (it goes when someone signs out in this browser).
      expect(window.localStorage.getItem(draftKey(OTHER_AUTHOR, VERSION_ID))).not.toBeNull();
      expect(window.localStorage.getItem(draftKey(CHECKER, VERSION_ID))).toBeNull();
    });
  }

  it('[DI-04][PR-06] the author\'s own draft of a version that is no longer a DRAFT cannot be applied, only discarded', async () => {
    storeDraft(PERSON_ID);
    renderRouted(() => <DesignerEditor initial={fixtureVersion({ state: 'IN_VERIFICATION' })} palette={PALETTE} personId={PERSON_ID} />);
    expect(await screen.findByText('Your unsaved changes from an earlier session cannot be applied.')).toBeTruthy();
    expect(screen.getByText(/this version is IN VERIFICATION, no longer a DRAFT: what is shown is the saved revision 3/)).toBeTruthy();
    await showsTheSavedContent();
    expect(screen.queryByText('UNSAVED (restored draft)')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Discard them' }));
    expect(window.localStorage.getItem(draftKey(PERSON_ID, VERSION_ID))).toBeNull();
    expect(screen.queryByText('Your unsaved changes from an earlier session cannot be applied.')).toBeNull();
  });

  it('[PR-02][PR-06] another author opening the same DRAFT is not offered a colleague\'s unsaved edits', async () => {
    storeDraft(OTHER_AUTHOR);
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    expect(await screen.findByRole('textbox', { name: 'Title' })).toBeTruthy();
    await showsTheSavedContent();
    expect(screen.queryByText('Unsaved changes from an earlier session were found in this browser.')).toBeNull();
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('[PR-02] a draft stored under a person\'s key that names someone else, and a draft kept without its author (format 1), are dropped', () => {
    const content = fixtureContent();
    const forged = { format: 'ebmr.designer-draft', formatVersion: 2, personId: OTHER_AUTHOR, versionId: VERSION_ID, baseRevision: 3, baseHash: 'h', content };
    window.localStorage.setItem(draftKey(PERSON_ID, VERSION_ID), JSON.stringify(forged));
    window.localStorage.setItem(legacyDraftKey(VERSION_ID), JSON.stringify({ format: 'ebmr.designer-draft', formatVersion: 1, versionId: VERSION_ID, baseRevision: 3, baseHash: 'h', content }));
    expect(loadDraft(PERSON_ID, VERSION_ID)).toBeNull();
    expect(window.localStorage.getItem(draftKey(PERSON_ID, VERSION_ID))).toBeNull();
    expect(window.localStorage.getItem(legacyDraftKey(VERSION_ID))).toBeNull();
    // Without a signed-in person nothing is stored or offered.
    expect(saveDraft({ personId: '', versionId: VERSION_ID, baseRevision: 3, baseHash: 'h', content })).toBe(false);
    expect(loadDraft('', VERSION_ID)).toBeNull();
    // The person's own, well-formed draft is offered to them.
    saveDraft({ personId: PERSON_ID, versionId: VERSION_ID, baseRevision: 3, baseHash: 'h', content });
    expect(loadDraft(PERSON_ID, VERSION_ID)?.personId).toBe(PERSON_ID);
    expect(loadDraft(OTHER_AUTHOR, VERSION_ID)).toBeNull();
  });

  it('[PR-02] at sign-out every designer draft in the browser is removed, whoever made it; nothing else is touched', () => {
    storeDraft(PERSON_ID);
    storeDraft(OTHER_AUTHOR);
    window.localStorage.setItem(legacyDraftKey(VERSION_ID), '{}');
    window.localStorage.setItem('ebmr.somethingElse', 'kept');
    clearAllDrafts();
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith('ebmr.designer.draft.'))).toEqual([]);
    expect(window.localStorage.getItem('ebmr.somethingElse')).toBe('kept');
  });
});

describe('saving a revision', () => {
  it('[PR-06] saves with a change note, clears the draft; a stale revision is refused in plain language', async () => {
    let saves = 0;
    fixtures({
      'designer.saveContent': ({ body }: { body: { baseRevision: number; content: flow.MbrContent; note: string } }) => {
        saves += 1;
        if (saves === 1) {
          return {
            status: 409,
            body: {
              refusal: { code: 'DESIGNER_STALE', kind: 'STALE', whatHappened: 'Someone saved this version after you opened it; your change was not saved.', why: 'You edited revision 3; the saved revision is now 4.', controls: ['PR-06'], whatYouCanDo: ['Reload the version.'], whoCanHelp: [] },
              correlationId: 'c',
              retryable: true,
            },
          };
        }
        expect(body.note).toBe('Renamed');
        return fixtureVersion({ revision: 4, content: body.content as never, contentHash: flow.mbrContentHash(body.content) });
      },
    });
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} personId={PERSON_ID} />);
    const title = await screen.findByRole('textbox', { name: 'Title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Renamed title{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Save revision…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save revision 4' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Change note/ }), 'Renamed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save revision' }));
    expect(await within(dialog).findByText('Someone saved this version after you opened it; your change was not saved.')).toBeTruthy();
    expect(window.localStorage.getItem(draftKey(PERSON_ID, VERSION_ID))).not.toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save revision' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(window.localStorage.getItem(draftKey(PERSON_ID, VERSION_ID))).toBeNull();
  });
});
