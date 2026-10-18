-- Phase 7 slice 7b-1 (review residual 6jc-R13; control DI-32): OPC UA data have a lower bound on their source time.
--
-- Handbook: modules/integrations.md
--
-- Before: plant.source_time_or_raise (0960) refused only a source time more than five minutes ahead of the database
-- clock, and the gateway dated a value that came without any OPC UA timestamp at epoch 0, so a sample of 1970 could
-- enter a unit's series.
--
-- Now:
--   plant.source_time_or_raise(text, text, bigint)   the 0960 checks (epoch microseconds as text, not more than five
--                                     minutes ahead of the database clock), and, when the third argument is given, a
--                                     source time more than the same five minutes before it is refused (EBMR-<family>-003).
--                                     The two-argument function stays as it was (the EMS and the session itself use it).
--   plant.opcua_session_start_us(equipment, adapter, sequence)   when the session the data stand on opened (its
--                                     openedAt, the gateway's clock): the latest session of the unit's enrolled endpoint
--                                     on that adapter before the message, the one plant.opcua_unit_problem judges.
--   plant.opcua_data_guard           re-created from 0961 with every check kept: after the identity check, the row's
--                                     earliest source time (a chunk's first sample, an alarm's raised time, an event's
--                                     time) must not be more than the allowed skew before that session's start
--                                     (EBMR-EQD-003 for series and events, EBMR-ALM-003 for alarms, class OUT_OF_RANGE).
-- The gateway marks a value without any timestamp BAD and dates it when it received it, and keeps a value older than
-- its session's start out of the series with an alarm (apps/site-gateway drivers/opcua.ts), so a working gateway never
-- meets this refusal.

set local role ebmr_owner;

create function plant.source_time_or_raise(p_us text, p_family text, p_not_before_us bigint) returns bigint
language plpgsql stable set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_us bigint := plant.source_time_or_raise(p_us, p_family);
begin
  if p_not_before_us is not null and v_us < p_not_before_us - 300000000 then
    raise exception using errcode = 'P0001',
      message = format('EBMR-%s-003 source time %s is more than five minutes before the start of the endpoint session it stands on (%s)', p_family, p_us, p_not_before_us);
  end if;
  return v_us;
end
$$;

create function plant.opcua_session_start_us(p_equipment uuid, p_adapter uuid, p_sequence bigint) returns bigint
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select s.opened_source_us
  from plant.opcua_endpoint_current x
  join plant.opcua_endpoint_unit eu on eu.endpoint_id = x.id
  join plant.opcua_endpoint_session s on s.device_id = x.device_id and s.adapter_id = p_adapter and s.sequence_no < p_sequence
  where eu.equipment_id = p_equipment and x.status = 'ENROLLED'
  order by s.sequence_no desc
  limit 1
$$;

-- 0961's guard with the lower bound of 6jc-R13 (header).
create or replace function plant.opcua_data_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  m         platform.inbound_message;
  v_problem text;
  v_family  text := case when tg_table_name = 'alarm' then 'ALM' else 'EQD' end;
  v_us      bigint;
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
  v_us := case tg_table_name
            when 'series' then (to_jsonb(new) ->> 'from_us')::bigint
            when 'alarm' then (to_jsonb(new) ->> 'raised_source_us')::bigint
            else (to_jsonb(new) ->> 'occurred_source_us')::bigint
          end;
  perform plant.source_time_or_raise(v_us::text, v_family, plant.opcua_session_start_us(new.equipment_id, m.adapter_id, m.sequence_no));
  return new;
end
$$;

revoke all on function plant.source_time_or_raise(text, text, bigint), plant.opcua_session_start_us(uuid, uuid, bigint) from public;

reset role;
