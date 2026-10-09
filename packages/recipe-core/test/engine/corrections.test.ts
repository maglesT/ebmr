/**
 * Derived values and the three paths for changing what was recorded (INV-25, DI-24, DI-29, DI-33, INV-41;
 * outline 5.2.3 including dependents already acted on, L-09).
 */
import { describe, expect, it } from 'vitest';
import type { Actor } from '../../src/engine/types.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, done, HEAD1, OP1, param, QA1, QA2, Run, sig, SUP1, VER1, VER2 } from './support.ts';

const seq = (id: string, ...children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });
const kg = (value: string) => ({ kind: 'DECIMAL' as const, value, unit: 'kg' });
const manual = { mode: 'MANUAL' as const };

/** in (manual) -> out (device) -> yield calculation, then a data-decided branch on the yield. */
function yieldMbr(): MbrContent {
  return mbrWith(
    seq(
      'ops',
      phase('in', { records: ['charged'] }),
      phase('out', { records: ['good'] }),
      phase('y', { block: { type: 'G-20', version: '1' }, computes: ['yld'] }),
      { kind: 'alternative', id: 'alt', decision: { mode: 'DATA' }, branches: [{ id: 'low', name: 'Low', guard: 'yld < 95 [%]', body: phase('rework-check') }, { id: 'ok', name: 'OK', otherwise: true }] },
      phase('end'),
    ),
    {
      parameters: [param('charged', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON' }), param('good')],
      calculations: [{ id: 'yld', name: 'Yield', expression: 'yield(good, charged)', output: { valueType: 'DECIMAL', unit: '%', semanticTag: 'yield' }, criticality: 'CRITICAL', riskClass: 'HIGH' }],
    },
  );
}

function runYield(charged: string, good: string): Run {
  const run = Run.issue(define(yieldMbr()));
  run.start('in');
  run.record('in', 'charged', kg(charged), { source: manual });
  run.perform('in');
  run.verify('in');
  done(run, 'out', { good });
  done(run, 'y');
  return run;
}

describe('derived values are computed, never typed (INV-25)', () => {
  it('[INV-25][DI-33] typing a calculation, a block-computed quantity or a header value is refused', () => {
    const r2 = Run.issue(define(yieldMbr()));
    r2.start('in');
    const refusal = r2.refused({ type: 'RECORD_DATA', actor: OP1, step: 'in', item: 'yld', value: { kind: 'DECIMAL', value: '98', unit: '%' }, source: manual }, 'ENG-DERIVED-TYPED');
    expect(refusal.controls).toContain('INV-25');
    const g22 = Run.issue(define(mbrWith(phase('o', { block: { type: 'G-22', version: '1' }, records: ['net'], produces: ['I'] }), { parameters: [param('net')], intermediates: [{ id: 'I', name: 'I' }] })));
    g22.start('o');
    g22.refused({ type: 'RECORD_DATA', actor: OP1, step: 'o', item: 'net', value: kg('5.00'), source: { mode: 'DEVICE', device: 'B' } }, 'ENG-DERIVED-TYPED');
  });

  it('[INV-25][DI-33] a derived value carries its evaluation record: inputs with sources, formula version and the result', () => {
    const run = runYield('10.00', '9.80');
    const d = Object.values(run.state.derived)[0];
    expect(d?.value).toEqual({ kind: 'DECIMAL', value: '98', unit: '%' });
    expect(d?.record.inputs.map((i) => `${i.path}=${i.value ?? ''} ${i.unit ?? ''} from ${i.source}`)).toEqual(['charged=10 kg from in@ charged attempt 1 (manual entry)', 'good=9.8 kg from out@ good attempt 1 (device DEV-1)']);
    expect(d?.record.programHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d?.record.languageVersion.length).toBeGreaterThan(0);
  });
});

describe('path (a): entry-error correction (DI-24)', () => {
  it('[DI-24][DI-33][INV-03] a correction keeps the original, recalculates dependents keeping the old result, and sends signed steps back for re-verification', () => {
    const run = runYield('10.00', '9.80');
    const original = Object.values(run.state.points).find((p) => p.item === 'charged');
    const oldDerived = Object.values(run.state.derived)[0];
    run.refused({ type: 'CORRECT_ENTRY', actor: OP1, point: original?.id ?? '', value: kg('10.20'), reason: '', signature: sig('CORRECTED', OP1) }, 'ENG-REASON');
    run.refused({ type: 'CORRECT_ENTRY', actor: OP1, point: original?.id ?? '', value: kg('10.20'), reason: 'keying error', signature: sig('CORRECTED', OP1) }, 'ENG-CORRECT-APPROVAL');
    const corrector: Actor = { id: 'OV1', kind: 'PERSON', roles: ['OPERATOR', 'VERIFIER'] };
    run.ok({ type: 'CORRECT_ENTRY', actor: corrector, point: original?.id ?? '', value: kg('10.20'), reason: 'keying error: 10.20 on the printout', signature: sig('CORRECTED', corrector), approval: { approver: SUP1, signature: sig('CORRECTION_APPROVED', SUP1) } });
    const points = Object.values(run.state.points).filter((p) => p.item === 'charged');
    expect(points.map((p) => `${p.value?.kind === 'DECIMAL' ? p.value.value : ''}:${p.status}:v${p.version}`)).toEqual(['10.00:SUPERSEDED:v1', '10.20:VALID:v2']);
    const derived = Object.values(run.state.derived);
    expect(derived.map((d) => `${d.value.kind === 'DECIMAL' ? d.value.value : ''}:${d.status}`)).toEqual(['98:SUPERSEDED', '96.07843137254901960784313725490196:CURRENT']);
    expect(derived[1]?.record.supersedes?.contentHash).toBe(oldDerived?.record.contentHash);
    expect(run.status('in')).toBe('AWAITING_VERIFICATION');
    expect(run.status('y')).toBe('AWAITING_VERIFICATION');
    expect(run.exceptions('POST_ENTRY_CORRECTION')).toHaveLength(1);
    run.refused({ type: 'VERIFY', actor: corrector, step: 'in', signature: sig('RE_VERIFIED_AFTER_CORRECTION', corrector) }, 'ENG-SEGREGATION');
    run.verify('in', [], VER2, 'RE_VERIFIED_AFTER_CORRECTION');
    // The yield step was sent back too: it is re-verified, not verified again (engine 1.1.0: exactly the step's check).
    run.verify('y', [], VER2, 'RE_VERIFIED_AFTER_CORRECTION');
  });

  it('[DI-24][DI-29] a device-captured value can never be corrected, only invalidated', () => {
    const run = runYield('10.00', '9.80');
    const good = Object.values(run.state.points).find((p) => p.item === 'good');
    const r = run.refused({ type: 'CORRECT_ENTRY', actor: OP1, point: good?.id ?? '', value: kg('9.90'), reason: 'x', signature: sig('CORRECTED', OP1) }, 'ENG-CORRECT-DEVICE');
    expect(r.message).toMatch(/only invalidated/);
  });

  it('[INV-41][DI-29] a failing value corrected to a passing one needs objective evidence and QA approval', () => {
    const mbr = mbrWith(seq('ops', phase('m', { records: ['t'] }), phase('n')), {
      parameters: [param('t', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON', criticality: 'NON_CRITICAL', limits: { unit: 'kg', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: '1.00', inclusive: true }, high: { value: '2.00', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'V' } }] } })],
    });
    const run = Run.issue(define(mbr));
    run.start('m');
    run.record('m', 't', kg('2.50'), { source: manual });
    const p = Object.values(run.state.points)[0]?.id ?? '';
    run.refused({ type: 'CORRECT_ENTRY', actor: OP1, point: p, value: kg('1.50'), reason: 'typo', signature: sig('CORRECTED', OP1) }, 'ENG-CORRECT-FAIL-TO-PASS');
    run.refused({ type: 'CORRECT_ENTRY', actor: OP1, point: p, value: kg('1.50'), reason: 'typo', signature: sig('CORRECTED', OP1), evidence: { kind: 'PRINTOUT', sha256: 'b'.repeat(64) }, approval: { approver: SUP1, signature: sig('CORRECTION_APPROVED', SUP1) } }, 'ENG-CORRECT-FAIL-TO-PASS');
    run.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: p, value: kg('1.50'), reason: 'typo; printout shows 1.50', signature: sig('CORRECTED', OP1), evidence: { kind: 'PRINTOUT', sha256: 'b'.repeat(64) }, approval: { approver: QA1, signature: sig('CORRECTION_APPROVED', QA1) } });
    // The exception raised by the failing value is never closed by the correction (INV-41).
    expect(run.exceptions('LIMIT_BREACH')[0]?.status).toBe('OPEN');
  });

  it('[DI-34][INV-41] a correction that would change a decision already taken never re-routes the path; QA must disposition it', () => {
    const run = runYield('10.00', '9.80');
    expect(run.status('end')).toBe('ENABLED');
    const original = Object.values(run.state.points).find((p) => p.item === 'charged');
    run.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: original?.id ?? '', value: kg('11.00'), reason: 'keying error', signature: sig('CORRECTED', OP1), approval: { approver: SUP1, signature: sig('CORRECTION_APPROVED', SUP1) } });
    const ex = run.exceptions('DECISION_AFFECTING_CORRECTION');
    expect(ex).toHaveLength(1);
    expect(ex[0]?.qaOnly).toBe(true);
    expect(run.status('rework-check')).toBe('NOT_APPLICABLE');
    expect(run.status('end')).toBe('ENABLED');
    run.refused({ type: 'START_STEP', actor: OP1, step: 'end' }, 'ENG-BLOCKED');
  });
});

describe('executed targets (outline 5.2.3)', () => {
  it('[DI-33][PR-19] a corrected input that moves an already dispensed target outside tolerance raises an exception; the dispensed quantity is never recomputed', () => {
    const mbr = mbrWith(
      seq(
        'ops',
        phase('a', { records: ['assay'] }),
        phase('calc', { block: { type: 'G-14', version: '1' }, computes: ['target'] }),
        phase('disp', { block: { type: 'G-07', version: '1' }, config: { tolerance: { percent: '0.5' } }, reads: ['target'], records: ['dispensed'], consumes: ['BOM-API'] }),
        phase('z'),
      ),
      {
        parameters: [param('assay', { unit: '%', semanticTag: 'w/w', precision: { kind: 'DECIMALS', digits: 1 }, capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON' }), param('dispensed', { precision: { kind: 'DECIMALS', digits: 3 } })],
        calculations: [{ id: 'target', name: 'Target', expression: '8 [kg] * 100 [%] / assay', output: { valueType: 'DECIMAL', unit: 'kg' }, criticality: 'CRITICAL', riskClass: 'HIGH' }],
        bom: [{ id: 'BOM-API', material: 'MAT', role: 'ACTIVE', quantity: { value: '8', unit: 'kg' } }],
      },
    );
    const run = Run.issue(define(mbr));
    run.start('a');
    run.record('a', 'assay', { kind: 'DECIMAL', value: '100.0', unit: '%' }, { source: manual });
    run.perform('a');
    run.verify('a');
    done(run, 'calc');
    run.start('disp');
    run.entry('disp', { kind: 'CONTAINER_WEIGHING', item: 'dispensed', bomLine: 'BOM-API', container: 'C1', lot: { id: 'L1', material: 'MAT', status: 'RELEASED', identityTested: true }, gross: '9.000', tare: '1.000', unit: 'kg', balance: 'B', source: 'DEVICE' });
    run.perform('disp');
    run.verify('disp');
    const assay = Object.values(run.state.points).find((p) => p.item === 'assay');
    run.ok({ type: 'CORRECT_ENTRY', actor: OP1, point: assay?.id ?? '', value: { kind: 'DECIMAL', value: '98.0', unit: '%' }, reason: 'CoA shows 98.0', signature: sig('CORRECTED', OP1), approval: { approver: SUP1, signature: sig('CORRECTION_APPROVED', SUP1) } });
    expect(run.exceptions('EXECUTED_TARGET_CHANGED')).toHaveLength(1);
    // Weighed at 0.001 kg (gross 9.000, tare 1.000): the dispensed quantity keeps that resolution (engine 1.2.0).
    expect(run.value('dispensed', 'disp')).toBe('8.000');
  });
});

describe('paths (b) void and (c) invalidation; repeats (DI-29, INV-41)', () => {
  function ipc(): MbrContent {
    return mbrWith(
      seq('ops', phase('t', { block: { type: 'G-13', version: '1' }, records: ['h'] }), { kind: 'alternative', id: 'alt', decision: { mode: 'DATA' }, branches: [{ id: 'hi', name: 'High', guard: 'h > 100 [N]', body: phase('x') }, { id: 'lo', name: 'Low', otherwise: true }] }, phase('z')),
      { parameters: [param('h', { unit: 'N', precision: { kind: 'DECIMALS', digits: 0 }, role: 'IPC', limits: { unit: 'N', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: '60', inclusive: true }, high: { value: '120', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'V' } }] } })] },
    );
  }
  const n = (value: string) => ({ kind: 'DECIMAL' as const, value, unit: 'N' });

  it('[DI-29][INV-41] three readings where the first two fail: all kept and flagged; the first failing result governs until it is invalidated', () => {
    const run = Run.issue(define(ipc()));
    run.start('t');
    run.record('t', 'h', n('130'));
    run.record('t', 'h', n('125'));
    run.record('t', 'h', n('90'));
    const pts = Object.values(run.state.points);
    expect(pts.map((p) => `${p.attempt}:${p.failed}:${p.flags.join('+')}`)).toEqual(['1:true:', '2:true:REPEAT+REPEAT_AFTER_FAIL', '3:false:REPEAT+REPEAT_AFTER_FAIL']);
    expect(run.exceptions('REPEAT_AFTER_FAIL')).toHaveLength(2);
    expect(run.value('h', 't')).toBe('130');
  });

  it('[DI-29][IN-20] invalidating a result needs an investigation and QA approval; the original stays, the next attempt governs', () => {
    const run = Run.issue(define(ipc()));
    run.start('t');
    run.record('t', 'h', n('130'));
    run.record('t', 'h', n('90'));
    const first = Object.values(run.state.points)[0]?.id ?? '';
    run.refused({ type: 'INVALIDATE_RESULT', actor: OP1, point: first, investigationRef: '', reason: 'bad sample', approval: { approver: QA1, signature: sig('INVALIDATION_APPROVED', QA1) } }, 'ENG-INVALIDATE-INVESTIGATION');
    run.refused({ type: 'INVALIDATE_RESULT', actor: OP1, point: first, investigationRef: 'OOS-4', reason: 'bad sample', approval: { approver: SUP1, signature: sig('INVALIDATION_APPROVED', SUP1) } }, 'ENG-ROLE');
    run.ok({ type: 'INVALIDATE_RESULT', actor: OP1, point: first, investigationRef: 'OOS-4', reason: 'tester jaw misaligned (assignable cause)', approval: { approver: QA1, signature: sig('INVALIDATION_APPROVED', QA1) } });
    expect(run.state.points[first]?.status).toBe('INVALIDATED');
    expect(run.value('h', 't')).toBe('90');
    expect(run.exceptions('LIMIT_BREACH')[0]?.status).toBe('OPEN');
    expect(run.exceptions('RESULT_INVALIDATED')).toHaveLength(1);
  });

  it('[DI-29][DI-24] an attempt is voided only before a result exists, with a reason and QA approval; the attempt stays in the record', () => {
    const run = Run.issue(define(ipc()));
    run.start('t');
    run.refused({ type: 'VOID_ATTEMPT', actor: OP1, step: 't', item: 'h', reason: 'sample dropped' }, 'ENG-VOID-APPROVAL');
    run.ok({ type: 'VOID_ATTEMPT', actor: OP1, step: 't', item: 'h', reason: 'sample dropped before reading', approval: { approver: QA2, signature: sig('VOID_AUTHORISED', QA2) } });
    run.record('t', 'h', n('90'));
    const pts = Object.values(run.state.points);
    expect(pts.map((p) => `${p.attempt}:${p.kind}`)).toEqual(['1:ABORTED', '2:VALUE']);
    expect(run.exceptions('ABORTED_ATTEMPT')).toHaveLength(1);
    run.refused({ type: 'VOID_ATTEMPT', actor: OP1, step: 't', item: 'h', point: pts[1]?.id ?? '', reason: 'wrong', approval: { approver: QA2, signature: sig('VOID_AUTHORISED', QA2) } }, 'ENG-VOID-RESULT');
  });

  it('[DI-28][PR-11] a late entry records both times, needs a reason and is flagged; an event time before the step started is impossible', () => {
    const run = Run.issue(define(ipc()));
    run.start('t');
    run.minutes(10);
    run.refused({ type: 'RECORD_DATA', actor: OP1, step: 't', item: 'h', value: n('90'), source: manual, occurredAt: { us: run.nowUs - 5n * 60_000_000n, trust: 'USER_CLAIMED' } }, 'ENG-REASON');
    run.refused({ type: 'RECORD_DATA', actor: OP1, step: 't', item: 'h', value: n('90'), source: manual, occurredAt: { us: run.nowUs - 20n * 60_000_000n, trust: 'USER_CLAIMED' }, reason: 'network down' }, 'ENG-OCCURRED-AT');
    run.ok({ type: 'RECORD_DATA', actor: OP1, step: 't', item: 'h', value: n('90'), source: manual, occurredAt: { us: run.nowUs - 5n * 60_000_000n, trust: 'USER_CLAIMED' }, reason: 'terminal was down' });
    const p = Object.values(run.state.points)[0];
    expect(p?.flags).toContain('LATE_ENTRY');
    expect(p?.timeBasis).toBe('RECORDED_AT');
    expect(p?.occurredAt?.trust).toBe('USER_CLAIMED');
    expect(run.exceptions('LATE_ENTRY')).toHaveLength(1);
    expect(HEAD1.id).toBe('HEAD1');
    expect(VER1.id).toBe('VER1');
  });
});
