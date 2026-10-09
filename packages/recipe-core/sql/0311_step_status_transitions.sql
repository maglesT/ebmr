-- Recipe core, execution store (module C3): a step instance changes its status only along the engine's life cycle, by
-- the act that moves it, and an act is taken only in the status the engine takes it in (Phase 2 exit review F66,
-- round-2 verification; DI-34, PR-13, PR-14, INV-18; ADR 0012: the rules hold when the application's own database
-- credentials are used directly).
--
-- 0307 refuses a step instance that is NEW in the state where the token cannot have reached it. It did not look at an
-- instance already in the state. The round-2 verification issued a dc-mini variant whose alternative, decided by the
-- issue variant, did not take the branch holding p-alt-sop: the instance came in NOT_APPLICABLE and the honest START
-- was refused (ENG-STEP-STATUS). operator1's START_STEP of it was then stored through the application role with the
-- engine result computed as if the instance were ENABLED: 0300 checks only the status the act leaves (IN_PROGRESS),
-- never the status it starts from, and 0307's completion mark was kept. The unmodified server then took the entry and
-- the PERFORMED signature, and the untaken branch ended COMPLETED; only the invariant query noticed, after the fact.
-- Besides, an accepted CORRECT_ENTRY is exempt from 0300's check of the other step instances (it may send finished
-- steps back for re-verification), so such a row could move any instance to any status.
--
-- This migration adds a row trigger on recipe.execution_state (zf_execution_step_status, after update; every row:
-- a person's row, a preparation, a time sweep), refused with EBMR-EXE-132 (DI-34, PR-13):
--
--   1. The act's own status (recipe.act_status_before; engine guards.ts requireStepStatus): an accepted step command
--      acts on its own step instance (the step and context it names), which the state before the row holds in the
--      status the engine takes that act in: START_STEP, REQUEST_SKIP and DISPOSITION_HOLD_POINT an ENABLED instance;
--      RECORD_DATA, RECORD_ENTRY, VOID_ATTEMPT and SIGN_PERFORMED one IN_PROGRESS; VERIFY one AWAITING_VERIFICATION.
--
--   2. Every status change of an instance of the state before the row is one the engine makes, by the row that makes
--      it (engine steps.ts and corrections.ts):
--        ENABLED -> IN_PROGRESS                            its own accepted START_STEP
--        ENABLED -> SKIPPED                                its own accepted REQUEST_SKIP
--        ENABLED -> COMPLETED                              its own accepted DISPOSITION_HOLD_POINT (a release)
--        IN_PROGRESS -> AWAITING_VERIFICATION or COMPLETED its own accepted SIGN_PERFORMED
--        AWAITING_VERIFICATION -> COMPLETED                its own accepted VERIFY
--        COMPLETED -> AWAITING_VERIFICATION                an accepted CORRECT_ENTRY or INVALIDATE_RESULT (the step of
--                                                          the changed value and the steps whose computed values it
--                                                          recomputes are sent back for re-verification)
--        COMPLETED or AWAITING_VERIFICATION -> IN_PROGRESS an accepted INVALIDATE_RESULT of a value of that step (left
--                                                          without a valid value, it is reopened for the re-test)
--      Nothing else: a NOT_APPLICABLE or SKIPPED instance never changes its status, and no instance goes back to
--      ENABLED. A new instance is 0307's (the token advance, checked against the flow).
--
-- With 0307 this closes the order: an instance comes in only where the token can be, and leaves ENABLED or
-- NOT_APPLICABLE only by the act the engine allows there. The core of the check is the pure function
-- recipe.step_status_problem, compared with the engine's own runs (packages/recipe-core/test/execution
-- step-status-sql.test.ts). A status change cannot be judged after the fact from the stored rows (only the last state
-- is kept), so the invariant query has no arm for it; the write-time refusal is the enforcement.
--
-- New functions are owned by ebmr_owner and private to the owner (no EXECUTE for PUBLIC); the trigger function is
-- SECURITY DEFINER; every function pins its search_path with pg_temp last. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- The status the engine needs the step instance of an accepted command of type p_type to have before it (engine
-- guards.ts requireStepStatus in steps.ts and corrections.ts); NULL for a command that is no act on its own step.
create function recipe.act_status_before(p_type text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_type
           when 'START_STEP' then 'ENABLED'
           when 'REQUEST_SKIP' then 'ENABLED'
           when 'DISPOSITION_HOLD_POINT' then 'ENABLED'
           when 'RECORD_DATA' then 'IN_PROGRESS'
           when 'RECORD_ENTRY' then 'IN_PROGRESS'
           when 'VOID_ATTEMPT' then 'IN_PROGRESS'
           when 'SIGN_PERFORMED' then 'IN_PROGRESS'
           when 'VERIFY' then 'AWAITING_VERIFICATION'
         end
$$;

-- DI-34, PR-13 (F66, round 2): why the step instances of state p_new, which the row (kind p_kind, accepted p_accepted,
-- command p_command as recorded) stores after state p_old, are not in a status the engine's act can leave them in
-- (header items 1 and 2); NULL when they are. The text completes "This <row> ...".
create function recipe.step_status_problem(p_old jsonb, p_new jsonb, p_kind text, p_accepted boolean, p_command jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_done  boolean := p_kind = 'COMMAND' and p_accepted is true;
  v_type  text := case when p_kind = 'COMMAND' then p_command ->> 'type' end;
  v_need  text := case when p_kind = 'COMMAND' and p_accepted is true then recipe.act_status_before(p_command ->> 'type') end;
  v_own   text;
  v_point text;
  v_ok    boolean;
  k       text;
  x       jsonb;
  y       jsonb;
  a       text;
  b       text;
begin
  if jsonb_typeof(p_old -> 'steps') is distinct from 'object' or jsonb_typeof(p_new -> 'steps') is distinct from 'object' then
    return 'stores a state whose steps are malformed';
  end if;
  if v_need is not null then
    if jsonb_typeof(p_command -> 'step') is distinct from 'string' then
      return 'names no step to act on';
    end if;
    v_own := (p_command ->> 'step') || '@' || recipe.ctx_key(coalesce(p_command -> 'context', '[]'::jsonb));
    a := p_old -> 'steps' -> v_own ->> 'status';
    if a is distinct from v_need then
      return format('acts on step %s, which is %s before it; the engine takes a %s only on a step that is %s',
                    v_own, coalesce(lower(replace(a, '_', ' ')), 'not in the state'), v_type, lower(replace(v_need, '_', ' ')));
    end if;
  end if;
  if v_done and v_type = 'INVALIDATE_RESULT' and jsonb_typeof(p_command -> 'point') = 'string' then
    v_point := p_old -> 'points' -> (p_command ->> 'point') ->> 'stepKey';
  end if;
  for k, x in select e.key, e.value from jsonb_each(p_old -> 'steps') e order by e.key loop
    y := p_new -> 'steps' -> k;
    a := x ->> 'status';
    b := y ->> 'status';
    if jsonb_typeof(y) is distinct from 'object' then
      return format('removes step instance %s', k);
    end if;
    continue when a is not distinct from b;
    v_ok := case
      when a = 'ENABLED' and b = 'IN_PROGRESS' then k = v_own and v_type = 'START_STEP'
      when a = 'ENABLED' and b = 'SKIPPED' then k = v_own and v_type = 'REQUEST_SKIP'
      when a = 'ENABLED' and b = 'COMPLETED' then k = v_own and v_type = 'DISPOSITION_HOLD_POINT'
      when a = 'IN_PROGRESS' and b in ('AWAITING_VERIFICATION', 'COMPLETED') then k = v_own and v_type = 'SIGN_PERFORMED'
      when a = 'AWAITING_VERIFICATION' and b = 'COMPLETED' then k = v_own and v_type = 'VERIFY'
      when a = 'COMPLETED' and b = 'AWAITING_VERIFICATION' then v_done and v_type in ('CORRECT_ENTRY', 'INVALIDATE_RESULT')
      when a in ('COMPLETED', 'AWAITING_VERIFICATION') and b = 'IN_PROGRESS' then k = v_point
      else false
    end;
    if not coalesce(v_ok, false) then
      return format('moves step instance %s from %s to %s; the engine moves a step only along its life cycle, by the act that moves it',
                    k, coalesce(lower(replace(a, '_', ' ')), 'no status'), coalesce(lower(replace(b, '_', ' ')), 'no status'));
    end if;
  end loop;
  return null;
end
$$;

-- DI-34, PR-13 (F66, round 2): the step instances a row stores are in a status its act can leave them in (header).
-- Runs after the projection is written (recipe.write_row writes the row first); the row that produced the state is the
-- one it names (last_seq). EBMR-EXE-132. Raises; returns nothing.
create function recipe.execution_step_status_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_problem text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_problem := recipe.step_status_problem(old.state, new.state, r.kind, r.accepted, r.command);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s (DI-34, PR-13). [EBMR-EXE-132]',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create trigger zf_execution_step_status after update on recipe.execution_state
  for each row execute function recipe.execution_step_status_check();

revoke all on function recipe.act_status_before(text), recipe.step_status_problem(jsonb, jsonb, text, boolean, jsonb),
                       recipe.execution_step_status_check() from public;

reset role;
