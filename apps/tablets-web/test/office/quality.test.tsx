/**
 * Quality screens (Phase 3 slice 6): deviations (raise, link, investigate, finding, conclude, close, cancel), lots
 * (results, approval, OOS link, release or reject), the extra-testing decision (described per choice), reprocessing,
 * ERP status. Refusals in the server's words; signed acts through the ceremony; QA and QC acts hidden from others.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { refusal, renderOffice } from './support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const dev = example('quality-deviations').deviations[0];
const devPath = `/quality/deviations/${dev?.deviationId ?? ''}`;

describe('deviations', () => {
  it('a record raised MINOR without a usable rationale is refused with the server\'s words', async () => {
    const ui = renderOffice('/quality/deviations', { role: 'QA_REVIEWER', fixtures: { 'quality.raiseDeviation': refusal('EBMR-DEV-030', 'A minor deviation needs its risk rationale.', 'IN-02') } });
    const form = await screen.findByTestId('form-Raise a deviation');
    await userEvent.click(within(form).getByRole('radio', { name: 'DEVIATION' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Title' }), 'Granulation end point late');
    await userEvent.click(within(form).getByRole('radio', { name: 'MINOR' }));
    // Fewer than 10 characters: the contract refuses it before anything is sent.
    await userEvent.type(within(form).getByRole('textbox', { name: 'Risk rationale' }), 'low');
    expect(within(form).getByRole('alert').textContent).toContain('riskRationale');
    expect(within(form).getByRole('button', { name: 'Raise the record' }).hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(form).getByRole('textbox', { name: 'Risk rationale' }), ' impact, validated range');
    await userEvent.click(within(form).getByRole('button', { name: 'Raise the record' }));
    await waitFor(() => expect(ui.posts('/api/quality/deviations')).toHaveLength(1));
    expect(await within(form).findByText('A minor deviation needs its risk rationale.')).toBeTruthy();
  });

  it('links a batch, records the finding and signs the impact assessment through the QA ceremony', async () => {
    const ui = renderOffice(devPath, { role: 'QA_REVIEWER' });
    const link = await screen.findByTestId('link-form');
    await userEvent.click(within(link).getByRole('radio', { name: 'A batch' }));
    const batch = example('batches-list').batches[0];
    await userEvent.click(await within(link).findByRole('radio', { name: new RegExp(`^${batch?.batchNumber ?? 'x'}`) }));
    await userEvent.click(within(link).getByRole('button', { name: 'Link it' }));
    await waitFor(() => expect(ui.posts(`${devPath.replace('/quality', '/api/quality')}/links`)).toHaveLength(1));
    expect(ui.posts(`${devPath.replace('/quality', '/api/quality')}/links`)[0]?.body).toEqual({ subjectKind: 'BATCH', subjectId: batch?.runId });
    const finding = screen.getByTestId('form-Record the finding');
    await userEvent.click(within(finding).getByRole('radio', { name: 'Yes' }));
    await userEvent.type(within(finding).getByRole('textbox', { name: 'Cause' }), 'Binder added too slowly by the dosing pump');
    await userEvent.click(within(finding).getByRole('radio', { name: 'EQUIPMENT' }));
    await userEvent.click(within(finding).getByRole('button', { name: 'Record the finding' }));
    await waitFor(() => expect(ui.posts(`${devPath.replace('/quality', '/api/quality')}/findings`)).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'Sign the impact assessment (QA signature)' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'QUALITY_ACT', act: 'DEVIATION_IMPACT_ASSESS', subjectId: dev?.deviationId, input: {} });
  });

  it('QA\'s classification starts the investigation of an OPEN record; an operator is offered no QA act', async () => {
    const open = { ...dev, state: 'OPEN' };
    const ui = renderOffice(devPath, { role: 'OPERATOR', fixtures: { 'quality.deviation': open } });
    const form = await screen.findByTestId('form-Classify and start the investigation');
    await userEvent.click(within(form).getByRole('radio', { name: 'MAJOR' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Risk rationale' }), 'End point outside the validated time');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Owner (person id)' }), '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e76');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Due date' }), '2026-11-12');
    await userEvent.click(within(form).getByRole('button', { name: 'Start the investigation' }));
    await waitFor(() => expect(ui.posts(`${devPath.replace('/quality', '/api/quality')}/investigation`)).toHaveLength(1));
    expect(screen.queryByTestId('qa-decision')).toBeNull();
    expect(screen.queryByTestId('cancel-deviation')).toBeNull();
  });

  it('an impact-assessed record is concluded, and one pending closure is closed, through the ceremony', async () => {
    const assessed = renderOffice(devPath, { role: 'QA_REVIEWER', fixtures: { 'quality.deviation': { ...dev, state: 'IMPACT_ASSESSED' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Conclude (QA signature)' }));
    await waitFor(() => expect(assessed.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(assessed.ceremony.sign.mock.calls[0]?.[0].action).toMatchObject({ act: 'DEVIATION_CONCLUDE' });
    assessed.unmount();
    const ui = renderOffice(devPath, { role: 'QA_REVIEWER', fixtures: { 'quality.deviation': { ...dev, state: 'PENDING_CLOSURE' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Close (QA signature)' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toMatchObject({ act: 'DEVIATION_CLOSE' });
  });
});

describe('lots', () => {
  const lot = example('quality-lots').lots[0];
  const lotPath = `/quality/lots/${lot?.lotId ?? ''}`;
  const failing = { resultId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', testCode: 'ASSAY', methodReference: 'STP-EXZ-AS-01', purpose: 'RELEASE', value: '93.1', unit: '%', lowerLimit: '98.0', upperLimit: '102.0', verdict: 'FAIL', state: 'RECORDED' };

  it('QC approves a result through the ceremony and raises an OOS record linked to the lot for a failing one', async () => {
    const ui = renderOffice(lotPath, { role: 'QC_ANALYST', fixtures: { 'quality.lotResults': { results: [failing] } } });
    const row = await screen.findByTestId('result-ASSAY-RELEASE');
    await userEvent.click(within(row).getByRole('button', { name: 'Approve ASSAY' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'QUALITY_ACT', act: 'LOT_RESULT_APPROVE', subjectId: failing.resultId, input: {} });
    await userEvent.click(within(row).getByRole('button', { name: 'Raise an OOS record for ASSAY' }));
    await waitFor(() => expect(ui.posts('/api/quality/deviations')).toHaveLength(1));
    expect(ui.posts('/api/quality/deviations')[0]?.body).toMatchObject({ kind: 'OOS' });
    const raised = example('quality-deviations').deviations[0];
    await waitFor(() => expect(ui.posts(`/api/quality/deviations/${raised?.deviationId ?? ''}/links`)[0]?.body).toEqual({ subjectKind: 'LOT', subjectId: lot?.lotId }));
  });

  it('[IN-33] a result row shows the method it was made by, read-only (copied from the approved specification, never typed on this screen)', async () => {
    // The firm's own method name of a sterility test by a validated rapid microbial method (DEMO-ONLY fixture text).
    const sterility = { ...failing, resultId: '1b2c3d4e-5f6a-4b7c-8d9e-0a1b2c3d4e5f', testCode: 'STERILITY', methodReference: 'Validated rapid microbial method', value: '0', unit: '1', lowerLimit: null, upperLimit: '0', verdict: 'PASS', state: 'APPROVED' };
    renderOffice(lotPath, { role: 'QC_ANALYST', fixtures: { 'quality.lotResults': { results: [sterility] } } });
    const row = await screen.findByTestId('result-STERILITY-RELEASE');
    expect(within(row).getByTestId(`result-method-${sterility.resultId}`).textContent).toBe('by Validated rapid microbial method');
    // Shown, not entered: the row offers no field for the method, and the form that records a result has none either.
    expect(within(row).queryByRole('textbox')).toBeNull();
    expect(within(await screen.findByTestId('form-Record a result')).queryByRole('textbox', { name: /method/i })).toBeNull();
  });

  it('QA releases with a route (described for that choice) or rejects; QC is not offered the decision', async () => {
    const ui = renderOffice(lotPath, { role: 'QA_REVIEWER' });
    const box = await screen.findByTestId('lot-decision');
    await userEvent.click(within(box).getByRole('radio', { name: 'Release' }));
    expect(within(box).getByRole('button', { name: 'Sign the decision' }).hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(box).getByRole('radio', { name: 'Identity tested' }));
    await userEvent.click(within(box).getByRole('button', { name: 'Sign the decision' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action: { kind: 'LOT_DECISION', lotId: lot?.lotId, decision: 'RELEASE', route: 'IDENTITY_TESTED' } });
    cleanup();
    renderOffice(lotPath, { role: 'QC_ANALYST' });
    await screen.findByTestId('lot-results');
    expect(screen.queryByTestId('lot-decision')).toBeNull();
  });
});

describe('extra testing, reprocessing, ERP status', () => {
  it('the extra-testing decision is described for the choice made, tests included', async () => {
    const ui = renderOffice('/quality/extra-testing', { role: 'QC_ANALYST' });
    const batch = example('batches-list').batches[0];
    await userEvent.click(await screen.findByRole('radio', { name: new RegExp(`^${batch?.batchNumber ?? 'x'}`) }));
    const box = await screen.findByTestId('extra-testing');
    await userEvent.click(within(box).getByRole('radio', { name: 'Extra tests' }));
    await userEvent.type(within(box).getByRole('textbox', { name: 'Tests' }), 'DISSOLUTION, IMPURITIES');
    await userEvent.click(within(box).getByRole('button', { name: 'Sign the decision' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action: { kind: 'QUALITY_ACT', act: 'QC_EXTRA_TESTING_DECISION', subjectId: batch?.runId, input: { decision: 'EXTRA_TESTS', tests: ['DISSOLUTION', 'IMPURITIES'] } } });
  });

  it('QA reserves a closed container as residue through the ceremony', async () => {
    const ui = renderOffice('/quality/reprocessing', { role: 'QA_REVIEWER' });
    const residue = example('quality-residues').containers[0];
    await userEvent.click(await screen.findByRole('button', { name: `Reserve ${residue?.label ?? 'x'} as residue` }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'REPROCESSING_ACT', act: 'RESERVE_RESIDUE', subjectId: residue?.containerId, input: {} });
  });

  it('the ERP status counts what the stub sent', async () => {
    renderOffice('/quality/erp');
    const counts = await screen.findByTestId('erp-counts');
    await waitFor(() => expect(counts.textContent).toContain(`Production orders: ${example('quality-erp-orders').orders.length}`));
  });

  it('[PR-47][IN-19] a master change waiting for QA shows the values in effect beside the received ones; the QA MBR approver confirms it through the ceremony, others are not offered the act (exit review HIGH-1)', async () => {
    const p = example('quality-erp-pending').pending[0];
    const ui = renderOffice('/quality/erp', { role: 'QA_MBR_APPROVER' });
    const box = await screen.findByTestId('erp-pending');
    expect(await within(box).findByText('reprocessingPermitted: false -> true')).toBeTruthy();
    await userEvent.click(within(box).getByRole('button', { name: 'Confirm PCM500 500 mg' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'MASTER_DATA_APPROVE', masterKind: 'ERP_PRODUCT', versionId: p?.versionId });
    cleanup();
    renderOffice('/quality/erp', { role: 'QA_REVIEWER' });
    const other = await screen.findByTestId('erp-pending');
    expect(await within(other).findByText('Waiting for QA')).toBeTruthy();
    expect(within(other).queryByRole('button', { name: /^Confirm/ })).toBeNull();
  });
});
