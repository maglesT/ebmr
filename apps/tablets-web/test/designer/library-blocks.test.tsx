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

  it('[PR-08] the values form takes the tiers the engine nests: an alert and an action limit inside the registered range are stored beside it, a tier that is not nested is a problem, and clearing a tier removes only that tier', async () => {
    const c0 = applyOp(content(), { kind: 'ADD_LIBRARY_BLOCK', ...(insertionPoint(content(), firstPhase(content()).id) as { sequenceId: string; index: number }), stepId: 'p-ipc-friab', definition: FRIAB });
    const step0 = byId(c0, 'p-ipc-friab');
    if (!step0) throw new Error('no step');
    const reg = { tier: 'REGISTERED', rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'FORMULATION' }, high: { value: '1.0', inclusive: true } };
    const alert = { tier: 'ALERT', rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'COMPANY_STANDARD', ref: 'FORMULATION' }, high: { value: '0.6', inclusive: true } };
    const step = { ...step0, config: { ...step0.config, limits: { loss: { unit: '%', ranges: [reg] } } } } as flow.PhaseNode;
    const onChange = vi.fn();
    const ui = renderRouted(() => <LibraryValuesForm content={c0} step={step} readOnly={false} onChange={onChange} />);
    const form = await screen.findByTestId('library-values');
    await userEvent.type(within(form).getByLabelText('loss: alert limit, upper'), '0.6');
    await userEvent.tab();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect((onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>)['limits']).toEqual({ loss: { unit: '%', ranges: [reg, alert] } });
    ui.unmount();

    // A tier outside the registered range is the engine's nesting problem, shown as the author types (LIB-USE-LIMIT-NOT_NESTED).
    const wide = { ...step0, config: { ...step0.config, limits: { loss: { unit: '%', ranges: [reg, { ...alert, high: { value: '1.2', inclusive: true } }] } } } } as flow.PhaseNode;
    const ui2 = renderRouted(() => <LibraryValuesForm content={c0} step={wide} readOnly={false} onChange={vi.fn()} />);
    expect(within(await screen.findByTestId('library-values-problems')).getByText(/alert limit/i)).toBeTruthy();
    ui2.unmount();

    // Clearing the alert's bound removes the alert only; editing the registered range keeps the alert.
    const both = { ...step0, config: { ...step0.config, limits: { loss: { unit: '%', ranges: [reg, alert] } } } } as flow.PhaseNode;
    const onBoth = vi.fn();
    renderRouted(() => <LibraryValuesForm content={c0} step={both} readOnly={false} onChange={onBoth} />);
    const f3 = await screen.findByTestId('library-values');
    await userEvent.clear(within(f3).getByLabelText('loss: alert limit, upper'));
    await userEvent.tab();
    await waitFor(() => expect(onBoth).toHaveBeenCalled());
    expect((onBoth.mock.calls.at(-1)?.[0] as Record<string, unknown>)['limits']).toEqual({ loss: { unit: '%', ranges: [reg] } });
    await userEvent.clear(within(f3).getByLabelText('loss: upper limit'));
    await userEvent.type(within(f3).getByLabelText('loss: upper limit'), '0.9');
    await userEvent.tab();
    await waitFor(() => expect((onBoth.mock.calls.at(-1)?.[0] as Record<string, unknown>)['limits']).toEqual({ loss: { unit: '%', ranges: [{ ...reg, high: { value: '0.9', inclusive: true } }, alert] } }));
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

  // D-6 (owner's MGL-SR-BL report, item 9): the equipment class is chosen from the plant's classes; a saved value the
  // plant lacks stays shown and marked; the plant's definitions screen is one link away.
  it('[PR-03] the equipment class of a library step is chosen from the plant\'s classes; a saved class the plant lacks is marked "not a plant class"', async () => {
    const cls = (code: string, description: string) => ({ code, kind: 'INSTRUMENT' as const, description, cleanHold: null, dirtyHold: null, calibrationRequired: true, checkRegime: 'DAILY' as const, cipValidationRef: null });
    installFixtures({ 'plant.equipmentClasses': { classes: [cls('EQC-FRB', 'Friabilator, drum'), cls('EQC-BAL', 'Balance, analytical')] } });
    const withDrum: library.BlockDefinition = { ...FRIAB, sections: [{ ...(FRIAB.sections[0] as library.SectionDef), fields: [{ id: 'drum', label: 'Friabilator', type: 'EQUIPMENT', kind: 'INSTRUMENT', classSlot: 'friabilatorClass' }, ...(FRIAB.sections[0]?.fields ?? [])] }] };
    const c = applyOp(content(), { kind: 'ADD_LIBRARY_BLOCK', ...(insertionPoint(content(), firstPhase(content()).id) as { sequenceId: string; index: number }), stepId: 'p-ipc-friab', definition: withDrum });
    const step = byId(c, 'p-ipc-friab');
    if (!step) throw new Error('no step');
    const onChange = vi.fn();
    const saved = { ...step, config: { ...step.config, equipmentClasses: { friabilatorClass: 'FRIABILATOR' } } } as flow.PhaseNode;
    renderRouted(() => <LibraryValuesForm content={c} step={saved} readOnly={false} onChange={onChange} />);
    const select = await screen.findByRole('combobox', { name: 'Equipment class for drum' });
    await waitFor(() => expect(within(select).getByText('EQC-FRB: Friabilator, drum (instrument)')).toBeTruthy());
    expect(within(select).getByText('FRIABILATOR (not a plant class)')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Define a class in Plant master data' }).getAttribute('href')).toBe('/master-data/plant');
    await userEvent.selectOptions(select, 'EQC-FRB');
    const config = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(config['equipmentClasses']).toEqual({ friabilatorClass: 'EQC-FRB' });
  });

  it('[PR-05] the author picks an approved library block and adds it after the step', async () => {
    installFixtures({
      'library.list': {
        blocks: [
          {
            blockId: '3b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', code: 'IPC-FRIAB', version: 1, title: 'Friability', category: 'TEST_IPC', edition: 'tablets', state: 'APPROVED', contentHash: library.definitionHash(FRIAB),
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

  it('[PR-03][PR-45] S11a finding: a release test (QC\'s record on the lot, signed by QC roles no floor session carries) is not offered for a master; an IPC test is', async () => {
    const entry = (blockId: string, def: typeof FRIAB) => ({
      blockId, code: def.code, version: 1, title: def.title, category: def.category, edition: 'tablets', state: 'APPROVED', contentHash: library.definitionHash(def),
      definition: def, draftedBy: { personId: '7a1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e11', legalName: 'Asha Rao', loginName: 'asha.rao', role: 'AUTHOR' }, draftedAt: { us: '1', text: 'now' },
      approvedBy: null, approvedAt: null, retiredAt: null, retirementReason: null,
    });
    const RELEASE = { ...FRIAB, code: 'REL-ASSAY', title: 'Assay (release)', category: 'TEST_RELEASE' as const, signatures: [{ meaning: 'PERFORMED' as const, role: 'QC_ANALYST' }] };
    installFixtures({ 'library.list': { blocks: [entry('3b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', FRIAB), entry('4c2f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5f', RELEASE)] } });
    const c = content();
    renderRouted(() => <AddLibraryBlock content={c} afterId={firstPhase(c).id} dispatch={vi.fn()} />);
    const select = await screen.findByLabelText('Approved library block');
    await waitFor(() => expect(within(select).getByText('IPC-FRIAB v1: Friability')).toBeTruthy());
    expect(within(select).queryByText('REL-ASSAY v1: Assay (release)')).toBeNull();
    expect(screen.getByText(/Release tests are recorded by QC on the lot/)).toBeTruthy();
  });
});
