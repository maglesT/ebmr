-- Recipe core: the scope, the report and the high-water mark of the batch audit-trail review (Phase 4 slice 1a; outline
-- 5.4 "Review"; DI-25, INV-48, D-P4-16; plan defaults D-1a-2 and D-1a-3 in docs/build-plan/phase-4/phase-4-plan.md).
--
--   * recipe.review_batches(batch): the record and, for a processing record, the packaging orders that pack its bulk.
--   * recipe.batch_involvement(batch) uuid[]: the involvement set (outline 7.2, L-04), computed from the system of record:
--     every person who gave an accepted command or the issue in the record or its packaging orders (entered, corrected,
--     voided data, dispositioned an exception, approved a skip), who signed any meaning there other than a review or
--     release meaning (performed, verified, witnessed, hold points, act approvals, the production approval), and who
--     performed or verified a line clearance for it. QA's IPC sampling counts (it is a command).
--   * recipe.audit_review_scope_chains(batch): the chains the review covers, each with its kind, label and window:
--       - the record's own chains (batch:<id>, the packaging orders' too) and its evidence records: output containers,
--         the cleanings its equipment uses relied on, its line clearances, the deviations linked to it and the LIMS results
--         of the lots it consumed: every event, also after the record was completed (a later
--         correction of such a record is in scope: DI-25);
--       - shared objects (equipment and instruments used, rooms occupied, lots consumed, the MBR version, the involved
--         persons and their accounts): the events from the critical period before the issue (D-P4-16, 72 hours) up to the record's last
--         execution row (D-1a-3: what happens to a shared object after the record was completed belongs to its later
--         users and to the release gate's own evidence checks, slice 3).
--     QA's own review acts (QUERIED, RESPONDED, ACCEPTED_BY_QA, ESCALATED rows of the exception register) are the review,
--     not reviewed by it, and are left out of the batch chain (D-1a-2).
--   * recipe.audit_review_events(batch, from_mark): the in-scope events after the mark (all of them with no mark), each
--     flagged critical (D-P4-16 default: a change to a shared object in the critical period before the issue, or a change
--     to an evidence record after the record was completed) and linked (not on the record's own chains).
--   * recipe.audit_review_mark(batch): the current high-water mark (chain key -> last in-scope sequence number).
--   * recipe.audit_review_report_hash(batch, from_mark): SHA-256 over the events (chain, sequence, event hash).
--
-- Storing the audit-event id of each field a guard read (outline 5.4) is not built: residual (D-P4-16).

set local role ebmr_owner;

create function recipe.review_batches(p_batch uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select array_agg(distinct x order by x) from (
    select p_batch as x
    union all
    select b.id from recipe.batch_execution b
     where b.purpose = 'GMP_BATCH' and b.id <> p_batch and recipe.packaging_parent_of(b.id) = p_batch) y
$$;

create function recipe.batch_involvement(p_batch uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, esig, plant, pg_temp as $$
  with s as (select unnest(recipe.review_batches(p_batch)) as id)
  select coalesce(array_agg(distinct p order by p) filter (where p is not null), '{}') from (
    select c.actor_person as p from recipe.execution_command c join s on s.id = c.batch_id
     where c.accepted and c.kind in ('ISSUE', 'COMMAND')
    union all
    select g.signer_person from esig.signature g
      join esig.meaning_type m on m.code = g.meaning_code and m.version = g.meaning_version
      join s on g.aggregate_id = s.id::text or g.aggregate_id like s.id::text || ':%' or g.aggregate_id like s.id::text || '/%'
     where m.role_class not in ('REVIEWER', 'RELEASE')
    union all
    select cl.performed_by from plant.clearance cl join s on s.id = cl.next_batch_id
    union all
    select v.verified_by from plant.clearance_verification v join plant.clearance cl on cl.id = v.clearance_id join s on s.id = cl.next_batch_id
  ) u
$$;

-- The end of the record's execution: its last execution row (the record and its packaging orders).
create function recipe.review_execution_end(p_batch uuid) returns timestamptz
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select max(c.recorded_at) from recipe.execution_command c where c.batch_id = any (recipe.review_batches(p_batch))
$$;

-- The critical period before use (D-P4-16; default 72 hours).
create function recipe.review_critical_period() returns interval
language sql immutable set search_path = pg_catalog, pg_temp as $$ select interval '72 hours' $$;

create function recipe.audit_review_scope_chains(p_batch uuid)
returns table (chain_key text, kind text, label text, window_from timestamptz, window_to timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, plant, site, pg_temp as $$
  with s as (select unnest(recipe.review_batches(p_batch)) as id),
  w as (select min(b.issued_at) - recipe.review_critical_period() as f, recipe.review_execution_end(p_batch) as t
          from recipe.batch_execution b join s on s.id = b.id),
  own as (
    select 'batch:' || b.id as chain_key, case when b.id = p_batch then 'BATCH' else 'PACKAGING_ORDER' end as kind, 'Batch ' || b.batch_number as label
      from recipe.batch_execution b join s on s.id = b.id
    union
    select 'output_container:' || c.id, 'CONTAINER', 'Container ' || c.label_code from plant.output_container c join s on s.id = c.batch_id
    union
    select 'plant_cleaning:' || u.cleaning_id, 'EQUIPMENT', 'Cleaning of ' || e.code from plant.equipment_use u join s on s.id = u.batch_id
      join plant.equipment e on e.id = u.equipment_id
    union
    select 'plant_clearance:' || cl.id, 'ROOM', 'Line clearance of ' || a.code from plant.clearance cl join s on s.id = cl.next_batch_id
      join plant.area a on a.id = cl.area_id
    union
    select 'deviation:' || d.id, 'DEVIATION', 'Deviation ' || d.ref from site.deviation_link l join site.deviation d on d.id = l.deviation_id
     where (l.subject_kind = 'BATCH' and l.subject_id in (select id from s)) or l.batch_id in (select id from s)
    union
    select 'lot_test_result:' || r.id, 'LIMS', 'Result ' || r.test_code || ' of lot ' || ml.lot_code
      from site.lot_consumption lc join s on s.id = lc.batch_id join site.lot_test_result r on r.lot_id = lc.lot_id
      join site.material_lot ml on ml.id = lc.lot_id
  ),
  shared as (
    select 'plant_equipment:' || e.id as chain_key, 'EQUIPMENT' as kind, 'Equipment ' || e.code as label
      from plant.equipment e where e.id in (select u.equipment_id from plant.equipment_use u join s on s.id = u.batch_id
                                            union select i.equipment_id from plant.instrument_use i join s on s.id = i.batch_id)
    union
    select 'plant_area:' || a.id, 'ROOM', 'Room ' || a.code from plant.area a
     where a.id in (select o.area_id from plant.area_occupancy o join s on s.id = o.batch_id)
    union
    select 'material_lot:' || ml.id, 'LOT', 'Lot ' || ml.lot_code from site.material_lot ml
     where ml.id in (select lc.lot_id from site.lot_consumption lc join s on s.id = lc.batch_id)
    union
    select 'mbr_version:' || cr.version_id, 'MBR', 'Master record version' from recipe.control_recipe cr join s on s.id = cr.batch_id
    union
    select 'person:' || p, 'PERSON', 'Person ' || coalesce((select x.legal_name from iam.person x where x.id = p), p::text)
      from unnest(recipe.batch_involvement(p_batch)) p
    union
    select 'account:' || a.id, 'ACCOUNT', 'Account ' || a.login_name from iam.account a where a.person_id = any (recipe.batch_involvement(p_batch))
  )
  select o.chain_key, o.kind, o.label, null::timestamptz, null::timestamptz from own o
  union all
  select x.chain_key, x.kind, x.label, w.f, w.t from shared x cross join w
   where not exists (select 1 from own o where o.chain_key = x.chain_key)
$$;

-- The in-scope events of the record after p_from_mark (chain key -> last sequence number already reviewed).
create function recipe.audit_review_events(p_batch uuid, p_from_mark jsonb)
returns table (event_id bigint, chain_key text, seq bigint, recorded_at timestamptz, action text, table_name text, record_id text,
               event_hash text, critical boolean, linked boolean)
language sql stable security definer set search_path = pg_catalog, recipe, kernel, pg_temp as $$
  with sc as (select * from recipe.audit_review_scope_chains(p_batch)),
  done as (select recipe.review_execution_end(p_batch) as t, (select min(b.issued_at) from recipe.batch_execution b where b.id = any (recipe.review_batches(p_batch))) as issued)
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

create function recipe.audit_review_mark(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(jsonb_object_agg(chain_key, m), '{}'::jsonb)
    from (select x.chain_key, max(x.seq)::text as m from recipe.audit_review_events(p_batch, null) x group by x.chain_key) y
$$;

create function recipe.audit_review_report_hash(p_batch uuid, p_from_mark jsonb) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select encode(sha256(convert_to(coalesce(string_agg(x.chain_key || '#' || x.seq || '#' || x.event_hash, E'\n' order by x.chain_key, x.seq), ''), 'UTF8')), 'hex')
    from recipe.audit_review_events(p_batch, p_from_mark) x
$$;

revoke all on function recipe.review_batches(uuid), recipe.batch_involvement(uuid), recipe.review_execution_end(uuid), recipe.review_critical_period(),
                       recipe.audit_review_scope_chains(uuid), recipe.audit_review_events(uuid, jsonb), recipe.audit_review_mark(uuid),
                       recipe.audit_review_report_hash(uuid, jsonb) from public;
grant execute on function recipe.review_batches(uuid), recipe.batch_involvement(uuid), recipe.audit_review_scope_chains(uuid),
                          recipe.audit_review_events(uuid, jsonb), recipe.audit_review_mark(uuid), recipe.audit_review_report_hash(uuid, jsonb) to ebmr_app;

reset role;
