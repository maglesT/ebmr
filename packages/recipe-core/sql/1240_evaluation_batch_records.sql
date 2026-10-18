-- Recipe core: the closed batch records and the recipe topics of the periodic evaluation (Phase 7 slice 7b-2; DI-08
-- clause 2, DI-11 clause 1, DI-44 clause 1; kernel 1335, 1336).
--
-- Handbook: modules/recipe-core.md
--
--   report.closed_batch_records()      the closed records of type batch: a GMP batch record that is closed by its own
--                                      life cycle now, not merely once: its record is LOCKED (recipe-core 0870: the
--                                      bulk reconciliation closed, or its lot's first disposition; an amendment closed
--                                      again), closed at its latest LOCKED or AMENDMENT_CLOSED event; or, never locked,
--                                      its current execution status is ABORTED or CANCELLED, closed at its latest move to
--                                      that status. A record UNDER_AMENDMENT, or still running, in review or reopened, is
--                                      not closed. Its archive package: every audit chain keyed by the batch
--                                      (kernel.audited_table with aggregate column batch_id: the batch record, its
--                                      review, its record lock and amendments, its contingency forms, its readings and
--                                      release, as the edition registers them), and the signature chains of its parts
--                                      (steps, stages, exceptions, data points, approved acts, record approvals, issue,
--                                      audit-trail reviews, reopenings, review items and record-lock amendments; aggregate
--                                      id the batch id, or the batch id then ':' or '/'), found through the range index
--                                      on esig.signature (kernel 1335).
--   report.evaluation_audit_reviews()  topic AUDIT_TRAIL_REVIEW: every audit-trail review (full or delta) of a batch
--                                      record signed in the period (recipe.batch_review_act).
--   report.evaluation_recipe_changes() topic CHANGE_RECORD, source log recipe.change_record: the master-record change
--                                      records recorded in the period.
--   The controlled-substance tables (recipe-core 1031 to 1034) are restricted tables of the export
--   (records.register_export_restricted_table, kernel 1335): an export or a readability read of a chain holding their
--   rows needs CONTROLLED.READ with no site or product limit (decision 0022, slice 7a).
-- All three functions are STABLE (they cannot write) and executable by the owner only; the kernel's report functions call
-- them.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1240_evaluation_batch_records)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the closed batch records, the recipe topics of the periodic evaluation and the restricted tables of the export (DI-08, DI-11, DI-44)'));

create function report.closed_batch_records()
returns table (record_id text, label text, closed_at timestamptz, chain_keys text[])
language sql stable security definer set search_path = pg_catalog, recipe, report, esig, kernel, pg_temp as $$
  with t as (
    select pg_catalog.array_agg(a.aggregate_type order by case a.aggregate_type when 'batch' then 0 else 1 end, a.aggregate_type collate "C") as types
      from (select distinct x.aggregate_type from kernel.audited_table x where x.aggregate_column = 'batch_id') a
  ),
  c as (
    select x.id, x.batch_number, recipe.record_lock_state(x.id) as lock_state,
           (select max(e.recorded_at) from recipe.record_lock_event e where e.batch_id = x.id and e.event in ('LOCKED', 'AMENDMENT_CLOSED')) as locked_at,
           st.status,
           (select report.us_at(max(m.now_us)) from recipe.execution_event e join recipe.execution_command m on m.batch_id = e.batch_id and m.seq = e.row_seq
             where e.batch_id = x.id and e.event_type = 'BATCH_STATUS_CHANGED' and e.event ->> 'to' = st.status) as ended_at
      from recipe.batch_execution x left join recipe.execution_state st on st.batch_id = x.id
     where x.installation = 'GMP' and x.purpose = 'GMP_BATCH'
  ),
  closed as (
    select c.id, c.batch_number, case when c.lock_state = 'LOCKED' then c.locked_at else c.ended_at end as closed_at
      from c
     where (c.lock_state = 'LOCKED' and c.locked_at is not null)
        or (c.lock_state = 'UNLOCKED' and c.status in ('ABORTED', 'CANCELLED') and c.ended_at is not null)
  )
  select d.id::text, 'Batch ' || d.batch_number, d.closed_at,
         (select pg_catalog.array_agg(ty || ':' || d.id::text order by o) from t cross join lateral pg_catalog.unnest(t.types) with ordinality u(ty, o))
           || coalesce((select pg_catalog.array_agg(distinct 'esig_signature:' || s.aggregate_ref order by 'esig_signature:' || s.aggregate_ref)
                          from esig.signature s
                         where s.aggregate_type in ('batch_step', 'batch_stage', 'batch_exception', 'batch_point', 'batch_act', 'batch_record',
                                                    'batch_issue', 'batch_audit_review', 'batch_review_reopen', 'review_items', 'record_lock')
                           and s.aggregate_id collate "C" >= d.id::text and s.aggregate_id collate "C" < d.id::text || '~'
                           and (s.aggregate_id = d.id::text or pg_catalog.starts_with(s.aggregate_id, d.id::text || ':')
                                or pg_catalog.starts_with(s.aggregate_id, d.id::text || '/'))), '{}')
    from closed d
$$;

create function report.evaluation_audit_reviews()
returns table (source_row text, occurred_at timestamptz, ended_at timestamptz, summary jsonb)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select a.id::text, a.recorded_at, null::timestamptz,
         jsonb_build_object('batchId', a.batch_id, 'batchNumber', (select x.batch_number from recipe.batch_execution x where x.id = a.batch_id),
                            'act', a.act, 'cycle', a.cycle, 'reviewNumber', a.review_number, 'reportHash', a.report_hash)
    from recipe.batch_review_act a
   where a.act in ('AUDIT_TRAIL_REVIEWED', 'DELTA_AUDIT_TRAIL_REVIEWED')
$$;

create function report.evaluation_recipe_changes()
returns table (source_row text, occurred_at timestamptz, ended_at timestamptz, summary jsonb)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select c.id::text, c.recorded_at, null::timestamptz,
         jsonb_build_object('number', c.number, 'title', c.title, 'class', c.change_class, 'processImpacting', c.process_impacting)
    from recipe.change_record c
$$;

revoke all on function report.closed_batch_records(), report.evaluation_audit_reviews(), report.evaluation_recipe_changes() from public;

select report.register_closed_record_source('batch', 'report.closed_batch_records()',
  'Closed GMP batch records (locked, or aborted or cancelled): every chain keyed by the batch and the signature chains of its parts');
select report.register_evaluation_source('AUDIT_TRAIL_REVIEW', 'recipe.batch_review_act', 'report.evaluation_audit_reviews()', 'IN_PERIOD',
  'Audit-trail reviews of batch records signed in the period, full or delta (DI-25)');
select report.register_evaluation_source('CHANGE_RECORD', 'recipe.change_record', 'report.evaluation_recipe_changes()', 'IN_PERIOD',
  'Master-record change records recorded in the period (PR-06)');

select records.register_export_restricted_table(t, 'CONTROLLED.READ', 'Controlled-substance records (IN-53; decision 0022): read with CONTROLLED.READ only')
  from pg_catalog.unnest(array['plant.controlled_product', 'plant.controlled_product_approval', 'recipe.controlled_custody',
                               'recipe.controlled_custody_signature', 'recipe.controlled_custody_use', 'recipe.controlled_checkpoint',
                               'recipe.controlled_checkpoint_signature', 'recipe.controlled_register_extract']::regclass[]) t;

select kernel.set_actor_context(null);

reset role;
