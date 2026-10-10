/**
 * One command's work on a stored batch: the engine and the store in one transaction (Phase 2 apps plan
 * section 7, "Command flow"). `ExecutionTx.open` locks the batch and takes the trusted time; `command`,
 * `prepare` and `sweep` run the pure engine at that time and append what it decided (refusals too), with
 * the signable content that changed. The definition must be the batch's own: same content, engine
 * version, block registry and pinned policy (ADR 0010), otherwise nothing runs.
 */
import { randomUUID } from 'node:crypto';
import { encode, encodeCommand, hashJson, type JsonValue } from '../engine/codec.ts';
import type { BatchDefinition } from '../engine/definition.ts';
import type { MbrContent } from '../flow/model.ts';
import { issue, prepareForSignature, step, sweep, type SignatureTarget } from '../engine/engine.ts';
import { aggregateContent, changedContents, signingContents, touchedAggregates, type AggregateContent } from '../engine/signing-content.ts';
import { ENGINE_VERSION, type Actor, type BatchState, type Command, type EngineEvent, type EnginePolicy, type IssueRequest, type StepResult } from '../engine/types.ts';
import { appendExecution, beginGmpIssue, beginIssue, ExecutionStoreError, issueExecution, issueGmpExecution, loadContentHead, lockExecution, type LockedExecution, type Queryable, type RoleEvidence } from './store.ts';

/** The engine policy as pinned in a batch (JSON; bigint durations tagged by the codec). */
export function pinnedPolicy(policy: EnginePolicy): JsonValue {
  return encode(policy);
}

export function policyHash(policy: EnginePolicy): string {
  return hashJson(pinnedPolicy(policy));
}

/** Refuses a definition that is not the one the batch was issued with (ADR 0010). */
export function assertDefinitionFits(def: BatchDefinition, locked: Pick<LockedExecution, 'batch'>): void {
  const b = locked.batch;
  if (def.contentHash !== b.contentHash) throw new ExecutionStoreError('EBMR-EXE-060', `The definition runs MBR content ${def.contentHash.slice(0, 12)}, but the batch pinned ${b.contentHash.slice(0, 12)}`);
  if (b.engineVersion !== ENGINE_VERSION) throw new ExecutionStoreError('EBMR-EXE-061', `The batch was issued with engine ${b.engineVersion}; this server runs engine ${ENGINE_VERSION} and never runs or replays it with another engine (ADR 0010)`);
  if (def.registry.fingerprint() !== b.registryFingerprint) throw new ExecutionStoreError('EBMR-EXE-062', 'The block versions of this server differ from those the batch was issued with (ADR 0010)');
  if (policyHash(def.policy) !== b.policyHash) throw new ExecutionStoreError('EBMR-EXE-063', 'The engine policy differs from the policy pinned at issue');
  if (def.installation !== b.installation) throw new ExecutionStoreError('EBMR-EXE-064', `A ${b.installation} batch executes only a definition made for that installation, not one for ${def.installation} (DI-05, INV-18)`);
}

export class ExecutionTx {
  private contents: Map<string, AggregateContent> | undefined;

  private constructor(
    readonly client: Queryable,
    readonly def: BatchDefinition,
    readonly locked: LockedExecution,
    public state: BatchState,
    public lastSeq: bigint,
  ) {}

  /** Locks the batch (FOR UPDATE), takes the transaction's trusted time and checks the definition fits. */
  static async open(client: Queryable, def: BatchDefinition, batchId: string): Promise<ExecutionTx> {
    const locked = await lockExecution(client, batchId);
    assertDefinitionFits(def, locked);
    return new ExecutionTx(client, def, locked, locked.state, locked.lastSeq);
  }

  /** The sweeper's open: undefined when another command holds the batch (FOR UPDATE SKIP LOCKED). */
  static async tryOpen(client: Queryable, def: BatchDefinition, batchId: string): Promise<ExecutionTx | undefined> {
    const locked = await lockExecution(client, batchId, true);
    if (!locked) return undefined;
    assertDefinitionFits(def, locked);
    return new ExecutionTx(client, def, locked, locked.state, locked.lastSeq);
  }

  get nowUs(): bigint {
    return this.locked.nowUs;
  }

  /** Signable content of the current state (cached per state). */
  currentContents(): Map<string, AggregateContent> {
    this.contents ??= signingContents(this.def, this.state);
    return this.contents;
  }

  private async append(kind: 'COMMAND' | 'PREPARE' | 'SWEEP', command: JsonValue, commandId: string, r: { state: BatchState; events: EngineEvent[]; accepted: boolean; refusal?: StepResult['refusal'] }, roles: readonly RoleEvidence[], evidence?: JsonValue): Promise<void> {
    const before = this.state;
    const contents = changedContents(this.def, before, r.state);
    // The first content version of a phase instance a person works on (storedOnCreation).
    if (r.accepted && kind !== 'SWEEP' && typeof command === 'object' && command !== null && !Array.isArray(command)) {
      for (const t of touchedAggregates(command as { type: string })) {
        if (contents.some((c) => c.type === t.type && c.key === t.key)) continue;
        const c = aggregateContent(this.def, r.state, t.type, t.key);
        if (c && !(await loadContentHead(this.client, t.type, this.locked.batch.id, t.key))) contents.push(c);
      }
    }
    const res = await appendExecution(this.client, {
      batchId: this.locked.batch.id,
      expectedSeq: this.lastSeq,
      kind,
      command,
      commandId,
      nowUs: this.nowUs,
      accepted: r.accepted,
      refusal: r.refusal,
      state: r.state,
      events: r.events,
      roles,
      contents,
      ...(evidence !== undefined ? { evidence } : {}),
    });
    this.state = r.state;
    this.lastSeq = res.seq;
    this.contents = undefined;
  }

  /** Runs an engine command and appends it, accepted or refused (a duplicate command id is refused). */
  async command(command: Command, roles: readonly RoleEvidence[], evidence?: JsonValue): Promise<StepResult> {
    const r = step(this.def, this.state, command, { nowUs: this.nowUs });
    if (r.duplicate) throw new ExecutionStoreError('EBMR-EXE-024', `Command ${command.commandId} was already applied`);
    await this.append('COMMAND', encodeCommand(command), command.commandId, r, roles, evidence);
    return r;
  }

  /** The command's result without storing it (a dry run at the trusted time). */
  dryRun(command: Command): StepResult {
    return step(this.def, this.state, command, { nowUs: this.nowUs });
  }

  /**
   * The system facts a signing command sees (sweep, and finalisation for PERFORMED), appended as a PREPARE
   * row when they produced events. `meaning` is the signature meaning being prepared for (the database
   * checks the permission of that meaning, e.g. STEP.WITNESS for a WITNESSED verification). Returns whether
   * a row was written.
   */
  async prepare(target: SignatureTarget, actor: Actor, roles: readonly RoleEvidence[], meaning?: string): Promise<boolean> {
    const p = prepareForSignature(this.def, this.state, target, actor, { nowUs: this.nowUs });
    if (!p.changed) return false;
    await this.append('PREPARE', encode({ type: 'PREPARE', target, actor, ...(meaning !== undefined ? { meaning } : {}) }), `PREPARE:${randomUUID()}`, { state: p.state, events: p.events, accepted: true }, roles);
    return true;
  }

  /** The time sweep (INV-20), appended as a SWEEP row only when it produced events. */
  async sweep(): Promise<EngineEvent[]> {
    const r = sweep(this.def, this.state, { nowUs: this.nowUs });
    if (r.events.length === 0) return [];
    await this.append('SWEEP', encode({ type: 'SWEEP' }), `SWEEP:${randomUUID()}`, { state: r.state, events: r.events, accepted: true }, []);
    return r.events;
  }
}

export interface IssueBatchInput {
  def: BatchDefinition;
  batchId: string;
  packageHash: string;
  /** The request without batch id and number (the database allocates the TEST- number). */
  request: Omit<IssueRequest, 'batchId' | 'batchNumber'>;
  evidence?: JsonValue;
}

/**
 * Issues a test batch (G-01 at the trusted time): the database allocates the TEST- number and the clock,
 * the engine checks the header and enables the first steps, and the ISSUE row pins the content, engine
 * version, block registry and policy.
 */
export async function issueBatch(client: Queryable, input: IssueBatchInput): Promise<{ batchNumber: string; state: BatchState; events: EngineEvent[]; nowUs: bigint }> {
  if (input.def.installation !== 'SANDBOX') throw new ExecutionStoreError('EBMR-EXE-064', 'Test runs execute only definitions made for the sandbox (DI-05, INV-18)');
  const begun = await beginIssue(client, input.batchId);
  const request: IssueRequest = { ...input.request, batchId: input.batchId, batchNumber: begun.batchNumber };
  const r = issue(input.def, request, { nowUs: begun.nowUs });
  await issueExecution(client, {
    batchId: input.batchId,
    packageHash: input.packageHash,
    batchNumber: begun.batchNumber,
    request: encode(request),
    policy: pinnedPolicy(input.def.policy),
    registryFingerprint: input.def.registry.fingerprint(),
    engineVersion: ENGINE_VERSION,
    nowUs: begun.nowUs,
    state: r.state,
    events: r.events,
    contents: changedContents(input.def, undefined, r.state),
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
  });
  return { batchNumber: begun.batchNumber, state: r.state, events: r.events, nowUs: begun.nowUs };
}

export interface IssueGmpBatchInput {
  batchId: string;
  /** The issuer's ISSUED signature on aggregate `batch_issue` of this batch, made in this command. */
  signatureId: string;
  /** The batch definition of the control recipe's MBR content, made for the GMP installation. */
  define: (content: MbrContent) => BatchDefinition;
  /** The request without batch id, number, market set and batch size (the database gives them: the pinned batch). */
  request: Omit<IssueRequest, 'batchId' | 'batchNumber' | 'marketSet' | 'batchSize'>;
  evidence?: JsonValue;
}

/**
 * Issues a planned GMP batch (recipe-core 0501) in the command that signs it ISSUED: the database gives the trusted time,
 * the register number, the pinned market set and batch size and the control recipe; the engine issues the batch from the
 * control recipe's MBR content; the ISSUE row pins the control recipe, engine version, block registry and policy.
 */
export async function issueGmpBatch(client: Queryable, input: IssueGmpBatchInput): Promise<{ batchNumber: string; state: BatchState; events: EngineEvent[]; nowUs: bigint; def: BatchDefinition }> {
  const begun = await beginGmpIssue(client, input.batchId);
  const snapshot = begun.snapshot as { mbr?: { content?: MbrContent } } | null;
  const content = snapshot?.mbr?.content;
  if (!content) throw new ExecutionStoreError('EBMR-EXE-192', 'The control recipe holds no MBR content');
  const def = input.define(content);
  if (def.installation !== 'GMP') throw new ExecutionStoreError('EBMR-EXE-064', 'A GMP batch executes only a definition made for the GMP installation (DI-05, INV-18)');
  if (def.contentHash !== begun.contentHash) throw new ExecutionStoreError('EBMR-EXE-060', `The definition runs MBR content ${def.contentHash.slice(0, 12)}, but the control recipe holds ${begun.contentHash.slice(0, 12)}`);
  const request: IssueRequest = { ...input.request, batchId: input.batchId, batchNumber: begun.batchNumber, marketSet: begun.marketSet, batchSize: begun.batchSize };
  const r = issue(def, request, { nowUs: begun.nowUs });
  await issueGmpExecution(client, {
    batchId: input.batchId,
    signatureId: input.signatureId,
    batchNumber: begun.batchNumber,
    request: encode(request),
    policy: pinnedPolicy(def.policy),
    registryFingerprint: def.registry.fingerprint(),
    engineVersion: ENGINE_VERSION,
    nowUs: begun.nowUs,
    state: r.state,
    events: r.events,
    contents: changedContents(def, undefined, r.state),
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
  });
  return { batchNumber: begun.batchNumber, state: r.state, events: r.events, nowUs: begun.nowUs, def };
}
