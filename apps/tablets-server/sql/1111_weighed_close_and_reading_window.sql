-- Tablets server, Phase 4 slice 1b: the weighed close of an output container, and the process-reading claim window of the
-- device-to-entry path (controls DI-30, DI-31, DI-32, DI-28, L-30; D-P4-10).
--
-- 1. tab.close_container_weighed(container, tare reading, gross reading, expected version): the validated electronic means
--    of DI-30 for a container's net. STEP.EXECUTE in the container's product scope, not an administrator. The tare and the
--    gross are scale readings claimed for this close in the person's command (tab.claim_readings, purposes TARE and GROSS:
--    a stable reading of an active balance of the session's room, fresh by the site's age policy, carrying its proof, used
--    once); both in kg or g; the net is gross minus tare in the container's unit, above zero; the container is not one
--    counted in units. The close is recorded through recipe-core 0740's internal plant.container_close_record with basis
--    WEIGHED and the two readings, so it needs no second person. Messages EBMR-CNT-054, EBMR-CNT-055.
--
-- 2. tab.claim_process_reading: CREATE OR REPLACE from 0820 (its only definition) with one addition, for the
--    device-to-entry path (D-P4-10): the reading was received no longer ago than the step's window (the block's
--    maxAgeSeconds, 60 s by default: recipe.g06_max_age_us, the age tab.step_link_status judges a link by). The rest is
--    unchanged: a reading the step's bound device sent while bound to this batch (EBMR-DEV-144), used by one entry at most
--    (EBMR-DEV-145). Message EBMR-DEV-154.
--
-- Owned by ebmr_owner, SECURITY DEFINER with pg_temp last (ADR 0016). Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

create function tab.close_container_weighed(p_container uuid, p_tare uuid, p_gross uuid, p_expected_version bigint) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, plant, iam, kernel, platform, pg_temp as $$
declare
  v_actor jsonb;
  c       plant.output_container;
  v_room  text;
  v_t     jsonb;
  v_g     jsonb;
  v_tare  numeric;
  v_gross numeric;
  v_net   numeric;
begin
  perform iam.assert_not_administrator();
  select * into c from plant.output_container where id = p_container;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown output container %s (EBMR-CNT-030)', p_container);
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', c.product_code));
  if c.quantity_unit not in ('kg', 'g') then
    raise exception using errcode = 'P0001',
      message = format('Container %s is counted in %s; a weighed close needs a container in kg or g (DI-30; EBMR-CNT-054)', c.label_code, c.quantity_unit);
  end if;
  if p_tare is null or p_gross is null then
    raise exception using errcode = 'P0001', message = format('A weighed close of container %s names its tare and its gross reading (DI-30; EBMR-CNT-054)', c.label_code);
  end if;
  v_room := iam.actor_location_scope() ->> 'area';
  v_t := tab.claim_readings(array[p_tare], v_room, 3600000000, 'TARE') -> 0;
  v_g := tab.claim_readings(array[p_gross], v_room, 3600000000, 'GROSS') -> 0;
  v_tare := (v_t ->> 'value')::numeric * case v_t ->> 'unit' when 'kg' then 1000 when 'g' then 1 end;
  v_gross := (v_g ->> 'value')::numeric * case v_g ->> 'unit' when 'kg' then 1000 when 'g' then 1 end;
  if v_tare is null or v_gross is null then
    raise exception using errcode = 'P0001', message = format('The readings of container %s are weights in kg or g (DI-32; EBMR-CNT-055)', c.label_code);
  end if;
  v_net := trim_scale((v_gross - v_tare) / case c.quantity_unit when 'kg' then 1000 else 1 end);
  if v_net <= 0 then
    raise exception using errcode = 'P0001',
      message = format('The gross reading of container %s (%s %s) is not above its tare (%s %s); the net is above zero (L-30; EBMR-CNT-055)', c.label_code,
                       v_g ->> 'value', v_g ->> 'unit', v_t ->> 'value', v_t ->> 'unit');
  end if;
  return plant.container_close_record(p_container, v_net, p_expected_version, 'WEIGHED',
                                      jsonb_build_object('tare', v_t - 'raw', 'gross', v_g - 'raw', 'room', v_room), v_actor);
end
$$;

create or replace function tab.claim_process_reading(p_reading uuid, p_batch uuid, p_step text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  r       tab.process_reading%rowtype;
  v_bind  tab.step_device%rowtype;
  v_max   numeric;
  v_now   bigint := platform.epoch_micros(clock_timestamp());
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  select * into r from tab.process_reading where id = p_reading;
  select * into v_bind from tab.step_device where batch_id = p_batch and step = p_step;
  if not coalesce(tab.reading_in_step(r, v_bind), false) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-144 DI-32: %s is no reading the process device of step %s of this batch sent while bound to it', coalesce(p_reading::text, 'NULL'), p_step);
  end if;
  -- D-P4-10: only a reading of the step's window reaches an entry (the age the step's link is judged by).
  v_max := recipe.g06_max_age_us(coalesce(tab.g06_step_node(p_batch, p_step) -> 'config', '{}'::jsonb));
  if v_now - r.received_us > v_max then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-154 DI-28: reading %s was received %s s ago, older than the %s s window of step %s; use a current reading',
                       p_reading, round((v_now - r.received_us) / 1000000.0, 1), round(v_max / 1000000.0, 1), p_step);
  end if;
  begin
    insert into tab.process_reading_use (reading_id, batch_id, step, person_id, account_id, session_id, correlation_id)
    values (p_reading, p_batch, p_step, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid,
            (v_actor ->> 'correlation_id')::uuid);
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-145 DI-32: reading %s is already used by an entry', p_reading);
  end;
  return jsonb_build_object('readingId', r.id, 'kind', r.kind, 'tag', r.tag, 'value', r.value, 'unit', r.unit, 'quality', r.quality,
                            'receivedAtUs', r.received_us::text, 'sourceTimeUs', r.source_time_us::text, 'deviceCode', r.device_code);
end
$$;

revoke all on function tab.close_container_weighed(uuid, uuid, uuid, bigint) from public;
grant execute on function tab.close_container_weighed(uuid, uuid, uuid, bigint) to ebmr_app;

reset role;
