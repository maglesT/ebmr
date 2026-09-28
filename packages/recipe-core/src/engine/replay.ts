/**
 * Replay of a persisted batch execution (Phase 2 apps plan section 7; module C3; DI-34, INV-19, INV-20,
 * INV-25; ADR 0010: a record is re-executed with the engine and block versions it was issued with).
 *
 * The execution store keeps one row per engine call, in order: ISSUE (the issue request), COMMAND (the
 * engine command), PREPARE (the system facts a signing command sees before the signer is shown the
 * content: target and actor) and SWEEP (the time sweep). Each row stores the trusted database time it ran
 * at, whether the engine accepted it, and the hashes of the events and of the resulting state.
 *
 * `replay` folds the rows through the pure engine at their stored clocks and compares, row by row, the
 * accepted flag, the events hash and the state hash; after every row it runs `checkInvariants`. It
 * reports the first difference (row, field, expected, actual). A tampered command, clock or state hash is
 * therefore reported at the row where it was changed.
 */
import { decode, eventsHash, stateHash, type JsonValue } from './codec.ts';
import type { BatchDefinition } from './definition.ts';
import { issue, prepareForSignature, step, sweep, type SignatureTarget } from './engine.ts';
import { checkInvariants } from './invariants.ts';
import type { Actor, BatchState, Command, EngineEvent, IssueRequest } from './types.ts';

export type ExecutionRowKind = 'ISSUE' | 'COMMAND' | 'PREPARE' | 'SWEEP';

/** What a stored row says the engine was asked to do (encoded with the codec). */
export type RowCommand =
  | { type: 'ISSUE'; request: IssueRequest }
  | { type: 'PREPARE'; target: SignatureTarget; actor: Actor; /** Signature meaning prepared for (permission check only). */ meaning?: string }
  | { type: 'SWEEP' }
  | Command;

export interface ExecutionRow {
  seq: bigint;
  kind: ExecutionRowKind;
  /** The encoded row command (codec JSON). */
  command: JsonValue;
  nowUs: bigint;
  accepted: boolean;
  stateHash: string;
  eventsHash: string;
}

export interface ReplayDifference {
  seq: bigint;
  field: 'kind' | 'accepted' | 'eventsHash' | 'stateHash' | 'command' | 'invariants';
  expected: string;
  actual: string;
}

export interface ReplayResult {
  identical: boolean;
  rows: number;
  firstDifference: ReplayDifference | null;
  invariantViolations: string[];
  /** The state after the last row (undefined when the first row could not be replayed). */
  state: BatchState | undefined;
}

/** One engine call of a row, from the state before it. */
export function applyRow(def: BatchDefinition, state: BatchState | undefined, kind: ExecutionRowKind, command: RowCommand, nowUs: bigint): { state: BatchState; events: EngineEvent[]; accepted: boolean } {
  const clock = { nowUs };
  if (kind === 'ISSUE') {
    if (command.type !== 'ISSUE') throw new Error('an ISSUE row must hold an issue request');
    const r = issue(def, command.request, clock);
    return { state: r.state, events: r.events, accepted: true };
  }
  if (!state) throw new Error(`a ${kind} row cannot come before the ISSUE row`);
  if (kind === 'PREPARE') {
    if (command.type !== 'PREPARE') throw new Error('a PREPARE row must hold a target and an actor');
    const r = prepareForSignature(def, state, command.target, command.actor, clock);
    return { state: r.state, events: r.events, accepted: true };
  }
  if (kind === 'SWEEP') {
    const r = sweep(def, state, clock);
    return { state: r.state, events: r.events, accepted: true };
  }
  if (command.type === 'ISSUE' || command.type === 'PREPARE' || command.type === 'SWEEP') throw new Error('a COMMAND row must hold an engine command');
  const r = step(def, state, command, clock);
  return { state: r.state, events: r.events, accepted: r.accepted };
}

/** Replays stored rows (in `seq` order) and compares every row with what the engine produces now. */
export function replay(def: BatchDefinition, rows: readonly ExecutionRow[]): ReplayResult {
  let state: BatchState | undefined;
  const violations: string[] = [];
  let expectedSeq = 1n;
  for (const row of rows) {
    const diff = (field: ReplayDifference['field'], expected: string, actual: string): ReplayResult => ({ identical: false, rows: rows.length, firstDifference: { seq: row.seq, field, expected, actual }, invariantViolations: violations, state });
    if (row.seq !== expectedSeq) return diff('command', `row ${expectedSeq}`, `row ${row.seq}`);
    expectedSeq += 1n;
    if ((row.seq === 1n) !== (row.kind === 'ISSUE')) return diff('kind', row.seq === 1n ? 'ISSUE' : 'COMMAND, PREPARE or SWEEP', row.kind);
    let r: { state: BatchState; events: EngineEvent[]; accepted: boolean };
    try {
      r = applyRow(def, state, row.kind, decode(row.command) as RowCommand, row.nowUs);
    } catch (e) {
      return diff('command', 'a command the engine can run', e instanceof Error ? e.message : String(e));
    }
    if (r.accepted !== row.accepted) return diff('accepted', String(row.accepted), String(r.accepted));
    const eh = eventsHash(r.events);
    if (eh !== row.eventsHash) return diff('eventsHash', row.eventsHash, eh);
    const sh = stateHash(r.state);
    if (sh !== row.stateHash) return diff('stateHash', row.stateHash, sh);
    state = r.state;
    const v = checkInvariants(def, state);
    if (v.length > 0) {
      violations.push(...v.map((x) => `row ${row.seq}: [${x.invariant}] ${x.message}`));
      return { identical: false, rows: rows.length, firstDifference: { seq: row.seq, field: 'invariants', expected: 'no violation', actual: violations.join('; ') }, invariantViolations: violations, state };
    }
  }
  return { identical: true, rows: rows.length, firstDifference: null, invariantViolations: violations, state };
}
