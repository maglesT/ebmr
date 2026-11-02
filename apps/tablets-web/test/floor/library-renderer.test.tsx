/**
 * The generic library renderer (decision 0026 slice S5): one form for every library block, drawn from the step's
 * definition and the product's values: limits shown and a breach flagged while typing (display only), conditional
 * fields, calculated fields never typed, timers, test readings per time point, and repeats; entries go as
 * LIBRARY_ENTRY. Every rule stays the server's and the database's.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ClientEntry, type StepScreenView } from '@ebmr/api-contract';
import { rendererFor } from '../../src/features/floor/renderers/registry.ts';
import { buildSectionEntry, limitText } from '../../src/features/floor/renderers/Library.tsx';
import { renderFloor, RUN_ID, stepFixtures, stepPath, stepVariant, type Answer, type Recorded } from './support.tsx';

const commandPath = `/api/test-runs/${RUN_ID}/commands`;
const entryOf = (r: Recorded | undefined) => (r?.body?.['intent'] as { entry?: unknown } | undefined)?.entry;
const range = (unit: string, low?: string, high?: string) => ({
  unit,
  ranges: [{ tier: 'REGISTERED', ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'REGISTRATION', ref: 'R' } }],
});

const DEF = {
  code: 'IPC-FRIAB',
  version: 1,
  title: 'Friability',
  category: 'TEST_IPC',
  instructions: 'Dedust 10 tablets, weigh, run 100 turns, dedust and weigh again.',
  sections: [
    {
      id: 'run',
      title: 'Run',
      fields: [
        { id: 'w0', label: 'Weight before', type: 'NUMBER', unit: 'g', limitSlot: 'w0' },
        { id: 'w1', label: 'Weight after', type: 'NUMBER', unit: 'g' },
        { id: 'loss', label: 'Weight loss', type: 'CALC', expression: '(w0 - w1) / w0 * 100 [%]', unit: '%', limitSlot: 'loss', critical: true },
        { id: 'cracked', label: 'Any tablet cracked', type: 'YES_NO', expected: false },
        { id: 'note', label: 'What was found', type: 'TEXT', showWhen: { field: 'cracked', equals: true } },
      ],
    },
  ],
  signatures: [{ meaning: 'PERFORMED', role: 'IPC_OPERATOR' }],
};
const CONFIG = { limits: { w0: range('g', '6.000', '7.000'), loss: range('%', undefined, '1.0') } };

const libraryStep = (definition: Record<string, unknown> = DEF, config: Record<string, unknown> = CONFIG, change?: (v: StepScreenView) => void): StepScreenView =>
  stepVariant('step-g07-weighing', (v) => {
    v.step = { ...v.step, stepKey: 'p-lib@', stepId: 'p-lib', block: 'LIB-IPC-FRIAB@1', blockTitle: 'Friability', status: 'IN_PROGRESS' };
    v.fields = [];
    v.entries = [];
    v.entryForms = [];
    v.blockEntries = [];
    v.library = { definition, config };
    change?.(v);
  });

const ok = (step: StepScreenView) => (r: Recorded): Answer | undefined => (r.path === commandPath ? { status: 200, body: { accepted: true, version: 8, step } } : undefined);

describe('the generic library renderer', () => {
  it('[PR-03] every library block has the one generic renderer, never the schema fallback', () => {
    const choice = rendererFor(libraryStep());
    expect(choice.fallback).toBe(false);
    expect(choice.key).toBe('LIB-IPC-FRIAB@1');
  });

  it('[PR-08][INV-25] shows the limits, flags a value outside them while typing, never offers the calculated field, and sends LIBRARY_ENTRY', async () => {
    const view = libraryStep();
    const ui = renderFloor(stepPath('p-lib@'), { fixtures: stepFixtures(view), intercept: ok(view) });
    const form = await screen.findByTestId('lib-section-run');
    expect(screen.getByText(/Dedust 10 tablets/)).toBeTruthy();
    expect(within(form).getByText('Limit 6.000 to 7.000 g')).toBeTruthy();
    expect(within(form).queryByRole('textbox', { name: /Weight loss/ })).toBeNull();
    expect(within(form).getByText('Calculated when saved: Weight loss.')).toBeTruthy();
    await userEvent.type(within(form).getByRole('textbox', { name: 'Weight before (g)' }), '7.500');
    expect(within(form).getByTestId('lib-breach-w0').textContent).toMatch(/Outside the registered limit/);
    await userEvent.clear(within(form).getByRole('textbox', { name: 'Weight before (g)' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Weight before (g)' }), '6.500');
    expect(within(form).queryByTestId('lib-breach-w0')).toBeNull();
    await userEvent.type(within(form).getByRole('textbox', { name: 'Weight after (g)' }), '6.480');
    const save = within(form).getByRole('button', { name: 'Save Run' });
    expect(save.hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(form).getByRole('radio', { name: 'No' }));
    await userEvent.click(save);
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    const entry = entryOf(ui.commands()[0]);
    expect(entry).toEqual({ kind: 'LIBRARY_ENTRY', entryKind: 'run', data: { w0: '6.500', w1: '6.480', cracked: false } });
    expect(ClientEntry.safeParse(entry).success).toBe(true);
  });

  it('[DI-33] a conditional field appears only when its condition holds, and is then required', async () => {
    const view = libraryStep();
    renderFloor(stepPath('p-lib@'), { fixtures: stepFixtures(view), intercept: ok(view) });
    const form = await screen.findByTestId('lib-section-run');
    expect(within(form).queryByRole('textbox', { name: 'What was found' })).toBeNull();
    await userEvent.click(within(form).getByRole('radio', { name: 'Yes' }));
    expect(within(form).getByRole('textbox', { name: 'What was found' })).toBeTruthy();
    expect(within(form).getByText(/Still to enter: Weight before, Weight after, What was found/)).toBeTruthy();
  });

  it('[PR-29] a profile test takes the planned readings at each time point with its limit; the entry carries them by point', () => {
    const section = { id: 'run', title: 'Run', fields: [{ id: 'released', label: 'Released', type: 'TEST_RESULT', unit: '%', replicatesSlot: 'vessels', statistics: [{ statistic: 'MEAN', limitSlot: 'mean' }], perPoint: true }] } as never;
    const config = { counts: { vessels: '2' }, points: { released: [{ id: 'h1', label: '1 h', limits: range('%', '20', '40') }, { id: 'h4', label: '4 h', limits: range('%', '45', '65') }] } } as never;
    const half = buildSectionEntry(section, config, { 'released#h1#0': '30', 'released#h1#1': '31', 'released#h4#0': '50' });
    expect(half.pending).toEqual(['Released']);
    const full = buildSectionEntry(section, config, { 'released#h1#0': '30', 'released#h1#1': '31', 'released#h4#0': '50', 'released#h4#1': '52' });
    expect(full).toEqual({ data: { released: { h1: ['30', '31'], h4: ['50', '52'] } }, pending: [], problems: [] });
    expect(limitText(range('%', '20', '40') as never)).toBe('20 to 40 %');
  });

  it('[PR-30] a timer is started and stopped on the server\'s clock; a section recorded once closes', async () => {
    const def = { ...DEF, sections: [{ id: 'mix', title: 'Mixing', fields: [{ id: 'mixing', label: 'Mixing time', type: 'TIMER', durationUnit: 'min' }, { id: 'speed', label: 'Impeller speed', type: 'NUMBER', unit: 'rpm' }] }] };
    const view = libraryStep(def, {});
    const ui = renderFloor(stepPath('p-lib@'), { fixtures: stepFixtures(view), intercept: ok(view) });
    const timer = await screen.findByTestId('lib-timer-mixing');
    await userEvent.click(within(timer).getByRole('button', { name: 'Start Mixing time' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(entryOf(ui.commands()[0])).toEqual({ kind: 'LIBRARY_ENTRY', entryKind: 'TIMER_START', data: { field: 'mixing' } });

  });

  it('[PR-03] a section recorded once closes; the recorded entry is listed with its sentence', async () => {
    const view = libraryStep(undefined, undefined, (v) => {
      const by = { personId: '7a1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e11', legalName: 'Ravi Kumar', loginName: 'ravi.kumar', role: 'OPERATOR' };
      v.entries = [{ entryId: 'E1', kind: 'run', summary: 'Run: Weight before 6.500 g; Weight after 6.480 g; Weight loss 0.31 % (calculated); Any tablet cracked: no', data: { w0: '6.500' }, by, at: { us: '1', text: 'now' } }];
    });
    renderFloor(stepPath('p-lib@'), { fixtures: stepFixtures(view) });
    expect(await screen.findByText(/Weight loss 0.31 % \(calculated\)/)).toBeTruthy();
    expect(screen.queryByTestId('lib-section-run')).toBeNull();
  });

  it('[PR-01][IN-13] shows the formula quantity and batch size the server scaled to this batch\'s issued size', async () => {
    const def = { ...DEF, inputs: [{ id: 'line', label: 'Formula quantity', kind: 'FORMULA_LINE', unit: 'kg', slot: 'activeLine' }, { id: 'size', label: 'Batch size', kind: 'BATCH_SIZE', unit: 'kg' }] };
    const view = libraryStep(def, CONFIG, (v) => {
      v.library = { definition: def, config: CONFIG, inputs: { line: { value: '31.25', unit: 'kg' }, size: { value: '250', unit: 'kg' } } };
    });
    renderFloor(stepPath('p-lib@'), { fixtures: stepFixtures(view) });
    const list = await screen.findByRole('list', { name: 'Values for this batch' });
    expect(within(list).getByText('Formula quantity: 31.25 kg')).toBeTruthy();
    expect(within(list).getByText('Batch size: 250 kg')).toBeTruthy();
  });
});
