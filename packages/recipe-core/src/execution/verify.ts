/**
 * Verification of a stored batch by replay (Phase 2 apps plan section 7, "Replay"; DI-34, INV-19,
 * INV-20, INV-25; ADR 0010): the stored rows are re-executed with the pure engine at their stored clocks,
 * and the result must equal what was stored row for row (accepted flag, events hash, state hash), the
 * stored state must be the last row's, and the latest signable content of every aggregate must be the
 * content of that state (so no signature can be valid on content the engine state does not have). A batch
 * pinned to another engine version or block registry is refused, never replayed with this engine.
 */
import { stateHash } from '../engine/codec.ts';
import type { BatchDefinition } from '../engine/definition.ts';
import { replay, type ReplayDifference } from '../engine/replay.ts';
import { signingContents } from '../engine/signing-content.ts';
import { assertDefinitionFits } from './run.ts';
import { loadBatch, loadContentHeads, loadRows, loadState, ExecutionStoreError, type Queryable } from './store.ts';

export interface VerificationReport {
  batchId: string;
  identical: boolean;
  rows: number;
  firstDifference: ReplayDifference | null;
  invariantViolations: string[];
  /** Differences between the stored signable content and the content of the replayed state. */
  contentProblems: string[];
}

export async function replayExecution(db: Queryable, def: BatchDefinition, batchId: string): Promise<VerificationReport> {
  const batch = await loadBatch(db, batchId);
  if (!batch) throw new ExecutionStoreError('EBMR-EXE-010', 'There is no test batch with this id');
  assertDefinitionFits(def, { batch });
  const rows = await loadRows(db, batchId);
  const r = replay(def, rows);
  const contentProblems: string[] = [];
  if (r.identical && r.state) {
    const stored = await loadState(db, batchId);
    if (!stored || stored.stateHash !== stateHash(r.state)) contentProblems.push('the stored state is not the state the rows produce');
    const heads = await loadContentHeads(db, batchId);
    const expected = signingContents(def, r.state);
    for (const [k, c] of expected) {
      const h = heads.get(k);
      const unstarted = c.type === 'batch_step' && r.state.steps[c.key]?.kind === 'PHASE' && ['PENDING', 'ENABLED'].includes(r.state.steps[c.key]?.status ?? '');
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
