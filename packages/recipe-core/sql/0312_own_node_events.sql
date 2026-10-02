-- Recipe core, execution store (module C3): an act records the start or end it makes, and the token's arrival records
-- the starts of the constructs it enters, so the time limits are measured from facts the writer cannot leave out
-- (Phase 2 exit review F67, round-2 verification; INV-20, PR-30, DI-27, DI-34; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
-- 0308 measures a minimum duration from the node events of the state before the row, and 0299 lets only the act that
-- records a node event add it; neither required the act to add it. The round-2 verification stored, through the
-- application role, on dc-mini with a 1 h minimum from the clearance's START to its END:
--   V1. operator1's START_STEP of the clearance whose state left out the START node event: accepted, and the unmodified
--       server's own SIGN_PERFORMED then went through at once (the engine's checkMinimum, like 0308, finds no start and
--       skips the constraint);
--   V2. a signed SIGN_PERFORMED (engine result computed without the minimum) whose state left out the END node event:
--       accepted, the step awaiting verification seconds after its start, and the invariant query reported nothing.
--
-- This migration adds a row trigger on recipe.execution_state (zg_execution_own_node_events, after insert or update;
-- every row, the issue included), refused with EBMR-EXE-133 (DI-27, INV-20, DI-34). The state a row stores holds
-- (recipe.own_node_event_problem; engine steps.ts, advance.ts afterFire):
--   1. after an accepted START_STEP, the START of its phase instance (step|START|context);
--   2. after an accepted SIGN_PERFORMED that moves its step out of IN_PROGRESS, the END of the phase instance;
--   3. after an accepted DISPOSITION_HOLD_POINT that completes its hold point (a release), the END of the hold point;
--   4. after an accepted SIGN_OFF_STAGE, the END of that stage frame (the token leaves the stage once it is signed
--      off; a sign-off made again after a correction finds the END already recorded);
--   5. after an accepted COMPLETE_LOOP_ITERATION whose decision, new in the row, ends the loop (EXIT or EXHAUSTED), the
--      END of the loop, in the frames outside its iterations;
--   6. for every step instance the row brings in ENABLED (the token has arrived there): the START of a hold point, and
--      the START of every stage, operation, loop, parallel, alternative and replicate section that encloses the
--      instance, in the frames of the loops and replicate sections around that construct (the token entered each of
--      them on its way; a loop's start is its first entry).
-- Node events are kept as recorded once added (0299), so each of these, once present, stays; with 0311 (a step is
-- signed performed only while in progress, which only its START_STEP makes it) every END of a phase finds the START
-- its own constraint is measured from.
--
-- What stays with the replay verification (ADR 0010), as in 0299 and 0307: the database does not re-run the token
-- advance, so when the token arrives (the row that brings an instance in) is taken as recorded; the time of every
-- event is the row's trusted time (0299). The core of the check is the pure function recipe.own_node_event_problem,
-- compared with the engine's own runs (packages/recipe-core/test/execution own-node-events-sql.test.ts).
--
-- New functions are owned by ebmr_owner and private to the owner (no EXECUTE for PUBLIC); the trigger function is
-- SECURITY DEFINER; every function pins its search_path with pg_temp last. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- The key of the node event of node p_node, event p_event, in frames p_frames (engine timing.ts nodeEventKey).
create function recipe.node_event_key(p_node text, p_event text, p_frames jsonb) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select p_node || '|' || p_event || '|' || recipe.ctx_key(p_frames)
$$;

-- INV-20, DI-27, DI-34 (F67, round 2): why the state p_new that a row (kind p_kind, accepted p_accepted, command
-- p_command as recorded) stores after state p_old (an empty object for the issue) leaves out a start or end its act or
-- the token's arrival records (header items 1 to 6); NULL when it does not. p_tree is the batch's flow
-- (recipe.flow_tree). The text completes "This <row> ...".
create function recipe.own_node_event_problem(p_tree jsonb, p_old jsonb, p_new jsonb, p_kind text, p_accepted boolean, p_command jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ev    jsonb := case when jsonb_typeof(p_new -> 'nodeEvents') = 'object' then p_new -> 'nodeEvents' else '{}'::jsonb end;
  v_type  text := case when p_kind = 'COMMAND' and p_accepted is true then p_command ->> 'type' end;
  v_ctx   jsonb := case when jsonb_typeof(p_command -> 'context') = 'array' then p_command -> 'context' else '[]'::jsonb end;
  v_key   text;
  v_dkey  text;
  v_want  text;
  v_what  text;
  k       text;
  y       jsonb;
  c       record;
begin
  -- Items 1 to 3: the act on a phase or hold point.
  if v_type in ('START_STEP', 'SIGN_PERFORMED', 'DISPOSITION_HOLD_POINT') and jsonb_typeof(p_command -> 'step') = 'string' then
    v_key := (p_command ->> 'step') || '@' || recipe.ctx_key(v_ctx);
    if v_type = 'START_STEP' then
      v_want := recipe.node_event_key(p_command ->> 'step', 'START', v_ctx);
      v_what := format('starts phase %s', v_key);
    elsif v_type = 'SIGN_PERFORMED' and p_old -> 'steps' -> v_key ->> 'status' = 'IN_PROGRESS'
          and p_new -> 'steps' -> v_key ->> 'status' is distinct from 'IN_PROGRESS' then
      v_want := recipe.node_event_key(p_command ->> 'step', 'END', v_ctx);
      v_what := format('ends phase %s', v_key);
    elsif v_type = 'DISPOSITION_HOLD_POINT' and p_new -> 'steps' -> v_key ->> 'status' = 'COMPLETED'
          and p_old -> 'steps' -> v_key ->> 'status' is distinct from 'COMPLETED' then
      v_want := recipe.node_event_key(p_command ->> 'step', 'END', v_ctx);
      v_what := format('releases hold point %s', v_key);
    end if;
    if v_want is not null and not (v_ev ? v_want) then
      return format('%s but records no %s event of it (%s)', v_what, split_part(v_want, '|', 2), v_want);
    end if;
  end if;
  -- Item 4: the stage signed off.
  if v_type = 'SIGN_OFF_STAGE' and jsonb_typeof(p_command -> 'stage') = 'string' then
    v_want := recipe.node_event_key(p_command ->> 'stage', 'END', v_ctx);
    if not (v_ev ? v_want) then
      return format('signs off stage %s@%s but records no END event of it (%s)', p_command ->> 'stage', recipe.ctx_key(v_ctx), v_want);
    end if;
  end if;
  -- Item 5: the loop ended.
  if v_type = 'COMPLETE_LOOP_ITERATION' and jsonb_typeof(p_command -> 'construct') = 'string' and jsonb_array_length(v_ctx) > 0 then
    v_dkey := (p_command ->> 'construct') || '@' || recipe.ctx_key(v_ctx);
    if not coalesce((p_old -> 'decisions') ? v_dkey, false) and p_new -> 'decisions' -> v_dkey ->> 'outcome' in ('EXIT', 'EXHAUSTED') then
      v_want := recipe.node_event_key(p_command ->> 'construct', 'END', recipe.frames_head(v_ctx, jsonb_array_length(v_ctx) - 1));
      if not (v_ev ? v_want) then
        return format('ends loop %s (%s) but records no END event of it (%s)', p_command ->> 'construct', p_new -> 'decisions' -> v_dkey ->> 'outcome', v_want);
      end if;
    end if;
  end if;
  -- Item 6: the token's arrival at a step instance.
  for k, y in select e.key, e.value
                from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) e
               where not coalesce((p_old -> 'steps') ? e.key, false) and e.value ->> 'status' = 'ENABLED'
               order by e.key
  loop
    if jsonb_typeof(p_tree -> 'ids' -> (y ->> 'step')) is distinct from 'object' then
      continue; -- not a step of the flow: 0307 refuses it (EBMR-EXE-129)
    end if;
    if y ->> 'kind' = 'HOLD' then
      v_want := recipe.node_event_key(y ->> 'step', 'START', y -> 'frames');
      if not (v_ev ? v_want) then
        return format('brings in hold point %s, which the token reaches, but records no START event of it (%s)', k, v_want);
      end if;
    end if;
    for c in select p.v ->> 0 as id, p.v ->> 1 as kind
               from jsonb_array_elements(p_tree -> 'ids' -> (y ->> 'step') -> 'path') with ordinality p (v, i)
              where p.v ->> 1 in ('stage', 'operation', 'loop', 'parallel', 'alternative', 'replicate')
              order by p.i
    loop
      v_want := recipe.node_event_key(c.id, 'START', recipe.frames_head(y -> 'frames', coalesce(jsonb_array_length(recipe.flow_within(p_tree, c.id)), 0)));
      if not (v_ev ? v_want) then
        return format('brings in step %s, which lies in %s %s, but records no START event of that %s (%s)', k, c.kind, c.id, c.kind, v_want);
      end if;
    end loop;
  end loop;
  return null;
end
$$;

-- INV-20, DI-27, DI-34 (F67, round 2): the state a row stores holds the starts and ends its act and the token's
-- arrival record (header). Runs after the projection is written; the row that produced the state is the one it names
-- (last_seq). EBMR-EXE-133. Raises; returns nothing.
create function recipe.execution_own_node_events_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  s0        jsonb := case when tg_op = 'UPDATE' then old.state else '{}'::jsonb end;
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
  v_problem := recipe.own_node_event_problem(recipe.flow_tree(v_content), s0, new.state, r.kind, r.accepted, r.command);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: the start and end of a step or construct are recorded by the act or arrival that makes them, so its time limits are measured from them (DI-27, INV-20, DI-34). [EBMR-EXE-133]',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create trigger zg_execution_own_node_events after insert or update on recipe.execution_state
  for each row execute function recipe.execution_own_node_events_check();

revoke all on function recipe.node_event_key(text, text, jsonb), recipe.own_node_event_problem(jsonb, jsonb, jsonb, text, boolean, jsonb),
                       recipe.execution_own_node_events_check() from public;

reset role;
