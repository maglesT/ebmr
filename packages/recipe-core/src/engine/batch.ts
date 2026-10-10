/**
 * Batch-level commands (outline 5.2.2, 5.2.4; G-01 issuance and header, G-18 exception and deviation
 * link): issue, hold and release, abort, cancel, and the exception commands.
 */
import { isDecimalLiteral } from '../flow/decimal.ts';
import type { Frame } from '../flow/tokens.ts';
import type { BatchDefinition } from './definition.ts';
import { engineDraft } from './exceptions.ts';
import { excludedFromReview, hasRole, MEANINGS, requireNotHandedOver, qualityUnitRoles, requireBatchStatus, requirePerson, requireReason, requireRole, requireSignature, useSignature } from './guards.ts';
import { refuse, stepKey, type Tx } from './tx.ts';
import {
  ABORT_CHECKLIST_ITEMS,
  ENGINE_VERSION,
  STATE_SCHEMA,
  type AbortBatchCommand,
  type AttachDeviationCommand,
  type BatchState,
  type CancelBatchCommand,
  type DispositionExceptionCommand,
  type HoldBatchCommand,
  type IssueRequest,
  type RaiseExceptionCommand,
  type ReleaseHoldCommand,
} from './types.ts';

/** The empty state an issued batch starts from (before the first advance). Refuses an invalid header (G-01). */
export function initialState(def: BatchDefinition, req: IssueRequest, nowUs: bigint): BatchState {
  const mbr = def.mbr;
  const size = mbr.header.batchSizes.find((b) => b.id === req.batchSize);
  if (!size) refuse('ENG-ISSUE-SIZE', `Batch size ${req.batchSize} is not one of the approved sizes of this MBR (${mbr.header.batchSizes.map((b) => b.id).join(', ')}); there is no free scaling`, ['PR-01', 'IN-13']);
  if (typeof req.batchNumber !== 'string' || req.batchNumber.trim().length === 0) refuse('ENG-ISSUE-NUMBER', 'A batch needs a batch number from the allocation register', ['PR-10', 'IN-18']);
  const markets = [...new Set(req.marketSet)];
  if (!markets.includes('IN')) refuse('ENG-ISSUE-MARKETS', 'India is in every market set (Revised Schedule M always applies)', ['IN-52', 'INV-28']);
  const outside = markets.filter((m) => !mbr.header.marketSet.includes(m));
  if (outside.length > 0) refuse('ENG-ISSUE-MARKETS', `The MBR is not approved for ${outside.join(', ')}`, ['IN-52', 'PR-04']);
  if (req.issuedBy.kind !== 'PERSON') refuse('ENG-ACTOR', 'A batch is issued by a person', ['PR-10']);
  const variants: Record<string, string> = {};
  for (const v of mbr.header.variants) {
    const value = req.variants?.[v.id];
    if (value === undefined || !v.values.includes(value)) refuse('ENG-ISSUE-VARIANT', `Variant ${v.id} needs one of ${v.values.join(', ')} at issue`, ['DI-34', 'PR-01']);
    variants[v.id] = value;
  }
  for (const key of Object.keys(req.variants ?? {})) if (!mbr.header.variants.some((v) => v.id === key)) refuse('ENG-ISSUE-VARIANT', `${key} is not a variant of this MBR`, ['DI-34']);
  const inputs: BatchState['header']['inputs'] = {};
  for (const i of mbr.inputs) {
    const given = req.inputs[i.id];
    if (!given) refuse('ENG-ISSUE-INPUT', `${i.name} (${i.id}) must be given at issue from the ${i.source === 'BATCH_HEADER' ? 'batch header' : 'master data'}`, ['PR-10', 'DI-10']);
    if (typeof given.source !== 'string' || given.source.trim().length === 0) refuse('ENG-ISSUE-INPUT', `${i.id} needs its source`, ['DI-10']);
    const v = given.value;
    const ok =
      (i.valueType === 'DECIMAL' && v.kind === 'DECIMAL' && isDecimalLiteral(v.value) && (i.unit === undefined || v.unit === i.unit || def.expr.convert('1', v.unit, i.unit) !== undefined)) ||
      (i.valueType === 'COUNT' && v.kind === 'COUNT' && /^(0|[1-9][0-9]*)$/.test(v.value)) ||
      (i.valueType === 'BOOLEAN' && v.kind === 'BOOLEAN') ||
      (i.valueType === 'CATEGORY' && v.kind === 'CATEGORY' && (i.categories ?? []).includes(v.value)) ||
      (i.valueType === 'TEXT' && v.kind === 'TEXT') ||
      (i.valueType === 'INSTANT' && v.kind === 'INSTANT');
    if (!ok) refuse('ENG-ISSUE-INPUT', `${i.id} does not have the declared type ${i.valueType}${i.unit ? ` in ${i.unit}` : ''}`, ['DI-30', 'DI-10']);
    inputs[i.id] = { value: v, source: given.source };
  }
  for (const key of Object.keys(req.inputs)) if (!mbr.inputs.some((i) => i.id === key)) refuse('ENG-ISSUE-INPUT', `${key} is not a header or master-data input of this MBR`, ['DI-10']);
  const header: BatchState['header'] = {
    batchId: req.batchId,
    batchNumber: req.batchNumber.trim(),
    batchSize: size.id,
    marketSet: markets.sort(),
    purpose: req.purpose ?? 'COMMERCIAL',
    variants,
    inputs,
    issuedBy: req.issuedBy.id,
    issuedAt: nowUs,
  };
  if (req.issueSignature) header.issueSignature = req.issueSignature.id;
  return {
    schema: STATE_SCHEMA,
    engineVersion: ENGINE_VERSION,
    mbrHash: def.contentHash,
    header,
    status: 'ISSUED',
    version: 0,
    seq: 0,
    lastRecordedUs: nowUs,
    marking: def.game.initial(),
    steps: {},
    decisions: {},
    points: {},
    derived: {},
    entries: {},
    containers: {},
    exceptions: {},
    holds: {},
    stages: {},
    subLots: {},
    nodeEvents: {},
    timeInstances: {},
    pendingDecisionProblems: {},
    appliedCommands: [],
    usedSignatures: req.issueSignature ? { [req.issueSignature.id]: 'batch issued' } : {},
    counters: {},
  };
}

export function holdBatch(tx: Tx, cmd: HoldBatchCommand): void {
  requireBatchStatus(tx, ['ISSUED', 'IN_PROGRESS', 'ON_HOLD'], 'placing a hold');
  const a = requirePerson(tx);
  requireRole(a, cmd.holdType === 'QA' ? tx.def.policy.qaRoles : [...tx.def.policy.supervisorRoles, ...tx.def.policy.qaRoles], `place a ${cmd.holdType.toLowerCase()} hold`);
  const reason = requireReason(cmd.reason, 'A hold');
  const id = tx.nextId('HOLD');
  tx.s.holds[id] = { id, type: cmd.holdType, reason, placedBy: a.id, at: tx.now, automatic: false };
  tx.emit({ type: 'HOLD_PLACED', hold: id, holdType: cmd.holdType, automatic: false, reason });
  if (tx.s.status !== 'ON_HOLD') {
    const from = tx.s.status as 'ISSUED' | 'IN_PROGRESS';
    tx.s.statusBeforeHold = from;
    tx.s.status = 'ON_HOLD';
    tx.emit({ type: 'BATCH_STATUS_CHANGED', from, to: 'ON_HOLD', reason });
  }
}

export function releaseHold(tx: Tx, cmd: ReleaseHoldCommand): void {
  requireBatchStatus(tx, ['ON_HOLD'], 'releasing a hold');
  const h = tx.s.holds[cmd.hold];
  if (!h || h.released) refuse('ENG-HOLD-UNKNOWN', `There is no active hold ${cmd.hold}`, ['PR-45']);
  const a = requirePerson(tx);
  // Only QA lifts a QA hold (outline 5.2.2).
  requireRole(a, h.type === 'QA' ? tx.def.policy.qaRoles : [...tx.def.policy.supervisorRoles, ...tx.def.policy.qaRoles], `release a ${h.type.toLowerCase()} hold`);
  const reason = requireReason(cmd.reason, 'Releasing a hold');
  h.released = { by: a.id, reason, at: tx.now };
  tx.emit({ type: 'HOLD_RELEASED', hold: h.id, by: a.id, reason });
  if (Object.values(tx.s.holds).some((x) => !x.released)) return;
  const to = tx.s.statusBeforeHold ?? 'IN_PROGRESS';
  tx.s.status = to;
  delete tx.s.statusBeforeHold;
  tx.emit({ type: 'BATCH_STATUS_CHANGED', from: 'ON_HOLD', to, reason: `last hold released: ${reason}` });
}

export function abortBatch(tx: Tx, cmd: AbortBatchCommand): void {
  requireBatchStatus(tx, ['ISSUED', 'IN_PROGRESS', 'ON_HOLD', 'EXECUTION_COMPLETE'], 'aborting the batch');
  const requester = requirePerson(tx);
  const reason = requireReason(cmd.reason, 'An abort');
  const persons = new Set(cmd.approvals.map((x) => x.approver.id));
  const head = cmd.approvals.find((x) => x.approver.kind === 'PERSON' && hasRole(x.approver, tx.def.policy.productionHeadRoles));
  const qa = cmd.approvals.find((x) => x.approver.kind === 'PERSON' && hasRole(x.approver, qualityUnitRoles(tx.def.policy)) && x !== head);
  if (!head || !qa || persons.size < 2 || head.approver.id === qa.approver.id || cmd.approvals.length !== 2 || persons.has(requester.id)) {
    refuse('ENG-ABORT-APPROVALS', 'An abort needs exactly two signatures by different persons, neither of them the one who records it: the head of production and QA', ['DI-34', 'PR-13']);
  }
  const unconfirmed = ABORT_CHECKLIST_ITEMS.filter((k) => cmd.checklist?.[k] !== true);
  if (unconfirmed.length > 0) refuse('ENG-ABORT-CHECKLIST', `An abort needs its checklist confirmed: ${unconfirmed.join(', ')} not confirmed`, ['DI-34', 'PR-13']);
  for (const ap of [head, qa]) requireSignature(tx, ap.signature, ap.approver.id, [MEANINGS.ABORT_APPROVED], 'The abort');
  for (const ap of [head, qa]) useSignature(tx, ap.signature, 'batch aborted');
  const from = tx.s.status;
  tx.s.status = 'ABORTED';
  tx.s.abort = { reason, checklist: { outputsHeld: true, equipmentSetDirty: true, materialsSecured: true }, approvals: [head.approver.id, qa.approver.id], at: tx.now };
  tx.emit({ type: 'BATCH_STATUS_CHANGED', from, to: 'ABORTED', reason });
}

export function cancelBatch(tx: Tx, cmd: CancelBatchCommand): void {
  requireBatchStatus(tx, ['ISSUED'], 'cancelling the batch');
  if (Object.values(tx.s.steps).some((i) => i.status !== 'ENABLED' && i.status !== 'PENDING' && i.status !== 'NOT_APPLICABLE')) {
    refuse('ENG-CANCEL-STARTED', 'Only a batch where nothing has started can be cancelled; abort it instead', ['PR-10', 'IN-18']);
  }
  const a = requirePerson(tx);
  requireRole(a, tx.def.policy.supervisorRoles, 'cancel an issued batch');
  const reason = requireReason(cmd.reason, 'A cancellation');
  const sig = requireSignature(tx, cmd.signature, a.id, [MEANINGS.CANCELLED], 'The cancellation');
  useSignature(tx, sig, 'batch cancelled');
  tx.s.status = 'CANCELLED';
  tx.emit({ type: 'BATCH_STATUS_CHANGED', from: 'ISSUED', to: 'CANCELLED', reason });
}

/** An operator can raise an exception at any step (S-4); ACTION stops the steps after it until a deviation is linked. */
export function raiseException(tx: Tx, cmd: RaiseExceptionCommand): void {
  requireBatchStatus(tx, ['ISSUED', 'IN_PROGRESS', 'ON_HOLD', 'EXECUTION_COMPLETE'], 'raising an exception');
  const a = requirePerson(tx);
  const text = requireReason(cmd.description, 'An exception');
  const frames = cmd.context ?? [];
  let source: { stepKey?: string; step?: string; frames: Frame[] } = { frames: [...frames] };
  let anchor: { node: string; frames: Frame[] } | undefined;
  if (cmd.step !== undefined) {
    const step = tx.def.steps.get(cmd.step);
    const key = stepKey(cmd.step, frames);
    if (!step || !tx.s.steps[key]) refuse('ENG-UNKNOWN-STEP', `Step ${key} has not been reached in this batch`, ['PR-13']);
    requireNotHandedOver(tx.s.steps[key], a.id, 'raising an exception at it');
    source = { stepKey: key, step: cmd.step, frames: [...frames] };
    anchor = { node: step.graphNode, frames: [...frames] };
  }
  tx.raise(
    engineDraft('OPERATOR_RAISED', `${a.id}: ${text}`, cmd.severity === 'ACTION' ? { severity: 'ACTION', blocks: anchor ? 'DOWNSTREAM' : 'NONE', until: 'DEVIATION', deviationRequired: true } : {}),
    source,
    anchor,
  );
}

export function attachDeviation(tx: Tx, cmd: AttachDeviationCommand): void {
  requireBatchStatus(tx, ['ISSUED', 'IN_PROGRESS', 'ON_HOLD', 'EXECUTION_COMPLETE'], 'linking a deviation');
  const e = tx.s.exceptions[cmd.exception];
  if (!e) refuse('ENG-UNKNOWN-EXCEPTION', `There is no exception ${cmd.exception}`, ['PR-49']);
  if (e.status !== 'OPEN') refuse('ENG-EXCEPTION-CLOSED', `Exception ${e.id} is already dispositioned`, ['PR-49']);
  if (e.deviation) refuse('ENG-DEVIATION-LINKED', `Exception ${e.id} is already linked to deviation ${e.deviation.ref}`, ['PR-49']);
  const a = requirePerson(tx);
  const ref = requireReason(cmd.deviationRef, 'A deviation link');
  e.deviation = { ref, linkedBy: a.id, at: tx.now };
  tx.emit({ type: 'DEVIATION_LINKED', exception: e.id, deviationRef: ref, by: a.id });
}

/**
 * Disposition of an exception (outline 5.2.4): by a person outside the involvement set of the step
 * that raised it; QA only where the exception requires it; a required deviation must be linked first.
 */
export function dispositionException(tx: Tx, cmd: DispositionExceptionCommand): void {
  requireBatchStatus(tx, ['ISSUED', 'IN_PROGRESS', 'ON_HOLD', 'EXECUTION_COMPLETE'], 'dispositioning an exception');
  const e = tx.s.exceptions[cmd.exception];
  if (!e) refuse('ENG-UNKNOWN-EXCEPTION', `There is no exception ${cmd.exception}`, ['DI-26']);
  if (e.status !== 'OPEN') refuse('ENG-EXCEPTION-CLOSED', `Exception ${e.id} is already dispositioned`, ['DI-26']);
  const a = requirePerson(tx);
  requireRole(a, e.qaOnly ? tx.def.policy.qaRoles : [...tx.def.policy.supervisorRoles, ...tx.def.policy.qaRoles], `disposition exception ${e.id}${e.qaOnly ? ' (QA only)' : ''}`);
  const inst = e.source.stepKey !== undefined ? tx.s.steps[e.source.stepKey] : undefined;
  if (inst && excludedFromReview(inst).has(a.id)) {
    refuse('ENG-SEGREGATION', `${a.id} is involved in step ${inst.key}, which raised ${e.id}, or took part in its hand-over, and cannot disposition it`, ['PR-13', 'PR-49', 'INV-03']);
  }
  const justification = requireReason(cmd.justification, 'A disposition');
  if (e.deviationRequired && cmd.outcome !== 'DEVIATION_RAISED') {
    refuse('ENG-DEVIATION-REQUIRED', `Exception ${e.id} needs a deviation${e.registrationRelevant ? ' flagged registration-relevant' : ''}; "no impact" is not an allowed disposition`, ['PR-08', 'PR-49', 'PR-50']);
  }
  if (cmd.outcome === 'DEVIATION_RAISED' && !e.deviation) refuse('ENG-DEVIATION-REQUIRED', `Link the deviation to ${e.id} before dispositioning it as raised`, ['PR-49']);
  const sig = requireSignature(tx, cmd.signature, a.id, [MEANINGS.EXCEPTION_DISPOSITIONED], `Disposition of ${e.id}`);
  useSignature(tx, sig, `disposition of ${e.id}`, e.source.stepKey);
  e.status = 'DISPOSITIONED';
  e.disposition = { by: a.id, outcome: cmd.outcome, justification, signature: sig.id, at: tx.now };
  tx.emit({ type: 'EXCEPTION_DISPOSITIONED', exception: e.id, outcome: cmd.outcome, by: a.id });
  if (e.source.stepKey !== undefined) tx.emit({ type: 'INVOLVEMENT', stepKey: e.source.stepKey, person: a.id, involvement: 'DISPOSITIONED_EXCEPTION' });
}
