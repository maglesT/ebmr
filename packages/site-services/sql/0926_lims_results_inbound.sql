-- Phase 6 slice 6a (builder B): LIMS sample results received through the LIMS adapter (DI-31; D-P6a-4: LIMS-lite
-- stays the stand-in; plan "Slice 6a").
--
-- Handbook: modules/site-services.md
--
--   lims_sample_result   insert-only: one row per received state of one LIMS result (sample, lot, test, specification
--                        reference, the value exactly as the LIMS sent it, decimal text and unit, or a text result; the
--                        LIMS's conformance and approval state; the LIMS's time), each tied to its message (source
--                        system, record id, timestamp: DI-31). The value is kept as text and never converted.
--   site.receive_lims_sample_result(envelope)   the LIMS adapter's command: platform.accept_inbound_detail (kernel 1180)
--                        and, when ACCEPTED, the row in the same transaction. Refusals:
--                          EBMR-LIMS-101 MALFORMED       payload shape (a value that is not decimal text, a unit that is
--                                                        not printable, an unknown field)
--                          EBMR-LIMS-103 WRONG_IDENTITY  a lot number this installation does not hold (wrong batch)
--                          EBMR-LIMS-104 STALE           older than a state of the same sample and test already applied
--   site.lims_lot_results(lot)   the latest state of each LIMS result of the lot, for the lot's screens.
-- D-P6a-B-6: the LIMS results are kept and shown beside LIMS-lite; they do not feed the release item G3.LIMS in slice 6a
-- (kernel 1180 defines no LIMS mirror data class; a LIMS release mode is an interface change for the lead).

set local role ebmr_owner;

create table site.lims_sample_result (
  id                  uuid primary key default gen_random_uuid(),
  lot_id              uuid not null references site.material_lot (id),
  sample_id           text not null check (sample_id ~ '^[\x21-\x7E]{1,64}$'),
  test_code           text not null check (test_code ~ '^[\x21-\x7E]{1,64}$'),
  specification_ref   text not null check (specification_ref ~ '^[\x21-\x7E]{1,64}$'),
  raw_value           text check (raw_value is null or raw_value ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'),
  raw_unit            text check (raw_unit is null or raw_unit ~ '^[\x21-\x7E]{1,16}$'),
  result_text         text check (result_text is null or (length(result_text) between 1 and 500)),
  conformance         text not null check (conformance in ('CONFORMS', 'DOES_NOT_CONFORM', 'NOT_APPLICABLE')),
  state               text not null check (state in ('ENTERED', 'REVIEWED', 'APPROVED', 'INVALIDATED')),
  lims_recorded_at    timestamptz not null,
  message_id          uuid not null unique references platform.inbound_message (id),
  source_timestamp    timestamptz not null,
  received_at         timestamptz not null default clock_timestamp(),
  check ((raw_value is null) = (raw_unit is null)),
  check ((raw_value is null) <> (result_text is null))
);
create index lims_sample_result_by_lot on site.lims_sample_result (lot_id, sample_id, test_code, source_timestamp);
revoke all on site.lims_sample_result from public;
select platform.enforce_db_time('site.lims_sample_result', array['received_at']);
select kernel.register_audited_table('site.lims_sample_result', 'material_lot', 'lot_id', true);

create function site.receive_lims_sample_result(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, platform, pg_temp as $$
declare
  v_out   jsonb;
  m       platform.inbound_message;
  p       jsonb;
  r       jsonb;
  k       text;
  v_lot   uuid;
  v_newer timestamptz;
begin
  -- Never an administrator; the inbound permission of the adapter's service role (the adapter's identity is checked by
  -- platform.accept_inbound_detail: DI-14, DI-20).
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  if p_envelope ->> 'messageType' is distinct from 'lims.sample_result' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LIMS-101 this command receives lims.sample_result messages, not %s', coalesce(p_envelope ->> 'messageType', 'none'));
  end if;
  v_out := platform.accept_inbound_detail(p_envelope);
  if v_out ->> 'outcome' <> 'ACCEPTED' then
    return v_out || jsonb_build_object('applied', 'NOTHING (duplicate)');
  end if;
  select * into m from platform.inbound_message where id = (v_out ->> 'messageId')::uuid;
  p := m.payload;
  if jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-LIMS-101 malformed lims.sample_result payload: not an object';
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('sampleId', 'lotNumber', 'testCode', 'specificationRef', 'result', 'conformance', 'state', 'recordedAt') then
      raise exception using errcode = 'P0001', message = format('EBMR-LIMS-101 malformed lims.sample_result payload: unknown field %s', k);
    end if;
  end loop;
  foreach k in array array['sampleId', 'lotNumber', 'testCode', 'specificationRef'] loop
    if jsonb_typeof(p -> k) is distinct from 'string' or (p ->> k) !~ '^[\x21-\x7E]{1,64}$' then
      raise exception using errcode = 'P0001', message = format('EBMR-LIMS-101 malformed lims.sample_result payload: %s is a code of 1 to 64 printable characters', k);
    end if;
  end loop;
  if coalesce(p ->> 'conformance', '') not in ('CONFORMS', 'DOES_NOT_CONFORM', 'NOT_APPLICABLE')
     or coalesce(p ->> 'state', '') not in ('ENTERED', 'REVIEWED', 'APPROVED', 'INVALIDATED')
     or coalesce(p ->> 'recordedAt', '') !~ '^(0|[1-9][0-9]{0,15})$' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-LIMS-101 malformed lims.sample_result payload: conformance, state and recordedAt (epoch microseconds) are required';
  end if;
  r := p -> 'result';
  if jsonb_typeof(r) is distinct from 'object'
     or not ((r ?& array['value', 'unit'] and (select count(*) from jsonb_object_keys(r)) = 2
              and jsonb_typeof(r -> 'value') = 'string' and (r ->> 'value') ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
              and jsonb_typeof(r -> 'unit') = 'string' and (r ->> 'unit') ~ '^[\x21-\x7E]{1,16}$')
             or (r ? 'text' and (select count(*) from jsonb_object_keys(r)) = 1 and jsonb_typeof(r -> 'text') = 'string'
                 and length(r ->> 'text') between 1 and 500)) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-LIMS-101 malformed lims.sample_result payload: result is {value as decimal text, unit} or {text} (DI-31: the value as the LIMS recorded it)';
  end if;
  select l.id into v_lot from site.material_lot l where l.lot_code = p ->> 'lotNumber';
  if v_lot is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LIMS-103 LIMS sample %s names lot %s, which this installation does not hold (wrong batch)', p ->> 'sampleId', p ->> 'lotNumber');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('lims:' || (p ->> 'sampleId') || '/' || (p ->> 'testCode'), 0));
  select max(x.source_timestamp) into v_newer from site.lims_sample_result x where x.sample_id = p ->> 'sampleId' and x.test_code = p ->> 'testCode';
  if v_newer is not null and v_newer >= m.source_timestamp then
    raise exception using errcode = 'P0001',
      message = format('EBMR-LIMS-104 the LIMS state of sample %s test %s at %s is older than the one already applied (%s); it is not applied',
                       p ->> 'sampleId', p ->> 'testCode', m.source_timestamp, v_newer);
  end if;
  insert into site.lims_sample_result (lot_id, sample_id, test_code, specification_ref, raw_value, raw_unit, result_text, conformance, state,
                                       lims_recorded_at, message_id, source_timestamp)
  values (v_lot, p ->> 'sampleId', p ->> 'testCode', p ->> 'specificationRef', r ->> 'value', r ->> 'unit', r ->> 'text', p ->> 'conformance',
          p ->> 'state', platform.epoch_us_to_timestamptz(p ->> 'recordedAt'), m.id, m.source_timestamp);
  return v_out || jsonb_build_object('applied', 'RECORDED');
end
$$;

create function site.lims_lot_results(p_lot uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('sampleId', s.sample_id, 'testCode', s.test_code, 'specificationRef', s.specification_ref,
                                               'value', s.raw_value, 'unit', s.raw_unit, 'text', s.result_text, 'conformance', s.conformance,
                                               'state', s.state, 'messageId', s.message_id, 'sourceTimestamp', site.utc_text(s.source_timestamp))
                            order by s.sample_id, s.test_code), '[]'::jsonb)
  from (select distinct on (x.sample_id, x.test_code) x.* from site.lims_sample_result x where x.lot_id = p_lot
        order by x.sample_id, x.test_code, x.source_timestamp desc, x.received_at desc) s
$$;

revoke all on function site.receive_lims_sample_result(jsonb), site.lims_lot_results(uuid) from public;
grant select on site.lims_sample_result to ebmr_app;
grant execute on function site.receive_lims_sample_result(jsonb), site.lims_lot_results(uuid) to ebmr_app;

reset role;
