/**
 * The signature dialog shows as the record to be signed only what the signature binds (DI-37, DI-36; review finding
 * CN1). What the execution store (C3) sends beside the record for information (`notSigned`: the status and handling
 * of exceptions, exceptions raised by acts about a step, a stage's exceptions and open counts, targets, live
 * verdicts, times of system computations) is shown after the record in its own section, labelled as not part of the
 * signature; a member the signed part leaves out is not shown as empty inside it.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { SignableContentView } from '@ebmr/api-contract';
import { SignableContent } from '../../src/identity/SignableContent.tsx';

const NOTE = 'Shown for information only. These facts are not part of the signed content: this signature does not cover them, and they may change after signing without affecting it.';
const AT = { us: '1790586363000000', text: '28-SEP-2026 14:36:03 +05:30 (Asia/Kolkata)' };
const PRIYA = { personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e51', legalName: 'TEST-Priya Nair', loginName: 'test-operator-1', role: 'OPERATOR' };
const COMMON = {
  runId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
  batchNumber: 'TEST-B-0001',
  product: { code: 'PRD-PCM-500', name: 'Paracetamol Tablets', strength: '500 mg' },
  mbr: { familyCode: 'MBR-PCM', versionNumber: '2', revision: 3, contentHash: 'ab'.repeat(32) },
};

function view(title: string, meaning: string, rendering: Record<string, unknown> & { kind: string }): SignableContentView {
  const text = JSON.stringify(rendering);
  return SignableContentView.parse({ aggregateType: rendering.kind, aggregateId: 'agg-1', contentVersion: '4', canonicalText: text, contentHash: sha256Hex(text), meaning, meaningText: `${meaning} text`, title, preview: true, rendering });
}

/** The data exception as the step's content signs it: as raised, without status, deviation, handling or time. */
const SIGNED_EXCEPTION = { exceptionId: 'EX-2', type: 'CLEARANCE_FAILED', title: 'Clearance was not confirmed', category: 'DEVIATION_OR_OVERRIDE', severity: 'ACTION', tier: null, expected: null, actual: null, raisedBy: null, controls: ['PR-26'] };

const STEP = view('Line clearance performed: 1.1.1 Dispensing booth clearance', 'LINE_CLEARANCE_PERFORMED', {
  kind: 'batch_step',
  ...COMMON,
  meaning: 'LINE_CLEARANCE_PERFORMED',
  meaningText: 'I performed the line clearance.',
  step: { stepKey: 'S-1.1.1@', stepId: 'S-1.1.1', number: '1.1.1', title: 'Dispensing booth clearance', kind: 'PHASE', block: 'G-10@1', blockTitle: 'Clearance checklist', stage: { stageKey: 'ST-1@', number: '1', name: 'Dispensing' } },
  instruction: { text: 'Confirm the booth is empty and clean.', sop: null },
  fields: [
    {
      item: 'P-BOOTH-DP',
      name: 'Booth differential pressure',
      valueType: 'DECIMAL',
      unit: 'Pa',
      precision: null,
      categories: null,
      capture: 'MANUAL',
      limits: [],
      attempts: [
        {
          pointId: 'pt-7',
          attempt: 1,
          version: 1,
          value: { kind: 'DECIMAL', value: '18.5', unit: 'Pa' },
          echo: 'Computed 18.5 Pa',
          by: PRIYA,
          source: { mode: 'BLOCK', deviceCode: null, raw: null, code: null },
          verdict: { tier: null, failed: false, text: 'Judged when the loop ends' },
          flags: [],
          status: 'VALID',
        },
      ],
      computed: true,
      required: true,
    },
  ],
  entries: [],
  exceptions: [SIGNED_EXCEPTION],
  notSigned: {
    note: NOTE,
    exceptions: [
      { exceptionId: 'EX-1', type: 'OPERATOR_RAISED', title: 'Label printer jammed once', category: 'PROCESS', severity: 'ALERT', tier: null, expected: null, actual: null, blocking: false, whatToDo: 'Continue; the supervisor reviews the alert.', routedTo: ['PRODUCTION_SUPERVISOR'], status: 'OPEN', deviationRef: null, raisedAt: AT, raisedBy: PRIYA, controls: ['DI-34'], inSignedContent: false, why: 'Raised by an act about the step, not by its data.' },
      { exceptionId: 'EX-2', title: 'Clearance was not confirmed', inSignedContent: true, status: 'OPEN', deviationRef: 'DEV-2026-014', blocking: true, whatToDo: 'Stop. QA decides this exception.', routedTo: ['QA'], raisedAt: AT },
    ],
    targets: [{ item: 'P-BOOTH-DP', name: 'Booth differential pressure', target: { value: { kind: 'DECIMAL', value: '15.0', unit: 'Pa' }, source: 'MBR' }, limits: [] }],
    verdicts: [{ item: 'P-BOOTH-DP', pointId: 'pt-7', attempt: 1, version: 1, verdict: { tier: 'VALIDATED', failed: true, text: 'Outside the validated range at the loop exit' } }],
    times: [{ item: 'P-BOOTH-DP', pointId: 'pt-7', attempt: 1, version: 1, at: AT, what: 'the time the system computed this value' }],
  },
});

const STAGE = view('Stage 1 Dispensing', 'STAGE_SIGNED_OFF', {
  kind: 'batch_stage',
  ...COMMON,
  meaning: 'STAGE_SIGNED_OFF',
  meaningText: 'I reviewed and signed off this stage.',
  stage: { stageKey: 'ST-1@', stageId: 'ST-1', number: '1', name: 'Dispensing', startedAt: AT },
  steps: [{ stepKey: 'S-1.1.1@', stepId: 'S-1.1.1', number: '1.1.1', title: 'Dispensing booth clearance', block: 'G-10@1', status: 'COMPLETED', statusText: 'Completed' }],
  notSigned: {
    note: NOTE,
    openExceptions: [{ stepKey: 'S-1.1.1@', number: '1.1.1', openExceptions: 2 }],
    exceptions: [{ exceptionId: 'EX-1', type: 'OPERATOR_RAISED', title: 'Label printer jammed once', status: 'OPEN', deviationRef: null }],
  },
});

const signedRegion = (name: string) => screen.getByRole('region', { name });
const notSignedRegion = () => screen.getByRole('region', { name: 'For information: not part of this signature' });

describe('what is shown as signed, and what is shown beside it (CN1)', () => {
  it('[DI-37][DI-36] CN1: a step shows as signed only the exception its content holds, as raised; its status and the act exception are shown apart, labelled not signed', () => {
    render(<SignableContent view={STEP} />);
    const signed = signedRegion('Step to be signed');
    const other = notSignedRegion();
    // The two sections are apart: the not-signed one is not inside the record to be signed.
    expect(signed.contains(other)).toBe(false);
    expect(other.getAttribute('data-signed')).toBe('false');
    expect(within(other).getByText(NOTE)).toBeTruthy();
    // Signed: EX-2 as raised, without status, deviation, handling or time.
    const ex = within(signed).getByRole('article', { name: 'Exception EX-2' });
    expect(within(ex).getByText('CLEARANCE_FAILED (DEVIATION_OR_OVERRIDE)')).toBeTruthy();
    for (const label of ['Status', 'Deviation', 'What to do', 'Blocking', 'Routed to', 'Raised at']) expect(within(ex).queryByText(label)).toBeNull();
    expect(within(signed).queryByRole('article', { name: 'Exception EX-1' })).toBeNull();
    expect(within(signed).queryByText(/OPEN|DEV-2026-014|Label printer jammed/)).toBeNull();
    // The value: no target row, no time row, the verdict the content signs.
    expect(within(signed).queryByText('Target')).toBeNull();
    expect(within(signed).queryByText('At')).toBeNull();
    expect(within(signed).getByText('Judged when the loop ends')).toBeTruthy();
    expect(within(signed).queryByText(/Outside the validated range/)).toBeNull();
    expect(within(signed).queryByText('Not signed')).toBeNull();
    // Beside it: both exceptions with status and handling, the act exception marked as not part of the signature.
    const act = within(other).getByRole('article', { name: 'Exception EX-1' });
    expect(within(act).getByText('No: this signature does not cover this exception')).toBeTruthy();
    expect(within(act).getByText('Raised by an act about the step, not by its data.')).toBeTruthy();
    expect(within(act).getAllByText('OPEN').length).toBeGreaterThan(0);
    const status = within(other).getByRole('article', { name: 'Exception EX-2' });
    expect(within(status).getByText('DEV-2026-014')).toBeTruthy();
    expect(within(status).getByText('Stop. QA decides this exception.')).toBeTruthy();
    expect(within(other).getByText('Outside the validated range at the loop exit')).toBeTruthy();
    expect(within(other).getByText('15.0 Pa')).toBeTruthy();
    expect(within(other).getAllByText(AT.text).length).toBeGreaterThan(0);
    expect(within(other).getByText('Times of system computations')).toBeTruthy();
  });

  it('[DI-37][DI-36] CN1: a stage shows its steps as signed without open counts; its exceptions and open counts are shown apart', () => {
    render(<SignableContent view={STAGE} />);
    const signed = signedRegion('Stage to be signed');
    const other = notSignedRegion();
    expect(signed.contains(other)).toBe(false);
    const table = within(signed).getByRole('table');
    expect(within(table).queryByText('Open exceptions')).toBeNull();
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Step', 'Title', 'Block', 'Status']);
    expect(within(signed).queryByRole('article', { name: 'Exception EX-1' })).toBeNull();
    expect(within(signed).queryByText('Exceptions')).toBeNull();
    expect(within(other).getByRole('article', { name: 'Exception EX-1' })).toBeTruthy();
    expect(within(other).getByText('Open exceptions per step')).toBeTruthy();
  });
});

/** A QA hold point to be decided: the decision (disposition and comment) is part of the signed content (P26, P38). */
const HOLD = (decision: Record<string, unknown>) =>
  view('Hold point released: 1.1.2 QA release of the dispensing booth', 'HOLD_POINT_RELEASED', {
    kind: 'batch_step',
    ...COMMON,
    meaning: 'HOLD_POINT_RELEASED',
    meaningText: 'Hold point released by',
    step: { stepKey: 'H-TEST@', stepId: 'H-TEST', number: '1.1.2', title: 'QA release of the dispensing booth', kind: 'HOLD', block: null, blockTitle: null, stage: { stageKey: 'ST-1@', number: '1', name: 'Dispensing' } },
    decision,
    instruction: { text: null, sop: null },
    fields: [],
    entries: [],
    exceptions: [],
    notSigned: { note: NOTE, exceptions: [], statuses: [{ item: 'P-BOOTH-DP', pointId: 'pt-7', attempt: 1, version: 1, status: 'SUPERSEDED' }] },
  });

describe('a hold-point decision is shown as part of what is signed (P26, P38)', () => {
  it('[DI-37][PR-45] P26/P38: the decision and the comment being signed are shown first, inside the record to be signed', () => {
    render(<SignableContent view={HOLD({ proposed: { disposition: 'APPROVED_WITH_CONDITIONS', comment: 'Release only after the hardness retest passes' } })} />);
    const signed = signedRegion('Step to be signed');
    const decision = within(signed).getByRole('region', { name: 'Decision to be signed' });
    expect(decision.getAttribute('data-present')).toBe('true');
    expect(within(decision).getByText('Approved with conditions (APPROVED_WITH_CONDITIONS)')).toBeTruthy();
    expect(within(decision).getByText('Release only after the hardness retest passes')).toBeTruthy();
    // First: before the step and its header.
    const regions = within(signed).getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(regions[0]).toBe('Decision to be signed');
    // The status of a value now is shown apart, never in the record to be signed.
    expect(within(signed).queryByText(/SUPERSEDED/)).toBeNull();
    expect(within(notSignedRegion()).getByText('Status of each value now (valid, superseded, invalidated)')).toBeTruthy();
  });

  it('[DI-37][PR-45] P26/P38: a decision without a comment says so; a preview without the decision says the signature binds none', () => {
    const { unmount } = render(<SignableContent view={HOLD({ proposed: { disposition: 'NOT_APPROVED', comment: null } })} />);
    const decision = within(signedRegion('Step to be signed')).getByRole('region', { name: 'Decision to be signed' });
    expect(within(decision).getByText('Not approved (NOT_APPROVED)')).toBeTruthy();
    expect(within(decision).getByText('none')).toBeTruthy();
    unmount();
    render(<SignableContent view={HOLD({ proposed: null, note: 'Preview it with the decision.' })} />);
    const none = within(signedRegion('Step to be signed')).getByRole('region', { name: 'Decision to be signed' });
    expect(none.getAttribute('data-present')).toBe('false');
    expect(within(none).getByText('No decision is part of the content shown. The signature binds only what is shown here.')).toBeTruthy();
    expect(within(none).getByText('Preview it with the decision.')).toBeTruthy();
  });

  it('[DI-37][PR-45] an empty comment and a comment of white space only are each shown as such, never as no comment or as an empty cell', () => {
    const commentOf = (comment: unknown): string => {
      const { unmount } = render(<SignableContent view={HOLD({ proposed: { disposition: 'NOT_APPROVED', comment } })} />);
      const decision = within(signedRegion('Step to be signed')).getByRole('region', { name: 'Decision to be signed' });
      const row = within(decision).getByText('Comment').parentElement;
      const text = row?.querySelector('dd')?.textContent ?? '(no comment row)';
      unmount();
      return text;
    };
    // The database records each of these as another decision (recipe-core 0295): the reviewer sees which one is signed.
    expect([null, '', ' ', '\t ', 'Residue found'].map(commentOf)).toEqual([
      'none',
      'Empty: a comment with no text (not the same as no comment)',
      'Blank: only white space (1 character)',
      'Blank: only white space (2 characters)',
      'Residue found',
    ]);
  });
});
