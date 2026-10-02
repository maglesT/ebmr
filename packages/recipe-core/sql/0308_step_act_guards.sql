-- Recipe core, execution store (module C3): an act on a step keeps the minimum durations and the blocks of open
-- exceptions, in the database as in the engine (Phase 2 exit review F67; INV-20, PR-08, PR-30, PR-45, IN-37, DI-34;
-- ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- The engine refuses a step's START or END before the minimum of a time constraint ending in it (engine timing.ts
-- checkMinimum, ENG-MIN-DURATION), a start or completion of a step that an open exception's block names or lies
-- downstream of (guards.ts requireNotBlocked, ENG-BLOCKED), and the release of a hold point while an open exception that
-- is not an alert has no QA decision (steps.ts dispositionHoldPoint, ENG-HOLD-OPEN-EXCEPTIONS). The database checked the
-- END only as bookkeeping (0299: at the row's time, by the step's own accepted act) and none of the three rules: a
-- writer holding the application role stored a SIGN_PERFORMED 0.6 s after the start of a step with a 1 h minimum, and
-- one of a step blocked by its open action-limit breach, each with an engine result computed as if the rule were not
-- there; the invariant query reported nothing (the completeness critic's reproducers).
--
-- This migration adds a row trigger on recipe.execution_state (ze_execution_step_acts, after update), which applies to
-- every row:
--
--   1. INV-20, PR-30 (recipe.minimum_duration_problem, EBMR-EXE-130): for every node event the row adds, and every time
--      constraint of the MBR's own list that ends in it and has a minimum, the time since the constraint's start in the
--      state before the row (its earliest START or latest END of the same instance, recipe.time_start_us of 0280) is at
--      least the minimum. The instance is the event's frames of the constructs both ends share (engine definition.ts,
--      the common prefix of their enclosing loops and replicate sections). A person's act (the START or END of a phase,
--      the END of a hold point, a stage or a loop) before its minimum is refused, as the engine refuses it; an automatic
--      construct event (the END of an operation, a parallel or alternative section, a replicate section) before its
--      minimum is accepted only with the TIME_MIN_BREACH the engine raises for it in the same row (its constraint
--      instance marked with minBreachException; 0280 and 0299 prove that breach). Pauses are not subtracted, as in
--      the engine (pauses come with Phase 3).
--
--   2. PR-08, PR-13 (recipe.blocking_exceptions_problem, EBMR-EXE-131): an accepted START_STEP, an accepted
--      SIGN_PERFORMED that completes its step (the step leaves IN_PROGRESS) and an accepted VERIFY act on a step that
--      no exception of the state before the row blocks: an open exception whose block is active (until DISPOSITION, or
--      until a deviation and none is linked) blocks the completion of the step instances its block names, and the
--      start and completion of the step instances its downstream anchor reaches in the flow (as the engine's
--      reachability of the execution graph, recipe.flow_reaches: after the anchor in a sequence, inside the construct
--      the anchor opens, and anywhere in a loop around both), except its own source step, with the same sub-lot.
--
--   3. PR-45, IN-37, PR-08 (recipe.hold_release_problem, EBMR-EXE-131): an accepted DISPOSITION_HOLD_POINT that releases
--      the hold point (recipe.hold_point_meaning HOLD_POINT_RELEASED) finds no open exception of the state before the
--      row that is not an alert, in the same sub-lot.
--
--   4. recipe.execution_violations() also reports (in recipe.execution_rule_violations, replaced whole, carrying 0306 and
--      0307) a phase or hold-point event of the stored state that came before a minimum ending in it: the latest
--      START or earliest END of its constraint instance among the events recorded before it.
--
-- What stays with the replay verification (ADR 0010), stated so the checks are not over-read: the state before the row
-- is the one the database has; the exceptions the engine's own sweep raises at the start of a command, before it checks
-- a block, are not seen by rule 2 or 3 (the database cannot tell them from those the act raises after its check). A
-- block cannot be re-judged after the fact from the stored rows (only the state of the last row is kept), so the
-- invariant query has no arm for rules 2 and 3; the write-time refusal is the enforcement.
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed
-- and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. Minimum durations
-- ---------------------------------------------------------------------------------------------

-- The number of leading constructs two lists of enclosing loops and replicate sections share (engine definition.ts
-- RuntimeConstraint.shared); NULL when either is unknown.
create function recipe.shared_constructs(p_a jsonb, p_b jsonb) returns integer
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(p_a) = 'array' and jsonb_typeof(p_b) = 'array' then
    coalesce((select min(i) - 1 from generate_series(1, least(jsonb_array_length(p_a), jsonb_array_length(p_b)) + 1) i
               where i > least(jsonb_array_length(p_a), jsonb_array_length(p_b)) or p_a -> (i - 1) is distinct from p_b -> (i - 1)), 0) end
$$;

-- INV-20, PR-30: why a node event that the row moving the state from p_old to p_new adds comes before the minimum of a
-- time constraint of MBR content p_content (flow p_tree) ending in it, as the engine refuses or flags it (header item
-- 1); NULL when none does.
create function recipe.minimum_duration_problem(p_content jsonb, p_tree jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_old    jsonb := case when jsonb_typeof(p_old -> 'nodeEvents') = 'object' then p_old -> 'nodeEvents' else '{}'::jsonb end;
  e        record;
  tc       jsonb;
  v_kind   text;
  v_person boolean;
  v_min    bigint;
  v_shared integer;
  v_inst   jsonb;
  v_start  bigint;
  v_at     bigint;
begin
  for e in select n.key, n.value
             from jsonb_each(case when jsonb_typeof(p_new -> 'nodeEvents') = 'object' then p_new -> 'nodeEvents' else '{}'::jsonb end) n
            where not (v_old ? n.key)
            order by n.key
  loop
    v_kind := p_tree -> 'ids' -> (e.value ->> 'node') ->> 'kind';
    -- A person's act is refused before its minimum (a phase's start or end; the end of a hold point, a stage or a loop:
    -- its release, sign-off or last iteration); an automatic construct end is flagged with a breach. The start of a hold
    -- point or of a construct is the token's arrival, which the engine neither refuses nor flags.
    v_person := v_kind = 'phase' or (e.value ->> 'event' = 'END' and v_kind in ('holdPoint', 'stage', 'loop'));
    continue when not coalesce(v_person or (e.value ->> 'event' = 'END' and v_kind in ('operation', 'parallel', 'alternative', 'replicate')), false);
    v_at := recipe.micros_of(e.value -> 'at');
    for tc in select t
                from jsonb_array_elements(case when jsonb_typeof(p_content -> 'timeConstraints') = 'array' then p_content -> 'timeConstraints' else '[]'::jsonb end) t
               where t -> 'to' ->> 'node' = e.value ->> 'node' and t -> 'to' ->> 'event' = e.value ->> 'event'
                 and jsonb_typeof(t -> 'from' -> 'node') = 'string' and t -> 'from' ->> 'event' in ('START', 'END')
    loop
      v_min := recipe.duration_us(tc -> 'min');
      v_shared := recipe.shared_constructs(recipe.flow_within(p_tree, tc -> 'from' ->> 'node'), recipe.flow_within(p_tree, e.value ->> 'node'));
      continue when v_min is null or v_shared is null or v_at is null or jsonb_typeof(e.value -> 'frames') is distinct from 'array';
      v_inst := recipe.frames_head(e.value -> 'frames', v_shared);
      v_start := recipe.time_start_us(v_old, jsonb_build_object('from', tc -> 'from'), v_inst);
      continue when v_start is null or v_at - v_start >= v_min;
      if v_person then
        return format('%s of %s comes %s after the %s of %s, before the minimum of %s of %s',
                      lower(e.value ->> 'event'), (e.value ->> 'node') || '@' || recipe.ctx_key(e.value -> 'frames'),
                      recipe.format_micros(greatest(v_at - v_start, 0)), lower(tc -> 'from' ->> 'event'), tc -> 'from' ->> 'node',
                      recipe.format_micros(v_min), coalesce(tc ->> 'name', tc ->> 'id'));
      end if;
      if jsonb_typeof(p_new -> 'timeInstances' -> ((tc ->> 'id') || '@' || recipe.ctx_key(v_inst)) -> 'minBreachException') is distinct from 'string' then
        return format('%s of %s comes before the minimum of %s of %s, and the row raises no TIME_MIN_BREACH for it',
                      lower(e.value ->> 'event'), (e.value ->> 'node') || '@' || recipe.ctx_key(e.value -> 'frames'),
                      recipe.format_micros(v_min), coalesce(tc ->> 'name', tc ->> 'id'));
      end if;
    end loop;
  end loop;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Blocks of open exceptions
-- ---------------------------------------------------------------------------------------------

-- Whether the execution graph reaches the node of step p_to from the anchor of tree node p_from (engine definition.ts
-- reachFrom over the compiled graph, flow/compile.ts): p_inside when the anchor opens the construct p_from (its scope
-- start, split, loop entry or test), so that everything inside it follows; after p_from in a sequence they both lie in;
-- and anywhere in a loop around both (its loop-back edge). Nothing crosses from one branch of a parallel section or an
-- alternative into another. FALSE when the tree has either node.
create function recipe.flow_reaches(p_tree jsonb, p_from text, p_inside boolean, p_to text) returns boolean
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_a jsonb := p_tree -> 'ids' -> p_from;
  v_y jsonb := p_tree -> 'ids' -> p_to;
  pa  jsonb;
  py  jsonb;
  k   integer := 0;
begin
  if jsonb_typeof(v_a) is distinct from 'object' or jsonb_typeof(v_y) is distinct from 'object' then
    return false;
  end if;
  if p_inside and exists (select 1 from jsonb_array_elements(v_y -> 'path') p where p ->> 0 = p_from) then
    return true;
  end if;
  pa := (v_a -> 'path') || jsonb_build_array(jsonb_build_array(p_from, v_a ->> 'kind', null));
  py := (v_y -> 'path') || jsonb_build_array(jsonb_build_array(p_to, v_y ->> 'kind', null));
  while k < jsonb_array_length(pa) and k < jsonb_array_length(py) and pa -> k ->> 0 = py -> k ->> 0 loop
    k := k + 1;
  end loop;
  if exists (select 1 from jsonb_array_elements(pa) with ordinality p (v, i) where p.i <= k and p.v ->> 1 = 'loop') then
    return true;
  end if;
  if k = 0 or k = jsonb_array_length(pa) or k = jsonb_array_length(py) then
    return false;
  end if;
  return pa -> (k - 1) ->> 1 = 'sequence' and (py -> (k - 1) ->> 2)::integer > (pa -> (k - 1) ->> 2)::integer;
end
$$;

-- Whether frames p_a and p_b agree on every replicate section of tree p_tree they both name (engine exceptions.ts
-- replicateCompatible: another sub-lot is never downstream).
create function recipe.same_sub_lots(p_tree jsonb, p_a jsonb, p_b jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select not exists (
    select 1
      from jsonb_array_elements(case when jsonb_typeof(p_a) = 'array' then p_a else '[]'::jsonb end) a
      join jsonb_array_elements(case when jsonb_typeof(p_b) = 'array' then p_b else '[]'::jsonb end) b on b ->> 'construct' = a ->> 'construct'
     where p_tree -> 'ids' -> (a ->> 'construct') ->> 'kind' = 'replicate' and (b -> 'index') is distinct from (a -> 'index'))
$$;

-- PR-08, PR-13: why step instance p_inst of state p_state (before the row) cannot p_phase (START or COMPLETE) while the
-- exceptions of that state block it, as the engine's blockingExceptions (header item 2); NULL when none does.
create function recipe.blocking_exceptions_problem(p_tree jsonb, p_state jsonb, p_inst jsonb, p_phase text) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select format('step %s cannot %s while these exceptions are unresolved: %s', p_inst ->> 'key', lower(p_phase),
                string_agg(format('%s %s%s', x.key, x.value ->> 'title',
                                  case when (x.value -> 'deviationRequired') = 'true'::jsonb and jsonb_typeof(x.value -> 'deviation') is distinct from 'object'
                                       then ' (needs a linked deviation)' else '' end), '; ' order by x.key))
    from jsonb_each(case when jsonb_typeof(p_state -> 'exceptions') = 'object' then p_state -> 'exceptions' else '{}'::jsonb end) x
    cross join lateral (select x.value -> 'block' -> 'downstream' as d,
                               split_part(x.value -> 'block' -> 'downstream' ->> 'node', ':', 1) as kind,
                               substr(x.value -> 'block' -> 'downstream' ->> 'node', strpos(x.value -> 'block' -> 'downstream' ->> 'node', ':') + 1) as anchor) a
   where jsonb_typeof(x.value -> 'block') = 'object' and x.value ->> 'status' = 'OPEN'
     and (x.value -> 'block' ->> 'until' = 'DISPOSITION' or jsonb_typeof(x.value -> 'deviation') is distinct from 'object')
     and ((p_phase = 'COMPLETE' and jsonb_typeof(x.value -> 'block' -> 'steps') = 'array' and (x.value -> 'block' -> 'steps') ? (p_inst ->> 'key'))
          or (jsonb_typeof(a.d) = 'object' and p_inst ->> 'key' is distinct from x.value -> 'source' ->> 'stepKey'
              and a.kind in ('task', 'hold', 'scope-start', 'and-split', 'xor-split', 'loop-entry', 'loop-test', 'rep-split')
              and recipe.flow_reaches(p_tree, a.anchor, a.kind not in ('task', 'hold'), p_inst ->> 'step')
              and recipe.same_sub_lots(p_tree, a.d -> 'frames', p_inst -> 'frames')))
  having count(*) > 0
$$;

-- PR-45, IN-37, PR-08: why hold point p_inst cannot be released while the exceptions of state p_state (before the row)
-- are open (engine steps.ts dispositionHoldPoint: any open exception that is not an alert, in the same sub-lot); NULL
-- when none is.
create function recipe.hold_release_problem(p_tree jsonb, p_state jsonb, p_inst jsonb) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select format('hold point %s cannot be released while required results are failing or open exceptions have no QA decision: %s',
                p_inst ->> 'key', string_agg(format('%s %s', x.key, x.value ->> 'title'), '; ' order by x.key))
    from jsonb_each(case when jsonb_typeof(p_state -> 'exceptions') = 'object' then p_state -> 'exceptions' else '{}'::jsonb end) x
   where x.value ->> 'status' = 'OPEN' and x.value ->> 'severity' is distinct from 'ALERT'
     and recipe.same_sub_lots(p_tree, x.value -> 'source' -> 'frames', p_inst -> 'frames')
  having count(*) > 0
$$;

-- ---------------------------------------------------------------------------------------------
-- The row trigger
-- ---------------------------------------------------------------------------------------------

-- INV-20, PR-08, PR-45 (F67): the acts a row records on a step keep the minimum durations and the blocks of open
-- exceptions (header items 1 to 3). EBMR-EXE-130, EBMR-EXE-131.
create function recipe.execution_step_acts_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  s0        jsonb := old.state;
  s1        jsonb := new.state;
  r         recipe.execution_command;
  v_content jsonb;
  v_tree    jsonb;
  v_key     text;
  v_phase   text;
  v_problem text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_key := case when r.kind = 'COMMAND' and r.accepted then recipe.row_step_key(r.kind, r.command) end;
  v_phase := case when v_key is null then null
                  when r.command ->> 'type' = 'START_STEP' then 'START'
                  when r.command ->> 'type' = 'VERIFY' then 'COMPLETE'
                  when r.command ->> 'type' = 'SIGN_PERFORMED' and s0 -> 'steps' -> v_key ->> 'status' = 'IN_PROGRESS'
                       and s1 -> 'steps' -> v_key ->> 'status' is distinct from 'IN_PROGRESS' then 'COMPLETE' end;
  -- Only rows that add a node event or act on a step need the MBR.
  if v_phase is null and r.command ->> 'type' is distinct from 'DISPOSITION_HOLD_POINT'
     and (s1 -> 'nodeEvents') is not distinct from (s0 -> 'nodeEvents') then
    return null;
  end if;
  select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
  v_tree := recipe.flow_tree(v_content);

  v_problem := recipe.minimum_duration_problem(v_content, v_tree, s0, s1);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The %s: no step starts or completes before its minimum duration (INV-20, PR-30). [EBMR-EXE-130]', v_problem);
  end if;
  if v_phase is not null then
    v_problem := recipe.blocking_exceptions_problem(v_tree, s0, s0 -> 'steps' -> v_key, v_phase);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('This %s row is refused: %s; a blocked step waits for its deviation or QA decision (PR-08, PR-13, INV-20). [EBMR-EXE-131]',
                         r.command ->> 'type', v_problem);
    end if;
  end if;
  if v_key is not null and r.command ->> 'type' = 'DISPOSITION_HOLD_POINT' and recipe.hold_point_meaning(r.command ->> 'disposition') = 'HOLD_POINT_RELEASED' then
    v_problem := recipe.hold_release_problem(v_tree, s0, s0 -> 'steps' -> v_key);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('This DISPOSITION_HOLD_POINT row is refused: %s (PR-45, IN-37, PR-08). [EBMR-EXE-131]', v_problem);
    end if;
  end if;
  return null;
end
$$;

create trigger ze_execution_step_acts after update on recipe.execution_state
  for each row execute function recipe.execution_step_acts_check();

-- ---------------------------------------------------------------------------------------------
-- 4. The invariant query
-- ---------------------------------------------------------------------------------------------

-- As 0307 (INV-03, PR-13, PR-49 of 0306; DI-34, PR-13 of 0307), and (F67; INV-20, PR-30) a phase or hold-point event of
-- a stored state that came before the minimum of a constraint of the MBR's own list ending in it, measured from the
-- events of its constraint instance recorded before it. A later migration that adds a rule replaces this function
-- whole, carrying its body.
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

  for r in
    select s.batch_id as bid, s.state, pk.content
      from recipe.execution_state s
      join recipe.batch_execution b on b.id = s.batch_id
      join recipe.test_package pk on pk.package_hash = b.package_hash
     order by s.batch_id
  loop
    v_tree := recipe.flow_tree(r.content);
    -- DI-34, PR-13 (F66): every step instance came after the steps before it.
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
    -- INV-20, PR-30 (F67): no phase or hold-point event came before a minimum ending in it.
    for v_problem in
      select format('the %s (INV-20, PR-30)', q.p)
        from jsonb_each(case when jsonb_typeof(r.state -> 'nodeEvents') = 'object' then r.state -> 'nodeEvents' else '{}'::jsonb end) e
       cross join lateral (
         select recipe.minimum_duration_problem(
                  r.content, v_tree,
                  jsonb_build_object('nodeEvents', coalesce((select jsonb_object_agg(o.key, o.value)
                                                               from jsonb_each(r.state -> 'nodeEvents') o
                                                              where recipe.micros_of(o.value -> 'at') < recipe.micros_of(e.value -> 'at')), '{}'::jsonb)),
                  jsonb_build_object('nodeEvents', jsonb_build_object(e.key, e.value))) as p) q
       where q.p is not null and v_tree -> 'ids' -> (e.value ->> 'node') ->> 'kind' in ('phase', 'holdPoint')
       order by e.key
    loop
      batch_id := r.bid;
      problem := v_problem;
      return next;
    end loop;
  end loop;
end
$$;

revoke all on function recipe.shared_constructs(jsonb, jsonb), recipe.minimum_duration_problem(jsonb, jsonb, jsonb, jsonb),
                       recipe.flow_reaches(jsonb, text, boolean, text), recipe.same_sub_lots(jsonb, jsonb, jsonb),
                       recipe.blocking_exceptions_problem(jsonb, jsonb, jsonb, text), recipe.hold_release_problem(jsonb, jsonb, jsonb),
                       recipe.execution_step_acts_check() from public;

-- Privileges: CREATE OR REPLACE kept those of 0306 (execution_rule_violations private to the owner).

reset role;
