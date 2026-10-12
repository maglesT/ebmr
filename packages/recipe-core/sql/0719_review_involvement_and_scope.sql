-- Recipe core: container work in the involvement set, and the audit-trail scope widened (Phase 4 slice 1 quick review,
-- findings 1 and 8; INV-35, DI-25, outline 5.4 and 7.2 involvement set).
--
--   * recipe.batch_involvement (CREATE OR REPLACE from 0711) also counts the work on the output containers of the record
--     and its packaging orders: who opened, closed or verified the net of a container, recorded a press IPC check of the
--     batch, held a container, merged or charged one, and every signer (other than of a review or release meaning) on an
--     output_container aggregate of those containers. So the person who closed a container or checked its net cannot sign
--     the batch's audit-trail review.
--   * recipe.audit_review_scope_chains (CREATE OR REPLACE from 0711) adds, as the record's own evidence (every event):
--     the press IPC checks of the batch (output_container_ipc:<id>), the scale and process readings its rows and container
--     closes used (device_reading:<id> and process_reading:<id>, the reading's use included), and, for a packaging
--     order, the containers of the processing batch issued to it; and, as shared objects (in the window), the campaigns
--     its equipment ran in (plant_campaign:<id>).

set local role ebmr_owner;
-- plant.container_close_verification arrives with recipe-core 0740 (builder 1b), applied after this file; the bodies are
-- checked when called.
set local check_function_bodies = off;

create or replace function recipe.batch_involvement(p_batch uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, esig, plant, pg_temp as $$
  with s as (select unnest(recipe.review_batches(p_batch)) as id),
  oc as (select c.id from plant.output_container c join s on s.id = c.batch_id)
  select coalesce(array_agg(distinct p order by p) filter (where p is not null), '{}') from (
    select c.actor_person as p from recipe.execution_command c join s on s.id = c.batch_id
     where c.accepted and c.kind in ('ISSUE', 'COMMAND')
    union all
    select g.signer_person from esig.signature g
      join esig.meaning_type m on m.code = g.meaning_code and m.version = g.meaning_version
      join s on g.aggregate_id = s.id::text or g.aggregate_id like s.id::text || ':%' or g.aggregate_id like s.id::text || '/%'
     where m.role_class not in ('REVIEWER', 'RELEASE')
    union all
    select g.signer_person from esig.signature g
      join esig.meaning_type m on m.code = g.meaning_code and m.version = g.meaning_version
      join oc on g.aggregate_type = 'output_container' and g.aggregate_id = oc.id::text
     where m.role_class not in ('REVIEWER', 'RELEASE')
    union all
    select cl.performed_by from plant.clearance cl join s on s.id = cl.next_batch_id
    union all
    select v.verified_by from plant.clearance_verification v join plant.clearance cl on cl.id = v.clearance_id join s on s.id = cl.next_batch_id
    union all
    select c.opened_by_person from plant.output_container c join oc on oc.id = c.id
    union all
    select x.person_id from plant.container_close x join oc on oc.id = x.container_id
    union all
    select x.person_id from plant.container_close_verification x join oc on oc.id = x.container_id
    union all
    select x.person_id from plant.container_hold x join oc on oc.id = x.container_id
    union all
    select x.person_id from plant.container_merge x join oc on oc.id = x.source_id or oc.id = x.target_id
    union all
    select x.person_id from plant.container_charge x join oc on oc.id = x.container_id
    union all
    select x.person_id from plant.ipc_check x join s on s.id = x.batch_id
  ) u
$$;

create or replace function recipe.audit_review_scope_chains(p_batch uuid)
returns table (chain_key text, kind text, label text, window_from timestamptz, window_to timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, plant, site, pg_temp as $$
  with s as (select unnest(recipe.review_batches(p_batch)) as id),
  w as (select min(b.issued_at) - recipe.review_critical_period() as f, recipe.review_execution_end(p_batch) as t
          from recipe.batch_execution b join s on s.id = b.id),
  reading as (
    select r.v as id from recipe.execution_command c join s on s.id = c.batch_id
      cross join lateral jsonb_path_query(c.evidence, 'lax $.**.readingId') r(v)
     where c.accepted and jsonb_typeof(r.v) = 'string'
    union
    select r.v from plant.container_close x join plant.output_container oc on oc.id = x.container_id join s on s.id = oc.batch_id
      cross join lateral jsonb_path_query(coalesce(to_jsonb(x) -> 'weighing', '{}'::jsonb), 'lax $.**.readingId') r(v)
     where jsonb_typeof(r.v) = 'string'
  ),
  own as (
    select 'batch:' || b.id as chain_key, case when b.id = p_batch then 'BATCH' else 'PACKAGING_ORDER' end as kind, 'Batch ' || b.batch_number as label
      from recipe.batch_execution b join s on s.id = b.id
    union
    select 'output_container:' || c.id, 'CONTAINER', 'Container ' || c.label_code from plant.output_container c join s on s.id = c.batch_id
    union
    select 'output_container:' || c.id, 'CONTAINER', 'Container ' || c.label_code || ' (bulk issued)'
      from recipe.packaging_bulk_issue i join s on s.id = i.order_batch_id join plant.output_container c on c.id = i.container_id
    union
    select 'output_container_ipc:' || x.id, 'CONTAINER', 'In-process check ' || x.id from plant.ipc_check x join s on s.id = x.batch_id
    union
    select 'device_reading:' || (r.id #>> '{}'), 'EQUIPMENT', 'Scale reading ' || (r.id #>> '{}') from reading r
    union
    select 'process_reading:' || (r.id #>> '{}'), 'EQUIPMENT', 'Process reading ' || (r.id #>> '{}') from reading r
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
    select 'plant_campaign:' || u.campaign_id, 'EQUIPMENT', 'Campaign ' || u.campaign_id from plant.equipment_use u join s on s.id = u.batch_id
     where u.campaign_id is not null
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

reset role;
