/**
 * The reads of the review feature (Phase 4 slice 1): the queue, one record in review, its exception register, an item's
 * detail and the audit-trail report. The database decides every state and gate (recipe.batch_review_state,
 * recipe.review_gate_problems, the audit-trail scope and mark of recipe-core 0711); this module only shapes what it says
 * into the contract's views.
 */
import type pg from 'pg';
import type { AuditTrailReportView, BatchReviewView, ItemDetailView, ReviewItemView, ReviewSummaryView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;
type State = ReviewSummaryView['reviewState'];
type People = Awaited<ReturnType<typeof peopleOf>>;

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
  if (!r) throw refusal(404, { code: 'EBMR-REV-001', kind: 'INVALID_INPUT', whatHappened: 'There is no GMP batch record with this id.', why: `Batch ${batchId} is not a GMP batch.`, whatYouCanDo: ['Open the review queue.'] });
  return r;
}

async function gate(db: Db, batchId: string, act: string): Promise<{ ready: boolean; problems: string[] }> {
  const { rows } = await db.query<{ p: string[] }>('select recipe.review_gate_problems($1, $2) as p', [batchId, act]);
  const problems = rows[0]?.p ?? [];
  return { ready: problems.length === 0, problems };
}

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
            count(*) filter (where recipe.review_item_status(r.batch_id, r.exception_id) not in ('ACCEPTED', 'ESCALATED'))::int as open,
            count(*) filter (where recipe.review_item_status(r.batch_id, r.exception_id) in ('ACCEPTED', 'ESCALATED'))::int as concluded,
            count(*) filter (where recipe.review_item_critical(r))::int as critical
       from recipe.exception_register r where r.batch_id = $1`,
    [batchId],
  );
  const { rows: texts } = await db.query<{
    source_ref: string; source: string; body: string; needs: boolean; tid: string | null; english: string | null; tby: string | null; vby: string | null; vus: string | null;
  }>(
    `select f.source_ref, f.source, f.body, (b.market_set && array['US', 'EU'] and recipe.text_needs_translation(f.body)) as needs,
            t.id as tid, t.english, t.translated_by as tby, t.verified_by as vby, case when t.verified_at is null then null else ${usOf('t.verified_at')} end as vus
       from recipe.batch_execution b cross join recipe.batch_free_text(b.id) f
       left join lateral recipe.latest_translation(b.id, f.source_ref) t on true
      where b.id = $1 order by f.source_ref`,
    [batchId],
  );
  const { rows: ck } = await db.query<{ m: string; o: string; e: string; g: string; c: string; person_id: string; role_code: string; us: string }>(
    `select materials_accounted as m, outputs_dispositioned as o, equipment_dirty as e, genealogy_closed as g, contingency_reconciled as c,
            person_id, role_code, ${usOf('recorded_at')} as us from recipe.abort_checklist where batch_id = $1`,
    [batchId],
  );
  const { rows: paused } = await db.query<{ step_id: string; n: number; id: string }>(
    `select t.step_id, cardinality(t.deviation_refs) as n, t.id from recipe.rbe_rereview_task t join recipe.stub_batch sb on sb.family_id = t.family_id
      where sb.id = $1 order by t.step_id`,
    [batchId],
  );
  const people = await peopleOf(db, [...acts.map((a) => a.person_id), ...texts.flatMap((t) => [t.tby, t.vby]), ...ck.map((c) => c.person_id)]);
  const c = ck[0];
  return {
    ...summaryOf(s),
    epoch: epochRows[0]?.v ?? '0',
    mode: 'FULL',
    pausedSteps: paused.map((p) => ({ stepId: p.step_id, deviations: p.n, taskId: p.id })),
    acts: acts.map((a) => ({
      act: a.act,
      cycle: a.cycle,
      by: personRef(people, a.person_id, a.role_code),
      at: app.formatInstant(a.us),
      signatureId: a.signature_id,
      valid: a.valid,
      reason: a.reason,
    })),
    gates: {
      productionApprove: await gate(db, batchId, 'PRODUCTION_APPROVE'),
      auditTrailReview: await gate(db, batchId, 'AUDIT_TRAIL_REVIEW'),
      qaReview: await gate(db, batchId, 'QA_REVIEW'),
      reopen: await gate(db, batchId, 'REOPEN'),
    },
    items: items[0] ?? { total: 0, open: 0, concluded: 0, critical: 0 },
    abortChecklist: c
      ? {
          materialsAccounted: c.m,
          outputsDispositioned: c.o,
          equipmentDirty: c.e,
          genealogyClosed: c.g,
          contingencyReconciled: c.c,
          recordedBy: personRef(people, c.person_id, c.role_code),
          recordedAt: app.formatInstant(c.us),
        }
      : null,
    freeText: texts.map((t) => ({
      sourceRef: t.source_ref,
      source: t.source,
      text: t.body,
      needsTranslation: t.needs,
      translation:
        t.tid && t.english && t.tby
          ? {
              translationId: t.tid,
              english: t.english,
              translatedBy: personRef(people, t.tby, 'TRANSLATOR'),
              verifiedBy: t.vby ? personRef(people, t.vby, 'VERIFIER') : null,
              verifiedAt: t.vus ? app.formatInstant(t.vus) : null,
            }
          : null,
    })),
    signable: { aggregateType: 'batch_review', aggregateId: batchId },
  };
}

interface ItemRow {
  exception_id: string;
  exception_type: string;
  category: string;
  severity: ReviewItemView['severity'];
  critical: boolean;
  raising_step_key: string | null;
  title: string;
  us: string;
  disp_outcome: 'NO_IMPACT' | 'DEVIATION_RAISED' | null;
  disp_by: string | null;
  disp_role: string | null;
  disp_note: string | null;
  deviation_ref: string | null;
  status: ReviewItemView['reviewStatus'];
  opened: boolean;
  paused: boolean;
}

const ITEMS_SQL = `
  select r.exception_id, r.exception_type, r.category, r.severity, recipe.review_item_critical(r) as critical, r.raising_step_key, r.title,
         ${usOf('r.raised_at')} as us, d.outcome as disp_outcome, d.by_person as disp_by, d.role_code as disp_role, d.note as disp_note,
         (select a.deviation_ref from recipe.exception_register_act a where a.batch_id = r.batch_id and a.exception_id = r.exception_id and a.act = 'DEVIATION_LINKED') as deviation_ref,
         recipe.review_item_status(r.batch_id, r.exception_id) as status,
         exists (select 1 from recipe.review_item_view v where v.batch_id = r.batch_id and v.exception_id = r.exception_id and v.person_id = $2) as opened,
         r.raising_step in (select recipe.rbe_paused_step(r.batch_id)) as paused
    from recipe.exception_register r
    left join recipe.exception_register_act d on d.batch_id = r.batch_id and d.exception_id = r.exception_id and d.act = 'DISPOSITIONED'
   where r.batch_id = $1`;

function itemOf(app: AppContext, people: People, r: ItemRow): ReviewItemView {
  return {
    exceptionId: r.exception_id,
    type: r.exception_type,
    category: r.category,
    severity: r.severity,
    critical: r.critical,
    stepKey: r.raising_step_key,
    title: r.title,
    raisedAt: app.formatInstant(r.us),
    engineDisposition: r.disp_outcome && r.disp_by ? { outcome: r.disp_outcome, by: personRef(people, r.disp_by, r.disp_role ?? ''), note: r.disp_note } : null,
    deviationRef: r.deviation_ref,
    reviewStatus: r.status,
    group: r.critical ? null : r.deviation_ref,
    detailOpened: r.opened,
    pausedStep: r.paused === true,
  };
}

export async function reviewItems(app: AppContext, db: Db, batchId: string, personId: string, only?: string): Promise<ReviewItemView[]> {
  await summary(db, batchId);
  const { rows } = await db.query<ItemRow>(`${ITEMS_SQL}${only === undefined ? '' : ' and r.exception_id = $3'} order by r.category, r.exception_id`, only === undefined ? [batchId, personId] : [batchId, personId, only]);
  const people = await peopleOf(db, rows.map((r) => r.disp_by));
  return rows.map((r) => itemOf(app, people, r));
}

export async function itemDetail(app: AppContext, db: Db, batchId: string, exceptionId: string, personId: string, openedUs: string): Promise<ItemDetailView> {
  const item = (await reviewItems(app, db, batchId, personId, exceptionId))[0];
  if (!item) throw refusal(404, { code: 'EBMR-REV-050', kind: 'INVALID_INPUT', whatHappened: 'The record has no such register item.', why: `Exception ${exceptionId} is not in batch ${batchId}.`, whatYouCanDo: ['Reload the register.'] });
  const { rows: rec } = await db.query<{ r: Record<string, unknown> }>('select raised_record as r from recipe.exception_register where batch_id = $1 and exception_id = $2', [batchId, exceptionId]);
  const { rows: acts } = await db.query<{ act: string; by_person: string; role_code: string; us: string; note: string | null }>(
    `select act, by_person, role_code, ${usOf('recorded_at')} as us, note from recipe.exception_register_act where batch_id = $1 and exception_id = $2 order by id`,
    [batchId, exceptionId],
  );
  const people = await peopleOf(db, acts.map((a) => a.by_person));
  return {
    item,
    raisedRecord: rec[0]?.r ?? {},
    acts: acts.map((a) => ({ act: a.act, by: personRef(people, a.by_person, a.role_code), at: app.formatInstant(a.us), note: a.note })),
    openedAt: app.formatInstant(openedUs),
  };
}

/** The audit-trail report: the events after the last mark of the cycle (all of them for the first review). */
export async function auditTrailReport(app: AppContext, db: Db, batchId: string, limit: number): Promise<AuditTrailReportView> {
  await summary(db, batchId);
  const { rows: last } = await db.query<{ review_number: number; high_water: Record<string, string> }>(
    `select a.review_number, a.high_water from recipe.batch_review_act a
      where a.batch_id = $1 and a.cycle = recipe.batch_review_cycle($1) and a.review_number is not null order by a.review_number desc limit 1`,
    [batchId],
  );
  const mark = last[0]?.high_water ?? null;
  const { rows: head } = await db.query<{ next: string; covered: boolean; hw: Record<string, string>; hash: string }>(
    'select recipe.audit_review_next_id($1) as next, recipe.audit_review_covered($1) as covered, recipe.audit_review_mark($1) as hw, recipe.audit_review_report_hash($1, $2::jsonb) as hash',
    [batchId, mark === null ? null : JSON.stringify(mark)],
  );
  const h = head[0];
  if (!h) throw new Error('the audit-trail report was not computed');
  const { rows: scope } = await db.query<{ chain_key: string; kind: AuditTrailReportView['scope'][number]['kind']; label: string }>(
    'select chain_key, kind, label from recipe.audit_review_scope_chains($1) order by kind, chain_key',
    [batchId],
  );
  const { rows: events } = await db.query<{ event_id: string; chain_key: string; seq: string; us: string; action: string; table_name: string | null; record_id: string | null; critical: boolean; linked: boolean; total: number }>(
    `select x.event_id::text, x.chain_key, x.seq::text, ${usOf('x.recorded_at')} as us, x.action, x.table_name, x.record_id, x.critical, x.linked,
            count(*) over ()::int as total
       from recipe.audit_review_events($1, $2::jsonb) x order by x.critical desc, x.recorded_at, x.event_id limit $3`,
    [batchId, mark === null ? null : JSON.stringify(mark), limit],
  );
  const total = events[0]?.total ?? 0;
  const covered = h.covered;
  return {
    batchId,
    reviewId: covered && last[0] ? `${batchId}/${String(last[0].review_number)}` : h.next,
    kind: last[0] ? 'DELTA' : 'FULL',
    fromMark: mark,
    highWater: h.hw,
    scope: scope.map((s) => ({ chainKey: s.chain_key, kind: s.kind, label: s.label })),
    events: events.map((e) => ({
      eventId: e.event_id,
      chainKey: e.chain_key,
      seq: e.seq,
      at: app.formatInstant(e.us),
      action: e.action,
      table: e.table_name,
      recordId: e.record_id,
      critical: e.critical,
      linked: e.linked,
    })),
    eventCount: total,
    truncated: total > events.length,
    reportHash: h.hash,
    covered,
  };
}
