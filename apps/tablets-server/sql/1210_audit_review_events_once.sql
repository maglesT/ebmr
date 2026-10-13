-- Tablets server, Phase 4 slice 7b (golden batches; performance re-measure against the 1-0 baseline): the audit-trail
-- review's event list was 80 times slower than its query (controls INV-48, DI-25; recipe-core 0711).
--
-- recipe.audit_review_events (CREATE OR REPLACE from recipe-core 0711, its latest and only definition) reads the review
-- window's end once in its CTE `done` (recipe.review_execution_end, about 0.1 s on a GB-T-01 record). The CTE was inlined
-- into the select list, so that function ran once per audit event: 27 s for the 3,700 events of GB-T-01's happy variant,
-- and the signing ceremony of an audit-trail review computes the report several times (about 12 minutes for one review).
-- The CTE is now MATERIALIZED and evaluated once: 0.3 s. Nothing else changes: the same rows, columns and report hash.
-- A recipe-core function re-created in this builder's Tablets range; the lead may move it to a recipe-core migration so
-- every edition has it. CREATE OR REPLACE keeps the owner, the grants and the pinned search path (SECURITY DEFINER,
-- pg_temp last). Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- As recipe-core 0711, with `done` materialized (header).
create or replace function recipe.audit_review_events(p_batch uuid, p_from_mark jsonb)
returns table (event_id bigint, chain_key text, seq bigint, recorded_at timestamptz, action text, table_name text, record_id text,
               event_hash text, critical boolean, linked boolean)
language sql stable security definer set search_path = pg_catalog, recipe, kernel, pg_temp as $$
  with sc as (select * from recipe.audit_review_scope_chains(p_batch)),
  done as materialized (select recipe.review_execution_end(p_batch) as t, (select min(b.issued_at) from recipe.batch_execution b where b.id = any (recipe.review_batches(p_batch))) as issued)
  select e.id, e.chain_key, e.seq, e.recorded_at, e.action, e.table_name, e.record_id, encode(e.hash, 'hex'),
         (sc.window_from is not null and e.recorded_at < done.issued)
           or (sc.window_from is null and sc.kind not in ('BATCH', 'PACKAGING_ORDER') and e.recorded_at > done.t),
         sc.kind not in ('BATCH', 'PACKAGING_ORDER')
    from sc cross join done
    join kernel.audit_event e on e.chain_key = sc.chain_key
   where e.seq > coalesce((p_from_mark ->> sc.chain_key)::bigint, 0)
     and (sc.window_from is null or (e.recorded_at >= sc.window_from and e.recorded_at <= sc.window_to))
     and not (e.table_name = 'recipe.exception_register_act'
              and exists (select 1 from recipe.exception_register_act a
                           where a.id::text = e.record_id and a.act in ('QUERIED', 'RESPONDED', 'ACCEPTED_BY_QA', 'ESCALATED')))
$$;

reset role;
