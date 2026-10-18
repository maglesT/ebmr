-- Phase 7 slice 7b-1 (golden regression of 6jc-R13, fix round 2; control DI-32): a series sample unchanged since before
-- its endpoint session is genuine data; the lower bound of every OPC UA record is the gateway's offline buffer.
--
-- Handbook: modules/integrations.md
--
-- Before (1233, 1234): a series chunk dated more than five minutes before the session it stands on was refused. An OPC
-- UA server sends the current value of every monitored node at subscription with the source time of its last change; a
-- tag that has not changed since before the session (a fill depth set at the start of the shift, a value held while the
-- gateway was down) therefore came hours old, and the gateway kept it out of the series to avoid the refusal. GB-T-03
-- showed it: the press's fill depth, unchanged since the simulator started, never reached the series.
--
-- Now plant.opcua_data_guard (re-created from 1234, every check kept) bounds a series chunk as 1234 bounds an alarm or an
-- equipment event: not more than the offline buffer (integration.opcua_offline_buffer_s, kernel 1330, default 7 days)
-- before the session's start; a time from a clock at 1970 is still refused (EBMR-EQD-003, OUT_OF_RANGE). The gateway keeps
-- only a sample older than that buffer out of the series, with its BEFORE_SESSION alarm.

set local role ebmr_owner;

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
  v_us := case tg_table_name
            when 'series' then (to_jsonb(new) ->> 'from_us')::bigint
            when 'alarm' then (to_jsonb(new) ->> 'raised_source_us')::bigint
            else (to_jsonb(new) ->> 'occurred_source_us')::bigint
          end;
  perform plant.source_time_or_raise(v_us::text, v_family, v_start,
    platform.setting_numeric('integration.opcua_offline_buffer_s')::bigint * 1000000);
  return new;
end
$$;

reset role;
