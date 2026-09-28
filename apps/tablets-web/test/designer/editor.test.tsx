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
import { draftKey, saveDraft } from '../../src/features/designer/model/draft.ts';
import { finding, fixtureContent, fixtureVersion, PALETTE, renderRouted, report, useFixtures, VERSION_ID } from './support.tsx';

let validated: unknown[] = [];

function fixtures(extra: Record<string, unknown> = {}): void {
  validated = [];
  useFixtures({
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
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} />);
    const panel = await screen.findByRole('region', { name: 'Findings in section 8 Procedure' }, { timeout: 10000 });
    expect(screen.getByRole('region', { name: 'Findings in section 6 Parameters and limits' })).toBeTruthy();
    expect(within(panel).getByText('Clearance problem (GMP-STAGE-CLEARANCE; PR-03)')).toBeTruthy();
    const row = document.getElementById('mbr-node-p-disp-clear') as HTMLElement;
    expect(row.getAttribute('data-severity')).toBe('ERROR');
    await userEvent.click(within(panel).getByRole('button', { name: /Go to step 1\.1\.1/ }));
    expect(await screen.findByRole('heading', { name: /Step 1\.1\.1: Clear the room or line/ })).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('mbr-node-p-disp-clear'));
    await userEvent.click(screen.getByRole('button', { name: /Go to parameters \/ lod \(section 6\)/ }));
  });

  it('[PR-08] a limit is edited as decimal text; letters are not accepted and nothing but a decimal string enters the content', async () => {
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} />);
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
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} />);
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
    renderRouted(() => <DesignerEditor initial={fixtureVersion({ state: 'IN_VERIFICATION' })} palette={PALETTE} />);
    expect(await screen.findByText(/This version is IN VERIFICATION: it can no longer be edited/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save revision…' }).hasAttribute('disabled') || screen.getByRole('button', { name: 'Save revision…' }).getAttribute('data-disabled') === 'true').toBe(true);
    expect(screen.queryByRole('textbox', { name: 'Loss on drying of granules, validated, upper limit' })).toBeNull();
  });
});

describe('unsaved draft (decision D7)', () => {
  it('keeps only the unsaved content, keyed by version and base revision; nothing else is stored', async () => {
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} />);
    const title = await screen.findByRole('textbox', { name: 'Title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Edited title{Enter}');
    await waitFor(() => expect(window.localStorage.getItem(draftKey(VERSION_ID))).not.toBeNull());
    const stored = JSON.parse(window.localStorage.getItem(draftKey(VERSION_ID)) as string) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['baseHash', 'baseRevision', 'content', 'format', 'formatVersion', 'versionId']);
    expect(stored['baseRevision']).toBe(3);
    const content = stored['content'] as flow.MbrContent;
    expect(content.header.title).toBe('Edited title');
    expect(flow.parseMbr(content).ok).toBe(true);
    // The content is MBR content only (the model's members), with no version state, evidence records,
    // justification records, signature records, credentials or tokens anywhere in the stored value.
    expect(Object.keys(content).sort()).toEqual(Object.keys(fixtureContent()).sort());
    for (const k of ['state', 'justifications', 'savedBy', 'contentHash', 'signatureId', 'manifestation', 'csrfToken', 'password', 'pin', 'secret', 'token']) {
      expect(JSON.stringify(stored)).not.toContain(`"${k}":`);
    }
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith('ebmr'))).toEqual([draftKey(VERSION_ID)]);
  });

  it('offers a stored draft, and a restored draft is labelled UNSAVED until saved', async () => {
    const content = fixtureContent();
    content.header.title = 'Draft from yesterday';
    saveDraft({ versionId: VERSION_ID, baseRevision: 3, baseHash: fixtureVersion().contentHash, content });
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} />);
    expect(await screen.findByText('Unsaved changes from an earlier session were found in this browser.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Restore unsaved changes' }));
    expect(await screen.findByText('UNSAVED (restored draft)')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Draft from yesterday');
  });

  it('a draft based on an older revision cannot be applied, only discarded', async () => {
    saveDraft({ versionId: VERSION_ID, baseRevision: 2, baseHash: 'b'.repeat(64), content: fixtureContent() });
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} />);
    expect(await screen.findByText('An unsaved draft in this browser is out of date.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restore unsaved changes' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Discard the old draft' }));
    expect(window.localStorage.getItem(draftKey(VERSION_ID))).toBeNull();
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
    renderRouted(() => <DesignerEditor initial={fixtureVersion()} palette={PALETTE} />);
    const title = await screen.findByRole('textbox', { name: 'Title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Renamed title{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Save revision…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save revision 4' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Change note/ }), 'Renamed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save revision' }));
    expect(await within(dialog).findByText('Someone saved this version after you opened it; your change was not saved.')).toBeTruthy();
    expect(window.localStorage.getItem(draftKey(VERSION_ID))).not.toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save revision' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(window.localStorage.getItem(draftKey(VERSION_ID))).toBeNull();
  });
});
