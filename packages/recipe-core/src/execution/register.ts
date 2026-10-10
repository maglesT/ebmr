/**
 * The exception register of a test batch (recipe-core sql/0440; outline 5.2.4; DI-26, PR-08, INV-41): one insert-only
 * row per exception, written by the database with the engine row that raised it, and its acts (deviation link,
 * disposition, QA review). The engine's state stays the source of the run; the register is what review by exception
 * reads, and the database keeps the two in step.
 */
import type { Queryable } from './store.ts';

export type ExceptionReviewAct = 'QUERIED' | 'RESPONDED' | 'ACCEPTED_BY_QA' | 'ESCALATED';

export interface RegisteredException {
  exceptionId: string;
  exceptionType: string;
  category: string;
  severity: 'ALERT' | 'ACTION' | 'CRITICAL';
  tier: 'REGISTERED' | 'VALIDATED' | 'INTERNAL_ACTION' | 'ALERT' | null;
  title: string;
  mandatory: boolean;
  qaOnly: boolean;
  deviationRequired: boolean;
  registrationRelevant: boolean;
  releaseBlocking: boolean;
  raisingStepKey: string | null;
  raisedAt: string;
  raisedBy: string;
  rowSeq: string;
  status: 'OPEN' | 'DISPOSITIONED';
  deviationRef: string | null;
  dispositionOutcome: 'NO_IMPACT' | 'DEVIATION_RAISED' | null;
  dispositionedBy: string | null;
  dispositionSignature: string | null;
  reviewState: 'NOT_REVIEWED' | ExceptionReviewAct;
  escalatedTo: string | null;
  blocking: boolean;
}

/** The register of a batch for review by exception (view recipe.exception_register_review), in exception id order. */
export async function loadExceptionRegister(db: Queryable, batchId: string): Promise<RegisteredException[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `select exception_id, exception_type, category, severity, tier, title, mandatory, qa_only, deviation_required, registration_relevant, release_blocking,
            raising_step_key, raised_at::text as raised_at, raised_by, row_seq::text as row_seq, status, deviation_ref, disposition_outcome,
            dispositioned_by::text as dispositioned_by, disposition_signature::text as disposition_signature, review_state, escalated_to, blocking
       from recipe.exception_register_review where batch_id = $1 order by exception_id`,
    [batchId],
  );
  return rows.map((r) => ({
    exceptionId: r['exception_id'] as string,
    exceptionType: r['exception_type'] as string,
    category: r['category'] as string,
    severity: r['severity'] as RegisteredException['severity'],
    tier: r['tier'] as RegisteredException['tier'],
    title: r['title'] as string,
    mandatory: r['mandatory'] as boolean,
    qaOnly: r['qa_only'] as boolean,
    deviationRequired: r['deviation_required'] as boolean,
    registrationRelevant: r['registration_relevant'] as boolean,
    releaseBlocking: r['release_blocking'] as boolean,
    raisingStepKey: r['raising_step_key'] as string | null,
    raisedAt: r['raised_at'] as string,
    raisedBy: r['raised_by'] as string,
    rowSeq: r['row_seq'] as string,
    status: r['status'] as RegisteredException['status'],
    deviationRef: r['deviation_ref'] as string | null,
    dispositionOutcome: r['disposition_outcome'] as RegisteredException['dispositionOutcome'],
    dispositionedBy: r['dispositioned_by'] as string | null,
    dispositionSignature: r['disposition_signature'] as string | null,
    reviewState: r['review_state'] as RegisteredException['reviewState'],
    escalatedTo: r['escalated_to'] as string | null,
    blocking: r['blocking'] as boolean,
  }));
}

/**
 * Records a QA review act on a registered exception (recipe.review_exception): QUERIED and RESPONDED with their text,
 * ACCEPTED_BY_QA of a dispositioned exception, ESCALATED to a deviation reference. Run inside the person's command.
 */
export async function reviewException(client: Queryable, batchId: string, exceptionId: string, act: ExceptionReviewAct, note: string | null, deviationRef: string | null = null): Promise<string> {
  const { rows } = await client.query<{ id: string }>('select recipe.review_exception($1, $2, $3, $4, $5)::text as id', [batchId, exceptionId, act, note, deviationRef]);
  return rows[0]?.id ?? '';
}
