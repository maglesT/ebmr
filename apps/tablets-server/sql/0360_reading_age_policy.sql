-- Tablets edition, scale readings (module M6-C5): the oldest a scale reading may be when a person's entry uses it is a
-- policy of the database, not the caller's word (Phase 2 exit review F38; DI-28, DI-32, DI-31; ADR 0012: the rules
-- hold when the application's own database credentials are used directly).
--
-- tab.claim_readings (0320) compared a reading's proven age (the gateway's signed wait plus the database time since it
-- was recorded, 0330; and the signed capture time of a DEVICE_SYNCED reading) only with p_max_age_us, which the caller
-- names and which could be anything from 1 microsecond to 1 hour. The policy, 120 s (M6-C5), lived only in the server
-- (apps/tablets-server/src/features/execution/intents.ts READING_MAX_AGE_US). A writer holding the application role
-- therefore recorded a weighing as captured from the scale (source DEVICE) on readings up to an hour old, a backlog
-- uploaded after an outage for example, by passing 3600 s (the executed-attacks reproducer and its verification).
--
-- This migration:
--   1. adds the platform setting device.reading_max_age_s: INTEGER seconds, default 120, allowed 5 to 120. It is
--      changed like any platform setting (platform.set_setting: PLATFORM.SETTINGS_CHANGE, a reason, audited), and only
--      ever tightened below the 120 s of M6-C5;
--   2. replaces tab.claim_readings: the maximum age applied is the lesser of the caller's p_max_age_us and the
--      setting (as iam.consume_auth_event caps a caller's maximum age with its policy, kernel 0160), in the proven-age
--      check and in the capture-time check of a DEVICE_SYNCED reading; the refusal (EBMR-DEV-104) names the maximum
--      applied. The rest is exactly as 0320 defined it (the caller's value is still bounded to 1 microsecond .. 1 hour,
--      EBMR-DEV-108).
--
-- A claimed reading is used only in the transaction that claims it (tablets 0300, EBMR-EXE-124), so the age checked at
-- the claim is the age of the committed entry. CREATE OR REPLACE keeps the owner (ebmr_owner), SECURITY DEFINER, the
-- volatility, the search_path and the privileges of 0320 (executable by the application roles). Applied as a new
-- migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

insert into platform.setting_definition (key, value_type, default_value, min_value, max_value, allowed_values, max_scale, unit, description, basis) values
  ('device.reading_max_age_s', 'INTEGER', '120', 5, 120, null, null, 's',
   'Oldest a scale reading may be, by its proven age, when a person''s entry uses it as captured from the scale; the database applies the lesser of this and what the caller asks',
   'DI-28, DI-32 design choice (M6-C5): default 120 s; allowed 5-120 s, so a site may only tighten it; Phase 2 exit review F38');

create or replace function tab.claim_readings(p_ids uuid[], p_room text, p_max_age_us bigint, p_purpose text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor     jsonb := iam.assert_validated_actor();
  v_scope     jsonb;
  v_room      text;
  v_eval      jsonb;
  v_r         tab.device_reading%rowtype;
  v_loc       jsonb;
  v_problem   jsonb;
  v_now       bigint := platform.epoch_micros(clock_timestamp());
  v_age       numeric;
  v_tolerance numeric;
  v_max       numeric;
  v_out       jsonb := '[]'::jsonb;
  v_id        uuid;
begin
  perform iam.assert_not_administrator();
  if v_actor ->> 'source' not in ('UI', 'API') then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-100 DI-31: only a person''s entry can use a scale reading';
  end if;
  -- The person must be able to execute steps (or dispense) where they are.
  v_scope := iam.actor_location_scope();
  v_eval := iam.evaluate_authority((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, 'DISPENSE.EXECUTE', v_scope,
                                   clock_timestamp(), v_actor ->> 'role_code');
  if not (v_eval ->> 'allowed')::boolean then
    perform iam.require_permission('STEP.EXECUTE', v_scope);
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-101 no reading ids to claim';
  end if;
  if (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids) or array_position(p_ids, null) is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-107 DI-32: a reading can be used only once, and each id only once per entry';
  end if;
  -- DI-20: the room is the one of the actor's session (its enrolled terminal's room when the session opened), never
  -- the caller's word; the room the caller names must be that same room.
  v_room := v_scope ->> 'area';
  if v_room is null or p_room is null or btrim(p_room) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-103 DI-20: a scale reading can be used only on a terminal registered to a room';
  end if;
  if p_room <> v_room then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-103 DI-20: the claim names room %s, but the terminal of this session is in room %s', p_room, v_room);
  end if;
  if p_max_age_us is null or p_max_age_us <= 0 or p_max_age_us > 3600000000 then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-108 the maximum reading age must be between 1 microsecond and 1 hour';
  end if;
  -- DI-28 (F38): the caller may only ask for fresher readings than the policy, never older ones.
  v_max := least(p_max_age_us::numeric, platform.setting_numeric('device.reading_max_age_s') * 1000000);
  if coalesce(btrim(p_purpose), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-106 a claim names its purpose';
  end if;
  -- DI-28 (P53): the tolerance between the database clock and a gateway's synchronised clock: each may be off the
  -- common reference by up to the site's drift alarm threshold.
  v_tolerance := 2 * platform.setting_numeric('time.drift_alarm_threshold_s') * 1000000;

  foreach v_id in array p_ids loop
    select * into v_r from tab.device_reading where id = v_id;
    if not found then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-101 DI-32: reading %s does not exist', v_id);
    end if;
    -- DI-31, DI-32: the stored reading still carries its proof (hash, gateway signature, raw line).
    v_problem := tab.device_reading_problem(v_r);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-110 DI-31: reading %s cannot be used: %s', v_id, v_problem ->> 'message');
    end if;
    if v_r.status <> 'OK' or not v_r.stable or v_r.value is null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-102 DI-32: reading %s is %s, not a stable weight', v_id, v_r.status);
    end if;
    if v_r.installation <> kernel.installation_kind() then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-043 DI-20: reading %s is from a %s installation', v_id, v_r.installation);
    end if;
    v_loc := iam.check_device_location(v_r.instrument_device_id, v_room, null);
    if not (v_loc ->> 'accepted')::boolean then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-103 DI-20: reading %s comes from %s (%s), which is not an active instrument of room %s',
                         v_id, v_r.device_code, coalesce(v_loc ->> 'reason', 'refused'), v_room);
    end if;
    if not exists (select 1 from iam.device where id = v_r.instrument_device_id and device_class = 'INSTRUMENT') then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-103 DI-20: %s is not an instrument', v_r.device_code);
    end if;
    if not exists (select 1 from tab.gateway_key k join tab.gateway_instrument b on b.gateway_key_id = k.id
                    where k.id = v_r.chain_id and k.status = 'ACTIVE' and b.instrument_device_id = v_r.instrument_device_id
                      and b.ended_at is null) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-109 DI-31: reading %s came through a gateway key or instrument binding that is no longer active', v_id);
    end if;
    v_age := case when v_r.uplink_delay_us is null then null else v_now::numeric - v_r.recorded_us + v_r.uplink_delay_us end;
    if v_age is null or v_age > v_max then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-104 DI-28: reading %s is too old to use (older than %s s, or its capture time is not known); take a new reading',
                         v_id, round(v_max / 1000000.0, 1));
    end if;
    -- DI-28 (P53): a reading taken on a synchronised clock carries a capture time the gateway signed; its age by that
    -- time bounds whatever wait was reported for it, including a wait before the ingesting transaction began.
    if v_r.trust = 'DEVICE_SYNCED' and v_now::numeric - v_r.source_time_us > v_max + v_tolerance then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-104 DI-28: reading %s was captured %s s ago by the gateway''s synchronised clock, more than %s s plus a clock tolerance of %s s; take a new reading',
                         v_id, round((v_now::numeric - v_r.source_time_us) / 1000000.0, 1), round(v_max / 1000000.0, 1),
                         round(v_tolerance / 1000000.0, 3));
    end if;
    if p_purpose in ('TARE', 'GROSS', 'CHECK') and v_r.purpose is not null and v_r.purpose <> p_purpose then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-106 DI-32: reading %s was taken as %s and cannot be used as %s', v_id, v_r.purpose, p_purpose);
    end if;
    begin
      insert into tab.reading_use (reading_id, purpose, room_code, person_id, account_id, session_id, correlation_id)
      values (v_id, p_purpose, v_room, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid,
              (v_actor ->> 'correlation_id')::uuid);
    exception when unique_violation then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-105 DI-32: reading %s has already been used', v_id);
    end;
    perform kernel.audit_business_event('device_reading:' || v_id,
      format('Scale reading %s %s from %s used as %s in room %s', v_r.value, v_r.unit, v_r.device_code, p_purpose, v_room),
      jsonb_build_object('purpose', p_purpose, 'room', v_room));
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'readingId', v_id, 'value', v_r.value, 'unit', v_r.unit, 'raw', v_r.raw, 'deviceCode', v_r.device_code,
      'sourceTimeUs', v_r.source_time_us::text, 'trust', v_r.trust));
  end loop;
  return v_out;
end
$$;

-- Privileges: CREATE OR REPLACE kept those of 0320 (tab.claim_readings executable by the application roles).

reset role;
