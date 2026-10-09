-- Platform state engine: a history row, like a state row, must be a published transition that the aggregate's state
-- row records, whoever writes it; and a state row never commits without the history row that records it (Phase 2 exit,
-- SQL mutation kill work, defect D11; controls DI-17, DI-34; build outline 5.2 introduction and 4.4 "Privileges";
-- ADR 0012 decision 2).
--
-- Who can write these rows. Only the table owner (ebmr_owner) and superusers hold INSERT on platform.state_history and
-- platform.aggregate_state (0550 grants the application role SELECT only; inside a sandbox the sandbox role mirrors the
-- application role's privileges, 0820 and 0980, so it holds SELECT only too). The only owner-level code that writes
-- either table is the engine itself, platform.create_aggregate_state_at and platform.transition, and both compute every
-- value they write: the application or sandbox role that calls them (create_aggregate_state, transition) passes the
-- machine, the aggregate, the event and the expected version, all checked, and setting the engine flag beforehand gives
-- it nothing (the engine sets the flag itself and turns it off). Neither role can reach an insert of its own choosing.
--
-- Why. platform.guard_state_row (0550) let a write through only while the session setting platform.state_engine was
-- 'on', the engine flag. Any role can set that setting with set_config, so for owner-level code (another module's
-- function or trigger, a migration, a data fix written as the owner) it was no barrier. For a state row the guard
-- also checked the change against the published transitions, but for a history row it checked nothing more: with the
-- flag forged, the owner could write any history row, for example CHECKED -APPROVE-> APPROVED at version 100 of an MBR
-- version still CHECKED. recipe.version_state_at and recipe.valid_cells read the state history, so that version was
-- treated as APPROVED and a batch could be issued under it; platform.state_violations() found the row only afterwards.
-- The kernel's own state-machine test treats a forged flag as an attack the guards must withstand (D11, found by the
-- skeptic of the market-authorisation-and-issue group, reproduced by its kill agent).
--
-- 0550's header says the trigger refuses any state change that "does not come through the engine"; it refused only a
-- change made without the flag, which any role can set, so that claim held only for code that did not set it.
--
-- Now, whatever the flag says (the flag is still required, as before, and no longer suffices):
--   * A history row that records a transition (from_state set) must be a published transition of the aggregate's
--     pinned machine version (from_state, event and to_state), record the permission and the signature meaning that
--     transition publishes, and carry a signature id exactly when it needs a signature; it must continue the
--     aggregate's latest history row (that row is at from_version, in from_state, under the same machine version); and
--     the aggregate's state row must record it (to_state at to_version, same machine version), as the engine updates
--     the state row just before it writes the history row. A history row that creates an aggregate (from_state null)
--     must be version 1 in the initial state of a published machine version, record that version's create permission
--     and no signature, be the aggregate's first history row, and agree with the state row the engine has just
--     inserted. Otherwise EBMR-PLAT-077, naming the row and what it does not match.
--   * A state row's insert names a machine that governs its aggregate type (EBMR-PLAT-072; the engine already refused
--     this in create_aggregate_state_at, the guard did not).
--   * At commit, every state row written in the transaction equals its aggregate's latest history row (state, version
--     and machine version): a state row that changed without its history row is refused (EBMR-PLAT-078), so the
--     agreement platform.state_violations() reported afterwards now holds when the transaction commits. A constraint
--     trigger deferred to the commit, because the engine writes the state row first and the history row next. A
--     transaction that sets its constraints IMMEDIATE before a transition makes the check run between the two writes,
--     and its transition is refused (fail closed); no code of the product does so.
--
-- What it does not do. Owner-level code that forges the flag can still make a published transition the engine would
-- make, writing both rows so that they agree, without the engine's checks of permission, signature and guards: the
-- guard sees rows, not the code that wrote them, and owner-level code can also change the owner's own tables in other
-- ways (its triggers included). The guards now hold history rows to what they already held state rows to: only a
-- published transition, in sequence, recorded in both tables. A signature id on such a row is not verified here (the
-- signature check needs the state the transition leaves, which the state row no longer shows when the history row is
-- written). A superuser who disables the triggers bypasses all of this, as before, and platform.state_violations()
-- still reports what it can see.
--
-- Same signature, language, owner (ebmr_owner), search_path (pg_temp last) and SECURITY DEFINER for the guard; the
-- triggers of 0550 call it by name and are kept. Applied as a new migration because applied migrations are checksummed
-- and never edited.

set local role ebmr_owner;

create or replace function platform.guard_state_row() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v_version platform.machine_version%rowtype;
  v_machine platform.machine%rowtype;
  v_t       platform.machine_transition%rowtype;
  v_state   platform.aggregate_state%rowtype;
  v_latest  platform.state_history%rowtype;
  v_row     text;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-072 aggregate state rows are never deleted';
  end if;
  if coalesce(current_setting('platform.state_engine', true), '') <> 'on' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-072 %s rows change only through platform.transition', tg_table_name);
  end if;

  if tg_table_name = 'aggregate_state' then
    if tg_op = 'INSERT' then
      select * into v_version from platform.machine_version where machine_code = new.machine_code and version = new.machine_version;
      select * into v_machine from platform.machine where code = new.machine_code;
      if v_version.definition_hash is null or new.version <> 1 or new.state <> v_version.initial_state
         or v_machine.aggregate_type is distinct from new.aggregate_type then
        raise exception using errcode = 'P0001',
          message = 'EBMR-PLAT-072 a new aggregate starts at version 1 in the initial state of a published machine version that governs its aggregate type';
      end if;
    else
      if new.aggregate_type <> old.aggregate_type or new.aggregate_id <> old.aggregate_id or new.machine_code <> old.machine_code
         or new.machine_version <> old.machine_version or new.version <> old.version + 1
         or not exists (select 1 from platform.machine_transition t
                        where t.machine_code = old.machine_code and t.machine_version = old.machine_version
                          and t.from_state = old.state and t.to_state = new.state) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-PLAT-072 %s -> %s is not a published transition of %s v%s', old.state, new.state, old.machine_code, old.machine_version);
      end if;
      new.updated_at := clock_timestamp();
    end if;
    return new;
  end if;

  -- platform.state_history (insert-only: an update or delete is refused by its audit registration, 0550).
  if tg_op <> 'INSERT' then
    return new;
  end if;
  v_row := case when new.from_state is null then format('that creates it in %s at version %s', new.to_state, new.to_version)
                else format('%s -%s-> %s at version %s', new.from_state, new.event, new.to_state, new.to_version) end;

  -- 1. A published transition of the pinned machine version (or the start of a published version), recording what
  --    that transition publishes.
  if new.from_state is null then
    select * into v_version from platform.machine_version where machine_code = new.machine_code and version = new.machine_version;
    select * into v_machine from platform.machine where code = new.machine_code;
    if v_version.definition_hash is null or v_machine.aggregate_type is distinct from new.aggregate_type
       or new.to_version <> 1 or new.to_state <> v_version.initial_state then
      raise exception using errcode = 'P0001',
        message = format('EBMR-PLAT-077 the history row of %s:%s %s does not start a published version of %s v%s (%s at version 1)',
                         new.aggregate_type, new.aggregate_id, v_row, new.machine_code, new.machine_version,
                         coalesce(v_version.initial_state, 'none'));
    end if;
    if new.permission_code is distinct from v_version.create_permission or new.signature_meaning is not null or new.signature_id is not null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-PLAT-077 the history row of %s:%s %s does not record what the published transition requires (permission %s, signature none)',
                         new.aggregate_type, new.aggregate_id, v_row, v_version.create_permission);
    end if;
  else
    select * into v_t from platform.machine_transition t
     where t.machine_code = new.machine_code and t.machine_version = new.machine_version
       and t.from_state = new.from_state and t.event = new.event and t.to_state = new.to_state;
    if not found then
      raise exception using errcode = 'P0001',
        message = format('EBMR-PLAT-077 the history row of %s:%s %s is not a published transition of %s v%s',
                         new.aggregate_type, new.aggregate_id, v_row, new.machine_code, new.machine_version);
    end if;
    if new.permission_code is distinct from v_t.permission_code or new.signature_meaning is distinct from v_t.signature_meaning
       or (new.signature_id is null) <> (v_t.signature_meaning is null) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-PLAT-077 the history row of %s:%s %s does not record what the published transition requires (permission %s, signature %s)',
                         new.aggregate_type, new.aggregate_id, v_row, v_t.permission_code, coalesce(v_t.signature_meaning, 'none'));
    end if;
  end if;

  -- 2. It continues the aggregate's latest history row: none for a creation row; else that row is at from_version, in
  --    from_state, under the same machine version.
  select * into v_latest from platform.state_history h
   where h.aggregate_type = new.aggregate_type and h.aggregate_id = new.aggregate_id
   order by h.to_version desc limit 1;
  if (new.from_state is null and v_latest.id is not null)
     or (new.from_state is not null
         and (v_latest.id is null or v_latest.to_version <> new.from_version or v_latest.to_state <> new.from_state
              or v_latest.machine_code <> new.machine_code or v_latest.machine_version <> new.machine_version)) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-077 the history row of %s:%s %s does not continue its latest history row (%s)',
                       new.aggregate_type, new.aggregate_id, v_row,
                       case when v_latest.id is null then 'none' else format('%s at version %s', v_latest.to_state, v_latest.to_version) end);
  end if;

  -- 3. The aggregate's state row records it (the engine writes the state row first).
  select * into v_state from platform.aggregate_state s
   where s.aggregate_type = new.aggregate_type and s.aggregate_id = new.aggregate_id;
  if not found or v_state.state <> new.to_state or v_state.version <> new.to_version
     or v_state.machine_code <> new.machine_code or v_state.machine_version <> new.machine_version then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-077 the history row of %s:%s %s differs from its state row (%s)',
                       new.aggregate_type, new.aggregate_id, v_row,
                       case when v_state.aggregate_id is null then 'none'
                            else format('%s at version %s, %s v%s', v_state.state, v_state.version, v_state.machine_code, v_state.machine_version) end);
  end if;
  return new;
end
$$;

-- At commit: the state row equals its aggregate's latest history row (deferred: the engine writes the state row first,
-- the history row next).
create function platform.state_row_history_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v_state  platform.aggregate_state%rowtype;
  v_latest platform.state_history%rowtype;
begin
  select * into v_state from platform.aggregate_state s
   where s.aggregate_type = new.aggregate_type and s.aggregate_id = new.aggregate_id;
  select * into v_latest from platform.state_history h
   where h.aggregate_type = new.aggregate_type and h.aggregate_id = new.aggregate_id
   order by h.to_version desc limit 1;
  if v_latest.id is null or v_latest.to_state <> v_state.state or v_latest.to_version <> v_state.version
     or v_latest.machine_code <> v_state.machine_code or v_latest.machine_version <> v_state.machine_version then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-078 the state row of %s:%s (%s at version %s, %s v%s) is not its latest history row (%s): a state changes only together with its history row, through platform.transition',
                       v_state.aggregate_type, v_state.aggregate_id, v_state.state, v_state.version, v_state.machine_code, v_state.machine_version,
                       case when v_latest.id is null then 'none'
                            else format('%s at version %s, %s v%s', v_latest.to_state, v_latest.to_version, v_latest.machine_code, v_latest.machine_version) end);
  end if;
  return null;
end
$$;

create constraint trigger zz_state_row_has_history after insert or update on platform.aggregate_state
  deferrable initially deferred for each row execute function platform.state_row_history_check();

revoke all on function platform.state_row_history_check() from public;

reset role;
