/**
 * Phase 3 slice 6 shop floor: the GMP floor reads and commands go to /api/batches/* (D-S6-1); the tablet blocks'
 * BLOCK_ENTRY forms are generated from the server's block schemas (D-S6-2), server-filled members never asked for;
 * an addition takes a source the database listed; an attempt is voided with a reason and QA's approval, never deleted.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepScreenView } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { buildBlockEntry, toWire, type BlockEntryFormDef } from '../../src/features/floor/renderers/block-entry.tsx';
import { fakeCeremony, renderFloor, RUN_ID, stepFixtures, stepPath, stepVariant } from './support.tsx';

afterEach(() => {
  apiState.installation = undefined;
});

const tb08 = (): StepScreenView => structuredClone(example('batches-step-tb08'));

function gmpStep(view: StepScreenView) {
  return { 'batches.step': () => view, ...stepFixtures(view) };
}

describe('the GMP floor uses the batches routes (D-S6-1)', () => {
  it('reads the step from /api/batches and sends a TB-08 addition as a BLOCK_ENTRY with the chosen source; the source facts are never asked for', async () => {
    const view = tb08();
    const ui = renderFloor(stepPath(view.step.stepKey), { installation: 'GMP', fixtures: gmpStep(view) });
    await screen.findByTestId('step-card');
    expect(ui.requests.some((r) => r.method === 'GET' && r.path === `/api/batches/${RUN_ID}/steps/${encodeURIComponent(view.step.stepKey)}`)).toBe(true);
    expect(ui.requests.some((r) => r.path.startsWith('/api/test-runs'))).toBe(false);

    const sources = await screen.findByTestId('addition-sources');
    await userEvent.click(within(sources).getByRole('button', { name: /^Use / }));
    await userEvent.click(screen.getByRole('button', { name: 'Record: Addition' }));
    const form = screen.getByTestId('block-form-ADDITION');
    expect(within(form).getByTestId('chosen-container').textContent).toContain('c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e70');
    // Server-filled members (source facts, the authorisation's signer) have no input.
    expect(within(form).queryByText(/Source batch id/i)).toBeNull();
    expect(within(form).queryByRole('textbox', { name: /Authorised by/i })).toBeNull();
    await userEvent.type(within(form).getByRole('textbox', { name: 'Gross' }), '5.250');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Tare' }), '0.250');
    await userEvent.click(within(form).getByRole('radio', { name: 'kg' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Save: Addition' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    const sent = ui.commands()[0];
    expect(sent?.path).toBe(`/api/batches/${RUN_ID}/commands`);
    expect(sent?.body?.['intent']).toEqual({
      type: 'RECORD_ENTRY',
      stepKey: view.step.stepKey,
      entry: { kind: 'BLOCK_ENTRY', entryKind: 'ADDITION', data: { container: 'c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e70', gross: '5.250', tare: '0.250', unit: 'kg' } },
    });
  });

  it('the sandbox keeps /api/test-runs', async () => {
    const ui = renderFloor(stepPath('p-blend@'));
    await screen.findByTestId('step-card');
    expect(ui.requests.some((r) => r.path.startsWith(`/api/test-runs/${RUN_ID}/steps/`))).toBe(true);
    expect(ui.requests.some((r) => r.path.startsWith('/api/batches'))).toBe(false);
  });
});

describe('schema-driven block entries (D-S6-2)', () => {
  const def: BlockEntryFormDef = {
    kind: 'WEIGHT_CHECK',
    title: 'Weight check',
    description: 'A weight check',
    schema: {
      type: 'object',
      description: 'A weight check',
      fields: {
        instrument: { type: 'string', description: 'Instrument', pattern: '^[A-Z0-9-]+$' },
        capture: { type: 'string', enum: ['DEVICE', 'MANUAL'], description: 'Capture' },
        counter: { type: 'integer', optional: true, description: 'Counter' },
        weights: { type: 'array', optional: true, description: 'Weights', items: { type: 'decimal', description: 'mg' } },
        sampledAtUs: { type: 'string', optional: true, serverFilled: true, description: 'Sampled' },
      },
    },
  };

  it('decimals travel as text, counts as whole numbers, lists in order; a server-filled member is never sent', () => {
    const built = buildBlockEntry(def, { instrument: 'TEST-BAL-01', capture: 'MANUAL', counter: '1200', weights: ['250.1', '249.8'], sampledAtUs: '1' });
    expect(built.entry).toEqual({ kind: 'BLOCK_ENTRY', entryKind: 'WEIGHT_CHECK', data: { instrument: 'TEST-BAL-01', capture: 'MANUAL', counter: 1200, weights: ['250.1', '249.8'] } });
  });

  it('names what is missing and what cannot be read, and builds nothing then', () => {
    const missing = buildBlockEntry(def, { capture: 'MANUAL' });
    expect(missing.entry).toBeNull();
    expect(missing.pending).toEqual(['Instrument']);
    const bad = buildBlockEntry(def, { instrument: 'bal 1', capture: 'MANUAL', counter: '1.5', weights: ['abc'] });
    expect(bad.entry).toBeNull();
    expect(bad.problems.join(' | ')).toMatch(/Instrument: not in the expected format.*Counter: a whole number is needed.*Weights 1/);
  });

  it('an optional object left empty stays absent; a required one names its members', () => {
    const schema = { type: 'object' as const, description: '', optional: true, fields: { value: { type: 'decimal' as const, description: '' } } };
    expect(toWire(schema, {}, 'Quantity')).toEqual({ value: undefined, pending: [], problems: [] });
    expect(toWire({ ...schema, optional: false }, {}, 'Quantity').pending).toEqual(['Quantity / Value']);
  });
});

describe('an attempt is voided with a reason, never deleted (DI-24 screen)', () => {
  const withAttempt = stepVariant('step-g04-parameters', (v) => {
    v.step = { ...v.step, status: 'IN_PROGRESS', statusText: 'In progress' };
  });

  it('the step screen offers the void with a reason and has no delete; on GMP the void is proposed, approved by QA with a signature, then sent naming the approval', async () => {
    const view = { ...withAttempt, blockEntries: [] };
    const act = example('batches-propose-act');
    const ceremony = fakeCeremony({ status: 'SIGNED', manifestation: example('manifestation'), result: null });
    const described: unknown[] = [];
    const describe = ({ body }: { body: unknown }) => {
      described.push(body);
      return { kind: 'ACT_APPROVAL', aggregateType: 'batch_act', aggregateId: act.actId, meaning: 'VOID_AUTHORISED', expectedState: null };
    };
    const ui = renderFloor(stepPath(view.step.stepKey), { installation: 'GMP', fixtures: { ...gmpStep(view), 'esig.describe': describe }, ceremony });
    await screen.findByTestId('step-card');
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Void an attempt (with a reason)' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: /delete/i })).toBeNull();
    expect(within(dialog).getByText(/Nothing is ever deleted/)).toBeTruthy();
    const propose = within(dialog).getByRole('button', { name: 'Ask QA to approve the void' });
    await userEvent.click(within(dialog).getAllByRole('radio')[0]!);
    expect(propose.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Reason for the void/ }), 'Typed into the wrong field');
    await userEvent.click(propose);
    const proposed = ui.requests.find((r) => r.method === 'POST' && r.path === `/api/batches/${RUN_ID}/acts`);
    expect(proposed?.body?.['intent']).toMatchObject({ type: 'VOID_ATTEMPT', stepKey: view.step.stepKey, reason: 'Typed into the wrong field' });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'QA: approve the void' }));
    // What QA signs is the server's description of the approval (esig.describe), never derived in the browser.
    expect(described).toEqual([{ action: { kind: 'ACT_APPROVAL', batchId: act.batchId, actId: act.actId } }]);
    expect(ceremony.sign).toHaveBeenCalledWith(expect.objectContaining({ aggregateType: 'batch_act', aggregateId: act.actId, meaning: act.meaning, action: { kind: 'ACT_APPROVAL', batchId: act.batchId, actId: act.actId } }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ui.commands()).toHaveLength(1));
    expect(ui.commands()[0]?.body?.['intent']).toMatchObject({ type: 'VOID_ATTEMPT', reason: 'Typed into the wrong field', approvalActId: act.actId });
  });
});
