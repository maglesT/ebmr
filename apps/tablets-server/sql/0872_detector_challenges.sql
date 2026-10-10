-- Tablets server, Phase 3 slice 3c (builder A): the challenge records of TB-17 (compression-line reject and detection
-- devices: the metal detector and the weight-control reject gate; tablets spec B.2 TB-17). Controls IN-36 (e) (metal-
-- detector challenge records where a detector is fitted), IN-35 (e), DI-49; ADR 0012: the rules hold when the
-- application's own database credentials are used directly.
--
--   tab.test_piece          a certified test piece: code, kind (FERROUS, NON_FERROUS, STAINLESS, or REJECT_SAMPLE for a
--                           reject-gate challenge), size, certificate reference and the instant its certificate expires
--                           (MASTERDATA.CHANGE); insert-only
--   tab.detector_challenge  one challenge of a device of a press for a batch: the device (METAL_DETECTOR or REJECT_GATE)
--                           and its code, when (START, INTERVAL, AFTER_STOPPAGE, END), each test piece passed through with
--                           whether it was detected and rejected; passed only when every piece was; the hold it raised;
--                           person and database time (STEP.EXECUTE)
--
-- tab.record_detector_challenge refuses a piece that is not in the register, not of a kind the device is challenged
-- with, or whose certificate has expired at database time (EBMR-DET-010), and a press that has no open use of the batch
-- (EBMR-DET-011). A failed challenge holds every output container of the batch and press opened since that device's
-- last passing challenge (tab.hold_press_output, tablets 0871), so tablets made while the device may not have worked are
-- never used before QA has assessed them. What the TB-17 step records about a challenge stands on its row (tablets 0874).
--
-- Every table is insert-only, audited, its times the database's; the application role reads them and writes only
-- through the SECURITY DEFINER functions (pg_temp last, ADR 0016). Applied as a new migration because applied migrations
-- are checksummed and never edited.

set local role ebmr_owner;

create table tab.test_piece (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  kind             text not null check (kind in ('FERROUS', 'NON_FERROUS', 'STAINLESS', 'REJECT_SAMPLE')),
  size_value       text not null check (tab.is_decimal_text(size_value)),
  size_unit        text not null check (size_unit in ('mm', 'mg', 'units')),
  certificate_ref  text not null check (btrim(certificate_ref) <> ''),
  certified_until  timestamptz not null,
  person_id        uuid not null,
  account_id       uuid not null,
  recorded_at      timestamptz not null default clock_timestamp()
);

create table tab.detector_challenge (
  id                  uuid primary key default gen_random_uuid(),
  batch_id            uuid not null references recipe.batch_execution (id),
  press_equipment_id  uuid not null references plant.equipment (id),
  device              text not null check (device in ('METAL_DETECTOR', 'REJECT_GATE')),
  device_code         text not null check (device_code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  timing              text not null check (timing in ('START', 'INTERVAL', 'AFTER_STOPPAGE', 'END')),
  pieces              jsonb not null check (jsonb_typeof(pieces) = 'array' and jsonb_array_length(pieces) >= 1),
  passed              boolean not null,
  hold                jsonb,
  person_id           uuid not null,
  account_id          uuid not null,
  recorded_at         timestamptz not null default clock_timestamp()
);
create index detector_challenge_by_batch on tab.detector_challenge (batch_id, press_equipment_id, device, recorded_at);

select platform.enforce_db_time('tab.test_piece', array['recorded_at']);
select platform.enforce_db_time('tab.detector_challenge', array['recorded_at']);
select kernel.register_audited_table('tab.test_piece', 'test_piece', 'id', true);
select kernel.register_audited_table('tab.detector_challenge', 'detector_challenge', 'id', true);
revoke all on tab.test_piece, tab.detector_challenge from public;
grant select on tab.test_piece, tab.detector_challenge to ebmr_app;

-- MASTERDATA.CHANGE. p_def: {code, kind, size: {value, unit}, certificateRef, certifiedUntil (ISO instant)}.
create function tab.define_test_piece(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  if jsonb_typeof(p_def) is distinct from 'object' or jsonb_typeof(p_def -> 'size') is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'A test piece states its code, kind, size, certificate and certificate expiry (EBMR-DET-001)';
  end if;
  insert into tab.test_piece (code, kind, size_value, size_unit, certificate_ref, certified_until, person_id, account_id)
  values (p_def ->> 'code', p_def ->> 'kind', p_def -> 'size' ->> 'value', p_def -> 'size' ->> 'unit', p_def ->> 'certificateRef',
          (p_def ->> 'certifiedUntil')::timestamptz, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- STEP.EXECUTE (the batch's product). p_pieces: [{piece, detected, rejected}] (header). Returns {challengeId, passed,
-- hold}.
create function tab.record_detector_challenge(p_batch uuid, p_press text, p_device text, p_device_code text, p_timing text, p_pieces jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, plant, iam, pg_temp as $$
declare
  v_actor   jsonb;
  e         plant.equipment;
  v_bad     text;
  v_passed  boolean;
  v_since   timestamptz;
  v_hold    jsonb;
  v_id      uuid;
  v_pieces  jsonb;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  select * into e from plant.equipment where code = p_press;
  if e.id is null or not exists (select 1 from plant.equipment_use_status u where u.equipment_id = e.id and u.batch_id = p_batch and u.ended_at is null) then
    raise exception using errcode = 'P0001', message = format('EBMR-DET-011 %s is no press in use by this batch', coalesce(p_press, '(none)'));
  end if;
  if p_device not in ('METAL_DETECTOR', 'REJECT_GATE') or jsonb_typeof(p_pieces) is distinct from 'array' or jsonb_array_length(p_pieces) = 0
     or exists (select 1 from jsonb_array_elements(p_pieces) x
                 where jsonb_typeof(x) <> 'object' or jsonb_typeof(x -> 'piece') is distinct from 'string'
                    or jsonb_typeof(x -> 'detected') is distinct from 'boolean' or jsonb_typeof(x -> 'rejected') is distinct from 'boolean')
     or (select count(distinct x ->> 'piece') from jsonb_array_elements(p_pieces) x) <> jsonb_array_length(p_pieces) then
    raise exception using errcode = 'P0001', message = 'EBMR-DET-010 a challenge names its device and each test piece once, with whether it was detected and rejected';
  end if;
  select string_agg(x ->> 'piece', ', ') into v_bad from jsonb_array_elements(p_pieces) x left join tab.test_piece t on t.code = x ->> 'piece'
   where t.id is null or t.certified_until <= clock_timestamp()
      or (p_device = 'METAL_DETECTOR' and t.kind = 'REJECT_SAMPLE') or (p_device = 'REJECT_GATE' and t.kind <> 'REJECT_SAMPLE');
  if v_bad is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DET-010 test piece %s is not in the register, not of a kind for the %s, or its certificate has expired (IN-36 (e))', v_bad, p_device);
  end if;
  v_pieces := (select jsonb_agg(jsonb_build_object('piece', x ->> 'piece', 'kind', t.kind, 'size', jsonb_build_object('value', t.size_value, 'unit', t.size_unit),
                                                   'certifiedUntil', t.certified_until, 'detected', x -> 'detected', 'rejected', x -> 'rejected') order by x ->> 'piece')
                 from jsonb_array_elements(p_pieces) x join tab.test_piece t on t.code = x ->> 'piece');
  v_passed := not exists (select 1 from jsonb_array_elements(p_pieces) x where not ((x ->> 'detected')::boolean and (x ->> 'rejected')::boolean));
  if not v_passed then
    perform pg_advisory_xact_lock(hashtext('tab.detector_challenge:' || p_batch::text || ':' || e.id::text || ':' || p_device));
    select max(c.recorded_at) into v_since from tab.detector_challenge c
     where c.batch_id = p_batch and c.press_equipment_id = e.id and c.device = p_device and c.passed;
    v_hold := tab.hold_press_output(p_batch, e.code, v_since, format('%s %s challenge failed', p_device, p_device_code));
  end if;
  insert into tab.detector_challenge (batch_id, press_equipment_id, device, device_code, timing, pieces, passed, hold, person_id, account_id)
  values (p_batch, e.id, p_device, p_device_code, p_timing, v_pieces, v_passed, v_hold, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return jsonb_build_object('challengeId', v_id, 'passed', v_passed, 'hold', v_hold);
end
$$;

revoke all on function tab.define_test_piece(jsonb), tab.record_detector_challenge(uuid, text, text, text, text, jsonb) from public;
grant execute on function tab.define_test_piece(jsonb), tab.record_detector_challenge(uuid, text, text, text, text, jsonb) to ebmr_app;

reset role;
