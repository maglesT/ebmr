-- Phase 7 slice 7b-1 (review round 1 of 7b-1b, findings 1 and 3; control DI-32): the lower bound of 1233 fits what each
-- kind of OPC UA record is, and an endpoint session cannot start at 1970.
--
-- Handbook: modules/integrations.md
--
-- Before (1233): an alarm or an equipment event dated more than five minutes before the endpoint session it stands on
-- was refused like a series chunk. The gateway keeps only data changes of that age out of the series; an alarm or
-- event that happened while the gateway was down and is delivered at the reconnect (under its own new key) was refused
-- and lost. And the session's own start (openedAt, the gateway's clock) was checked only against being ahead of the
-- database's clock, so a gateway clock at 1970 made the bound itself about 0.
--
-- Now:
--   plant.source_time_or_raise(text, text, bigint, bigint)   the checks of the two-argument function, and a source time
--                                     more than the fourth argument (microseconds) before the third is refused
--                                     (EBMR-<family>-003). The three-argument function of 1233 stays (five minutes).
--   plant.opcua_data_guard           re-created from 1233 with every check kept: a series chunk keeps the five-minute
--                                     bound before its session's start; an alarm or an equipment event may be as old as
--                                     the gateway's offline buffer before it (setting integration.opcua_offline_buffer_s,
--                                     kernel 1330, default 7 days), so a time of 1970 still fails (EBMR-ALM-003,
--                                     EBMR-EQD-003, OUT_OF_RANGE).
--   plant.opcua_session_start_guard  (trigger before insert on plant.opcua_endpoint_session) refuses a session whose
--                                     start is more than the offline buffer before the database's clock at receipt
--                                     (EBMR-EQD-003): a session pulled after a server outage is within it, a gateway
--                                     clock at 1970 is not. The receiving command (0961) is unchanged; its message is
--                                     refused whole, with the worker's alarm, as every refusal.

set local role ebmr_owner;

create function plant.source_time_or_raise(p_us text, p_family text, p_not_before_us bigint, p_allowed_us bigint) returns bigint
language plpgsql stable set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_us bigint := plant.source_time_or_raise(p_us, p_family);
begin
  if p_not_before_us is not null and v_us < p_not_before_us - coalesce(p_allowed_us, 0) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-%s-003 source time %s is more than %s s before the start of the endpoint session it stands on (%s)', p_family, p_us,
                       coalesce(p_allowed_us, 0) / 1000000, p_not_before_us);
  end if;
  return v_us;
end
$$;

-- 1233's guard: series keep the five-minute bound; alarms and events the offline buffer (header).
create or replace function plant.opcua_data_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  m         platform.inbound_message;
  v_problem text;
  v_family  text := case when tg_table_name = 'alarm' then 'ALM' else 'EQD' end;
  v_us      bigint;
  v_start   bigint;
begin
  if new.source is distinct from 'OPCUA' then
    return new;
  end if;
  select * into m from platform.inbound_message where id = new.inbound_message_id;
  if m.id is null or new.equipment_id is null then
    v_problem := 'DI-20: OPC UA data name a unit and the inbound message they came in';
  else
    v_problem := plant.opcua_unit_problem(new.equipment_id, m.adapter_id, m.sequence_no);
  end if;
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-%s-002 %s (wrong identity)', v_family, v_problem);
  end if;
  v_start := plant.opcua_session_start_us(new.equipment_id, m.adapter_id, m.sequence_no);
  if tg_table_name = 'series' then
    v_us := (to_jsonb(new) ->> 'from_us')::bigint;
    perform plant.source_time_or_raise(v_us::text, v_family, v_start);
  else
    v_us := case tg_table_name when 'alarm' then (to_jsonb(new) ->> 'raised_source_us')::bigint else (to_jsonb(new) ->> 'occurred_source_us')::bigint end;
    perform plant.source_time_or_raise(v_us::text, v_family, v_start,
      platform.setting_numeric('integration.opcua_offline_buffer_s')::bigint * 1000000);
  end if;
  return new;
end
$$;

create function plant.opcua_session_start_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  v_window bigint := platform.setting_numeric('integration.opcua_offline_buffer_s')::bigint;
begin
  if new.opened_source_us < (extract(epoch from clock_timestamp()) * 1000000)::bigint - v_window * 1000000 then
    raise exception using errcode = 'P0001',
      message = format('EBMR-EQD-003 the session of endpoint %s started at %s, more than %s s (the gateway''s offline buffer) before the database clock',
                       new.endpoint_code, new.opened_source_us, v_window);
  end if;
  return new;
end
$$;

create trigger ab_opcua_session_start before insert on plant.opcua_endpoint_session for each row execute function plant.opcua_session_start_guard();

revoke all on function plant.source_time_or_raise(text, text, bigint, bigint), plant.opcua_session_start_guard() from public;

reset role;
