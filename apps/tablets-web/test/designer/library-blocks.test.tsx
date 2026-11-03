/**
 * Library blocks in the designer (decision 0026 slice S9): an approved block is added after a step in one undoable
 * change that also carries its snapshot (pinned by hash); the product's values are typed in a form built from the
 * block's slots, with the formulation checks shown as they are typed.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { flow, library } from '@ebmr/recipe-core/pure';
import granulation from '../../../../packages/recipe-core/test/fixtures/tablet-granulation-compression.mbr.json' with { type: 'json' };
import { AddLibraryBlock, LibraryValuesForm } from '../../src/features/designer/components/LibraryBlocks.tsx';
import { applyOp, insertionPoint, OpError, type Content } from '../../src/features/designer/model/ops.ts';
import { installFixtures, renderRouted } from './support.tsx';

const FRIAB: library.BlockDefinition = {
  code: 'IPC-FRIAB',
  version: 1,
  title: 'Friability',
  category: 'TEST_IPC',
  sections: [
    {
      id: 'run',
      title: 'Run',
      fields: [
        { id: 'w0', label: 'Weight before', type: 'NUMBER', unit: 'g' },
        { id: 'w1', label: 'Weight after', type: 'NUMBER', unit: 'g' },
        { id: 'loss', label: 'Weight loss', type: 'CALC', expression: '(w0 - w1) / w0 * 100 [%]', unit: '%', limitSlot: 'loss', critical: true },
      ],
    },
  ],
  signatures: [{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }],
  referenceLimits: { loss: { unit: '%', high: '1.0', note: 'A common compendial maximum for uncoated tablets' } },
};

const content = (): Content => {
  const parsed = flow.parseMbr(structuredClone(granulation));
  if (!parsed.ok) throw new Error('fixture');
  return parsed.mbr;
};
const byId = (c: Content, id: string): flow.PhaseNode | undefined => {
  let found: flow.PhaseNode | undefined;
  flow.walk(c.procedure.body, (n) => {
    if (n.kind === 'phase' && n.id === id) found = n;
  });
  return found;
};
const firstPhase = (c: Content): flow.PhaseNode => {
  let found: flow.PhaseNode | undefined;
  flow.walk(c.procedure.body, (n) => {
    if (!found && n.kind === 'phase') found = n;
  });
  if (!found) throw new Error('no phase');
  return found;
};

describe('library blocks in the designer', () => {
  it('[PR-05] adding a library block inserts its step and carries its snapshot in one change; a different content under the same version is refused', () => {
    const c = content();
    const at = insertionPoint(c, firstPhase(c).id);
    if (!at) throw new Error('no insertion point');
    const next = applyOp(c, { kind: 'ADD_LIBRARY_BLOCK', ...at, stepId: 'p-ipc-friab', definition: FRIAB });
    const step = byId(next, 'p-ipc-friab');
    expect(step?.block).toEqual({ type: 'LIB-IPC-FRIAB', version: '1' });
    expect(step?.config).toEqual({ hash: library.definitionHash(FRIAB) });
    expect(next.blockDefinitions).toHaveLength(1);
    expect(flow.parseMbr(JSON.parse(JSON.stringify(next))).ok).toBe(true);
    const again = applyOp(next, { kind: 'ADD_LIBRARY_BLOCK', ...at, stepId: 'p-ipc-friab-2', definition: FRIAB });
    expect(again.blockDefinitions).toHaveLength(1);
    expect(() => applyOp(next, { kind: 'ADD_LIBRARY_BLOCK', ...at, stepId: 'p-x', definition: { ...FRIAB, title: 'Edited' } })).toThrow(OpError);
  });

  it('[PR-03][PR-08] the values form shows each slot, the reference limit, and the formulation checks as values are typed', async () => {
    const c = applyOp(content(), { kind: 'ADD_LIBRARY_BLOCK', ...(insertionPoint(content(), firstPhase(content()).id) as { sequenceId: string; index: number }), stepId: 'p-ipc-friab', definition: FRIAB });
    const step = byId(c, 'p-ipc-friab');
    if (!step) throw new Error('no step');
    const onChange = vi.fn();
    renderRouted(() => <LibraryValuesForm content={c} step={step} readOnly={false} onChange={onChange} />);
    const form = await screen.findByTestId('library-values');
    expect(within(form).getByText(/reference 1.0 %: A common compendial maximum/)).toBeTruthy();
    expect(within(screen.getByTestId('library-values-problems')).getByText(/needs limits/)).toBeTruthy();
    const upper = within(form).getByLabelText('loss: upper limit');
    await userEvent.type(upper, '0.8');
    await userEvent.tab();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const config = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(config['limits']).toEqual({ loss: { unit: '%', ranges: [{ tier: 'REGISTERED', rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'FORMULATION' }, high: { value: '0.8', inclusive: true } }] } });
    expect(config['hash']).toBe(library.definitionHash(FRIAB));
  });

  it('[PR-03] a field with several limits (a test\'s mean, minimum and maximum) names each limit by its slot, so the author can tell them apart (S11 finding)', async () => {
    const HARD: library.BlockDefinition = {
      code: 'IPC-HARD-T',
      version: 1,
      title: 'Hardness',
      category: 'TEST_IPC',
      sections: [
        {
          id: 'run',
          title: 'Run',
          fields: [
            {
              id: 'force',
              label: 'Breaking force',
              type: 'TEST_RESULT',
              unit: 'N',
              replicatesSlot: 'tablets',
              statistics: [
                { statistic: 'MEAN', limitSlot: 'meanForce' },
                { statistic: 'MIN', limitSlot: 'minForce' },
              ],
            },
            { id: 'note', label: 'Note', type: 'NUMBER', unit: 'mm', limitSlot: 'note' },
          ],
        },
      ],
      signatures: [{ meaning: 'PERFORMED', role: 'IPC_OPERATOR' }],
    };
    const c = applyOp(content(), { kind: 'ADD_LIBRARY_BLOCK', ...(insertionPoint(content(), firstPhase(content()).id) as { sequenceId: string; index: number }), stepId: 'p-ipc-hard-t', definition: HARD });
    const step = byId(c, 'p-ipc-hard-t');
    if (!step) throw new Error('no step');
    renderRouted(() => <LibraryValuesForm content={c} step={step} readOnly={false} onChange={vi.fn()} />);
    const form = await screen.findByTestId('library-values');
    expect(within(form).getByRole('group', { name: 'Limits of force, meanForce' })).toBeTruthy();
    expect(within(form).getByRole('group', { name: 'Limits of force, minForce' })).toBeTruthy();
    expect(within(form).getAllByLabelText('force, minForce: lower limit')).toHaveLength(1);
    // A field with one limit keeps the plain name.
    expect(within(form).getByRole('group', { name: 'Limits of note' })).toBeTruthy();
  });

  it('[PR-05] the author picks an approved library block and adds it after the step', async () => {
    installFixtures({
      'library.list': {
        blocks: [
          {
            blockId: '3b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', code: 'IPC-FRIAB', version: 1, title: 'Friability', category: 'TEST_IPC', state: 'APPROVED', contentHash: library.definitionHash(FRIAB),
            definition: FRIAB, draftedBy: { personId: '7a1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e11', legalName: 'Asha Rao', loginName: 'asha.rao', role: 'AUTHOR' }, draftedAt: { us: '1', text: 'now' },
            approvedBy: null, approvedAt: null, retiredAt: null, retirementReason: null,
          },
        ],
      },
    });
    const c = content();
    const dispatch = vi.fn();
    renderRouted(() => <AddLibraryBlock content={c} afterId={firstPhase(c).id} dispatch={dispatch} />);
    const select = await screen.findByLabelText('Approved library block');
    await waitFor(() => expect(within(select).getByText('IPC-FRIAB v1: Friability')).toBeTruthy());
    await userEvent.selectOptions(select, '3b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e');
    await userEvent.click(screen.getByRole('button', { name: 'Add the block' }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ADD_LIBRARY_BLOCK', stepId: 'p-ipc-friab', definition: FRIAB }));
  });
});
