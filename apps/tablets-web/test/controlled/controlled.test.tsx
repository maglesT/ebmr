/**
 * Controlled-substance screens (Phase 6 slice 6e; draft IN-53) on the contract's examples: the draft banner on every
 * screen, the flag awaiting a second QA person, the custody records with the place each custodian signs (the dispensing
 * prompt), the balance panel with an explained difference, and the register export that says whether it reproduces.
 * Every value and gate is the server's.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROLLED_DRAFT_BANNER } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const products = example('controlled-products');
const custody = example('controlled-custody');
const balance = example('controlled-balance');

describe('controlled-substance screens (IN-53, draft)', () => {
  it('[IN-53] the page shows the draft banner; a flag awaiting approval offers QA the approval through the ceremony (CONTROLLED_ACT names the record only)', async () => {
    const ui = renderOffice('/controlled', { role: 'QA_REVIEWER' });
    expect((await screen.findByTestId('controlled-banner')).textContent).toContain(CONTROLLED_DRAFT_BANNER);
    const pending = products.products[1]!;
    const row = await screen.findByTestId(`controlled-flag-${pending.records[0]!.recordId}`);
    expect(row.getAttribute('data-state')).toBe('RECORDED');
    expect(row.textContent).toContain('Awaiting a second QA person');
    expect(screen.getByTestId(`controlled-flag-${products.products[0]!.records[0]!.recordId}`).textContent).toContain('Approved by');
    await userEvent.click(within(row).getByRole('button', { name: `Approve the flag of ${pending.productCode}` }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'CONTROLLED_ACT', act: 'FLAG_APPROVE', subjectId: pending.records[0]!.recordId });
  });

  it('[IN-53] dispensing a controlled API with one person is refused: a record awaiting its second custodian offers only the countersignature, and the dispensing form prompts for dual custody', async () => {
    const ui = renderOffice('/controlled', { role: 'VERIFIER' });
    const awaiting = custody.records[0]!;
    const row = await screen.findByTestId(`controlled-custody-${awaiting.custodyId}`);
    expect(row.textContent).toContain('Awaiting the second custodian');
    expect(within(row).queryByRole('button', { name: 'Sign as the first custodian' })).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: 'Countersign as the second custodian' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'CONTROLLED_ACT', act: 'CUSTODY_SECOND', subjectId: awaiting.custodyId });
    // A destruction waits for its witness.
    const destruction = await screen.findByTestId(`controlled-custody-${custody.records[3]!.custodyId}`);
    expect(within(destruction).getByRole('button', { name: 'Sign as the first custodian' })).toBeTruthy();
    expect(screen.getByTestId('controlled-dispense-prompt').textContent).toContain('A dispensing with one person is refused');
    // The proposal carries the lot, the batch and the exact net as decimal text.
    const box = screen.getByTestId('controlled-custody');
    await userEvent.type(within(box).getByRole('textbox', { name: 'Lot (id)' }), awaiting.lotId);
    await userEvent.type(within(box).getByRole('textbox', { name: 'Batch (id)' }), awaiting.batchId!);
    await userEvent.type(within(box).getByRole('textbox', { name: "Quantity (in the lot's unit)" }), '2.000');
    await userEvent.click(within(box).getByRole('button', { name: 'Propose' }));
    await waitFor(() => expect(ui.posts('/api/controlled/custody')).toHaveLength(1));
    expect(ui.posts('/api/controlled/custody')[0]?.body).toEqual({ kind: 'DISPENSE', lotId: awaiting.lotId, batchId: awaiting.batchId, quantity: '2.000' });
  });

  it('[IN-53] the balance panel shows each checkpoint with the server\'s difference; an explained difference names its deviation; the supervisor signs a recorded checkpoint', async () => {
    const ui = renderOffice(`/controlled/batches/${balance.batchId}`, { role: 'SHIFT_SUPERVISOR' });
    expect((await screen.findByTestId('controlled-banner')).textContent).toContain(CONTROLLED_DRAFT_BANNER);
    const explained = balance.materials[0]!.checkpoints[0]!;
    const row = await screen.findByTestId(`controlled-checkpoint-${explained.checkpointId}`);
    expect(row.getAttribute('data-difference')).toBe('0.100');
    expect(row.textContent).toContain(explained.deviationRef!);
    expect(screen.getByTestId(`controlled-checkpoint-${balance.materials[0]!.checkpoints[1]!.checkpointId}`).getAttribute('data-state')).toBe('SIGNED');
    await userEvent.click(within(row).getByRole('button', { name: `Sign the account at ${explained.stageKey}` }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'CONTROLLED_ACT', act: 'BALANCE_SIGN', subjectId: explained.checkpointId });
    const form = screen.getByTestId('controlled-record-checkpoint-API-TRAMADOL');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Stage (as signed off)' }), 'S-BLEND@');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Consumed into the product' }), '1.950');
    await userEvent.clear(within(form).getByRole('textbox', { name: 'In process' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'In process' }), '0.050');
    await userEvent.click(within(form).getByRole('button', { name: 'Record the account' }));
    await waitFor(() => expect(ui.posts('/api/controlled/checkpoints')).toHaveLength(1));
    expect(ui.posts('/api/controlled/checkpoints')[0]?.body).toEqual({ batchId: balance.batchId, stageKey: 'S-BLEND@', materialCode: 'API-TRAMADOL', consumed: '1.950', inProcess: '0.050' });
  });

  it('[IN-53] the register export is reproducible (same hash): the opened export shows its banner and whether it reproduces', async () => {
    renderOffice('/controlled', { role: 'QA_REVIEWER' });
    const extract = example('controlled-register-extract');
    const item = await screen.findByTestId(`controlled-extract-${extract.extractId}`);
    expect(item.textContent).toContain(extract.resultSha256);
    await userEvent.click(within(item).getByRole('button', { name: 'Open' }));
    const opened = await screen.findByTestId('controlled-extract');
    expect(opened.getAttribute('data-reproduces')).toBe('true');
    expect(opened.textContent).toContain('Reproduces (the same hash now)');
    expect(opened.textContent).toContain(CONTROLLED_DRAFT_BANNER);
  });
});
