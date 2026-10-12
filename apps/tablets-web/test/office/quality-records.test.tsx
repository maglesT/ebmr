/**
 * Quality-record screens of Phase 4 slice 2c, on the contracts of slices 2a (ns/deviation.ts) and 2b
 * (ns/specifications.ts, ns/samples.ts): the full deviation record (classification, impact per market, closure basis,
 * the release checklist), a lot's release check, status events proposed then signed, samples, specifications with their
 * approval and editions, and returned goods with QC's assessment. What is sent is the person's input; what is signed is
 * the server's (esig.describe); refusals in the server's words.
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
const detail = example('deviation-detail');
const apiDev = `/api/quality/deviations/${detail.deviationId}`;
const investigating = { ...dev, state: 'UNDER_INVESTIGATION' };
const lot = example('quality-lots').lots[0];
const lotPath = `/quality/lots/${lot?.lotId ?? ''}`;

describe('the full deviation record', () => {
  it('shows QA\'s classification, the impact per linked subject and market with whether it is signed, the finding', async () => {
    renderOffice(devPath, { role: 'QA_REVIEWER' });
    expect((await screen.findByTestId('qa-classification')).textContent).toContain(`QA classification MAJOR: ${detail.qaClassification?.riskRationale ?? 'missing'}`);
    const impact = screen.getByTestId('impact-B26-0001');
    expect(impact.textContent).toContain('IN NONE (signed)');
    expect(impact.textContent).toContain('US POTENTIAL (signed)');
    expect(screen.getByTestId('deviation-finding').textContent).toContain('EQUIPMENT: Impeller speed set below the master value');
  });

  it('records the impact on the linked subject for a market, as typed and chosen', async () => {
    const ui = renderOffice(devPath, { role: 'QA_REVIEWER', fixtures: { 'quality.deviation': investigating, 'quality.deviationDetail': { ...detail, state: 'UNDER_INVESTIGATION' } } });
    const form = await screen.findByTestId('impact-form');
    const button = within(form).getByRole('button', { name: 'Record the impact' });
    await userEvent.click(within(form).getByRole('radio', { name: 'US' }));
    await userEvent.click(within(form).getByRole('radio', { name: 'NONE' }));
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(form).getByRole('textbox', { name: 'Rationale of the impact' }), 'US dissolution profile matched the reference');
    await userEvent.click(button);
    await waitFor(() => expect(ui.posts(`${apiDev}/impacts`)).toHaveLength(1));
    expect(ui.posts(`${apiDev}/impacts`)[0]?.body).toEqual({ linkId: detail.links[0]?.linkId, market: 'US', impact: 'NONE', rationale: 'US dissolution profile matched the reference' });
  });

  it('records the closure basis with the CAPA references, the notification assessment and the other batches assessed', async () => {
    const ui = renderOffice(devPath, { role: 'QA_REVIEWER', fixtures: { 'quality.deviation': investigating, 'quality.deviationDetail': { ...detail, state: 'UNDER_INVESTIGATION' } } });
    const form = await screen.findByTestId('closure-form');
    const send = within(form).getByRole('button', { name: 'Record the closure basis' });
    expect(send.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(form).getByRole('textbox', { name: 'Root-cause method' }), 'Five whys');
    await userEvent.type(within(form).getByRole('textbox', { name: 'CAPA references' }), 'CAPA-26-014, CAPA-26-015');
    await userEvent.click(within(within(form).getByRole('radiogroup', { name: 'Regulatory notification required' })).getByRole('radio', { name: 'No' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Notification assessment' }), 'No registered detail is affected');
    const row = within(form).getByTestId('other-batch-0');
    await userEvent.click(within(row).getByRole('radio', { name: 'BATCH' }));
    await userEvent.type(within(row).getByRole('textbox', { name: 'Reference 1' }), 'B26-0002');
    await userEvent.click(within(within(row).getByRole('radiogroup', { name: 'Included in the deviation 1' })).getByRole('radio', { name: 'No' }));
    await userEvent.type(within(row).getByRole('textbox', { name: 'Reason 1' }), 'Made before the maintenance');
    await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false));
    await userEvent.click(send);
    await waitFor(() => expect(ui.posts(`${apiDev}/closure-basis`)).toHaveLength(1));
    expect(ui.posts(`${apiDev}/closure-basis`)[0]?.body).toEqual({
      rootCauseMethod: 'Five whys',
      capaRefs: ['CAPA-26-014', 'CAPA-26-015'],
      notificationRequired: false,
      notificationRationale: 'No registered detail is affected',
      otherBatches: [{ subjectKind: 'BATCH', ref: 'B26-0002', included: false, reason: 'Made before the maintenance' }],
    });
  });

  it('a refused reclassification is shown with the server\'s words', async () => {
    renderOffice(devPath, {
      role: 'QA_REVIEWER',
      fixtures: { 'quality.deviation': investigating, 'quality.deviationDetail': { ...detail, state: 'UNDER_INVESTIGATION' }, 'quality.reclassifyDeviation': refusal('EBMR-DEV-061', 'The initiator never classifies the record.', 'IN-02') },
    });
    const form = await screen.findByTestId('form-Reclassify');
    await userEvent.click(within(form).getByRole('radio', { name: 'CRITICAL' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Risk rationale of the reclassification' }), 'A second batch shows the same drift');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Owner (person id)' }), '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e76');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Due date' }), '2026-11-20');
    await userEvent.click(within(form).getByRole('button', { name: 'Reclassify' }));
    expect(await screen.findByText('The initiator never classifies the record.')).toBeTruthy();
  });

  it('an operator is offered no reclassification', async () => {
    renderOffice(devPath, { role: 'OPERATOR', fixtures: { 'quality.deviation': investigating, 'quality.deviationDetail': { ...detail, state: 'UNDER_INVESTIGATION' } } });
    await screen.findByTestId('qa-classification');
    expect(screen.queryByTestId('form-Reclassify')).toBeNull();
  });
});

describe('a lot\'s release check, events and samples', () => {
  it('shows the release check and the linked deviations as the release checklist lists them, in the server\'s words', async () => {
    renderOffice(lotPath, { role: 'QA_REVIEWER' });
    const check = await screen.findByTestId('lot-release-check');
    await waitFor(() => expect(check.textContent).toContain(example('specifications-lot-release-check').limsProblem ?? 'missing'));
    expect(within(check).getByTestId('samples-ok')).toBeTruthy();
    const release = screen.getByTestId('deviation-release');
    await waitFor(() => expect(release.textContent).toContain('blocks release'));
    expect(release.textContent).toContain(example('deviation-release').problem ?? 'missing');
  });

  it('QA proposes a hold first, then signs it as LOT_DECISION with the reason', async () => {
    const ui = renderOffice(lotPath, { role: 'QA_REVIEWER' });
    const events = await screen.findByTestId('lot-events');
    await userEvent.click(within(events).getByRole('radio', { name: 'hold' }));
    await userEvent.click(within(events).getByRole('button', { name: 'Propose the event' }));
    await waitFor(() => expect(ui.posts(`/api/lots/${lot?.lotId ?? ''}/decisions`)).toHaveLength(1));
    expect(ui.posts(`/api/lots/${lot?.lotId ?? ''}/decisions`)[0]?.body).toEqual({ event: 'HOLD' });
    const proposal = await within(events).findByTestId('lot-event-proposal');
    expect(proposal.textContent).toContain('Proposed: HOLD from RELEASED (lot state version 3)');
    await userEvent.type(within(proposal).getByRole('textbox', { name: 'Reason code' }), 'COMPLAINT');
    await userEvent.type(within(proposal).getByRole('textbox', { name: 'Reason for the event' }), 'Market complaint on blister seal');
    await userEvent.click(within(proposal).getByRole('button', { name: 'Sign the hold' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action: { kind: 'LOT_DECISION', lotId: lot?.lotId, decision: 'HOLD', reason: { code: 'COMPLAINT', text: 'Market complaint on blister seal' } } });
  });

  it('a QC person pulls a sample with what was typed; the required quantity and kept-until instant are the server\'s', async () => {
    const ui = renderOffice(lotPath, { role: 'QC_ANALYST' });
    const samples = await screen.findByTestId('lot-samples');
    const s = example('samples-list').samples[0];
    await waitFor(() => expect(samples.textContent).toContain(`required ${s?.requiredQuantity ?? 'missing'}`));
    expect(samples.textContent).toContain(`kept until ${s?.retainUntil.text ?? 'missing'}`);
    const form = within(samples).getByTestId('form-Pull a sample');
    await userEvent.click(within(form).getByRole('radio', { name: 'RETENTION' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Quantity' }), '0.200');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Container' }), 'Amber glass jar');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Storage location' }), 'Retention room R-1');
    await userEvent.click(within(form).getByRole('button', { name: 'Pull the sample' }));
    await waitFor(() => expect(ui.posts(`/api/lots/${lot?.lotId ?? ''}/samples`)).toHaveLength(1));
    expect(ui.posts(`/api/lots/${lot?.lotId ?? ''}/samples`)[0]?.body).toEqual({ kind: 'RETENTION', quantity: '0.200', container: 'Amber glass jar', storageLocation: 'Retention room R-1' });
    // QA disposes of samples; QC is not offered it.
    expect(within(samples).queryByRole('button', { name: 'Dispose of the sample' })).toBeNull();
  });
});

describe('specifications', () => {
  it('lists each version with its limits and their pharmacopoeia and edition; a draft is approved through the ceremony', async () => {
    const draft = { ...example('specifications-list').specifications[0], state: 'DRAFT', approvedBy: null, approvedAt: null };
    const ui = renderOffice('/quality/specifications', { role: 'QA_REVIEWER', fixtures: { 'specifications.list': { specifications: [draft] } } });
    const card = await screen.findByTestId('spec-MAT-EXZ-NA-1');
    expect(within(card).getByRole('table').textContent).toContain('IP 2022');
    expect(within(card).getByRole('table').textContent).toContain('from 98.0 to 102.0 %');
    await userEvent.click(within(card).getByRole('button', { name: 'Approve MAT-EXZ-NA version 1 (signature)' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action: { kind: 'LIMS_ACT', act: 'SPECIFICATION_APPROVE', subjectId: draft.specificationId } });
  });

  it('QC drafts a version with its tests; the body is the contract\'s', async () => {
    const ui = renderOffice('/quality/specifications', { role: 'QC_ANALYST' });
    const form = await screen.findByTestId('draft-specification');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Material code' }), 'mat-mcc-101');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Title' }), 'Microcrystalline cellulose');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Monograph reference' }), 'IP 2022 monograph');
    const t = within(form).getByTestId('spec-test-0');
    await userEvent.type(within(t).getByRole('textbox', { name: 'Test code 1' }), 'lod');
    await userEvent.type(within(t).getByRole('textbox', { name: 'Method 1' }), 'STP-LOD-01');
    await userEvent.type(within(t).getByRole('textbox', { name: 'Unit 1' }), '%');
    await userEvent.type(within(t).getByRole('textbox', { name: 'Upper limit 1' }), '5.0');
    await userEvent.click(within(within(t).getByRole('radiogroup', { name: 'Required for release 1' })).getByRole('radio', { name: 'Yes' }));
    await userEvent.click(within(t).getByRole('radio', { name: 'IP' }));
    await userEvent.type(within(t).getByRole('textbox', { name: 'Edition 1' }), '2022');
    await userEvent.type(within(t).getByRole('textbox', { name: 'Sample per run 1' }), '0.010');
    await userEvent.type(within(t).getByRole('textbox', { name: 'Sample unit 1' }), 'kg');
    await userEvent.click(within(form).getByRole('button', { name: 'Draft the version' }));
    await waitFor(() => expect(ui.posts('/api/quality/specifications')).toHaveLength(1));
    expect(ui.posts('/api/quality/specifications')[0]?.body).toEqual({
      materialCode: 'MAT-MCC-101', title: 'Microcrystalline cellulose', monographReference: 'IP 2022 monograph',
      tests: [{ testCode: 'LOD', methodReference: 'STP-LOD-01', unit: '%', upperLimit: '5.0', required: true, pharmacopoeia: 'IP', edition: '2022', sampleQuantity: '0.010', sampleUnit: 'kg' }],
    });
  });

  it('shows the review list of specifications citing an older edition', async () => {
    renderOffice('/quality/specifications', { role: 'QA_REVIEWER' });
    const item = example('specifications-edition-review').items[0];
    const review = await screen.findByTestId('edition-review');
    await waitFor(() => expect(review.textContent).toContain(`cites ${item?.pharmacopoeia ?? ''} ${item?.cited ?? ''}; effective now ${item?.effective ?? ''}`));
  });
});

describe('returned goods', () => {
  it('lists a return with its assessment; QC signs an unsigned assessment through the ceremony', async () => {
    const r = example('samples-returns').returns[0];
    const unsigned = { ...r, assessment: r?.assessment ? { ...r.assessment, signed: false } : null };
    const ui = renderOffice('/quality/returns', { role: 'QC_ANALYST', fixtures: { 'samples.returns': { returns: [unsigned] } } });
    const card = await screen.findByTestId(`return-${r?.lotCode ?? ''}`);
    expect(within(card).getByTestId('return-assessment').textContent).toContain('disposition DESTROY');
    await userEvent.click(within(card).getByRole('button', { name: `Sign the assessment of ${r?.lotCode ?? ''}` }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.posts('/api/esig/describe')[0]?.body).toEqual({ action: { kind: 'LIMS_ACT', act: 'RETURN_ASSESSMENT_SIGN', subjectId: r?.lotId } });
  });

  it('QC records an assessment; a refused one is shown in the server\'s words', async () => {
    const r = example('samples-returns').returns[0];
    renderOffice('/quality/returns', {
      role: 'QC_ANALYST',
      fixtures: { 'samples.returns': { returns: [{ ...r, assessment: null }] }, 'samples.assessReturn': refusal('EBMR-LIMS-071', 'With any doubt the goods are destroyed or chemically recovered.', 'PR-48') },
    });
    const form = await screen.findByTestId(`form-Assess ${r?.lotCode ?? ''}`);
    await userEvent.type(within(form).getByRole('textbox', { name: 'Nature of the product' }), 'Uncoated tablets in blisters');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Storage conditions' }), 'Unknown');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Condition and history' }), 'Cartons wet');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Time since issue' }), '2 months');
    await userEvent.click(within(within(form).getByRole('radiogroup', { name: /Any doubt/ })).getByRole('radio', { name: 'Yes' }));
    await userEvent.click(within(within(form).getByRole('radiogroup', { name: /Other batches implicated/ })).getByRole('radio', { name: 'No' }));
    await userEvent.click(within(form).getByRole('radio', { name: 'RETURN_TO_STOCK' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Record the assessment' }));
    expect(await screen.findByText('With any doubt the goods are destroyed or chemically recovered.')).toBeTruthy();
  });
});
