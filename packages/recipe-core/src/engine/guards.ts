/**
 * Guards shared by the command handlers (outline 5.2.3 transition guards; 7.2 segregation of duties).
 * Every refusal is plain language first, then the rule code and the controls (outline 6.3).
 */
import type { Frame } from '../flow/tokens.ts';
import type { BatchDefinition, StepDef } from './definition.ts';
import { blockingExceptions, describeBlocking } from './exceptions.ts';
import { refuse, stepKey, type Tx } from './tx.ts';
import type { Actor, BatchState, BatchStatus, SignatureRef, StepInstance } from './types.ts';

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

/**
 * Meaning codes that verify recorded evidence (VERIFIED and its specialisations in the kernel catalogue): the
 * catalogue of the VERIFY command type. A step accepts only the one its own check asks for (`checkMeanings`).
 */
export const VERIFICATION_MEANINGS: readonly string[] = ['VERIFIED', 'CONTAINER_CHECKED', 'CHARGE_IN_VERIFIED', 'YIELD_VERIFIED', 'IPC_VERIFIED', 'LINE_CLEARANCE_VERIFIED'];

/**
 * The meanings a PERFORMED signature on `step` may carry, exactly (DI-35; engine 1.1.0): the block's own perform
 * meanings when it has any (LINE_CLEARANCE_PERFORMED, SAMPLE_TAKEN, IPC_PERFORMED), else the generic PERFORMED. The
 * generic meaning never stands in for the block's own: the block's meaning is what the record attests (a line
 * clearance, a sample taken), so a PERFORMED signature on such a step would drop that attestation. The screen offers
 * the first (actions.ts performMeaning) and the database accepts the same set (recipe.step_signature_meanings).
 */
export function performMeanings(step: StepDef | undefined): readonly string[] {
  const own = step?.block?.handler?.meanings?.perform ?? [];
  return own.length > 0 ? own : [MEANINGS.PERFORMED];
}

/**
 * The items of step instance `inst` that hold a critical value typed by hand whose MBR parameter names a photo or a
 * printout as its evidence, without an attachment of that kind (lead TODO T12 of the Phase 2 exit; DI-30, PR-14;
 * engine 1.4.0): its current (VALID) values only, sorted. The validator lets the second person of such a step review
 * the value later (VERIFIED) only because the photo or printout will be there to review it against (GMP-WITNESS); a
 * value without it has nothing behind it, as any other critical hand entry, so its check is a witness. In this release
 * no hand entry carries an attachment: the server and the database refuse an attachment hash until an attachment store
 * exists (EBMR-EXE-122).
 */
export function handEntriesWithoutDeclaredEvidence(
  def: Pick<BatchDefinition, 'analysis'>,
  state: Pick<BatchState, 'points'> | undefined,
  inst: Pick<StepInstance, 'key'> | undefined,
): string[] {
  if (!state || !inst) return [];
  const items = new Set<string>();
  for (const p of Object.values(state.points)) {
    if (p.stepKey !== inst.key || p.kind !== 'VALUE' || p.status !== 'VALID' || p.source.mode !== 'MANUAL') continue;
    const param = def.analysis.parameters.get(p.item);
    if (param?.criticality !== 'CRITICAL' || (param.evidence !== 'PHOTO' && param.evidence !== 'PRINTOUT')) continue;
    if (p.source.evidence?.kind !== param.evidence) items.add(p.item);
  }
  return [...items].sort();
}

/**
 * The meanings the check of a step instance may carry, exactly (DI-35, PR-14, PR-20, DI-24; review finding P37;
 * engine 1.1.0, 1.4.0): RE_VERIFIED_AFTER_CORRECTION while it awaits re-verification; else WITNESSED where the MBR asks
 * for a witness, or where the step holds a critical hand entry without the photo or printout its MBR names
 * (`unevidenced`, from handEntriesWithoutDeclaredEvidence; T12); else the block's own check meanings
 * (CONTAINER_CHECKED on a dispensing step); else VERIFIED. A verifier never chooses: a witness, a generic VERIFIED or
 * another block's check never replaces the check the step requires. The screen offers the first (actions.ts
 * checkMeaning) and the database accepts the same set (recipe.step_check_meanings, recipe.step_signature_meanings).
 */
export function checkMeanings(step: StepDef | undefined, inst: Pick<StepInstance, 'reverification'> | undefined, unevidenced: readonly string[]): readonly string[] {
  if (inst?.reverification === true) return [MEANINGS.RE_VERIFIED];
  if (step?.checkMeaning === 'WITNESSED' || unevidenced.length > 0) return [MEANINGS.WITNESSED];
  const own = step?.block?.handler?.meanings?.check ?? [];
  return own.length > 0 ? own : [MEANINGS.VERIFIED];
}

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

/**
 * The code points that show nothing on their own, as inclusive ranges: the C0 and C1 controls, Unicode White_Space,
 * the format characters (general category Cf), the default-ignorable code points and the Braille blank (Unicode 17).
 * Written out, never as Unicode property escapes, so the engine's answer does not change with the runtime's Unicode
 * tables. The kernel's blank test holds exactly this class (kernel.is_blank, kernel 0960; recipe.reason_is_blank),
 * and a test compares the two over every code point.
 */
export const BLANK_CODE_POINTS: readonly (readonly [number, number])[] = [
  [0x0000, 0x0020], [0x007f, 0x00a0], [0x00ad, 0x00ad], [0x034f, 0x034f], [0x0600, 0x0605], [0x061c, 0x061c], [0x06dd, 0x06dd],
  [0x070f, 0x070f], [0x0890, 0x0891], [0x08e2, 0x08e2], [0x115f, 0x1160], [0x1680, 0x1680], [0x17b4, 0x17b5], [0x180b, 0x180f],
  [0x2000, 0x200f], [0x2028, 0x202f], [0x205f, 0x206f], [0x2800, 0x2800], [0x3000, 0x3000], [0x3164, 0x3164], [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfffb], [0x110bd, 0x110bd], [0x110cd, 0x110cd], [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff],
];

/** True when `text` holds no character a person can read: only white space, controls and invisible format characters. */
export function isBlankText(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (!BLANK_CODE_POINTS.some(([from, to]) => c >= from && c <= to)) return false;
  }
  return true;
}

/**
 * A reason, justification, description or reference the person gives: a text with at least one visible character
 * (engine 1.1.0; DI-22, DI-24, P29), kept trimmed as JavaScript trims it.
 */
export function requireReason(reason: string | undefined, what: string): string {
  if (typeof reason !== 'string' || isBlankText(reason)) refuse('ENG-REASON', `${what} needs a reason`, ['DI-22', 'DI-24']);
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
