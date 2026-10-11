/**
 * Process and recording blocks: G-03 instruction, G-05 observation, G-11 environment, G-12 sampling,
 * G-13 IPC, G-15 timer/transfer, G-24 reprocessing gate.
 */
import { describe, expect, it } from 'vitest';
import type { FlowNode, MbrContent, PhaseNode } from '../../src/flow/model.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, OP1, OP2, param, QA1, Run, sig, T0, VER1 } from '../engine/support.ts';

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const one = (p: Partial<PhaseNode>, extra: Partial<MbrContent> = {}): MbrContent => mbrWith(seq('ops', phase('x', p), phase('z')), extra);

describe('G-03 instruction and acknowledgement', () => {
  it('[DI-34][DI-10] an instruction cannot be signed before it is acknowledged; the SOP version in force is written into the record', () => {
    const mbr = one({ block: { type: 'G-03', version: '1' }, config: { sop: 'SOP-1', acknowledgement: 'READ' } }, {
      references: [
        { id: 'RSK', kind: 'RISK_SCALE', code: 'RSK', version: '1', hash: 'a'.repeat(64) },
        { id: 'SOP-1', kind: 'SOP', code: 'SOP-GRAN-004', version: '7', hash: 'd'.repeat(64) },
      ],
    });
    const run = Run.issue(define(mbr));
    run.start('x');
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'x', signature: sig('PERFORMED', OP1) }, 'G03-NOT-ACKNOWLEDGED');
    expect(run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'x', entry: { kind: 'ACKNOWLEDGE', mode: 'READ', sopVersion: '6' } }).refusal?.code).toBe('G03-SOP-VERSION');
    run.entry('x', { kind: 'ACKNOWLEDGE', mode: 'READ', sopVersion: '7' });
    expect(Object.values(run.state.entries)[0]?.data).toMatchObject({ sop: 'SOP-GRAN-004', sopVersion: '7', acknowledgedBy: 'OP1' });
    run.perform('x');
  });

  it('[DI-10] an instruction naming an SOP the MBR does not reference cannot be executed', () => {
    expect(() => define(one({ block: { type: 'G-03', version: '1' }, config: { sop: 'SOP-X' } }))).toThrow(/G03-SOP-REF/);
  });
});

describe('G-05 observation capture and G-13 IPC', () => {
  it('[DI-41][DI-30] a scanned paper original attached as evidence makes a second-person verification mandatory', () => {
    const run = Run.issue(define(one({ block: { type: 'G-05', version: '1' }, signatures: { perform: { role: 'OPERATOR' } } })));
    run.start('x');
    run.entry('x', { kind: 'ATTACHMENT', sha256: 'e'.repeat(64), mediaType: 'image/png', description: 'balance printout', paperOriginal: true });
    run.perform('x');
    expect(run.status('x')).toBe('AWAITING_VERIFICATION');
    run.verify('x', [], VER1, 'VERIFIED');
  });

  it('[PR-29][IN-20][DI-29] a failing categorical IPC stops the step until a deviation is linked, and a passing re-test never replaces it', () => {
    const run = Run.issue(define(one({ block: { type: 'G-13', version: '1' }, records: ['leak'] }, { parameters: [param('leak', { valueType: 'CATEGORY', categories: ['PASS', 'FAIL'], role: 'IPC' })] })));
    run.start('x');
    run.record('x', 'leak', { kind: 'CATEGORY', value: 'FAIL' });
    run.record('x', 'leak', { kind: 'CATEGORY', value: 'PASS' });
    expect(run.exceptions().map((e) => e.type).sort()).toEqual(['IPC_RESULT_FAILED', 'REPEAT_AFTER_FAIL']);
    expect(run.value('leak', 'x')).toBe('FAIL');
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'x', signature: sig('IPC_PERFORMED', OP1) }, 'ENG-BLOCKED');
  });

  it('[IN-35][DI-29] a readings set with fewer values than the plan is refused (every reading is kept individually)', () => {
    const run = Run.issue(define(one({ block: { type: 'G-13', version: '1' }, records: ['w'] }, { parameters: [param('w', { unit: 'mg', precision: { kind: 'DECIMALS', digits: 1 }, readings: 20, role: 'IPC' })] })));
    run.start('x');
    const r = run.refused({ type: 'RECORD_DATA', actor: OP1, step: 'x', item: 'w', value: { kind: 'SERIES', values: Array.from({ length: 19 }, () => '250.0'), unit: 'mg' }, source: { mode: 'DEVICE', device: 'B' } }, 'ENG-VALUE-READINGS');
    expect(r.message).toContain('19');
  });
});

describe('G-11 environmental condition check', () => {
  it('[IN-39][PR-25] a pressure difference below its action limit stops the step, links a deviation and notifies production and QA', () => {
    const run = Run.issue(define(one({ block: { type: 'G-11', version: '1' }, records: ['dp'] }, {
      parameters: [param('dp', { unit: 'Pa', precision: { kind: 'DECIMALS', digits: 0 }, role: 'PROCESS_PARAMETER', limits: { unit: 'Pa', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: '10', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'V' } }] } })],
    })));
    run.start('x');
    run.record('x', 'dp', { kind: 'DECIMAL', value: '8', unit: 'Pa' });
    expect(run.exceptions().map((e) => e.type).sort()).toEqual(['ENVIRONMENT_EXCURSION', 'LIMIT_BREACH']);
    const note = run.events.find((e) => e.type === 'NOTIFICATION');
    expect(note?.type === 'NOTIFICATION' ? note.roles : []).toEqual(['PRODUCTION_SUPERVISOR', 'QA']);
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'x', signature: sig('PERFORMED', OP1) }, 'ENG-BLOCKED');
  });
});

describe('G-12 sampling', () => {
  it('[IN-20][PR-29] sample ids are system-generated and the label carries product, batch, sample, sampler and time; an unplanned point is refused', () => {
    const run = Run.issue(define(one({ block: { type: 'G-12', version: '1' }, config: { locations: 2, replicates: 1, purpose: 'BU' } })));
    run.start('x');
    expect(run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'x', entry: { kind: 'SAMPLE', point: 'L9', purpose: 'BU', units: 1 } }).refusal?.code).toBe('G12-NOT-PLANNED');
    run.entry('x', { kind: 'SAMPLE', point: 'L1', purpose: 'BU', units: 1 });
    const d = Object.values(run.state.entries)[0]?.data;
    expect(d?.['sampleId']).toBe('B0001/x/S1');
    expect(d?.['label']).toEqual({ product: 'P', batch: 'B0001', sample: 'B0001/x/S1', sampler: 'OP1', takenAtUs: T0.toString() });
    run.perform('x', [], OP1, 'SAMPLE_TAKEN');
    // Location L2 was never sampled: a shortfall exception that the steps after it wait on (PR-29).
    expect(run.exceptions('SAMPLING_SHORTFALL')).toHaveLength(1);
    run.verify('x');
    run.refused({ type: 'START_STEP', actor: OP1, step: 'z' }, 'ENG-BLOCKED');
  });
});

describe('G-15 transfer', () => {
  it('[IN-15][PR-30] a transfer records issued-by and received-by, two different persons', () => {
    const run = Run.issue(define(one({ block: { type: 'G-15', version: '1' }, config: { transfer: true } })));
    run.start('x');
    run.entry('x', { kind: 'TRANSFER_ISSUED', material: 'Dried granules' });
    run.entry('x', { kind: 'TRANSFER_RECEIVED', material: 'Dried granules' });
    run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'x', signature: sig('PERFORMED', OP1) }, 'G15-TRANSFER');
    run.entry('x', { kind: 'TRANSFER_RECEIVED', material: 'Dried granules' }, [], OP2);
    run.perform('x', [], OP1);
    run.perform('x', [], OP2);
    expect(run.status('x')).toBe('AWAITING_VERIFICATION');
  });
});

describe('G-24 reprocessing and recovery gate', () => {
  const recovery = (): MbrContent => one({ block: { type: 'G-24', version: '1' }, reprocessing: { case: 'RECOVERY', maxPercent: '3', maxAge: { value: '90', unit: 'd' }, maxSourceBatches: 1 } });
  const auth = { investigationRef: 'INV-7', riskEvaluationRef: 'RA-9', authorisationRef: 'AUTH-3', authorisedBy: 'QA1' };
  const add = (e: Record<string, unknown>) => ({ kind: 'SOURCE_ADDITION', sourceBatch: 'B-OLD', productCode: 'P', quantity: { value: '0.010', unit: 'kg' }, manufacturedAtUs: String(T0 - 10n * 86_400_000_000n), ...e });

  it('[PR-47][IN-19] recovered material cannot be added without prior authorisation citing an investigation and a risk evaluation', () => {
    const run = Run.issue(define(recovery()));
    run.refused({ type: 'START_STEP', actor: OP1, step: 'x' }, 'G24-NOT-AUTHORISED');
    run.refused({ type: 'START_STEP', actor: OP1, step: 'x', blockData: { ...auth, authorisedBy: 'OP1' } }, 'G24-SELF-AUTHORISED');
    run.refused({ type: 'START_STEP', actor: OP1, step: 'x', blockData: { investigationRef: 'INV-7' } }, 'ENG-ENTRY-SCHEMA');
    run.start('x', [], OP1, auth);
  });

  it('[PR-47][IN-19][DI-33] only the same product, within the MBR age, percentage and source-batch limits; chained recovery is blocked; QC must decide on extra testing', () => {
    const run = Run.issue(define(recovery()));
    run.start('x', [], OP1, auth);
    const code = (e: Record<string, unknown>) => run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'x', entry: add(e) }).refusal?.code;
    expect(code({ productCode: 'OTHER' })).toBe('G24-OTHER-PRODUCT');
    expect(code({ containsRecovered: true })).toBe('G24-CHAINED');
    expect(code({ manufacturedAtUs: String(T0 - 91n * 86_400_000_000n) })).toBe('G24-TOO-OLD');
    expect(code({ quantity: { value: '0.031', unit: 'kg' } })).toBe('G24-TOO-MUCH');
    run.entry('x', add({}));
    expect(code({ sourceBatch: 'B-OTHER' })).toBe('G24-TOO-MANY-SOURCES');
    run.perform('x');
    expect(run.exceptions('QC_ADDITIONAL_TESTING_DECISION')).toHaveLength(1);
    expect(run.exceptions('QC_ADDITIONAL_TESTING_DECISION')[0]?.releaseBlocking).toBe(true);
    run.verify('x');
    expect(QA1.id).toBe('QA1');
  });

  it('[PR-47] a reprocessing step must declare its case', () => {
    expect(() => define(one({ block: { type: 'G-24', version: '1' } }))).toThrow(/G24-NO-CASE/);
  });
});
