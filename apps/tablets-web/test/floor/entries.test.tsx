/**
 * Block entries (module C4): each renderer sends only what the contract's strict ClientEntry allows: lots as
 * codes, weights as reading ids (or hand-typed values on the two-person path), checklist answers with nothing
 * pre-selected; one badge tap per entry. The renderer registry lists every executable block version.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ClientEntry, TABLET_ENTRY_KINDS_BY_BLOCK } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { blocks } from '@ebmr/recipe-core/pure';
import type { ScaleCaptureSlotProps } from '../../src/app/ports.tsx';
import { RENDERERS, rendererFor } from '../../src/features/floor/renderers/registry.ts';
import { grossAboveTare } from '../../src/features/floor/renderers/parts.tsx';
import { envelope, fakeScaleSlot, reading, renderFloor, RUN_ID, stepFixtures, stepPath, stepVariant, type Answer, type Recorded } from './support.tsx';

const commandPath = `/api/test-runs/${RUN_ID}/commands`;
const ok = (r: Recorded, step = example('step-g07-weighing')): Answer | undefined => (r.path === commandPath ? { status: 200, body: { accepted: true, version: 8, step } } : undefined);
const entryOf = (r: Recorded | undefined) => (r?.body?.['intent'] as { entry?: unknown } | undefined)?.entry;

/** G-07 as the server should send it: the BOM line to choose (the example lacks it; proposal to the lead). */
// The shared example carries the server's bomLine field; these variants pin the cases the tests need.
const withoutBomLine = (v: { entryForms: { fields: { name: string }[] }[] }): void => {
  v.entryForms[0]!.fields = v.entryForms[0]!.fields.filter((f) => f.name !== 'bomLine');
};
const g07WithoutBom = stepVariant('step-g07-weighing', withoutBomLine);
const g07WithBom = stepVariant('step-g07-weighing', (v) => {
  withoutBomLine(v);
  v.entryForms[0]!.fields.unshift({
    name: 'bomLine',
    label: 'Material (BOM line)',
    type: 'enum',
    unit: null,
    options: [{ value: 'BOM-API', label: 'Paracetamol (BOM-API)' }],
    required: true,
    description: 'The BOM line this container is for',
  });
});

describe('G-07 weighing and dispensing', () => {
  it('[INV-25] sends the lot as a code and tare and gross as reading ids only, with one badge tap; the net is left to the server', async () => {
    const seen: ScaleCaptureSlotProps[] = [];
    const slot = fakeScaleSlot({ TARE: reading('TARE', 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e01', '1.250'), GROSS: reading('GROSS', 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e02', '13.753') }, seen);
    const ui = renderFloor(stepPath('p-disp-api@'), { scaleSlot: slot, fixtures: stepFixtures(g07WithBom), intercept: (r) => ok(r) });
    const form = await screen.findByTestId('form-CONTAINER_WEIGHING');
    const save = within(form).getByRole('button', { name: 'Save: Weigh one container' });
    expect(save.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(form).getByRole('textbox', { name: 'Lot' }), 'TEST-L26-0101{Enter}');
    await userEvent.click(within(form).getByRole('radio', { name: 'Paracetamol (BOM-API)' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Capture tare on TEST-BAL-01' }));
    expect(within(form).getByTestId('reading-TARE').textContent).toContain('1.250 kg on TEST-BAL-01');
    await userEvent.click(within(form).getByRole('button', { name: 'Capture gross on TEST-BAL-01' }));
    expect(save.hasAttribute('disabled')).toBe(false);
    await userEvent.click(save);
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(ui.tap.requestTap).toHaveBeenCalledTimes(1);
    const entry = entryOf(ui.commands()[0]);
    expect(entry).toEqual({ kind: 'CONTAINER_WEIGHING', item: 'dispApi', bomLine: 'BOM-API', lotCode: 'TEST-L26-0101', tareReadingId: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e01', grossReadingId: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e02' });
    expect(ClientEntry.safeParse(entry).success).toBe(true);
    // The live gauge gets the display band of the weighed item (decimal text; display only).
    expect(seen.find((p) => p.purpose === 'GROSS')?.band).toEqual({ unit: 'kg', low: '24.875', high: '25.125', target: '25.000' });
    expect(seen.find((p) => p.purpose === 'TARE')?.band).toBeUndefined();
  });

  it('a gross that is not above the tare (the material not put on the scale) is said before anything is sent; the readings stay for a new gross', async () => {
    const slot = fakeScaleSlot({ TARE: reading('TARE', 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e01', '0.200'), GROSS: reading('GROSS', 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e02', '0.2') });
    const ui = renderFloor(stepPath('p-disp-api@'), { scaleSlot: slot, fixtures: stepFixtures(g07WithBom), intercept: (r) => ok(r) });
    const form = await screen.findByTestId('form-CONTAINER_WEIGHING');
    const save = within(form).getByRole('button', { name: 'Save: Weigh one container' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Lot' }), 'TEST-L26-0101{Enter}');
    await userEvent.click(within(form).getByRole('radio', { name: 'Paracetamol (BOM-API)' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Capture tare on TEST-BAL-01' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Capture gross on TEST-BAL-01' }));
    expect(within(form).getByRole('alert').textContent).toBe('The gross (0.2 kg) is not above the tare (0.200 kg): put the material on the scale and capture the gross again.');
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(ui.commands()).toHaveLength(0);
    expect(within(form).getByTestId('reading-TARE').textContent).toContain('0.200 kg on TEST-BAL-01');
  });

  it('names what the step does not say (the BOM line) instead of sending an entry the contract refuses', async () => {
    renderFloor(stepPath('p-disp-api@'), { scaleSlot: fakeScaleSlot({}), fixtures: stepFixtures(g07WithoutBom) });
    const form = await screen.findByTestId('form-CONTAINER_WEIGHING');
    expect(within(form).getByRole('alert').textContent).toContain('The step does not say which bomLine this entry is for');
    expect(within(form).getByRole('button', { name: 'Save: Weigh one container' }).hasAttribute('disabled')).toBe(true);
  });

  it('after an engine refusal the readings it used are used up: the person captures again (DEV-105)', async () => {
    const slot = fakeScaleSlot({ TARE: reading('TARE', 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e01', '1.250'), GROSS: reading('GROSS', 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e02', '13.753') });
    // The engine refusal is committed with the command's claims; the server names the readings it used (F59).
    const readingsUsed = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e01,c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e02';
    renderFloor(stepPath('p-disp-api@'), {
      scaleSlot: slot,
      fixtures: stepFixtures(g07WithBom),
      intercept: (r) => (r.path === commandPath ? { status: 422, body: envelope('NOT_ALLOWED', 'G07-LOT-STATUS', { whatHappened: 'Lot TEST-L26-0101 is in quarantine.', details: { readingsUsed } }) } : undefined),
    });
    const form = await screen.findByTestId('form-CONTAINER_WEIGHING');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Lot' }), 'TEST-L26-0101{Enter}');
    await userEvent.click(within(form).getByRole('radio', { name: 'Paracetamol (BOM-API)' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Capture tare on TEST-BAL-01' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Capture gross on TEST-BAL-01' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Save: Weigh one container' }));
    expect(await within(form).findByText('Lot TEST-L26-0101 is in quarantine.')).toBeTruthy();
    expect(within(form).getByRole('button', { name: 'Capture tare on TEST-BAL-01' })).toBeTruthy();
    expect(within(form).queryByTestId('reading-TARE')).toBeNull();
    expect(within(form).getByText('Scanned: TEST-L26-0101')).toBeTruthy();
  });

  it('[DI-32][DI-34] after a stale answer (409) the readings stay: the server used none, and the resend names the same readings (F58)', async () => {
    const slot = fakeScaleSlot({ TARE: reading('TARE', 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e01', '1.250'), GROSS: reading('GROSS', 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e02', '13.753') });
    let calls = 0;
    const ui = renderFloor(stepPath('p-disp-api@'), {
      scaleSlot: slot,
      fixtures: stepFixtures(g07WithBom),
      intercept: (r) => {
        if (r.path !== commandPath) return undefined;
        calls += 1;
        return calls === 1 ? { status: 409, body: envelope('STALE', 'ENG-STALE', { whatHappened: 'The test run changed since this screen was loaded. The refusal is recorded; no scale reading was used, and nothing else changed.' }) } : ok(r);
      },
    });
    const form = await screen.findByTestId('form-CONTAINER_WEIGHING');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Lot' }), 'TEST-L26-0101{Enter}');
    await userEvent.click(within(form).getByRole('radio', { name: 'Paracetamol (BOM-API)' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Capture tare on TEST-BAL-01' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Capture gross on TEST-BAL-01' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Save: Weigh one container' }));
    await screen.findByTestId('stale-changes');
    // The floor says what happened: not saved, the refusal recorded, no scale reading used (F58.1).
    expect(within(form).getByText(/Your entry was not saved: the refusal is recorded in the test run, and no scale reading was used\./)).toBeTruthy();
    expect(within(form).getByTestId('reading-TARE').textContent).toContain('1.250 kg on TEST-BAL-01');
    expect(within(form).getByTestId('reading-GROSS').textContent).toContain('13.753 kg on TEST-BAL-01');
    await userEvent.click(within(form).getByRole('button', { name: 'Save: Weigh one container' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(2));
    expect(entryOf(ui.commands()[1])).toMatchObject({ tareReadingId: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e01', grossReadingId: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e02' });
  });
});

describe('G-22 output containers with the scale offline', () => {
  it('offers only the manual path, clearly marked two-person, and sends the typed tare and gross as decimal text (no reading ids)', async () => {
    const seen: ScaleCaptureSlotProps[] = [];
    const ui = renderFloor(stepPath('p-blend-out@'), { scaleSlot: fakeScaleSlot({}, seen), intercept: (r) => ok(r, example('step-g22-output')) });
    const form = await screen.findByTestId('form-OUTPUT_CONTAINER');
    expect(within(form).getByText('Manual weighing: two-person rule')).toBeTruthy();
    expect(seen).toHaveLength(0);
    await userEvent.click(within(form).getByRole('radio', { name: 'Final blend' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Tare (typed by hand)' }), '1.05');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Gross (typed by hand)' }), '26.10');
    await userEvent.click(within(form).getByRole('button', { name: 'Save: Weigh one output container' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    const entry = entryOf(ui.commands()[0]);
    expect(entry).toEqual({ kind: 'OUTPUT_CONTAINER', intermediate: 'I-BLEND', manual: { tare: '1.05', gross: '26.10', unit: 'kg' } });
    expect(ClientEntry.safeParse(entry).success).toBe(true);
  });

  it('a Save that cannot be pressed says what is still needed, in screen order, until nothing is', async () => {
    renderFloor(stepPath('p-blend-out@'), { scaleSlot: fakeScaleSlot({}, []), intercept: (r) => ok(r, example('step-g22-output')) });
    const form = await screen.findByTestId('form-OUTPUT_CONTAINER');
    const save = within(form).getByRole('button', { name: 'Save: Weigh one output container' });
    const pending = () => within(form).queryByTestId('still-needed')?.textContent ?? null;
    expect(pending()).toBe('To save, still needed: Intermediate, Tare (typed by hand), Gross (typed by hand).');
    await userEvent.click(within(form).getByRole('radio', { name: 'Final blend' }));
    expect(pending()).toBe('To save, still needed: Tare (typed by hand), Gross (typed by hand).');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Gross (typed by hand)' }), '26.10');
    expect(pending()).toBe('To save, still needed: Tare (typed by hand).');
    expect(save.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(form).getByRole('textbox', { name: 'Tare (typed by hand)' }), '1.05');
    expect(pending()).toBeNull();
    expect(save.hasAttribute('disabled')).toBe(false);
  });

  it('a typed gross that is not above the typed tare is said and cannot be saved', async () => {
    renderFloor(stepPath('p-blend-out@'), { scaleSlot: fakeScaleSlot({}, []), intercept: (r) => ok(r, example('step-g22-output')) });
    const form = await screen.findByTestId('form-OUTPUT_CONTAINER');
    const save = within(form).getByRole('button', { name: 'Save: Weigh one output container' });
    await userEvent.click(within(form).getByRole('radio', { name: 'Final blend' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Tare (typed by hand)' }), '1.05');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Gross (typed by hand)' }), '1.050');
    expect(within(form).getByRole('alert').textContent).toBe('The gross (1.050 kg) is not above the tare (1.05 kg): put the material on the scale and capture the gross again.');
    expect(save.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(form).getByRole('textbox', { name: 'Gross (typed by hand)' }), '1');
    expect(within(form).queryByRole('alert')).toBeNull();
    expect(save.hasAttribute('disabled')).toBe(false);
  });
});

describe('grossAboveTare', () => {
  it('compares decimal text exactly, at any scale and sign; anything else is not judged', () => {
    expect(grossAboveTare('1.0501', '1.05')).toBe(true);
    expect(grossAboveTare('1.050', '1.05')).toBe(false);
    expect(grossAboveTare('1.04', '1.05')).toBe(false);
    expect(grossAboveTare('10', '9.999')).toBe(true);
    expect(grossAboveTare('0', '-0.5')).toBe(true);
    expect(grossAboveTare('-1', '-0.5')).toBe(false);
    expect(grossAboveTare('1.', '0')).toBeNull();
    expect(grossAboveTare('1', 'x')).toBeNull();
  });
});

describe('checklists, scans and acknowledgements', () => {
  it('G-10 clearance: nothing pre-selected; the save waits for every answer; NOT CONFIRMED is sent as answered (the server decides the exception)', async () => {
    const ui = renderFloor(stepPath('p-disp-clear@'), { intercept: (r) => ok(r, example('step-g10-clearance')) });
    const form = await screen.findByTestId('form-CLEARANCE_CHECK');
    expect(within(form).getAllByRole('radio').every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    const save = within(form).getByRole('button', { name: 'Save: Clearance checklist' });
    const answer = async (item: string, word: string) => userEvent.click(within(within(form).getByRole('radiogroup', { name: item })).getByRole('radio', { name: word }));
    await answer('No material of the previous product in the booth', 'Confirmed');
    await answer('No documents or labels of the previous batch', 'Not confirmed');
    expect(save.hasAttribute('disabled')).toBe(true);
    await answer('Equipment carries a valid CLEAN label', 'Not applicable');
    await userEvent.click(save);
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(entryOf(ui.commands()[0])).toEqual({
      kind: 'CLEARANCE_CHECK',
      answers: [
        { id: 'NO_PREVIOUS_MATERIAL', answer: 'CONFIRMED' },
        { id: 'NO_PREVIOUS_DOCUMENTS', answer: 'NOT_CONFIRMED' },
        { id: 'EQUIPMENT_CLEAN_LABEL', answer: 'NOT_APPLICABLE' },
      ],
    });
  });

  it('G-10 previous batch and G-09 equipment status (label by scan, YES/NO checks) build strict entries', async () => {
    const first = renderFloor(stepPath('p-disp-clear@'), { intercept: (r) => ok(r, example('step-g10-clearance')) });
    const prev = await screen.findByTestId('form-PREVIOUS_BATCH');
    await userEvent.type(within(prev).getByRole('textbox', { name: 'Previous product' }), 'Ibuprofen 400 mg tablets');
    await userEvent.type(within(prev).getByRole('textbox', { name: 'Previous batch number' }), 'TEST-B26-0000');
    await userEvent.click(within(prev).getByRole('button', { name: 'Save: Previous batch' }));
    await waitFor(() => expect(first.commands()).toHaveLength(1));
    expect(entryOf(first.commands()[0])).toEqual({ kind: 'PREVIOUS_BATCH', product: 'Ibuprofen 400 mg tablets', batchNumber: 'TEST-B26-0000' });
    first.unmount();

    const inProgress = stepVariant('step-g09-equipment-status', (v) => {
      v.step.status = 'IN_PROGRESS';
      v.actions = [{ action: 'RECORD_ENTRY', available: true, primary: true, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] }];
    });
    const second = renderFloor(stepPath('p-disp-bal@'), { fixtures: stepFixtures(inProgress), intercept: (r) => ok(r, inProgress) });
    const form = await screen.findByTestId('form-EQUIPMENT_STATUS');
    await userEvent.click(within(form).getByRole('radio', { name: 'TEST-BAL-01 Balance 60 kg' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Status label' }), 'TEST-LBL-0042{Enter}');
    for (const check of ['Calibration valid', 'Daily check passed today', 'Clean and ready']) await userEvent.click(within(within(form).getByRole('radiogroup', { name: check })).getByRole('radio', { name: 'Yes' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Save: Equipment status' }));
    await waitFor(() => expect(second.commands()).toHaveLength(1));
    expect(entryOf(second.commands()[0])).toEqual({
      kind: 'EQUIPMENT_STATUS',
      equipmentRef: 'balance',
      labelId: 'TEST-LBL-0042',
      answers: [
        { id: 'CALIBRATED', answer: 'YES' },
        { id: 'DAILY_CHECK', answer: 'YES' },
        { id: 'CLEAN', answer: 'YES' },
      ],
    });
  });

  it('G-03 acknowledgement and G-08 charge-in by container scan', async () => {
    const a = renderFloor(stepPath('p-disp-sop@'), { intercept: (r) => ok(r, example('step-g03-acknowledge')) });
    const ack = await screen.findByTestId('form-ACKNOWLEDGE');
    await userEvent.click(within(ack).getByRole('radio', { name: 'I have read the instruction' }));
    await userEvent.click(within(ack).getByRole('button', { name: 'Save: Acknowledge the instruction' }));
    await waitFor(() => expect(a.commands()).toHaveLength(1));
    expect(entryOf(a.commands()[0])).toEqual({ kind: 'ACKNOWLEDGE', mode: 'READ' });
    a.unmount();

    const b = renderFloor(stepPath('p-charge@'), { intercept: (r) => ok(r, example('step-g08-charge')) });
    const charge = await screen.findByTestId('form-CHARGE_CONTAINER');
    expect(screen.getByTestId('entry-E-7').textContent).toContain('Charged TEST-B26-0001/C-1');
    await userEvent.type(within(charge).getByRole('textbox', { name: 'Container label' }), 'TEST-B26-0001/C-2{Enter}');
    await userEvent.click(within(charge).getByRole('button', { name: 'Save: Charge a container' }));
    await waitFor(() => expect(b.commands()).toHaveLength(1));
    expect(entryOf(b.commands()[0])).toEqual({ kind: 'CHARGE_CONTAINER', containerCode: 'TEST-B26-0001/C-2' });
  });
});

describe('renderer registry', () => {
  it('lists each executable block version with its dedicated renderer or the schema-driven fallback (strict in A2)', () => {
    const phase = blocks.GENERIC_BLOCK_VERSIONS.filter((b) => b.level === 'PHASE' || b.level === 'HOLD_POINT').map((b) => `${b.type}@${b.version}`);
    // G-09@1 and G-10@1 are the SANDBOX_ONLY manual-attestation versions registered by the execution module (C3); the
    // tablet blocks TB-01 to TB-24 are the edition's (Phase 3 slice 6: the contract's BLOCK_ENTRY list names them all).
    const executable = [...new Set([...phase, 'G-09@1', 'G-10@1', ...Object.keys(TABLET_ENTRY_KINDS_BY_BLOCK)])].sort();
    const table = Object.fromEntries(
      executable.map((key) => {
        const view = key === 'G-17@1' ? { ...example('step-g17-hold-point') } : { ...example('step-g04-parameters'), step: { ...example('step-g04-parameters').step, block: key } };
        const choice = rendererFor(view);
        return [key, choice.fallback ? 'fallback' : 'dedicated'];
      }),
    );
    expect(table).toEqual({
      'G-03@1': 'dedicated',
      'G-04@1': 'dedicated',
      'G-05@1': 'fallback',
      // Phase 3 slice 6: G-06@1 (process values, setpoints, alarms), G-21@1 (printed materials) and G-24@2 (additions
      // from the database's sources) have their screens. The plant-backed G-09@2 and G-10@2 stay on the fallback: their
      // entries (equipment use, area occupancy) are recorded by the server from the plant bindings, not sent from a form.
      'G-06@1': 'dedicated',
      'G-07@1': 'dedicated',
      'G-08@1': 'dedicated',
      'G-09@1': 'dedicated',
      'G-09@2': 'dedicated',
      'G-10@1': 'dedicated',
      'G-10@2': 'dedicated',
      'G-11@1': 'fallback',
      'G-12@1': 'fallback',
      'G-13@1': 'fallback',
      'G-14@1': 'fallback',
      'G-15@1': 'fallback',
      'G-16@1': 'fallback',
      'G-17@1': 'dedicated',
      'G-20@1': 'dedicated',
      'G-21@1': 'dedicated',
      'G-22@1': 'dedicated',
      'G-23@1': 'dedicated',
      'G-24@1': 'fallback',
      'G-24@2': 'dedicated',
      ...Object.fromEntries(Object.keys(TABLET_ENTRY_KINDS_BY_BLOCK).filter((k) => k.startsWith('TB-')).map((k) => [k, 'dedicated'])),
    });
    // No tablet block, G-06, G-21 or G-24@2 on the fallback (slice 6 brief).
    expect(Object.keys(TABLET_ENTRY_KINDS_BY_BLOCK).filter((k) => table[k] !== 'dedicated')).toEqual([]);
    expect(Object.keys(RENDERERS).every((k) => executable.includes(k))).toBe(true);
  });

  it('the fallback renders a category value as choices and sends it as RECORD_DATA; an entry kind the contract does not know cannot be sent', async () => {
    const g05 = stepVariant('step-g04-parameters', (v) => {
      v.step = { ...v.step, stepKey: 'p-obs@', stepId: 'p-obs', block: 'G-05@1', blockTitle: 'Observation capture', status: 'IN_PROGRESS', statusText: 'In progress', title: 'Blend appearance' };
      v.fields = [{ ...v.fields[0]!, item: 'appearance', name: 'Blend appearance', valueType: 'CATEGORY', unit: null, precision: null, categories: ['UNIFORM', 'NOT_UNIFORM'], target: null, limits: [], attempts: [] }];
      v.exceptions = [];
      v.signatures = [];
      v.entryForms = [{ kind: 'LINE_CHECK', title: 'Line check', description: 'Not a contract entry', fields: [{ name: 'ok', label: 'Line clear', type: 'boolean', unit: null, options: null, required: true, description: '' }] }];
      v.actions = [
        { action: 'RECORD_DATA', available: true, primary: true, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] },
        { action: 'RECORD_ENTRY', available: true, primary: false, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] },
      ];
    });
    const ui = renderFloor(stepPath('p-obs@'), { fixtures: stepFixtures(g05), intercept: (r) => ok(r, g05) });
    const field = await screen.findByTestId('field-appearance');
    await userEvent.click(within(field).getByRole('radio', { name: 'UNIFORM' }));
    await userEvent.click(within(field).getByRole('button', { name: 'Save Blend appearance' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(ui.commands()[0]?.body?.['intent']).toEqual({ type: 'RECORD_DATA', stepKey: 'p-obs@', item: 'appearance', value: { kind: 'CATEGORY', value: 'UNIFORM' }, source: { mode: 'MANUAL' } });
    const form = screen.getByTestId('form-LINE_CHECK');
    await userEvent.click(within(form).getByRole('radio', { name: 'Yes' }));
    expect(within(form).getByRole('alert').textContent).toContain('This entry cannot be sent from this screen');
    expect(within(form).getByRole('button', { name: 'Save: Line check' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('a value card (RECORD_DATA) says why its Save cannot be pressed (F64)', () => {
  // A value card with one decimal place, so the floor keypad offers the decimal point.
  const valueCard = stepVariant('step-g04-parameters', (v) => {
    v.step = { ...v.step, stepKey: 'p-vc@', stepId: 'p-vc', status: 'IN_PROGRESS', statusText: 'In progress' };
    v.fields = [{ ...v.fields[0]!, item: 'lod', name: 'Loss on drying', unit: '%', precision: { kind: 'DECIMALS', digits: 1 }, target: null, limits: [], attempts: [] }];
    v.exceptions = [];
    v.signatures = [];
    v.entryForms = [];
    v.actions = [{ action: 'RECORD_DATA', available: true, primary: true, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] }];
  });

  it('nothing given yet, then "12." on the keypad: the card says what is still needed; once the number is complete the line goes and Save can be pressed', async () => {
    renderFloor(stepPath('p-vc@'), { fixtures: stepFixtures(valueCard) });
    const card = await screen.findByTestId('field-lod');
    const save = within(card).getByRole('button', { name: 'Save Loss on drying' });
    expect(within(card).getByTestId('still-needed').textContent).toBe('To save, still needed: Loss on drying.');
    const keypad = within(card).getByRole('group', { name: /keypad/i });
    await userEvent.click(within(keypad).getByRole('button', { name: '1' }));
    await userEvent.click(within(keypad).getByRole('button', { name: '2' }));
    await userEvent.click(within(keypad).getByRole('button', { name: /point|\./i }));
    expect(within(card).getByRole<HTMLInputElement>('textbox', { name: 'Loss on drying' }).value).toBe('12.');
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(within(card).getByTestId('still-needed').textContent).toBe('To save, still needed: Loss on drying, as a whole number or with its decimals (it ends with the decimal point).');
    await userEvent.click(within(keypad).getByRole('button', { name: '5' }));
    expect(within(card).queryByTestId('still-needed')).toBeNull();
    expect(save.hasAttribute('disabled')).toBe(false);
  });

  it('a choice not made yet is named; made, the line goes', async () => {
    const yesNo = stepVariant('step-g04-parameters', (v) => {
      v.step = { ...v.step, stepKey: 'p-vc@', stepId: 'p-vc', status: 'IN_PROGRESS', statusText: 'In progress' };
      v.fields = [{ ...v.fields[0]!, item: 'clean', name: 'Blender clean', valueType: 'BOOLEAN', unit: null, precision: null, target: null, limits: [], attempts: [] }];
      v.exceptions = [];
      v.signatures = [];
      v.entryForms = [];
      v.actions = [{ action: 'RECORD_DATA', available: true, primary: true, requires: 'TAP', meaning: null, reason: null, target: null, whoCanHelp: [] }];
    });
    renderFloor(stepPath('p-vc@'), { fixtures: stepFixtures(yesNo) });
    const card = await screen.findByTestId('field-clean');
    expect(within(card).getByTestId('still-needed').textContent).toBe('To save, still needed: Blender clean.');
    await userEvent.click(within(card).getByRole('radio', { name: 'Yes' }));
    expect(within(card).queryByTestId('still-needed')).toBeNull();
    expect(within(card).getByRole('button', { name: 'Save Blender clean' }).hasAttribute('disabled')).toBe(false);
  });
});
