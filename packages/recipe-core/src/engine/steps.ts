/**
 * Step life cycle (outline 5.2.3): PENDING -> ENABLED (token arrives) -> IN_PROGRESS (batch not on hold,
 * role held, not blocked, time limits respected) -> AWAITING_VERIFICATION (mandatory data present,
 * calculations done, minimum duration elapsed, no blocking exception; Sig(PERFORMED) by every person
 * who entered data; the block's own perform meaning where it has one) -> COMPLETED (the check the step requires:
 * RE_VERIFIED_AFTER_CORRECTION, the MBR's WITNESSED, the block's own check or VERIFIED, by a person who neither
 * performed, entered data in nor corrected the step: INV-03). SKIPPED only for skippable phases with a different
 * approver; NOT_APPLICABLE only by the system. Hold points and stage sign-off live here too.
 */
import type { PhaseNode } from '../flow/model.ts';
import { RELEASING_DISPOSITIONS, type StepDef } from './definition.ts';
import { computeCalculations, evaluateAcceptanceScheme, missingData, notify, raiseDrafts, snapshotTargets, storePoint, validateValue } from './data.ts';
import { engineDraft, replicateCompatible } from './exceptions.ts';
import { deriveStageSummary } from './stage-summary.ts';
import {
  addUnique,
  checkMeanings,
  handEntriesWithoutDeclaredEvidence,
  hasRole,
  involvedIn,
  MEANINGS,
  performMeanings,
  requireBatchStatus,
  requireInstance,
  requireNotBlocked,
  requirePerson,
  requireReason,
  requireRole,
  requireSignature,
  requireStep,
  requireStepStatus,
  useSignature,
} from './guards.ts';
import { checkMinimum, eventInstant, recordNodeEvent } from './timing.ts';
import { ctxKey, refuse, type Tx } from './tx.ts';
import type {
  ChooseAlternativeCommand,
  ChooseReplicateCountCommand,
  CompleteLoopIterationCommand,
  DispositionHoldPointCommand,
  RecordDataCommand,
  RecordEntryCommand,
  RequestSkipCommand,
  SignOffStageCommand,
  SignPerformedCommand,
  StageSummary,
  StartStepCommand,
  StepInstance,
  VerifyCommand,
} from './types.ts';
import { validateSchema } from '../blocks/schema.ts';
import { makeView } from './view.ts';
import { evaluateCondition, recordDecision } from './advance.ts';
import { pointsOf } from './values.ts';

const RUNNING = ['ISSUED', 'IN_PROGRESS'] as const;

function markInProgress(tx: Tx): void {
  if (tx.s.status === 'ISSUED') {
    tx.s.status = 'IN_PROGRESS';
    tx.emit({ type: 'BATCH_STATUS_CHANGED', from: 'ISSUED', to: 'IN_PROGRESS', reason: 'first step started' });
  }
}

function setStatus(tx: Tx, inst: StepInstance, to: StepInstance['status'], reason?: string): void {
  const from = inst.status;
  inst.status = to;
  const ev: Parameters<Tx['emit']>[0] = { type: 'STEP_STATUS_CHANGED', stepKey: inst.key, step: inst.step, from, to, by: tx.by };
  if (reason !== undefined) Object.assign(ev, { reason });
  tx.emit(ev);
  if ((to === 'COMPLETED' || to === 'SKIPPED' || to === 'NOT_APPLICABLE') && inst.firstCompletedSeq === undefined) inst.firstCompletedSeq = tx.s.seq;
}

function phaseOf(step: StepDef): PhaseNode {
  if (step.node.kind !== 'phase') refuse('ENG-NOT-A-PHASE', `${step.id} is a hold point, not a phase`, ['DI-34']);
  return step.node;
}

/** Actor may perform the step: a person with a performer role, or the automation of an automated phase. */
function requirePerformer(tx: Tx, step: StepDef, action: string): void {
  const a = tx.actor;
  if (!a) refuse('ENG-ACTOR', 'No actor', ['DI-14']);
  if (a.kind === 'SYSTEM') {
    const phase = phaseOf(step);
    if (phase.signatures.perform) refuse('ENG-ACTOR', `${step.id} is performed by a person (${phase.signatures.perform.role}); a system account cannot ${action}`, ['DI-14', 'PR-14']);
    return;
  }
  requireRole(a, step.performRoles, `${action} ${step.id}`);
}

// ---------------------------------------------------------------------------------------------

export function startStep(tx: Tx, cmd: StartStepCommand): void {
  requireBatchStatus(tx, RUNNING, 'starting a step');
  const step = requireStep(tx, cmd.step);
  phaseOf(step);
  const frames = cmd.context ?? [];
  const inst = requireInstance(tx, step, frames);
  requireStepStatus(inst, ['ENABLED'], 'starting it');
  requirePerformer(tx, step, 'start');
  if (cmd.occurredAt && (cmd.occurredAt.trust === 'USER_CLAIMED' || cmd.occurredAt.trust === 'PAPER')) {
    refuse('ENG-BACKDATING', 'A step start cannot be given a person-claimed time; the server time is used and late data goes through the late-entry path', ['DI-28', 'PR-11']);
  }
  requireNotBlocked(tx, inst, 'START');
  const at = eventInstant(tx, cmd.occurredAt);
  checkMinimum(tx, step.id, 'START', frames, at);
  const handler = step.block?.handler;
  const view = makeView(tx, step, inst);
  const startSchema = step.block?.dataSchema?.startData;
  if (cmd.blockData !== undefined) {
    if (!startSchema) refuse('ENG-ENTRY-SCHEMA', `Block ${step.block?.type ?? '?'} takes no start data`, ['DI-30']);
    const problems = validateSchema(startSchema, cmd.blockData, 'startData');
    if (problems.length > 0) refuse('ENG-ENTRY-SCHEMA', `Start data of ${step.id}: ${problems.map((p) => `${p.path} ${p.message}`).join('; ')}`, ['DI-30']);
  }
  const hp = handler?.beforeStart?.(view, cmd.blockData) ?? [];
  if (hp.length > 0) refuse(hp[0]?.code ?? 'ENG-BLOCK', hp.map((p) => p.message).join('; '), hp.flatMap((p) => p.controls));

  markInProgress(tx);
  inst.startedAt = at;
  inst.startedSeq = tx.s.seq + 1;
  setStatus(tx, inst, 'IN_PROGRESS');
  recordNodeEvent(tx, step.id, 'START', frames, at);
  if (tx.actor?.kind === 'PERSON') {
    addUnique(inst.performers, tx.actor.id);
    tx.emit({ type: 'INVOLVEMENT', stepKey: inst.key, person: tx.actor.id, involvement: 'STARTED' });
  }
  if (cmd.blockData !== undefined) {
    const id = tx.nextId('EN');
    tx.s.entries[id] = { id, stepKey: inst.key, kind: 'START_DATA', data: { ...cmd.blockData }, enteredBy: tx.by, recordedAt: tx.now, recordedSeq: tx.s.seq + 1 };
    tx.emit({ type: 'ENTRY_RECORDED', entry: id, stepKey: inst.key, kind: 'START_DATA', by: tx.by });
  }
  snapshotTargets(tx, step, inst);
  computeCalculations(tx, step, inst, undefined);
}

export function recordData(tx: Tx, cmd: RecordDataCommand): void {
  requireBatchStatus(tx, ['IN_PROGRESS', 'ON_HOLD'], 'recording data');
  const step = requireStep(tx, cmd.step);
  const phase = phaseOf(step);
  const frames = cmd.context ?? [];
  const inst = requireInstance(tx, step, frames);
  const a = tx.def.analysis;
  if (a.calculations.has(cmd.item) || step.computedItems.has(cmd.item)) {
    refuse('ENG-DERIVED-TYPED', `${cmd.item} is computed by the system from its inputs and can never be typed`, ['INV-25', 'DI-33']);
  }
  if (a.inputs.has(cmd.item)) refuse('ENG-DERIVED-TYPED', `${cmd.item} is a header or master-data value fixed when the batch was issued`, ['INV-25', 'DI-10']);
  if (!phase.records.includes(cmd.item)) refuse('ENG-NOT-RECORDED-HERE', `Step ${step.id} does not record ${cmd.item}`, ['DI-34', 'PR-13']);
  requireStepStatus(inst, ['IN_PROGRESS'], 'recording data');
  requirePerformer(tx, step, 'record data in');
  if (tx.actor?.kind === 'SYSTEM' && cmd.source.mode === 'MANUAL') refuse('ENG-ACTOR', 'A system account cannot key a value by hand', ['DI-14']);
  const param = a.parameters.get(cmd.item);
  if (!param) refuse('ENG-NOT-RECORDED-HERE', `${cmd.item} is not a parameter`, ['DI-34']);
  validateValue(tx, param, cmd.value);
  let late = false;
  if (cmd.occurredAt) {
    const started = inst.startedAt ?? tx.clockUs;
    if (cmd.occurredAt.us < started || cmd.occurredAt.us > tx.clockUs) {
      refuse('ENG-OCCURRED-AT', 'The event time must lie between the start of the step and now; back-dating before the step started is impossible', ['DI-28', 'PR-11', 'INV-16']);
    }
    if (cmd.occurredAt.trust === 'USER_CLAIMED' || cmd.occurredAt.trust === 'PAPER') {
      requireReason(cmd.reason, 'A late entry');
      late = true;
    }
  }
  const view = makeView(tx, step, inst);
  const opts: Parameters<typeof storePoint>[7] = { lateEntry: late };
  if (cmd.occurredAt) opts.occurredAt = cmd.occurredAt;
  const point = storePoint(tx, step, inst, view, cmd.item, cmd.value, cmd.source, opts);
  if (late) {
    point.exceptions.push(
      tx.raise(engineDraft('LATE_ENTRY', `${cmd.item} in ${inst.key} was entered late with a claimed time (${cmd.occurredAt?.trust ?? ''}); reason: ${cmd.reason ?? ''}`, { item: cmd.item }), {
        stepKey: inst.key,
        step: inst.step,
        frames: inst.frames,
        point: point.id,
      }),
    );
  }
  if (tx.actor?.kind === 'PERSON') {
    addUnique(inst.dataEnterers, tx.actor.id);
    tx.emit({ type: 'INVOLVEMENT', stepKey: inst.key, person: tx.actor.id, involvement: 'ENTERED_DATA' });
  }
  computeCalculations(tx, step, inst, undefined);
}

export function recordEntry(tx: Tx, cmd: RecordEntryCommand): void {
  requireBatchStatus(tx, ['IN_PROGRESS', 'ON_HOLD'], 'recording an entry');
  const step = requireStep(tx, cmd.step);
  phaseOf(step);
  const inst = requireInstance(tx, step, cmd.context ?? []);
  requireStepStatus(inst, ['IN_PROGRESS'], 'recording an entry');
  requirePerformer(tx, step, 'record entries in');
  const block = step.block;
  const schema = block?.dataSchema?.entries[cmd.entry.kind];
  if (!block || !schema || !block.handler?.acceptEntry) refuse('ENG-ENTRY-KIND', `Block ${block?.type ?? '?'} does not take entries of kind ${cmd.entry.kind}`, ['DI-30']);
  const payload = Object.fromEntries(Object.entries(cmd.entry).filter(([k]) => k !== 'kind'));
  const problems = validateSchema(schema, payload, cmd.entry.kind);
  if (problems.length > 0) refuse('ENG-ENTRY-SCHEMA', `Entry ${cmd.entry.kind} of ${step.id}: ${problems.map((p) => `${p.path} ${p.message}`).join('; ')}`, block.controls);
  const view = makeView(tx, step, inst);
  const r = block.handler.acceptEntry(view, cmd.entry);
  if (!r.ok) refuse(r.problems[0]?.code ?? 'ENG-BLOCK', r.problems.map((p) => p.message).join('; '), [...new Set(r.problems.flatMap((p) => p.controls))]);
  for (const c of r.registerContainers ?? []) if (tx.s.containers[c.id]) refuse('ENG-CONTAINER-DUPLICATE', `Container ${c.id} is already registered`, ['PR-38', 'PR-57']);
  for (const c of r.consumeContainers ?? []) {
    const rec = tx.s.containers[c];
    if (!rec) refuse('ENG-CONTAINER-UNKNOWN', `Container ${c} does not belong to this batch`, ['PR-21']);
    if (rec.status === 'CONSUMED') refuse('ENG-CONTAINER-CONSUMED', `Container ${c} was already charged in ${rec.consumedBy ?? '?'}`, ['PR-21']);
  }
  const id = tx.nextId('EN');
  tx.s.entries[id] = { id, stepKey: inst.key, kind: cmd.entry.kind, data: r.data, enteredBy: tx.by, recordedAt: tx.now, recordedSeq: tx.s.seq + 1 };
  tx.emit({ type: 'ENTRY_RECORDED', entry: id, stepKey: inst.key, kind: cmd.entry.kind, by: tx.by });
  for (const c of r.registerContainers ?? []) {
    tx.s.containers[c.id] = { id: c.id, holds: c.holds, holdsKind: c.holdsKind, producedBy: inst.key, producedIn: [...inst.frames], status: 'QUARANTINE', ...(c.net ? { net: c.net } : {}) };
    tx.emit({ type: 'CONTAINER_REGISTERED', container: c.id, holds: c.holds, stepKey: inst.key });
  }
  for (const c of r.consumeContainers ?? []) {
    const rec = tx.s.containers[c];
    if (!rec) continue;
    rec.status = 'CONSUMED';
    rec.consumedBy = inst.key;
    tx.emit({ type: 'CONTAINER_CONSUMED', container: c, stepKey: inst.key });
  }
  raiseDrafts(tx, step, inst, r.exceptions, { entry: id });
  notify(tx, `${inst.key} ${cmd.entry.kind}`, r.notifications);
  if (r.verificationRequired === true) inst.verificationRequired = true;
  if (tx.actor?.kind === 'PERSON') {
    addUnique(inst.dataEnterers, tx.actor.id);
    tx.emit({ type: 'INVOLVEMENT', stepKey: inst.key, person: tx.actor.id, involvement: 'ENTERED_DATA' });
  }
  computeCalculations(tx, step, inst, undefined);
}

/**
 * Finalisation at the PERFORMED attempt: block-computed items (container totals) and evaluations the
 * block runs at the end of the step (tolerance, sampling shortfall, acceptance schemes). These are
 * system facts: they stay recorded even when the PERFORMED signature itself is refused.
 */
export function finalisePerform(tx: Tx, cmd: SignPerformedCommand): void {
  const step = tx.def.steps.get(cmd.step);
  if (!step || step.node.kind !== 'phase') return;
  const inst = tx.s.steps[`${step.id}@${ctxKey(cmd.context ?? [])}`];
  if (!inst || inst.status !== 'IN_PROGRESS' || tx.s.status !== 'IN_PROGRESS') return;
  const handler = step.block?.handler;
  const view = makeView(tx, step, inst);
  for (const c of handler?.computeItems?.(view) ?? []) {
    const fingerprint = c.entries.join(',');
    if (inst.blockComputed[c.item] === fingerprint) continue;
    const prev = pointsOf(tx.s, inst.key, c.item).filter((p) => p.status === 'VALID' && p.kind === 'VALUE');
    const last = prev[prev.length - 1];
    const point = storePoint(tx, step, inst, view, c.item, c.value, { mode: 'BLOCK', entries: [...c.entries] }, last ? { correctionOf: last } : {});
    if (last) {
      last.status = 'SUPERSEDED';
      last.supersededBy = point.id;
      point.correction = { reason: 'recomputed from the block entries', signature: 'SYSTEM' };
    }
    inst.blockComputed[c.item] = fingerprint;
  }
  computeCalculations(tx, step, inst, undefined);
  const entriesFingerprint = `${Object.values(tx.s.entries).filter((e) => e.stepKey === inst.key).map((e) => e.id).join(',')}|${Object.values(tx.s.points).filter((p) => p.stepKey === inst.key && p.status === 'VALID').map((p) => p.id).join(',')}`;
  if (inst.blockComputed['\u0000perform'] !== entriesFingerprint) {
    inst.blockComputed['\u0000perform'] = entriesFingerprint;
    evaluateAcceptanceScheme(tx, step, inst);
    const eff = handler?.onPerform?.(makeView(tx, step, inst));
    raiseDrafts(tx, step, inst, eff?.exceptions);
    notify(tx, inst.key, eff?.notifications);
  }
}

export function signPerformed(tx: Tx, cmd: SignPerformedCommand): void {
  requireBatchStatus(tx, ['IN_PROGRESS'], 'signing a step as performed');
  const step = requireStep(tx, cmd.step);
  const phase = phaseOf(step);
  const frames = cmd.context ?? [];
  const inst = requireInstance(tx, step, frames);
  requireStepStatus(inst, ['IN_PROGRESS'], 'signing it as performed');
  const a = tx.actor;
  if (!a) refuse('ENG-ACTOR', 'No actor', ['DI-14']);
  const handler = step.block?.handler;
  let signer: string | undefined;
  if (a.kind === 'SYSTEM') {
    if (!step.systemPerforms) refuse('ENG-ACTOR', `${step.id} needs a person's PERFORMED signature (two persons on every batch unless the one-verifier mode S5a is on)`, ['PR-14', 'INV-31']);
  } else {
    requireRole(a, step.performRoles, `sign ${step.id} as performed`);
    // Exactly the step's own PERFORMED meaning: the block's (a line clearance, a sample taken), else PERFORMED (DI-35).
    requireSignature(tx, cmd.signature, a.id, performMeanings(step), `Step ${inst.key}`);
    signer = a.id;
  }
  // The step moves on only when every person who entered data has signed for their own entries (L-67).
  const signedAfter = signer ? [...new Set([...inst.performedSigners, signer])] : inst.performedSigners;
  const unsigned = inst.dataEnterers.filter((p) => !signedAfter.includes(p));
  const transition = unsigned.length === 0;
  const at = eventInstant(tx, cmd.occurredAt);
  if (transition) {
    // The block's own completeness rule first: it names what is missing in the block's terms.
    const hp = handler?.beforePerform?.(makeView(tx, step, inst)) ?? [];
    if (hp.length > 0) refuse(hp[0]?.code ?? 'ENG-BLOCK', hp.map((p) => p.message).join('; '), [...new Set(hp.flatMap((p) => p.controls))]);
    const missing = missingData(tx, step, inst);
    if (missing.length > 0) refuse('ENG-MANDATORY-DATA', `Step ${inst.key} cannot be signed as performed: mandatory values or calculations are missing (${missing.join(', ')})`, ['PR-16', 'DI-34', 'INV-25']);
    requireNotBlocked(tx, inst, 'COMPLETE');
    checkMinimum(tx, step.id, 'END', frames, at);
  }
  if (signer && cmd.signature) {
    addUnique(inst.performedSigners, signer);
    addUnique(inst.performers, signer);
    inst.signatures.push({ id: cmd.signature.id, meaning: cmd.signature.meaning, signer, at: tx.now, role: 'PERFORMED', valid: true });
    useSignature(tx, cmd.signature, `${inst.key} performed`, inst.key);
    tx.emit({ type: 'INVOLVEMENT', stepKey: inst.key, person: signer, involvement: 'PERFORMED' });
  }
  if (!transition) return;
  inst.endedAt = at;
  recordNodeEvent(tx, step.id, 'END', frames, at);
  const needsCheck = phase.signatures.check !== undefined || inst.verificationRequired;
  if (needsCheck) setStatus(tx, inst, 'AWAITING_VERIFICATION');
  else {
    inst.completedAt = tx.now;
    setStatus(tx, inst, 'COMPLETED');
  }
}

export function verify(tx: Tx, cmd: VerifyCommand): void {
  requireBatchStatus(tx, ['IN_PROGRESS'], 'verifying a step');
  const step = requireStep(tx, cmd.step);
  phaseOf(step);
  const inst = requireInstance(tx, step, cmd.context ?? []);
  requireStepStatus(inst, ['AWAITING_VERIFICATION'], 'verifying it');
  const a = requirePerson(tx);
  const roles = step.checkRole !== undefined ? [step.checkRole] : [...tx.def.policy.fallbackVerifierRoles];
  requireRole(a, roles, `verify ${step.id}`);
  // Exactly the check the step requires (P37; DI-35, PR-14, PR-20): RE_VERIFIED_AFTER_CORRECTION while re-verification
  // is due, else the MBR's WITNESSED or a witness for a critical hand entry without the photo or printout its MBR names
  // (T12; DI-30), else the block's own check, else VERIFIED. Never a witness or a generic verification in place of the
  // step's own check, nor a later review in place of a witness.
  const meanings = checkMeanings(step, inst, handEntriesWithoutDeclaredEvidence(tx.def, tx.s, inst));
  // INV-03: the verifier or witness never performed, entered data in or corrected the step.
  if (involvedIn(inst).has(a.id)) {
    refuse('ENG-SEGREGATION', `${a.id} performed, entered data in or corrected step ${inst.key} and so cannot verify or witness it`, ['INV-03', 'PR-14', 'DI-30']);
  }
  const sig = requireSignature(tx, cmd.signature, a.id, meanings, `Verification of ${inst.key}`);
  requireNotBlocked(tx, inst, 'COMPLETE');
  if (sig.meaning === MEANINGS.WITNESSED && inst.endedAt !== undefined && tx.now - inst.endedAt > tx.def.policy.witnessWindowUs) {
    tx.raise(engineDraft('WITNESS_LATE', `${a.id} signed WITNESSED for ${inst.key} after the witness window; a witness must watch the act`), { stepKey: inst.key, step: inst.step, frames: inst.frames });
  }
  inst.signatures.push({ id: sig.id, meaning: sig.meaning, signer: a.id, at: tx.now, role: 'CHECKED', valid: true });
  useSignature(tx, sig, `${inst.key} ${sig.meaning.toLowerCase()}`, inst.key);
  tx.emit({ type: 'INVOLVEMENT', stepKey: inst.key, person: a.id, involvement: sig.meaning === MEANINGS.WITNESSED ? 'WITNESSED' : 'VERIFIED' });
  inst.reverification = false;
  inst.completedAt = tx.now;
  setStatus(tx, inst, 'COMPLETED');
}

/** Skip only for skippable phases, with a different approver, never for CPP/CQA inputs, reconciliation, clearance or release signatures (outline 5.2.3). */
export function requestSkip(tx: Tx, cmd: RequestSkipCommand): void {
  requireBatchStatus(tx, RUNNING, 'skipping a step');
  const step = requireStep(tx, cmd.step);
  if (step.kind === 'HOLD') refuse('ENG-SKIP-FORBIDDEN', `${step.id} is a QA hold point: release signatures are never skipped`, ['PR-13', 'PR-45']);
  const phase = phaseOf(step);
  const inst = requireInstance(tx, step, cmd.context ?? []);
  requireStepStatus(inst, ['ENABLED'], 'skipping it');
  const a = requirePerson(tx);
  const reason = requireReason(cmd.reason, 'A skip');
  if (step.config['skippable'] !== true) refuse('ENG-SKIP-FORBIDDEN', `${step.id} is not declared skippable in the MBR`, ['PR-13', 'DI-34']);
  const roles = tx.def.analysis.describe(phase)?.roles ?? [];
  if (roles.some((r) => r === 'CLEARANCE' || r === 'YIELD_RECONCILIATION' || r === 'SIGN_OFF' || r === 'DISPENSING' || r === 'CHARGE_IN' || r === 'REPROCESSING')) {
    refuse('ENG-SKIP-FORBIDDEN', `${step.id} is a ${roles.join('/').toLowerCase()} step: line clearance, dispensing, charge-in, reconciliation, reprocessing and sign-off steps are never skipped`, ['PR-13', 'PR-16']);
  }
  const critical = phase.records.filter((r) => tx.def.analysis.parameters.get(r)?.criticality === 'CRITICAL');
  if (critical.length > 0) refuse('ENG-SKIP-FORBIDDEN', `${step.id} records critical values (${critical.join(', ')}): CPP and CQA inputs are never skipped`, ['PR-13', 'DI-07']);
  if (phase.consumes.length + phase.produces.length + phase.uses.length > 0 || phase.yieldCheckpoint !== undefined || phase.acceptanceScheme !== undefined) {
    refuse('ENG-SKIP-FORBIDDEN', `${step.id} moves material or carries a yield or acceptance check and cannot be skipped`, ['PR-13', 'PR-31']);
  }
  const readers = [...step.writes].filter((w) => tx.def.readItems.has(w));
  if (readers.length > 0) refuse('ENG-SKIP-FORBIDDEN', `${step.id} writes values other steps read (${readers.join(', ')})`, ['PR-13', 'DI-34']);
  const approver = cmd.approval.approver;
  if (approver.kind !== 'PERSON' || approver.id === a.id) refuse('ENG-SEGREGATION', 'A skip is approved by a different person than the one who requests it', ['PR-13', 'DI-17']);
  requireRole(approver, [...tx.def.policy.supervisorRoles, ...tx.def.policy.qaRoles], `approve skipping ${step.id}`);
  const sig = requireSignature(tx, cmd.approval.signature, approver.id, [MEANINGS.SKIP_APPROVED], `Skip of ${inst.key}`);
  markInProgress(tx);
  useSignature(tx, sig, `${inst.key} skip approved`, inst.key);
  inst.skip = { reason, requestedBy: a.id, approvedBy: approver.id, signature: sig.id, at: tx.now };
  inst.signatures.push({ id: sig.id, meaning: sig.meaning, signer: approver.id, at: tx.now, role: 'SKIP_APPROVAL', valid: true });
  setStatus(tx, inst, 'SKIPPED', reason);
  tx.emit({ type: 'INVOLVEMENT', stepKey: inst.key, person: approver.id, involvement: 'APPROVED_SKIP' });
  tx.raise(engineDraft('STEP_SKIPPED', `${inst.key} was skipped: ${reason} (requested by ${a.id}, approved by ${approver.id})`), { stepKey: inst.key, step: inst.step, frames: inst.frames });
}

/** QA hold point (G-17): everything after it waits for the authorised disposition. */
export function dispositionHoldPoint(tx: Tx, cmd: DispositionHoldPointCommand): void {
  requireBatchStatus(tx, ['IN_PROGRESS'], 'signing a hold point');
  const step = requireStep(tx, cmd.step);
  if (step.node.kind !== 'holdPoint') refuse('ENG-NOT-A-HOLD-POINT', `${step.id} is not a hold point`, ['PR-45']);
  const hold = step.node;
  const inst = requireInstance(tx, step, cmd.context ?? []);
  requireStepStatus(inst, ['ENABLED'], 'dispositioning it');
  if (inst.disposition) refuse('ENG-HOLD-DECIDED', `Hold point ${inst.key} was already signed ${inst.disposition.value}`, ['PR-45']);
  const a = requirePerson(tx);
  requireRole(a, [hold.role], `sign hold point ${hold.id}`);
  if (!hold.dispositions.includes(cmd.disposition)) refuse('ENG-HOLD-DISPOSITION', `${cmd.disposition} is not a disposition of ${hold.id} (${hold.dispositions.join(', ')})`, ['PR-45']);
  const positive = RELEASING_DISPOSITIONS.includes(cmd.disposition);
  const sig = requireSignature(tx, cmd.signature, a.id, [positive ? MEANINGS.HOLD_RELEASED : MEANINGS.HOLD_NOT_RELEASED], `Hold point ${inst.key}`);
  const at = tx.clockUs;
  if (positive) {
    const open = Object.values(tx.s.exceptions).filter((e) => e.status === 'OPEN' && e.severity !== 'ALERT' && replicateCompatible(tx.def, e.source.frames, inst.frames));
    if (open.length > 0) {
      refuse('ENG-HOLD-OPEN-EXCEPTIONS', `Hold point ${inst.key} cannot be approved while required results are failing or open exceptions have no QA decision: ${open.map((e) => `${e.id} ${e.title}`).join('; ')}`, ['PR-45', 'IN-37', 'PR-08']);
    }
    checkMinimum(tx, step.id, 'END', inst.frames, at);
  }
  useSignature(tx, sig, `${inst.key} ${cmd.disposition}`, inst.key);
  inst.signatures.push({ id: sig.id, meaning: sig.meaning, signer: a.id, at: tx.now, role: 'HOLD_POINT', valid: true });
  inst.disposition = { value: cmd.disposition, positive, by: a.id, signature: sig.id, at: tx.now, ...(cmd.comment !== undefined ? { comment: cmd.comment } : {}) };
  addUnique(inst.performers, a.id);
  tx.emit({ type: 'INVOLVEMENT', stepKey: inst.key, person: a.id, involvement: 'SIGNED_HOLD_POINT' });
  if (positive) {
    inst.endedAt = at;
    inst.completedAt = tx.now;
    recordNodeEvent(tx, step.id, 'END', inst.frames, at);
    setStatus(tx, inst, 'COMPLETED', cmd.disposition);
    return;
  }
  // "Not approved": the intermediate is rejected; nothing after the hold point runs; the batch goes on QA hold.
  tx.raise(
    engineDraft('HOLD_POINT_NOT_APPROVED', `QA hold point ${hold.name} (${inst.key}) was signed ${cmd.disposition} by ${a.id}: the intermediate is rejected and the steps after it cannot run`, {
      blocks: 'DOWNSTREAM',
      until: 'DISPOSITION',
      qaOnly: true,
      releaseBlocking: true,
    }),
    { stepKey: inst.key, step: inst.step, frames: inst.frames },
    { node: step.graphNode, frames: inst.frames },
  );
  const holdId = tx.nextId('HOLD');
  tx.s.holds[holdId] = { id: holdId, type: 'QA', reason: `hold point ${inst.key} not approved`, placedBy: 'SYSTEM', at: tx.now, automatic: true };
  tx.s.statusBeforeHold = 'IN_PROGRESS';
  tx.s.status = 'ON_HOLD';
  tx.emit({ type: 'HOLD_PLACED', hold: holdId, holdType: 'QA', automatic: true, reason: `hold point ${inst.key} not approved` });
  tx.emit({ type: 'BATCH_STATUS_CHANGED', from: 'IN_PROGRESS', to: 'ON_HOLD', reason: `hold point ${inst.key} not approved` });
}

/** Stage frame sign-off by the person responsible for the stage (G-02; IN-15): derived summary, never typed. */
export function signOffStage(tx: Tx, cmd: SignOffStageCommand): void {
  requireBatchStatus(tx, ['IN_PROGRESS', 'EXECUTION_COMPLETE'], 'signing off a stage');
  const stage = tx.def.stages.get(cmd.stage);
  if (!stage) refuse('ENG-UNKNOWN-STAGE', `There is no stage ${cmd.stage}`, ['IN-15']);
  const frames = cmd.context ?? [];
  const key = `${stage.id}@${ctxKey(frames)}`;
  const frame = tx.s.stages[key];
  if (!frame || (!frame.awaitingSignOff && (frame.endedAt === undefined || frame.signOff?.valid === true))) {
    refuse('ENG-STAGE-NOT-READY', `Stage ${key} is not waiting for its sign-off: its steps are not finished, or it is already signed off`, ['IN-15', 'PR-16']);
  }
  const a = requirePerson(tx);
  requireRole(a, [stage.responsibleRole], `sign off stage ${stage.id}`);
  const sig = requireSignature(tx, cmd.signature, a.id, [MEANINGS.STAGE_SIGNED_OFF], `Stage ${key}`);
  // The steps, exceptions and summary of the frame: the one derivation the stage's signed content also uses
  // (stage-summary.ts; the summary is part of what the STAGE_SIGNED_OFF signature binds, Phase 2 exit review F01).
  const { steps, exceptions, summary: derived } = deriveStageSummary(tx.def, tx.s, frame);
  const open = steps.filter((i) => (i.status !== 'COMPLETED' && i.status !== 'NOT_APPLICABLE' && i.status !== 'SKIPPED') || i.reverification);
  if (open.length > 0) refuse('ENG-STAGE-STEPS', `Stage ${key} has steps that are not finished or await re-verification: ${open.map((i) => i.key).join(', ')}`, ['PR-16', 'IN-15']);
  const unclassified = exceptions.filter((e) => e.status === 'OPEN' && (e.stageSignOffBlocked || (e.block !== undefined && (e.block.until === 'DISPOSITION' || e.deviation === undefined))));
  if (unclassified.length > 0) {
    refuse('ENG-STAGE-EXCEPTIONS', `Stage ${key} cannot be signed off: ${unclassified.map((e) => `${e.id} ${e.title}`).join('; ')} ${unclassified.some((e) => e.stageSignOffBlocked) ? '(registration-relevant exceptions need QA classification first)' : ''}`.trim(), ['PR-08', 'IN-15', 'PR-16']);
  }
  checkMinimum(tx, stage.id, 'END', frames, tx.clockUs);
  const summary: StageSummary = {
    stage: derived.stage,
    startedAt: derived.startedAt,
    endedAt: tx.now,
    steps: derived.steps,
    exceptions: derived.exceptions,
    deviations: derived.deviations,
    statement: derived.statement,
    yields: derived.yields,
  };
  useSignature(tx, sig, `stage ${key} signed off`);
  frame.signOff = { by: a.id, signature: sig.id, at: tx.now, valid: true, summary };
  tx.emit({ type: 'STAGE_SIGNED_OFF', stageKey: key, by: a.id, statement: summary.statement });
}

export function chooseAlternative(tx: Tx, cmd: ChooseAlternativeCommand): void {
  requireBatchStatus(tx, RUNNING, 'choosing a branch');
  const alt = tx.def.alternatives.get(cmd.construct);
  if (!alt) refuse('ENG-UNKNOWN-CONSTRUCT', `There is no alternative ${cmd.construct}`, ['DI-34']);
  if (alt.decision.mode !== 'OPERATOR_CHOICE') refuse('ENG-DECISION-MODE', `${alt.id} is decided ${alt.decision.mode === 'DATA' ? 'by recorded data' : 'by the issue variant'}, never by a person`, ['DI-34', 'PR-13']);
  const frames = cmd.context ?? [];
  const split = tx.def.analysis.graphNodeOf(alt.id, 'XOR_SPLIT');
  const enabled = split ? tx.def.game.enabled(tx.s.marking).some((e) => e.node === split.id && ctxKey(e.frames) === ctxKey(frames)) : false;
  if (!enabled) refuse('ENG-NOT-ENABLED', `The choice at ${alt.id} is not due yet: the steps before it have not been completed`, ['DI-34']);
  const a = requirePerson(tx);
  requireRole(a, alt.decision.roles, `choose a branch at ${alt.id}`);
  const reason = requireReason(cmd.reason, `The choice at ${alt.id}`);
  if (!alt.branches.some((b) => b.id === cmd.branch)) refuse('ENG-DECISION-OPTION', `${cmd.branch} is not a branch of ${alt.id}`, ['DI-34']);
  markInProgress(tx);
  recordDecision(tx, { key: `${alt.id}@${ctxKey(frames)}`, kind: 'BRANCH', construct: alt.id, frames: [...frames], outcome: cmd.branch, decidedBy: a.id, reason, inputs: { points: [], derived: [] } });
}

export function chooseReplicateCount(tx: Tx, cmd: ChooseReplicateCountCommand): void {
  requireBatchStatus(tx, RUNNING, 'choosing a sub-lot count');
  const rep = tx.def.replicates.get(cmd.construct);
  if (!rep) refuse('ENG-UNKNOWN-CONSTRUCT', `There is no replicate section ${cmd.construct}`, ['INV-19']);
  if (rep.count.mode !== 'RUNTIME') refuse('ENG-DECISION-MODE', `The sub-lot count of ${rep.id} comes from its expression, never from a person`, ['INV-19']);
  const frames = cmd.context ?? [];
  const split = tx.def.analysis.graphNodeOf(rep.id, 'REP_SPLIT');
  const enabled = split ? tx.def.game.enabled(tx.s.marking).some((e) => e.node === split.id && ctxKey(e.frames) === ctxKey(frames)) : false;
  if (!enabled) refuse('ENG-NOT-ENABLED', `The sub-lot count of ${rep.id} is not due yet`, ['DI-34']);
  const a = requirePerson(tx);
  requireRole(a, tx.def.policy.replicateCountRoles, `choose the sub-lot count of ${rep.id}`);
  const reason = requireReason(cmd.reason, `The sub-lot count of ${rep.id}`);
  if (!Number.isSafeInteger(cmd.count) || cmd.count < rep.count.min || cmd.count > rep.count.max) {
    refuse('ENG-REPLICATE-COUNT', `${rep.name} allows ${rep.count.min} to ${rep.count.max} sub-lots; ${cmd.count} was chosen`, ['INV-19']);
  }
  markInProgress(tx);
  recordDecision(tx, { key: `${rep.id}@${ctxKey(frames)}`, kind: 'COUNT', construct: rep.id, frames: [...frames], outcome: String(cmd.count), decidedBy: a.id, reason, inputs: { points: [], derived: [] } });
}

/** Ends a loop iteration: the engine evaluates the exit condition; a person never chooses the outcome (INV-19). */
export function completeLoopIteration(tx: Tx, cmd: CompleteLoopIterationCommand): void {
  requireBatchStatus(tx, ['IN_PROGRESS'], 'completing a loop iteration');
  const loop = tx.def.loops.get(cmd.construct);
  if (!loop) refuse('ENG-UNKNOWN-CONSTRUCT', `There is no loop ${cmd.construct}`, ['INV-19']);
  const frames = cmd.context;
  const last = frames[frames.length - 1];
  if (!last || last.construct !== loop.id) refuse('ENG-LOOP-CONTEXT', `The context must name an iteration of ${loop.id}`, ['INV-19']);
  const test = tx.def.analysis.graphNodeOf(loop.id, 'LOOP_TEST');
  const enabled = test ? tx.def.game.enabled(tx.s.marking).find((e) => e.node === test.id && ctxKey(e.frames) === ctxKey(frames)) : undefined;
  if (!enabled || !test) refuse('ENG-NOT-ENABLED', `Iteration ${last.index} of ${loop.id} is not finished: its steps have not been completed`, ['DI-34', 'INV-19']);
  const a = tx.actor;
  if (!a) refuse('ENG-ACTOR', 'No actor', ['DI-14']);
  if (a.kind === 'PERSON') {
    const roles = [...tx.def.steps.values()].filter((s) => s.constructs.includes(loop.id)).flatMap((s) => s.performRoles);
    requireRole(a, [...new Set(roles), ...tx.def.policy.supervisorRoles], `end an iteration of ${loop.id}`);
  }
  const cond = evaluateCondition(tx, loop.exit.condition, loop.id, test, frames);
  if (!cond.ok) refuse('ENG-LOOP-EXIT', `The exit condition of ${loop.name} cannot be evaluated for iteration ${last.index}: ${cond.reason ?? ''}`, ['INV-19', 'DI-34']);
  const outcome = cond.value === true ? 'EXIT' : last.index < loop.maxIterations ? 'CONTINUE' : 'EXHAUSTED';
  if (outcome !== 'CONTINUE') checkMinimum(tx, loop.id, 'END', frames.slice(0, -1), tx.clockUs);
  recordDecision(tx, {
    key: `${loop.id}@${ctxKey(frames)}`,
    kind: 'LOOP',
    construct: loop.id,
    frames: [...frames],
    outcome,
    decidedBy: 'SYSTEM',
    reason: `exit condition ${loop.exit.condition} is ${String(cond.value)} in iteration ${last.index} of at most ${loop.maxIterations}; ended by ${a.id}`,
    inputs: cond.inputs,
    iteration: last.index,
  });
}

export { hasRole };
