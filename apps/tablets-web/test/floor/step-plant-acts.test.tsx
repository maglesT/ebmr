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
import { routes, type BlockEntryFormView, type BlockFieldSchemaWire, type StepPlantView, type StepScreenView } from '@ebmr/api-contract';
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
  tooling: { checklist: ['TIPS', 'EDGES'], sets: [], issues: [], preUse: [] }, containers: [], charges: [], layers: [], chargedStages: {}, ...over,
});

function render(view: StepScreenView, current: () => StepPlantView, acts: Record<string, () => unknown>) {
  return renderFloor(stepPath(view.step.stepKey), { installation: 'GMP', fixtures: { 'batches.step': () => view, ...stepFixtures(view), 'batches.stepPlant': current, ...acts } });
}
const posts = (ui: ReturnType<typeof renderFloor>, path: string) => ui.requests.filter((r) => r.method === 'POST' && r.path === path);
const entryOf = (ui: ReturnType<typeof renderFloor>) => (ui.commands().at(-1)?.body?.['intent'] as { entry: unknown } | undefined)?.entry;

const entry = (kind: string, data: Record<string, unknown>) => ({ entryId: `${kind}-1`, kind, summary: kind, data, by: OP, at: at('20-OCT-2026 09:01') });
const accepted = () => ({ accepted: true as const, version: 4, step: null });

describe('the room a clearance step occupies (A2; R3.3)', () => {
  it('[IN-21][PR-34][INV-40] starts the batch\'s use of the stage\'s room and records it in the step as one act, then ends the use', async () => {
    const view = gmpView('G-10@2', 'p-disp-clear@', [form('AREA_OCCUPANCY', 'Area occupancy', { areaCode: str('Area'), occupancyId: str('Occupancy', ID) })]);
    const occupancy = { occupancyId: OCC, areaCode: 'DISP-1', batchNumber: 'B26-0007', stage: 'S-DISP', startedBy: OP, startedAt: at('20-OCT-2026 09:00'), ended: null };
    let current = plant({ block: 'G-10@2', areas: [{ code: 'DISP-1', kind: 'ROOM', state: 'CLEARED' }] });
    let shown = view;
    const ui = renderFloor(stepPath(view.step.stepKey), {
      installation: 'GMP',
      fixtures: {
        'batches.step': () => shown,
        ...stepFixtures(view),
        'batches.stepPlant': () => current,
        'batches.plantEntry': () => {
          current = { ...current, occupancies: [{ ...occupancy, mine: true }] };
          shown = { ...view, entries: [entry('AREA_OCCUPANCY', { areaCode: 'DISP-1', occupancyId: OCC })] };
          return accepted();
        },
        'plant.endAreaOccupancy': () => ({ ...occupancy, ended: { by: OP, at: at('20-OCT-2026 12:00') } }),
      },
    });
    const panel = await screen.findByTestId('step-plant');
    await userEvent.click(within(panel).getByRole('button', { name: 'Start using room DISP-1 and record it in this step' }));
    const path = `/api/batches/${RUN_ID}/steps/${encodeURIComponent('p-disp-clear@')}/plant-entries`;
    await waitFor(() => expect(posts(ui, path)).toHaveLength(1));
    expect(posts(ui, path)[0]?.body).toMatchObject({ expectedVersion: view.run.version, act: { act: 'START_AREA_OCCUPANCY', areaCode: 'DISP-1' } });
    // No separate save: the step records the room, and the panel says so.
    await waitFor(() => expect(within(screen.getByTestId('occupancy-DISP-1')).getByText('Recorded in this step.')).toBeTruthy());
    expect(within(screen.getByTestId('occupancy-DISP-1')).queryByRole('button', { name: 'Record DISP-1 in this step' })).toBeNull();
    expect(ui.commands()).toHaveLength(0);
    await userEvent.click(await within(screen.getByTestId('step-plant')).findByRole('button', { name: 'End the use of DISP-1' }));
    await waitFor(() => expect(posts(ui, `/api/plant/occupancies/${OCC}/end`)).toHaveLength(1));
  });
});

describe('the units a status step checks (A3, A4; R3.3, R3.4)', () => {
  it('[PR-23][IN-25][INV-40] records the balance\'s per-use check, books it and the press each with its record in the step as one act; a booked unit is not offered for booking again and says until when', async () => {
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
    let shown = view;
    const ui = renderFloor(stepPath(view.step.stepKey), {
      installation: 'GMP',
      fixtures: {
        'batches.step': () => shown,
        ...stepFixtures(view),
        'batches.stepPlant': () => current,
        'plant.recordInstrumentCheck': () => ({ checkId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d09', equipmentCode: 'BAL-C1', result: 'PASS', regime: 'PER_USE', recordedAt: at('20-OCT-2026 09:00') }),
        'batches.plantEntry': () => {
          const first = current.uses.length === 0;
          const useId = first ? USE_BAL : USE_PRESS;
          const kind = first ? ('INSTRUMENT' as const) : ('PROCESS' as const);
          const code = first ? 'BAL-C1' : 'PRESS-01';
          const ref = first ? 'BAL' : 'PRESS';
          current = { ...current, uses: [...current.uses, { ...booking(useId, kind, code), mine: true }] };
          shown = { ...shown, entries: [...shown.entries, { ...entry('EQUIPMENT_USE', { equipmentRef: ref, equipmentCode: code, useId }), entryId: useId }] };
          return accepted();
        },
      },
    });
    const path = `/api/batches/${RUN_ID}/steps/${encodeURIComponent('p-comp-status@')}/plant-entries`;
    const bal = await screen.findByTestId('plant-unit-BAL');
    await userEvent.click(within(bal).getByRole('button', { name: 'Per-use check of BAL-C1 passed' }));
    await waitFor(() => expect(posts(ui, '/api/plant/instruments/BAL-C1/checks')).toHaveLength(1));
    expect(posts(ui, '/api/plant/instruments/BAL-C1/checks')[0]?.body).toMatchObject({ result: 'PASS', reference: 'Per-use check', batchId: RUN_ID });
    await userEvent.click(within(screen.getByTestId('plant-unit-BAL')).getByRole('button', { name: 'Book BAL-C1 and record it in this step' }));
    await waitFor(() => expect(posts(ui, path)).toHaveLength(1));
    expect(posts(ui, path)[0]?.body).toMatchObject({ act: { act: 'BOOK_UNIT', equipmentRef: 'BAL', code: 'BAL-C1', plannedHours: '12' } });
    await waitFor(() => expect(within(screen.getByTestId('use-BAL-C1')).getByText('Recorded in this step for BAL.')).toBeTruthy());
    expect(within(screen.getByTestId('plant-unit-BAL')).getByText('BAL-C1 booked until 20-OCT-2026 21:00')).toBeTruthy();
    expect(within(screen.getByTestId('plant-unit-BAL')).queryByRole('button', { name: /^Book BAL-C1/ })).toBeNull();
    await userEvent.click(within(screen.getByTestId('plant-unit-PRESS')).getByRole('button', { name: 'Book PRESS-01 and record it in this step' }));
    await waitFor(() => expect(posts(ui, path)).toHaveLength(2));
    expect(posts(ui, path)[1]?.body).toMatchObject({ act: { act: 'BOOK_UNIT', equipmentRef: 'PRESS', code: 'PRESS-01', plannedHours: '12' } });
    await waitFor(() => expect(within(screen.getByTestId('use-PRESS-01')).getByText('Recorded in this step for PRESS.')).toBeTruthy());
    expect(ui.commands()).toHaveLength(0);
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
    // The plant stage the container goes into (the contract's stage code), never the master's stage id S-COMP.
    expect(posts(ui, '/api/plant/charges')[0]?.body).toMatchObject({ batchId: RUN_ID, stage: 'COMPRESSION', label: 'OC-B26-0007-0001' });
    expect(routes.plant.chargeContainer.body?.safeParse(posts(ui, '/api/plant/charges')[0]?.body).success).toBe(true);
    const charge = await screen.findByTestId('block-form-HOPPER_CHARGE');
    await userEvent.click(within(charge).getByRole('button', { name: 'Save: Hopper charge' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(2));
    const data = (entryOf(ui) as { data: { chargeId: string } }).data;
    expect(data.chargeId).toMatch(UUID);
    expect(data).toEqual({ chargeId: CHARGE });
  });
});

describe('the hopper of each layer of a bilayer run (slice 7m, R1)', () => {
  it('[PR-21][IN-26] offers each layer only the closed containers of its own blend; a charge into the layer\'s hopper fills HOPPER_CHARGE with the layer, its hopper, its blend and the charge, never typed', async () => {
    const view = gmpView('TB-16@1', 'p-run@', [
      form('HOPPER_CHARGE', 'Hopper charge', { layer: str('Layer'), hopper: str('Hopper'), blend: str('Blend'), chargeId: str('Charge', ID) }),
    ]);
    const L2 = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d08';
    const current = plant({
      block: 'TB-16@1', stage: 'S-COMP',
      layers: [{ id: 'L1', hopper: 'H1', stage: 'BLEND_L1' }, { id: 'T', hopper: 'H2', stage: 'BLEND_L2' }],
      containers: [
        { containerId: CONTAINER, label: 'OC-B26-0007-0001', stage: 'BLEND_L1', netQuantity: '33.150', unit: 'kg', problem: null },
        { containerId: L2, label: 'OC-B26-0007-0002', stage: 'BLEND_L2', netQuantity: '14.350', unit: 'kg', problem: null },
      ],
    });
    const ui = render(view, () => current, { 'plant.chargeContainer': () => ({ chargeId: CHARGE, containerId: L2, label: 'OC-B26-0007-0002', netQuantity: '14.350', unit: 'kg' }) });
    const panel = await screen.findByTestId('plant-layer-charge');
    // Each layer lists only its own blend's containers: no button would put the lactose blend into hopper H1.
    expect(within(within(panel).getByTestId('layer-L1')).queryByRole('button', { name: /OC-B26-0007-0002/ })).toBeNull();
    expect(within(within(panel).getByTestId('layer-T')).queryByRole('button', { name: /OC-B26-0007-0001/ })).toBeNull();
    await userEvent.click(within(within(panel).getByTestId('layer-T')).getByRole('button', { name: 'Charge OC-B26-0007-0002 into hopper H2' }));
    await waitFor(() => expect(posts(ui, '/api/plant/charges')).toHaveLength(1));
    expect(posts(ui, '/api/plant/charges')[0]?.body).toMatchObject({ batchId: RUN_ID, stage: 'COMPRESSION', label: 'OC-B26-0007-0002' });
    const charge = await screen.findByTestId('block-form-HOPPER_CHARGE');
    await userEvent.click(within(charge).getByRole('button', { name: 'Save: Hopper charge' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(entryOf(ui)).toEqual({ kind: 'BLOCK_ENTRY', entryKind: 'HOPPER_CHARGE', data: { layer: 'T', hopper: 'H2', blend: 'BLEND_L2', chargeId: CHARGE } });
  });
});

describe('the charges a bilayer step has recorded already (7m review P7M-1)', () => {
  it('[PR-21][IN-26] offers "Record the charge" only for a charge the step has not recorded (a second entry of a charge is refused by the database: db-guards.test.ts TB16-CHARGE)', async () => {
    const view = gmpView('TB-16@1', 'p-run@', [
      form('HOPPER_CHARGE', 'Hopper charge', { layer: str('Layer'), hopper: str('Hopper'), blend: str('Blend'), chargeId: str('Charge', ID) }),
    ]);
    const OTHER = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d09';
    view.entries = [{ entryId: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d10', kind: 'HOPPER_CHARGE', summary: 'hopper charge', data: { layer: 'L1', hopper: 'H1', blend: 'BLEND_L1', chargeId: CHARGE }, by: OP, at: at('20-OCT-2026 10:01') }];
    const charge = (chargeId: string, label: string) => ({ chargeId, label, stage: 'COMPRESSION', chargedBy: OP, chargedAt: at('20-OCT-2026 10:00'), mine: true });
    const current = plant({
      block: 'TB-16@1', stage: 'S-COMP',
      layers: [{ id: 'L1', hopper: 'H1', stage: 'BLEND_L1' }],
      charges: [charge(CHARGE, 'OC-B26-0007-0001'), charge(OTHER, 'OC-B26-0007-0003')],
      chargedStages: { [CHARGE]: 'BLEND_L1', [OTHER]: 'BLEND_L1' },
    });
    render(view, () => current, {});
    const layer = within(await screen.findByTestId('plant-layer-charge')).getByTestId('layer-L1');
    expect(await within(layer).findByRole('button', { name: 'Record the charge of OC-B26-0007-0003 into hopper H1' })).toBeTruthy();
    expect(within(layer).queryByRole('button', { name: 'Record the charge of OC-B26-0007-0001 into hopper H1' })).toBeNull();
  });
});

describe('the printed lot hands itself to the issue entry once (slice 7k)', () => {
  it('[PR-32] a saved issue entry stays closed: the lot taken is not handed to the form again', async () => {
    const lotSchema: BlockFieldSchemaWire = { type: 'object', description: 'Lot', fields: { id: str('Lot id'), material: str('Material'), status: str('Status'), artwork: str('Artwork') } };
    const view = gmpView('G-21@1', 'p-g21@', [form('ISSUE', 'Issue', { lot: lotSchema, scannedArtwork: str('Scanned artwork') })]);
    const ui = renderFloor(stepPath(view.step.stepKey), {
      installation: 'GMP',
      fixtures: {
        'batches.step': () => view,
        ...stepFixtures(view),
        'batches.stepPlant': () => plant({ block: 'G-21@1' }),
        'execution.packagingBatchData': { batchId: RUN_ID, stepKey: 'p-g21@', current: null, jobs: [] },
        'batches.printedLot': { id: 'GBT2-LBL-001', material: 'MAT-LBL-GBT02', status: 'RELEASED', artwork: 'ART-GBT02-LBL-1' },
      },
      intercept: (r) => (r.method === 'POST' && r.path.endsWith('/commands') ? { status: 200, body: accepted() } : undefined),
    });
    const panel = await screen.findByTestId('printed-lot');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Scan the printed packaging lot' }), 'GBT2-LBL-001');
    await userEvent.click(within(panel).getByRole('button', { name: 'Take the lot from the register' }));
    const issue = await screen.findByTestId('block-form-ISSUE');
    await userEvent.type(within(issue).getByRole('textbox', { name: /Scanned artwork/ }), 'ART-GBT02-LBL-1');
    await userEvent.click(within(issue).getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect((entryOf(ui) as { data: { lot: { id: string } } }).data.lot.id).toBe('GBT2-LBL-001');
    await waitFor(() => expect(screen.getByTestId('block-form-ISSUE').getAttribute('data-closed')).toBe('true'));
    // The views read again after the save do not reopen it with the same lot.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByTestId('block-form-ISSUE').getAttribute('data-closed')).toBe('true');
    expect(ui.commands()).toHaveLength(1);
  });
});
