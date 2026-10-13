/**
 * The review routes and signed acts over HTTP (Phase 4 slice 1a; contract ns/review.ts; recipe-core 0710 to 0716): a GMP
 * batch record goes through production approval, the register, the audit-trail review, the QA review with its evidence
 * epoch and a reopen, each signed through the ceremony by the seed's personas; the database decides and a refusal signs
 * nothing. The CORRECT_ENTRY route on a GMP batch: the correction of critical data names the approval it needs.
 * The record's completion (EXECUTION_COMPLETE) is set by the test (the engine's completeness is proven elsewhere).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { execution } from '@ebmr/recipe-core';
import { sha256Hex } from '@ebmr/expr';
import { personaIn, pinOf, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import { RunDriver } from '../execution/support.ts';
import { gmpContent, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import type { TestBrowser } from '../support/harness.ts';
import { describeAction, signAction } from '../support/signed-acts.ts';

type Json = Record<string, unknown>;
let w: GmpBatchWorld;
let head: TestBrowser;
let qa: TestBrowser;
let qa2: TestBrowser;
let batchId: string;

beforeAll(async () => {
  w = await startGmpBatchWorld();
  const issuer = await w.gmp.asPersona('issuer');
  [head, qa, qa2] = await Promise.all([w.gmp.asPersona('head1'), w.gmp.asPersona('qaInvestigator'), w.gmp.asPersona('qaApprover2')]);
  batchId = await w.issued(issuer);
  await w.gmp.db.admin.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = $1", [batchId]);
}, 600_000);
afterAll(async () => {
  await w?.close();
});

const codeOf = (r: Awaited<ReturnType<typeof signAction>>): string => (r.ok ? 'ok' : (refusalOf(r)?.code ?? 'refused'));

describe('review over HTTP (outline 5.2.2, 5.4, 7.3)', () => {
  it('[INV-30][INV-35][INV-48] production approval, register, audit-trail review, QA review with its epoch and a reopen run through the signed ceremony; out-of-order and involved signers are refused', async () => {
    const queue = valueOf(await head.call(routes.review.queue, { query: {} }));
    expect(queue.batches.map((b) => b.batchId)).toContain(batchId);
    let view = valueOf(await head.call(routes.review.batch, { params: { batchId } }));
    expect(view).toMatchObject({ reviewState: 'EXECUTION_COMPLETE', cycle: 1, recordKind: 'PROCESSING', signable: { aggregateType: 'batch_review', aggregateId: batchId } });
    expect(view.gates.productionApprove).toEqual({ ready: true, problems: [] });
    expect(view.gates.qaReview.ready).toBe(false);

    // INV-30: the QA review before the production approval is refused, and signs nothing.
    expect(codeOf(await signAction(w.gmp, qa2, 'qaApprover2', { kind: 'REVIEW_ACT', act: 'QA_REVIEW', batchId, input: { expectedEpoch: view.epoch } }))).not.toBe('ok');
    const approve = { kind: 'REVIEW_ACT' as const, act: 'PRODUCTION_APPROVE' as const, batchId, input: {} };
    expect((await describeAction(head, approve)).meaning).toBe('PRODUCTION_APPROVED');
    expect(codeOf(await signAction(w.gmp, qa, 'qaInvestigator', approve))).not.toBe('ok');
    valueOf(await signAction(w.gmp, head, 'head1', approve));
    view = valueOf(await head.call(routes.review.batch, { params: { batchId } }));
    expect(view.reviewState).toBe('PRODUCTION_APPROVED');
    expect(view.acts.map((a) => [a.act, a.valid])).toEqual([['PRODUCTION_APPROVED', true]]);

    const register = valueOf(await qa.call(routes.review.register, { params: { batchId }, body: {} }));
    expect(register).toMatchObject({ batchId, noExceptions: true, items: [] });

    // The audit-trail report names the review the act signs; the production approver is involved (INV-35).
    const report = valueOf(await qa.call(routes.review.auditTrail, { params: { batchId }, query: {} }));
    expect(report).toMatchObject({ kind: 'FULL', covered: false, reviewId: `${batchId}/1`, fromMark: null });
    expect(report.scope.map((s) => s.chainKey)).toContain(`batch:${batchId}`);
    expect(report.eventCount).toBeGreaterThan(0);
    const at = { kind: 'REVIEW_ACT' as const, act: 'AUDIT_TRAIL_REVIEW' as const, batchId, input: { reviewId: report.reviewId } };
    expect(codeOf(await signAction(w.gmp, head, 'head1', at))).not.toBe('ok');
    expect(codeOf(await signAction(w.gmp, qa, 'qaInvestigator', { ...at, input: {} }))).not.toBe('ok');
    valueOf(await signAction(w.gmp, qa, 'qaInvestigator', at));
    expect(valueOf(await qa.call(routes.review.auditTrail, { params: { batchId }, query: {} })).covered).toBe(true);

    // The QA review names the epoch it evaluated: another one is refused, the current one is recorded.
    view = valueOf(await qa2.call(routes.review.batch, { params: { batchId } }));
    expect(view.gates.qaReview).toEqual({ ready: true, problems: [] });
    const qaReview = { kind: 'REVIEW_ACT' as const, act: 'QA_REVIEW' as const, batchId, input: { expectedEpoch: view.epoch } };
    expect(codeOf(await signAction(w.gmp, qa2, 'qaApprover2', { ...qaReview, input: {} }))).toBe('EBMR-API-ACT-INPUT');
    expect(codeOf(await signAction(w.gmp, qa2, 'qaApprover2', { ...qaReview, input: { expectedEpoch: String(BigInt(view.epoch) + 5n) } }))).toMatch(/EBMR-REV-021|refused/);
    expect(codeOf(await signAction(w.gmp, head, 'head1', qaReview))).not.toBe('ok');
    valueOf(await signAction(w.gmp, qa2, 'qaApprover2', qaReview));
    view = valueOf(await qa2.call(routes.review.batch, { params: { batchId } }));
    expect(view.reviewState).toBe('QA_REVIEWED');

    // A reopen names the cycle it reopens and the person's reason; the review signatures of the cycle no longer stand.
    const reopen = { kind: 'REVIEW_ACT' as const, act: 'REOPEN' as const, batchId, input: { cycle: 1, reason: { code: 'CORRECTION', text: 'A keying error is to be corrected' } } };
    expect(codeOf(await signAction(w.gmp, qa, 'qaInvestigator', { ...reopen, input: { cycle: 1 } }))).toBe('EBMR-API-ACT-INPUT');
    valueOf(await signAction(w.gmp, qa, 'qaInvestigator', reopen));
    view = valueOf(await qa.call(routes.review.batch, { params: { batchId } }));
    expect(view).toMatchObject({ reviewState: 'EXECUTION_COMPLETE', cycle: 2 });
    expect(view.acts.map((a) => [a.act, a.valid])).toEqual([
      ['PRODUCTION_APPROVED', false],
      ['AUDIT_TRAIL_REVIEWED', false],
      ['QA_REVIEWED', false],
      ['REOPENED', true],
    ]);
    // The signature of a reopen of cycle 1 is no reopen of cycle 2.
    expect(codeOf(await signAction(w.gmp, qa2, 'qaApprover2', reopen))).not.toBe('ok');
  }, 600_000);
});


/** dc-mini as a GMP master with a first step that records the blend time (CRITICAL, keyed by hand). */
function earlyBlendTime(m: Json): void {
  const body = (m['procedure'] as Json)['body'] as Json;
  const prep = ((((body['children'] as Json[])[0] as Json)['body'] as Json)['children'] as Json[])[0] as Json;
  const mix = (((((body['children'] as Json[])[1] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
  const p = (mix['children'] as Json[]).find((x) => x['id'] === 'p-blend') as Json;
  p['records'] = ['blenderSpeed'];
  const early = { ...p, id: 'p-early-time', name: 'Record the blend time', records: ['blendTime'], equipment: [], signatures: { ...(p['signatures'] as Json), check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } } };
  const prepBody = prep['body'] as Json;
  prepBody['children'] = [early, ...(prepBody['children'] as Json[])];
}

describe('the CORRECT_ENTRY route (outline 5.2.3 path (a); S25)', () => {
  it('[DI-24] a correction of critical data is a signed intent that names the approval it needs: without it nothing is signed; with another person\'s CORRECTION_APPROVAL it is recorded', async () => {
    const g = await startGmpBatchWorld(gmpContent(earlyBlendTime));
    try {
      const issuer = await g.gmp.asPersona('issuer');
      const runId = await g.issued(issuer);
      const browsers: Record<string, TestBrowser> = { issuer };
      for (const p of ['operator1', 'qa1']) browsers[p] = await g.gmp.asPersona(p);
      const d = new RunDriver(g.gmp, runId, browsers);
      await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-early-time@' });
      await d.ok('operator1', { type: 'RECORD_DATA', stepKey: 'p-early-time@', item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } });
      const st = await execution.loadState(g.gmp.db.admin, runId);
      const point = Object.values(st?.state.points ?? {}).find((x) => x.item === 'blendTime' && x.status === 'VALID')?.id ?? '';
      const correct = { type: 'CORRECT_ENTRY' as const, point, value: { kind: 'DECIMAL' as const, value: '16', unit: 'min' }, reason: 'Keyed 15 for 16 from the timer display' };
      const unapproved = await d.sign('operator1', correct);
      expect(unapproved.result.ok).toBe(false);
      expect(refusalOf(unapproved.result)?.code).toMatch(/^ENG-/);
      // Shop-floor QA approves it at its kiosk (a badge tap on the challenge, the PIN to sign).
      const qa1 = browsers['qa1'] as TestBrowser;
      const action = { kind: 'CORRECTION_APPROVAL' as const, batchId: runId, point };
      const preview = valueOf(await qa1.call(routes.esig.content, { query: { aggregateType: 'batch_point', aggregateId: `${runId}:${point}`, intent: 'CORRECTION_APPROVED' } }));
      const body = { aggregateType: 'batch_point', aggregateId: `${runId}:${point}`, contentVersion: preview.contentVersion, meaning: 'CORRECTION_APPROVED', clientContentHash: sha256Hex(preview.canonicalText), action };
      const challenge = valueOf(await qa1.call(routes.esig.createChallenge, { body, attribution: await tapFor(qa1, personaIn(g.gmp, 'qa1'), 'POST', '/api/esig/challenges', body) }));
      const signBody = { challengeId: challenge.challengeId, credentials: pinOf(g.gmp, 'qa1'), action };
      const approvalId = valueOf(await qa1.call(routes.esig.sign, { body: { ...signBody, proof: await qa1.proof('POST', '/api/esig/sign', signBody) } })).manifestation.signatureId;
      valueOf((await d.sign('operator1', { ...correct, approvalSignatureId: approvalId })).result);
      const after = await execution.loadState(g.gmp.db.admin, runId);
      expect(Object.values(after?.state.points ?? {}).find((x) => x.item === 'blendTime' && x.status === 'VALID')?.value).toMatchObject({ value: '16' });
    } finally {
      await g.close();
    }
  }, 600_000);

  it('[DI-25][DI-24][DI-07] a value changed after entry, on a field classed non-critical, shows with its original in the checker\'s step view, in the exception register with both values and the reason, and in the audit-trail review list', async () => {
    // The blend time classed non-critical under a declared risk-based reduction: its correction needs no approval (S25),
    // never less than the reason, the CORRECTED signature, the audit trail and the review.
    const informational = (m: Json): void => {
      earlyBlendTime(m);
      for (const p of m['parameters'] as Json[]) if (p['id'] === 'blendTime') p['criticality'] = 'NON_CRITICAL';
      (m['references'] as Json[]).push({ id: 'RA-BLEND-TIME', kind: 'RISK_ASSESSMENT', code: 'RA-BLEND-TIME', version: '1', hash: 'a'.repeat(64), title: 'Risk assessment: blend time informational' });
      m['riskReductions'] = [...((m['riskReductions'] as Json[] | undefined) ?? []), { id: 'RR-BLEND-TIME', kind: 'MINOR_CLASSIFICATION', subjects: ['blendTime'], riskClass: 'LOW', rationale: 'RA-BLEND-TIME' }];
    };
    const g = await startGmpBatchWorld(gmpContent(informational));
    try {
      const issuer = await g.gmp.asPersona('issuer');
      const runId = await g.issued(issuer);
      const browsers: Record<string, TestBrowser> = { issuer };
      for (const p of ['operator1', 'verifier1', 'qaInvestigator']) browsers[p] = await g.gmp.asPersona(p);
      const d = new RunDriver(g.gmp, runId, browsers);
      await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-early-time@' });
      await d.ok('operator1', { type: 'RECORD_DATA', stepKey: 'p-early-time@', item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } });
      await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-early-time@' });
      const st = await execution.loadState(g.gmp.db.admin, runId);
      const point = Object.values(st?.state.points ?? {}).find((x) => x.item === 'blendTime' && x.status === 'VALID')?.id ?? '';
      const reasonText = 'Keyed 15 for 16 from the timer display';
      const correct = { type: 'CORRECT_ENTRY' as const, point, value: { kind: 'DECIMAL' as const, value: '16', unit: 'min' }, reason: reasonText };
      const corrected = await d.sign('operator1', correct);
      const correctionSig = valueOf(corrected.result).manifestation.signatureId;

      // The checker's step view: the original attempt beside the corrected one, flagged CORRECTED, both by the operator.
      const view = await d.stepView('verifier1', 'p-early-time@');
      const field = view.fields.find((f) => f.item === 'blendTime');
      expect(field?.attempts.map((a) => [a.value?.kind === 'DECIMAL' ? a.value.value : null, a.status, a.by.personId])).toEqual([
        ['15', 'SUPERSEDED', personaIn(g.gmp, 'operator1').personId],
        ['16', 'VALID', personaIn(g.gmp, 'operator1').personId],
      ]);
      expect(field?.attempts.map((a) => a.flags)).toEqual([[], ['CORRECTED']]);
      // The step's own signature no longer stands: the checker sees it waiting for its signatures again.
      expect(view.step.status).toBe('AWAITING_VERIFICATION');
      expect(view.signatures.map((x) => [x.meaning, x.valid])).toEqual([['PERFORMED', false]]);

      // The review list: the exception register names the change with the original, the new value and the reason.
      // The record's completion is set by the test as a fixture (triggers off: the engine's completeness is proven elsewhere).
      const c = await g.gmp.db.admin.connect();
      try {
        await c.query('begin');
        await c.query("set local session_replication_role = 'replica'");
        await c.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = $1", [runId]);
        await c.query('commit');
      } finally {
        c.release();
      }
      const qaB = browsers['qaInvestigator'] as TestBrowser;
      const register = valueOf(await qaB.call(routes.review.register, { params: { batchId: runId }, body: {} }));
      expect(register.noExceptions).toBe(false);
      const item = register.items.find((i) => i.type === 'POST_ENTRY_CORRECTION');
      expect(item).toMatchObject({ stepKey: 'p-early-time@', reviewStatus: 'OPEN' });
      expect(item?.title).toMatch(new RegExp(`blendTime in p-early-time@ was corrected from 15 min to 16 min: ${reasonText}`));

      // The audit-trail review list holds the event of the accepted correction command, the one its CORRECTED signature recorded.
      const report = valueOf(await qaB.call(routes.review.auditTrail, { params: { batchId: runId }, query: {} }));
      const { rows: audited } = await g.gmp.db.admin.query<{ id: string }>(
        `select e.id::text from kernel.audit_event e
          where e.chain_key = $1 and e.action = 'BUSINESS' and e.payload #>> '{body,details,command_id}' = $2 and (e.payload #>> '{body,details,accepted}')::boolean`,
        [`batch:${runId}`, `ESIG:${correctionSig}`],
      );
      expect(audited).toHaveLength(1);
      expect(report.truncated).toBe(false);
      expect(report.events.filter((e) => e.eventId === audited[0]?.id).map((e) => [e.chainKey, e.action])).toEqual([[`batch:${runId}`, 'BUSINESS']]);
    } finally {
      await g.close();
    }
  }, 600_000);
});

describe('an out-of-limit value is committed before its warning (DI-28)', () => {
  it('[DI-28] an out-of-limit value is in the audit trail as committed before the limit warning: the command that stored it is audited first in the commit, the warning is raised by that stored row, and the answer shows it with the committed value', async () => {
    const g = await startGmpBatchWorld(gmpContent(earlyBlendTime));
    try {
      const issuer = await g.gmp.asPersona('issuer');
      const runId = await g.issued(issuer);
      const d = new RunDriver(g.gmp, runId, { issuer, operator1: await g.gmp.asPersona('operator1') });
      await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-early-time@' });
      // 19 min: inside the registered 10-20 min, outside the internal action limits 12-18 min.
      const answer = await d.ok('operator1', { type: 'RECORD_DATA', stepKey: 'p-early-time@', item: 'blendTime', value: { kind: 'DECIMAL', value: '19', unit: 'min' }, source: { mode: 'MANUAL' } });
      // The warning the operator sees is the committed record's, returned with the answer.
      const attempt = answer.step?.fields.find((f) => f.item === 'blendTime')?.attempts.at(-1);
      expect(attempt).toMatchObject({ value: { kind: 'DECIMAL', value: '19', unit: 'min' }, status: 'VALID' });
      expect(attempt?.verdict?.tier).toBe('INTERNAL_ACTION');
      const { rows: cmds } = await g.gmp.db.admin.query<{ seq: string; command_id: string }>(
        "select seq::text, command_id from recipe.execution_command where batch_id = $1 and command_type = 'RECORD_DATA' and accepted",
        [runId],
      );
      expect(cmds).toHaveLength(1);
      const { rows: warnings } = await g.gmp.db.admin.query<{ row_seq: string; tier: string; raised_at: Date }>(
        'select row_seq::text, tier, raised_at from recipe.exception_register where batch_id = $1',
        [runId],
      );
      // The warning is raised by the row that stored the value, never before it.
      expect(warnings.map((x) => [x.row_seq, x.tier])).toEqual([[cmds[0]?.seq, 'INTERNAL_ACTION']]);
      // The audit trail of that commit (one transaction, one correlation): the stored command, with its value, is audited
      // before the register row of the warning.
      const { rows: events } = await g.gmp.db.admin.query<{ seq: string; kind: string; recorded_at: Date }>(
        `select e.seq::text, case when e.table_name = 'recipe.exception_register' then 'WARNING' else 'VALUE' end as kind, e.recorded_at
           from kernel.audit_event e
          where e.chain_key = $1 and e.action = 'INSERT' and e.table_name in ('recipe.execution_command', 'recipe.exception_register')
            and e.correlation_id = (select b.correlation_id from kernel.audit_event b where b.chain_key = $1 and b.action = 'BUSINESS' and b.payload #>> '{body,details,command_id}' = $2)
          order by e.seq`,
        [`batch:${runId}`, cmds[0]?.command_id],
      );
      expect(events.map((e) => e.kind)).toEqual(['VALUE', 'WARNING']);
      expect(Number(events[0]?.seq)).toBeLessThan(Number(events[1]?.seq));
      expect(events[0]!.recorded_at.getTime()).toBeLessThanOrEqual(events[1]!.recorded_at.getTime());
    } finally {
      await g.close();
    }
  }, 600_000);
});
