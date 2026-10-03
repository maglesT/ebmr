/**
 * A justification names the saved revision whose warning the author was shown (review P15, P59; IN-02, DI-04): the
 * justify request carries that revision and its content hash, so the server refuses it (409) when the version was
 * saved again meanwhile, instead of recording the text against content its author never saw. A warning is justified
 * only as the check of the saved revision reports it: while the report on screen is for other content, Justify is
 * not offered.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flow } from '@ebmr/recipe-core/pure';
import { DesignerEditor } from '../../src/features/designer/DesignerPage.tsx';
import { finding, fixtureVersion, installFixtures, PALETTE, PERSON_ID, renderRouted, report } from './support.tsx';

const KEY = 'G07-TOLERANCE-MISSING@p-disp-exc';
const WARNING = finding({ key: KEY, rule: 'G07-TOLERANCE-MISSING', severity: 'WARNING', message: 'The excipient dispensing step has no tolerance.' });
let sent: unknown[] = [];

function install(reportHash: (content: flow.MbrContent) => string): void {
  installFixtures({
    'designer.validate': ({ body }: { body: { content: flow.MbrContent } }) => report([WARNING], reportHash(body.content)),
    'designer.justify': ({ body }: { body: unknown }) => {
      sent.push(body);
      return fixtureVersion();
    },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  sent = [];
});
afterEach(() => {
  window.localStorage.clear();
});

describe('justify dialog (IN-02, DI-04)', () => {
  it('[IN-02][DI-04] the justification names the saved revision and content hash whose warning is on screen', async () => {
    install((content) => flow.mbrContentHash(content));
    const v = fixtureVersion();
    renderRouted(() => <DesignerEditor initial={v} palette={PALETTE} personId={PERSON_ID} />);
    await userEvent.click(await screen.findByRole('button', { name: `Justify ${KEY}` }, { timeout: 5_000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Justify a warning' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Why the warning is acceptable' }), 'Checked at reconciliation.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record the justification' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ findingKey: KEY, text: 'Checked at reconciliation.', baseRevision: v.revision, contentHash: v.contentHash });
  });

  it('[IN-02][DI-04] a warning reported for other content than the saved revision cannot be justified', async () => {
    // The report on screen is not the saved revision's (as while its check has not answered yet).
    install(() => 'b'.repeat(64));
    const v = fixtureVersion();
    renderRouted(() => <DesignerEditor initial={v} palette={PALETTE} personId={PERSON_ID} />);
    const button = await screen.findByRole('button', { name: `Justify ${KEY}` }, { timeout: 5_000 });
    expect(button.hasAttribute('disabled') || button.getAttribute('data-disabled') === 'true').toBe(true);
    expect(screen.getByText(/Wait until the saved revision has been checked/)).toBeTruthy();
    await userEvent.click(button);
    expect(screen.queryByRole('dialog', { name: 'Justify a warning' })).toBeNull();
    expect(sent).toEqual([]);
  });
});
