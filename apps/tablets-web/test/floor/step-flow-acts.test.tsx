/**
 * Phase 7 slice 7l (requirement R1: every tablet block demonstrable on the screens): what the demo routes found that a
 * person could not do on the step screen, now offered there and sent as the person's own command:
 *  - the branch of an alternative chosen by the person the master names, with the reason (CHOOSE_ALTERNATIVE);
 *  - a loop iteration ended once its step is completed (COMPLETE_LOOP_ITERATION; the engine decides the outcome);
 *  - a member that names another entry of the batch (a binder addition's TB-03 preparation) picked from the entries
 *    listed, never its id typed;
 *  - a reject container of a sort result picked from the batch's containers, never its id typed;
 *  - the potency calculation of TB-01 from the active's lots (POTENCY_CALCULATION).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { BlockEntryFormView, BlockFieldSchemaWire, StepScreenView } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { renderFloor, RUN_ID, stepFixtures, stepPath } from './support.tsx';

afterEach(() => {
  apiState.installation = undefined;
});

const at = (text: string) => ({ us: '1792300000000000', text });
const OP = { personId: '7a1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e11', legalName: 'Priya Nair', loginName: 'priya.nair', role: 'OPERATOR' };
const EN = '^EN-[1-9][0-9]{0,8}$';
const ID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const CONTAINER = '2b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d01';
const str = (description: string, pattern?: string, enumValues?: string[]): BlockFieldSchemaWire => ({ type: 'string', description, ...(pattern ? { pattern } : {}), ...(enumValues ? { enum: enumValues } : {}) });
const dec = (description: string): BlockFieldSchemaWire => ({ type: 'decimal', description });
const form = (kind: string, title: string, fields: Record<string, BlockFieldSchemaWire>): BlockEntryFormView => ({ kind: kind as BlockEntryFormView['kind'], title, description: title, schema: { type: 'object', description: title, fields } });

function gmpView(block: string, stepKey: string, change: (v: StepScreenView) => void = () => undefined): StepScreenView {
  const v = structuredClone(example('batches-step-tb08'));
  v.step.block = block;
  v.step.stepKey = stepKey;
  v.run.runId = RUN_ID;
  const out: StepScreenView = { ...v, blockEntries: [], entryForms: [] };
  change(out);
  return out;
}

function render(view: StepScreenView, extra: Record<string, () => unknown> = {}) {
  return renderFloor(stepPath(view.step.stepKey), { installation: 'GMP', fixtures: { 'batches.step': () => view, ...stepFixtures(view), ...extra } });
}
const intentOf = (ui: ReturnType<typeof renderFloor>) => ui.commands().at(-1)?.body?.['intent'] as Record<string, unknown> | undefined;

describe('the branch of an alternative chosen on the step screen', () => {
  it('[DI-34][PR-13] offers the branches the master names and sends the choice with the person\'s reason', async () => {
    const view = gmpView('TB-04@1', 'p-ipa-extra@', (v) => {
      v.alternative = { construct: 'A-IPA', context: '', branches: [{ id: 'B-IPA-NONE', name: 'No extra isopropyl alcohol' }, { id: 'B-IPA-EXTRA', name: 'Extra isopropyl alcohol' }], roles: ['PRODUCTION_SUPERVISOR'], chosen: null };
    });
    const ui = render(view);
    const box = await screen.findByTestId('alternative-choice');
    const choose = within(box).getByRole('button', { name: 'Choose the branch' });
    expect(choose.hasAttribute('disabled') || choose.getAttribute('aria-disabled') === 'true' || choose.hasAttribute('data-disabled')).toBe(true);
    await userEvent.click(within(box).getByRole('radio', { name: 'No extra isopropyl alcohol' }));
    await userEvent.type(within(box).getByRole('textbox', { name: 'Reason for the choice' }), 'Wet mass consistency normal');
    await userEvent.click(choose);
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(intentOf(ui)).toEqual({ type: 'CHOOSE_ALTERNATIVE', construct: 'A-IPA', branch: 'B-IPA-NONE', reason: 'Wet mass consistency normal' });
  });

  it('[DI-34] shows the branch chosen and offers no second choice', async () => {
    const view = gmpView('TB-08@1', 'p-rework@', (v) => {
      v.alternative = { construct: 'A-RPR', context: '', branches: [{ id: 'B-RPR-NONE', name: 'No addition' }, { id: 'B-RPR-ADD', name: 'Addition' }], roles: ['PRODUCTION_SUPERVISOR'], chosen: 'B-RPR-NONE' };
    });
    render(view);
    const box = await screen.findByTestId('alternative-choice');
    expect(within(box).getByText('Branch chosen: No addition')).toBeTruthy();
    expect(within(box).queryByRole('button', { name: 'Choose the branch' })).toBeNull();
  });
});

describe('a loop iteration ended on the step screen', () => {
  it('[INV-19][DI-34] is offered once the step of the iteration is completed and sends COMPLETE_LOOP_ITERATION for the step', async () => {
    const view = gmpView('TB-05@1', 'p-dry@L-DRY=1', (v) => {
      v.step.status = 'COMPLETED';
      v.loop = { construct: 'L-DRY', name: 'Dry until the LOD is in range', iteration: 1, completed: false };
    });
    const ui = render(view);
    const box = await screen.findByTestId('loop-iteration');
    await userEvent.click(within(box).getByRole('button', { name: 'End iteration 1' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(intentOf(ui)).toEqual({ type: 'COMPLETE_LOOP_ITERATION', stepKey: 'p-dry@L-DRY=1' });
  });

  it('[INV-19] waits for the step to be completed, and shows an ended iteration as ended', async () => {
    const running = gmpView('TB-05@1', 'p-dry@L-DRY=2', (v) => {
      v.step.status = 'IN_PROGRESS';
      v.loop = { construct: 'L-DRY', name: 'Dry until the LOD is in range', iteration: 2, completed: false };
    });
    const ui = render(running);
    const end = within(await screen.findByTestId('loop-iteration')).getByRole('button', { name: 'End iteration 2' });
    expect(end.hasAttribute('disabled') || end.getAttribute('aria-disabled') === 'true' || end.hasAttribute('data-disabled')).toBe(true);
    ui.unmount();
    render(gmpView('TB-05@1', 'p-dry@L-DRY=1', (v) => {
      v.step.status = 'COMPLETED';
      v.loop = { construct: 'L-DRY', name: 'Dry until the LOD is in range', iteration: 1, completed: true };
    }));
    expect(within(await screen.findByTestId('loop-iteration')).getByText('Iteration 1 ended')).toBeTruthy();
  });
});

describe('a member naming another entry of the batch', () => {
  it('[IN-13][IN-36] lists the citable TB-03 preparations of the batch and saves the one picked, never a typed id', async () => {
    const view = gmpView('TB-04@1', 'p-gran@', (v) => {
      v.blockEntries = [form('BINDER_ADDITION', 'Binder addition', { preparation: str('The PREPARED entry of the solution (TB-03)', EN), quantity: { type: 'object', description: 'Quantity', fields: { value: dec('Value'), unit: str('Unit') } } })];
      v.citable = [{ entryId: 'EN-3', kind: 'PREPARED', summary: 'prepared 7.200 kg', data: {}, by: OP, at: at('22-OCT-2026 10:00') }];
    });
    const ui = render(view);
    await userEvent.click(await screen.findByRole('button', { name: 'Record: Binder addition' }));
    const f = await screen.findByTestId('block-form-BINDER_ADDITION');
    expect(within(f).queryByRole('textbox', { name: 'Preparation' })).toBeNull();
    await userEvent.click(within(f).getByRole('radio', { name: /^prepared 7\.200 kg \(EN-3, / }));
    const q = within(f).getByTestId('block-object-quantity');
    await userEvent.type(within(q).getByRole('textbox', { name: 'Value' }), '7.200');
    await userEvent.type(within(q).getByRole('textbox', { name: 'Unit' }), 'kg');
    await userEvent.click(within(f).getByRole('button', { name: 'Save: Binder addition' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect((intentOf(ui)?.['entry'] as Record<string, unknown>)['data']).toEqual({ preparation: 'EN-3', quantity: { value: '7.200', unit: 'kg' } });
  });
});

describe('a reject container named in a sort result', () => {
  it('[PR-46][IN-35] is picked from the batch\'s containers (label, stage, state, net), never its id typed', async () => {
    const view = gmpView('TB-20@1', 'p-insp@', (v) => {
      v.blockEntries = [form('SORT_RESULT', 'Sort result', {
        rejects: { type: 'array', description: 'Reject containers', items: { type: 'object', description: 'One reject container', fields: { category: str('Category', undefined, ['DESTRUCTION', 'REUSABLE_RESIDUE']), container: str('Container', ID), count: str('Count', '^[0-9]{1,18}$') } } },
      })];
    });
    const list = example('containers-list');
    const c0 = list.containers[0];
    if (!c0) throw new Error('the containers example lists none');
    const containers = { ...list, containers: [{ ...c0, containerId: CONTAINER, label: 'OC-RWG260001-0005', stage: 'INSPECTION', state: 'CLOSED' as const, netQuantity: '0.180', unit: 'kg' as const }] };
    const ui = render(view, { 'containers.list': () => containers });
    await userEvent.click(await screen.findByRole('button', { name: 'Record: Sort result' }));
    const f = await screen.findByTestId('block-form-SORT_RESULT');
    await userEvent.click(within(f).getByRole('button', { name: 'Add to Rejects' }));
    const row = within(f).getByRole('group', { name: 'Rejects 1' });
    await userEvent.click(within(row).getByRole('radio', { name: 'DESTRUCTION' }));
    await userEvent.click(await within(row).findByRole('radio', { name: /^OC-RWG260001-0005 \(INSPECTION, CLOSED, 0\.180 kg\)$/ }));
    await userEvent.type(within(row).getByRole('textbox', { name: 'Count' }), '426');
    await userEvent.click(within(f).getByRole('button', { name: 'Save: Sort result' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect((intentOf(ui)?.['entry'] as Record<string, unknown>)['data']).toEqual({ rejects: [{ category: 'DESTRUCTION', container: CONTAINER, count: '426' }] });
  });
});

describe('the potency calculation of TB-01', () => {
  it('[PR-19][IN-23] sends the active\'s lot scanned as POTENCY_CALCULATION (the server reads its assay; nothing typed but the lot)', async () => {
    const view = gmpView('TB-01@1', 'p-disp-api@');
    const ui = render(view);
    const box = await screen.findByTestId('potency-calculation');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Lot 1 of the active' }), 'RTW-API-001');
    await userEvent.click(within(box).getByRole('button', { name: 'Calculate from the lots' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(intentOf(ui)).toEqual({ type: 'RECORD_ENTRY', stepKey: 'p-disp-api@', entry: { kind: 'POTENCY_CALCULATION', lots: [{ lotCode: 'RTW-API-001' }] } });
  });
  it('[PR-19][DI-33] R10 #1, #2: after the calculation the box shows each lot\'s assay, water, as-is potency and target, the excipient\'s target, and the still-to-weigh list counts against those targets', async () => {
    const lot = { lotCode: 'RAB-API-0001', basis: 'ANHYDROUS_WATER', assay: '99.40', water: '0.60', lod: null, asIs: '98.8036', baseEquivalent: '3.000', target: '3.037', changed: false };
    const view = gmpView('TB-01@1', 'p-disp-api@', (v) => {
      v.potency = {
        lots: [lot],
        active: { bomLine: 'BOM-API', material: 'Rabeprazole sodium (MAT-RAB)', unit: 'kg', standard: '3.000', target: '3.037' },
        excipient: { bomLine: 'BOM-MCC', material: 'Microcrystalline cellulose (MAT-MCC)', unit: 'kg', standard: '4.500', target: '4.464' },
        total: '7.501',
        summary: 'Lot RAB-API-0001: assay 99.40 %, water 0.60 % → 98.8036 % as is; Rabeprazole sodium (MAT-RAB) 3.037 kg; Microcrystalline cellulose (MAT-MCC) 4.464 kg',
      };
      v.entryForms = structuredClone(example('step-g07-weighing').entryForms);
      v.bomRemaining = [
        { bomLine: 'BOM-API', material: 'Rabeprazole sodium (MAT-RAB)', unit: 'kg', basis: 'POTENCY', required: '3.037', weighed: '0.000', remaining: '3.037' },
        { bomLine: 'BOM-MCC', material: 'Microcrystalline cellulose (MAT-MCC)', unit: 'kg', basis: 'POTENCY', required: '4.464', weighed: '4.500', remaining: '-0.036' },
      ];
    });
    render(view);
    const result = await screen.findByTestId('potency-result');
    expect(within(result).getByTestId('potency-lot-RAB-API-0001').textContent).toMatch(/RAB-API-0001.*99\.40 %.*0\.60 %.*98\.8036 %.*3\.037 kg/);
    expect(within(result).getByTestId('potency-target-active').textContent).toContain('target 3.037 kg');
    expect(within(result).getByTestId('potency-target-excipient').textContent).toContain('target 4.464 kg');
    expect(within(result).queryByTestId('potency-changed')).toBeNull();
    expect(screen.getByTestId('still-to-weigh-BOM-API').textContent).toBe('Rabeprazole sodium (MAT-RAB): still to weigh 3.037 kg (target from the potency calculation 3.037 kg, weighed 0.000 kg)');
    expect(screen.getByTestId('still-to-weigh-BOM-MCC').textContent).toContain('0.036 kg over the target from the potency calculation (4.464 kg)');
  });

  it('[PR-19] R13: a lot whose approved result changed since the calculation asks for a recalculation', async () => {
    const view = gmpView('TB-01@1', 'p-disp-api@', (v) => {
      v.potency = {
        lots: [{ lotCode: 'RAB-API-0001', basis: 'AS_IS', assay: '99.40', water: null, lod: null, asIs: '99.40', baseEquivalent: '3.000', target: '3.019', changed: true }],
        active: { bomLine: 'BOM-API', material: 'Rabeprazole sodium', unit: 'kg', standard: '3.000', target: '3.019' },
        excipient: null,
        total: '3.019',
        summary: 'x',
      };
    });
    render(view);
    expect((await screen.findByTestId('potency-changed')).textContent).toMatch(/Potency changed since the calculation \(RAB-API-0001\): recalculate/);
  });
});
