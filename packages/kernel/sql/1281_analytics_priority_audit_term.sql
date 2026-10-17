-- Phase 6A exit (slice 6A-7, review finding P6A7-2): the review priority's audit-trail term is restricted in the
-- database (ADR 0020 point 4; draft controls DI-53, PR-61; D-6A-5-4, D-6A-7-R2).
--
-- Handbook: modules/analytics.md
--
-- Why. REVIEW.PRIORITY counts the audit-trail rule hits on a record's entries (term OPEN_AUDIT_FLAG). The hits come from
-- flags about persons, which only data-integrity review may read (DI-53), and the slice's own review (P6A5-1) hid the
-- term from everyone else in the server only. The views analytics.review_priority_v1 and analytics.output_v1 still gave
-- the application role the full score, the term's points and count and its reason, to any reader of the views: the
-- restriction held on one path, not in the database as DI-53's other restricted reads do.
--
--   analytics.viewer_holds_di_review()  whether the command's person holds ANALYTICS.DI_REVIEW now. SECURITY DEFINER,
--                                 EXECUTE to ebmr_app; refuses administrators first (iam.assert_not_administrator,
--                                 DI-18), then asks iam.require_permission (DI-17). Any refusal (no validated person, an
--                                 administrator, the permission missing) or a read-only transaction answers false: the
--                                 term is then left out (it fails closed).
--   analytics.review_priority_v1  replaced (same columns): without ANALYTICS.DI_REVIEW the score is the score less the
--                                 term's points (never below 0), and the reasons leave the term's reason out.
--   analytics.output_v1           replaced (same columns): a REVIEW_PRIORITY output read without ANALYTICS.DI_REVIEW has
--                                 the term's count and points left out of its values, its score reduced likewise, and
--                                 the term's reason left out. Every other output is unchanged. The permission is asked
--                                 at most once per query, and only when a REVIEW_PRIORITY output is read.
-- The server's own filter (features/common/review-priority.ts) stays; it now finds no term to take out. Nothing in the
-- review, the exception register, the audit-trail review or release reads either view (PR-61); nothing outside the
-- analytics schema reads them (DI-51).

set local role ebmr_owner;

create function analytics.viewer_holds_di_review() returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('ANALYTICS.DI_REVIEW', '{}'::jsonb);
  return true;
exception when raise_exception or read_only_sql_transaction then
  return false;
end
$$;
revoke all on function analytics.viewer_holds_di_review() from public;
grant execute on function analytics.viewer_holds_di_review() to ebmr_app;

-- The term's points in an output's values (0 when absent or not a positive number).
create function analytics.audit_term_points(p_values jsonb) returns double precision
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select case when pg_catalog.jsonb_typeof(p_values -> 'OPEN_AUDIT_FLAG.points') = 'number'
               and (p_values ->> 'OPEN_AUDIT_FLAG.points')::double precision > 0
              then (p_values ->> 'OPEN_AUDIT_FLAG.points')::double precision else 0 end
$$;
revoke all on function analytics.audit_term_points(jsonb) from public;
grant execute on function analytics.audit_term_points(jsonb) to ebmr_app;

-- The reasons without the term's reason (order kept).
create function analytics.reasons_without_audit_term(p_reasons jsonb) returns jsonb
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select coalesce((select pg_catalog.jsonb_agg(r order by n) from pg_catalog.jsonb_array_elements(p_reasons) with ordinality x(r, n)
                    where r ->> 'code' is distinct from 'OPEN_AUDIT_FLAG'), '[]'::jsonb)
$$;
revoke all on function analytics.reasons_without_audit_term(jsonb) from public;
grant execute on function analytics.reasons_without_audit_term(jsonb) to ebmr_app;

create or replace view analytics.review_priority_v1 as
  with viewer as materialized (select analytics.viewer_holds_di_review() as di)
  select distinct on (o.subject_ref)
         o.subject_ref as batch_ref, o.id as output_id, o.run as run_id, r.method, r.version,
         case when jsonb_typeof(o."values" -> 'score') = 'number' then
           case when (select di from viewer) then (o."values" ->> 'score')::double precision
                else greatest(0, (o."values" ->> 'score')::double precision - analytics.audit_term_points(o."values")) end
         end as score,
         case when (select di from viewer) then o.reasons else analytics.reasons_without_audit_term(o.reasons) end as reasons,
         o.recorded_at as scored_at, e.ended_at as finished_at, true as advisory
    from analytics.output o
    join analytics.run r on r.id = o.run
    join analytics.run_end e on e.run = r.id and e.status = 'DONE'
   where o.kind = 'REVIEW_PRIORITY' and o.subject_kind = 'BATCH'
   order by o.subject_ref, o.recorded_at desc, o.id desc;

create or replace view analytics.output_v1 as
  with viewer as materialized (select analytics.viewer_holds_di_review() as di)
  select o.id as output_id, o.run as run_id, r.method, r.version, r.reference_set, o.subject_kind, o.subject_ref, o.kind,
         case when o.kind <> 'REVIEW_PRIORITY' then o."values"
              when (select di from viewer) then o."values"
              else (o."values" - 'OPEN_AUDIT_FLAG.count' - 'OPEN_AUDIT_FLAG.points')
                   || case when jsonb_typeof(o."values" -> 'score') = 'number'
                           then jsonb_build_object('score', greatest(0, (o."values" ->> 'score')::double precision - analytics.audit_term_points(o."values")))
                           else '{}'::jsonb end
         end as "values",
         case when o.kind <> 'REVIEW_PRIORITY' then o.reasons
              when (select di from viewer) then o.reasons
              else analytics.reasons_without_audit_term(o.reasons)
         end as reasons,
         o.recorded_at,
         (select min((x ->> 'data_as_of')::timestamptz) from jsonb_array_elements(r.inputs) x) as data_as_of,
         e.ended_at as finished_at, true as advisory
    from analytics.output o
    join analytics.run r on r.id = o.run
    join analytics.run_end e on e.run = r.id and e.status = 'DONE'
   where o.subject_kind not in ('PERSON', 'ACCOUNT');

reset role;
