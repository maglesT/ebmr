/**
 * The facts of a batch the archive feature needs (Phase 4 slice 6b): its number and status, and the retention facts
 * (kernel records/batch-retention.ts) read from the batch's record: the issue date in the site's zone, the market set,
 * the latest expiry of the lots made from it, the EU disposition of those lots and the abort or cancellation date.
 *
 * The licence form is the one of the licence basis recorded at the batch's issue (recipe.batch_licence_basis, slice 6a:
 * basis.form 25 or 25A is FORM_25, 28 or 28A is FORM_28); none recorded (a batch issued before 6a): no licence rule.
 * D-6b-3: the EU state is CERTIFIED when a lot of the batch has a QP certification (the latest date), FINALLY_REJECTED when
 * the QP rejected it or its EU disposition is REJECTED or INELIGIBLE (the date of that event), else PENDING.
 */
import type { records } from '@ebmr/kernel';
import type pg from 'pg';

type Db = Pick<pg.Pool, 'query'> | pg.PoolClient;

export interface BatchFacts {
  batchId: string;
  batchNumber: string;
  status: string;
  /** Packaging batches packed from this batch (they depend on its record), via their finished lots. */
  supports: string[];
  /** Processing batches this batch was packed from (its record depends on theirs). */
  dependsOn: string[];
  retention: records.BatchRetentionFacts;
}

interface Row {
  batch_number: string;
  status: string | null;
  manufacture_date: string;
  markets: string[] | null;
  expiry_date: string | null;
  abort_date: string | null;
  eu_certified: string | null;
  eu_rejected: string | null;
  licence_form: string | null;
  packed_from: string[] | null;
  packed_into: string[] | null;
}

/** The retention engine's licence form of a recorded licence basis form (Drugs Rules Form 25/25A or 28/28A), or null. */
export function licenceFormOf(form: string | null | undefined): 'FORM_25' | 'FORM_28' | null {
  return form === '25' || form === '25A' ? 'FORM_25' : form === '28' || form === '28A' ? 'FORM_28' : null;
}

export async function batchFacts(db: Db, batchId: string): Promise<BatchFacts | null> {
  const { rows } = await db.query<Row>(
    `with b as (select e.id, e.batch_number, e.site_zone, e.issued_at from recipe.batch_execution e where e.id = $1),
          lots as (select f.lot_id, recipe.release_batches(f.lot_id) as batches from site.finished_lot f where $1 = any (recipe.release_batches(f.lot_id)))
     select b.batch_number, s.state ->> 'status' as status,
            to_char((b.issued_at at time zone b.site_zone)::date, 'YYYY-MM-DD') as manufacture_date,
            recipe.market_set('BATCH', b.id) as markets,
            (select to_char(max((l.expires_at at time zone b.site_zone)::date), 'YYYY-MM-DD') from site.material_lot l join lots on lots.lot_id = l.id) as expiry_date,
            (select to_char(max((c.recorded_at at time zone b.site_zone)::date), 'YYYY-MM-DD') from recipe.execution_command c
              where c.batch_id = b.id and c.command_type in ('ABORT_BATCH', 'CANCEL_BATCH')) as abort_date,
            (select to_char(max((q.certified_at at time zone b.site_zone)::date), 'YYYY-MM-DD') from recipe.qp_certification q join lots on lots.lot_id = q.lot_id
              where q.outcome = 'CERTIFIED') as eu_certified,
            (select to_char(max((x.at at time zone b.site_zone)::date), 'YYYY-MM-DD') from (
                select q.recorded_at as at from recipe.qp_certification q join lots on lots.lot_id = q.lot_id where q.outcome = 'REJECTED_BY_QP'
                union all
                select ev.recorded_at from recipe.market_disposition_event ev join lots on lots.lot_id = ev.lot_id
                 where ev.market = 'EU' and recipe.disposition_state(ev.lot_id, 'EU') in ('REJECTED', 'INELIGIBLE')) x) as eu_rejected,
            (select lb.basis ->> 'form' from recipe.batch_licence_basis lb where lb.batch_id = b.id) as licence_form,
            (select array_agg(distinct x::text) from lots, unnest(lots.batches) x where lots.batches[1] = b.id and x <> b.id) as packed_from,
            (select array_agg(distinct lots.batches[1]::text) from lots where lots.batches[1] <> b.id) as packed_into
       from b left join recipe.execution_state s on s.batch_id = b.id`,
    [batchId],
  );
  const r = rows[0];
  if (!r) return null;
  const status = r.status ?? 'ISSUED';
  const markets = (r.markets ?? ['IN']).filter((m): m is records.Market => m === 'IN' || m === 'US' || m === 'EU');
  const outcome: records.BatchRetentionFacts['outcome'] =
    status === 'ABORTED' ? 'ABORTED' : status === 'CANCELLED' ? 'CANCELLED' : status === 'EXECUTION_COMPLETE' ? 'COMPLETED' : 'IN_PROGRESS';
  const eu: records.BatchRetentionFacts['eu'] = !markets.includes('EU')
    ? null
    : r.eu_certified
      ? { state: 'CERTIFIED', date: r.eu_certified }
      : r.eu_rejected
        ? { state: 'FINALLY_REJECTED', date: r.eu_rejected }
        : { state: 'PENDING' };
  return {
    batchId,
    batchNumber: r.batch_number,
    status,
    // A processing batch supports the packaging batches packed from it (they depend on it); release_batches lists the
    // packaging batch first.
    supports: (r.packed_into ?? []).filter((x) => x !== batchId),
    dependsOn: (r.packed_from ?? []).filter((x) => x !== batchId),
    retention: {
      markets,
      licenceForm: licenceFormOf(r.licence_form),
      manufactureDate: r.manufacture_date,
      expiryDate: r.expiry_date,
      outcome,
      abortCancelDate: outcome === 'ABORTED' || outcome === 'CANCELLED' ? (r.abort_date ?? r.manufacture_date) : null,
      eu,
    },
  };
}
