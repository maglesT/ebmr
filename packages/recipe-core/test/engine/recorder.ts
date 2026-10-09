/**
 * Test support for module C3: a recorder that drives the pure engine the way the execution store does
 * (an ISSUE row; a PREPARE row before a signed command when the sweep or the finalisation changed
 * something; the COMMAND row, refused or not; SWEEP rows when a sweep produced events) and keeps, per
 * signable aggregate, the content hash history, so a test can compute which signatures the e-signature
 * kernel would still hold valid (a signature stays valid until the content of its aggregate changes).
 */
import { encode, eventsHash, stateHash, type JsonValue } from '../../src/engine/codec.ts';
import type { BatchDefinition } from '../../src/engine/definition.ts';
import { issue, prepareForSignature, step, sweep } from '../../src/engine/engine.ts';
import type { ExecutionRow, ExecutionRowKind } from '../../src/engine/replay.ts';
import { signatureSubjects, signatureTargetOf, signingContents, type AggregateContent } from '../../src/engine/signing-content.ts';
import type { BatchState, Command, EngineEvent, IssueRequest, StepResult } from '../../src/engine/types.ts';

const SIGNED = new Set(['SIGN_PERFORMED', 'VERIFY', 'DISPOSITION_HOLD_POINT', 'SIGN_OFF_STAGE', 'DISPOSITION_EXCEPTION', 'CORRECT_ENTRY']);

export interface KernelSignature {
  id: string;
  aggregate: string;
  hash: string;
  valid: boolean;
}

export class Recorder {
  readonly rows: ExecutionRow[] = [];
  /** Signatures as the kernel would hold them. */
  readonly signatures = new Map<string, KernelSignature>();
  contents: Map<string, AggregateContent>;
  /** Violations of "an accepted signed command never changes the content it was signed on". */
  readonly invarianceBreaches: string[] = [];

  private constructor(
    readonly def: BatchDefinition,
    public state: BatchState,
  ) {
    this.contents = signingContents(def, state);
  }

  static issue(def: BatchDefinition, request: IssueRequest, nowUs: bigint): Recorder {
    const r = issue(def, request, { nowUs });
    const rec = new Recorder(def, r.state);
    rec.push('ISSUE', encode({ type: 'ISSUE', request }), nowUs, true, r.state, r.events);
    return rec;
  }

  private push(kind: ExecutionRowKind, command: JsonValue, nowUs: bigint, accepted: boolean, state: BatchState, events: EngineEvent[]): void {
    this.rows.push({ seq: BigInt(this.rows.length + 1), kind, command, nowUs, accepted, stateHash: stateHash(state), eventsHash: eventsHash(events) });
  }

  /** Moves to a new state: every kernel signature whose aggregate content changed is superseded (for good). */
  private settle(next: BatchState): void {
    const contents = signingContents(this.def, next);
    for (const sig of this.signatures.values()) {
      if (!sig.valid) continue;
      if (contents.get(sig.aggregate)?.contentHash !== sig.hash) sig.valid = false;
    }
    this.state = next;
    this.contents = contents;
  }

  /** One command as the store runs it (prepare for signed commands, then the command itself). */
  exec(command: Command, nowUs: bigint): StepResult {
    let signedOn = new Map<string, string>();
    if (SIGNED.has(command.type)) {
      const prep = prepareForSignature(this.def, this.state, signatureTargetOf(command), command.actor, { nowUs });
      if (prep.changed) {
        this.push('PREPARE', encode({ type: 'PREPARE', target: signatureTargetOf(command), actor: command.actor }), nowUs, true, prep.state, prep.events);
        this.settle(prep.state);
      }
      signedOn = new Map(signatureSubjects(this.state, command).map((s) => [s.signatureId, `${s.type}:${s.key}`]));
    }
    const r = step(this.def, this.state, command, { nowUs });
    if (r.duplicate) return r;
    this.push('COMMAND', encode(command), nowUs, r.accepted, r.state, r.events);
    const hashes = new Map([...signedOn.values()].map((agg) => [agg, this.contents.get(agg)?.contentHash ?? '(none)']));
    this.settle(r.state);
    if (r.accepted) {
      for (const [id, agg] of signedOn) {
        const signed = hashes.get(agg) ?? '(none)';
        const now = this.contents.get(agg)?.contentHash ?? '(none)';
        if (signed !== now) this.invarianceBreaches.push(`${command.type} ${id} on ${agg}`);
        this.signatures.set(id, { id, aggregate: agg, hash: signed, valid: signed === now });
      }
    }
    return r;
  }

  /** The time sweep as the store's sweeper runs it (a SWEEP row only when it produced events). */
  sweep(nowUs: bigint): EngineEvent[] {
    const r = sweep(this.def, this.state, { nowUs });
    if (r.events.length > 0) {
      this.push('SWEEP', encode({ type: 'SWEEP' }), nowUs, true, r.state, r.events);
      this.settle(r.state);
    }
    return r.events;
  }

  /** Ids of the signatures the kernel would hold valid. */
  kernelValid(): string[] {
    return [...this.signatures.values()].filter((s) => s.valid).map((s) => s.id).sort();
  }
}
