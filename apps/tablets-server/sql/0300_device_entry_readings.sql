-- Tablets server, module C3 with C5: a weighing recorded as captured from a device stands on the scale readings its
-- command claimed (review finding P36, round-1 verification, residual c; controls DI-20, DI-31, DI-32).
--
-- recipe-core 0285 (EBMR-EXE-124) accepted a person's RECORD_ENTRY with source DEVICE whenever the balance it named was
-- an instrument of the terminal's room. It never asked whether a reading of that balance was claimed for the entry
-- (tab.reading_use), so a writer with the application role could record a direct weighing with invented weights, as
-- DEVICE evidence, without any reading. recipe-core 0300 now also asks for an ACTIVE instrument; this migration binds
-- the weights to the readings. A row trigger on recipe.execution_command (ac_tab_device_entry_readings, after the
-- recipe check ab_execution_source_room) refuses a person's COMMAND row of type RECORD_ENTRY whose entry says source
-- DEVICE unless its evidence (the server's evidence.readings, apps/tablets-server features/execution/intents.ts) names,
-- for each of TARE and GROSS, exactly one reading that
--   * was claimed for that purpose (tab.claim_readings) in this command: by the row's person, account and session,
--     under the row's correlation id, since this transaction began, for the row's room;
--   * is a stored reading of the balance the entry names, with exactly the weight and unit the entry states;
--   * backs no other row of this command (a claimed reading is used by one entry only; DI-32).
--   EBMR-EXE-124  the device entry does not stand on readings claimed for it.
-- This holds for accepted and refused rows alike: the server claims the readings before the engine decides, so a
-- refused device entry has them too. A hand-keyed weighing (source MANUAL) is not a device entry and is not checked
-- here.
--
-- Privileges: the trigger function is SECURITY DEFINER, owned by ebmr_owner, pg_temp last (ADR 0016), and nobody
-- executes it directly.

set local role ebmr_owner;

create function tab.device_entry_readings_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_entry   jsonb := new.command -> 'entry';
  v_purpose text;
  v_n       bigint;
  v_ev      jsonb;
  v_id      uuid;
  u         tab.reading_use%rowtype;
  d         tab.device_reading%rowtype;
  v_problem text;
begin
  if new.kind <> 'COMMAND' or new.source not in ('UI', 'API') or new.command_type <> 'RECORD_ENTRY' or v_entry ->> 'source' is distinct from 'DEVICE' then
    return new;
  end if;
  foreach v_purpose in array array['TARE', 'GROSS'] loop
    select count(*), (array_agg(e))[1] into v_n, v_ev
      from jsonb_array_elements(case when jsonb_typeof(new.evidence -> 'readings') = 'array' then new.evidence -> 'readings' else '[]'::jsonb end) e
     where e ->> 'purpose' = v_purpose;
    v_id := null;
    if v_n = 1 and (v_ev ->> 'readingId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_id := (v_ev ->> 'readingId')::uuid;
    end if;
    u := null;
    d := null;
    if v_id is not null then
      select * into u from tab.reading_use where reading_id = v_id;
      select * into d from tab.device_reading where id = v_id;
    end if;
    v_problem := case
      when v_n is distinct from 1 or v_id is null then format('it names %s %s reading', case when v_n = 0 then 'no' else 'no single, well-formed' end, lower(v_purpose))
      when u.reading_id is null or d.id is null then format('the %s reading %s was never claimed', lower(v_purpose), v_id)
      when u.purpose is distinct from v_purpose or u.room_code is distinct from new.room_code or u.person_id is distinct from new.actor_person
           or u.account_id is distinct from new.actor_account or u.session_id is distinct from new.session_id
           or u.correlation_id is distinct from new.correlation_id or u.claimed_at < transaction_timestamp()
        then format('the %s reading %s was not claimed as %s by this person''s session, in this command, for room %s', lower(v_purpose), v_id, lower(v_purpose), coalesce(new.room_code, '(none)'))
      when d.device_code is distinct from v_entry ->> 'balance' or d.value is distinct from v_entry ->> lower(v_purpose) or d.unit is distinct from v_entry ->> 'unit'
        then format('the %s reading %s is %s %s from %s, not the %s %s from %s the entry states', lower(v_purpose), v_id, coalesce(d.value, '?'), coalesce(d.unit, '?'),
                    d.device_code, coalesce(v_entry ->> lower(v_purpose), '?'), coalesce(v_entry ->> 'unit', '?'), coalesce(v_entry ->> 'balance', '?'))
      when exists (select 1 from recipe.execution_command c
                    where c.correlation_id = new.correlation_id
                      and c.evidence -> 'readings' @> jsonb_build_array(jsonb_build_object('readingId', v_ev ->> 'readingId')))
        then format('the %s reading %s already backs another entry', lower(v_purpose), v_id)
    end;
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('A weighing is recorded as captured from a device only on the scale readings claimed for it: %s (DI-31, DI-32). [EBMR-EXE-124]', v_problem);
    end if;
  end loop;
  return new;
end
$$;

create trigger ac_tab_device_entry_readings before insert on recipe.execution_command
  for each row execute function tab.device_entry_readings_check();

revoke all on function tab.device_entry_readings_check() from public;

reset role;
