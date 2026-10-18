-- Recipe core: the closed batch records and the recipe topics of the periodic evaluation (Phase 7 slice 7b-2; DI-08
-- clause 2, DI-11 clause 1, DI-44 clause 1; kernel 1335, 1336).
--
-- Handbook: modules/recipe-core.md
--
--   report.closed_batch_records()      the closed records of type batch: a GMP batch record whose execution has ended
--                                      (its first status change to EXECUTION_COMPLETE, ABORTED or CANCELLED, at the
--                                      engine's database time), labelled with its batch number, with the chains of its
--                                      archive package: the batch record, its review and audit-trail review, and its
--                                      contingency forms (as the evidence export of the archive feature takes them), and
--                                      the signature chains of its parts: the signatures of its steps, stages, exceptions,
--                                      data points, approved acts, record approvals, issue, audit-trail reviews, reopenings
--                                      and review items (aggregate id the batch id, or the batch id then ':' or '/'). The
--                                      full export, the readability sample and the evaluation pack read it (kernel 1335).
--   report.evaluation_audit_reviews()  topic AUDIT_TRAIL_REVIEW: every audit-trail review (full or delta) of a batch
--                                      record signed in the period (recipe.batch_review_act).
--   report.evaluation_recipe_changes() topic CHANGE_RECORD, source log recipe.change_record: the master-record change
--                                      records recorded in the period.
-- All three are STABLE (they cannot write) and executable by the owner only; the kernel's report functions call them.

set local role ebmr_owner;

create function report.closed_batch_records()
returns table (record_id text, label text, closed_at timestamptz, chain_keys text[])
language sql stable security definer set search_path = pg_catalog, recipe, report, esig, pg_temp as $$
  select x.id::text, 'Batch ' || x.batch_number, c.closed_at,
         array['batch:' || x.id::text, 'batch_review:' || x.id::text, 'form_reconciliation:' || x.id::text]
           || coalesce((select pg_catalog.array_agg(distinct 'esig_signature:' || s.aggregate_ref order by 'esig_signature:' || s.aggregate_ref)
                          from esig.signature s
                         where s.aggregate_type in ('batch_step', 'batch_stage', 'batch_exception', 'batch_point', 'batch_act', 'batch_record',
                                                    'batch_issue', 'batch_audit_review', 'batch_review_reopen', 'review_items')
                           and (s.aggregate_id = x.id::text or pg_catalog.starts_with(s.aggregate_id, x.id::text || ':')
                                or pg_catalog.starts_with(s.aggregate_id, x.id::text || '/'))), '{}')
    from recipe.batch_execution x
    cross join lateral (select report.us_at(min(m.now_us)) as closed_at
                          from recipe.execution_event e join recipe.execution_command m on m.batch_id = e.batch_id and m.seq = e.row_seq
                         where e.batch_id = x.id and e.event_type = 'BATCH_STATUS_CHANGED'
                           and e.event ->> 'to' in ('EXECUTION_COMPLETE', 'ABORTED', 'CANCELLED')) c
   where x.installation = 'GMP' and x.purpose = 'GMP_BATCH' and c.closed_at is not null
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
  'Closed GMP batch records (execution ended): the batch record, its review and its contingency forms');
select report.register_evaluation_source('AUDIT_TRAIL_REVIEW', 'recipe.batch_review_act', 'report.evaluation_audit_reviews()', 'IN_PERIOD',
  'Audit-trail reviews of batch records signed in the period, full or delta (DI-25)');
select report.register_evaluation_source('CHANGE_RECORD', 'recipe.change_record', 'report.evaluation_recipe_changes()', 'IN_PERIOD',
  'Master-record change records recorded in the period (PR-06)');

reset role;
