-- Recipe core, execution store (module C3): who was involved in a step is read from the accepted commands recorded on it,
-- not only from the lists the writer stores beside them (Phase 2 exit review F11, round-2 verification; INV-03, PR-13,
-- PR-49, DI-17, DI-35; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- 0306 made the database refuse a disposition by a person involved in the step that raised the exception, but it read
-- that involvement from facts the writer controls: the step's performers, data enterers, correctors and PERFORMED
-- signers in the stored state (the content provider, recipe.check_disposition_state) and the INVOLVEMENT events of the
-- rows (the invariant query). 0300 binds a person's own-step row only in the step's status, PERFORMED signers and
-- signatures; it leaves the other lists of that step and the row's events to the writer. The round-2 verification
-- stored, through the application role, operator1's own START_STEP and PREVIOUS_BATCH entry on the line clearance with
-- the engine's real result except that operator1 was taken out of the lists and the INVOLVEMENT events were dropped.
-- operator1, also holding QA_SHOP_FLOOR, then signed and stored the disposition of an exception raised at that step,
-- with the engine's own unmodified result: the database accepted it, and the invariant query reported nothing.
--
-- The accepted command rows themselves cannot be left out: they are append-only and hash-chained, and each names its
-- person from the validated session (recipe.append_execution: the engine actor is the signed-in person). The engine adds
-- exactly the person of these accepted commands to a step instance's lists (engine steps.ts and corrections.ts):
-- START_STEP (performers), RECORD_DATA and RECORD_ENTRY (data enterers), SIGN_PERFORMED (PERFORMED signers and
-- performers), DISPOSITION_HOLD_POINT (performers), VOID_ATTEMPT (data enterers), each on the step instance its command
-- names (step and context), and CORRECT_ENTRY (correctors) on the step instance of the data point it corrects (a point's
-- step is kept as recorded, 0303). This migration:
--
--   1. recipe.recorded_involvement(batch, points, step key, before): the persons of those accepted commands of the batch
--      on that step instance, before row `before` (all rows when NULL), as a sorted JSON array of person ids;
--   2. recipe.execution_content_of: the batch_exception branch also names that set for the step the exception was raised
--      at, so the kernel refuses the signature itself (EBMR-ESIG-044). The rest is exactly as 0306 defined it;
--   3. a row trigger on recipe.execution_command (ae_execution_disposition_involvement, before insert): an accepted
--      DISPOSITION_EXCEPTION whose person is in that set before the row, for the raising step of the exception in the
--      stored state, is refused (EBMR-EXE-087, the code of 0306's check of the lists). This also covers a signature made
--      before its signer acted in the step and used after that act in the same transaction;
--   4. recipe.execution_violations() reports a disposition by such a person (recipe.execution_rule_violations, replaced
--      whole, carrying the body of 0308: its F11 arm now reads the accepted commands as well as the INVOLVEMENT events).
--
-- 0306's checks of the stored lists are kept: the involvement set is the union of what the lists and the rows say.
-- CREATE OR REPLACE keeps the owner (ebmr_owner), SECURITY DEFINER, the volatility, the search_path and the privileges
-- of the replaced functions (execution_content_of and execution_rule_violations private to the owner). The new functions
-- are private to the owner; every function pins its search_path with pg_temp last. Applied as a new migration because
-- applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. The involvement the accepted commands record
-- ---------------------------------------------------------------------------------------------

-- INV-03: the persons of the accepted commands of batch p_batch before row p_before (every row when NULL) that the
-- engine adds to the involvement lists of step instance p_key (header): START_STEP, RECORD_DATA, RECORD_ENTRY,
-- SIGN_PERFORMED, DISPOSITION_HOLD_POINT and VOID_ATTEMPT naming that instance (step and context), and CORRECT_ENTRY of a
-- data point of it (its step in p_points, the stored state's data points). A sorted JSON array of person ids.
create function recipe.recorded_involvement(p_batch uuid, p_points jsonb, p_key text, p_before bigint) returns jsonb
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(q.person) order by q.person), '[]'::jsonb)
    from (select distinct c.actor_person::text as person
            from recipe.execution_command c
           where c.batch_id = p_batch and c.kind = 'COMMAND' and c.accepted and c.actor_person is not null
             and (p_before is null or c.seq < p_before)
             and case when c.command_type in ('START_STEP', 'RECORD_DATA', 'RECORD_ENTRY', 'SIGN_PERFORMED', 'DISPOSITION_HOLD_POINT', 'VOID_ATTEMPT')
                        then jsonb_typeof(c.command -> 'step') = 'string'
                             and (c.command ->> 'step') || '@' || recipe.ctx_key(coalesce(c.command -> 'context', '[]'::jsonb)) = p_key
                      when c.command_type = 'CORRECT_ENTRY'
                        then jsonb_typeof(c.command -> 'point') = 'string' and p_points -> (c.command ->> 'point') ->> 'stepKey' = p_key
                      else false end) q
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The content provider: the raising step's involvement, from the rows too
-- ---------------------------------------------------------------------------------------------

create or replace function recipe.execution_content_of(p_type text, p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_table regclass := recipe.content_table(p_type);
  v_row   record;
  v_batch uuid;
  v_key   text;
  b       recipe.batch_execution;
  st      jsonb;
  x       jsonb;
  v_state text;
  v_by    uuid[] := '{}';
  v_act   jsonb;
  v_ended bigint;
  v_dev   uuid;
  v_dec   jsonb;
begin
  if v_table is null or p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:.+$' then
    return jsonb_build_object('exists', false);
  end if;
  v_batch := split_part(p_id, ':', 1)::uuid;
  v_key := substr(p_id, 38);
  execute format('select content_version, content from %s where aggregate_id = $1 order by content_version desc limit 1', v_table) into v_row using p_id;
  if v_row.content_version is null then
    return jsonb_build_object('exists', false);
  end if;
  select * into b from recipe.batch_execution where id = v_batch;
  select state into st from recipe.execution_state where batch_id = v_batch;
  case p_type
    when 'batch_step' then
      x := st -> 'steps' -> v_key;
      v_state := x ->> 'status';
      v_by := recipe.person_ids(coalesce(x -> 'performers', '[]') || coalesce(x -> 'dataEnterers', '[]') || coalesce(x -> 'correctors', '[]')
                                || coalesce(x -> 'performedSigners', '[]'));
      v_ended := recipe.micros_of(x -> 'endedAt');
      if v_ended is not null then
        select c.device_id into v_dev from recipe.execution_command c
         where c.batch_id = v_batch and c.accepted and c.command_type = 'SIGN_PERFORMED'
           and recipe.instance_aggregate(v_batch, c.command ->> 'step', c.command -> 'context') = p_id
         order by c.seq desc limit 1;
        if v_dev is not null then
          v_act := jsonb_build_object('device_id', v_dev, 'at', timestamptz 'epoch' + make_interval(secs => 0) + (v_ended::text || ' microseconds')::interval,
                                      'next_step_started', recipe.next_step_started(st, v_key, v_ended));
        end if;
      end if;
      -- The hold-point decision being signed is part of the signed content once it is proposed
      -- (recipe.propose_hold_point_decision; P26, P38). Without a proposal the content is the one signed before 0295.
      if v_row.content -> 'step' ->> 'kind' = 'HOLD' then
        v_dec := recipe.current_decision(p_id, v_row.content_version);
        if jsonb_typeof(v_dec) = 'object' or v_row.content ? 'proposedDecision' then
          v_row.content := v_row.content || jsonb_build_object('proposedDecision', v_dec);
        end if;
      end if;
    when 'batch_stage' then
      x := st -> 'stages' -> v_key;
      v_state := case when (x -> 'signOff' ->> 'valid')::boolean is true then 'SIGNED_OFF'
                      when (x ->> 'awaitingSignOff')::boolean is true or x ? 'endedAt' then 'AWAITING_SIGN_OFF'
                      else 'IN_PROGRESS' end;
    when 'batch_exception' then
      x := st -> 'exceptions' -> v_key;
      v_state := x ->> 'status';
      -- The raiser and the person who linked the deviation, and (F11; INV-03, PR-13, PR-49) everyone involved in the
      -- step the exception was raised at, as the stored step lists name them and (round 2) as the accepted commands
      -- recorded on that step name them: the kernel never lets them sign its disposition (EBMR-ESIG-044).
      v_by := recipe.person_ids(jsonb_build_array(x ->> 'raisedBy', x -> 'deviation' ->> 'linkedBy')
                                || recipe.step_involvement(case when jsonb_typeof(x -> 'source' -> 'stepKey') = 'string'
                                                                then st -> 'steps' -> (x -> 'source' ->> 'stepKey') end)
                                || case when jsonb_typeof(x -> 'source' -> 'stepKey') = 'string'
                                        then recipe.recorded_involvement(v_batch, st -> 'points', x -> 'source' ->> 'stepKey', null)
                                        else '[]'::jsonb end);
      -- The disposition being signed is part of the signed content (recipe.propose_disposition).
      v_row.content := v_row.content || jsonb_build_object('proposedDisposition', recipe.current_proposal(p_id, v_row.content_version));
    when 'batch_point' then
      x := st -> 'points' -> v_key;
      v_state := x ->> 'status';
      v_by := recipe.person_ids(jsonb_build_array(x ->> 'enteredBy'));
  end case;
  -- The content is returned exactly as stored (its null members are part of the signed text); only an
  -- absent act is left out.
  return jsonb_build_object(
    'exists', true, 'content_version', v_row.content_version, 'content', v_row.content, 'state', v_state,
    'entered_by', to_jsonb(v_by), 'scope', jsonb_build_object('site', b.site_code))
    || case when v_act is null then '{}'::jsonb else jsonb_build_object('act', v_act) end;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. The disposition row: never by a person an accepted command on the raising step names
-- ---------------------------------------------------------------------------------------------

-- INV-03, PR-13, PR-49 (F11, round 2): an accepted DISPOSITION_EXCEPTION is not by a person whose accepted command
-- before it acted in the step that raised the exception (header item 3). Raises; never changes the row.
create function recipe.execution_disposition_involvement_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  st     jsonb;
  v_step text;
begin
  if new.kind is distinct from 'COMMAND' or new.accepted is not true or new.command_type is distinct from 'DISPOSITION_EXCEPTION' then
    return new;
  end if;
  -- The stored state before the row (recipe.write_row writes the row first, then the state that names it).
  select s.state into st from recipe.execution_state s where s.batch_id = new.batch_id;
  v_step := case when jsonb_typeof(st -> 'exceptions' -> (new.command ->> 'exception') -> 'source' -> 'stepKey') = 'string'
                 then st -> 'exceptions' -> (new.command ->> 'exception') -> 'source' ->> 'stepKey' end;
  if v_step is not null and recipe.recorded_involvement(new.batch_id, st -> 'points', v_step, new.seq) ? coalesce(new.actor_person::text, '') then
    raise exception using errcode = 'P0001',
      message = format('%s started, entered data in, corrected or signed performed step %s, which raised exception %s, as the accepted commands recorded on that step show, so the disposition is refused: an exception is decided by a person outside the work that raised it (INV-03, PR-13, PR-49). [EBMR-EXE-087]',
                       new.actor_person, v_step, coalesce(new.command ->> 'exception', 'null'));
  end if;
  return new;
end
$$;

create trigger ae_execution_disposition_involvement before insert on recipe.execution_command
  for each row execute function recipe.execution_disposition_involvement_check();

-- ---------------------------------------------------------------------------------------------
-- 4. The invariant query
-- ---------------------------------------------------------------------------------------------

-- As 0308 (INV-03, PR-13, PR-49 of 0306; DI-34, PR-13 of 0307; INV-20, PR-30 of 0308), and (F11, round 2) the
-- involvement of the disposer in the raising step read from the accepted commands before the disposition as well as
-- from the INVOLVEMENT events. A later migration that adds a rule replaces this function whole, carrying its body.
create or replace function recipe.execution_rule_violations() returns table (batch_id uuid, problem text)
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
#variable_conflict use_column
declare
  r         record;
  v_tree    jsonb;
  v_problem text;
begin
  -- INV-03, PR-13, PR-49 (F11): an accepted disposition of an exception raised at a step, by a person whose involvement
  -- in that step an accepted command recorded before it: the command itself (round 2, recipe.recorded_involvement), or
  -- an INVOLVEMENT event of it.
  for r in
    select d.batch_id as bid, d.seq, d.command ->> 'exception' as exc, d.actor_person, x.step_key
      from recipe.execution_command d
      join recipe.execution_state s on s.batch_id = d.batch_id
     cross join lateral (select s.state -> 'exceptions' -> (d.command ->> 'exception') -> 'source' ->> 'stepKey' as step_key) x
     where d.kind = 'COMMAND' and d.accepted and d.command_type = 'DISPOSITION_EXCEPTION' and x.step_key is not null
       and (recipe.recorded_involvement(d.batch_id, s.state -> 'points', x.step_key, d.seq) ? d.actor_person::text
            or exists (select 1
                         from recipe.execution_command c
                         join recipe.execution_event e on e.batch_id = c.batch_id and e.row_seq = c.seq
                        where c.batch_id = d.batch_id and c.seq < d.seq and c.kind = 'COMMAND' and c.accepted
                          and e.event_type = 'INVOLVEMENT' and e.event ->> 'stepKey' = x.step_key and e.event ->> 'person' = d.actor_person::text
                          and e.event ->> 'involvement' in ('STARTED', 'ENTERED_DATA', 'PERFORMED', 'CORRECTED', 'VOIDED', 'SIGNED_HOLD_POINT')))
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

revoke all on function recipe.recorded_involvement(uuid, jsonb, text, bigint), recipe.execution_disposition_involvement_check() from public;

-- Privileges: CREATE OR REPLACE kept those of 0306 and 0308 (execution_content_of and execution_rule_violations private
-- to the owner).

reset role;
