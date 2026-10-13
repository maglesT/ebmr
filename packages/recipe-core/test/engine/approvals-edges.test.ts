/**
 * The approvals of an abort (DI-34, PR-13) and the aggregates the approval signatures sign (DI-37, INV-09) at their
 * edges: the head of production and QA as two persons, never a system, never the one who records it, a person holding
 * both roles approving only once; each approval and the cancellation bound to the act or the record it approves.
 * Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { MbrContent } from '../../src/flow/model.ts';
import { approvedAct, approvedActKey, BATCH_ACT_AGGREGATE, BATCH_RECORD_AGGREGATE, batchRecordKey, signatureSubjects } from '../../src/engine/signing-content.ts';
import type { Actor, BatchState, Command } from '../../src/engine/types.ts';
import { mbrWith, phase } from '../flow/support.ts';
import { define, HEAD1, QA1, Run, sig, SUP1 } from './support.ts';

const person = (id: string, roles: string[]): Actor => ({ id, kind: 'PERSON', roles });
const CHECKLIST = { outputsHeld: true, equipmentSetDirty: true, materialsSecured: true };
const mbr = (): MbrContent => mbrWith({ kind: 'sequence', id: 'ops', children: [phase('p1'), phase('p2')] });
const approval = (a: Actor) => ({ approver: a, signature: sig('BATCH_ABORT_APPROVED', a) });
const abort = (approvals: Actor[], actor: Actor = SUP1) => ({ type: 'ABORT_BATCH' as const, actor, reason: 'contamination', checklist: CHECKLIST, approvals: approvals.map(approval) });

describe('abort approvals', () => {
  it('[DI-34][PR-13][IN-04] the head of production and QA, two persons, neither the recorder, never a system; one holding both roles counts once', () => {
    const started = (): Run => {
      const run = Run.issue(define(mbr()));
      run.start('p1');
      return run;
    };
    const BOTH = person('BOTH1', ['HEAD_OF_PRODUCTION', 'QA']);
    const QA_B = person('QA9', ['QA']);
    const SYS_QA: Actor = { id: 'SYS-QA', kind: 'SYSTEM', roles: ['QA'] };
    const SYS_HEAD: Actor = { id: 'SYS-HEAD', kind: 'SYSTEM', roles: ['HEAD_OF_PRODUCTION'] };
    for (const approvers of [[QA1, QA_B], [HEAD1, SUP1], [BOTH, BOTH], [HEAD1, SYS_QA], [SYS_HEAD, QA1], [HEAD1]]) {
      started().refused(abort(approvers), 'ENG-ABORT-APPROVALS');
    }
    started().refused(abort([HEAD1, QA1], HEAD1), 'ENG-ABORT-APPROVALS');
    started().refused(abort([HEAD1, QA1], QA1), 'ENG-ABORT-APPROVALS');
    const both = started();
    both.ok(abort([BOTH, QA1]));
    expect(both.state.abort?.approvals).toEqual(['BOTH1', 'QA1']);
    const reversed = started();
    reversed.ok(abort([QA1, BOTH]));
    expect(reversed.state.abort?.approvals).toEqual(['BOTH1', 'QA1']);
  });
});

describe('what an approval signs', () => {
  const S = { version: 7, points: { PT1: {} } } as unknown as BatchState;
  const fs = (meaning: string, a: Actor) => ({ id: `SIG-${meaning}-${a.id}`, meaning, signer: a.id });
  const ap = (a: Actor, meaning = 'APPROVED') => ({ approver: a, signature: fs(meaning, a) });

  it('[DI-37][INV-09] the approved act is the command without its id, actor, signatures and version, with its requester; its key binds the state version and the act', () => {
    const skip = { type: 'REQUEST_SKIP', commandId: 'c1', actor: SUP1, expectedVersion: 7, step: 'p2', reason: 'not needed', approval: ap(QA1) } as unknown as Command;
    expect(approvedAct(skip)).toEqual({ type: 'REQUEST_SKIP', step: 'p2', reason: 'not needed', requestedBy: 'SUP1' });
    const many = { type: 'ABORT_BATCH', actor: HEAD1, reason: 'r', signature: fs('X', HEAD1), approvals: [ap(QA1)] } as unknown as Command;
    expect(approvedAct(many)).toEqual({ type: 'ABORT_BATCH', reason: 'r', requestedBy: 'HEAD1' });
    const key = approvedActKey(S, skip);
    expect(key).toMatch(/^act@7:[0-9a-f]{16,}$/);
    expect(approvedActKey(S, { ...skip, approval: ap(HEAD1), commandId: 'c2' } as Command)).toBe(key);
    expect(approvedActKey(S, { ...skip, step: 'p1' } as Command)).not.toBe(key);
    expect(approvedActKey(S, { ...skip, actor: HEAD1 })).not.toBe(key);
    expect(approvedActKey({ version: 8 }, skip)).not.toBe(key);
    expect(batchRecordKey(S)).toBe('record@7');
    expect([BATCH_ACT_AGGREGATE, BATCH_RECORD_AGGREGATE]).toEqual(['batch_act', 'batch_record']);
  });

  it('[DI-37][INV-09] skip, void, invalidation, abort and hand-over approvals sign the act; a cancellation signs the record; a correction signs its point', () => {
    const subjects = (cmd: Record<string, unknown>) => signatureSubjects(S, cmd as unknown as Command).map((x) => `${x.signatureId}|${x.meaning}|${x.signer}|${x.type}|${x.key}`);
    const act = (cmd: Record<string, unknown>) => approvedActKey(S, cmd as unknown as Command);
    const id = (a: Actor, meaning = 'APPROVED') => fs(meaning, a).id;
    const skip = { type: 'REQUEST_SKIP', actor: SUP1, step: 'p2', reason: 'x', approval: ap(QA1) };
    expect(subjects(skip)).toEqual([`${id(QA1)}|APPROVED|QA1|batch_act|${act(skip)}`]);
    const voided = { type: 'VOID_ATTEMPT', actor: SUP1, step: 'p2', reason: 'x', approval: ap(QA1) };
    expect(subjects(voided)).toEqual([`${id(QA1)}|APPROVED|QA1|batch_act|${act(voided)}`]);
    expect(subjects({ type: 'VOID_ATTEMPT', actor: SUP1, step: 'p2', reason: 'x' })).toEqual([]);
    const inval = { type: 'INVALIDATE_RESULT', actor: SUP1, point: 'PT1', reason: 'x', approval: ap(QA1) };
    expect(subjects(inval)).toEqual([`${id(QA1)}|APPROVED|QA1|batch_act|${act(inval)}`]);
    const ab = { type: 'ABORT_BATCH', actor: SUP1, reason: 'x', approvals: [ap(HEAD1), ap(QA1)] };
    expect(subjects(ab)).toEqual([`${id(HEAD1)}|APPROVED|HEAD1|batch_act|${act(ab)}`, `${id(QA1)}|APPROVED|QA1|batch_act|${act(ab)}`]);
    const cancel = { type: 'CANCEL_BATCH', actor: SUP1, reason: 'x', signature: fs('BATCH_CANCELLED', SUP1) };
    expect(subjects(cancel)).toEqual([`${fs('BATCH_CANCELLED', SUP1).id}|BATCH_CANCELLED|SUP1|batch_record|record@7`]);
    const hand = { type: 'HAND_OVER_STEP', actor: SUP1, step: 'p1', incoming: 'OP2', reason: 'x', signature: fs('HANDOVER_APPROVED', SUP1), approval: ap(QA1, 'HANDOVER_APPROVED') };
    expect(subjects(hand)).toEqual([`${fs('HANDOVER_APPROVED', SUP1).id}|HANDOVER_APPROVED|SUP1|batch_act|${act(hand)}`, `${id(QA1, 'HANDOVER_APPROVED')}|HANDOVER_APPROVED|QA1|batch_act|${act(hand)}`]);
    const fix = { type: 'CORRECT_ENTRY', actor: SUP1, point: 'PT1', signature: fs('CORRECTED', SUP1) };
    expect(subjects(fix)).toEqual([`${fs('CORRECTED', SUP1).id}|CORRECTED|SUP1|batch_point|PT1`]);
    expect(subjects({ ...fix, approval: ap(QA1) })).toEqual([`${fs('CORRECTED', SUP1).id}|CORRECTED|SUP1|batch_point|PT1`, `${id(QA1)}|APPROVED|QA1|batch_point|PT1`]);
    expect(subjects({ ...fix, point: 'PT9' })).toEqual([]);
  });
});
