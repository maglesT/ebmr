/**
 * Phase 7 slice 7p screens: a profile test (dissolution at 1 h, 4 h, 8 h, each with its own limits) drafted in the
 * specification editor, shown on the lot page as one release requirement whose points QC records one by one (typed or
 * from the LIMS value), and a point's result approved through the ceremony with its point in the name.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { renderOffice } from './support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const lot = example('quality-lots').lots[0];
const lotPath = `/quality/lots/${lot?.lotId ?? ''}`;
const RID = '5b4c3d2e-1f0a-4b9c-8d7e-6f5a4b3c2d1e';
const profile = {
  testCode: 'DISSOLUTION', unit: '%', required: true, status: 'OPEN', problem: 'time point 4 h of profile DISSOLUTION has no current RELEASE result',
  points: [
    { pointNo: 1, label: '1 h', stage: null, timeValue: '1', timeUnit: 'h', lowerLimit: null, upperLimit: '40', result: { resultId: RID, value: '31', verdict: 'PASS', state: 'APPROVED' }, lims: null },
    { pointNo: 2, label: '4 h', stage: null, timeValue: '4', timeUnit: 'h', lowerLimit: '45', upperLimit: '70', result: null, lims: { sampleId: 'S-9', value: '58.4', unit: '%', verdict: 'PASS', conformance: 'CONFORMS', state: 'APPROVED' } },
    { pointNo: 3, label: '8 h', stage: null, timeValue: '8', timeUnit: 'h', lowerLimit: '80', upperLimit: null, result: null, lims: null },
  ],
};

describe('profiles on the QC screen (slice 7p)', () => {
  it('[IN-33][PR-45] the profile is one requirement with its status; QC records a point typed or from the LIMS value; a recorded point offers no entry', async () => {
    const ui = renderOffice(lotPath, { role: 'QC_ANALYST', fixtures: { 'quality.lotProfiles': { profiles: [profile] } } });
    const box = await screen.findByTestId('profile-DISSOLUTION');
    expect(box.getAttribute('data-status')).toBe('OPEN');
    expect(box.textContent).toContain('time point 4 h of profile DISSOLUTION has no current RELEASE result');
    expect(within(screen.getByTestId('point-DISSOLUTION-1 h')).queryByRole('button')).toBeNull();
    const eight = screen.getByTestId('point-DISSOLUTION-8 h');
    await userEvent.type(within(eight).getByRole('textbox', { name: 'Value at 8 h' }), '86');
    await userEvent.click(within(eight).getByRole('button', { name: 'Record DISSOLUTION at 8 h' }));
    await waitFor(() => expect(ui.posts(`/api/quality/lots/${lot?.lotId ?? ''}/results`)).toHaveLength(1));
    expect(ui.posts(`/api/quality/lots/${lot?.lotId ?? ''}/results`)[0]?.body).toEqual({ testCode: 'DISSOLUTION', point: '8 h', purpose: 'RELEASE', value: '86' });
    await userEvent.click(within(screen.getByTestId('point-DISSOLUTION-4 h')).getByRole('button', { name: 'Record the LIMS value at 4 h' }));
    await waitFor(() => expect(ui.posts(`/api/quality/lots/${lot?.lotId ?? ''}/results`)).toHaveLength(2));
    expect(ui.posts(`/api/quality/lots/${lot?.lotId ?? ''}/results`)[1]?.body).toEqual({ testCode: 'DISSOLUTION', point: '4 h', purpose: 'RELEASE', value: '58.4' });
  });

  it('[IN-33] a point\'s result is approved through the ceremony, named with its point', async () => {
    const r = { resultId: RID, testCode: 'DISSOLUTION', point: '4 h', purpose: 'RELEASE', value: '58', unit: '%', lowerLimit: '45', upperLimit: '70', verdict: 'PASS', state: 'RECORDED' };
    const ui = renderOffice(lotPath, { role: 'QC_ANALYST', fixtures: { 'quality.lotResults': { results: [r] } } });
    const row = await screen.findByTestId('result-DISSOLUTION-4 h-RELEASE');
    await userEvent.click(within(row).getByRole('button', { name: 'Approve DISSOLUTION at 4 h' }));
    await waitFor(() => expect(ui.ceremony.sign).toHaveBeenCalledTimes(1));
    expect(ui.ceremony.sign.mock.calls[0]?.[0].action).toEqual({ kind: 'QUALITY_ACT', act: 'LOT_RESULT_APPROVE', subjectId: RID, input: {} });
  });
});

describe('profiles in the specification editor (slice 7p)', () => {
  it('[IN-33] QC drafts a profile test: its limits are on its ordered time points, the test has none', async () => {
    const ui = renderOffice('/quality/specifications', { role: 'QC_ANALYST' });
    const box = await screen.findByTestId('draft-specification');
    const type = async (name: string, v: string) => userEvent.type(within(box).getByRole('textbox', { name }), v);
    await type('Material code', 'SR-500');
    await type('Title', 'Finished product specification');
    await type('Monograph reference', 'In-house monograph');
    await type('Test code 1', 'DISSOLUTION');
    await type('Method 1', 'STP-DS-SR');
    await type('Unit 1', '%');
    await userEvent.click(within(box).getByRole('radio', { name: 'Profile (time points)' }));
    expect(within(box).queryByRole('textbox', { name: 'Lower limit 1' })).toBeNull();
    for (const [k, label, time, unit, lower, upper] of [[1, '1 h', '1', 'h', '', '40'], [2, '4 h', '4', 'h', '45', '70']] as const) {
      const p = within(screen.getByTestId(`spec-test-0-point-${String(k - 1)}`));
      await userEvent.type(p.getByRole('textbox', { name: `Label of point ${String(k)} of test 1` }), label);
      await userEvent.type(p.getByRole('textbox', { name: `Time of point ${String(k)} of test 1` }), time);
      await userEvent.click(p.getByRole('radio', { name: unit }));
      if (lower) await userEvent.type(p.getByRole('textbox', { name: `Lower limit of point ${String(k)} of test 1` }), lower);
      await userEvent.type(p.getByRole('textbox', { name: `Upper limit of point ${String(k)} of test 1` }), upper);
    }
    await userEvent.click(within(box).getByRole('radio', { name: 'Yes' }));
    await userEvent.click(within(box).getByRole('radio', { name: 'IN_HOUSE' }));
    await type('Edition 1', 'STP-DS-SR v1');
    await type('Sample per run 1', '12');
    await type('Sample unit 1', 'units');
    await userEvent.click(within(box).getByRole('button', { name: 'Draft the version' }));
    await waitFor(() => expect(ui.posts('/api/quality/specifications')).toHaveLength(1));
    expect(ui.posts('/api/quality/specifications')[0]?.body).toMatchObject({
      materialCode: 'SR-500',
      tests: [{ testCode: 'DISSOLUTION', unit: '%', required: true, points: [{ label: '1 h', timeValue: '1', timeUnit: 'h', upperLimit: '40' }, { label: '4 h', timeValue: '4', timeUnit: 'h', lowerLimit: '45', upperLimit: '70' }] }],
    });
    const sent = (ui.posts('/api/quality/specifications')[0]?.body as { tests: Record<string, unknown>[] }).tests[0] ?? {};
    expect('lowerLimit' in sent || 'upperLimit' in sent).toBe(false);
  });
});
