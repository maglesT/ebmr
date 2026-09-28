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
import { sweepTime } from './timing.ts';
import { cloneState, RefusalError, Tx } from './tx.ts';
import type { Actor, BatchState, Clock, Command, EngineEvent, IssueRequest, StepResult } from './types.ts';

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

/** Applies one command at the trusted time `clock` (pure: same inputs, same outputs). */
export function step(def: BatchDefinition, state: BatchState, command: Command, clock: Clock): StepResult {
  if (state.mbrHash !== def.contentHash) throw new Error('the state belongs to another MBR version than this definition');
  const base = openTx(def, state, clock, command.actor);
  sweepTime(base);
  if (state.appliedCommands.includes(command.commandId)) return { state: base.s, events: base.events, accepted: false, duplicate: true };
  const refused = (err: RefusalError, events: EngineEvent[], s: BatchState): StepResult => {
    base.emit({ type: 'COMMAND_REFUSED', commandId: command.commandId, commandType: command.type, code: err.refusal.code, by: command.actor.id });
    return { state: s, events: [...events, ...base.events.slice(events.length)], accepted: false, refusal: err.refusal };
  };
  try {
    if (command.expectedVersion !== undefined && command.expectedVersion !== state.version) {
      throw new RefusalError({ code: 'ENG-STALE', message: `The batch changed since this screen was loaded (version ${state.version}, expected ${command.expectedVersion}); reload and try again (ENG-STALE; DI-34)`, controls: ['DI-34'] });
    }
    if (command.type === 'SIGN_PERFORMED') finalisePerform(base, command);
  } catch (e) {
    if (e instanceof RefusalError) return refused(e, [...base.events], base.s);
    throw e;
  }
  const tx = new Tx(def, cloneState(base.s), base.now, base.clockUs, command.actor);
  try {
    dispatch(tx, command);
    advance(tx);
    sweepTime(tx);
  } catch (e) {
    if (e instanceof RefusalError) return refused(e, [...base.events], base.s);
    throw e;
  }
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
}

export function createEngine(def: BatchDefinition): Engine {
  return {
    definition: def,
    issue: (request, clock) => issue(def, request, clock),
    step: (state, command, clock) => step(def, state, command, clock),
    sweep: (state, clock) => sweep(def, state, clock),
  };
}
