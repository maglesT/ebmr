/**
 * Guards shared by the command handlers (outline 5.2.3 transition guards; 7.2 segregation of duties).
 * Every refusal is plain language first, then the rule code and the controls (outline 6.3).
 */
import type { Frame } from '../flow/tokens.ts';
import type { StepDef } from './definition.ts';
import { blockingExceptions, describeBlocking } from './exceptions.ts';
import { refuse, stepKey, type Tx } from './tx.ts';
import type { Actor, BatchStatus, SignatureRef, StepInstance } from './types.ts';

/**
 * Signature meanings the engine accepts (kernel e-signature catalogue codes). Codes marked NEW are
 * not yet in the kernel's vendor catalogue (kernel migration 0210) and must be added there.
 */
export const MEANINGS = {
  PERFORMED: 'PERFORMED',
  VERIFIED: 'VERIFIED',
  WITNESSED: 'WITNESSED',
  RE_VERIFIED: 'RE_VERIFIED_AFTER_CORRECTION',
  CORRECTED: 'CORRECTED',
  HOLD_RELEASED: 'HOLD_POINT_RELEASED',
  /** NEW: a QA hold point signed "not approved". */
  HOLD_NOT_RELEASED: 'HOLD_POINT_NOT_RELEASED',
  /** NEW: the person responsible signs off a stage (IN-15). */
  STAGE_SIGNED_OFF: 'STAGE_SIGNED_OFF',
  EXCEPTION_DISPOSITIONED: 'EXCEPTION_DISPOSITIONED',
  SKIP_APPROVED: 'SKIP_APPROVED',
  VOID_AUTHORISED: 'VOID_AUTHORISED',
  /** NEW: S25 approval of a correction of critical data. */
  CORRECTION_APPROVED: 'CORRECTION_APPROVED',
  /** NEW: QA approval of an invalidation with an investigation (path c). */
  INVALIDATION_APPROVED: 'INVALIDATION_APPROVED',
  /** NEW: head of production and QA approve an abort. */
  ABORT_APPROVED: 'BATCH_ABORT_APPROVED',
  /** NEW: a supervisor cancels an issued batch before anything started. */
  CANCELLED: 'BATCH_CANCELLED',
  REPROCESSING_AUTHORISED: 'DEVIATION_AUTHORISED',
} as const;

/** Meaning codes that verify recorded evidence (VERIFIED and its specialisations in the kernel catalogue). */
export const VERIFICATION_MEANINGS: readonly string[] = ['VERIFIED', 'CONTAINER_CHECKED', 'CHARGE_IN_VERIFIED', 'YIELD_VERIFIED', 'IPC_VERIFIED', 'LINE_CLEARANCE_VERIFIED'];

export function requireBatchStatus(tx: Tx, allowed: readonly BatchStatus[], action: string): void {
  if (allowed.includes(tx.s.status)) return;
  if (tx.s.status === 'ON_HOLD') refuse('ENG-BATCH-ON-HOLD', `The batch is on hold: ${action} is not possible until the hold is released (only QA lifts a QA hold)`, ['DI-34', 'PR-45']);
  refuse('ENG-BATCH-STATUS', `The batch is ${tx.s.status.toLowerCase().replace('_', ' ')}: ${action} is not possible`, ['DI-34']);
}

export function requirePerson(tx: Tx): Actor {
  const a = tx.actor;
  if (!a || a.kind !== 'PERSON') refuse('ENG-ACTOR', 'This action needs an authenticated person, not a system account', ['DI-14', 'DI-35']);
  return a;
}

export function hasRole(actor: Actor, roles: readonly string[]): boolean {
  return actor.roles.some((r) => roles.includes(r));
}

export function requireRole(actor: Actor, roles: readonly string[], action: string): void {
  if (roles.length === 0 || !hasRole(actor, roles)) refuse('ENG-ROLE', `${actor.id} does not hold a role that may ${action} (needs one of ${roles.join(', ') || 'no role is configured'})`, ['DI-17', 'PR-15']);
}

export function requireReason(reason: string | undefined, what: string): string {
  if (typeof reason !== 'string' || reason.trim().length === 0) refuse('ENG-REASON', `${what} needs a reason`, ['DI-22', 'DI-24']);
  return reason.trim();
}

/** The signature was made by this person, with an accepted meaning, and is used once in the batch (INV-10). */
export function requireSignature(tx: Tx, sig: SignatureRef | undefined, signer: string, meanings: readonly string[], subject: string): SignatureRef {
  if (!sig) refuse('ENG-SIGNATURE', `${subject} needs an e-signature`, ['DI-35', 'PR-14']);
  if (sig.signer !== signer) refuse('ENG-SIGNATURE', `The signature ${sig.id} was made by ${sig.signer}, not by ${signer}: nobody signs for someone else`, ['DI-35', 'DI-38']);
  if (!meanings.includes(sig.meaning)) refuse('ENG-SIGNATURE-MEANING', `${subject} needs a signature meaning ${meanings.join(' or ')}; ${sig.meaning} was given`, ['DI-35']);
  const used = tx.s.usedSignatures[sig.id];
  if (used !== undefined) refuse('ENG-SIGNATURE-REUSED', `The signature ${sig.id} was already used for ${used}`, ['DI-35', 'INV-10']);
  return sig;
}

export function useSignature(tx: Tx, sig: SignatureRef, subject: string, stepKeyOf?: string): void {
  tx.s.usedSignatures[sig.id] = subject;
  const ev: Parameters<Tx['emit']>[0] = { type: 'SIGNATURE_APPLIED', signature: sig.id, meaning: sig.meaning, signer: sig.signer, subject };
  if (stepKeyOf !== undefined) Object.assign(ev, { stepKey: stepKeyOf });
  tx.emit(ev);
}

export function requireStep(tx: Tx, step: string): StepDef {
  const d = tx.def.steps.get(step);
  if (!d) refuse('ENG-UNKNOWN-STEP', `There is no step ${step} in this MBR`, ['DI-34']);
  return d;
}

/** The step instance must exist, i.e. the token has reached it (DI-34: nothing runs out of sequence). */
export function requireInstance(tx: Tx, step: StepDef, frames: readonly Frame[]): StepInstance {
  const key = stepKey(step.id, frames);
  const inst = tx.s.steps[key];
  if (!inst || inst.status === 'PENDING') {
    refuse('ENG-NOT-ENABLED', `Step ${key} is not enabled: the steps before it have not been completed, so it cannot be executed out of sequence`, ['DI-34', 'PR-13']);
  }
  return inst;
}

export function requireStepStatus(inst: StepInstance, allowed: readonly StepInstance['status'][], action: string): void {
  if (!allowed.includes(inst.status)) refuse('ENG-STEP-STATUS', `Step ${inst.key} is ${inst.status.toLowerCase().replace(/_/g, ' ')}: ${action} is not possible`, ['DI-34']);
}

export function requireNotBlocked(tx: Tx, inst: StepInstance, phase: 'START' | 'COMPLETE'): void {
  const list = blockingExceptions(tx.def, tx.s, inst, phase);
  if (list.length > 0) {
    refuse('ENG-BLOCKED', `Step ${inst.key} cannot ${phase === 'START' ? 'start' : 'complete'} while these exceptions are unresolved: ${describeBlocking(list)}`, ['PR-08', 'PR-13', 'INV-20']);
  }
}

/** Persons involved in a step (performed, entered data, corrected): never its verifier (INV-03). */
export function involvedIn(inst: StepInstance): Set<string> {
  return new Set([...inst.performers, ...inst.dataEnterers, ...inst.correctors, ...inst.performedSigners]);
}

export function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}
