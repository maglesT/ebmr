/**
 * The EU QP batch package on the EU tab and the QP's read-only view (Phase 4 slice 4c, on slice 4b's routes), on the
 * contract's examples: the database's reasons a package cannot be assembled, the assembly, the issue signed as
 * TRUE_COPY_VERIFIED through esig.describe and the ceremony (QP_PACKAGE_ACT), the time-boxed access granted with its
 * window end as typed (exact microseconds) and its reason, the access ended early with a reason, and the QP's view of
 * the one lot's issued packages with the download's hashes. The browser computes no state, hash or gate.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { validToUs } from '../../src/features/release/QpPackage.tsx';
import { renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const lot = example('release-lot');
const qp = example('qp-package-lot');
const L = lot.lotId;
const issued = qp.packages[0];
const access = qp.accesses[0];
if (!issued || !access) throw new Error('the QP package example lists a package and an access');
const ACCOUNT = '8d7c6b5a-4938-4271-8605-f4e3d2c1b0a9';

async function openEu() {
  await userEvent.click(await screen.findByRole('tab', { name: /^EU$/ }));
  return screen.findByTestId('qp-package');
}

describe('EU QP batch package (QA)', () => {
  it('[DI-41] lists the package with its sections and hashes as the server answers; the database\'s reasons stop the assembly', async () => {
    renderOffice(`/release/${L}`, { role: 'QA_REVIEWER', fixtures: { 'qpPackage.lot': { ...qp, assembleProblems: ['the manufacturer release of the lot is not RELEASED'] } } });
    const box = await openEu();
    const card = await within(box).findByTestId(`qp-package-${issued.packageId}`);
    expect(card.getAttribute('data-state')).toBe('ISSUED');
    expect(card.textContent).toContain(issued.packageSha256);
    expect(within(card).getAllByRole('listitem')).toHaveLength(issued.sections.length);
    expect(within(box).getByTestId('qp-assemble-problems').textContent).toContain('the manufacturer release of the lot is not RELEASED');
    expect(within(box).getByRole('button', { name: 'Assemble the package' }).hasAttribute('disabled')).toBe(true);
  });

  it('[DI-41] QA assembles the package, then issues it by signing TRUE_COPY_VERIFIED through esig.describe and the ceremony', async () => {
    const assembled = { ...issued, state: 'ASSEMBLED', issuedBy: null, issuedAt: null, signatureId: null };
    const ui = renderOffice(`/release/${L}`, { role: 'QA_REVIEWER', fixtures: { 'qpPackage.lot': { ...qp, packages: [assembled], accesses: [] } } });
    const box = await openEu();
    await userEvent.click(within(box).getByRole('button', { name: 'Assemble the package' }));
    await waitFor(() => expect(ui.posts(`/api/qp-package/lots/${L}/packages`)).toHaveLength(1));
    expect(ui.posts(`/api/qp-package/lots/${L}/packages`)[0]?.body).toEqual({});
    // An assembled package offers no access before it is issued.
    expect(within(box).queryByTestId(`qp-grant-${issued.packageId}`)).toBeNull();
    await userEvent.click(within(box).getByRole('button', { name: 'Sign and issue the package' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    const action = { kind: 'QP_PACKAGE_ACT', act: 'ISSUE', packageId: issued.packageId };
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual(action);
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action });
  });

  it('QA grants a QP account read-only access until the instant typed, with its offset, and a reason', async () => {
    const ui = renderOffice(`/release/${L}`, { role: 'QA_REVIEWER' });
    const box = await openEu();
    const grant = await within(box).findByTestId(`qp-grant-${issued.packageId}`);
    const button = within(grant).getByRole('button', { name: 'Grant the access' });
    await userEvent.type(within(grant).getByRole('textbox', { name: 'QP account (id)' }), ACCOUNT);
    await userEvent.type(within(grant).getByRole('textbox', { name: 'Reason for the access' }), 'TA-2026-01: certification of the lot');
    // No offset: the instant is ambiguous and is not sent.
    await userEvent.type(within(grant).getByRole('textbox', { name: /^Access ends at/ }), '2026-10-26T18:00:00');
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(grant).getByRole('textbox', { name: /^Access ends at/ }), '+05:30');
    await userEvent.click(button);
    await waitFor(() => expect(ui.posts(`/api/qp-package/packages/${issued.packageId}/accesses`)).toHaveLength(1));
    expect(ui.posts(`/api/qp-package/packages/${issued.packageId}/accesses`)[0]?.body).toEqual({ accountId: ACCOUNT, validToUs: '1793017800000000', reason: 'TA-2026-01: certification of the lot' });
  });

  it('QA ends a live access early with a reason; an ended access offers nothing', async () => {
    const ui = renderOffice(`/release/${L}`, { role: 'QA_REVIEWER' });
    const box = await openEu();
    const row = await within(box).findByTestId(`qp-access-${access.accessId}`);
    expect(row.textContent).toContain('read 1 times');
    const end = within(row).getByRole('button', { name: `End the access of ${access.qp.legalName}` });
    expect(end.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(row).getByRole('textbox'), 'Certification received');
    await userEvent.click(end);
    await waitFor(() => expect(ui.posts(`/api/qp-package/accesses/${access.accessId}/revocation`)).toHaveLength(1));
    expect(ui.posts(`/api/qp-package/accesses/${access.accessId}/revocation`)[0]?.body).toEqual({ reason: 'Certification received' });
    cleanup();
    renderOffice(`/release/${L}`, { role: 'QA_REVIEWER', fixtures: { 'qpPackage.lot': { ...qp, accesses: [{ ...access, state: 'REVOKED' }] } } });
    const again = await openEu();
    expect(within(await within(again).findByTestId(`qp-access-${access.accessId}`)).queryByRole('button')).toBeNull();
  });

  it('the window end is converted exactly, never guessed', () => {
    expect(validToUs('2026-10-26T12:30:00Z')).toBe('1793017800000000');
    expect(validToUs('2026-10-26T18:00:00+05:30')).toBe('1793017800000000');
    expect(validToUs('2026-10-26T18:00')).toBeNull();
    expect(validToUs('tomorrow')).toBeNull();
  });

  it('a role outside QA sees the package but no act', async () => {
    renderOffice(`/release/${L}`, { role: 'US_QCU_SIGNER' });
    const box = await openEu();
    await within(box).findByTestId(`qp-package-${issued.packageId}`);
    expect(within(box).queryByRole('button')).toBeNull();
  });
});

describe('the QP\'s read-only view', () => {
  it('lists the issued packages of the lot the access names and downloads one with its hashes; nothing to change', async () => {
    const reader = example('qp-reader-packages');
    const file = example('qp-reader-file');
    const p = reader.packages[0];
    if (!p) throw new Error('the reader example lists a package');
    const ui = renderOffice('/qp', { role: 'EU_QP_READER' });
    const row = await screen.findByTestId(`qp-reader-${p.packageId}`);
    expect(row.textContent).toContain(p.accessValidTo.text);
    await userEvent.click(within(row).getByRole('button', { name: `Download ${p.label}` }));
    const box = await screen.findByTestId('qp-reader-file');
    expect(box.textContent).toContain(file.contentSha256);
    expect(within(box).getByRole('link', { name: 'Save the package file' }).getAttribute('download')).toBe(`qp-package-${file.packageId}.json`);
    expect(ui.requests.some((r) => r.method === 'GET' && r.path === `/api/qp/packages/${p.packageId}`)).toBe(true);
    expect(ui.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });
});
