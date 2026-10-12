/**
 * The output containers of a batch (Phase 4 slice 1c screens on the 1b routes): the close, typed or weighed (readings
 * named by id), with a fresh badge tap on a shared terminal; the second person's check of a typed net and QA's release
 * through the ceremony; sort and reject with a reason; and why a container cannot be used or released, in the
 * database's words.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { refusal, renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const list = example('containers-list');
const typed = list.containers[0]!;
const held = list.containers[1]!;
const B = typed.batchId;
const path = `/review/${B}/containers`;
const open = { ...typed, state: 'OPEN' as const, version: 1, netQuantity: null, closeBasis: null, closedBy: null, closedAt: null, usableProblem: 'still open' };

describe('output containers', () => {
  it('shows why a container cannot be used and why QA cannot release it, in the server\'s words; release is not offered while it stands', async () => {
    renderOffice(path, { role: 'QA_REVIEWER' });
    const card = await screen.findByTestId(`container-${held.label}`);
    expect(within(card).getByTestId('release-problem').textContent).toBe(held.releaseProblem);
    expect(within(card).getByTestId('usable-problem').textContent).toContain(held.usableProblem ?? 'x');
    await userEvent.type(within(card).getByRole('textbox', { name: 'Release reason code' }), 'IPC_INVESTIGATED');
    await userEvent.type(within(card).getByRole('textbox', { name: 'Reason for the release' }), 'Investigation concluded');
    expect(within(card).getByRole('button', { name: `Release ${held.label} (QA signature)` }).hasAttribute('disabled')).toBe(true);
    expect(within(await screen.findByTestId(`container-${typed.label}`)).getByTestId('container-net').textContent).toContain('not verified by a second person yet');
  });

  it('QA releases a held container once nothing stands in the way, with the reason, through the ceremony', async () => {
    const ui = renderOffice(path, { role: 'QA_REVIEWER', fixtures: { 'containers.list': { containers: [{ ...held, releaseProblem: null }] } } });
    const card = await screen.findByTestId(`container-${held.label}`);
    await userEvent.type(await within(card).findByRole('textbox', { name: 'Release reason code' }), 'IPC_INVESTIGATED');
    await userEvent.type(within(card).getByRole('textbox', { name: 'Reason for the release' }), 'Sorted 100 %, all within limits');
    await userEvent.click(within(card).getByRole('button', { name: `Release ${held.label} (QA signature)` }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'CONTAINER_ACT', act: 'RELEASE', containerId: held.containerId, reason: { code: 'IPC_INVESTIGATED', text: 'Sorted 100 %, all within limits' } });
  });

  it('a second person verifies a typed net through the ceremony; the refusal of the closer is the server\'s', async () => {
    const ui = renderOffice(path, { role: 'VERIFIER', fixtures: { 'esig.describe': refusal('EBMR-CNT-061', 'The person who closed the container cannot verify its net.') } });
    const card = await screen.findByTestId(`container-${typed.label}`);
    await userEvent.click(within(card).getByRole('button', { name: `Verify the net of ${typed.label} (second person)` }));
    expect(await within(card).findByText('The person who closed the container cannot verify its net.')).toBeTruthy();
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action: { kind: 'CONTAINER_ACT', act: 'VERIFY_CLOSE', containerId: typed.containerId } });
    expect(ui.ceremony.sign).not.toHaveBeenCalled();
  });

  it('a typed close sends the net as decimal text at the version shown, with a fresh badge tap on a shared terminal', async () => {
    const ui = renderOffice(path, { role: 'OPERATOR', attribution: 'TAP', fixtures: { 'containers.list': { containers: [open] } } });
    const card = await screen.findByTestId(`container-${open.label}`);
    await userEvent.click(await within(card).findByRole('radio', { name: 'Net typed (a second person verifies it)' }));
    const close = within(card).getByRole('button', { name: `Close ${open.label}` });
    await userEvent.type(within(card).getByRole('textbox', { name: 'Net quantity (kg)' }), '18.2505');
    expect(close.hasAttribute('disabled')).toBe(true);
    await userEvent.clear(within(card).getByRole('textbox', { name: 'Net quantity (kg)' }));
    await userEvent.type(within(card).getByRole('textbox', { name: 'Net quantity (kg)' }), '18.250');
    await userEvent.click(close);
    await waitFor(() => expect(ui.posts(`/api/containers/${open.containerId}/close`)).toHaveLength(1));
    expect(ui.tap.requestTap).toHaveBeenCalledTimes(1);
    expect(ui.tap.requestTap.mock.calls[0]?.[1]).toEqual({ method: 'POST', path: `/api/containers/${open.containerId}/close`, body: { expectedVersion: 1, typed: { net: '18.250' } } });
    expect(ui.posts(`/api/containers/${open.containerId}/close`)[0]?.body).toMatchObject({ expectedVersion: 1, typed: { net: '18.250' }, attribution: { method: 'BADGE_TAP' } });
  });

  it('sorts a held container with the operator\'s reason; QA alone is offered reject and release', async () => {
    const ui = renderOffice(path, { role: 'OPERATOR', fixtures: { 'containers.list': { containers: [held] } } });
    const card = await screen.findByTestId(`container-${held.label}`);
    await userEvent.type(await within(card).findByRole('textbox', { name: 'Sort reason code' }), 'SORT');
    await userEvent.type(within(card).getByRole('textbox', { name: 'Reason to sort' }), '100 % sorting after the failed weight check');
    await userEvent.click(within(card).getByRole('button', { name: `Sort ${held.label}` }));
    await waitFor(() => expect(ui.posts(`/api/containers/${held.containerId}/sort`)).toHaveLength(1));
    expect(ui.posts(`/api/containers/${held.containerId}/sort`)[0]?.body).toEqual({ expectedVersion: held.version, reason: { code: 'SORT', text: '100 % sorting after the failed weight check' } });
    expect(within(card).queryByTestId('release-container')).toBeNull();
    expect(within(card).queryByTestId('reject-container')).toBeNull();
  });
});
