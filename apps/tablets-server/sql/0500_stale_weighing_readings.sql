-- Tablets server, module C3 with C5: a weighing refused because its screen showed an older version of the run (the
-- engine's ENG-STALE) is recorded with the scale readings it names, without using them (Phase 2 exit review F58 and its
-- follow-up F58.1; controls DI-34, DI-32, DI-31, DI-20; ADR 0012: the rules hold when the application's own database
-- credentials are used directly).
--
-- F58: the run command claimed the tare and gross readings while resolving the intent, before the engine's first check
-- (ENG-STALE), and committed the refusal with the claims, so a weighing refused only because the run had moved on spent
-- both readings. The first fix answered a stale request before anything was written: the readings stayed usable, but
-- the attempt was no longer a row of the run, against DI-34's rule that a refused engine call is a row with its refusal.
-- Recording it again with its readings claimed was not possible: 0300 (EBMR-EXE-124) refuses a device entry, accepted
-- or refused, unless every reading it names was claimed for it in its own command, and a claim is a use (tab.reading_use,
-- one use per reading); rolling the claims back to a savepoint would leave a row 0300 refuses. Nor can the entry be
-- recorded without its source: 0310 (EBMR-EXE-121) refuses a weighing that is neither DEVICE nor MANUAL, and a weight
-- from the scale is never recorded as keyed by hand.
--
-- The server now resolves a stale request as any other, except that the scale readings are named, not used: their
-- facts come from tab.peek_readings (below), and the row lists them as evidence.namedReadings, never as
-- evidence.readings (the readings a row used). The engine refuses the command ENG-STALE; recipe-core 0326 proves the
-- refusal is the engine's answer to a command from an older screen and that the row changes nothing.
--
-- This migration:
--   1. adds tab.peek_readings(p_ids, p_room, p_max_age_us, p_purpose): the facts tab.claim_readings gives for these
--      readings, to this actor, now, with every check of the claim (the person may execute steps here; the reading
--      exists, keeps its proof, is a stable weight of this installation from an active instrument of the session's
--      room bound to an active gateway key, is no older than the policy allows, was taken for the purpose, is unused),
--      after which the claim is undone: it is made inside a subtransaction that is rolled back, so no use row, no audit
--      entry of a use and no lock of it remain. A refusal of the claim is raised as the claim raises it. Executable by
--      the application role (the server names the readings of a stale weighing with it);
--   2. replaces tab.device_entry_readings_check (trigger ac_tab_device_entry_readings of 0300). For every row but a
--      refusal ENG-STALE nothing changes: a device entry stands, for each of TARE and GROSS, on exactly one reading of
--      evidence.readings claimed for that purpose in this command by this person's session for the row's room, stored
--      with exactly the weight and unit the entry states from the balance it names, and backing no other row of this
--      command. For a row recorded as the refusal ENG-STALE (recipe-core 0326 proves it is one: the command's screen
--      showed another version than the run's, and the row changes nothing but the time sweep's findings):
--        EBMR-EXE-124  the command used no scale reading: none was claimed in this transaction under its correlation
--                      id by its session, and it lists none as used (no evidence.readings);
--        EBMR-EXE-124  a device entry names, for each of TARE and GROSS, exactly one reading in evidence.namedReadings,
--                      stored with exactly the weight and unit the entry states from the balance it names, named by no
--                      other row of this command, and one the person could claim now for that purpose
--                      (tab.peek_readings: the claim's own refusal, EBMR-DEV-1xx, otherwise). The readings stay unused,
--                      so the accepted command from the reloaded screen claims them.
--      The weights of a stale row are therefore as genuine as those of any device entry: readings of an active balance
--      of the row's room, proven, fresh and taken for their purpose; only their use is not made, because the row uses
--      nothing.
--
-- Correction of earlier headers (applied migrations are never edited): 0300 says the rule holds for accepted and refused
-- rows alike because the server claims the readings before the engine decides; recipe-core 0300 says the same of
-- EBMR-EXE-124's balance check. Both still hold for every row except a refusal ENG-STALE, which names its readings
-- without claiming them (the balance check of recipe-core 0300 applies to it unchanged). And tablets 0360 says a claimed
-- reading is used only in the transaction that claims it: tab.peek_readings claims and releases it in one subtransaction.
--
-- Privileges: both functions are SECURITY DEFINER, owned by ebmr_owner, pg_temp last (ADR 0016). Nobody executes the
-- trigger function directly; CREATE OR REPLACE keeps its owner and the trigger of 0300. Applied as a new migration
-- because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. The readings as a claim would give them, unused
-- ---------------------------------------------------------------------------------------------

create function tab.peek_readings(p_ids uuid[], p_room text, p_max_age_us bigint, p_purpose text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_out jsonb;
begin
  begin
    v_out := tab.claim_readings(p_ids, p_room, p_max_age_us, p_purpose);
    -- Undo the claim (its use rows, its audit entries): only this block's work is rolled back.
    raise exception using errcode = 'EBMRP', message = 'peeked';
  exception when sqlstate 'EBMRP' then
    null;
  end;
  return v_out;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The device entry check, with the stale refusal's readings named and not used
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
      if v_problem is null then
        -- Every check of a claim for this purpose, by this person, now, for the row's room; nothing is used.
        perform tab.peek_readings(array[v_id], new.room_code, 3600000000, v_purpose);
      end if;
    end if;
    if v_problem is not null and not v_stale then
      raise exception using errcode = 'P0001',
        message = format('A weighing is recorded as captured from a device only on the scale readings claimed for it: %s (DI-31, DI-32). [EBMR-EXE-124]', v_problem);
    end if;
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('A weighing refused as stale names the scale readings its screen captured, as they are stored and as a claim by this person would accept them now, and uses none: %s (DI-31, DI-32). [EBMR-EXE-124]', v_problem);
    end if;
  end loop;
  return new;
end
$$;

revoke all on function tab.peek_readings(uuid[], text, bigint, text) from public;
grant execute on function tab.peek_readings(uuid[], text, bigint, text) to ebmr_app;

reset role;
