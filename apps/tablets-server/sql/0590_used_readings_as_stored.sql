-- Tablets server, module C3 with C5: the scale readings a weighing captured from a device uses (evidence.readings) are
-- exactly its tare and its gross, in that order, each as stored, and nothing else (Phase 2 exit review F12, the round-6
-- verification; controls DI-05, DI-31, DI-32; ADR 0012: the rules hold when the application's own database credentials
-- are used directly).
--
-- 0300 binds a device weighing to the readings its evidence names by reading id and purpose, and the entry's balance,
-- weights and unit to the stored readings; 0520 binds the list a stale row names without using them (namedReadings)
-- whole. The rest of a used reading was read by nothing: its raw line, capture time and trust, the device, value and
-- unit the evidence states for it, and the order of the list. recipe-core 0335 now holds the list to the server's shape
-- (two members TARE and GROSS of exactly the reading's facts, the device a test device label), but a raw line or a time
-- is free text there, so, through the application role, an accepted device weighing whose evidence gave its tare the raw
-- line 'L2409-0017' was recorded (apps/tablets-server/test/execution/db-guards-used-readings.test.ts, before this
-- migration), and so was one stating another capture time, trust or value than the stored reading's, or listing the
-- gross first.
--
-- This migration adds tab.used_readings_check (trigger ac_tab_used_readings, before insert, after
-- ac_tab_device_entry_readings and ac_tab_stale_named_readings): evidence.readings, the readings a row uses, is exactly
-- the server's list of the two readings it names for TARE and GROSS: the tare, then the gross, each with the facts the
-- stored reading has (reading id, balance, value, unit, raw line, capture time, trust), and nothing else. EBMR-EXE-124,
-- the code of 0300 and 0520. Where the row may carry such a list at all (a RECORD_ENTRY captured from a device) is
-- recipe-core 0335's to say; which readings it may use (claimed for it, by this person's session, in this command) stays
-- 0300's.
--
-- Privileges: the trigger function is SECURITY DEFINER, owned by ebmr_owner, pg_temp last (ADR 0016), and nobody
-- executes it directly. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

create function tab.used_readings_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_used     jsonb := case when jsonb_typeof(new.evidence) = 'object' then new.evidence -> 'readings' end;
  v_expected jsonb := '[]'::jsonb;
  v_purpose  text;
  v_id       text;
  d          tab.device_reading%rowtype;
begin
  if v_used is null then
    return new;
  end if;
  -- The list the server writes: the tare, then the gross, each as the stored reading gives it (as 0520 for a stale row).
  foreach v_purpose in array array['TARE', 'GROSS'] loop
    v_id := null;
    if jsonb_typeof(v_used) = 'array' then
      select e ->> 'readingId' into v_id from jsonb_array_elements(v_used) e where e ->> 'purpose' = v_purpose limit 1;
    end if;
    d := null;
    if v_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into d from tab.device_reading where id = v_id::uuid;
    end if;
    v_expected := v_expected || jsonb_build_array(jsonb_build_object(
      'purpose', v_purpose, 'readingId', d.id, 'deviceCode', d.device_code, 'value', d.value, 'unit', d.unit, 'raw', d.raw,
      'sourceTimeUs', d.source_time_us::text, 'trust', d.trust));
  end loop;
  if v_used is distinct from v_expected then
    raise exception using errcode = 'P0001',
      message = format('A weighing captured from a device uses exactly its tare and its gross reading, in that order, each as stored, and nothing else: it names %s, the stored readings are %s (DI-31, DI-32). [EBMR-EXE-124]',
                       left(v_used::text, 2000), v_expected);
  end if;
  return new;
end
$$;

create trigger ac_tab_used_readings before insert on recipe.execution_command
  for each row execute function tab.used_readings_check();

revoke all on function tab.used_readings_check() from public;

reset role;
