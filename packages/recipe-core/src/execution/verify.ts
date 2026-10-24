/**
 * Verification of a stored batch by replay (Phase 2 apps plan section 7, "Replay"; DI-34, INV-19,
 * INV-20, INV-25; ADR 0010): the stored rows are re-executed with the pure engine at their stored clocks,
 * and the result must equal what was stored row for row (accepted flag, events hash, state hash), the
 * stored state must be the last row's, and the latest signable content of every aggregate must be the
 * content of that state (so no signature can be valid on content the engine state does not have). A batch
 * pinned to another engine version or block registry is refused, never replayed with this engine.
 *
 * Every stored content version is read too (Phase 2 exit review F12, the round-7 verification; DI-05, DI-30, DI-37;
 * decisions REPLAY-GATE.1 and F12.6): each must be the content of the replayed state at the row that stored it, and that
 * row must bring the record in or change it (or be a person's accepted command that first works on a phase, whose first
 * version is stored then: touchedAggregates). A version superseded before the replay is therefore compared as well; the
 * database (recipe-core sql 0338) holds only its key, members, header and identity.
 */
import { stateHash } from '../engine/codec.ts';
import type { BatchDefinition } from '../engine/definition.ts';
import { replay, type ExecutionRow, type ReplayDifference } from '../engine/replay.ts';
import { aggregateContent, signingContents, touchedAggregates } from '../engine/signing-content.ts';
import type { BatchState } from '../engine/types.ts';
import { assertDefinitionFits } from './run.ts';
import { loadBatch, loadContentHeads, loadContentVersions, loadRows, loadState, ExecutionStoreError, type ContentVersionRecord, type Queryable } from './store.ts';

export interface VerificationReport {
  batchId: string;
  identical: boolean;
  rows: number;
  firstDifference: ReplayDifference | null;
  invariantViolations: string[];
  /** Differences between the stored signable content (every version, and the latest of each record) and the content of the replayed state. */
  contentProblems: string[];
}

/** Why content version `v`, stored by `row`, is not what the row's replayed state (`before` it, `after` it) stores; undefined when it is. */
function versionProblem(def: BatchDefinition, row: ExecutionRow, before: BatchState | undefined, after: BatchState, v: ContentVersionRecord): string | undefined {
  const label = `${v.type}:${v.key} version ${v.version} (row ${row.seq})`;
  const c = aggregateContent(def, after, v.type, v.key);
  if (!c) return `${label} is stored but not part of the state at that row`;
  if (c.contentHash !== v.hash) return `${label}: the stored content is not the content of the state at that row`;
  const prior = before ? aggregateContent(def, before, v.type, v.key) : undefined;
  if (prior?.contentHash !== c.contentHash) return undefined;
  const command = row.command;
  const touched =
    v.version === 1 &&
    row.accepted &&
    row.kind !== 'SWEEP' &&
    typeof command === 'object' &&
    command !== null &&
    !Array.isArray(command) &&
    touchedAggregates(command as { type: string }).some((t) => t.type === v.type && t.key === v.key);
  return touched ? undefined : `${label}: the row neither brings it in nor changes it`;
}

export async function replayExecution(db: Queryable, def: BatchDefinition, batchId: string): Promise<VerificationReport> {
  const batch = await loadBatch(db, batchId);
  if (!batch) throw new ExecutionStoreError('EBMR-EXE-010', 'There is no test batch with this id');
  assertDefinitionFits(def, { batch });
  const rows = await loadRows(db, batchId);
  const byRow = new Map<bigint, ContentVersionRecord[]>();
  for (const v of await loadContentVersions(db, batchId)) byRow.set(v.rowSeq, [...(byRow.get(v.rowSeq) ?? []), v]);
  const versionProblems: string[] = [];
  const r = replay(def, rows, (row, before, after) => {
    for (const v of byRow.get(row.seq) ?? []) {
      const p = versionProblem(def, row, before, after, v);
      if (p !== undefined) versionProblems.push(p);
    }
  });
  const contentProblems: string[] = [];
  if (r.identical && r.state) {
    contentProblems.push(...versionProblems);
    const stored = await loadState(db, batchId);
    if (!stored || stored.stateHash !== stateHash(r.state)) contentProblems.push('the stored state is not the state the rows produce');
    const heads = await loadContentHeads(db, batchId);
    const expected = signingContents(def, r.state);
    for (const [k, c] of expected) {
      const h = heads.get(k);
      // A phase created not applicable (an untaken branch) is never worked on either (slice 7o, found by the R4 run).
      const unstarted = c.type === 'batch_step' && r.state.steps[c.key]?.kind === 'PHASE' && ['PENDING', 'ENABLED', 'NOT_APPLICABLE'].includes(r.state.steps[c.key]?.status ?? '');
      if (!h) {
        // A phase nobody has worked on yet is stored when it is first worked on (storedOnCreation).
        if (!unstarted) contentProblems.push(`${k} has no stored content`);
      } else if (h.hash !== c.contentHash) contentProblems.push(`${k}: the stored content is not the content of the state`);
    }
    for (const k of heads.keys()) if (!expected.has(k)) contentProblems.push(`${k} is stored but not part of the state`);
  }
  return {
    batchId,
    identical: r.identical && contentProblems.length === 0,
    rows: r.rows,
    firstDifference: r.firstDifference,
    invariantViolations: r.invariantViolations,
    contentProblems,
  };
}
