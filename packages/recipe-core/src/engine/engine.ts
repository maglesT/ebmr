/**
 * The execution engine: `step(state, command, clock) -> (state, events)` (ADR 0004 decision 5).
 *
 * Each call:
 *   1. copies the state (the caller's state is never changed);
 *   2. applies the trusted time: a clock earlier than the last time seen is flagged and never allowed
 *      to hide a maximum breach;
 *   3. sweeps every time constraint (INV-20: breaches are computed at every command);
 *   4. refuses a duplicate (idempotency key) or stale (optimistic locking) command;
 *   5. runs the command's guards and effects, then fires every control node that can fire
 *      (advance), and sweeps again;
 *   6. on refusal returns the state with only the system facts of steps 2-3 (and a finalisation of
 *      a PERFORMED attempt), plus a COMMAND_REFUSED event, and the refusal in plain language.
 * The engine never reads the system clock and does no I/O; persistence (Phase 3) writes the events and
 * the new state in the command's transaction, with the e-signatures the kernel made there.
 */
import { advance } from './advance.ts';
import { abortBatch, attachDeviation, cancelBatch, dispositionException, holdBatch, initialState, raiseException, releaseHold } from './batch.ts';
import { correctEntry, invalidateResult, voidAttempt } from './corrections.ts';
import type { BatchDefinition } from './definition.ts';
import { engineDraft } from './exceptions.ts';
import {
  chooseAlternative,
  chooseReplicateCount,
  completeLoopIteration,
  dispositionHoldPoint,
  finalisePerform,
  recordData,
  recordEntry,
  requestSkip,
  signOffStage,
  signPerformed,
  startStep,
  verify,
} from './steps.ts';
import { stepSigningContent } from './signing-content.ts';
import { sweepTime } from './timing.ts';
import { cloneState, RefusalError, Tx } from './tx.ts';
import type { Frame } from '../flow/tokens.ts';
import type { Actor, BatchState, Clock, Command, EngineEvent, IssueRequest, SignatureTarget, StepResult } from './types.ts';

function openTx(def: BatchDefinition, state: BatchState, clock: Clock, actor: Actor | undefined): Tx {
  const s = cloneState(state);
  const regressed = clock.nowUs < s.lastRecordedUs;
  const now = regressed ? s.lastRecordedUs : clock.nowUs;
  const tx = new Tx(def, s, now, clock.nowUs, actor);
  if (regressed) {
    tx.emit({ type: 'CLOCK_REGRESSION', previousUs: s.lastRecordedUs, nowUs: clock.nowUs });
    tx.raise(engineDraft('CLOCK_REGRESSION', 'The trusted clock went backwards; maximum durations are measured against the latest time seen and minimum durations against the clock as given'), { frames: [] });
  } else s.lastRecordedUs = clock.nowUs;
  return tx;
}

function dispatch(tx: Tx, cmd: Command): void {
  switch (cmd.type) {
    case 'START_STEP':
      return startStep(tx, cmd);
    case 'RECORD_DATA':
      return recordData(tx, cmd);
    case 'RECORD_ENTRY':
      return recordEntry(tx, cmd);
    case 'SIGN_PERFORMED':
      return signPerformed(tx, cmd);
    case 'VERIFY':
      return verify(tx, cmd);
    case 'CHOOSE_ALTERNATIVE':
      return chooseAlternative(tx, cmd);
    case 'CHOOSE_REPLICATE_COUNT':
      return chooseReplicateCount(tx, cmd);
    case 'COMPLETE_LOOP_ITERATION':
      return completeLoopIteration(tx, cmd);
    case 'REQUEST_SKIP':
      return requestSkip(tx, cmd);
    case 'DISPOSITION_HOLD_POINT':
      return dispositionHoldPoint(tx, cmd);
    case 'SIGN_OFF_STAGE':
      return signOffStage(tx, cmd);
    case 'RAISE_EXCEPTION':
      return raiseException(tx, cmd);
    case 'ATTACH_DEVIATION':
      return attachDeviation(tx, cmd);
    case 'DISPOSITION_EXCEPTION':
      return dispositionException(tx, cmd);
    case 'HOLD_BATCH':
      return holdBatch(tx, cmd);
    case 'RELEASE_HOLD':
      return releaseHold(tx, cmd);
    case 'CORRECT_ENTRY':
      return correctEntry(tx, cmd);
    case 'VOID_ATTEMPT':
      return voidAttempt(tx, cmd);
    case 'INVALIDATE_RESULT':
      return invalidateResult(tx, cmd);
    case 'ABORT_BATCH':
      return abortBatch(tx, cmd);
    case 'CANCEL_BATCH':
      return cancelBatch(tx, cmd);
  }
}

/** What a signature is about to be applied to (types.ts; re-exported here for the engine's callers). */
export type { SignatureTarget };

/**
 * The system facts a command triggers before its own guards run (shared by `step` and
 * `prepareForSignature`, so both are identical by construction): the sweep of every time constraint at the
 * trusted time and, for SIGN_PERFORMED, the finalisation of the PERFORMED attempt (block-computed totals,
 * calculations, acceptance schemes, the block's end-of-step evaluations). Mutates `base`.
 */
function sweepPhase(base: Tx): void {
  sweepTime(base);
}

function finalisePhase(base: Tx, target: SignatureTarget): void {
  if (target.type === 'SIGN_PERFORMED' && target.step !== undefined) {
    finalisePerform(base, { type: 'SIGN_PERFORMED', commandId: '', actor: base.actor ?? { id: 'SYSTEM', kind: 'SYSTEM', roles: [] }, step: target.step, context: target.context ?? [] });
  }
}

/**
 * A PERFORMED signature on a step that is still in progress (other persons have yet to sign for their own
 * entries) covers the step's data as it was. When that data changes afterwards (a value, an entry, a
 * correction, a void or the finalisation of a later PERFORMED attempt), the signature no longer covers it:
 * the engine invalidates it and the person signs again, just as the e-signature kernel supersedes a
 * signature whose content changed (INV-09, DI-37). Signatures made in this very command are exempt: they
 * were made on the prepared content.
 */
function resignAfterChange(before: BatchState, tx: Tx): void {
  for (const inst of Object.values(tx.s.steps)) {
    if (inst.status !== 'IN_PROGRESS') continue;
    const prior = before.steps[inst.key];
    if (!prior) continue;
    const priorIds = new Set(prior.signatures.filter((g) => g.valid && g.role === 'PERFORMED').map((g) => g.id));
    const signed = inst.signatures.filter((g) => g.valid && g.role === 'PERFORMED' && priorIds.has(g.id));
    if (signed.length === 0) continue;
    if (stepSigningContent(tx.def, before, inst.key).contentHash === stepSigningContent(tx.def, tx.s, inst.key).contentHash) continue;
    for (const g of signed) g.valid = false;
    const stale = new Set(signed.map((g) => g.signer));
    inst.performedSigners = inst.performedSigners.filter((p) => !stale.has(p));
    tx.emit({ type: 'SIGNATURES_INVALIDATED', signatures: signed.map((g) => g.id), stepKey: inst.key, reason: 'the data of the step changed after it was signed as performed; every person who entered data signs again' });
  }
}

/**
 * The state as a signing command will see it (Phase 2 apps plan section 6): the sweep and, for
 * SIGN_PERFORMED, the finalisation, at the trusted time, without the command itself. `changed` is true
 * when these system facts produced events (then the caller persists them as a PREPARE row before the
 * signer is shown the content). A refusal raised while finalising keeps the facts established before it,
 * exactly as `step` does.
 */
export function prepareForSignature(def: BatchDefinition, state: BatchState, target: SignatureTarget, actor: Actor, clock: Clock): { state: BatchState; events: EngineEvent[]; changed: boolean } {
  if (state.mbrHash !== def.contentHash) throw new Error('the state belongs to another MBR version than this definition');
  const base = openTx(def, state, clock, actor);
  sweepPhase(base);
  try {
    finalisePhase(base, target);
  } catch (e) {
    if (!(e instanceof RefusalError)) throw e;
  }
  resignAfterChange(state, base);
  return { state: base.s, events: base.events, changed: base.events.length > 0 };
}

/** Applies one command at the trusted time `clock` (pure: same inputs, same outputs). */
export function step(def: BatchDefinition, state: BatchState, command: Command, clock: Clock): StepResult {
  if (state.mbrHash !== def.contentHash) throw new Error('the state belongs to another MBR version than this definition');
  const base = openTx(def, state, clock, command.actor);
  sweepPhase(base);
  if (state.appliedCommands.includes(command.commandId)) return { state: base.s, events: base.events, accepted: false, duplicate: true };
  const refused = (err: RefusalError, events: EngineEvent[], s: BatchState): StepResult => {
    base.emit({ type: 'COMMAND_REFUSED', commandId: command.commandId, commandType: command.type, code: err.refusal.code, by: command.actor.id });
    return { state: s, events: [...events, ...base.events.slice(events.length)], accepted: false, refusal: err.refusal };
  };
  try {
    if (command.expectedVersion !== undefined && command.expectedVersion !== state.version) {
      throw new RefusalError({ code: 'ENG-STALE', message: `The batch changed since this screen was loaded (version ${state.version}, expected ${command.expectedVersion}); reload and try again (ENG-STALE; DI-34)`, controls: ['DI-34'] });
    }
    finalisePhase(base, command.type === 'SIGN_PERFORMED' ? { type: command.type, step: command.step, context: command.context ?? [] } : { type: command.type });
  } catch (e) {
    if (e instanceof RefusalError) {
      resignAfterChange(state, base);
      return refused(e, [...base.events], base.s);
    }
    throw e;
  }
  const tx = new Tx(def, cloneState(base.s), base.now, base.clockUs, command.actor);
  try {
    dispatch(tx, command);
    advance(tx);
    sweepTime(tx);
  } catch (e) {
    if (e instanceof RefusalError) {
      resignAfterChange(state, base);
      return refused(e, [...base.events], base.s);
    }
    throw e;
  }
  resignAfterChange(state, tx);
  tx.s.version += 1;
  tx.s.appliedCommands.push(command.commandId);
  return { state: tx.s, events: [...base.events, ...tx.events], accepted: true };
}

/** Evaluates time constraints (and nothing else) at `clock`: the sweeper of INV-20. */
export function sweep(def: BatchDefinition, state: BatchState, clock: Clock): { state: BatchState; events: EngineEvent[] } {
  const tx = openTx(def, state, clock, undefined);
  sweepTime(tx);
  return { state: tx.s, events: tx.events };
}

/** Issues a batch (G-01): validates the header, pins the MBR hash and enables the first steps. */
export function issue(def: BatchDefinition, request: IssueRequest, clock: Clock): { state: BatchState; events: EngineEvent[] } {
  let s: BatchState;
  try {
    s = initialState(def, request, clock.nowUs);
  } catch (e) {
    if (e instanceof RefusalError) throw new IssueRefusedError(e.refusal.message, e.refusal.code);
    throw e;
  }
  const tx = new Tx(def, s, clock.nowUs, clock.nowUs, request.issuedBy);
  tx.emit({ type: 'BATCH_ISSUED', batchId: s.header.batchId, batchNumber: s.header.batchNumber, mbrHash: s.mbrHash, marketSet: [...s.header.marketSet] });
  advance(tx);
  return { state: tx.s, events: tx.events };
}

export class IssueRefusedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'IssueRefusedError';
  }
}

/** The engine bound to one definition: `engine.step(state, command, clock)` as in ADR 0004. */
export interface Engine {
  readonly definition: BatchDefinition;
  issue(request: IssueRequest, clock: Clock): { state: BatchState; events: EngineEvent[] };
  step(state: BatchState, command: Command, clock: Clock): StepResult;
  sweep(state: BatchState, clock: Clock): { state: BatchState; events: EngineEvent[] };
  prepareForSignature(state: BatchState, target: SignatureTarget, actor: Actor, clock: Clock): { state: BatchState; events: EngineEvent[]; changed: boolean };
}

export function createEngine(def: BatchDefinition): Engine {
  return {
    definition: def,
    issue: (request, clock) => issue(def, request, clock),
    step: (state, command, clock) => step(def, state, command, clock),
    sweep: (state, clock) => sweep(def, state, clock),
    prepareForSignature: (state, target, actor, clock) => prepareForSignature(def, state, target, actor, clock),
  };
}
