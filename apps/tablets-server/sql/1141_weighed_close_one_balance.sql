-- Tablets server: the weighed close reads one balance within the container's open time (Phase 4 slice 1 quick review,
-- finding 7; DI-30, DI-32, L-30). tab.close_container_weighed is replaced from its latest definition (1111) with two
-- checks after the readings are claimed: the tare and the gross come from the same device (EBMR-CNT-056), and both were
-- received between the container's opening and this close (EBMR-CNT-057). Nothing else changes.

set local role ebmr_owner;

create or replace function tab.close_container_weighed(p_container uuid, p_tare uuid, p_gross uuid, p_expected_version bigint) returns jsonb
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
  -- Finding 7: one balance weighs the tare and the gross, and both readings were received while the container was open
  -- (after it was opened, up to this close).
  if (select r.device_code from tab.device_reading r where r.id = p_tare) is distinct from (select r.device_code from tab.device_reading r where r.id = p_gross) then
    raise exception using errcode = 'P0001',
      message = format('The tare and the gross of container %s were read on different balances; one balance weighs both (DI-30, L-30; EBMR-CNT-056)', c.label_code);
  end if;
  if exists (select 1 from tab.device_reading r where r.id in (p_tare, p_gross) and (r.recorded_at < c.opened_at or r.recorded_at > clock_timestamp())) then
    raise exception using errcode = 'P0001',
      message = format('A reading of container %s was received before the container was opened; its tare and gross are read while it is open (DI-30, L-30; EBMR-CNT-057)', c.label_code);
  end if;
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

reset role;
