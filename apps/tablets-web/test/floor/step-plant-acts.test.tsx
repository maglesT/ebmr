/**
 * The plant acts of a GMP step on the step screen (Phase 7 slice 7h, WP-A; demo gap report A2 to A6): the room's use by
 * the batch on a clearance step, the booking of a balance and a unit on a status step, the tooling of a tooling step and
 * the hopper charge and press set-up of a set-up step. What is offered is the server's answer (batches.stepPlant); each
 * act is one call of the signed-in person; its answer fills the step's entry form, which the person saves: no
 * identifier is typed.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { BlockEntryFormView, BlockFieldSchemaWire, StepPlantView, StepScreenView } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { renderFloor, RUN_ID, stepFixtures, stepPath } from './support.tsx';

afterEach(() => {
  apiState.installation = undefined;
});

const at = (text: string) => ({ us: '1792300000000000', text });
const OP = { personId: '7a1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e11', legalName: 'Priya Nair', loginName: 'priya.nair', role: 'OPERATOR' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OCC = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d01';
const USE_BAL = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d02';
const USE_PRESS = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d03';
const INSPECTION = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d04';
const ISSUE = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d05';
const CONTAINER = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d06';
const CHARGE = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d07';

const str = (description: string, pattern?: string, enumValues?: string[]): BlockFieldSchemaWire => ({ type: 'string', description, ...(pattern ? { pattern } : {}), ...(enumValues ? { enum: enumValues } : {}) });
const ID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const form = (kind: string, title: string, fields: Record<string, BlockFieldSchemaWire>): BlockEntryFormView => ({ kind: kind as BlockEntryFormView['kind'], title, description: title, schema: { type: 'object', description: title, fields } });

function gmpView(block: string, stepKey: string, blockEntries: BlockEntryFormView[]): StepScreenView {
  const v = structuredClone(example('batches-step-tb08'));
  v.step.block = block;
  v.step.stepKey = stepKey;
  v.run.runId = RUN_ID;
  return { ...v, blockEntries, entryForms: [] };
}

const plant = (over: Partial<StepPlantView>): StepPlantView => ({
  batchId: RUN_ID, stepKey: 'p-x@', batchNumber: 'B26-0007', block: null, stage: 'S-DISP', areas: [], lineClearances: [], occupancies: [], equipment: [], uses: [],
  tooling: { checklist: ['TIPS', 'EDGES'], sets: [], issues: [], preUse: [] }, containers: [], charges: [], ...over,
});

function render(view: StepScreenView, current: () => StepPlantView, acts: Record<string, () => unknown>) {
  return renderFloor(stepPath(view.step.stepKey), { installation: 'GMP', fixtures: { 'batches.step': () => view, ...stepFixtures(view), 'batches.stepPlant': current, ...acts } });
}
const posts = (ui: ReturnType<typeof renderFloor>, path: string) => ui.requests.filter((r) => r.method === 'POST' && r.path === path);
const entryOf = (ui: ReturnType<typeof renderFloor>) => (ui.commands().at(-1)?.body?.['intent'] as { entry: unknown } | undefined)?.entry;

describe('the room a clearance step occupies (A2)', () => {
  it('[IN-21][PR-34] starts the batch\'s use of the stage\'s room, fills the AREA_OCCUPANCY entry from the answer, saves it, and ends the use', async () => {
    const view = gmpView('G-10@2', 'p-disp-clear@', [form('AREA_OCCUPANCY', 'Area occupancy', { areaCode: str('Area'), occupancyId: str('Occupancy', ID) })]);
    const occupancy = { occupancyId: OCC, areaCode: 'DISP-1', batchNumber: 'B26-0007', stage: 'S-DISP', startedBy: OP, startedAt: at('20-OCT-2026 09:00'), ended: null };
    let current = plant({ block: 'G-10@2', areas: [{ code: 'DISP-1', kind: 'ROOM', state: 'CLEARED' }] });
    const ui = render(view, () => current, {
      'plant.startAreaOccupancy': () => {
        current = { ...current, occupancies: [{ ...occupancy, mine: true }] };
        return occupancy;
      },
      'plant.endAreaOccupancy': () => ({ ...occupancy, ended: { by: OP, at: at('20-OCT-2026 12:00') } }),
    });
    const panel = await screen.findByTestId('step-plant');
    await userEvent.click(within(panel).getByRole('button', { name: 'Start using room DISP-1' }));
    await waitFor(() => expect(posts(ui, '/api/plant/occupancies')).toHaveLength(1));
    expect(posts(ui, '/api/plant/occupancies')[0]?.body).toMatchObject({ areaCode: 'DISP-1', batchId: RUN_ID, stage: 'S-DISP' });
    // The entry form opens with the room and the occupancy filled in: nothing to type.
    const entry = await screen.findByTestId('block-form-AREA_OCCUPANCY');
    expect(within(entry).getByTestId('chosen-occupancyId').textContent).toContain(OCC);
    expect(within(entry).queryByRole('textbox')).toBeNull();
    await userEvent.click(within(entry).getByRole('button', { name: 'Save: Area occupancy' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(entryOf(ui)).toEqual({ kind: 'BLOCK_ENTRY', entryKind: 'AREA_OCCUPANCY', data: { areaCode: 'DISP-1', occupancyId: OCC } });
    await userEvent.click(await within(screen.getByTestId('step-plant')).findByRole('button', { name: 'End the use of DISP-1' }));
    await waitFor(() => expect(posts(ui, `/api/plant/occupancies/${OCC}/end`)).toHaveLength(1));
  });
});

describe('the units a status step checks (A3, A4)', () => {
  it('[PR-23][IN-25] records the balance\'s per-use check and books it, books the press, and fills the EQUIPMENT_USE entry with the unit, its reference and the use', async () => {
    const view = gmpView('G-09@2', 'p-comp-status@', [form('EQUIPMENT_USE', 'Equipment use', { equipmentRef: str('Reference'), equipmentCode: str('Unit'), useId: str('Use', ID) })]);
    const unit = (code: string, name: string) => ({ code, name, areaCode: 'COMP-1', fitness: 'QUALIFIED', lastCheck: null });
    const booking = (useId: string, kind: 'PROCESS' | 'INSTRUMENT', equipmentCode: string) => ({ useId, kind, equipmentCode, batchNumber: 'B26-0007', startedBy: OP, startedAt: at('20-OCT-2026 09:00'), plannedEnd: at('20-OCT-2026 21:00'), ended: null });
    let current = plant({
      block: 'G-09@2',
      equipment: [
        { ref: 'BAL', kind: 'INSTRUMENT', classCode: 'EQC-BAL', units: [unit('BAL-C1', 'Balance 6 kg')] },
        { ref: 'PRESS', kind: 'PROCESS', classCode: 'EQC-PRESS', units: [unit('PRESS-01', 'Rotary press')] },
      ],
    });
    const ui = render(view, () => current, {
      'plant.recordInstrumentCheck': () => ({ checkId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d09', equipmentCode: 'BAL-C1', result: 'PASS', regime: 'PER_USE', recordedAt: at('20-OCT-2026 09:00') }),
      'plant.recordInstrumentUse': () => {
        current = { ...current, uses: [...current.uses, { ...booking(USE_BAL, 'INSTRUMENT', 'BAL-C1'), mine: true }] };
        return booking(USE_BAL, 'INSTRUMENT', 'BAL-C1');
      },
      'plant.startEquipmentUse': () => {
        current = { ...current, uses: [...current.uses, { ...booking(USE_PRESS, 'PROCESS', 'PRESS-01'), mine: true }] };
        return booking(USE_PRESS, 'PROCESS', 'PRESS-01');
      },
    });
    const bal = await screen.findByTestId('plant-unit-BAL');
    await userEvent.click(within(bal).getByRole('button', { name: 'Per-use check of BAL-C1 passed' }));
    await waitFor(() => expect(posts(ui, '/api/plant/instruments/BAL-C1/checks')).toHaveLength(1));
    expect(posts(ui, '/api/plant/instruments/BAL-C1/checks')[0]?.body).toMatchObject({ result: 'PASS', reference: 'Per-use check', batchId: RUN_ID });
    await userEvent.click(within(screen.getByTestId('plant-unit-BAL')).getByRole('button', { name: 'Book BAL-C1' }));
    await waitFor(() => expect(posts(ui, '/api/plant/instruments/BAL-C1/uses')).toHaveLength(1));
    expect(posts(ui, '/api/plant/instruments/BAL-C1/uses')[0]?.body).toMatchObject({ batchId: RUN_ID, plannedHours: '12' });
    const entry = await screen.findByTestId('block-form-EQUIPMENT_USE');
    await userEvent.click(within(entry).getByRole('button', { name: 'Save: Equipment use' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(entryOf(ui)).toEqual({ kind: 'BLOCK_ENTRY', entryKind: 'EQUIPMENT_USE', data: { equipmentRef: 'BAL', equipmentCode: 'BAL-C1', useId: USE_BAL } });
    await userEvent.click(within(screen.getByTestId('plant-unit-PRESS')).getByRole('button', { name: 'Book PRESS-01' }));
    await waitFor(() => expect(posts(ui, '/api/plant/equipment/PRESS-01/uses')).toHaveLength(1));
    const second = await screen.findByTestId('block-form-EQUIPMENT_USE');
    await waitFor(() => expect(within(second).getByTestId('chosen-useId').textContent).toContain(USE_PRESS));
    await userEvent.click(within(second).getByRole('button', { name: 'Save: Equipment use' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(2));
    expect(entryOf(ui)).toEqual({ kind: 'BLOCK_ENTRY', entryKind: 'EQUIPMENT_USE', data: { equipmentRef: 'PRESS', equipmentCode: 'PRESS-01', useId: USE_PRESS } });
  });
});

describe('the tooling of a tooling step (A6)', () => {
  it('[INV-24][IN-36] inspects the set item by item before use and issues it to the press in use; each answer fills its TB-09 entry', async () => {
    const view = gmpView('TB-09@1', 'p-tool@', [
      form('TOOLING_INSPECTED', 'Tooling inspected', { set: str('Set'), inspectionId: str('Inspection', ID), when: str('When', undefined, ['BEFORE', 'AFTER']), result: str('Result', undefined, ['PASS', 'FAIL']) }),
      form('TOOLING_ISSUED', 'Tooling issued', { set: str('Set'), issueId: str('Issue', ID), press: str('Press') }),
    ]);
    const press = { useId: USE_PRESS, kind: 'PROCESS' as const, equipmentCode: 'PRESS-01', batchNumber: 'B26-0007', startedBy: OP, startedAt: at('20-OCT-2026 09:00'), plannedEnd: at('20-OCT-2026 21:00'), ended: null, mine: true };
    const current = plant({ block: 'TB-09@1', uses: [press], tooling: { checklist: ['TIPS', 'EDGES'], sets: [{ code: 'TS-F100', upper: 45, lower: 45, dies: 45, issuedNow: false }], issues: [], preUse: [] } });
    const ui = render(view, () => current, {
      'plant.inspectTooling': () => ({ inspectionId: INSPECTION, set: 'TS-F100', kind: 'PRE_USE', result: 'PASS', held: [] }),
      'plant.issueTooling': () => ({ issueId: ISSUE, set: 'TS-F100', press: 'PRESS-01', preUseInspectionId: INSPECTION }),
    });
    const panel = await screen.findByTestId('tooling-inspect-BEFORE-TS-F100');
    const inspect = within(panel).getByRole('button', { name: 'Inspect set TS-F100 before use' });
    expect(inspect.hasAttribute('disabled') || inspect.getAttribute('aria-disabled') === 'true').toBe(true);
    for (const group of within(panel).getAllByRole('radiogroup')) await userEvent.click(within(group).getByRole('radio', { name: 'In order' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Inspect set TS-F100 before use' }));
    await waitFor(() => expect(posts(ui, '/api/plant/tooling/TS-F100/inspections')).toHaveLength(1));
    expect(posts(ui, '/api/plant/tooling/TS-F100/inspections')[0]?.body).toMatchObject({ kind: 'PRE_USE', findings: { TIPS: true, EDGES: true } });
    const inspected = await screen.findByTestId('block-form-TOOLING_INSPECTED');
    await userEvent.click(within(inspected).getByRole('button', { name: 'Save: Tooling inspected' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(entryOf(ui)).toEqual({ kind: 'BLOCK_ENTRY', entryKind: 'TOOLING_INSPECTED', data: { set: 'TS-F100', inspectionId: INSPECTION, when: 'BEFORE', result: 'PASS' } });
    await userEvent.click(within(screen.getByTestId('plant-tooling')).getByRole('button', { name: 'Issue set TS-F100 to PRESS-01' }));
    await waitFor(() => expect(posts(ui, '/api/plant/tooling/TS-F100/issues')).toHaveLength(1));
    expect(posts(ui, '/api/plant/tooling/TS-F100/issues')[0]?.body).toMatchObject({ batchId: RUN_ID, press: 'PRESS-01', counts: { upper: '45', lower: '45', dies: '45' } });
    const issued = await screen.findByTestId('block-form-TOOLING_ISSUED');
    await userEvent.click(within(issued).getByRole('button', { name: 'Save: Tooling issued' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(2));
    expect(entryOf(ui)).toEqual({ kind: 'BLOCK_ENTRY', entryKind: 'TOOLING_ISSUED', data: { set: 'TS-F100', issueId: ISSUE, press: 'PRESS-01' } });
  });
});

describe('the press set-up and hopper charge (A5)', () => {
  it('[IN-26] charges a closed container of the batch by its label and fills HOPPER_CHARGE; offers the press in use with its tooling for PRESS_SETUP', async () => {
    const view = gmpView('TB-10@1', 'p-setup@', [
      form('PRESS_SETUP', 'Press set-up', { press: str('Press'), useId: str('Use', ID), issueId: str('Issue', ID) }),
      form('HOPPER_CHARGE', 'Hopper charge', { chargeId: str('Charge', ID) }),
    ]);
    const press = { useId: USE_PRESS, kind: 'PROCESS' as const, equipmentCode: 'PRESS-01', batchNumber: 'B26-0007', startedBy: OP, startedAt: at('20-OCT-2026 09:00'), plannedEnd: at('20-OCT-2026 21:00'), ended: null, mine: true };
    const issue = { issueId: ISSUE, set: 'TS-F100', press: 'PRESS-01', counts: { upper: 45, lower: 45, dies: 45 }, preUse: { inspectionId: INSPECTION, result: 'PASS' as const }, returned: null, postUse: null };
    const current = plant({
      block: 'TB-10@1', stage: 'S-COMP', uses: [press], tooling: { checklist: [], sets: [], issues: [issue], preUse: [] },
      containers: [{ containerId: CONTAINER, label: 'OC-B26-0007-0001', stage: 'BLENDING', netQuantity: '19.880', unit: 'kg', problem: null }],
    });
    const ui = render(view, () => current, { 'plant.chargeContainer': () => ({ chargeId: CHARGE, containerId: CONTAINER, label: 'OC-B26-0007-0001', netQuantity: '19.880', unit: 'kg' }) });
    const panel = await screen.findByTestId('plant-press-setup');
    await userEvent.click(within(panel).getByRole('button', { name: 'Set up PRESS-01 with set TS-F100' }));
    const setup = await screen.findByTestId('block-form-PRESS_SETUP');
    await userEvent.click(within(setup).getByRole('button', { name: 'Save: Press set-up' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(entryOf(ui)).toEqual({ kind: 'BLOCK_ENTRY', entryKind: 'PRESS_SETUP', data: { press: 'PRESS-01', useId: USE_PRESS, issueId: ISSUE } });
    await userEvent.click(within(screen.getByTestId('plant-press-setup')).getByRole('button', { name: 'Charge container OC-B26-0007-0001' }));
    await waitFor(() => expect(posts(ui, '/api/plant/charges')).toHaveLength(1));
    expect(posts(ui, '/api/plant/charges')[0]?.body).toMatchObject({ batchId: RUN_ID, stage: 'S-COMP', label: 'OC-B26-0007-0001' });
    const charge = await screen.findByTestId('block-form-HOPPER_CHARGE');
    await userEvent.click(within(charge).getByRole('button', { name: 'Save: Hopper charge' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(2));
    const data = (entryOf(ui) as { data: { chargeId: string } }).data;
    expect(data.chargeId).toMatch(UUID);
    expect(data).toEqual({ chargeId: CHARGE });
  });
});
