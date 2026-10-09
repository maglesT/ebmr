-- Recipe core, execution store (module C3): a row makes a recorded signature invalid only where the engine does (Phase 2
-- exit, SQL mutation kill work, defect D9; decision D9.1; DI-35, INV-10, PR-14, INV-03; ADR 0012: the rules hold when
-- the application's own database credentials are used directly).
--
-- Correction of 0300's header, stated here because applied migrations are never edited. 0300 says a row changes another
-- step than its own only as the system does, naming "the invalidation of a PERFORMED signature whose data changed", and
-- that on its own step a recorded signature is "only made invalid". Its check (recipe.signature_change_problem with no
-- e-signature of the row) accepted any recorded signature going from valid to not valid, in any row: PERFORMED or
-- CHECKED, whatever the step's status, with no data of the step changed, and it left the signer among the step's
-- PERFORMED signers. Through the application role an accepted RAISE_EXCEPTION whose state made operator1's PERFORMED
-- signature of a step waiting for its check invalid, with nothing else changed, was stored 'ok' (the kill agent of the
-- execution-state-binding group; reproduced by apps/tablets-server/test/mutation/execution-state-binding.test.ts "D9:
-- ..."). A step whose signatures are invalid looks unsigned to the engine and to the reviewer, so a writer could send a
-- signed step back for signing again, or make a check look missing, without any act of the run.
--
-- The engine makes a recorded signature of a step invalid in three places only (recipe-core engine):
--   * engine.ts resignAfterChange, after every command, refused or accepted, and every preparation: a PERFORMED signature
--     recorded valid before the row, of a step the row leaves IN_PROGRESS, whose signing content the row changed
--     (signing-content.ts stepSigningContent: the step's data points, computed values, entries and the exceptions raised
--     at it that are data of the step, not acts); the signer is then no longer a PERFORMED signer of the step;
--   * corrections.ts sendBackForReverification, in a correction (CORRECT_ENTRY) or a result invalidation
--     (INVALIDATE_RESULT): the PERFORMED and CHECKED signatures of a step that was COMPLETED or AWAITING_VERIFICATION
--     and is sent back for re-verification (left AWAITING_VERIFICATION, marked for re-verification); its PERFORMED
--     signers are kept;
--   * corrections.ts invalidateResult, in a result invalidation: the PERFORMED and CHECKED signatures of the step of the
--     invalidated value, COMPLETED or AWAITING_VERIFICATION before, reopened for a re-test (left IN_PROGRESS), whose
--     PERFORMED signers are then none. (A test run takes no INVALIDATE_RESULT in this release, EBMR-EXE-003; the rule is
--     ready for it.)
--
-- What changed (decision D9.1, EBMR-EXE-128):
--   * recipe.step_facts_changed(state before, state after, step key): whether the row changes a data point, computed
--     value or entry of that step instance, or an exception raised at it that is no act (engine signing-content.ts
--     ACT_EXCEPTION_TYPES: WITNESS_LATE, OPERATOR_RAISED, HOLD_POINT_NOT_APPROVED, STEP_SKIPPED, EXECUTED_TARGET_CHANGED),
--     read as raised (its status, disposition and deviation link left out). It is wider than the engine's content
--     change (it compares whole records, and without the engine it cannot leave out what the engine leaves out of a
--     step's content: a computed value withdrawn later, the verdict on a loop endpoint judged at the loop's exit), so it
--     never refuses an invalidation the engine makes;
--   * recipe.signature_invalidation_problem(step key, step before, step after, state before, state after, the type of
--     an accepted command): why the row makes a recorded signature of that step invalid (valid true before, false after)
--     otherwise than one of the three engine paths above, or keeps the signer of a PERFORMED signature it made invalid
--     on a step left IN_PROGRESS among the PERFORMED signers (unless the row adds a new PERFORMED signature of that
--     person), or drops a PERFORMED signer whose PERFORMED signature it does not make invalid (a result invalidation
--     that reopens a step COMPLETED or AWAITING_VERIFICATION before drops them all); NULL when it does none of these.
--     The sending back and the reopening count only for a step that was COMPLETED or AWAITING_VERIFICATION before the
--     row, as in the engine (0311 already lets no other status move there, but an IN_PROGRESS step left IN_PROGRESS by
--     an INVALIDATE_RESULT is under the first path only);
--   * recipe.execution_signature_invalidation_check, run by the row trigger zzm_execution_signature_invalidation (after
--     update of recipe.execution_state, every row whatever its kind or source, after every earlier check of the state;
--     it reads the row the state names) on every step instance of the state before the row, the row's own step too.
--   Every other change of a recorded signature stays refused by 0300 and 0381 (zb_execution_state_binding).
-- What the database still does not decide: whether the step's signing content really changed (the replay of the
-- release gate, ADR 0010, compares every row with the engine and every stored content version with the replayed
-- state, 0338).
--
-- New functions are owned by ebmr_owner and private to the owner (no EXECUTE for PUBLIC); the trigger function is
-- SECURITY DEFINER; every function pins its search_path with pg_temp last. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-35, INV-10 (D9): whether state p_new changes, against state p_old, a data point, computed value or entry of step
-- instance p_key, or an exception raised at it that is data of the step (not an act of a person or of the run), as
-- raised (header).
create function recipe.step_facts_changed(p_old jsonb, p_new jsonb, p_key text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select exists (select 1
                   from unnest(array['points', 'derived', 'entries']) m (member)
                  cross join lateral (select e.key from jsonb_each(case when jsonb_typeof(p_old -> m.member) = 'object' then p_old -> m.member else '{}'::jsonb end) e
                                      union
                                      select e.key from jsonb_each(case when jsonb_typeof(p_new -> m.member) = 'object' then p_new -> m.member else '{}'::jsonb end) e) r
                  where p_key in (p_old -> m.member -> r.key ->> 'stepKey', p_new -> m.member -> r.key ->> 'stepKey')
                    and (p_new -> m.member -> r.key) is distinct from (p_old -> m.member -> r.key))
      or exists (select 1
                   from (select e.key from jsonb_each(case when jsonb_typeof(p_old -> 'exceptions') = 'object' then p_old -> 'exceptions' else '{}'::jsonb end) e
                         union
                         select e.key from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) e) r
                  where p_key in (p_old -> 'exceptions' -> r.key -> 'source' ->> 'stepKey', p_new -> 'exceptions' -> r.key -> 'source' ->> 'stepKey')
                    and coalesce(p_new -> 'exceptions' -> r.key ->> 'type', p_old -> 'exceptions' -> r.key ->> 'type')
                        not in ('WITNESS_LATE', 'OPERATOR_RAISED', 'HOLD_POINT_NOT_APPROVED', 'STEP_SKIPPED', 'EXECUTED_TARGET_CHANGED')
                    and ((p_new -> 'exceptions' -> r.key) - array['status', 'disposition', 'deviation'])
                        is distinct from ((p_old -> 'exceptions' -> r.key) - array['status', 'disposition', 'deviation']))
$$;

-- DI-35, INV-10, PR-14 (D9): why step instance p_key, p_old before a row and p_new after it (states p_s0 and p_s1), has a
-- recorded signature made invalid, or its PERFORMED signers changed, otherwise than the engine does (header); NULL when
-- it has not. p_type: the type of the row's command when the row is an accepted COMMAND, otherwise NULL.
create function recipe.signature_invalidation_problem(p_key text, p_old jsonb, p_new jsonb, p_s0 jsonb, p_s1 jsonb, p_type text) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_old     jsonb := case when jsonb_typeof(p_old -> 'signatures') = 'array' then p_old -> 'signatures' else '[]'::jsonb end;
  v_new     jsonb := case when jsonb_typeof(p_new -> 'signatures') = 'array' then p_new -> 'signatures' else '[]'::jsonb end;
  v_was     jsonb := case when jsonb_typeof(p_old -> 'performedSigners') = 'array' then p_old -> 'performedSigners' else '[]'::jsonb end;
  v_now     jsonb := case when jsonb_typeof(p_new -> 'performedSigners') = 'array' then p_new -> 'performedSigners' else '[]'::jsonb end;
  v_status  text := p_new ->> 'status';
  v_correct boolean := coalesce(p_type in ('CORRECT_ENTRY', 'INVALIDATE_RESULT'), false);
  -- The engine sends back, or reopens, only a step that was COMPLETED or AWAITING_VERIFICATION (corrections.ts).
  v_back    boolean := coalesce(p_old ->> 'status' in ('COMPLETED', 'AWAITING_VERIFICATION'), false);
  v_changed boolean;
  v_stale   jsonb := '[]'::jsonb;
  o         jsonb;
  x         jsonb;
  s         jsonb;
begin
  for i in 0 .. jsonb_array_length(v_old) - 1 loop
    o := v_old -> i;
    x := v_new -> i;
    if not coalesce((o -> 'valid') = 'true'::jsonb and (x -> 'valid') = 'false'::jsonb, false) then
      continue; -- kept, or changed otherwise: 0300 and 0381 judge that
    end if;
    v_changed := coalesce(v_changed, recipe.step_facts_changed(p_s0, p_s1, p_key));
    if not coalesce(   (o ->> 'role' = 'PERFORMED' and v_status = 'IN_PROGRESS' and v_changed)
                    or (v_correct and v_back and o ->> 'role' in ('PERFORMED', 'CHECKED') and v_status = 'AWAITING_VERIFICATION' and (p_new -> 'reverification') = 'true'::jsonb)
                    or (p_type = 'INVALIDATE_RESULT' and v_back and o ->> 'role' in ('PERFORMED', 'CHECKED') and v_status = 'IN_PROGRESS' and v_changed), false) then
      return format('its %s signature %s is made invalid with the step left %s%s', coalesce(o ->> 'role', '(no role)'), coalesce(o ->> 'id', '(no id)'),
                    coalesce(v_status, 'without a status'), case when v_changed then '' else ' and none of its data changed' end);
    end if;
    if coalesce(o ->> 'role' = 'PERFORMED' and v_status = 'IN_PROGRESS', false) then
      v_stale := v_stale || jsonb_build_array(o -> 'signer');
    end if;
  end loop;
  -- The signer of a PERFORMED signature made invalid on a step left in progress signs again: no longer a PERFORMED
  -- signer, unless the row records a new PERFORMED signature of that person.
  for s in select e from jsonb_array_elements(v_stale) e loop
    if v_now @> jsonb_build_array(s)
       and not exists (select 1 from jsonb_array_elements(v_new) with ordinality n (g, j)
                        where n.j > jsonb_array_length(v_old) and n.g ->> 'role' = 'PERFORMED' and n.g -> 'signer' = s and (n.g -> 'valid') = 'true'::jsonb) then
      return format('the PERFORMED signature of %s is made invalid, and %s stays a PERFORMED signer of it', s #>> '{}', s #>> '{}');
    end if;
  end loop;
  -- A PERFORMED signer leaves only with the PERFORMED signature the row makes invalid (or all of them, when a result
  -- invalidation reopens the step).
  if not coalesce(p_type = 'INVALIDATE_RESULT' and v_back and v_status = 'IN_PROGRESS' and v_now = '[]'::jsonb, false) then
    for s in select e from jsonb_array_elements(v_was) e loop
      if not (v_now @> jsonb_build_array(s)) and not (v_stale @> jsonb_build_array(s)) then
        return format('%s is no longer a PERFORMED signer of it, and no PERFORMED signature of %s is made invalid', s #>> '{}', s #>> '{}');
      end if;
    end loop;
  end if;
  return null;
end
$$;

-- DI-35, INV-10, PR-14, INV-03 (D9): every recorded signature a row makes invalid, on any step instance, is one the
-- engine makes invalid (header). EBMR-EXE-128. Raises; returns nothing.
create function recipe.execution_signature_invalidation_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_type    text;
  v_problem text;
  k         text;
  x         jsonb;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_type := case when r.kind = 'COMMAND' and r.accepted then r.command_type end;
  for k, x in select e.key, e.value from jsonb_each(case when jsonb_typeof(old.state -> 'steps') = 'object' then old.state -> 'steps' else '{}'::jsonb end) e
               order by e.key loop
    v_problem := recipe.signature_invalidation_problem(k, x, new.state -> 'steps' -> k, old.state, new.state, v_type);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('This %s %s row changes the signatures of step %s otherwise than the engine does: %s. The engine makes a recorded signature invalid only when the data it covers changes on a step left in progress (a PERFORMED signature, whose signer signs again) and, in a correction or a result invalidation, on a step it sends back for re-verification or reopens (DI-35, INV-10, PR-14). [EBMR-EXE-128]',
                         case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                         coalesce(r.command_type, r.kind, 'unknown'), k, v_problem);
    end if;
  end loop;
  return null;
end
$$;

create trigger zzm_execution_signature_invalidation after update on recipe.execution_state
  for each row execute function recipe.execution_signature_invalidation_check();

revoke all on function recipe.step_facts_changed(jsonb, jsonb, text), recipe.signature_invalidation_problem(text, jsonb, jsonb, jsonb, jsonb, text),
                       recipe.execution_signature_invalidation_check() from public;

reset role;
