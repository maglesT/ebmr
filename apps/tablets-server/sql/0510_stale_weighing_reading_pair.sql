-- Tablets server, module C3 with C5: the scale readings a weighing refused as stale names are checked as the claims of
-- its command would check them together, tare then gross, not each alone (Phase 2 exit follow-up F58.1, second round;
-- controls DI-32, DI-34, DI-31, DI-20; ADR 0012: the rules hold when the application's own database credentials are
-- used directly).
--
-- 0500 checked the readings of a stale weighing (a refusal ENG-STALE whose entry is a DEVICE weighing) one purpose at a
-- time, each with tab.peek_readings in a subtransaction of its own that was rolled back before the next. A claim is a
-- use, one per reading, so the command that uses the readings never claims one reading as both the tare and the gross:
-- the gross claim finds the reading used by the tare's and refuses it (EBMR-DEV-105), and nothing is written. Peeked
-- apart, both checks passed. A reading taken for no stated purpose (the gateway may send one; the claim then accepts it
-- as a tare or as a gross) named as both the tare and the gross of a weighing from an older screen was therefore
-- recorded as a refused row whose entry states the one weight as tare and gross, both from that reading, while the same
-- request from the current screen was refused before anything was written (verification of F58.1, gap 1). The row used
-- nothing and changed nothing, but the database accepted for it a device entry that the claims refuse.
--
-- This migration:
--   1. adds tab.peek_weighing_readings(p_tare, p_gross, p_room, p_max_age_us): the facts tab.claim_readings gives for
--      the tare reading as TARE and then for the gross reading as GROSS, to this actor, now, made as the command makes
--      them (two claims in one transaction, so the second sees the first's use) inside one subtransaction that is
--      rolled back: no use row, no audit entry of a use and no lock of them remain. A refusal of either claim is raised
--      as the claim raises it, so a reading named as both is refused as the command's own claims refuse it
--      (EBMR-DEV-105). Executable by the application role: the server names the readings of a stale weighing with it,
--      so a stale request gets the answer a request from the current screen gets, before anything is written;
--   2. replaces tab.device_entry_readings_check (trigger ac_tab_device_entry_readings of 0300). Every check of 0500 is
--      kept, in its order, for every row; for a stale weighing the claim check is made once, after the per-purpose
--      checks, on the pair (tab.peek_weighing_readings) instead of once per purpose;
--   3. drops tab.peek_readings (0500): it checked one purpose alone, which is what let the pair through, and nothing
--      calls it any more.
--
-- Correction of the 0500 header (applied migrations are never edited): it says a stale device entry names each reading
-- once and that each is one a claim by the person would accept now. Each was named once for its purpose, but one
-- reading could be named for both purposes, and each was checked alone. From here on the pair is one that the claims
-- of the command would accept now, together. Its item 1 (tab.peek_readings, executable by the application role) no
-- longer holds: the function is dropped here.
--
-- Privileges: both functions are SECURITY DEFINER, owned by ebmr_owner, pg_temp last (ADR 0016). Nobody executes the
-- trigger function directly; CREATE OR REPLACE keeps its owner and the trigger of 0300. Applied as a new migration
-- because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. The tare and gross readings as the claims of one command would give them, unused
-- ---------------------------------------------------------------------------------------------

create function tab.peek_weighing_readings(p_tare uuid, p_gross uuid, p_room text, p_max_age_us bigint) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_out jsonb;
begin
  begin
    -- As the command claims them: the tare, then the gross, in one transaction.
    v_out := tab.claim_readings(array[p_tare], p_room, p_max_age_us, 'TARE');
    v_out := v_out || tab.claim_readings(array[p_gross], p_room, p_max_age_us, 'GROSS');
    -- Undo both claims (their use rows, their audit entries): only this block's work is rolled back.
    raise exception using errcode = 'EBMRP', message = 'peeked';
  exception when sqlstate 'EBMRP' then
    null;
  end;
  return v_out;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The device entry check, with the stale refusal's readings checked as a pair
-- ---------------------------------------------------------------------------------------------

create or replace function tab.device_entry_readings_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_entry   jsonb := new.command -> 'entry';
  v_stale   boolean := new.accepted is false and new.refusal ->> 'code' = 'ENG-STALE';
  v_list    text;
  v_purpose text;
  v_n       bigint;
  v_ev      jsonb;
  v_id      uuid;
  v_named   uuid[] := '{}';
  u         tab.reading_use%rowtype;
  d         tab.device_reading%rowtype;
  v_problem text;
begin
  if new.kind <> 'COMMAND' or new.source not in ('UI', 'API') then
    return new;
  end if;
  if v_stale then
    select format('it claimed reading %s as %s', x.reading_id, lower(x.purpose)) into v_problem
      from tab.reading_use x
     where x.correlation_id = new.correlation_id and x.session_id = new.session_id and x.claimed_at >= transaction_timestamp()
     order by x.claimed_at, x.reading_id
     limit 1;
    if v_problem is null and new.evidence ? 'readings' then
      v_problem := 'it lists scale readings as used (evidence.readings)';
    end if;
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('This row is the refusal ENG-STALE of a command from a screen that showed an older version of the run, which uses no scale reading, but %s (DI-32). [EBMR-EXE-124]', v_problem);
    end if;
  end if;
  if new.command_type <> 'RECORD_ENTRY' or v_entry ->> 'source' is distinct from 'DEVICE' then
    return new;
  end if;
  v_list := case when v_stale then 'namedReadings' else 'readings' end;
  foreach v_purpose in array array['TARE', 'GROSS'] loop
    select count(*), (array_agg(e))[1] into v_n, v_ev
      from jsonb_array_elements(case when jsonb_typeof(new.evidence -> v_list) = 'array' then new.evidence -> v_list else '[]'::jsonb end) e
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
    if not v_stale then
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
    else
      v_problem := case
        when v_n is distinct from 1 or v_id is null then format('it names %s %s reading', case when v_n = 0 then 'no' else 'no single, well-formed' end, lower(v_purpose))
        when d.id is null then format('the %s reading %s does not exist', lower(v_purpose), v_id)
        when d.device_code is distinct from v_entry ->> 'balance' or d.value is distinct from v_entry ->> lower(v_purpose) or d.unit is distinct from v_entry ->> 'unit'
          then format('the %s reading %s is %s %s from %s, not the %s %s from %s the entry states', lower(v_purpose), v_id, coalesce(d.value, '?'), coalesce(d.unit, '?'),
                      d.device_code, coalesce(v_entry ->> lower(v_purpose), '?'), coalesce(v_entry ->> 'unit', '?'), coalesce(v_entry ->> 'balance', '?'))
        when exists (select 1 from recipe.execution_command c
                      where c.correlation_id = new.correlation_id
                        and (c.evidence -> 'readings' @> jsonb_build_array(jsonb_build_object('readingId', v_ev ->> 'readingId'))
                             or c.evidence -> 'namedReadings' @> jsonb_build_array(jsonb_build_object('readingId', v_ev ->> 'readingId'))))
          then format('the %s reading %s is named by another row of this command', lower(v_purpose), v_id)
      end;
    end if;
    if v_problem is not null and not v_stale then
      raise exception using errcode = 'P0001',
        message = format('A weighing is recorded as captured from a device only on the scale readings claimed for it: %s (DI-31, DI-32). [EBMR-EXE-124]', v_problem);
    end if;
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('A weighing refused as stale names the scale readings its screen captured, as they are stored and as the claims of its command would accept them now, and uses none: %s (DI-31, DI-32). [EBMR-EXE-124]', v_problem);
    end if;
    v_named := v_named || v_id;
  end loop;
  if v_stale then
    -- Every check of the claims the command would make, by this person, now, for the row's room, as it makes them: the
    -- tare, then the gross, in one transaction, so a reading named as both is refused as the gross claim refuses it
    -- (EBMR-DEV-105). The claim's own refusal (EBMR-DEV-1xx) is raised; nothing is used.
    perform tab.peek_weighing_readings(v_named[1], v_named[2], new.room_code, 3600000000);
  end if;
  return new;
end
$$;

revoke all on function tab.peek_weighing_readings(uuid, uuid, text, bigint) from public;
grant execute on function tab.peek_weighing_readings(uuid, uuid, text, bigint) to ebmr_app;

-- ---------------------------------------------------------------------------------------------
-- 3. The per-purpose peek of 0500, no longer called
-- ---------------------------------------------------------------------------------------------

drop function tab.peek_readings(uuid[], text, bigint, text);

reset role;
