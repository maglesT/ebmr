-- Phase 7 slice 7b-1 (the T12 observation of the gateway, decision 0022; controls DI-32, DI-31): a stretch of a unit's
-- series the gateway could not record is an alarm in the database, naming the unit, the tag and the interval.
--
-- Handbook: modules/integrations.md
--
-- Before: the gateway kept the samples of an open chunk in memory only; a crash lost them, and the series simply had a
-- hole in source time that nothing reported.
--
-- Now the gateway spools each sample of an open chunk on receipt (apps/site-gateway/src/opcua-feed.ts) and, at restart,
-- completes the chunk from the spool (signed like every chunk, received by plant.receive_series_chunk as before). What
-- it cannot fill (the samples after the last one spooled, and the time it was down) it reports on its feed as one
-- message per series:
--
--   platform.inbound_schema row   opcua.series_gap v1 {subjectKind EQUIPMENT, subjectCode, tag, unit, fromUs, toUs,
--                                 reason GATEWAY_RESTART, detail} (@ebmr/integration-sdk/adapter systems/opcua.ts)
--   plant.receive_series_gap      SECURITY DEFINER, INTERFACE.WRITE, the OPCUA adapter's command, reached only through
--                                 tab.accept_gateway_envelope (tablets 1432: the gateway's signature is checked first,
--                                 kernel 1305). Accepts the message (platform.accept_inbound_detail: sequence, keys,
--                                 de-duplication), checks the payload, that the unit and tag are a known unit and one of
--                                 its series tags in its unit (EBMR-EQD-002 otherwise), that the unit stands on a valid
--                                 session of its endpoint (plant.opcua_unit_problem, as every OPC UA data row), that
--                                 fromUs < toUs and toUs is not ahead of the database clock (plant.source_time_or_raise),
--                                 and raises the integration alarm SERIES_GAP (kernel 1328, MAJOR) with the unit, tag,
--                                 interval and reason in its details. The message itself is the record (insert-only).
--
-- Messages: EBMR-EQD-040 (malformed series gap); EBMR-EQD-001 to -003 as for a chunk.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1232_series_gap_message)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'OPC UA series gap message schema (DI-32, DI-31, Phase 7 slice 7b-1)'));

insert into platform.inbound_schema (source_system, message_type, schema_version, description) values
  ('OPCUA', 'opcua.series_gap', 1, 'A stretch of a unit''s series the gateway could not record (a crash between spool writes, the time it was down)');

create function plant.receive_series_gap(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, platform, iam, pg_temp as $$
declare
  v_out     jsonb;
  m         platform.inbound_message;
  v_ad      iam.integration_adapter;
  p         jsonb;
  k         text;
  s         record;
  t         plant.series_tag;
  v_problem text;
  v_alarm   uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  if p_envelope ->> 'messageType' is distinct from 'opcua.series_gap' then
    raise exception using errcode = 'P0001', message = format('EBMR-EQD-040 this command receives opcua.series_gap, not %s', coalesce(p_envelope ->> 'messageType', 'none'));
  end if;
  v_out := platform.accept_inbound_detail(p_envelope);
  if v_out ->> 'outcome' <> 'ACCEPTED' then
    return jsonb_build_object('outcome', 'DUPLICATE', 'messageId', v_out ->> 'messageId', 'applied', 'NOTHING (duplicate)');
  end if;
  select * into m from platform.inbound_message where id = (v_out ->> 'messageId')::uuid;
  select * into v_ad from iam.integration_adapter where id = m.adapter_id;
  p := m.payload;
  for k in select jsonb_object_keys(p) loop
    if k not in ('subjectKind', 'subjectCode', 'tag', 'unit', 'fromUs', 'toUs', 'reason', 'detail') then
      raise exception using errcode = 'P0001', message = format('EBMR-EQD-040 malformed series gap: unknown field %s', k);
    end if;
  end loop;
  if coalesce(p ->> 'fromUs', '') !~ '^(0|[1-9][0-9]{0,15})$' or coalesce(p ->> 'toUs', '') !~ '^(0|[1-9][0-9]{0,15})$'
     or coalesce(p ->> 'reason', '') <> 'GATEWAY_RESTART' or coalesce(btrim(p ->> 'detail'), '') = '' or length(p ->> 'detail') > 500 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-EQD-040 malformed series gap: subjectKind, subjectCode, tag, unit, fromUs and toUs (epoch microseconds), reason GATEWAY_RESTART and a detail of at most 500 characters';
  end if;
  if (p ->> 'fromUs')::bigint >= (p ->> 'toUs')::bigint then
    raise exception using errcode = 'P0001', message = format('EBMR-EQD-040 malformed series gap: fromUs %s is not before toUs %s', p ->> 'fromUs', p ->> 'toUs');
  end if;
  select * into s from plant.payload_subject(p, 'EQD', m.source_system);
  select * into t from plant.series_tag where tag = p ->> 'tag';
  if t.tag is null or t.subject_kind <> s.kind or t.unit is distinct from p ->> 'unit' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-EQD-002 %s in %s is not a series tag of a %s in its unit (wrong tag)', coalesce(p ->> 'tag', 'NULL'), coalesce(p ->> 'unit', 'NULL'), lower(s.kind));
  end if;
  perform plant.source_time_or_raise(p ->> 'toUs', 'EQD');
  -- DI-20: a gap is reported for a unit by the endpoint session it was recorded under, as every OPC UA data row (0961).
  v_problem := plant.opcua_unit_problem(s.equipment_id, m.adapter_id, m.sequence_no);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-EQD-002 %s (wrong identity)', v_problem);
  end if;
  v_alarm := platform.raise_integration_alarm(v_ad, 'SERIES_GAP', 'MAJOR', m.id,
    jsonb_build_object('unit', p ->> 'subjectCode', 'tag', p ->> 'tag', 'fromUs', p ->> 'fromUs', 'toUs', p ->> 'toUs', 'reason', p ->> 'reason',
                       'detail', p ->> 'detail'));
  return jsonb_build_object('outcome', 'ACCEPTED', 'messageId', m.id, 'applied', 'SERIES_GAP alarm raised', 'alarmId', v_alarm);
end
$$;

revoke all on function plant.receive_series_gap(jsonb) from public;
grant execute on function plant.receive_series_gap(jsonb) to ebmr_app;

reset role;
