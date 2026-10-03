-- Tablets server, module C3 with C5: a command recorded as the refusal ENG-STALE uses no scale reading, whatever the
-- order of the writes and whichever transaction or session makes them, checked at commit; and the readings such a row
-- names without using them are exactly its tare and its gross, as stored (Phase 2 exit follow-up F58.1, third round;
-- controls DI-32, DI-34, PR-19, DI-31; ADR 0012: the rules hold when the application's own database credentials are
-- used directly).
--
-- 0500 and 0510 check, when the stale row is inserted, only that its command has claimed nothing so far: no
-- tab.reading_use claimed in this transaction under its correlation id by its session. A writer holding the
-- application role recorded the honest stale weighing (it passed), then, in the same transaction, claimed the two
-- readings it named with tab.claim_readings under the row's own correlation id and session, and committed: a refused
-- ENG-STALE row whose evidence names the readings as not used, and two use rows that say its command used them. The
-- next accepted weighing with those readings was refused EBMR-DEV-105, and neither recipe.execution_violations() nor
-- the replay noticed (verification of F58.1, round 2, gap A). A claim in a later transaction under the row's
-- correlation id, or claims made earlier in another transaction and the stale row written after them, passed the same
-- way. The same verification found that 0510 reads only the TARE and GROSS entries of evidence.namedReadings and only
-- their reading ids: a third entry (a CHECK naming a used reading) or a forged value on a named entry was recorded
-- (gap B).
--
-- This migration:
--   1. adds tab.reading_claim_mark: one row per correlation id under which a scale reading was claimed (claimed) or a
--      row was recorded as the refusal ENG-STALE (stale_refusal), backfilled from the rows already stored. It holds no
--      fact of its own (each mark restates a tab.reading_use or recipe.execution_command row, both audited); it is the
--      one key on which two transactions of the same correlation id meet. Each check below sets its mark with INSERT
--      ... ON CONFLICT DO UPDATE and reads the other mark from the row it gets back: PostgreSQL 16 makes that statement
--      wait for a concurrent writer of the same key and then update its committed row (READ COMMITTED), or raise a
--      serialization failure when that row is newer than the transaction's snapshot (REPEATABLE READ, SERIALIZABLE),
--      so a claim and a stale row of one correlation id never both commit, in any order or at the same time. Only the
--      owner's trigger functions write it; no role is granted anything on it;
--   2. adds the constraint trigger zz_tab_stale_row_uses_no_reading on recipe.execution_command (after insert,
--      deferrable, initially deferred) for a row recorded as the refusal ENG-STALE: at commit it marks the row's
--      correlation id, and refuses the row when a scale reading was claimed under that correlation id, before or after
--      the row, in this transaction or in any other. EBMR-EXE-124;
--   3. adds the constraint trigger zz_tab_reading_use_not_stale on tab.reading_use (after insert, deferrable, initially
--      deferred): at commit it marks the claim's correlation id, and refuses the claim when a row recorded as the
--      refusal ENG-STALE carries that correlation id. EBMR-EXE-124. A claim made and undone in a rolled-back
--      subtransaction (tab.peek_weighing_readings, 0510, used by the server and by 0510's check of a stale weighing)
--      queues no check: PostgreSQL drops the deferred trigger events of an aborted subtransaction.
--      Both checks run at commit, after every write of the transaction. SET CONSTRAINTS ... IMMEDIATE only moves a
--      check to the end of its own statement; the later of the two writes is then checked against the earlier one, so
--      no order passes;
--   4. adds tab.stale_named_readings_check (trigger ac_tab_stale_named_readings, before insert, after
--      ac_tab_device_entry_readings and ac_tab_manual_weighing): evidence.namedReadings, the readings a row names
--      without using them, is present only on a row recorded as the refusal ENG-STALE of a RECORD_ENTRY whose entry
--      is captured from a device, and is then exactly the server's list of the two readings: the tare, then the gross,
--      each with the facts the stored reading has (reading id, balance, value, unit, raw line, capture time, trust),
--      and nothing else. EBMR-EXE-124.
--
-- The rule of items 2 and 3 is by correlation id, whatever the session: stricter than 0500's (correlation id and
-- session). The server gives every request a correlation id of its own (a random UUID per request), so the stale
-- request and the request that uses the readings (the resend from the reloaded screen) never share one, and a stale
-- request claims nothing (it peeks).
--
-- Corrections of earlier headers (applied migrations are never edited):
--   * 0500 says a stale row's command used no scale reading because none was claimed in this transaction under its
--     correlation id by its session, and the execution README and decision F58.2 say a stale row whose command claimed
--     readings is refused. That check ran when the row was inserted and saw only claims made before it in its own
--     transaction. From here on no claim under the row's correlation id commits at all, before or after the row, here
--     or in another transaction (items 2 and 3).
--   * 0500 and 0510 say the readings of a stale weighing are named "as stored": they compared the reading ids and the
--     weights, unit and balance of the entry only, and only the first TARE and GROSS entries. From here on the whole
--     list is bound (item 4).
--
-- Not covered (outside this follow-up, recorded in decision F58.2): a writer holding the application role can still
-- claim readings in a command that writes no row at all; nothing binds a claim to a row of its command. The record
-- then holds uses no row explains, never a stale row that used them.
--
-- Privileges: the three functions are SECURITY DEFINER trigger functions owned by ebmr_owner, pg_temp last in their
-- search_path (ADR 0016), executed by nobody directly. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. The marks of a correlation id
-- ---------------------------------------------------------------------------------------------

create table tab.reading_claim_mark (
  correlation_id  uuid primary key,
  -- A scale reading was claimed (tab.reading_use) under this correlation id.
  claimed         boolean not null default false,
  -- A row was recorded as the refusal ENG-STALE (recipe.execution_command) under this correlation id.
  stale_refusal   boolean not null default false
);
revoke all on tab.reading_claim_mark from public;

-- What is stored already. A correlation id may carry both marks here: before F58 (5ad9860) a stale weighing was
-- recorded with the readings it claimed. The checks below apply to what is written from now on.
insert into tab.reading_claim_mark (correlation_id, claimed, stale_refusal)
select x.correlation_id, bool_or(x.claimed), bool_or(x.stale_refusal)
  from (select u.correlation_id, true as claimed, false as stale_refusal from tab.reading_use u
        union all
        select c.correlation_id, false, true from recipe.execution_command c
         where c.accepted is false and c.refusal ->> 'code' = 'ENG-STALE') x
 group by x.correlation_id;

-- ---------------------------------------------------------------------------------------------
-- 2. A row recorded as the refusal ENG-STALE, at commit
-- ---------------------------------------------------------------------------------------------

create function tab.stale_row_claims_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_claimed boolean;
begin
  insert into tab.reading_claim_mark as m (correlation_id, stale_refusal) values (new.correlation_id, true)
  on conflict (correlation_id) do update set stale_refusal = true
  returning m.claimed into v_claimed;
  if v_claimed then
    raise exception using errcode = 'P0001',
      message = format('This row is the refusal ENG-STALE of a command from a screen that showed an older version of the run, which uses no scale reading, but a scale reading is claimed under its correlation id %s (checked at commit; DI-32). [EBMR-EXE-124]', new.correlation_id);
  end if;
  return null;
end
$$;

create constraint trigger zz_tab_stale_row_uses_no_reading after insert on recipe.execution_command
  deferrable initially deferred for each row
  when (new.accepted is false and new.refusal ->> 'code' = 'ENG-STALE')
  execute function tab.stale_row_claims_check();

revoke all on function tab.stale_row_claims_check() from public;

-- ---------------------------------------------------------------------------------------------
-- 3. A claim of a scale reading, at commit
-- ---------------------------------------------------------------------------------------------

create function tab.reading_use_stale_row_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_stale boolean;
begin
  insert into tab.reading_claim_mark as m (correlation_id, claimed) values (new.correlation_id, true)
  on conflict (correlation_id) do update set claimed = true
  returning m.stale_refusal into v_stale;
  if v_stale then
    raise exception using errcode = 'P0001',
      message = format('Scale reading %s is claimed under correlation id %s, which a row recorded as the refusal ENG-STALE carries; a command from a screen that showed an older version of the run uses no scale reading (checked at commit; DI-32). [EBMR-EXE-124]', new.reading_id, new.correlation_id);
  end if;
  return null;
end
$$;

create constraint trigger zz_tab_reading_use_not_stale after insert on tab.reading_use
  deferrable initially deferred for each row
  execute function tab.reading_use_stale_row_check();

revoke all on function tab.reading_use_stale_row_check() from public;

-- ---------------------------------------------------------------------------------------------
-- 4. The readings a row names without using them
-- ---------------------------------------------------------------------------------------------

create function tab.stale_named_readings_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_named    jsonb := case when jsonb_typeof(new.evidence) = 'object' then new.evidence -> 'namedReadings' end;
  v_expected jsonb := '[]'::jsonb;
  v_purpose  text;
  v_id       text;
  d          tab.device_reading%rowtype;
begin
  if v_named is null then
    return new;
  end if;
  if not (new.kind = 'COMMAND' and new.accepted is false and new.refusal ->> 'code' = 'ENG-STALE'
          and new.command_type = 'RECORD_ENTRY' and new.command -> 'entry' ->> 'source' = 'DEVICE') then
    raise exception using errcode = 'P0001',
      message = 'This row names scale readings it does not use (evidence.namedReadings); only the refusal ENG-STALE of an entry captured from a device names readings without using them (DI-32). [EBMR-EXE-124]';
  end if;
  -- The list the server writes: the tare, then the gross, each as the stored reading gives it.
  foreach v_purpose in array array['TARE', 'GROSS'] loop
    v_id := null;
    if jsonb_typeof(v_named) = 'array' then
      select e ->> 'readingId' into v_id from jsonb_array_elements(v_named) e where e ->> 'purpose' = v_purpose limit 1;
    end if;
    d := null;
    if v_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into d from tab.device_reading where id = v_id::uuid;
    end if;
    v_expected := v_expected || jsonb_build_array(jsonb_build_object(
      'purpose', v_purpose, 'readingId', d.id, 'deviceCode', d.device_code, 'value', d.value, 'unit', d.unit, 'raw', d.raw,
      'sourceTimeUs', d.source_time_us::text, 'trust', d.trust));
  end loop;
  if v_named is distinct from v_expected then
    raise exception using errcode = 'P0001',
      message = format('A weighing refused as stale names exactly its tare and its gross reading, in that order, each as stored, and nothing else: it names %s, the stored readings are %s (DI-31, DI-32). [EBMR-EXE-124]', v_named, v_expected);
  end if;
  return new;
end
$$;

create trigger ac_tab_stale_named_readings before insert on recipe.execution_command
  for each row execute function tab.stale_named_readings_check();

revoke all on function tab.stale_named_readings_check() from public;

reset role;
