/**
 * One engine transaction: a mutable draft of the batch state plus the events it produces. Every
 * command works on a fresh deep copy, so the caller's state is never changed (the engine is a pure
 * function of state, command and clock).
 */
import { contextKey, type Frame } from '../flow/tokens.ts';
import type { ExceptionDraft } from '../blocks/contract.ts';
import type { BatchDefinition } from './definition.ts';
import type { Actor, BatchState, EngineEvent, ExceptionRecord, Refusal } from './types.ts';

export type EventInput = EngineEvent extends infer E ? (E extends EngineEvent ? Omit<E, 'seq' | 'at'> : never) : never;

export class RefusalError extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
    this.name = 'RefusalError';
  }
}

/** Refuses the command: plain language first, then the rule code and the controls it protects. */
export function refuse(code: string, text: string, controls: readonly string[]): never {
  throw new RefusalError({ code, message: `${text} (${code}; ${controls.join(', ')})`, controls: [...controls] });
}

export function ctxKey(frames: readonly Frame[]): string {
  return contextKey(frames);
}

export function stepKey(step: string, frames: readonly Frame[]): string {
  return `${step}@${contextKey(frames)}`;
}

export function cloneState(s: BatchState): BatchState {
  return structuredClone(s);
}

export class Tx {
  readonly events: EngineEvent[] = [];

  constructor(
    readonly def: BatchDefinition,
    public s: BatchState,
    /** Trusted time of the transaction (never earlier than the last time seen, for maximum checks). */
    readonly now: bigint,
    /** The clock as given (for minimum checks: a regressing clock never shortens a minimum). */
    readonly clockUs: bigint,
    readonly actor: Actor | undefined,
  ) {}

  get by(): string {
    return this.actor?.id ?? 'SYSTEM';
  }

  emit(e: EventInput): void {
    this.s.seq += 1;
    this.events.push({ ...e, seq: this.s.seq, at: this.now });
  }

  nextId(prefix: string): string {
    const n = (this.s.counters[prefix] ?? 0) + 1;
    this.s.counters[prefix] = n;
    return `${prefix}-${n}`;
  }

  /** Records an exception (never deleted; closed only by disposition, DI-26, INV-41). */
  raise(draft: ExceptionDraft, source: ExceptionRecord['source'], anchor?: { node: string; frames: readonly Frame[] }, extra: Partial<ExceptionRecord> = {}): string {
    const id = this.nextId('EX');
    const blocksStep = draft.blocks === 'STEP' || draft.blocks === 'STEP_AND_DOWNSTREAM';
    const blocksDown = draft.blocks === 'DOWNSTREAM' || draft.blocks === 'STEP_AND_DOWNSTREAM';
    const rec: ExceptionRecord = {
      id,
      type: draft.type,
      category: draft.category,
      title: draft.title,
      controls: [...draft.controls],
      severity: draft.severity,
      source: { ...source, frames: [...source.frames] },
      raisedAt: this.now,
      raisedSeq: this.s.seq + 1,
      raisedBy: this.by,
      deviationRequired: draft.deviationRequired ?? false,
      registrationRelevant: draft.registrationRelevant ?? false,
      qaOnly: draft.qaOnly ?? false,
      stageSignOffBlocked: draft.registrationRelevant ?? false,
      releaseBlocking: draft.releaseBlocking ?? false,
      status: 'OPEN',
      ...extra,
    };
    if (draft.item !== undefined) rec.source.item = draft.item;
    if (blocksStep || blocksDown) {
      rec.block = { steps: blocksStep && source.stepKey !== undefined ? [source.stepKey] : [], until: draft.until ?? 'DEVIATION' };
      if (blocksDown && anchor) rec.block.downstream = { node: anchor.node, frames: [...anchor.frames] };
    }
    this.s.exceptions[id] = rec;
    const ev: EventInput = { type: 'EXCEPTION_RAISED', exception: id, exceptionType: rec.type, severity: rec.severity, title: rec.title, controls: rec.controls };
    if (rec.tier !== undefined) (ev as { tier?: string }).tier = rec.tier;
    this.emit(ev);
    return id;
  }
}
