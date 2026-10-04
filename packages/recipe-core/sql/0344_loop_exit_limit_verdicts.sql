-- Recipe core, execution store (module C3): the row that decides a loop's exit is judged against the endpoint's limits,
-- whatever else it changes (PR-08, PR-49, INV-19, DI-26; ADR 0012: the rules hold when the application's own database
-- credentials are used directly). Found by the SQL mutation run (batch 2, group exceptions-and-dispositions: the mutant
-- recipe.check_exception_changes#88 judged more rows than the guard and was the stricter of the two).
--
-- What was wrong. recipe.limit_verdicts (0305) judges, besides each value a row stores or re-evaluates, every loop exit
-- the row decides: an exit (EXIT or EXHAUSTED) whose iteration holds an endpoint value still waiting for its verdict is
-- a problem, because the engine gives that value its verdict at the exit (engine data.ts raiseForEvaluationAtExit,
-- ADR 0004). But recipe.check_exception_changes ran recipe.limit_exceptions_problem only when the row changed a data
-- point or a computed value, or added a limit exception. The row that decides an exit and leaves its endpoint as it was
-- changes none of those, so it was never judged. Through the application role, a COMPLETE_LOOP_ITERATION of a drying
-- loop whose endpoint (LOD 1.5 %) was outside its internal action limit (0.0-1.0 %) was stored 'ok' with the engine's
-- state except that the endpoint stayed ENDPOINT_IN_PROGRESS and the LIMIT_BREACH the verdict raises (ACTION, deviation
-- required, blocking the steps after it) was left out with its event; the invariant query reported nothing. The test
-- packages/recipe-core/test/execution/sql-guards.test.ts ("an exit that leaves it waiting, is refused") called the
-- helper directly, not the guard.
--
-- What changed: recipe.check_exception_changes (CREATE OR REPLACE, the body of 0305 otherwise unchanged) also judges a
-- row that changes the state's decisions. limit_verdicts reads only the loop exits among them, and an honest exit
-- gives its endpoint the verdict in the same row, so the engine's own rows are judged as before (the golden runs of
-- sql-guards.test.ts judge every row of both fixtures with limit_exceptions_problem and find nothing).
--
-- CREATE OR REPLACE keeps the owner (ebmr_owner), SECURITY DEFINER, STABLE, the search_path and the privileges of 0270
-- (none for PUBLIC). Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-26, INV-41, PR-49, PR-13, PR-08: as 0305; the limit verdicts are also judged on a row that changes a decision.
create or replace function recipe.check_exception_changes(p_prior jsonb, p_state jsonb, p_kind text, p_cmd jsonb, p_accepted boolean) returns void
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0        jsonb := coalesce(p_prior -> 'exceptions', '{}'::jsonb);
  e1        jsonb := p_state -> 'exceptions';
  v_act     text := case when p_kind = 'COMMAND' and p_accepted is true then p_cmd ->> 'type' end;
  v_ex      text := p_cmd ->> 'exception';
  v_ref     text := recipe.js_trim(p_cmd ->> 'deviationRef');
  v_raise   boolean;
  v_n       integer := 0;
  v_want    jsonb;
  v_cont    jsonb;
  v_loaded  boolean := false;
  v_problem text;
  k         text;
  x0        jsonb;
  x1        jsonb;
begin
  if jsonb_typeof(e0) is distinct from 'object' or jsonb_typeof(e1) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'The exceptions of the engine state are malformed (DI-34). [EBMR-EXE-030]';
  end if;
  for k, x0 in select key, value from jsonb_each(e0) loop
    x1 := e1 -> k;
    if jsonb_typeof(x1) is distinct from 'object' then
      raise exception using errcode = 'P0001',
        message = format('The state no longer holds exception %s; an exception is never removed (DI-26, INV-41). [EBMR-EXE-044]', k);
    end if;
    if (x1 - 'status' - 'disposition' - 'deviation') is distinct from (x0 - 'status' - 'disposition' - 'deviation') then
      raise exception using errcode = 'P0001',
        message = format('The state changes exception %s as it was raised; an exception is kept as raised (DI-26, INV-41). [EBMR-EXE-044]', k);
    end if;
    if coalesce(x1 -> 'deviation', 'null'::jsonb) is distinct from coalesce(x0 -> 'deviation', 'null'::jsonb)
       and not coalesce(v_act = 'ATTACH_DEVIATION' and v_ex = k and coalesce(x0 -> 'deviation', 'null'::jsonb) = 'null'::jsonb
                         and x0 ->> 'status' = 'OPEN' and coalesce(v_ref, '') <> ''
                         and x1 -> 'deviation' ->> 'ref' = v_ref and x1 -> 'deviation' ->> 'linkedBy' = p_cmd -> 'actor' ->> 'id', false) then
      raise exception using errcode = 'P0001',
        message = format('The state changes the deviation link of exception %s, which this row does not link (PR-49, DI-26). [EBMR-EXE-044]', k);
    end if;
    if ((x1 -> 'status') is distinct from (x0 -> 'status') or (x1 -> 'disposition') is distinct from (x0 -> 'disposition'))
       and not coalesce(v_act = 'DISPOSITION_EXCEPTION' and v_ex = k, false) then
      raise exception using errcode = 'P0001',
        message = format('The state changes the status or disposition of exception %s without its own signed disposition (PR-49, DI-37, INV-41). [EBMR-EXE-044]', k);
    end if;
  end loop;
  for k, x1 in select key, value from jsonb_each(e1) where not (e0 ? key) loop
    if jsonb_typeof(x1) is distinct from 'object' or x1 ->> 'status' is distinct from 'OPEN' or x1 ? 'disposition' or x1 ? 'deviation' then
      raise exception using errcode = 'P0001',
        message = format('Exception %s is raised by this row already dispositioned or linked; a new exception is open (DI-26, PR-49). [EBMR-EXE-044]', k);
    end if;
  end loop;
  -- The operator's exception is the one the command raised (PR-49, PR-13).
  v_raise := coalesce(v_act = 'RAISE_EXCEPTION', false);
  for k, x1 in select key, value from jsonb_each(e1) where not (e0 ? key) and value ->> 'type' = 'OPERATOR_RAISED' order by key loop
    v_n := v_n + 1;
    if not v_raise or v_n > 1 then
      raise exception using errcode = 'P0001',
        message = format('Exception %s is an operator''s exception, which only an accepted RAISE_EXCEPTION raises, one per command; this %s row does not (PR-13, PR-49, DI-26). [EBMR-EXE-044]',
                         k, coalesce(p_kind, 'null'));
    end if;
    if (p_cmd -> 'severity') = '"ACTION"'::jsonb and p_cmd ? 'step' then
      select pk.content into v_cont from recipe.test_package pk where pk.content_hash = p_state ->> 'mbrHash' limit 1;
      v_loaded := true;
    end if;
    v_want := recipe.operator_exception_record(v_cont, p_cmd, k);
    if v_want is null or (x1 - 'raisedAt' - 'raisedSeq') is distinct from v_want then
      raise exception using errcode = 'P0001',
        message = format('Exception %s is not the exception its command raised: its type, severity, need of a deviation, block, QA-only and release-blocking flags, title, source and raiser come from the command (PR-49, PR-13, DI-26). [EBMR-EXE-044]', k);
    end if;
  end loop;
  if v_raise and v_n = 0 then
    raise exception using errcode = 'P0001',
      message = 'The accepted RAISE_EXCEPTION of this row is not recorded in the state as the operator''s exception it raises (PR-13, PR-49, DI-26). [EBMR-EXE-044]';
  end if;
  -- The limit exceptions are those the verdicts on the values the row judges raise (PR-08, PR-49): judged whenever the
  -- row changes a data point, a computed value or a decision (a loop's exit judges its endpoint, 0344), or adds a limit
  -- exception.
  if (p_state -> 'points') is distinct from (p_prior -> 'points') or (p_state -> 'derived') is distinct from (p_prior -> 'derived')
     or (p_state -> 'decisions') is distinct from (p_prior -> 'decisions')
     or exists (select 1 from jsonb_each(e1) e where not (e0 ? e.key) and e.value ->> 'type' in ('LIMIT_BREACH', 'YIELD_OUT_OF_LIMITS')) then
    if not v_loaded then
      select pk.content into v_cont from recipe.test_package pk where pk.content_hash = p_state ->> 'mbrHash' limit 1;
    end if;
    v_problem := recipe.limit_exceptions_problem(v_cont, p_prior, p_state, p_cmd -> 'actor' ->> 'id');
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('The limit verdicts of this %s row are not recorded as the engine gives them: %s. A value outside a limit tier raises the exception its tier requires, with the type, tier, severity, need of a deviation, block, QA-only, registration, stage and release flags, title, source and raiser that the value and the MBR''s limits give it (PR-08, PR-49, DI-26). [EBMR-EXE-044]',
                         coalesce(p_kind, 'null'), v_problem);
    end if;
  end if;
end
$$;

reset role;
