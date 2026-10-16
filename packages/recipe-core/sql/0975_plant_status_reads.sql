-- Phase 6 slice 6b (builder B): the plant's status displays read straight from the system state (PR-22, PR-35,
-- DI-49): what a screen shows is what the database holds at the moment of the read, never a copy kept elsewhere.
--
-- Handbook: modules/recipe-core.md
--
--   plant.status_board()            every PROCESS unit, room and line with its machine state and version
--                                   (platform.aggregate_state), the batch and product it serves now (the open equipment
--                                   use or occupancy), its cleaning state (rooms and lines: plant.room_cleaning_state),
--                                   and its alarms awaiting acknowledgment
--   plant.line_station(code)        the line station display (PR-35): the line, its state, and the product, batch,
--                                   packaging order and artwork set of the occupancy open on it (null fields when idle)
--   plant.room_conditions(code)     the room's latest EMS sample per room tag (raw and shown value, unit, status, source
--                                   and receipt time), its open EMS alarms and its cleaning state (DI-32, DI-49)
--
-- Messages: EBMR-PLANT-011 (an unknown room or line, from plant.area_by_code).

set local role ebmr_owner;

create function plant.status_board() returns setof jsonb
language sql stable security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
  select jsonb_build_object(
           'subjectKind', 'EQUIPMENT', 'code', e.code, 'name', e.name, 'kind', e.kind, 'classCode', e.class_code,
           'state', s.state, 'stateVersion', s.version::text, 'stateSince', s.updated_at,
           'batchId', u.batch_id, 'batchRef', u.batch_ref, 'product', u.product_code, 'cleaningState', null, 'lastCleanedAt', null,
           'openAlarms', (select count(*) from plant.alarm_status a where a.equipment_id = e.id and a.acked_at is null)::integer)
  from plant.equipment e
  left join platform.aggregate_state s on s.aggregate_type = 'plant_equipment' and s.aggregate_id = e.id
  left join lateral (select x.batch_id, x.batch_ref, x.product_code from plant.equipment_use_status x
                      where x.equipment_id = e.id and x.ended_at is null order by x.started_at desc limit 1) u on true
  where e.kind = 'PROCESS'
  union all
  select jsonb_build_object(
           'subjectKind', 'AREA', 'code', a.code, 'name', a.name, 'kind', a.kind, 'classCode', null,
           'state', s.state, 'stateVersion', s.version::text, 'stateSince', s.updated_at,
           'batchId', o.batch_id, 'batchRef', o.batch_ref, 'product', o.product_code, 'cleaningState', c.cleaning_state, 'lastCleanedAt', c.last_cleaned_at,
           'openAlarms', (select count(*) from plant.alarm_status x where x.area_id = a.id and x.acked_at is null)::integer)
  from plant.area a
  left join platform.aggregate_state s on s.aggregate_type = 'plant_area' and s.aggregate_id = a.id
  left join plant.room_cleaning_state c on c.area_id = a.id
  left join lateral (select x.batch_id, x.batch_ref, x.product_code from plant.area_occupancy_status x
                      where x.area_id = a.id and x.ended_at is null order by x.started_at desc limit 1) o on true
$$;

create function plant.line_station(p_code text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  a plant.area := plant.area_by_code(p_code, false);
  o plant.area_occupancy_status;
  s platform.aggregate_state;
begin
  select * into s from platform.aggregate_state where aggregate_type = 'plant_area' and aggregate_id = a.id;
  select * into o from plant.area_occupancy_status x where x.area_id = a.id and x.ended_at is null order by x.started_at desc limit 1;
  return jsonb_build_object('code', a.code, 'name', a.name, 'kind', a.kind, 'state', s.state, 'stateVersion', s.version::text,
                            'batchId', o.batch_id, 'batchRef', o.batch_ref, 'product', o.product_code,
                            'productName', (select p.name from plant.product p where p.code = o.product_code),
                            'stage', o.stage, 'packagingOrder', o.packaging_order, 'artworkSet', o.artwork_set, 'since', o.started_at);
end
$$;

create function plant.room_conditions(p_code text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  a      plant.area := plant.area_by_code(p_code, false);
  v_tags jsonb;
begin
  select coalesce(jsonb_agg(t.x order by t.tag), '[]'::jsonb) into v_tags
  from (
    select g.tag, jsonb_build_object('tag', g.tag, 'unit', g.unit, 'sample', l.sample, 'receivedAt', l.received_at) as x
    from plant.series_tag g
    left join lateral (
      select s.received_at, (select smp from jsonb_array_elements(s.samples) smp order by (smp ->> 'sourceTime')::bigint desc limit 1) as sample
      from plant.series s where s.area_id = a.id and s.tag = g.tag order by s.to_us desc limit 1) l on true
    where g.subject_kind = 'AREA'
  ) t;
  return jsonb_build_object(
    'code', a.code, 'name', a.name, 'tags', v_tags,
    'cleaningState', (select c.cleaning_state from plant.room_cleaning_state c where c.area_id = a.id),
    'openAlarms', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'source', x.source, 'alarmCode', x.alarm_code, 'message', x.message,
                                                                'gmpCritical', x.gmp_critical, 'raisedSourceUs', x.raised_source_us::text) order by x.raised_source_us), '[]'::jsonb)
                   from plant.alarm_status x where x.area_id = a.id and x.acked_at is null));
end
$$;

revoke all on function plant.status_board(), plant.line_station(text), plant.room_conditions(text) from public;
grant execute on function plant.status_board(), plant.line_station(text), plant.room_conditions(text) to ebmr_app;

reset role;
