/**
 * Declutter D1: where the server refuses a disconnected function (410 DISCONNECTED), the release page keeps working and
 * shows no error for it: the EU QP batch package section and the notifications of the decision render nothing.
 *
 * Control: DI-17.
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { refusal, renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const lot = example('release-lot');
const gone = { ...refusal('DISCONNECTED', 'This function is not connected.'), status: 410 };

describe('[DI-17] disconnected panels on the release page (declutter D1)', () => {
  it('[DI-17] the QP package section and the decision notifications render nothing on 410 DISCONNECTED; the release page stays', async () => {
    renderOffice(`/release/${lot.lotId}`, { role: 'QA_REVIEWER', fixtures: { 'qpPackage.lot': gone, 'notifications.list': gone } });
    await screen.findByTestId('grel-checklist');
    await waitFor(() => expect(screen.queryByTestId('lot-notifications')).toBeNull());
    await userEvent.click(await screen.findByRole('tab', { name: /^EU$/ }));
    await screen.findByTestId('eu-certifications');
    await waitFor(() => expect(screen.queryByTestId('qp-package')).toBeNull());
    expect(screen.queryByText('This function is not connected.')).toBeNull();
  });

  it('[DI-17] with the functions connected both sections are shown as before', async () => {
    renderOffice(`/release/${lot.lotId}`, { role: 'QA_REVIEWER' });
    expect(await screen.findByTestId('lot-notifications')).toBeTruthy();
    await userEvent.click(await screen.findByRole('tab', { name: /^EU$/ }));
    expect(await screen.findByTestId('qp-package')).toBeTruthy();
  });
});
