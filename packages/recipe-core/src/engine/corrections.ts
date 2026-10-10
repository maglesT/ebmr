/**
 * The three paths for changing what was recorded (outline 5.2.3; R-18, L-08, L-09; DI-24, DI-29,
 * IN-20(c), INV-41) and what happens to values that were already acted on.
 *
 * (a) Entry-error correction of a manually entered value: the corrector signs CORRECTED with a reason,
 *     S25 approval for critical data, and joins the step's data-enterers (so cannot verify it).
 *     Device-captured values are never corrected, only invalidated. A failing value corrected to a
 *     passing one needs objective evidence and QA approval (that approval is the invalidation record).
 * (b) Void of an attempt: only before a result exists; reason, signer, QA approval when S28 is on.
 * (c) Invalidation of a result: only with a linked investigation that concluded an assignable cause,
 *     approved by QA; the original stays in the record.
 * In every path the exception a failing evaluation raised stays open until dispositioned.
 *
 * Dependents (classified like @ebmr/expr `classifyDependents`): derived results are recalculated with
 * the earlier record kept and signed dependents sent back for re-verification; decisions already taken
 * are re-evaluated but never re-routed (a changed outcome raises a decision-affecting-correction
 * exception only QA can disposition); executed targets are never silently recomputed (a new target
 * outside tolerance of what was executed raises an exception). A correction to a verified step sends
 * it back to AWAITING_VERIFICATION and invalidates the stage sign-off.
 */
import { assessTargetChange } from '@ebmr/expr';
import type { GraphNode } from '../flow/graph.ts';
import { evaluateCondition } from './advance.ts';
import { computeCalculations, evaluateValue, missingData, storePoint, validateValue } from './data.ts';
import { engineDraft } from './exceptions.ts';
import { addUnique, isBlankText, requireNotHandedOver, hasRole, MEANINGS, qualityUnitRoles, requireBatchStatus, requirePerson, requireReason, requireRole, requireSignature, requireStep, requireInstance, requireStepStatus, useSignature } from './guards.ts';
import { ctxKey, refuse, type Tx } from './tx.ts';
import type { CorrectEntryCommand, DataPoint, InvalidateResultCommand, StepInstance, VoidAttemptCommand } from './types.ts';
import { makeView } from './view.ts';
import { effectivePoint, resolveAt, showValue } from './values.ts';

const CHANGEABLE = ['IN_PROGRESS', 'ON_HOLD', 'EXECUTION_COMPLETE'] as const;

function requirePoint(tx: Tx, id: string): DataPoint {
  const p = tx.s.points[id];
  if (!p) refuse('ENG-UNKNOWN-POINT', `There is no data point ${id} in this batch`, ['DI-24']);
  return p;
}

/** A step being handed over (L-07) waits for the incoming performer before its data is changed. */
function requireNotBeingHandedOver(inst: StepInstance, action: string): void {
  if (inst.status === 'ATTEMPT_HANDED_OVER') refuse('ENG-STEP-STATUS', `Step ${inst.key} is being handed over: ${action} waits until the incoming performer has taken it over`, ['DI-34', 'DI-24']);
}

/** A step that was signed must be re-verified by an uninvolved person; its stage sign-off becomes invalid. */
function sendBackForReverification(tx: Tx, inst: StepInstance, reason: string): void {
  if (inst.status !== 'COMPLETED' && inst.status !== 'AWAITING_VERIFICATION') return;
  const checks = inst.signatures.filter((s) => s.valid && (s.role === 'CHECKED' || s.role === 'PERFORMED'));
  for (const s of checks) s.valid = false;
  if (checks.length > 0) tx.emit({ type: 'SIGNATURES_INVALIDATED', signatures: checks.map((s) => s.id), stepKey: inst.key, reason });
  const from = inst.status;
  inst.reverification = true;
  inst.status = 'AWAITING_VERIFICATION';
  if (from !== 'AWAITING_VERIFICATION') tx.emit({ type: 'STEP_STATUS_CHANGED', stepKey: inst.key, step: inst.step, from, to: 'AWAITING_VERIFICATION', by: 'SYSTEM', reason });
  invalidateStageSignOff(tx, inst, reason);
  reopenBatch(tx, reason);
}

function invalidateStageSignOff(tx: Tx, inst: StepInstance, reason: string): void {
  const stage = tx.def.steps.get(inst.step)?.stage;
  if (stage === undefined) return;
  for (const f of Object.values(tx.s.stages)) {
    if (f.stage !== stage || !f.signOff?.valid) continue;
    if (!f.frames.every((x) => inst.frames.some((y) => y.construct === x.construct && y.index === x.index))) continue;
    f.signOff.valid = false;
    f.invalidations.push({ at: tx.now, reason });
    tx.emit({ type: 'STAGE_SIGN_OFF_INVALIDATED', stageKey: f.key, reason });
  }
}

/** A correction after EXECUTION_COMPLETE returns the batch to IN_PROGRESS (outline 5.2.2). */
function reopenBatch(tx: Tx, reason: string): void {
  if (tx.s.status !== 'EXECUTION_COMPLETE') return;
  tx.s.status = 'IN_PROGRESS';
  tx.emit({ type: 'BATCH_STATUS_CHANGED', from: 'EXECUTION_COMPLETE', to: 'IN_PROGRESS', reason });
}

/**
 * Propagates a change of recorded values (by the ids of the superseded or invalidated points) to
 * derived values, decisions already taken and executed targets.
 */
export function propagate(tx: Tx, changedPoints: readonly string[], reason: string): void {
  const changed = new Set<string>(changedPoints);
  // 1. Derived results: recompute every calculation whose inputs changed, to a fixpoint; keep the old records.
  for (let pass = 0; pass < 64; pass++) {
    const affected = Object.values(tx.s.derived).filter((d) => d.status === 'CURRENT' && d.inputs.some((i) => i.points.some((p) => changed.has(p)) || i.derived.some((x) => changed.has(x))));
    if (affected.length === 0) break;
    const steps = [...new Set(affected.map((d) => d.stepKey))];
    let progressed = false;
    for (const key of steps) {
      const inst = tx.s.steps[key];
      const step = inst ? tx.def.steps.get(inst.step) : undefined;
      if (!inst || !step) continue;
      const before = affected.filter((d) => d.stepKey === key).map((d) => d.id);
      const created = computeCalculations(tx, step, inst, reason);
      for (const id of before) {
        if (tx.s.derived[id]?.status === 'SUPERSEDED') {
          changed.add(id);
          progressed = true;
        } else {
          // Inputs no longer available (e.g. an invalidated value without a re-test): the old result is withdrawn.
          const d = tx.s.derived[id];
          if (d && d.status === 'CURRENT' && !created.some((c) => tx.s.derived[c]?.calculation === d.calculation)) {
            const inputsGone = d.inputs.some((i) => i.points.some((p) => tx.s.points[p]?.status !== 'VALID'));
            if (inputsGone) {
              d.status = 'SUPERSEDED';
              changed.add(id);
              progressed = true;
              tx.raise(engineDraft('CALCULATION_FAILED', `${d.calculation} in ${key} no longer has valid inputs after the change (${reason}); it must be recomputed from a re-test`, { item: d.calculation, blocks: 'STEP_AND_DOWNSTREAM', until: 'DISPOSITION' }), { stepKey: key, step: inst.step, frames: inst.frames, item: d.calculation, derived: id }, { node: step.graphNode, frames: inst.frames });
            }
          }
        }
      }
      if (created.length > 0) sendBackForReverification(tx, inst, `a value this step computed was recalculated: ${reason}`);
    }
    if (!progressed) break;
  }
  // 2. Decisions already taken: re-evaluate, never re-route (L-09).
  for (const d of Object.values(tx.s.decisions)) {
    if (!d.inputs.points.some((p) => changed.has(p)) && !d.inputs.derived.some((x) => changed.has(x))) continue;
    let reader: GraphNode | undefined;
    let now: string | undefined;
    let problem: string | undefined;
    if (d.kind === 'BRANCH') {
      const alt = tx.def.alternatives.get(d.construct);
      if (!alt || alt.decision.mode !== 'DATA') continue;
      reader = tx.def.analysis.graphNodeOf(alt.id, 'XOR_SPLIT');
      const truthy: string[] = [];
      for (const b of alt.branches) {
        if (b.guard === undefined) continue;
        const r = evaluateCondition(tx, b.guard, alt.id, reader, d.frames);
        if (!r.ok) problem = r.reason;
        else if (r.value === true) truthy.push(b.id);
      }
      now = truthy.length === 1 ? truthy[0] : truthy.length === 0 ? alt.branches.find((b) => b.otherwise === true)?.id : undefined;
    } else if (d.kind === 'LOOP') {
      const loop = tx.def.loops.get(d.construct);
      if (!loop) continue;
      reader = tx.def.analysis.graphNodeOf(loop.id, 'LOOP_TEST');
      const r = evaluateCondition(tx, loop.exit.condition, loop.id, reader, d.frames);
      if (!r.ok) problem = r.reason;
      else {
        const exits = r.value === true;
        const took = d.outcome === 'EXIT';
        now = exits === took ? d.outcome : exits ? 'EXIT' : 'CONTINUE';
      }
    } else continue;
    if (now === d.outcome && problem === undefined) continue;
    tx.raise(
      engineDraft('DECISION_AFFECTING_CORRECTION', `After the change (${reason}) the decision at ${d.construct} would now be ${problem !== undefined ? `undecidable (${problem})` : (now ?? 'no single branch')} instead of ${d.outcome}; the executed path is not re-routed and only QA dispositions this`, {
        blocks: 'DOWNSTREAM',
        until: 'DISPOSITION',
        qaOnly: true,
        deviationRequired: true,
        releaseBlocking: true,
      }),
      { frames: [...d.frames], construct: d.construct },
      reader ? { node: reader.id, frames: d.frames } : undefined,
    );
  }
  // 3. Targets: executed ones are compared with the new target; others simply follow it.
  for (const inst of Object.values(tx.s.steps)) {
    const step = tx.def.steps.get(inst.step);
    if (!step || step.node.kind !== 'phase') continue;
    for (const [item, t] of Object.entries(inst.targets)) {
      if (!t.points.some((p) => changed.has(p)) && !t.derived.some((x) => changed.has(x))) continue;
      const r = resolveAt(tx.def, tx.s, item, inst.frames);
      if (!r.ok) continue;
      const previous = t.value;
      inst.targets[item] = { value: r.resolved.value, points: r.resolved.points, derived: r.resolved.derived };
      const handler = step.block?.handler;
      const executedItem = handler?.executedQuantityItem?.(step.node, tx.def.mbr);
      const executed = executedItem !== undefined ? effectivePoint(tx.s, inst.key, executedItem) : undefined;
      if (!executed?.value || executed.value.kind !== 'DECIMAL' || r.resolved.value.kind !== 'DECIMAL') continue;
      const tolerance = handler?.targetTolerance?.(step.node, step.config) ?? { percent: '0' };
      const assessed = assessTargetChange({ value: executed.value.value, unit: executed.value.unit }, { value: r.resolved.value.value, unit: r.resolved.value.unit }, tolerance);
      if (assessed.withinTolerance) continue;
      tx.raise(
        engineDraft('EXECUTED_TARGET_CHANGED', `The target ${item} of ${inst.key} changed from ${showValue(previous)} to ${showValue(r.resolved.value)} after ${executedItem ?? '?'} = ${showValue(executed.value)} was executed; the difference is outside tolerance`, {
          item,
          blocks: 'DOWNSTREAM',
          until: 'DISPOSITION',
          deviationRequired: true,
          releaseBlocking: true,
        }),
        { stepKey: inst.key, step: inst.step, frames: inst.frames, item },
        { node: step.graphNode, frames: inst.frames },
      );
    }
  }
}

/** Path (a): entry-error correction. */
export function correctEntry(tx: Tx, cmd: CorrectEntryCommand): void {
  requireBatchStatus(tx, CHANGEABLE, 'correcting data');
  const old = requirePoint(tx, cmd.point);
  if (old.kind !== 'VALUE' || old.status !== 'VALID') refuse('ENG-CORRECT-STATE', `Data point ${old.id} is ${old.kind === 'ABORTED' ? 'a voided attempt' : old.status.toLowerCase()} and cannot be corrected`, ['DI-24']);
  if (old.source.mode !== 'MANUAL') {
    refuse('ENG-CORRECT-DEVICE', `${old.item} was captured by ${old.source.mode.toLowerCase()} and can never be corrected, only invalidated with an investigation (path c)`, ['DI-24', 'DI-29', 'INV-41']);
  }
  const inst = tx.s.steps[old.stepKey];
  const step = tx.def.steps.get(old.step);
  const param = tx.def.analysis.parameters.get(old.item);
  if (!inst || !step || !param) refuse('ENG-UNKNOWN-POINT', `Data point ${old.id} has no step`, ['DI-24']);
  requireNotBeingHandedOver(inst, 'correcting its data');
  const a = requirePerson(tx);
  requireRole(a, [...step.performRoles, ...tx.def.policy.supervisorRoles, ...tx.def.policy.qaRoles], `correct data of ${step.id}`);
  const reason = requireReason(cmd.reason, 'A correction');
  const sig = requireSignature(tx, cmd.signature, a.id, [MEANINGS.CORRECTED], `Correction of ${old.item}`);
  validateValue(tx, param, cmd.value);
  const approval = cmd.approval;
  let approvedBy: string | undefined;
  if (approval) {
    if (approval.approver.kind !== 'PERSON' || approval.approver.id === a.id) refuse('ENG-SEGREGATION', 'A correction is approved by a different person than the corrector', ['DI-24', 'DI-17']);
    requireSignature(tx, approval.signature, approval.approver.id, [MEANINGS.CORRECTION_APPROVED], `Approval of the correction of ${old.item}`);
    approvedBy = approval.approver.id;
  }
  if (param.criticality === 'CRITICAL' && tx.def.policy.criticalCorrectionNeedsApproval) {
    if (!approval) refuse('ENG-CORRECT-APPROVAL', `${old.item} is critical data: its correction needs the approval of a supervisor or QA (S25)`, ['DI-24', 'DI-30']);
    requireRole(approval.approver, [...tx.def.policy.supervisorRoles, ...tx.def.policy.qaRoles], 'approve a correction of critical data');
  }
  if (old.failed && param.limits) {
    const ev = evaluateValue(tx, param.limits, cmd.value);
    const nowPasses = ev !== undefined && ev.breached === undefined;
    if (nowPasses) {
      if (!cmd.evidence) refuse('ENG-CORRECT-FAIL-TO-PASS', `${old.item} failed its limits; a correction that would make it pass needs objective evidence of the true value, otherwise only an invalidation with an investigation applies (path c)`, ['INV-41', 'DI-29', 'IN-20']);
      if (!approval || !hasRole(approval.approver, tx.def.policy.qaRoles)) refuse('ENG-CORRECT-FAIL-TO-PASS', `${old.item} failed its limits; making it pass needs QA approval of the correction`, ['INV-41', 'DI-29']);
    }
  }
  const point = storePoint(tx, step, inst, makeView(tx, step, inst), old.item, cmd.value, old.source, { correctionOf: old });
  point.correction = { reason, signature: sig.id, ...(cmd.evidence ? { evidence: cmd.evidence.sha256 } : {}), ...(approvedBy !== undefined ? { approvedBy } : {}) };
  old.status = 'SUPERSEDED';
  old.supersededBy = point.id;
  useSignature(tx, sig, `correction of ${old.id}`, inst.key);
  if (approval) useSignature(tx, approval.signature, `approval of the correction of ${old.id}`, inst.key);
  addUnique(inst.correctors, a.id);
  tx.emit({ type: 'DATA_CORRECTED', point: point.id, supersedes: old.id, by: a.id, reason });
  tx.emit({ type: 'INVOLVEMENT', stepKey: inst.key, person: a.id, involvement: 'CORRECTED' });
  tx.raise(engineDraft('POST_ENTRY_CORRECTION', `${old.item} in ${inst.key} was corrected from ${showValue(old.value ?? { kind: 'TEXT', value: '?' })} to ${showValue(cmd.value)}: ${reason}`, { item: old.item }), {
    stepKey: inst.key,
    step: inst.step,
    frames: inst.frames,
    point: point.id,
  });
  computeCalculations(tx, step, inst, `correction of ${old.item}: ${reason}`);
  propagate(tx, [old.id], `correction of ${old.item}: ${reason}`);
  sendBackForReverification(tx, inst, `${old.item} was corrected: ${reason}`);
}

/** Path (b): void of an attempt that has no result. */
export function voidAttempt(tx: Tx, cmd: VoidAttemptCommand): void {
  requireBatchStatus(tx, ['IN_PROGRESS', 'ON_HOLD'], 'voiding an attempt');
  if (cmd.point !== undefined) {
    const p = requirePoint(tx, cmd.point);
    if (p.kind === 'VALUE') refuse('ENG-VOID-RESULT', `${p.item} already has a result; once a result exists it cannot be voided: correct an entry error (path a) or invalidate it with an investigation (path c)`, ['DI-29', 'DI-24', 'INV-41']);
  }
  const step = requireStep(tx, cmd.step);
  if (step.node.kind !== 'phase' || (!step.node.records.includes(cmd.item) && !step.computedItems.has(cmd.item))) refuse('ENG-NOT-RECORDED-HERE', `Step ${step.id} does not capture ${cmd.item}`, ['DI-29']);
  const inst = requireInstance(tx, step, cmd.context ?? []);
  requireStepStatus(inst, ['IN_PROGRESS'], 'voiding an attempt');
  const a = requirePerson(tx);
  requireRole(a, step.performRoles, `void an attempt in ${step.id}`);
  requireNotHandedOver(inst, a.id, 'voiding an attempt');
  const reason = requireReason(cmd.reason, 'A void');
  let approvedBy: string | undefined;
  if (tx.def.policy.voidNeedsQaApproval || cmd.approval) {
    const ap = cmd.approval;
    if (!ap) refuse('ENG-VOID-APPROVAL', 'Each void needs QA approval (S28)', ['DI-29', 'DI-24']);
    if (ap.approver.kind !== 'PERSON' || ap.approver.id === a.id) refuse('ENG-SEGREGATION', 'A void is approved by a different person', ['DI-29']);
    requireRole(ap.approver, tx.def.policy.qaRoles, 'approve a void');
    requireSignature(tx, ap.signature, ap.approver.id, [MEANINGS.VOID_AUTHORISED], `Approval of a void in ${inst.key}`);
    useSignature(tx, ap.signature, `void in ${inst.key}`, inst.key);
    approvedBy = ap.approver.id;
  }
  const attempt = Object.values(tx.s.points).filter((p) => p.stepKey === inst.key && p.item === cmd.item).reduce((m, p) => Math.max(m, p.attempt), 0) + 1;
  const id = tx.nextId('DP');
  tx.s.points[id] = {
    id,
    item: cmd.item,
    stepKey: inst.key,
    step: inst.step,
    frames: [...inst.frames],
    attempt,
    version: 1,
    kind: 'ABORTED',
    source: { mode: 'MANUAL' },
    enteredBy: a.id,
    recordedAt: tx.now,
    recordedSeq: tx.s.seq + 1,
    timeBasis: 'RECORDED_AT',
    status: 'VALID',
    voidReason: reason,
    failed: false,
    flags: ['ABORTED'],
    exceptions: [],
  };
  addUnique(inst.dataEnterers, a.id);
  tx.emit({ type: 'ATTEMPT_VOIDED', point: id, stepKey: inst.key, item: cmd.item, by: a.id, reason });
  tx.emit({ type: 'INVOLVEMENT', stepKey: inst.key, person: a.id, involvement: 'VOIDED' });
  const ex = tx.raise(engineDraft('ABORTED_ATTEMPT', `Attempt ${attempt} of ${cmd.item} in ${inst.key} was voided before a result existed: ${reason}${approvedBy ? ` (approved by ${approvedBy})` : ''}`, { item: cmd.item }), { stepKey: inst.key, step: inst.step, frames: inst.frames, point: id });
  tx.s.points[id]?.exceptions.push(ex);
}

/** Path (c): invalidation of a result with an investigation, approved by QA. */
export function invalidateResult(tx: Tx, cmd: InvalidateResultCommand): void {
  requireBatchStatus(tx, CHANGEABLE, 'invalidating a result');
  const p = requirePoint(tx, cmd.point);
  if (p.kind !== 'VALUE' || p.status !== 'VALID') refuse('ENG-INVALIDATE-STATE', `Data point ${p.id} is not a valid result`, ['DI-29']);
  const inst = tx.s.steps[p.stepKey];
  const step = tx.def.steps.get(p.step);
  if (!inst || !step) refuse('ENG-UNKNOWN-POINT', `Data point ${p.id} has no step`, ['DI-29']);
  requireNotBeingHandedOver(inst, 'invalidating its result');
  const a = requirePerson(tx);
  const reason = requireReason(cmd.reason, 'An invalidation');
  if (typeof cmd.investigationRef !== 'string' || isBlankText(cmd.investigationRef)) {
    refuse('ENG-INVALIDATE-INVESTIGATION', 'A result is invalidated only with a linked OOS or deviation investigation that concluded an assignable cause', ['DI-29', 'IN-20', 'INV-41']);
  }
  if (typeof cmd.assignableCause !== 'string' || isBlankText(cmd.assignableCause)) {
    refuse('ENG-INVALIDATE-INVESTIGATION', `A result is invalidated only with the assignable cause its investigation ${cmd.investigationRef.trim()} concluded, recorded with the invalidation`, ['DI-29', 'IN-20', 'INV-41']);
  }
  const cause = cmd.assignableCause.trim();
  const ap = cmd.approval;
  if (ap.approver.kind !== 'PERSON' || ap.approver.id === a.id) refuse('ENG-SEGREGATION', 'An invalidation is approved by QA, a different person than the requester', ['DI-29', 'INV-41']);
  requireRole(ap.approver, qualityUnitRoles(tx.def.policy), 'approve an invalidation');
  const sig = requireSignature(tx, ap.signature, ap.approver.id, [MEANINGS.INVALIDATION_APPROVED], `Invalidation of ${p.item}`);
  useSignature(tx, sig, `invalidation of ${p.id}`, inst.key);
  p.status = 'INVALIDATED';
  p.invalidation = { investigationRef: cmd.investigationRef.trim(), assignableCause: cause, reason, approvedBy: ap.approver.id, signature: sig.id, at: tx.now };
  tx.emit({ type: 'RESULT_INVALIDATED', point: p.id, by: ap.approver.id, investigationRef: cmd.investigationRef.trim() });
  tx.raise(engineDraft('RESULT_INVALIDATED', `${p.item} attempt ${p.attempt} in ${inst.key} was invalidated with investigation ${cmd.investigationRef.trim()} (assignable cause: ${cause}): ${reason}; the original stays in the record`, { item: p.item }), {
    stepKey: inst.key,
    step: inst.step,
    frames: inst.frames,
    point: p.id,
  });
  computeCalculations(tx, step, inst, `invalidation of ${p.item}: ${reason}`);
  propagate(tx, [p.id], `invalidation of ${p.item} (${cmd.investigationRef.trim()})`);
  // A step left without a valid value is reopened for the re-test; otherwise it is re-verified.
  if (inst.status !== 'IN_PROGRESS' && missingData(tx, step, inst).length > 0) {
    const from = inst.status;
    const signed = inst.signatures.filter((s) => s.valid && (s.role === 'CHECKED' || s.role === 'PERFORMED'));
    for (const s of signed) s.valid = false;
    if (signed.length > 0) tx.emit({ type: 'SIGNATURES_INVALIDATED', signatures: signed.map((s) => s.id), stepKey: inst.key, reason: `result invalidated: ${reason}` });
    inst.performedSigners = [];
    inst.status = 'IN_PROGRESS';
    tx.emit({ type: 'STEP_STATUS_CHANGED', stepKey: inst.key, step: inst.step, from, to: 'IN_PROGRESS', by: 'SYSTEM', reason: `reopened for a re-test: ${reason}` });
    invalidateStageSignOff(tx, inst, `result invalidated: ${reason}`);
    reopenBatch(tx, `result invalidated: ${reason}`);
  } else sendBackForReverification(tx, inst, `result invalidated: ${reason}`);
}

export { ctxKey, requireStepStatus };
