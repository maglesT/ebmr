-- Plant, part 6: the equipment and area logbook as a read view (IN-25 (a), PR-24; class Other, decision 0008 section 2).
-- Every line comes from an audited plant row (uses, cleanings, clearances, occupancies, calibrations, checks, events,
-- feed readings), so the logbook is written automatically and cannot disagree with the records it shows (outline 3.3.6).

set local role ebmr_owner;

create view plant.logbook with (security_barrier) as
  select 'EQUIPMENT'::text as subject_kind, e.code as subject_code, 'USE_STARTED'::text as entry, u.started_at as at,
         u.batch_ref, u.product_code, u.started_by as person_id,
         jsonb_build_object('use_id', u.id, 'planned_end', u.planned_end, 'cleaning_id', u.cleaning_id, 'campaign_id', u.campaign_id) as detail
  from plant.equipment_use_status u join plant.equipment e on e.id = u.equipment_id
  union all
  select 'EQUIPMENT', e.code, 'USE_ENDED', u.ended_at, u.batch_ref, u.product_code, u.ended_by,
         jsonb_build_object('use_id', u.id, 'clean_hold_crossed', u.clean_hold_crossed, 'calibration_crossed', u.calibration_crossed,
                            'campaign_crossed', u.campaign_crossed, 'overran_plan', u.overran_plan)
  from plant.equipment_use_status u join plant.equipment e on e.id = u.equipment_id where u.ended_at is not null
  union all
  select case when c.equipment_id is not null then 'EQUIPMENT' else 'AREA' end, coalesce(e.code, a.code), x.entry, x.at, null, null, x.person,
         jsonb_build_object('cleaning_id', c.id, 'level', c.level, 'method', c.method, 'dirty_hold_exceeded', c.dirty_hold_exceeded,
                            'cycle_reference', c.cycle_reference, 'signature_id', c.signature_id, 'abandon_reason', c.abandon_reason)
  from plant.cleaning_status c
  left join plant.equipment e on e.id = c.equipment_id
  left join plant.area a on a.id = c.area_id
  cross join lateral (values ('CLEANING_STARTED', c.started_at, c.started_by), ('CLEANING_COMPLETED', c.completed_at, c.completed_by),
                             ('CLEANING_VERIFIED', c.verified_at, c.verified_by), ('CLEANING_ABANDONED', c.abandoned_at, c.abandoned_by)) x(entry, at, person)
  where x.at is not null
  union all
  select 'AREA', a.code, 'CLEARANCE_PERFORMED', c.performed_at, c.next_batch, c.next_product, c.performed_by,
         jsonb_build_object('clearance_id', c.id, 'type', c.clearance_type, 'previous_product', c.previous_product, 'previous_batch', c.previous_batch,
                            'previous_order', c.previous_order, 'next_order', c.next_order, 'next_artwork_set', c.next_artwork_set)
  from plant.clearance_status c join plant.area a on a.id = c.area_id
  union all
  select 'AREA', a.code, 'CLEARANCE_' || c.result, c.verified_at, c.next_batch, c.next_product, c.verified_by,
         jsonb_build_object('clearance_id', c.id, 'type', c.clearance_type, 'signature_id', c.signature_id)
  from plant.clearance_status c join plant.area a on a.id = c.area_id where c.result is not null
  union all
  select 'AREA', a.code, 'STARTED', o.started_at, o.batch_ref, o.product_code, o.started_by,
         jsonb_build_object('occupancy_id', o.id, 'stage', o.stage, 'packaging_order', o.packaging_order, 'artwork_set', o.artwork_set,
                            'clearance_id', o.clearance_id)
  from plant.area_occupancy_status o join plant.area a on a.id = o.area_id
  union all
  select 'AREA', a.code, 'ENDED', o.ended_at, o.batch_ref, o.product_code, o.ended_by,
         jsonb_build_object('occupancy_id', o.id, 'stage', o.stage, 'packaging_order', o.packaging_order)
  from plant.area_occupancy_status o join plant.area a on a.id = o.area_id where o.ended_at is not null
  union all
  select 'EQUIPMENT', e.code, 'CALIBRATION', c.recorded_at, null, null, c.person_id,
         jsonb_build_object('calibration_id', c.id, 'due_at', c.due_at, 'as_found', c.as_found, 'as_left', c.as_left, 'reference', c.reference)
  from plant.calibration c join plant.equipment e on e.id = c.equipment_id
  union all
  select 'EQUIPMENT', e.code, 'CHECK_' || k.result, k.recorded_at, k.batch_ref, null, k.person_id,
         jsonb_build_object('check_id', k.id, 'regime', k.regime, 'reference', k.reference)
  from plant.instrument_check k join plant.equipment e on e.id = k.equipment_id
  union all
  select 'EQUIPMENT', e.code, 'INSTRUMENT_USE', i.recorded_at, i.batch_ref, i.product_code, i.person_id,
         jsonb_build_object('use_id', i.id, 'check_id', i.check_id, 'planned_end', i.planned_end)
  from plant.instrument_use i join plant.equipment e on e.id = i.equipment_id
  union all
  select 'EQUIPMENT', e.code, v.kind, v.recorded_at, v.batch_ref, null, v.person_id,
         jsonb_build_object('event_id', v.id, 'reference', v.reference, 'detail', v.detail)
  from plant.equipment_event v join plant.equipment e on e.id = v.equipment_id
  union all
  select 'EQUIPMENT', e.code, 'FEED_' || r.status, r.recorded_at, null, null, r.person_id,
         jsonb_build_object('reading_id', r.id, 'source', r.source, 'observed_at', r.observed_at)
  from plant.utility_reading r join plant.equipment e on e.id = r.equipment_id;

comment on view plant.logbook is 'Equipment and area logbook (IN-25 (a), PR-24): one line per recorded act, read from the audited plant rows';

grant select on plant.logbook to ebmr_app;

reset role;
