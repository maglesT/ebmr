/**
 * The block library screen (decision 0026 slice S3, /mbr/library): versions with their state, fields and approval; the
 * author checks and stores the next version; QA approves a draft through the ceremony (LIBRARY_ACT) and retires an
 * approved version with a reason. Every rule is the server's.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { LibraryBlockView } from '@ebmr/api-contract';
import { apiState } from '../../src/api/client.ts';
import { renderOffice, signedCeremony } from '../office/support.tsx';
import { AUTHOR, QA, at } from '../slice7g2/fixtures.ts';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const definition = {
  code: 'IPC-FRIAB',
  version: 1,
  title: 'Friability',
  category: 'TEST_IPC',
  sections: [{ id: 'run', title: 'Run', fields: [{ id: 'w0', label: 'Weight before', type: 'NUMBER', unit: 'g' }] }],
  signatures: [{ meaning: 'PERFORMED', role: 'IPC_OPERATOR' }],
};

const block = (over: Partial<LibraryBlockView> = {}): LibraryBlockView => ({
  blockId: '3b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  code: 'IPC-FRIAB',
  version: 1,
  title: 'Friability',
  category: 'TEST_IPC',
  state: 'DRAFT',
  contentHash: 'a'.repeat(64),
  definition,
  draftedBy: AUTHOR,
  draftedAt: at('1 Nov 2026'),
  approvedBy: null,
  approvedAt: null,
  retiredAt: null,
  retirementReason: null,
  ...over,
});

describe('the block library screen', () => {
  it('[DI-35][PR-05] QA sees a draft with its fields and approves it through the ceremony with LIBRARY_ACT', async () => {
    const ceremony = signedCeremony();
    renderOffice('/mbr/library', { role: 'QA_MBR_APPROVER', ceremony, fixtures: { 'library.list': { blocks: [block()] } } });
    const card = await screen.findByTestId('library-IPC-FRIAB-1');
    expect(card.textContent).toContain('DRAFT');
    expect(within(card).getByRole('list', { name: 'Fields of Run' }).textContent).toContain('Weight before (number, g)');
    await userEvent.click(within(card).getByRole('button', { name: 'Approve IPC-FRIAB version 1 (signature)' }));
    await waitFor(() => expect(ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'LIBRARY_ACT', act: 'BLOCK_APPROVE', subjectId: block().blockId });
  });

  it('[DI-22] QA retires an approved version only with a reason', async () => {
    const approved = block({ state: 'APPROVED', approvedBy: QA, approvedAt: at('1 Nov 2026') });
    const ui = renderOffice('/mbr/library', { role: 'QA_MBR_APPROVER', fixtures: { 'library.list': { blocks: [approved] }, 'library.retire': { ...approved, state: 'RETIRED' } } });
    const card = await screen.findByTestId('library-IPC-FRIAB-1');
    const retire = within(card).getByRole('button', { name: 'Retire IPC-FRIAB version 1' });
    expect(retire.hasAttribute('disabled') || retire.getAttribute('aria-disabled') === 'true').toBe(true);
    await userEvent.type(within(card).getByLabelText('Reason to retire IPC-FRIAB version 1'), 'Replaced by version 2');
    await userEvent.click(retire);
    await waitFor(() => expect(ui.posts('/api/library/blocks/retire')).toHaveLength(1));
    expect(ui.posts('/api/library/blocks/retire')[0]?.body).toEqual({ blockId: approved.blockId, reason: 'Replaced by version 2' });
  });

  it('[PR-03] the author checks a definition, sees its problems in the server\'s words, and stores it as the next version', async () => {
    const ui = renderOffice('/mbr/library', {
      role: 'MBR_AUTHOR',
      fixtures: {
        'library.list': { blocks: [block({ state: 'APPROVED', approvedBy: QA, approvedAt: at('1 Nov 2026') })] },
        'library.check': { problems: [{ code: 'LIB-FIELD-UNIT', severity: 'ERROR', path: 'sections[0].fields[0].unit', message: 'Field w0: "furlongs" is not a unit', controls: ['PR-03'] }] },
        'library.draft': { block: block({ version: 2 }), warnings: [] },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Start version 2 from IPC-FRIAB version 1' }));
    const text = screen.getByLabelText<HTMLTextAreaElement>('Definition (JSON)');
    expect(JSON.parse(text.value)).toMatchObject({ code: 'IPC-FRIAB', version: 2 });
    await userEvent.click(screen.getByRole('button', { name: 'Check the definition' }));
    expect(await screen.findByText(/Field w0: "furlongs" is not a unit/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Store as the next version' }));
    await waitFor(() => expect(ui.posts('/api/library/blocks')).toHaveLength(1));
    expect((ui.posts('/api/library/blocks')[0]?.body as { definition: { version: number } }).definition.version).toBe(2);
  });
});
