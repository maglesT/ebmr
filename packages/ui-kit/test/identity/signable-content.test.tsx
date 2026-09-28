/**
 * What is being signed (module C1, DI-37): the renderers of the execution store's (C3) signable content, with
 * fixtures in the exact rendering shapes C3 sends and every contract view parsed through its @ebmr/api-contract
 * schema. The signer sees every member: known ones with plain labels, unknown ones as labelled text. The proposed
 * disposition of an exception comes first and only from the signed content.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { EntryView, ExceptionView, FieldView, Instant, LimitView, PersonRef, SignableContentView, StepSummaryView } from '@ebmr/api-contract';
import { SignableContent, limitText, valueText } from '../../src/identity/SignableContent.tsx';

const AT_1 = Instant.parse({ us: '1790586363000000', text: '28-SEP-2026 14:36:03 +05:30 (Asia/Kolkata)' });
const AT_2 = Instant.parse({ us: '1790586423000000', text: '28-SEP-2026 14:37:03 +05:30 (Asia/Kolkata)' });
const AT_3 = Instant.parse({ us: '1790587023000000', text: '28-SEP-2026 14:47:03 +05:30 (Asia/Kolkata)' });
const PRIYA = PersonRef.parse({ personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e51', legalName: 'TEST-Priya Nair', loginName: 'test-operator-1', role: 'OPERATOR' });
const MEERA = PersonRef.parse({ personId: '5b2d3e4f-6a7b-4c8d-9e0f-1a2b3c4d5e62', legalName: 'TEST-Meera Iyer', loginName: 'test-qa-1', role: 'QA_OFFICER' });

const COMMON = {
  runId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
  batchNumber: 'TEST-B-0001',
  product: { code: 'PRD-PCM-500', name: 'Paracetamol Tablets', strength: '500 mg' },
  mbr: { familyCode: 'MBR-PCM', versionNumber: '2', revision: 3, contentHash: 'ab'.repeat(32) },
};

const PRESSURE_LIMIT = LimitView.parse({
  tier: 'VALIDATED',
  low: { value: '10.0', inclusive: true },
  high: { value: '25.0', inclusive: false },
  source: { kind: 'VALIDATION_REPORT', ref: 'VR-HVAC-03', text: 'Dispensing booth HVAC qualification' },
  rounding: 'HALF_UP to 1 decimal',
});
const SPEED_LIMIT = LimitView.parse({
  tier: 'ALERT',
  low: { value: '12.0', inclusive: true },
  high: { value: '14.0', inclusive: true },
  source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01', text: 'Blend uniformity study' },
  rounding: 'HALF_UP to 1 decimal',
});

const FIELD = FieldView.parse({
  item: 'P-BOOTH-DP',
  name: 'Booth differential pressure',
  valueType: 'DECIMAL',
  unit: 'Pa',
  precision: { kind: 'DECIMALS', digits: 1 },
  categories: null,
  capture: 'MANUAL',
  target: { value: { kind: 'DECIMAL', value: '15.0', unit: 'Pa' }, source: 'MBR' },
  limits: [PRESSURE_LIMIT],
  attempts: [
    {
      pointId: 'pt-7',
      attempt: 1,
      version: 1,
      value: { kind: 'DECIMAL', value: '18.5', unit: 'Pa' },
      echo: 'You entered 18.5 Pa',
      by: PRIYA,
      at: AT_1,
      source: { mode: 'MANUAL', deviceCode: null, raw: null, code: null },
      verdict: { tier: null, failed: false, text: 'Within the validated range' },
      flags: [],
      status: 'VALID',
    },
  ],
  computed: false,
  required: true,
});
const ENTRY = EntryView.parse({
  entryId: 'en-3',
  kind: 'LINE_CLEARANCE',
  summary: 'Line clearance checklist completed',
  data: { previousProduct: 'PRD-IBU-200', checklist: ['Booth empty', 'Previous labels removed'] },
  by: PRIYA,
  at: AT_1,
});
const EXCEPTION = ExceptionView.parse({
  exceptionId: 'EX-1',
  type: 'LIMIT_EXCURSION',
  title: 'Blender speed above the alert limit',
  category: 'PROCESS',
  severity: 'ALERT',
  tier: 'ALERT',
  expected: '12.0 to 14.0 /min',
  actual: '15.0 /min',
  blocking: true,
  whatToDo: 'Ask QA to disposition the exception.',
  routedTo: ['QA_OFFICER'],
  status: 'OPEN',
  deviationRef: 'DEV-2026-014',
  raisedAt: AT_2,
  raisedBy: null,
  controls: ['PR-49'],
});
const SUMMARIES = [
  StepSummaryView.parse({ stepKey: 'S-1.1.1@', stepId: 'S-1.1.1', number: '1.1.1', title: 'Dispensing booth clearance', block: 'G-04@1', status: 'COMPLETED', statusText: 'Completed', openExceptions: 0 }),
  StepSummaryView.parse({ stepKey: 'S-1.1.2@', stepId: 'S-1.1.2', number: '1.1.2', title: 'Dispense binder', block: 'W-01@2', status: 'AWAITING_VERIFICATION', statusText: 'Awaiting verification', openExceptions: 1 }),
];

function view(title: string, meaning: string, rendering: Record<string, unknown> & { kind: string }): SignableContentView {
  const text = JSON.stringify(rendering);
  return SignableContentView.parse({ aggregateType: rendering.kind, aggregateId: 'agg-1', contentVersion: '4', canonicalText: text, contentHash: sha256Hex(text), meaning, meaningText: `${meaning} text`, title, preview: true, rendering });
}

const STEP = view('Line clearance verified: 1.1.1 Dispensing booth clearance', 'LINE_CLEARANCE_VERIFIED', {
  kind: 'batch_step',
  ...COMMON,
  meaning: 'LINE_CLEARANCE_VERIFIED',
  meaningText: 'I verified the line clearance of this step.',
  step: { stepKey: 'S-1.1.1@', stepId: 'S-1.1.1', number: '1.1.1', title: 'Dispensing booth clearance', kind: 'PHASE', block: 'G-04@1', blockTitle: 'Line clearance', stage: { stageKey: 'ST-1@', number: '1', name: 'Dispensing' }, loopLabel: 'iteration 2 of 3' },
  instruction: { text: 'Confirm the booth is empty and clean.', sop: { code: 'SOP-DSP-004', title: 'Dispensing booth clearance', version: '05', hash: 'cd'.repeat(32) } },
  fields: [FIELD],
  entries: [ENTRY],
  exceptions: [EXCEPTION],
  reviewNote: 'a member C3 adds later',
});

const STAGE = view('Stage 1 Dispensing', 'STAGE_SIGNED_OFF', {
  kind: 'batch_stage',
  ...COMMON,
  meaning: 'STAGE_SIGNED_OFF',
  meaningText: 'I reviewed and signed off this stage.',
  stage: { stageKey: 'ST-1@', stageId: 'ST-1', number: '1', name: 'Dispensing', startedAt: AT_1 },
  steps: [SUMMARIES[0], { ...SUMMARIES[1], subLot: 'sub-lot 2' }],
  exceptions: [EXCEPTION],
});

const exceptionView = (disposition: unknown) =>
  view('Exception EX-1: Blender speed above the alert limit', 'EXCEPTION_DISPOSITIONED', {
    kind: 'batch_exception',
    ...COMMON,
    meaning: 'EXCEPTION_DISPOSITIONED',
    meaningText: 'I dispositioned this exception.',
    step: { stepKey: 'S-2.1.4@', number: '2.1.4', title: 'Blend' },
    exception: { ...EXCEPTION, escalatedTo: 'QA head' },
    recorded: { item: 'P-BLEND-SPEED', name: 'Blender speed', value: { kind: 'DECIMAL', value: '15.0', unit: '/min' }, text: '15.0 /min (entered)', limits: [SPEED_LIMIT] },
    deviation: { ref: 'DEV-2026-014', linkedBy: MEERA, at: AT_3 },
    disposition,
  });

describe('what is signed: the C3 rendering shapes', () => {
  it('[DI-37] a step shows its batch, product, master record, meaning, step, instruction, values with limits and attempts, entries and exceptions', () => {
    render(<SignableContent view={STEP} />);
    const region = screen.getByRole('region', { name: 'Step to be signed' });
    const has = (text: string) => expect(within(region).getByText(text)).toBeTruthy();
    has('Line clearance verified: 1.1.1 Dispensing booth clearance');
    has('TEST-B-0001');
    has('PRD-PCM-500 · Paracetamol Tablets · 500 mg');
    has('MBR-PCM version 2, revision 3');
    has(`· SHA-256 ${'ab'.repeat(32)}`);
    has('LINE_CLEARANCE_VERIFIED: I verified the line clearance of this step.');
    has('1.1.1 Dispensing booth clearance');
    has('Processing step');
    has('G-04@1 Line clearance');
    has('1 Dispensing');
    has('Confirm the booth is empty and clean.');
    has('SOP SOP-DSP-004 Dispensing booth clearance, version 05');
    // The value, its limit (exclusive high bound), its attempt with the server's verdict.
    const value = within(region).getByRole('article', { name: 'Value Booth differential pressure' });
    expect(within(value).getByText('Booth differential pressure (Pa)')).toBeTruthy();
    expect(within(value).getByText('Validated range: ≥ 10.0 and < 25.0 Pa (VALIDATION_REPORT VR-HVAC-03: Dispensing booth HVAC qualification); rounding HALF_UP to 1 decimal')).toBeTruthy();
    expect(within(value).getByText('P-BOOTH-DP · DECIMAL · 1 decimals')).toBeTruthy();
    expect(within(value).getByText('15.0 Pa (MBR)')).toBeTruthy();
    expect(within(value).getByText('18.5 Pa')).toBeTruthy();
    expect(within(value).getByText('TEST-Priya Nair (test-operator-1), OPERATOR')).toBeTruthy();
    expect(within(value).getByText('Within the validated range')).toBeTruthy();
    // The entry with its data, the exception raised by the system.
    has('Line clearance checklist completed (LINE_CLEARANCE, en-3)');
    has('PRD-IBU-200');
    has('Previous labels removed');
    const ex = within(region).getByRole('article', { name: 'Exception EX-1' });
    expect(within(ex).getByText('EX-1: Blender speed above the alert limit')).toBeTruthy();
    expect(within(ex).getByText('the system')).toBeTruthy();
    expect(within(ex).getByText('Yes: it stops the work until it is resolved')).toBeTruthy();
    expect(within(ex).getByText('ALERT, Alert limit')).toBeTruthy();
    // Unknown members (top level and nested) are shown as labelled text.
    has('Loop label');
    has('iteration 2 of 3');
    has('Review note');
    has('a member C3 adds later');
  });

  it('[DI-37] a stage shows when it started, every step with its status and open exceptions, and the exceptions', () => {
    render(<SignableContent view={STAGE} />);
    const region = screen.getByRole('region', { name: 'Stage to be signed' });
    expect(within(region).getByRole('heading', { name: 'Stage 1 Dispensing' })).toBeTruthy();
    expect(within(region).getByText('28-SEP-2026 14:36:03 +05:30 (Asia/Kolkata)')).toBeTruthy();
    expect(within(region).getByText('ST-1@ (ST-1)')).toBeTruthy();
    const table = within(region).getByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    const second = rows[2];
    if (!second) throw new Error('missing row');
    for (const text of ['1.1.2', 'Dispense binder', 'W-01@2', 'Awaiting verification', '1']) expect(within(second).getByText(text)).toBeTruthy();
    expect(within(second).getByText('Sub lot')).toBeTruthy();
    expect(within(second).getByText('sub-lot 2')).toBeTruthy();
    expect(within(region).getByRole('article', { name: 'Exception EX-1' })).toBeTruthy();
  });

  it('[DI-37] an exception shows its proposed disposition first and prominently, then the exception, the recorded value, its limits and the linked deviation', () => {
    render(<SignableContent view={exceptionView({ proposed: { outcome: 'DEVIATION_RAISED', justification: 'Speed restored; blend uniformity to be tested under DEV-2026-014.', deviationRef: 'DEV-2026-014', reviewedWith: 'Line QA' } })} />);
    const region = screen.getByRole('region', { name: 'Exception to be signed' });
    const disposition = within(region).getByRole('region', { name: 'Proposed disposition' });
    // First: nothing of the record comes before the disposition.
    expect(region.querySelector('section')).toBe(disposition);
    expect(disposition.getAttribute('data-present')).toBe('true');
    expect(disposition.className).not.toBe('');
    expect(within(disposition).getByText('Deviation raised (DEVIATION_RAISED)')).toBeTruthy();
    expect(within(disposition).getByText('Speed restored; blend uniformity to be tested under DEV-2026-014.')).toBeTruthy();
    expect(within(disposition).getByText('DEV-2026-014')).toBeTruthy();
    expect(within(disposition).getByText('Reviewed with')).toBeTruthy();
    expect(within(disposition).getByText('Line QA')).toBeTruthy();
    const has = (text: string) => expect(within(region).getByText(text)).toBeTruthy();
    has('Exception EX-1: Blender speed above the alert limit');
    has('EXCEPTION_DISPOSITIONED: I dispositioned this exception.');
    has('EX-1: Blender speed above the alert limit');
    has('the system');
    has('Escalated to');
    has('QA head');
    has('2.1.4 Blend (S-2.1.4@)');
    const recorded = within(region).getByRole('region', { name: 'Recorded value' });
    for (const text of ['Blender speed', '15.0 /min', '(P-BLEND-SPEED)', '15.0 /min (entered)', 'Alert limit: ≥ 12.0 and ≤ 14.0 /min (VALIDATION_REPORT VR-BLEND-01: Blend uniformity study); rounding HALF_UP to 1 decimal']) {
      expect(within(recorded).getByText(text)).toBeTruthy();
    }
    has('DEV-2026-014, linked by TEST-Meera Iyer (test-qa-1), QA_OFFICER at 28-SEP-2026 14:47:03 +05:30 (Asia/Kolkata)');
  });

  it('[DI-37] without a proposal in the signed content no outcome is shown, the note is, and a system-raised exception says so', () => {
    render(<SignableContent view={exceptionView({ proposed: null, note: 'Preview it with the proposal as the intent.' })} />);
    const disposition = screen.getByRole('region', { name: 'Proposed disposition' });
    expect(disposition.getAttribute('data-present')).toBe('false');
    expect(within(disposition).getByText('No disposition is part of the content shown. The signature binds only what is shown here.')).toBeTruthy();
    expect(within(disposition).getByText('Note')).toBeTruthy();
    expect(within(disposition).getByText('Preview it with the proposal as the intent.')).toBeTruthy();
    expect(within(disposition).queryByText(/NO_IMPACT|DEVIATION_RAISED/)).toBeNull();
    expect(screen.getByText('the system')).toBeTruthy();
  });

  it('[DI-37] an exception outside a step without a recorded value or deviation says so rather than leaving gaps', () => {
    const v = view('Exception EX-2: Hold time exceeded', 'EXCEPTION_DISPOSITIONED', {
      kind: 'batch_exception',
      ...COMMON,
      meaning: 'EXCEPTION_DISPOSITIONED',
      meaningText: 'I dispositioned this exception.',
      step: null,
      exception: { ...EXCEPTION, exceptionId: 'EX-2', title: 'Hold time exceeded', raisedBy: PRIYA, deviationRef: null },
      recorded: null,
      deviation: null,
      disposition: { proposed: { outcome: 'NO_IMPACT', justification: 'Within the validated hold study.', deviationRef: null } },
    });
    render(<SignableContent view={v} />);
    expect(within(screen.getByRole('region', { name: 'Proposed disposition' })).getByText('No impact (NO_IMPACT)')).toBeTruthy();
    for (const text of ['Not raised at a step.', 'No recorded value belongs to this exception.', 'none linked', 'TEST-Priya Nair (test-operator-1), OPERATOR']) expect(screen.getByText(text)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Deviation linked' })).getByText('None.')).toBeTruthy();
  });
});

describe('value and limit text', () => {
  it('[DI-37] data values show exactly as sent: decimals with their unit, instants in exact UTC', () => {
    expect(valueText({ kind: 'DECIMAL', value: '12.503', unit: 'kg' })).toBe('12.503 kg');
    expect(valueText({ kind: 'COUNT', value: '12' })).toBe('12');
    expect(valueText({ kind: 'BOOLEAN', value: false })).toBe('No');
    expect(valueText({ kind: 'CATEGORY', value: 'PASS' })).toBe('PASS');
    expect(valueText({ kind: 'INSTANT', us: '1790586363000000' })).toBe('2026-09-28 09:06:03.000000 UTC');
    expect(valueText({ kind: 'SERIES', values: ['1.0', '1.10'], unit: 'mm' })).toBe('1.0, 1.10 mm');
    expect(valueText(null)).toBe('—');
  });

  it('[DI-37] a one-sided limit shows only its bound and whether it is inclusive', () => {
    expect(limitText({ ...SPEED_LIMIT, tier: 'REGISTERED', low: null, high: { value: '2.0', inclusive: false } }, '%')).toBe(
      'Registered limit: < 2.0 % (VALIDATION_REPORT VR-BLEND-01: Blend uniformity study); rounding HALF_UP to 1 decimal',
    );
  });
});
