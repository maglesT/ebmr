/**
 * The review-priority read (Phase 6A slice 6A-5; contract ns/analytics-review.ts; draft control PR-61): the latest
 * REVIEW_PRIORITY output of a GMP batch record, from analytics.review_priority_v1 with its run's data_as_of
 * (analytics.output_v1). The score is the database's double precision as a JSON number (StatNumber); every instant is
 * the database's. Nothing here writes.
 */
import type pg from 'pg';
import { ReviewPriority, type ReviewPriorityView } from '@ebmr/api-contract';
import type { AppContext } from '../../../platform/context.ts';
import { usOf } from '../../common/people.ts';
import { auditPointsOf, holdsDiReview, priorityForViewer } from '../../common/review-priority.ts';
import { envelope } from '../reads.ts';

type Db = Pick<pg.Pool | pg.PoolClient, 'query'>;

/** Whether `batchId` is a GMP batch record (the priority is about batch records only). */
export async function isGmpRecord(db: Db, batchId: string): Promise<boolean> {
  const { rows } = await db.query("select 1 from recipe.batch_execution where id = $1 and installation = 'GMP' and purpose = 'GMP_BATCH'", [batchId]);
  return rows.length > 0;
}

interface Row {
  run_id: string;
  method: string;
  version: number;
  score: number | null;
  reasons: unknown;
  values: unknown;
  scored_us: string;
  as_of_us: string | null;
  finished_us: string;
  age: number | null;
}

/**
 * The record's review priority with its envelope; priority null (and no method or run) for an unscored record. Without
 * ANALYTICS.DI_REVIEW the score is shown without its audit-trail term (D-6A-5-4; DI-53).
 */
export async function priorityView(app: AppContext, db: Pick<pg.PoolClient, 'query'>, batchId: string): Promise<ReviewPriorityView> {
  const { rows } = await db.query<Row>(
    `select p.run_id::text, p.method, p.version, p.score, p.reasons, o."values", ${usOf('p.scored_at')} as scored_us,
            case when o.data_as_of is null then null else ${usOf('o.data_as_of')} end as as_of_us, ${usOf('p.finished_at')} as finished_us,
            greatest(0, floor(extract(epoch from statement_timestamp() - o.data_as_of)))::integer as age
       from analytics.review_priority_v1 p
       left join analytics.output_v1 o on o.output_id = p.output_id
      where p.batch_ref = $1 and p.method = 'REVIEW.PRIORITY'`,
    [batchId],
  );
  const r = rows[0];
  const parsed = r === undefined ? null
    : ReviewPriority.safeParse({ score: r.score, reasons: r.reasons, methodVersion: { id: r.method, version: r.version }, scoredAt: app.formatInstant(r.scored_us) });
  if (r === undefined || parsed === null || !parsed.success) return { ...envelope(), batchId, priority: null };
  return {
    ...envelope(r.age ?? 0),
    method: parsed.data.methodVersion,
    run: { id: r.run_id, dataAsOf: app.formatInstant(r.as_of_us ?? r.finished_us), finishedAt: app.formatInstant(r.finished_us) },
    batchId,
    priority: priorityForViewer(parsed.data, auditPointsOf(r.values), await holdsDiReview(db)),
  };
}
