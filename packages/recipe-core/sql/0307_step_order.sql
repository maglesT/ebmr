-- Recipe core, execution store (module C3): a step instance comes into the state only where the token can have
-- reached it, in the database as in the engine (Phase 2 exit review F66; DI-34, PR-13, INV-18; ADR 0012: the rules
-- hold when the application's own database credentials are used directly).
--
-- The engine enforces the order of the steps with its token game (engine advance.ts): a step instance exists only once
-- the token reaches it, and START_STEP needs that instance (guards.ts requireInstance, ENG-NOT-ENABLED). The database
-- accepted a new step instance in any row as long as it looked like one the token advance creates: ENABLED or
-- NOT_APPLICABLE with nobody in it (0300 recipe.new_instance_problem, EBMR-EXE-128) and told by its STEP_STATUS_CHANGED
-- event from PENDING by SYSTEM (0299, EBMR-EXE-048). Whether the token could be there was never asked. A writer
-- holding the application role stored, beside an ordinary entry on the line clearance, the dispensing step ENABLED; the
-- unmodified server then let the dispensing start while the clearance was in progress, and recipe.execution_violations()
-- reported nothing. Only the replay verification, run on demand, disagreed.
--
-- The database now derives, from the batch's own MBR content, conditions every step instance the engine creates
-- fulfils (they follow from the token game; the database still does not re-run it):
--
--   1. recipe.flow_tree(content): the procedure as the engine expands it (library calls inlined under the call's id,
--      as recipe.flow_numbering of 0304): for every node its kind and its path from the root, each ancestor with the
--      slot leading down (a sequence: the child's position; a parallel section or an alternative: the branch), and for
--      a sequence the ids of its children. A procedure that cannot be read this way (a node without an id or of no
--      known kind, an id twice, a library call naming no embedded element or itself) gives {bad}.
--
--   2. An ENABLED step instance a row adds (recipe.step_order_problem) is one the token can have reached:
--        - its frames are one per enclosing loop and replicate section, outermost first, each a whole number from 1;
--        - every node before it in a sequence it lies in (at every level) has been left by the token
--          (recipe.flow_left_problem): each phase and hold point in it has been completed or skipped at least once
--          (status COMPLETED or SKIPPED, or the mark of its first completion, firstCompletedSeq, kept when a later
--          correction sends it back for re-verification), in the frames of the instance; inside an alternative also
--          not applicable; a stage in it has been signed off; a loop in it has ended (a decision EXIT or EXHAUSTED);
--          an alternative and a replicate section in it are decided. What lies inside a loop or a replicate section
--          of that node is not looked at (its iterations and sub-lots are not named by the instance's frames);
--        - every alternative it lies in decided on its branch; in iteration k > 1 of a loop, iteration k - 1 decided
--          to continue; in sub-lot k of a replicate section, its count is at least k.
--      A NOT_APPLICABLE step instance a row adds lies in an alternative, at that alternative's frames, which decided on
--      another branch (engine advance.ts markNotApplicable).
--
--   3. The marks the condition reads are bound (recipe.completion_mark_problem):
--        - firstCompletedSeq is set only when the instance is COMPLETED, SKIPPED or NOT_APPLICABLE, and never changed or
--          removed once set (engine steps.ts setStatus);
--        - a hold point becomes COMPLETED only with a releasing decision recorded (engine steps.ts dispositionHoldPoint;
--          a decision not releasing it never moves the token on);
--        - a stage frame's sign-off appears or is replaced only in an accepted SIGN_OFF_STAGE of that stage frame,
--          and is otherwise kept, apart from being made invalid (valid true -> false) when a correction re-opens a
--          step of the stage (engine corrections.ts invalidateStageSignOff).
--
--   These are checked by a row trigger on recipe.execution_state (zd_execution_step_order, after insert or update),
--   for every row (the issue, a person's row, a preparation, a sweep), refused with EBMR-EXE-129 (DI-34, PR-13).
--
--   4. recipe.execution_violations() also reports (in recipe.execution_rule_violations, which this migration replaces
--      whole, carrying the arm of 0306) a step instance of the stored state that a predecessor phase or hold point
--      finished after it was enabled (firstCompletedSeq later than its enabledSeq), or never, or one that the
--      conditions of item 2 do not hold for, as the engine's own DI-34 invariant (engine invariants.ts checkSequence).
--
-- What stays with the replay verification (ADR 0010), stated so the checks are not over-read: the decisions themselves
-- (which branch recorded data choose, a loop's exit, a count) are taken as recorded; inside a loop or replicate section
-- only the iteration or sub-lot the instance names is looked at; a sequential replicate's sub-lot k is not held to the
-- end of sub-lot k - 1.
--
-- New functions are owned by ebmr_owner and private to the owner (no EXECUTE for PUBLIC); the trigger function is
-- SECURITY DEFINER; every function pins its search_path with pg_temp last. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. The procedure as a tree of expanded ids
-- ---------------------------------------------------------------------------------------------

-- One node p_node of the procedure, under the id prefix p_prefix of the library calls it lies in (p_calls: the
-- elements being expanded), with its path p_path from the root ([[id, kind, slot], ...]). p_acc carries {ids: {<expanded
-- id>: {kind, path, n, children?}}, n: the next place in document order}, and 'bad' once the procedure cannot be read.
create function recipe.flow_tree_visit(p_content jsonb, p_node jsonb, p_prefix text, p_calls text[], p_path jsonb, p_acc jsonb)
returns jsonb
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_acc  jsonb := p_acc;
  v_kind text := p_node ->> 'kind';
  v_id   text;
  v_body jsonb;
  v_els  bigint;
  v_kids jsonb := '[]'::jsonb;
  c      record;
begin
  if v_acc ? 'bad' then
    return v_acc;
  end if;
  if jsonb_typeof(p_node) is distinct from 'object' or jsonb_typeof(p_node -> 'id') is distinct from 'string' then
    return v_acc || jsonb_build_object('bad', 'a node of the procedure has no id');
  end if;
  v_id := p_prefix || (p_node ->> 'id');
  if (v_acc -> 'ids') ? v_id then
    return v_acc || jsonb_build_object('bad', format('node id %s occurs twice', v_id));
  end if;
  if v_kind is null or v_kind not in ('stage', 'operation', 'phase', 'holdPoint', 'sequence', 'parallel', 'alternative', 'loop', 'replicate', 'libraryCall') then
    return v_acc || jsonb_build_object('bad', format('node %s is of no kind a procedure has (%s)', v_id, coalesce(v_kind, 'none')));
  end if;
  v_acc := jsonb_set(jsonb_set(v_acc, array['ids', v_id], jsonb_build_object('kind', v_kind, 'path', p_path, 'n', coalesce((v_acc ->> 'n')::integer, 0))),
                     '{n}', to_jsonb(coalesce((v_acc ->> 'n')::integer, 0) + 1));
  if v_kind in ('stage', 'operation', 'loop', 'replicate') then
    return recipe.flow_tree_visit(p_content, p_node -> 'body', p_prefix, p_calls, p_path || jsonb_build_array(jsonb_build_array(v_id, v_kind, 0)), v_acc);
  end if;
  if v_kind = 'libraryCall' then
    if jsonb_typeof(p_node -> 'element') is distinct from 'string' or (p_node ->> 'element') = any (p_calls) then
      return v_acc || jsonb_build_object('bad', format('library call %s names no element or its own element', v_id));
    end if;
    select count(*), (array_agg(e -> 'body'))[1] into v_els, v_body
      from jsonb_array_elements(case when jsonb_typeof(p_content -> 'library') = 'array' then p_content -> 'library' else '[]'::jsonb end) e
     where e ->> 'ref' = p_node ->> 'element';
    if v_els is distinct from 1 then
      return v_acc || jsonb_build_object('bad', format('library call %s names %s, which the MBR does not embed once', v_id, p_node ->> 'element'));
    end if;
    return recipe.flow_tree_visit(p_content, v_body, v_id || '/', p_calls || (p_node ->> 'element'),
                                  p_path || jsonb_build_array(jsonb_build_array(v_id, v_kind, 0)), v_acc);
  end if;
  if v_kind = 'sequence' then
    if jsonb_typeof(p_node -> 'children') is distinct from 'array' then
      return v_acc || jsonb_build_object('bad', format('sequence %s has no children', v_id));
    end if;
    for c in select a.v, a.i from jsonb_array_elements(p_node -> 'children') with ordinality a (v, i) order by a.i loop
      v_acc := recipe.flow_tree_visit(p_content, c.v, p_prefix, p_calls, p_path || jsonb_build_array(jsonb_build_array(v_id, v_kind, c.i - 1)), v_acc);
      if v_acc ? 'bad' then
        return v_acc;
      end if;
      v_kids := v_kids || to_jsonb(p_prefix || (c.v ->> 'id'));
    end loop;
    return jsonb_set(v_acc, array['ids', v_id, 'children'], v_kids);
  end if;
  if v_kind in ('parallel', 'alternative') then
    if jsonb_typeof(p_node -> 'branches') is distinct from 'array' then
      return v_acc || jsonb_build_object('bad', format('%s %s has no branches', v_kind, v_id));
    end if;
    for c in select a.v from jsonb_array_elements(p_node -> 'branches') with ordinality a (v, i) order by a.i loop
      if jsonb_typeof(c.v -> 'id') is distinct from 'string' then
        return v_acc || jsonb_build_object('bad', format('a branch of %s has no id', v_id));
      end if;
      -- An alternative's branch may be empty (the "no action" option); a parallel branch has a body.
      if jsonb_typeof(c.v -> 'body') = 'object' or v_kind = 'parallel' then
        v_acc := recipe.flow_tree_visit(p_content, c.v -> 'body', p_prefix, p_calls, p_path || jsonb_build_array(jsonb_build_array(v_id, v_kind, c.v ->> 'id')), v_acc);
      end if;
    end loop;
  end if;
  return v_acc;
end
$$;

-- The procedure of MBR content p_content as a tree of expanded ids: {ids: {<id>: {kind, path, n, children?}}} (n: the
-- node's place in document order, from 0), or {bad}.
create function recipe.flow_tree(p_content jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select case when jsonb_typeof(p_content -> 'procedure' -> 'body') = 'object'
              then recipe.flow_tree_visit(p_content, p_content -> 'procedure' -> 'body', '', '{}'::text[], '[]'::jsonb, '{"ids": {}, "n": 0}'::jsonb) - 'n'
              else '{"bad": "the content has no procedure"}'::jsonb end
$$;

-- The loops and replicate sections enclosing node p_id of tree p_tree, outermost first (engine StepDef.constructs: the
-- constructs of every instance's frames); NULL when the tree has no such node.
create function recipe.flow_within(p_tree jsonb, p_id text) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p_tree -> 'ids' -> p_id) = 'object'
              then coalesce((select jsonb_agg(e.v -> 0 order by e.i)
                               from jsonb_array_elements(p_tree -> 'ids' -> p_id -> 'path') with ordinality e (v, i)
                              where e.v ->> 1 in ('loop', 'replicate')), '[]'::jsonb) end
$$;

-- Whether frames p_frames are one per construct of p_within, in that order, each index a whole number from 1.
create function recipe.frames_fit(p_within jsonb, p_frames jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_typeof(p_within) = 'array' and jsonb_typeof(p_frames) = 'array'
                  and jsonb_array_length(p_frames) = jsonb_array_length(p_within)
                  and not exists (select 1
                                    from jsonb_array_elements(p_frames) with ordinality f (v, i)
                                   where jsonb_typeof(f.v) is distinct from 'object'
                                      or f.v ->> 'construct' is distinct from p_within ->> (f.i::integer - 1)
                                      or jsonb_typeof(f.v -> 'index') is distinct from 'number'
                                      or (f.v ->> 'index') !~ '^[1-9][0-9]{0,8}$'), false)
$$;

-- Whether step instance p_inst has been finished at least once: COMPLETED or SKIPPED (NOT_APPLICABLE too when p_na),
-- or marked with its first completion (firstCompletedSeq, kept when a correction sends it back) and not NOT_APPLICABLE.
-- With p_before, only a first completion at or before that sequence number counts.
create function recipe.step_once_finished(p_inst jsonb, p_na boolean, p_before numeric) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(case
    when jsonb_typeof(p_inst) is distinct from 'object' then false
    when p_before is not null
      then jsonb_typeof(p_inst -> 'firstCompletedSeq') = 'number' and (p_inst ->> 'firstCompletedSeq')::numeric <= p_before
           and (p_na or p_inst ->> 'status' is distinct from 'NOT_APPLICABLE')
    else p_inst ->> 'status' in ('COMPLETED', 'SKIPPED')
         or (p_na and p_inst ->> 'status' = 'NOT_APPLICABLE')
         or (jsonb_typeof(p_inst -> 'firstCompletedSeq') = 'number' and p_inst ->> 'status' is distinct from 'NOT_APPLICABLE')
  end, false)
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Where the token can be
-- ---------------------------------------------------------------------------------------------

-- Why the token has not left node p_root (frames p_frames: those of its enclosing loops and replicate sections) in
-- state p_state; NULL when it has (header item 2). With p_before (the invariant query), a phase or hold point counts
-- only when first finished at or before that sequence number, and the decisions and sign-offs are not looked at.
create function recipe.flow_left_problem(p_tree jsonb, p_state jsonb, p_root text, p_frames jsonb, p_before numeric) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx   text := recipe.ctx_key(p_frames);
  v_dec   jsonb := case when jsonb_typeof(p_state -> 'decisions') = 'object' then p_state -> 'decisions' else '{}'::jsonb end;
  m       record;
  v_inner text[];
  v_alt   boolean;
  v_key   text;
  v_inst  jsonb;
begin
  for m in select e.key, e.value
             from jsonb_each(p_tree -> 'ids') e
            where e.key = p_root or exists (select 1 from jsonb_array_elements(e.value -> 'path') p where p ->> 0 = p_root)
            order by (e.value ->> 'n')::integer
  loop
    -- The kinds of the constructs from the root (included) down to the member (excluded).
    v_inner := case when m.key = p_root then '{}'::text[]
                    else (select coalesce(array_agg(p.v ->> 1 order by p.i), '{}'::text[])
                            from jsonb_array_elements(m.value -> 'path') with ordinality p (v, i)
                           where p.i >= (select min(q.i) from jsonb_array_elements(m.value -> 'path') with ordinality q (v, i) where q.v ->> 0 = p_root)) end;
    -- Inside a loop or a replicate section of the root the instance's frames name no iteration or sub-lot.
    continue when v_inner && array['loop', 'replicate'];
    v_alt := v_inner && array['alternative'];
    v_key := m.key || '@' || v_ctx;
    if m.value ->> 'kind' in ('phase', 'holdPoint') then
      v_inst := p_state -> 'steps' -> v_key;
      if not recipe.step_once_finished(v_inst, v_alt, p_before) then
        return format('step %s is %s', v_key,
                      case when jsonb_typeof(v_inst) is distinct from 'object' then 'not enabled'
                           when p_before is not null then format('first finished %s', coalesce('at ' || (v_inst ->> 'firstCompletedSeq'), 'never'))
                           else lower(replace(coalesce(v_inst ->> 'status', 'without a status'), '_', ' ')) end);
      end if;
    elsif p_before is null and not v_alt then
      if m.value ->> 'kind' = 'stage' and jsonb_typeof(p_state -> 'stages' -> v_key -> 'signOff') is distinct from 'object' then
        return format('stage %s is not signed off', v_key);
      end if;
      if m.value ->> 'kind' = 'loop'
         and not exists (select 1 from jsonb_each(v_dec) d
                          where d.value ->> 'construct' = m.key and d.value ->> 'outcome' in ('EXIT', 'EXHAUSTED')
                            and jsonb_typeof(d.value -> 'frames') = 'array' and jsonb_array_length(d.value -> 'frames') = jsonb_array_length(p_frames) + 1
                            and recipe.ctx_key(recipe.frames_head(d.value -> 'frames', jsonb_array_length(p_frames))) = v_ctx) then
        return format('loop %s has not ended', v_key);
      end if;
      if m.value ->> 'kind' in ('alternative', 'replicate') and jsonb_typeof(v_dec -> v_key) is distinct from 'object' then
        return format('%s %s is not decided', case m.value ->> 'kind' when 'alternative' then 'alternative' else 'replicate section' end, v_key);
      end if;
    end if;
  end loop;
  return null;
end
$$;

-- DI-34, PR-13: why step instance p_inst of state p_state is not one the token can have reached in the batch's flow
-- p_tree (header item 2); NULL when it is. With p_before (the invariant query: the instance's enabledSeq), the steps
-- before it must have been first finished by then, and decisions are not looked at.
create function recipe.step_order_problem(p_tree jsonb, p_state jsonb, p_inst jsonb, p_before numeric) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_step    text := p_inst ->> 'step';
  v_node    jsonb := p_tree -> 'ids' -> (p_inst ->> 'step');
  v_frames  jsonb := p_inst -> 'frames';
  v_dec     jsonb := case when jsonb_typeof(p_state -> 'decisions') = 'object' then p_state -> 'decisions' else '{}'::jsonb end;
  e         record;
  v_n       integer := 0;
  v_fr      jsonb;
  v_k       bigint;
  v_kid     text;
  v_problem text;
begin
  if p_tree ? 'bad' then
    return format('the MBR''s procedure cannot be read (%s)', p_tree ->> 'bad');
  end if;
  if jsonb_typeof(p_inst) is distinct from 'object' or coalesce(v_node ->> 'kind', '') not in ('phase', 'holdPoint') then
    return 'its step is no phase or hold point of the MBR';
  end if;
  if jsonb_typeof(v_frames) is distinct from 'array' or p_inst ->> 'key' is distinct from v_step || '@' || recipe.ctx_key(v_frames) then
    return 'its key is not its step and frames';
  end if;
  if p_inst ->> 'status' = 'NOT_APPLICABLE' then
    -- An untaken branch: an alternative it lies in, at exactly the instance's frames, decided on another branch.
    for e in select p.v, p.i from jsonb_array_elements(v_node -> 'path') with ordinality p (v, i) order by p.i loop
      if e.v ->> 1 = 'alternative' and v_n = jsonb_array_length(v_frames)
         and recipe.frames_fit(recipe.flow_within(p_tree, e.v ->> 0), v_frames)
         and jsonb_typeof(v_dec -> ((e.v ->> 0) || '@' || recipe.ctx_key(v_frames)) -> 'outcome') = 'string'
         and v_dec -> ((e.v ->> 0) || '@' || recipe.ctx_key(v_frames)) ->> 'outcome' is distinct from e.v ->> 2 then
        return null;
      end if;
      if e.v ->> 1 in ('loop', 'replicate') then
        v_n := v_n + 1;
      end if;
    end loop;
    return 'it is set not applicable, but no alternative it lies in decided on another branch at its frames';
  end if;
  if not recipe.frames_fit(recipe.flow_within(p_tree, v_step), v_frames) then
    return 'its frames are not one per enclosing loop and replicate section, outermost first, each a whole number from 1';
  end if;
  for e in select p.v, p.i from jsonb_array_elements(v_node -> 'path') with ordinality p (v, i) order by p.i loop
    v_fr := recipe.frames_head(v_frames, v_n);
    if e.v ->> 1 = 'sequence' then
      -- Every node before it in this sequence has been left.
      for v_kid in select k.v #>> '{}'
                     from jsonb_array_elements(p_tree -> 'ids' -> (e.v ->> 0) -> 'children') with ordinality k (v, i)
                    where k.i <= (e.v ->> 2)::integer order by k.i loop
        v_problem := recipe.flow_left_problem(p_tree, p_state, v_kid, v_fr, p_before);
        if v_problem is not null then
          return format('%s comes before it and has not been left: %s', v_kid, v_problem);
        end if;
      end loop;
    elsif e.v ->> 1 = 'alternative' and p_before is null then
      if v_dec -> ((e.v ->> 0) || '@' || recipe.ctx_key(v_fr)) ->> 'outcome' is distinct from e.v ->> 2 then
        return format('alternative %s has not decided on branch %s', (e.v ->> 0) || '@' || recipe.ctx_key(v_fr), e.v ->> 2);
      end if;
    elsif e.v ->> 1 in ('loop', 'replicate') then
      v_k := (v_frames -> v_n ->> 'index')::bigint;
      if p_before is null and e.v ->> 1 = 'loop' and v_k > 1
         and v_dec -> ((e.v ->> 0) || '@' || recipe.ctx_key(v_fr || jsonb_build_array(jsonb_build_object('construct', e.v ->> 0, 'index', v_k - 1)))) ->> 'outcome'
             is distinct from 'CONTINUE' then
        return format('iteration %s of loop %s did not continue into iteration %s', v_k - 1, e.v ->> 0, v_k);
      end if;
      if p_before is null and e.v ->> 1 = 'replicate'
         and not coalesce((v_dec -> ((e.v ->> 0) || '@' || recipe.ctx_key(v_fr)) ->> 'outcome') ~ '^[0-9]{1,9}$'
                          and (v_dec -> ((e.v ->> 0) || '@' || recipe.ctx_key(v_fr)) ->> 'outcome')::bigint >= v_k, false) then
        return format('sub-lot %s of %s is not one its decided count gives', v_k, e.v ->> 0);
      end if;
      v_n := v_n + 1;
    end if;
  end loop;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. The marks the order reads
-- ---------------------------------------------------------------------------------------------

-- Why step instance p_new (p_old before the row, NULL when new) carries a completion mark the engine does not give it
-- (header item 3); NULL when it does not.
create function recipe.completion_mark_problem(p_old jsonb, p_new jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
    when jsonb_typeof(p_new) is distinct from 'object' then null
    when (p_old -> 'firstCompletedSeq') is not null and (p_new -> 'firstCompletedSeq') is distinct from (p_old -> 'firstCompletedSeq')
      then 'the mark of its first completion is changed or removed'
    when (p_old -> 'firstCompletedSeq') is null and (p_new -> 'firstCompletedSeq') is not null
         and coalesce(p_new ->> 'status', '') not in ('COMPLETED', 'SKIPPED', 'NOT_APPLICABLE')
      then format('it is marked as finished while %s', lower(replace(coalesce(p_new ->> 'status', 'without a status'), '_', ' ')))
    when p_new ->> 'kind' = 'HOLD' and p_new ->> 'status' = 'COMPLETED' and p_old ->> 'status' is distinct from 'COMPLETED'
         and (p_new -> 'disposition' -> 'positive') is distinct from 'true'::jsonb
      then 'the hold point is completed without a releasing decision'
  end
$$;

-- IN-15, DI-34: why the stage frames p_new (the state's stages after a row) change or drop a sign-off of p_old (before
-- it) otherwise than the engine does (header item 3): a sign-off appears or is replaced only in the accepted
-- SIGN_OFF_STAGE of that stage frame (the row: p_kind, p_accepted, p_command), and is otherwise kept, except that a
-- correction makes it invalid (valid true -> false, the rest kept). NULL when it does not.
create function recipe.stage_sign_off_problem(p_old jsonb, p_new jsonb, p_kind text, p_accepted boolean, p_command jsonb) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select format('the sign-off of stage %s changes in a row that does not sign it off', k.key)
    from (select key from jsonb_object_keys(case when jsonb_typeof(p_old) = 'object' then p_old else '{}'::jsonb end) key
          union
          select key from jsonb_object_keys(case when jsonb_typeof(p_new) = 'object' then p_new else '{}'::jsonb end) key) k
   cross join lateral (select p_old -> k.key -> 'signOff' as x, p_new -> k.key -> 'signOff' as y) q
   where q.y is distinct from q.x
     and not coalesce(jsonb_typeof(q.x) = 'object' and jsonb_typeof(q.y) = 'object' and q.y - 'valid' = q.x - 'valid'
                      and (q.x -> 'valid') = 'true'::jsonb and (q.y -> 'valid') = 'false'::jsonb, false)
     and not coalesce(p_kind = 'COMMAND' and p_accepted and p_command ->> 'type' = 'SIGN_OFF_STAGE' and jsonb_typeof(q.y) = 'object'
                      and k.key = (p_command ->> 'stage') || '@' || recipe.ctx_key(coalesce(p_command -> 'context', '[]'::jsonb)), false)
   order by k.key
   limit 1
$$;

-- ---------------------------------------------------------------------------------------------
-- The row trigger
-- ---------------------------------------------------------------------------------------------

-- DI-34, PR-13 (F66): the step instances a row brings in are where the token can be, and the marks that order reads are
-- the engine's (header items 2 and 3). EBMR-EXE-129.
create function recipe.execution_step_order_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  s0        jsonb := case when tg_op = 'UPDATE' then old.state else '{}'::jsonb end;
  s1        jsonb := new.state;
  r         recipe.execution_command;
  v_tree    jsonb;
  v_content jsonb;
  v_problem text;
  k         text;
  y         jsonb;
begin
  if jsonb_typeof(s1 -> 'steps') is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'The steps of the engine state are malformed (DI-34). [EBMR-EXE-030]';
  end if;
  for k, y in select key, value from jsonb_each(s1 -> 'steps') order by key loop
    v_problem := recipe.completion_mark_problem(s0 -> 'steps' -> k, y);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('Step instance %s: %s; a step is finished, and the token moves on, only as the engine finishes it (DI-34, PR-13). [EBMR-EXE-129]', k, v_problem);
    end if;
  end loop;
  -- A stage frame's sign-off: new or replaced only by its own accepted SIGN_OFF_STAGE, else kept (made invalid at most).
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_problem := recipe.stage_sign_off_problem(s0 -> 'stages', s1 -> 'stages', r.kind, r.accepted, r.command);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('%s; a stage is signed off by its own accepted SIGN_OFF_STAGE, and a sign-off is otherwise kept (IN-15, DI-34). [EBMR-EXE-129]',
                       upper(left(v_problem, 1)) || substr(v_problem, 2));
  end if;
  for k, y in select key, value from jsonb_each(s1 -> 'steps') where not coalesce((s0 -> 'steps') ? key, false) order by key loop
    if v_tree is null then
      select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
      v_tree := recipe.flow_tree(v_content);
    end if;
    v_problem := recipe.step_order_problem(v_tree, s1, y, null);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('Step instance %s is new in the state, but the token cannot have reached it: %s. A step comes only after the steps before it (DI-34, PR-13). [EBMR-EXE-129]', k, v_problem);
    end if;
  end loop;
  return null;
end
$$;

create trigger zd_execution_step_order after insert or update on recipe.execution_state
  for each row execute function recipe.execution_step_order_check();

-- ---------------------------------------------------------------------------------------------
-- 4. The invariant query
-- ---------------------------------------------------------------------------------------------

-- As 0306 (INV-03, PR-13, PR-49: a disposition by a person involved in the raising step), and (F66; DI-34, PR-13) a
-- step instance of a stored state that came before the steps before it: one of them first finished after the instance
-- was enabled, or never (as the engine's invariant checkSequence), or the instance is not one the token can have
-- reached. A later migration that adds a rule replaces this function whole, carrying its body.
create or replace function recipe.execution_rule_violations() returns table (batch_id uuid, problem text)
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
#variable_conflict use_column
declare
  r         record;
  v_tree    jsonb;
  v_problem text;
begin
  -- INV-03, PR-13, PR-49 (F11): an accepted disposition of an exception raised at a step, by a person whose involvement
  -- in that step an accepted command recorded before it.
  for r in
    select d.batch_id as bid, d.seq, d.command ->> 'exception' as exc, d.actor_person, x.step_key
      from recipe.execution_command d
      join recipe.execution_state s on s.batch_id = d.batch_id
     cross join lateral (select s.state -> 'exceptions' -> (d.command ->> 'exception') -> 'source' ->> 'stepKey' as step_key) x
     where d.kind = 'COMMAND' and d.accepted and d.command_type = 'DISPOSITION_EXCEPTION' and x.step_key is not null
       and exists (select 1
                     from recipe.execution_command c
                     join recipe.execution_event e on e.batch_id = c.batch_id and e.row_seq = c.seq
                    where c.batch_id = d.batch_id and c.seq < d.seq and c.kind = 'COMMAND' and c.accepted
                      and e.event_type = 'INVOLVEMENT' and e.event ->> 'stepKey' = x.step_key and e.event ->> 'person' = d.actor_person::text
                      and e.event ->> 'involvement' in ('STARTED', 'ENTERED_DATA', 'PERFORMED', 'CORRECTED', 'VOIDED', 'SIGNED_HOLD_POINT'))
     order by d.batch_id, d.seq
  loop
    batch_id := r.bid;
    problem := format('row %s: exception %s was dispositioned by %s, who was involved in step %s, which raised it (INV-03, PR-13, PR-49)',
                      r.seq, r.exc, r.actor_person, r.step_key);
    return next;
  end loop;

  -- DI-34, PR-13 (F66): every step instance came after the steps before it.
  for r in
    select s.batch_id as bid, s.state, pk.content
      from recipe.execution_state s
      join recipe.batch_execution b on b.id = s.batch_id
      join recipe.test_package pk on pk.package_hash = b.package_hash
     order by s.batch_id
  loop
    v_tree := recipe.flow_tree(r.content);
    for v_problem in
      select format('step instance %s: %s (DI-34, PR-13)', i.key, q.p)
        from jsonb_each(case when jsonb_typeof(r.state -> 'steps') = 'object' then r.state -> 'steps' else '{}'::jsonb end) i
       cross join lateral (
         select coalesce(recipe.step_order_problem(v_tree, r.state, i.value, null),
                         case when i.value ->> 'status' is distinct from 'NOT_APPLICABLE' then
                           case when jsonb_typeof(i.value -> 'enabledSeq') = 'number'
                                then recipe.step_order_problem(v_tree, r.state, i.value, (i.value ->> 'enabledSeq')::numeric)
                                else 'it has no sequence number of its enabling' end end) as p) q
       where q.p is not null
       order by i.key
    loop
      batch_id := r.bid;
      problem := v_problem;
      return next;
    end loop;
  end loop;
end
$$;

revoke all on function recipe.flow_tree_visit(jsonb, jsonb, text, text[], jsonb, jsonb), recipe.flow_tree(jsonb), recipe.flow_within(jsonb, text),
                       recipe.frames_fit(jsonb, jsonb), recipe.step_once_finished(jsonb, boolean, numeric),
                       recipe.flow_left_problem(jsonb, jsonb, text, jsonb, numeric), recipe.step_order_problem(jsonb, jsonb, jsonb, numeric),
                       recipe.completion_mark_problem(jsonb, jsonb), recipe.stage_sign_off_problem(jsonb, jsonb, text, boolean, jsonb),
                       recipe.execution_step_order_check() from public;

-- Privileges: CREATE OR REPLACE kept those of 0306 (execution_rule_violations private to the owner).

reset role;
