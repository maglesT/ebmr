/**
 * The screens of slice 7g WP3 (decision 0025: every act has a screen): market policies and a batch's pins, site values,
 * the EU qualified-person register, the compendial rule sets, the plant configuration, an MBR's change records,
 * periodic review, risk links and labelling, and the retirement of a reference document. Every act is offered; what the
 * person may do is the server's, so a refusal is shown in its words; signatures go through the ceremony with the action
 * the server describes.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { apiState } from '../../src/api/client.ts';
import { refusal, signedCeremony } from '../office/support.tsx';
import { renderMarket } from './support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const at = (text: string) => ({ us: '1760000000000000', text });
const person = (legalName: string, role = 'QA_MBR_APPROVER') => ({ personId: '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f', legalName, loginName: legalName.toLowerCase().replace(' ', '.'), role });
const MEERA = person('Meera Iyer');
const U1 = '0b6f2a10-1c2d-4e3f-8a4b-5c6d7e8f9a0b';
const U2 = '1c7a3b21-2d3e-4f40-9b5c-6d7e8f9a0b1c';
const U3 = '2d8b4c32-3e4f-4051-8c6d-7e8f9a0b1c2d';

const POLICY = {
  code: 'VOID.QA', title: 'QA approval of each void', level: 'TENANT' as const, controls: ['DI-09'], positions: ['RELAXED', 'STRICT', 'STRICTEST'], defaultPosition: 'STRICT', looseningRequires: 'QA_APPROVAL', current: 'STRICT',
  versions: [{ versionId: U1, version: 1, position: 'STRICT', direction: 'INITIAL' as const, effectiveFrom: at('01-OCT-2026'), recordedAt: at('01-OCT-2026'), author: MEERA, approver: null, changeRef: null, reason: 'initial' }],
};

describe('market policies', () => {
  it('[INV-47][DI-09] lists a policy with its versions; a new version carries its change reference, change record and reason; a loosening first asks another person\'s approval through the ceremony', async () => {
    const ceremony = signedCeremony();
    const ui = renderMarket('/market/policies', { role: 'QA_MBR_APPROVER', ceremony, fixtures: { 'marketConfig.policies': { policies: [POLICY] }, 'marketConfig.setPolicyVersion': POLICY } });
    const p = await screen.findByTestId('policy-VOID.QA');
    expect(p.textContent).toContain('In force now: STRICT');
    expect(within(p).queryByTestId('policy-VOID.QA-loosening')).toBeNull();
    await userEvent.click(within(p).getByRole('radio', { name: 'RELAXED' }));
    const loosening = within(p).getByTestId('policy-VOID.QA-loosening');
    await userEvent.click(within(loosening).getByRole('button', { name: 'Approve the loosening of VOID.QA to RELAXED' }));
    await waitFor(() => expect(ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'MARKET_LOOSENING', target: { subject: 'POLICY_VERSION', policy: 'VOID.QA', position: 'RELAXED' } });
    await userEvent.type(within(p).getByRole('textbox', { name: 'Change reference' }), 'CC-1');
    await userEvent.type(within(p).getByRole('textbox', { name: 'Change record (approved, area MARKET_POLICY)' }), 'CR-1');
    await userEvent.type(within(p).getByRole('textbox', { name: 'Reason' }), 'supervisor approves voids');
    await userEvent.click(within(p).getByRole('button', { name: 'Set VOID.QA to RELAXED' }));
    await waitFor(() => expect(ui.posts('/api/market/policies/VOID.QA/versions')).toHaveLength(1));
    expect(ui.posts('/api/market/policies/VOID.QA/versions')[0]?.body).toEqual({ position: 'RELAXED', changeRef: 'CC-1', changeRecord: 'CR-1', reason: 'supervisor approves voids' });
  });

  it('[INV-47] defines a policy under a change record, shows a batch\'s pins and applies a tightening with its change reference; a refusal is shown in the server\'s words', async () => {
    const pins = { batchId: U2, pins: [{ policy: 'VOID.QA', pinKind: 'ISSUE' as const, version: 1, position: 'STRICT', issueInstant: at('02-OCT-2026'), recordedAt: at('02-OCT-2026'), changeRef: null, reason: null }] };
    const ui = renderMarket('/market/policies', {
      fixtures: {
        'marketConfig.policies': { policies: [POLICY] }, 'marketConfig.definePolicy': POLICY, 'marketConfig.batchPolicies': pins,
        'marketConfig.applyPolicyTightening': refusal('EBMR-MKT-085', 'This version is not stricter than what the batch applies.'),
      },
    });
    const define = await screen.findByTestId('policy-define');
    await userEvent.type(within(define).getByRole('textbox', { name: 'Policy code' }), 'NEW.ONE');
    await userEvent.type(within(define).getByRole('textbox', { name: 'Title' }), 'A switch');
    await userEvent.type(within(define).getByRole('textbox', { name: /^Positions/ }), 'OFF, ON');
    await userEvent.type(within(define).getByRole('textbox', { name: 'Default position' }), 'ON');
    await userEvent.type(within(define).getByRole('textbox', { name: /^Change record/ }), 'CR-2');
    await userEvent.type(within(define).getByRole('textbox', { name: 'Reason' }), 'new design choice');
    await userEvent.click(within(define).getByRole('button', { name: 'Define the policy' }));
    await waitFor(() => expect(ui.posts('/api/market/policies')).toHaveLength(1));
    expect(ui.posts('/api/market/policies')[0]?.body).toEqual({ code: 'NEW.ONE', title: 'A switch', positions: ['OFF', 'ON'], defaultPosition: 'ON', looseningRequires: 'QA_APPROVAL', controls: [], changeRecord: 'CR-2', reason: 'new design choice' });
    const batch = screen.getByTestId('batch-policies');
    await userEvent.type(within(batch).getByRole('textbox', { name: 'Batch id' }), U2);
    expect(await within(batch).findByText(/VOID.QA: version 1 \(STRICT\), pinned at issue/)).toBeTruthy();
    await userEvent.click(within(batch).getByRole('radio', { name: 'VOID.QA' }));
    await userEvent.click(within(batch).getByRole('radio', { name: '1: STRICT' }));
    await userEvent.type(within(batch).getByRole('textbox', { name: 'Change reference' }), 'CC-9');
    await userEvent.type(within(batch).getByRole('textbox', { name: 'Reason' }), 'stricter now');
    await userEvent.click(within(batch).getByRole('button', { name: 'Apply the tightening to the batch' }));
    expect(await within(batch).findByText('This version is not stricter than what the batch applies.')).toBeTruthy();
    expect(ui.posts(`/api/market/batches/${U2}/policies/VOID.QA/tightening`)[0]?.body).toEqual({ versionId: U1, changeRef: 'CC-9', reason: 'stricter now' });
  });
});

describe('site values', () => {
  it('[IN-52][ST-01][DI-09] previews a site value; a loosening with a justification offers QA\'s approval through the ceremony; the value is set under a change record', async () => {
    const ceremony = signedCeremony();
    const values = { sites: [{ siteId: U3, code: 'SITE-1', markets: ['IN'] }], values: [] };
    const ui = renderMarket('/market/site-values', {
      ceremony,
      fixtures: {
        'marketConfig.siteValues': values, 'marketConfig.setSiteValue': values,
        'marketConfig.previewSiteValue': { outcome: 'LOOSENING', code: null, message: null, resolvedValue: '12', floorType: 'GUIDANCE', approvalSigned: false },
      },
    });
    const form = await screen.findByTestId('site-value-set');
    await userEvent.click(await within(form).findByRole('radio', { name: 'SITE-1 (IN)' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Rule key' }), 'kernel.managementReview.maxIntervalMonths');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Value' }), '18');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Effective from (YYYY-MM-DD)' }), '2026-02-01');
    await userEvent.type(within(form).getByRole('textbox', { name: /^Justification/ }), 'CCS-7');
    expect((await within(form).findByTestId('site-value-preview')).getAttribute('data-outcome')).toBe('LOOSENING');
    await userEvent.click(within(form).getByRole('button', { name: 'Approve this loosening (QA)' }));
    await waitFor(() => expect(ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ceremony.sign.mock.calls[0]?.[0].action).toEqual({
      kind: 'MARKET_LOOSENING', target: { subject: 'SITE_VALUE', site: 'SITE-1', key: 'kernel.managementReview.maxIntervalMonths', value: '18', effectiveFrom: '2026-02-01', justificationRef: 'CCS-7' },
    });
    await userEvent.type(within(form).getByRole('textbox', { name: /^Change record/ }), 'CR-SV');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Reason' }), 'annual reviews');
    await userEvent.click(within(form).getByRole('button', { name: 'Set the site value' }));
    await waitFor(() => expect(ui.posts('/api/market/site-values')).toHaveLength(1));
    expect(ui.posts('/api/market/site-values')[0]?.body).toEqual({ site: 'SITE-1', key: 'kernel.managementReview.maxIntervalMonths', value: '18', effectiveFrom: '2026-02-01', justificationRef: 'CCS-7', changeRecord: 'CR-SV', reason: 'annual reviews' });
  });
});

describe('the QP register and the compendial rule sets', () => {
  it('[ST-10] QA signs a QP register entry for a person of the EU QP role on an importer\'s authorisation (QP_REGISTER)', async () => {
    const ceremony = signedCeremony();
    const qp = person('Joachim Weber', 'EU_QP');
    renderMarket('/qp-register', { ceremony, fixtures: { 'marketConfig.qpRegister': { importers: [{ code: 'EUIMP-1', name: 'Import GmbH', miaNumber: 'DE-MIA-1' }], candidates: [qp], entries: [] } } });
    const act = await screen.findByTestId('qp-register-act');
    const signBtn = within(act).getByRole('button', { name: 'Sign the register entry' });
    expect(signBtn.hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(act).getByRole('radio', { name: /Joachim Weber/ }));
    await userEvent.click(within(act).getByRole('radio', { name: /EUIMP-1/ }));
    await userEvent.click(signBtn);
    await waitFor(() => expect(ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'QP_REGISTER', personId: qp.personId, action: 'REGISTER', importerCode: 'EUIMP-1', miaNumber: 'DE-MIA-1' });
  });

  it('[IN-34] records a rule set verification against the official text and offers its signature (RULE_SET_VERIFY) once recorded', async () => {
    const ceremony = signedCeremony();
    const base = { code: 'UOW-IP', version: 1, test: 'UNIFORMITY_OF_WEIGHT', pharmacopoeia: 'IP', markets: ['IN'], confidence: 'MEDIUM', source: 'secondary', problem: 'the QA verification of rule set UOW-IP version 1 is not signed' };
    const recorded = { ...base, verification: { verificationId: U1, documentRef: 'IP-2.5.4', note: 'checked', recordedBy: MEERA, recordedAt: at('x'), signedBy: null, signedAt: null } };
    const ui = renderMarket('/compendial-rule-sets', { ceremony, fixtures: { 'marketConfig.ruleSets': { ruleSets: [recorded, { ...base, code: 'FRI-IP', verification: null }] }, 'marketConfig.recordRuleSetVerification': recorded } });
    const fri = await screen.findByTestId('rule-set-FRI-IP-1');
    expect(within(fri).queryByRole('button', { name: /^Sign/ })).toBeNull();
    await userEvent.type(within(fri).getByRole('textbox', { name: /^Official text/ }), 'IP-2.5.5');
    await userEvent.type(within(fri).getByRole('textbox', { name: 'What was checked' }), 'friability limits');
    await userEvent.click(within(fri).getByRole('button', { name: 'Record the verification of FRI-IP version 1' }));
    await waitFor(() => expect(ui.posts('/api/compendial-rule-sets/FRI-IP/1/verification')).toHaveLength(1));
    expect(ui.posts('/api/compendial-rule-sets/FRI-IP/1/verification')[0]?.body).toEqual({ documentRef: 'IP-2.5.5', note: 'friability limits' });
    await userEvent.click(within(screen.getByTestId('rule-set-UOW-IP-1')).getByRole('button', { name: 'Sign the verification of UOW-IP version 1' }));
    await waitFor(() => expect(ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'RULE_SET_VERIFY', code: 'UOW-IP', version: 1 });
  });
});

describe('plant configuration', () => {
  it('[DI-49][IN-26][IN-38] saves an alarm code, opens and closes a campaign with a reason, sets a feed age and records a line isolation', async () => {
    const cfg = {
      alarmCodes: [],
      campaigns: [{ campaignId: U1, equipmentCode: null, areaCode: 'RM-1', product: 'P1', maxBatches: '5', maxDays: '14', validationRef: 'CV-1', openedBy: MEERA, openedAt: at('x'), closedBy: null, closedAt: null, closeReason: null }],
      feedAges: [], utilityClasses: ['PW-LOOP'], lineIsolations: [], lines: ['LN-1'],
    };
    const ui = renderMarket('/plant/configuration', {
      fixtures: { 'marketConfig.plantConfig': cfg, 'marketConfig.defineAlarmCode': cfg, 'marketConfig.openCampaign': cfg, 'marketConfig.closeCampaign': cfg, 'marketConfig.setUtilityFeedAge': cfg, 'marketConfig.recordLineIsolation': cfg },
    });
    const alarms = await screen.findByTestId('alarm-codes');
    await userEvent.type(within(alarms).getByRole('textbox', { name: 'Alarm code' }), 'FORCE.HIGH');
    await userEvent.type(within(alarms).getByRole('textbox', { name: 'Description' }), 'Force high');
    await userEvent.click(within(alarms).getByRole('button', { name: 'Save the alarm code' }));
    await waitFor(() => expect(ui.posts('/api/plant/alarm-codes')).toHaveLength(1));
    expect(ui.posts('/api/plant/alarm-codes')[0]?.body).toEqual({ source: 'OPCUA', code: 'FORCE.HIGH', gmpCritical: true, deviationRequired: false, description: 'Force high' });

    const camps = screen.getByTestId('campaigns');
    const close = within(camps).getByRole('button', { name: 'Close the campaign on RM-1' });
    expect(close.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(camps).getByRole('textbox', { name: 'Reason for closing a campaign' }), 'product change');
    await userEvent.click(close);
    await waitFor(() => expect(ui.posts(`/api/plant/campaigns/${U1}/closure`)).toHaveLength(1));
    expect(ui.posts(`/api/plant/campaigns/${U1}/closure`)[0]?.body).toEqual({ reason: 'product change' });
    await userEvent.click(within(camps).getByRole('radio', { name: 'A room' }));
    await userEvent.type(within(camps).getByRole('textbox', { name: 'Room code' }), 'RM-2');
    await userEvent.type(within(camps).getByRole('textbox', { name: 'Product' }), 'P1');
    await userEvent.type(within(camps).getByRole('textbox', { name: 'Maximum batches' }), '5');
    await userEvent.type(within(camps).getByRole('textbox', { name: 'Maximum days' }), '14');
    await userEvent.type(within(camps).getByRole('textbox', { name: 'Cleaning validation reference' }), 'CV-2');
    await userEvent.click(within(camps).getByRole('button', { name: 'Open the campaign' }));
    await waitFor(() => expect(ui.posts('/api/plant/campaigns')).toHaveLength(1));
    expect(ui.posts('/api/plant/campaigns')[0]?.body).toEqual({ areaCode: 'RM-2', product: 'P1', maxBatches: '5', maxDays: '14', validationRef: 'CV-2' });

    const ages = screen.getByTestId('feed-ages');
    await userEvent.click(within(ages).getByRole('radio', { name: 'PW-LOOP' }));
    await userEvent.type(within(ages).getByRole('textbox', { name: 'Maximum age (minutes)' }), '15');
    await userEvent.click(within(ages).getByRole('button', { name: 'Set the maximum age' }));
    await waitFor(() => expect(ui.posts('/api/plant/utility-feed-ages')).toHaveLength(1));
    expect(ui.posts('/api/plant/utility-feed-ages')[0]?.body).toEqual({ classCode: 'PW-LOOP', maxAgeMinutes: '15' });

    const iso = screen.getByTestId('line-isolations');
    await userEvent.click(within(iso).getByRole('radio', { name: 'LN-1' }));
    await userEvent.type(within(iso).getByRole('textbox', { name: 'Qualification reference' }), 'OQ-1');
    await userEvent.click(within(iso).getByRole('button', { name: 'Record the line isolation' }));
    await waitFor(() => expect(ui.posts('/api/plant/line-isolations')).toHaveLength(1));
    expect(ui.posts('/api/plant/line-isolations')[0]?.body).toEqual({ area: 'LN-1', isolated: true, reference: 'OQ-1' });
  });
});

const REVIEW = {
  versionId: U2,
  state: 'DRAFT',
  reviews: [],
  riskAssessments: [],
  draft: { changeRecord: null, effectiveFrom: null, reviewDue: null },
  evidence: { contentHash: 'c'.repeat(64), complete: false, missing: ['a passing sandbox test run on this exact content (SANDBOX_RUN)'], items: [{ kind: 'VALIDATOR' as const, result: 'PASS' as const, problems: [] }] },
};

describe('master records', () => {
  it('[PR-04] records the validation and a market\'s regulatory assessment of a change record', async () => {
    const cr = { changeRecordId: U1, number: 'CC-1', title: 'Punch change', changeClass: 'MAJOR', processImpacting: true, recordedAt: at('x'), validations: [], regulatory: [] };
    const ui = renderMarket('/mbr/change-records', { fixtures: { 'marketConfig.changeRecords': { changeRecords: [cr] }, 'marketConfig.addChangeRegulatory': cr, 'marketConfig.addChangeValidation': cr } });
    const s = await screen.findByTestId('change-record-CC-1');
    await userEvent.type(within(s).getByRole('textbox', { name: 'Market (two letters)' }), 'US');
    await userEvent.type(within(s).getByRole('textbox', { name: 'Reporting category' }), 'CBE-30');
    await userEvent.click(within(s).getByRole('button', { name: 'Record the regulatory assessment' }));
    await waitFor(() => expect(ui.posts(`/api/mbr/change-records/${U1}/regulatory`)).toHaveLength(1));
    expect(ui.posts(`/api/mbr/change-records/${U1}/regulatory`)[0]?.body).toEqual({ market: 'US', reportingCategory: 'CBE-30' });
    await userEvent.type(within(s).getByRole('textbox', { name: 'Validation reference' }), 'PV-1');
    await userEvent.click(within(s).getByRole('button', { name: 'Record the validation assessment' }));
    await waitFor(() => expect(ui.posts(`/api/mbr/change-records/${U1}/validation`)).toHaveLength(1));
    expect(ui.posts(`/api/mbr/change-records/${U1}/validation`)[0]?.body).toEqual({ validationRef: 'PV-1' });
  });

  it('[PR-05] records the periodic review with its outcome and next due date, and unlinks a risk assessment; a refusal is shown in the server\'s words', async () => {
    const review = { ...REVIEW, state: 'APPROVED', riskAssessments: [{ riskAssessmentId: U3, code: 'RA-1', version: '1', riskClass: 'MEDIUM', rationaleRef: 'QRM-1', subjects: [] }] };
    const ui = renderMarket(`/mbr/versions/${U2}/review`, {
      fixtures: { 'marketConfig.versionReview': review, 'marketConfig.recordPeriodicReview': review, 'marketConfig.unlinkRiskAssessment': refusal('EBMR-IAM-040', 'You do not hold the right to author this master.') },
    });
    const reviews = await screen.findByTestId('periodic-reviews');
    await userEvent.click(within(reviews).getByRole('radio', { name: 'A revision is required' }));
    await userEvent.type(within(reviews).getByRole('textbox', { name: 'Summary of the review' }), 'update the IPC frequency');
    await userEvent.type(within(reviews).getByRole('textbox', { name: 'Next review due (YYYY-MM-DD)' }), '2027-10-01');
    await userEvent.click(within(reviews).getByRole('button', { name: 'Record the periodic review' }));
    await waitFor(() => expect(ui.posts(`/api/mbr/versions/${U2}/periodic-reviews`)).toHaveLength(1));
    expect(ui.posts(`/api/mbr/versions/${U2}/periodic-reviews`)[0]?.body).toEqual({ outcome: 'REVISION_REQUIRED', summary: 'update the IPC frequency', nextDue: '2027-10-01' });
    await userEvent.click(within(screen.getByTestId('risk-links')).getByRole('button', { name: 'Unlink RA-1 version 1' }));
    expect(await screen.findByText('You do not hold the right to author this master.')).toBeTruthy();
  });

  it('[PR-06] raises a change record with its number, title, class, process impact and validation reference', async () => {
    const cr = { changeRecordId: U1, number: 'CC-9', title: 'New master', changeClass: 'CRITICAL', processImpacting: false, recordedAt: at('x'), validations: [], regulatory: [] };
    const ui = renderMarket('/mbr/change-records', { fixtures: { 'marketConfig.changeRecords': { changeRecords: [] }, 'marketConfig.recordChangeRecord': cr } });
    const s = await screen.findByTestId('raise-change-record');
    const raise = within(s).getByRole('button', { name: 'Raise the change record' });
    expect(raise.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(s).getByRole('textbox', { name: 'Change record number' }), 'CC-9');
    await userEvent.type(within(s).getByRole('textbox', { name: 'Title of the change' }), 'New master');
    await userEvent.click(within(s).getByRole('radio', { name: 'Critical' }));
    await userEvent.click(within(s).getByRole('radio', { name: 'No' }));
    await userEvent.type(within(s).getByRole('textbox', { name: 'Validation reference (optional)' }), 'PV-9');
    await userEvent.click(raise);
    await waitFor(() => expect(ui.posts('/api/mbr/change-records')).toHaveLength(1));
    expect(ui.posts('/api/mbr/change-records')[0]?.body).toEqual({ number: 'CC-9', title: 'New master', changeClass: 'CRITICAL', processImpacting: false, validationRef: 'PV-9' });
    expect(await screen.findByText('Change record CC-9 is raised.')).toBeTruthy();
  });

  it('[PR-07][PR-06] sets the draft\'s change record, effective-from and review due; records a risk assessment and links a recorded one for listed elements', async () => {
    const cr = { changeRecordId: U1, number: 'CC-1', title: 'New master', changeClass: 'MAJOR', processImpacting: true, recordedAt: at('x'), validations: [], regulatory: [] };
    const ra = { riskAssessmentId: U3, code: 'RA-7', version: '2', title: 'Blend risk', riskClass: 'HIGH', rationaleRef: 'QRM-7', recordedBy: MEERA, recordedAt: at('x') };
    const ui = renderMarket(`/mbr/versions/${U2}/review`, {
      fixtures: {
        'marketConfig.versionReview': REVIEW, 'marketConfig.setDraftAttributes': REVIEW, 'marketConfig.linkRiskAssessment': REVIEW, 'marketConfig.recordRiskAssessment': ra,
        'marketConfig.changeRecords': { changeRecords: [cr] }, 'marketConfig.riskAssessments': { riskAssessments: [ra] }, 'marketConfig.sandboxRunResults': { results: [] },
      },
    });
    const d = await screen.findByTestId('draft-attributes');
    expect(within(d).getByTestId('draft-change-record').textContent).toContain('none yet');
    await userEvent.type(within(d).getByRole('textbox', { name: 'Change record number' }), 'CC-1');
    await userEvent.type(within(d).getByRole('textbox', { name: /^Effective from/ }), '2026-11-01T00:00:00+05:30');
    await userEvent.type(within(d).getByRole('textbox', { name: 'Periodic review due (YYYY-MM-DD)' }), '2028-12-31');
    await userEvent.type(within(d).getByRole('textbox', { name: 'Reason' }), 'new master');
    await userEvent.click(within(d).getByRole('button', { name: 'Set the draft attributes' }));
    await waitFor(() => expect(ui.posts(`/api/mbr/versions/${U2}/draft-attributes`)).toHaveLength(1));
    expect(ui.posts(`/api/mbr/versions/${U2}/draft-attributes`)[0]?.body).toEqual({ changeRecordId: U1, effectiveFrom: '2026-11-01T00:00:00+05:30', reviewDue: '2028-12-31', reason: 'new master' });

    const r = screen.getByTestId('risk-links');
    await userEvent.type(within(r).getByRole('textbox', { name: 'Assessment code' }), 'RA-8');
    await userEvent.type(within(r).getByRole('textbox', { name: 'Title' }), 'Compression risk');
    await userEvent.type(within(r).getByRole('textbox', { name: 'Risk class' }), 'MEDIUM');
    await userEvent.type(within(r).getByRole('textbox', { name: 'Rationale reference (the QRM report)' }), 'QRM-8');
    await userEvent.click(within(r).getByRole('button', { name: 'Record the risk assessment' }));
    await waitFor(() => expect(ui.posts('/api/mbr/risk-assessments')).toHaveLength(1));
    expect(ui.posts('/api/mbr/risk-assessments')[0]?.body).toEqual({ code: 'RA-8', version: '1', title: 'Compression risk', riskClass: 'MEDIUM', rationaleRef: 'QRM-8' });
    await userEvent.type(within(r).getByRole('textbox', { name: /^Elements it covers/ }), 'blendTime, yieldCalc');
    await userEvent.click(within(r).getByRole('button', { name: 'Link RA-7 version 2' }));
    await waitFor(() => expect(ui.posts(`/api/mbr/versions/${U2}/risk-assessments`)).toHaveLength(1));
    expect(ui.posts(`/api/mbr/versions/${U2}/risk-assessments`)[0]?.body).toEqual({ riskAssessmentId: U3, subjects: ['blendTime', 'yieldCalc'] });
  });

  it('[DI-04][DI-05][INV-18] shows the evidence of the current content and imports a sandbox test-run result from the exchange folder; a result that cannot be imported is greyed with its reason', async () => {
    const result = (batch: string, problem: string | null) => ({
      fileName: `${(problem ? 'b' : 'a').repeat(64)}.json`, resultHash: (problem ? 'b' : 'a').repeat(64), runId: U1, batchNumber: batch, runStatus: 'EXECUTION_COMPLETE', passed: true,
      contentHash: 'c'.repeat(64), exportedAt: at('20-OCT-2026'), exporter: 'TEST-Anil Kumar (anil.kumar)', imported: false, problem,
    });
    const ui = renderMarket(`/mbr/versions/${U2}/review`, {
      fixtures: {
        'marketConfig.versionReview': REVIEW, 'marketConfig.changeRecords': { changeRecords: [] }, 'marketConfig.riskAssessments': { riskAssessments: [] },
        'marketConfig.sandboxRunResults': { results: [result('TEST-B26-0001', null), result('TEST-B26-0002', 'the run tested revision 1, and the content has changed since')] },
        'marketConfig.importSandboxRunResult': refusal('EBMR-IAM-040', 'You do not hold the right to author this master.'),
      },
    });
    const e = await screen.findByTestId('verification-evidence');
    expect(within(e).getByTestId('evidence-complete').textContent).toContain('Still missing: a passing sandbox test run on this exact content (SANDBOX_RUN).');
    expect(within(e).getByTestId('evidence-VALIDATOR').textContent).toContain('passed');
    expect((await within(e).findByRole('button', { name: 'Import the result of run TEST-B26-0002' })).hasAttribute('disabled')).toBe(true);
    expect(within(e).getByTestId('run-result-TEST-B26-0002').textContent).toContain('Cannot be imported: the run tested revision 1');
    await userEvent.click(within(e).getByRole('button', { name: 'Import the result of run TEST-B26-0001' }));
    await waitFor(() => expect(ui.posts(`/api/mbr/versions/${U2}/sandbox-run-results`)).toHaveLength(1));
    expect(ui.posts(`/api/mbr/versions/${U2}/sandbox-run-results`)[0]?.body).toEqual({ fileName: `${'a'.repeat(64)}.json` });
    expect(await screen.findByText('You do not hold the right to author this master.')).toBeTruthy();
  });

  it('[PR-36][IN-31] shows the labelling of a master and why it would fail approval; declares a cut label with its 211.122(g) control', async () => {
    const labelling = { versionId: U2, state: 'DRAFT', items: [{ step: 'pack', item: 'CARTON-1', form: 'CARTON' as const, templateId: null, templateRef: null, option211122g: null }], approvalProblem: 'CARTON-1 has no approved template' };
    const ui = renderMarket(`/mbr/versions/${U2}/labelling`, { fixtures: { 'labels.masterLabelling': labelling, 'labels.declareLabelling': labelling, 'labels.templates': { templates: [] } } });
    expect((await screen.findByTestId('labelling-state')).textContent).toContain('It would fail approval: CARTON-1 has no approved template');
    expect(screen.getByTestId('labelling-item-CARTON-1').textContent).toContain('no template');
    const form = screen.getByTestId('labelling-declare');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Step' }), 'pack');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Item code' }), 'LABEL-1');
    await userEvent.click(within(form).getByRole('radio', { name: 'Cut label' }));
    const declare = within(form).getByRole('button', { name: 'Declare the item' });
    expect(declare.hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(form).getByRole('radio', { name: 'Electronic 100' }));
    await userEvent.click(declare);
    await waitFor(() => expect(ui.posts(`/api/labels/masters/${U2}/labelling`)).toHaveLength(1));
    expect(ui.posts(`/api/labels/masters/${U2}/labelling`)[0]?.body).toEqual({ step: 'pack', item: 'LABEL-1', form: 'CUT_LABEL', option211122g: 'ELECTRONIC_100' });
  });

  it('[PR-05][DI-22] the reference documents screen retires a version from a date with the reason', async () => {
    const ui = renderMarket('/mbr', {
      fixtures: {
        'designer.referenceDocuments': { documents: [{ refId: U1, code: 'SOP-QA-017', kind: 'SOP', title: 'Batch numbering', version: '3', hash: 'ab', status: 'EFFECTIVE' }] },
        'marketConfig.retireReferenceDocument': { retirementId: U2 },
      },
    });
    const retire = await screen.findByTestId('reference-document-retire');
    await userEvent.click(within(retire).getByRole('radio', { name: 'SOP-QA-017 version 3' }));
    await userEvent.click(within(retire).getByRole('radio', { name: 'Withdrawn' }));
    await userEvent.type(within(retire).getByRole('textbox', { name: 'From (YYYY-MM-DD)' }), '2026-11-01');
    await userEvent.type(within(retire).getByRole('textbox', { name: 'Reason' }), 'superseded by version 4');
    await userEvent.click(within(retire).getByRole('button', { name: 'Retire the document version' }));
    await waitFor(() => expect(ui.posts(`/api/reference-documents/${U1}/retirement`)).toHaveLength(1));
    expect(ui.posts(`/api/reference-documents/${U1}/retirement`)[0]?.body).toEqual({ status: 'WITHDRAWN', effectiveFrom: '2026-11-01', reason: 'superseded by version 4' });
  });
});
