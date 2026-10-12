/**
 * The reads of the review feature (Phase 4 slice 1): the queue, one record in review and the audit-trail report. The
 * database decides every state and gate (recipe.batch_review_state, recipe.review_gate_problems, the audit-trail report);
 * this module only shapes what it says into the contract's views.
 */
import type pg from 'pg';
import type { AuditTrailReportView, BatchReviewView, ReviewSummaryView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;
type State = ReviewSummaryView['reviewState'];

const SUMMARY_SQL = `
  select b.id, b.batch_number, f.record_kind, f.product_code || ' ' || f.strength as product, s.status,
         recipe.batch_review_state(b.id) as review_state, recipe.batch_review_cycle(b.id) as cycle, b.market_set as markets
    from recipe.batch_execution b
    join recipe.execution_state s on s.batch_id = b.id
    join recipe.stub_batch sb on sb.id = b.id
    join recipe.mbr_family f on f.id = sb.family_id
   where b.purpose = 'GMP_BATCH'`;

interface SummaryRow {
  id: string;
  batch_number: string;
  record_kind: 'PROCESSING' | 'PACKAGING';
  product: string;
  status: string;
  review_state: State;
  cycle: number;
  markets: string[];
}

const summaryOf = (r: SummaryRow): ReviewSummaryView => ({
  batchId: r.id,
  batchNumber: r.batch_number,
  recordKind: r.record_kind,
  product: r.product,
  executionStatus: r.status,
  reviewState: r.review_state,
  cycle: r.cycle,
  markets: [...r.markets].sort(),
});

/** GMP records at or after EXECUTION_COMPLETE (or ABORTED), optionally in one review state. */
export async function reviewQueue(db: Db, state: State | undefined): Promise<ReviewSummaryView[]> {
  const { rows } = await db.query<SummaryRow>(`${SUMMARY_SQL} and s.status in ('EXECUTION_COMPLETE', 'ABORTED') order by b.batch_number`);
  return rows.map(summaryOf).filter((r) => state === undefined || r.reviewState === state);
}

async function summary(db: Db, batchId: string): Promise<SummaryRow> {
  const { rows } = await db.query<SummaryRow>(`${SUMMARY_SQL} and b.id = $1`, [batchId]);
  const r = rows[0];
  if (!r) throw refusal(404, { code: 'EBMR-REV-NO-BATCH', kind: 'INVALID_INPUT', whatHappened: 'There is no GMP batch record with this id.', why: `Batch ${batchId} is not a GMP batch.`, whatYouCanDo: ['Open the review queue.'] });
  return r;
}

const gate = (problems: readonly string[]): { ready: boolean; problems: string[] } => ({ ready: problems.length === 0, problems: [...problems] });

/** One record in review: its state, cycle, epoch, signed acts and the database's reasons why each act is not possible yet. */
export async function batchReview(app: AppContext, db: Db, batchId: string): Promise<BatchReviewView> {
  const s = await summary(db, batchId);
  const { rows: epochRows } = await db.query<{ v: string }>("select recipe.epoch_of('BATCH', $1)::text as v", [batchId]);
  const { rows: acts } = await db.query<{ act: BatchReviewView['acts'][number]['act']; cycle: number; person_id: string; role_code: string; us: string; signature_id: string; reason: string | null; valid: boolean }>(
    `select a.act, a.cycle, a.person_id, a.role_code, ${usOf('a.recorded_at')} as us, a.signature_id, a.reason,
            coalesce((esig.signature_state(a.signature_id) ->> 'valid')::boolean, false) as valid
       from recipe.batch_review_act a where a.batch_id = $1 order by a.recorded_at, a.id`,
    [batchId],
  );
  const { rows: items } = await db.query<{ total: number; open: number; concluded: number; critical: number }>(
    `select count(*)::int as total,
            count(*) filter (where not exists (select 1 from recipe.exception_register_act x where x.batch_id = r.batch_id and x.exception_id = r.exception_id
                                                 and x.act in ('ACCEPTED_BY_QA', 'ESCALATED')))::int as open,
            count(*) filter (where exists (select 1 from recipe.exception_register_act x where x.batch_id = r.batch_id and x.exception_id = r.exception_id
                                             and x.act in ('ACCEPTED_BY_QA', 'ESCALATED')))::int as concluded,
            count(*) filter (where r.severity = 'CRITICAL' or r.qa_only or r.registration_relevant)::int as critical
       from recipe.exception_register r where r.batch_id = $1`,
    [batchId],
  );
  const people = await peopleOf(db, acts.map((a) => a.person_id));
  const notYet = ['The review acts arrive with Phase 4 slice 1a.'];
  return {
    ...summaryOf(s),
    epoch: epochRows[0]?.v ?? '0',
    mode: 'FULL',
    pausedSteps: [],
    acts: acts.map((a) => ({
      act: a.act,
      cycle: a.cycle,
      by: personRef(people, a.person_id, a.role_code),
      at: app.formatInstant(a.us),
      signatureId: a.signature_id,
      valid: a.valid,
      reason: a.reason,
    })),
    gates: { productionApprove: gate(notYet), auditTrailReview: gate(notYet), qaReview: gate(notYet), reopen: gate(notYet) },
    items: items[0] ?? { total: 0, open: 0, concluded: 0, critical: 0 },
    abortChecklist: null,
    freeText: [],
    signable: { aggregateType: 'batch_review', aggregateId: batchId },
  };
}

/** The audit-trail report of the record (slice 1a fills it from recipe.audit_review_report). */
export async function auditTrailReport(db: Db, batchId: string): Promise<AuditTrailReportView> {
  await summary(db, batchId);
  return {
    batchId,
    reviewId: `${batchId}/1`,
    kind: 'FULL',
    fromMark: null,
    highWater: {},
    scope: [],
    events: [],
    eventCount: 0,
    truncated: false,
    reportHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    covered: false,
  };
}
