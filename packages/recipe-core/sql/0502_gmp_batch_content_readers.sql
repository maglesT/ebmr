-- Recipe core, execution store (module C3): every guard and reader of a batch's MBR content reads the content a GMP
-- batch runs too (Phase 3 slice 2b items 1 and 2; DI-05, INV-02; ADR 0012: the rules hold when the application's own
-- database credentials are used directly).
--
-- Until now each of these functions read a batch's MBR content from its test package (recipe.batch_execution joined to
-- recipe.test_package on package_hash). A GMP batch names no test package (0500): it runs its control recipe's snapshot.
-- An inner join would have found no content for it, so a guard would have checked a GMP row against nothing (or
-- refused it). Each function is replaced from its latest definition (named above it) with exactly one change: the
-- content comes from recipe.execution_mbr_content(package_hash, control_recipe_id), the package's content for a test
-- batch (as before) and the control recipe's snapshot.mbr.content for a GMP batch; recipe.check_exception_changes, which
-- finds the content by the state's MBR hash, reads recipe.content_for_mbr_hash. A function that reads the content
-- from the batch row now joins the content laterally under the same alias, so the rest of its body is unchanged.
--
-- Left as it was: recipe.run_bound_words (0348; the sandbox's identifier rule over a test run's text: its callers return
-- before it in a GMP database). CREATE OR REPLACE keeps each function's owner, privileges, SECURITY DEFINER and
-- search_path. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- As 0370_loop_exit_limit_verdicts.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
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
      v_cont := recipe.content_for_mbr_hash(p_state ->> 'mbrHash');
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
  -- row changes a data point, a computed value or a decision (a loop's exit judges its endpoint, 0370), or adds a limit
  -- exception.
  if (p_state -> 'points') is distinct from (p_prior -> 'points') or (p_state -> 'derived') is distinct from (p_prior -> 'derived')
     or (p_state -> 'decisions') is distinct from (p_prior -> 'decisions')
     or exists (select 1 from jsonb_each(e1) e where not (e0 ? e.key) and e.value ->> 'type' in ('LIMIT_BREACH', 'YIELD_OUT_OF_LIMITS')) then
    if not v_loaded then
      v_cont := recipe.content_for_mbr_hash(p_state ->> 'mbrHash');
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

-- As 0270_execution_guards.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.correction_needs_approval(p_batch uuid, p_prior jsonb, p_point text) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  b      recipe.batch_execution;
  v_item text := p_prior -> 'points' -> p_point ->> 'item';
begin
  select * into b from recipe.batch_execution where id = p_batch;
  return not exists (
    select 1 from (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk
    cross join lateral jsonb_array_elements(case when jsonb_typeof(pk.content -> 'parameters') = 'array' then pk.content -> 'parameters' else '[]'::jsonb end) p
    where b.id is not null and v_item is not null and p ->> 'id' = v_item and p ->> 'criticality' = 'NON_CRITICAL');
end
$$;

-- As 0304_hold_point_first_version.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.created_by_system(p_batch uuid, p_seq bigint, p_state jsonb, p_c jsonb) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_key text := p_c ->> 'key';
  v_ct  jsonb := p_c -> 'content';
  v_mbr jsonb;
  x     jsonb;
  f     text;
begin
  if jsonb_typeof(p_state) is distinct from 'object' or v_key is null or jsonb_typeof(v_ct) is distinct from 'object' then
    return false;
  end if;
  if p_c ->> 'type' = 'batch_exception' then
    x := p_state -> 'exceptions' -> v_key;
    if not coalesce(jsonb_typeof(x) = 'object' and x ->> 'raisedBy' = 'SYSTEM' and recipe.is_system_fact(x ->> 'type') and x ->> 'status' = 'OPEN'
                    and not (x ?| array['deviation', 'disposition']), false) then
      return false;
    end if;
    select pk.content into v_mbr from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = p_batch;
    return coalesce(
      exists (select 1 from recipe.execution_event e
               where e.batch_id = p_batch and e.row_seq = p_seq and e.event_type = 'EXCEPTION_RAISED'
                 and e.event ->> 'exception' = v_key and e.event ->> 'exceptionType' = x ->> 'type')
      and v_ct = recipe.exception_content_of(v_mbr, p_state, x),
      false);
  end if;
  if p_c ->> 'type' = 'batch_step' then
    x := p_state -> 'steps' -> v_key;
    if jsonb_typeof(x) is distinct from 'object' or x ->> 'kind' is distinct from 'HOLD' or coalesce(x ->> 'status', '') not in ('ENABLED', 'NOT_APPLICABLE')
       or x ?| array['disposition', 'startedAt', 'endedAt'] then
      return false;
    end if;
    foreach f in array array['performers', 'dataEnterers', 'correctors', 'performedSigners', 'signatures'] loop
      if coalesce(x -> f, '[]'::jsonb) is distinct from '[]'::jsonb then
        return false;
      end if;
    end loop;
    select pk.content into v_mbr from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = p_batch;
    return coalesce(
      v_ct = recipe.hold_point_content_of(v_mbr, p_state, v_key)
      and exists (select 1 from recipe.execution_event e
                   where e.batch_id = p_batch and e.row_seq = p_seq and e.event_type = 'STEP_STATUS_CHANGED'
                     and e.event ->> 'stepKey' = v_key and e.event ->> 'from' = 'PENDING' and e.event ->> 'by' = 'SYSTEM'),
      false);
  end if;
  return false;
end
$$;

-- As 0452_change_path_guards.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_change_path_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
  v_code    text := '178';
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
  v_problem := recipe.change_path_problem(old.state, new.state, r.kind, r.command, r.accepted, r.actor_person::text, v_content);
  if v_problem is not null then
    if v_problem ~ '^\[1[0-9]{2}\] ' then
      v_code := substr(v_problem, 2, 3);
      v_problem := substr(v_problem, 7);
    end if;
    raise exception using errcode = 'P0001',
      message = format('This %s %s row cannot be recorded: it %s. A skip, a void, an invalidation, a correction from fail to pass, an abort and a cancellation are recorded only on the conditions the engine sets, and nothing else aborts, cancels or revives a batch',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem)
                || case v_code
                     when '172' then ' (PR-13, DI-07, DI-34). [EBMR-EXE-172]'
                     when '173' then ' (DI-24, DI-29). [EBMR-EXE-173]'
                     when '174' then ' (DI-29, INV-41). [EBMR-EXE-174]'
                     when '175' then ' (INV-41, PR-12, DI-24). [EBMR-EXE-175]'
                     when '176' then ' (DI-34, DI-35). [EBMR-EXE-176]'
                     when '177' then ' (PR-10, DI-34). [EBMR-EXE-177]'
                     else ' (DI-34, DI-24). [EBMR-EXE-178]'
                   end;
  end if;
  return null;
end
$$;

-- As 0317_container_entry_binding.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_container_entry_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
begin
  if not exists (select 1
                   from jsonb_object_keys(case when jsonb_typeof(new.state -> 'containers') = 'object' then new.state -> 'containers' else '{}'::jsonb end) k
                  where not coalesce((old.state -> 'containers') ? k, false)) then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
  v_problem := recipe.new_container_problem(v_content, old.state, new.state, r.kind, r.accepted, r.command);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: a container is registered by the entry that names it, in a block that registers containers (DI-30, DI-05). [EBMR-EXE-126]',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

-- As 0319_stage_summary_content.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
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
  v_mbr   jsonb;
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
      -- F01 (DI-37, IN-15, PR-16): the stage's summary, which the STAGE_SIGNED_OFF meaning confirms, is part of the
      -- signed text: the summary a sign-off would record now, derived here from the stored state and the batch's MBR,
      -- and once validly signed the one the sign-off recorded (header item 3). A sign-off made before this migration
      -- keeps the text it was signed on (header item 2). NULL when it cannot be derived: nothing then matches it.
      if not exists (select 1 from recipe.execution_stage_summary_legacy l
                      where l.aggregate_id = p_id and l.signature_id = x -> 'signOff' ->> 'signature'
                        and x -> 'signOff' -> 'valid' = 'true'::jsonb) then
        v_mbr := recipe.execution_mbr_content(b.package_hash, b.control_recipe_id);
        v_row.content := v_row.content || jsonb_build_object('summary', recipe.stage_summary_content(v_mbr, st, v_key));
      end if;
    when 'batch_exception' then
      x := st -> 'exceptions' -> v_key;
      v_state := x ->> 'status';
      -- The raiser and the person who linked the deviation, and (F11; INV-03, PR-13, PR-49) everyone involved in the
      -- step the exception was raised at, as the stored step lists name them and (round 2) as the accepted commands
      -- recorded on that step name them: the kernel never lets them sign its disposition (EBMR-ESIG-044). Round 3: the
      -- raising step is also the step the command of the row that raised the exception acts on (header item 2).
      v_by := recipe.person_ids(jsonb_build_array(x ->> 'raisedBy', x -> 'deviation' ->> 'linkedBy')
                                || recipe.exception_step_involvement(v_batch, st, v_key, null));
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

-- As 0338_row_context_and_content_versions.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_content_version_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_type    text := case tg_table_name when 'execution_step_content' then 'batch_step' when 'execution_stage_content' then 'batch_stage'
                                       when 'execution_exception_content' then 'batch_exception' when 'execution_point_content' then 'batch_point' end;
  v_state   jsonb;
  v_mbr     jsonb;
  v_problem text;
begin
  select s.state into v_state from recipe.execution_state s where s.batch_id = new.batch_id and s.last_seq = new.row_seq;
  select pk.content into v_mbr from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
  v_problem := case when v_state is null then 'it is not stored by the row the batch''s state was last written by'
                    else recipe.content_version_problem(v_type, new.aggregate_key, new.content, v_state, v_mbr) end;
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('Content %s:%s of row %s cannot be recorded: %s. A content version is the content of a step instance, stage frame, exception or data point of the state its row produced, with exactly the members of its kind''s content, so nothing sits in the record unread (DI-05, DI-30, DI-37). [EBMR-EXE-126]',
                       v_type, left(new.aggregate_key, 128), new.row_seq, v_problem);
  end if;
  return new;
end
$$;

-- As 0330_entry_block_data.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_entry_block_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if not exists (select 1
                   from jsonb_object_keys(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) k
                  where not coalesce((old.state -> 'entries') ? k, false))
     and (r.command ->> 'type') is distinct from 'START_STEP' then
    return null;
  end if;
  select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
  v_problem := recipe.entry_block_problem(v_content, old.state, new.state, r.command);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: an entry holds exactly what its block builds from what was entered, the batch''s MBR, the batch, its step, its person and the time, and only what the block accepts (DI-05, DI-10, DI-30, PR-14, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47). [EBMR-EXE-126]',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

-- As 0328_entry_mbr_references.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_entry_references_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
begin
  if not exists (select 1
                   from jsonb_object_keys(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) k
                  where not coalesce((old.state -> 'entries') ? k, false))
     and not exists (select 1
                       from jsonb_each(case when jsonb_typeof(new.state -> 'containers') = 'object' then new.state -> 'containers' else '{}'::jsonb end) x
                      where x.value ->> 'status' = 'CONSUMED' and (old.state -> 'containers' -> x.key ->> 'status') is distinct from 'CONSUMED') then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
  v_problem := recipe.entry_reference_problem(v_content, old.state, new.state, r.command);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: an entry names only what its step''s node in the batch''s MBR names (the BOM lines it dispenses or charges, the intermediates it produces or uses, the equipment it checks), so the record never holds what the MBR does not give it (DI-05, DI-30, PR-18, PR-21, PR-23). [EBMR-EXE-126]',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

-- As 0332_entry_block_schema.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_entry_schema_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_command jsonb;
  v_content jsonb;
  v_problem text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_command := case when r.kind = 'COMMAND' then r.command end;
  if not exists (select 1
                   from jsonb_object_keys(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) k
                  where not coalesce((old.state -> 'entries') ? k, false))
     and (v_command ->> 'type') is distinct from 'RECORD_ENTRY' and (v_command ->> 'type') is distinct from 'START_STEP' then
    return null;
  end if;
  select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
  v_problem := recipe.entry_schema_problem(v_content, old.state, new.state, v_command, r.accepted is true);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: an entry and a step''s start data meet the data schema of the step''s block version and are of a kind it records, as the engine checks them before the block accepts them (DI-05, DI-30, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47). [EBMR-EXE-126]',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

-- As 0327_exception_source_step.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_exception_source_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_old     jsonb := case when tg_op = 'UPDATE' then old.state else '{}'::jsonb end;
  v_content jsonb;
  v_problem text;
begin
  if not exists (select 1
                   from jsonb_object_keys(case when jsonb_typeof(new.state -> 'exceptions') = 'object' then new.state -> 'exceptions' else '{}'::jsonb end) k
                  where not coalesce((v_old -> 'exceptions') ? k, false)) then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
  v_problem := recipe.exception_source_problem(v_content, v_old, new.state, r.kind, r.accepted, r.command);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: an exception is recorded at the step instance the engine raises it at, the step its row acts on or, for what a correction or an invalidation recomputes, a step the changed value feeds, so the persons involved in that step stay excluded from its disposition (INV-03, PR-13, PR-49, DI-26). [EBMR-EXE-044]',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

-- As 0337_issue_request_accept_rules.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_issue_request_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_content jsonb;
  v_problem text;
begin
  v_content := recipe.execution_mbr_content(new.package_hash, new.control_recipe_id);
  v_problem := recipe.issue_request_problem(v_content, new.issue_request);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The issue request of test batch %s cannot be recorded: %s. A batch is issued only with a request its MBR accepts, as the engine checks it at issue, so nothing sits in the record unread (DI-05, DI-10, DI-34). [EBMR-EXE-126]',
                       new.batch_number, v_problem);
  end if;
  return new;
end
$$;

-- As 0333_late_witness_review.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_late_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_old     jsonb := case when tg_op = 'UPDATE' then old.state else '{}'::jsonb end;
  v_content jsonb;
  v_policy  jsonb;
  v_want    jsonb;
  v_row     text;
  v_n       integer := 0;
  k         text;
  x         jsonb;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if r.kind = 'COMMAND' and r.accepted is true and r.command_type = 'VERIFY' then
    select pk.content, b.policy into v_content, v_policy
      from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
    v_want := recipe.late_check_record(v_content, v_policy, v_old, r.command,
                                       greatest(r.now_us, coalesce(recipe.micros_of(v_old -> 'lastRecordedUs'), r.now_us)));
  end if;
  v_row := format('%s %s', case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                  coalesce(r.command_type, r.kind, 'unknown'));
  for k, x in select e.key, e.value
                from jsonb_each(case when jsonb_typeof(new.state -> 'exceptions') = 'object' then new.state -> 'exceptions' else '{}'::jsonb end) e
               where not coalesce((v_old -> 'exceptions') ? e.key, false) and e.value ->> 'type' = 'WITNESS_LATE'
               order by e.key
  loop
    v_n := v_n + 1;
    if v_want is null or v_n > 1 then
      raise exception using errcode = 'P0001',
        message = format('This %s row adds exception %s of type WITNESS_LATE, which only the later review of a step whose witness is no longer possible raises, once: a witness window that has passed or a run that moved on is the record''s to say, not the writer''s (DI-35, DI-30, PR-14). [EBMR-EXE-141]',
                         v_row, k);
    end if;
    if jsonb_typeof(x) is distinct from 'object' or (x - 'raisedAt' - 'raisedSeq') is distinct from (v_want || jsonb_build_object('id', k)) then
      raise exception using errcode = 'P0001',
        message = format('This %s row records exception %s otherwise than the later review of step %s raises it: its type, title, QA-only and other flags, source and raiser follow from the step, the time and the review (DI-35, DI-30, PR-14). [EBMR-EXE-141]',
                         v_row, k, v_want -> 'source' ->> 'stepKey');
    end if;
  end loop;
  if v_want is not null and v_n = 0 then
    raise exception using errcode = 'P0001',
      message = format('This %s row checks step %s by a later review (%s) where a witness was due and is no longer possible, and records no exception for it: the review records WITNESS_LATE, which QA dispositions (DI-35, DI-30, PR-14). [EBMR-EXE-141]',
                       v_row, v_want -> 'source' ->> 'stepKey', r.command -> 'signature' ->> 'meaning');
  end if;
  return null;
end
$$;

-- As 0312_own_node_events.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_own_node_events_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  s0        jsonb := case when tg_op = 'UPDATE' then old.state else '{}'::jsonb end;
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
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

-- As 0338_row_context_and_content_versions.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_row_context_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  s0        jsonb := case when tg_op = 'UPDATE' then old.state else '{}'::jsonb end;
  v_content jsonb;
  v_problem text;
  k         text;
  x         jsonb;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if r.kind is distinct from 'PREPARE' and (r.kind is distinct from 'COMMAND' or r.accepted is not true) then
    return null;
  end if;
  select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
  v_problem := recipe.row_context_problem(v_content, new.state, r.kind, r.accepted, r.command);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row cannot be recorded: %s. A command''s context names the step instance, stage frame or decision of the state it acts on, in the frames of the batch''s MBR, and a preparation names a signed command and the step instance of the state it prepares, so nothing sits in the record unread (DI-05, DI-30). [EBMR-EXE-126]',
                       case when r.kind = 'PREPARE' then 'preparation' else 'accepted' end, coalesce(r.command_type, r.kind), v_problem);
  end if;
  -- Every value the row keys by hand (0300: only an accepted RECORD_DATA or CORRECT_ENTRY adds one) is of its parameter.
  for k, x in select e.key, e.value from jsonb_each(case when jsonb_typeof(new.state -> 'points') = 'object' then new.state -> 'points' else '{}'::jsonb end) e
               where not coalesce((s0 -> 'points') ? e.key, false) and e.value -> 'source' ->> 'mode' = 'MANUAL' and e.value ->> 'kind' = 'VALUE'
               order by e.key loop
    v_problem := recipe.point_value_problem(recipe.mbr_member(v_content -> 'parameters', x ->> 'item'), x -> 'value');
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('Data point %s of this accepted %s row cannot be recorded: %s. A value is recorded only as its parameter in the MBR takes it, as the engine accepts it, so nothing sits in the record unread (DI-05, DI-30). [EBMR-EXE-126]',
                         left(k, 64), coalesce(r.command_type, r.kind), v_problem);
    end if;
  end loop;
  return null;
end
$$;

-- As 0327_exception_source_step.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
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
  -- an INVOLVEMENT event of it. Round 3: every step the exception was raised at (recipe.exception_raising_steps: the
  -- stored source's step and the step the raising row's command acts on; round 4, sql 0327: a PREPARE or refused row
  -- that raised it too).
  for r in
    select d.batch_id as bid, d.seq, d.command ->> 'exception' as exc, d.actor_person, x.step_key
      from recipe.execution_command d
      join recipe.execution_state s on s.batch_id = d.batch_id
     cross join lateral unnest(recipe.exception_raising_steps(d.batch_id, s.state, d.command ->> 'exception')) x (step_key)
     where d.kind = 'COMMAND' and d.accepted and d.command_type = 'DISPOSITION_EXCEPTION'
       and (recipe.recorded_involvement(d.batch_id, s.state -> 'points', x.step_key, d.seq) ? d.actor_person::text
            or exists (select 1
                         from recipe.execution_command c
                         join recipe.execution_event e on e.batch_id = c.batch_id and e.row_seq = c.seq
                        where c.batch_id = d.batch_id and c.seq < d.seq and c.kind = 'COMMAND' and c.accepted
                          and e.event_type = 'INVOLVEMENT' and e.event ->> 'stepKey' = x.step_key and e.event ->> 'person' = d.actor_person::text
                          and e.event ->> 'involvement' in ('STARTED', 'ENTERED_DATA', 'PERFORMED', 'CORRECTED', 'VOIDED', 'SIGNED_HOLD_POINT')))
     order by d.batch_id, d.seq, x.step_key
  loop
    batch_id := r.bid;
    problem := format('row %s: exception %s was dispositioned by %s, who was involved in step %s, which raised it (INV-03, PR-13, PR-49)',
                      r.seq, r.exc, r.actor_person, r.step_key);
    return next;
  end loop;

  -- INV-03, PR-13, PR-49 (F11, round 4): an exception of a type the engine raises at a step that names no step instance
  -- of the stored state (header item 4).
  for r in
    select s.batch_id as bid, e.key as exc, e.value ->> 'type' as typ
      from recipe.execution_state s
     cross join lateral jsonb_each(case when jsonb_typeof(s.state -> 'exceptions') = 'object' then s.state -> 'exceptions' else '{}'::jsonb end) e
     where recipe.exception_at_step(e.value ->> 'type')
       and not recipe.source_names_instance(s.state, case when jsonb_typeof(e.value -> 'source') = 'object' then e.value -> 'source' else '{}'::jsonb end)
     order by s.batch_id, e.key
  loop
    batch_id := r.bid;
    problem := format('exception %s (%s) names no step instance it was raised at, although the engine raises it at a step (INV-03, PR-13, PR-49)', r.exc, r.typ);
    return next;
  end loop;

  for r in
    select s.batch_id as bid, s.state, pk.content
      from recipe.execution_state s
      join recipe.batch_execution b on b.id = s.batch_id
      cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk
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

-- As 0300_evidence_state_binding.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_source_room_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_src     jsonb;
  v_content jsonb;
  v_problem text;
begin
  if new.kind <> 'COMMAND' or new.source not in ('UI', 'API') then
    return new;
  end if;
  if new.command_type = 'RECORD_DATA' then
    v_src := new.command -> 'source';
    if jsonb_typeof(v_src) is distinct from 'object' or v_src ->> 'mode' is distinct from 'MANUAL' then
      raise exception using errcode = 'P0001',
        message = format('A value a person records is a hand entry: the %s source is not attested by any device the database knows, so it is not recorded as objective evidence (DI-30, DI-32). [EBMR-EXE-121]',
                         coalesce(v_src ->> 'mode', 'missing'));
    end if;
    if v_src <> '{"mode": "MANUAL"}'::jsonb then
      raise exception using errcode = 'P0001',
        message = 'A hand entry carries no attachment hash: no attachment the database stored stands behind it, so it is not evidence of the value (DI-30, DI-32). [EBMR-EXE-122]';
    end if;
  end if;
  -- A refused row changes nothing: the engine's refusal is recorded whatever the terminal (P36, residual d).
  if new.accepted and new.command_type in ('START_STEP', 'RECORD_DATA', 'RECORD_ENTRY', 'SIGN_PERFORMED', 'VERIFY') then
    select pk.content into v_content
      from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk
     where b.id = new.batch_id;
    if jsonb_typeof(new.command -> 'step') is distinct from 'string' or recipe.step_node(v_content, new.command ->> 'step') is null then
      raise exception using errcode = 'P0001',
        message = format('A step command is recorded only for a step of the batch''s MBR; %s (DI-20, DI-34). [EBMR-EXE-125]',
                         case when jsonb_typeof(new.command -> 'step') = 'string' then format('the MBR has no step %s', new.command ->> 'step')
                              else 'this one names no step' end);
    end if;
    v_problem := recipe.step_room_problem(v_content, new.command ->> 'step', new.room_code);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('The data of a step is accepted only from a terminal of the step''s room: %s (DI-20). [EBMR-EXE-123]', v_problem);
    end if;
  end if;
  if new.command_type = 'RECORD_ENTRY' and new.command -> 'entry' ->> 'source' = 'DEVICE'
     and not exists (select 1 from iam.device d
                      where d.code = new.command -> 'entry' ->> 'balance' and d.device_class = 'INSTRUMENT' and d.status = 'ACTIVE'
                        and new.room_code is not null and d.room_code = new.room_code) then
    raise exception using errcode = 'P0001',
      message = format('A value captured from a device is accepted only from an active instrument of the terminal''s room: %s is not an active instrument registered to %s (DI-20, DI-32). [EBMR-EXE-124]',
                       coalesce(new.command -> 'entry' ->> 'balance', 'no device'), coalesce('room ' || new.room_code, 'a terminal registered to no room'));
  end if;
  return new;
end
$$;

-- As 0320_stage_sign_off_shape.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_stage_summary_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_key     text;
  v_mbr     jsonb;
  v_signed  jsonb;
  v_rec     jsonb;
  v_frame   jsonb;
  v_now     bigint;
  v_problem text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if r.kind is distinct from 'COMMAND' or r.accepted is not true or r.command_type is distinct from 'SIGN_OFF_STAGE' then
    return null;
  end if;
  v_key := (r.command ->> 'stage') || '@' || recipe.ctx_key(r.command -> 'context');
  -- The engine's transaction time: the later of the row's database time and the last time seen before the row.
  v_now := greatest(r.now_us, coalesce(recipe.micros_of(old.state -> 'lastRecordedUs'), r.now_us));
  v_problem := recipe.stage_sign_off_shape_problem(new.state -> 'stages' -> v_key -> 'signOff', v_now, r.actor_person::text,
                                                   r.command -> 'signature' ->> 'id');
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The sign-off of stage %s is not the one the engine records: %s. A stage sign-off records its signer, signature and time and exactly the summary its signature covers (DI-37, IN-15, PR-16). [EBMR-EXE-135]',
                       v_key, v_problem);
  end if;
  select pk.content into v_mbr from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
  v_signed := recipe.stage_summary_of(v_mbr, old.state, v_key);
  v_rec := new.state -> 'stages' -> v_key -> 'signOff' -> 'summary';
  v_frame := old.state -> 'stages' -> v_key;
  if v_signed is null or recipe.canonical_stage_summary(v_rec) is distinct from v_signed
     or v_rec -> 'stage' is distinct from v_frame -> 'stage' or v_rec -> 'startedAt' is distinct from v_frame -> 'startedAt' then
    raise exception using errcode = 'P0001',
      message = format('The sign-off of stage %s records the summary %s, but the summary of the stage as signed is %s: a stage sign-off records the summary its signature covers, derived from the record (DI-37, IN-15, PR-16). [EBMR-EXE-135]',
                       v_key, coalesce(recipe.canonical_stage_summary(v_rec)::text, coalesce(v_rec::text, 'none')), coalesce(v_signed::text, 'none (it cannot be derived)'));
  end if;
  return null;
end
$$;

-- As 0463_hand_over_guards.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_state_binding_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  s0        jsonb := old.state;
  s1        jsonb := new.state;
  r         recipe.execution_command;
  v_cmd     jsonb;
  v_type    text;
  v_key     text;
  v_done    boolean;
  v_content jsonb;
  v_param   jsonb;
  v_n       bigint;
  v_manual  integer := 0;
  v_point   jsonb;
  v_entries integer := 0;
  v_status  text[];
  v_fields  text[] := array['source', 'balance', 'gross', 'tare', 'unit'];
  v_problem text;
  k         text;
  x         jsonb;
  y         jsonb;
  m         text;
  f         text;
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if r.seq is null then
    raise exception using errcode = 'P0001', message = format('The state of batch %s names row %s, which does not exist (DI-34). [EBMR-EXE-030]', new.batch_id, new.last_seq);
  end if;
  if r.kind not in ('COMMAND', 'PREPARE') or r.source not in ('UI', 'API') then
    return null;
  end if;
  foreach m in array array['steps', 'points', 'entries'] loop
    if jsonb_typeof(s0 -> m) is distinct from 'object' or jsonb_typeof(s1 -> m) is distinct from 'object' then
      raise exception using errcode = 'P0001', message = format('The %s of the engine state are malformed (DI-34). [EBMR-EXE-030]', m);
    end if;
  end loop;
  v_cmd := case when r.kind = 'PREPARE' then r.command -> 'target' else r.command end;
  v_type := v_cmd ->> 'type';
  v_done := r.kind = 'COMMAND' and r.accepted;
  -- A skip, a void, a hand-over and a take-over act on the step instance they name, like the step commands (0453, 0463).
  v_key := coalesce(recipe.row_step_key(r.kind, r.command),
                    case when v_done and v_type in ('REQUEST_SKIP', 'VOID_ATTEMPT', 'HAND_OVER_STEP', 'TAKE_OVER_STEP') and jsonb_typeof(v_cmd -> 'step') = 'string'
                         then (v_cmd ->> 'step') || '@' || recipe.ctx_key(coalesce(v_cmd -> 'context', '[]'::jsonb)) end);

  -- EBMR-EXE-126: every new data point is what the row records.
  for k, x in select key, value from jsonb_each(s1 -> 'points') where not ((s0 -> 'points') ? key) order by key loop
    m := x -> 'source' ->> 'mode';
    if m = 'MANUAL' and v_done and v_type = 'VOID_ATTEMPT' and x ->> 'kind' = 'ABORTED' and x ->> 'stepKey' = v_key
       and x ->> 'enteredBy' = r.actor_person::text then
      -- The voided attempt of an accepted void, in its own step and in its person's name: no value (0452 holds the rest).
      continue;
    elsif m = 'MANUAL' then
      if not (v_done and v_type in ('RECORD_DATA', 'CORRECT_ENTRY')) then
        raise exception using errcode = 'P0001',
          message = format('Data point %s is a hand entry that this %s %s row does not key: a value keyed by hand is recorded only by the accepted RECORD_DATA (or correction) that carries it (DI-30, DI-32). [EBMR-EXE-126]',
                           k, case when r.accepted then 'accepted' else 'refused' end, coalesce(v_type, r.kind));
      end if;
      v_manual := v_manual + 1;
      v_point := x;
    elsif m = 'BLOCK' then
      if v_type is distinct from 'SIGN_PERFORMED' or x ->> 'stepKey' is distinct from v_key then
        raise exception using errcode = 'P0001',
          message = format('Data point %s is computed by the block of step %s, which is not the step this %s row signs as performed; a block computes its values when its own step is signed performed (DI-33, INV-25). [EBMR-EXE-126]',
                           k, coalesce(x ->> 'stepKey', '(none)'), coalesce(v_type, r.kind));
      end if;
    else
      raise exception using errcode = 'P0001',
        message = format('Data point %s is recorded with a %s source, which no device, scan or system attests for a person''s row in this release: a value a person records is a hand entry (DI-30, DI-32). [EBMR-EXE-126]',
                         k, coalesce(m, 'missing'));
    end if;
  end loop;

  -- EBMR-EXE-126, EBMR-EXE-127: the accepted RECORD_DATA stores exactly the value it keys, with the hand-entry rules.
  if v_done and v_type = 'RECORD_DATA' then
    if v_manual <> 1 then
      raise exception using errcode = 'P0001',
        message = format('The RECORD_DATA of %s stores %s hand-entered values; it stores exactly the one it keys (DI-30, DI-32). [EBMR-EXE-126]', coalesce(v_cmd ->> 'item', '(no item)'), v_manual);
    end if;
    if v_point ->> 'item' is distinct from v_cmd ->> 'item' or v_point ->> 'stepKey' is distinct from v_key
       or v_point -> 'source' is distinct from v_cmd -> 'source' or v_point -> 'value' is distinct from v_cmd -> 'value'
       or v_point ->> 'enteredBy' is distinct from r.actor_person::text or v_point ->> 'kind' is distinct from 'VALUE' then
      raise exception using errcode = 'P0001',
        message = format('The value the state stores for %s is not the one the RECORD_DATA keys: its item, step, value, source or person differ (DI-30, DI-32, DI-14). [EBMR-EXE-126]', coalesce(v_cmd ->> 'item', '(no item)'));
    end if;
    select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
    select count(*), (array_agg(p))[1] into v_n, v_param
      from jsonb_array_elements(case when jsonb_typeof(v_content -> 'parameters') = 'array' then v_content -> 'parameters' else '[]'::jsonb end) p
     where p ->> 'id' = v_cmd ->> 'item';
    if v_n is distinct from 1 then
      raise exception using errcode = 'P0001',
        message = format('%s is not a parameter of the batch''s MBR, so no value of it is recorded (DI-30, DI-34). [EBMR-EXE-126]', coalesce(v_cmd ->> 'item', '(no item)'));
    end if;
    -- The engine flags a value keyed by hand for a parameter the MBR captures otherwise (data.ts storePoint).
    if coalesce(jsonb_typeof(v_point -> 'flags') = 'array' and (v_point -> 'flags') ? 'MANUAL_FALLBACK', false)
       is distinct from (coalesce(v_param ->> 'capture', 'MANUAL') <> 'MANUAL') then
      raise exception using errcode = 'P0001',
        message = format('The value of %s is keyed by hand, and the MBR captures it %s: it is flagged MANUAL_FALLBACK exactly when the MBR captures it otherwise than by hand (DI-30, PR-14). [EBMR-EXE-126]',
                         v_cmd ->> 'item', lower(coalesce(v_param ->> 'capture', 'MANUAL')));
    end if;
    if (coalesce(v_param ->> 'capture', 'MANUAL') <> 'MANUAL' or v_param ->> 'criticality' = 'CRITICAL')
       and (s1 -> 'steps' -> v_key -> 'verificationRequired') is distinct from 'true'::jsonb then
      raise exception using errcode = 'P0001',
        message = format('%s is %s and keyed by hand, so step %s needs a second person''s check before it completes; the state does not require it (DI-30, PR-14). [EBMR-EXE-127]',
                         v_cmd ->> 'item', case when v_param ->> 'criticality' = 'CRITICAL' then 'critical' else 'a manual fallback' end, v_key);
    end if;
  end if;

  -- EBMR-EXE-128, EBMR-EXE-126: a new block entry belongs to the row's own step and person, from its accepted
  -- RECORD_ENTRY (or the start data of its START_STEP), and holds the weighing facts its command sent.
  for k, x in select key, value from jsonb_each(s1 -> 'entries') where not ((s0 -> 'entries') ? key) order by key loop
    v_entries := v_entries + 1;
    if not (v_done and ((v_type = 'RECORD_ENTRY' and x ->> 'kind' = v_cmd -> 'entry' ->> 'kind') or (v_type = 'START_STEP' and x ->> 'kind' = 'START_DATA')))
       or x ->> 'stepKey' is distinct from v_key or x ->> 'enteredBy' is distinct from r.actor_person::text or v_entries > 1 then
      raise exception using errcode = 'P0001',
        message = format('Entry %s (%s of step %s) is not the entry this %s row records: an entry is recorded by the accepted RECORD_ENTRY of its own step, in the name of its person (DI-20, DI-30, DI-14). [EBMR-EXE-128]',
                         k, coalesce(x ->> 'kind', '?'), coalesce(x ->> 'stepKey', '(none)'), coalesce(v_type, r.kind));
    end if;
    -- A weighing (an entry naming its balance; blocks G-07 and G-22) keeps what was weighed on which balance, and how.
    if v_type = 'RECORD_ENTRY' and (v_cmd -> 'entry') ? 'balance' then
      foreach f in array v_fields loop
        if (v_cmd -> 'entry') ? f and (x -> 'data' -> f) is distinct from (v_cmd -> 'entry' -> f) then
          raise exception using errcode = 'P0001',
            message = format('Entry %s stores another %s than its RECORD_ENTRY sent (DI-30, DI-32). [EBMR-EXE-126]', k, f);
        end if;
      end loop;
    end if;
  end loop;
  if v_done and v_type = 'RECORD_ENTRY' and v_entries <> 1 then
    raise exception using errcode = 'P0001',
      message = format('The RECORD_ENTRY of step %s stores %s entries; it stores exactly the one it records (DI-30, DI-34). [EBMR-EXE-128]', coalesce(v_key, '(none)'), v_entries);
  end if;

  -- EBMR-EXE-128, EBMR-EXE-127: the step instances.
  for k, x in select key, value from jsonb_each(s0 -> 'steps') order by key loop
    y := s1 -> 'steps' -> k;
    if y is null then
      raise exception using errcode = 'P0001', message = format('The state no longer holds step instance %s; a step instance is never removed (DI-34). [EBMR-EXE-128]', k);
    end if;
    -- The second person, once required, stays required.
    if (x -> 'verificationRequired') = 'true'::jsonb and (y -> 'verificationRequired') is distinct from 'true'::jsonb then
      raise exception using errcode = 'P0001',
        message = format('Step %s needs a second person''s check, and this %s row clears that requirement; nothing clears it (DI-30, PR-14). [EBMR-EXE-127]', k, coalesce(v_type, r.kind));
    end if;
    if k is not distinct from v_key or y = x then
      continue;
    end if;
    if not (v_done and v_type in ('CORRECT_ENTRY', 'INVALIDATE_RESULT')) then
      v_problem := case
        when jsonb_typeof(y) is distinct from 'object' or jsonb_typeof(x) is distinct from 'object' then 'it is malformed'
        when (y - array['signatures', 'performedSigners']) is distinct from (x - array['signatures', 'performedSigners'])
          then 'its status, times, persons, targets or values change'
        when jsonb_typeof(y -> 'performedSigners') is distinct from 'array' or not ((y -> 'performedSigners') <@ coalesce(x -> 'performedSigners', '[]'::jsonb))
          then 'a PERFORMED signer is added'
        else recipe.signature_change_problem(x, y, '{}'::uuid[])
      end;
      if v_problem is not null then
        raise exception using errcode = 'P0001',
          message = format('This %s row acts on %s, yet the state changes step %s (%s): a row changes the step it acts on, and otherwise only what the system does on its own (DI-20, DI-34, INV-03). [EBMR-EXE-128]',
                           coalesce(v_type, r.kind), coalesce('step ' || v_key, 'no step'), k, v_problem);
      end if;
    end if;
  end loop;
  for k, y in select key, value from jsonb_each(s1 -> 'steps') where not ((s0 -> 'steps') ? key) order by key loop
    v_problem := recipe.new_instance_problem(k, y);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('Step instance %s is new in the state, and %s: a row brings in a step instance only as the system does, enabled or not applicable, with nobody''s involvement (DI-20, DI-34, INV-03). [EBMR-EXE-128]', k, v_problem);
    end if;
  end loop;

  -- The row's own step instance.
  if v_key is not null then
    x := s0 -> 'steps' -> v_key;
    y := s1 -> 'steps' -> v_key;
    v_status := case when not v_done then array[x ->> 'status']
                     when v_type = 'START_STEP' then array['IN_PROGRESS']
                     when v_type in ('RECORD_DATA', 'RECORD_ENTRY') then array[x ->> 'status']
                     when v_type = 'SIGN_PERFORMED' then array['IN_PROGRESS', 'AWAITING_VERIFICATION', 'COMPLETED']
                     when v_type = 'VERIFY' then array['COMPLETED']
                     when v_type = 'REQUEST_SKIP' then array['SKIPPED']
                     when v_type = 'VOID_ATTEMPT' then array[x ->> 'status']
                     when v_type = 'HAND_OVER_STEP' then array['ATTEMPT_HANDED_OVER']
                     when v_type = 'TAKE_OVER_STEP' then array['IN_PROGRESS'] end;
    if v_status is not null and not exists (select 1 from unnest(v_status) a where a is not distinct from y ->> 'status') then
      raise exception using errcode = 'P0001',
        message = format('This %s %s row leaves step %s %s; it %s (DI-34, PR-14). [EBMR-EXE-128]',
                         case when r.kind = 'PREPARE' then 'preparation' when r.accepted then 'accepted' else 'refused' end, coalesce(v_type, r.kind), v_key,
                         coalesce(y ->> 'status', 'without a status'),
                         case when not v_done then 'changes no step''s status' else format('leaves it %s', array_to_string(v_status, ' or ')) end);
    end if;
    if y is not null then
      v_problem := case
        when jsonb_typeof(y -> 'performedSigners') is distinct from 'array'
             or not ((y -> 'performedSigners') <@ (coalesce(x -> 'performedSigners', '[]'::jsonb)
                                                   || case when v_done and v_type = 'SIGN_PERFORMED' then jsonb_build_array(r.actor_person::text) else '[]'::jsonb end))
          then 'a PERFORMED signer is added that did not sign it performed in this row'
        else recipe.signature_change_problem(coalesce(x, '{}'::jsonb), y, case when v_done then r.signature_ids else '{}'::uuid[] end)
      end;
      if v_problem is not null then
        raise exception using errcode = 'P0001',
          message = format('The state of step %s after this %s row does not follow from it: %s (DI-35, INV-10, PR-14). [EBMR-EXE-128]', v_key, coalesce(v_type, r.kind), v_problem);
      end if;
    end if;
    -- A step that needs its check is not completed by its PERFORMED signature.
    if v_done and v_type = 'SIGN_PERFORMED' and y ->> 'status' = 'COMPLETED' then
      if v_content is null then
        select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
      end if;
      if (y -> 'verificationRequired') = 'true'::jsonb or jsonb_typeof(recipe.step_node(v_content, v_cmd ->> 'step') -> 'signatures' -> 'check') = 'object' then
        raise exception using errcode = 'P0001',
          message = format('Step %s needs a second person''s check, so its PERFORMED signature leaves it awaiting verification, not completed (DI-30, PR-14, INV-03). [EBMR-EXE-127]', v_key);
      end if;
    end if;
  end if;
  return null;
end
$$;

-- As 0339_state_record_names.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_state_records_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  b         recipe.batch_execution;
  v_content jsonb;
  v_problem text;
begin
  select * into b from recipe.batch_execution where id = new.batch_id;
  v_content := recipe.execution_mbr_content(b.package_hash, b.control_recipe_id);
  v_problem := recipe.state_record_problem(v_content, case when tg_op = 'UPDATE' then old.state else '{}'::jsonb end, new.state);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The state of test batch %s adds %s. A record the state brings in is named as the engine names it, in the frames of the batch''s MBR, so nothing sits in the record unread (DI-05, DI-30). [EBMR-EXE-126]',
                       b.batch_number, v_problem);
  end if;
  return null;
end
$$;

-- As 0345_start_data_and_status_equipment.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_status_equipment_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
begin
  if not exists (select 1
                   from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) x
                  where not coalesce((old.state -> 'entries') ? x.key, false) and x.value ->> 'kind' = 'EQUIPMENT_STATUS') then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
  v_problem := recipe.status_equipment_problem(v_content, old.state, new.state);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: an equipment status names equipment the MBR binds where its step runs, so the record never holds equipment the MBR does not give it (DI-05, DI-30, PR-23). [EBMR-EXE-126]',
                       case when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

-- As 0308_step_act_guards.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_step_acts_check() returns trigger
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
  select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
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

-- As 0307_step_order.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_step_order_check() returns trigger
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
      select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
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

-- As 0299_system_fact_bookkeeping.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_system_fact_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  s0        jsonb := case when tg_op = 'UPDATE' then old.state end;
  e0        jsonb := case when tg_op = 'UPDATE' then coalesce(old.state -> 'exceptions', '{}'::jsonb) else '{}'::jsonb end;
  e1        jsonb := new.state -> 'exceptions';
  n0        jsonb := case when tg_op = 'UPDATE' then coalesce(old.state -> 'nodeEvents', '{}'::jsonb) else '{}'::jsonb end;
  n1        jsonb := new.state -> 'nodeEvents';
  t0        jsonb := case when tg_op = 'UPDATE' then coalesce(old.state -> 'timeInstances', '{}'::jsonb) else '{}'::jsonb end;
  t1        jsonb := new.state -> 'timeInstances';
  st0       jsonb := case when tg_op = 'UPDATE' then coalesce(old.state -> 'steps', '{}'::jsonb) else '{}'::jsonb end;
  st1       jsonb := new.state -> 'steps';
  r         recipe.execution_command;
  k         text;
  f         text;
  x         jsonb;
  w         jsonb;
  v_raised  jsonb;
  v_content jsonb;
  v_loaded  boolean := false;
  v_problem text;
  v_clock   integer := 0;
  v_last0   bigint;
  v_last1   bigint;
  v_at      bigint;
begin
  if jsonb_typeof(e0) is distinct from 'object' or jsonb_typeof(e1) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'The exceptions of the engine state are malformed (DI-34). [EBMR-EXE-030]';
  end if;
  if jsonb_typeof(n0) is distinct from 'object' or jsonb_typeof(n1) is distinct from 'object' or jsonb_typeof(t0) is distinct from 'object'
     or jsonb_typeof(t1) is distinct from 'object' or jsonb_typeof(st0) is distinct from 'object' or jsonb_typeof(st1) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'The steps, node events or time-constraint instances of the engine state are malformed (DI-34). [EBMR-EXE-030]';
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  if r.seq is null then
    raise exception using errcode = 'P0001', message = format('The state of batch %s names row %s, which does not exist (DI-34). [EBMR-EXE-030]', new.batch_id, new.last_seq);
  end if;

  -- 1. The last time seen: the later of the previous one and the row's trusted database time.
  v_last0 := recipe.micros_of(s0 -> 'lastRecordedUs');
  v_last1 := recipe.micros_of(new.state -> 'lastRecordedUs');
  if v_last1 is distinct from greatest(r.now_us, coalesce(v_last0, r.now_us)) then
    raise exception using errcode = 'P0001',
      message = format('The state of row %s records %s as the last time seen, not the later of the previous one (%s) and the row''s trusted database time (%s): the time bookkeeping comes from the database clock (DI-27, INV-16). [EBMR-EXE-025]',
                       r.seq, coalesce(v_last1::text, 'none'), coalesce(v_last0::text, 'none'), r.now_us);
  end if;

  -- 2. Node events: never changed or removed; a new one well formed, at the row's time, and recorded by the row's act.
  for k, x in select key, value from jsonb_each(n0) loop
    if (n1 -> k) is distinct from x then
      raise exception using errcode = 'P0001',
        message = format('Row %s changes or removes node event %s; a recorded start or end is kept as recorded (DI-27, INV-20). [EBMR-EXE-026]', r.seq, k);
    end if;
  end loop;
  for k, x in select key, value from jsonb_each(n1) where not (n0 ? key) order by key loop
    if jsonb_typeof(x) is distinct from 'object' or jsonb_typeof(x -> 'node') is distinct from 'string' or coalesce(x ->> 'event', '') not in ('START', 'END')
       or jsonb_typeof(x -> 'frames') is distinct from 'array' or recipe.micros_of(x -> 'at') is null
       or (x - 'node' - 'event' - 'frames' - 'at') is distinct from '{}'::jsonb
       or exists (select 1 from jsonb_array_elements(x -> 'frames') g
                   where jsonb_typeof(g -> 'construct') is distinct from 'string' or jsonb_typeof(g -> 'index') is distinct from 'number')
       or k is distinct from (x ->> 'node') || '|' || (x ->> 'event') || '|' || recipe.ctx_key(x -> 'frames') then
      raise exception using errcode = 'P0001',
        message = format('Node event %s of row %s is malformed: a start or end names its node, event, frames and time, under the key of those (DI-34, INV-20). [EBMR-EXE-026]', k, r.seq);
    end if;
    v_at := recipe.micros_of(x -> 'at');
    if v_at is distinct from r.now_us then
      raise exception using errcode = 'P0001',
        message = format('Node event %s of row %s is recorded at %s, not at the row''s trusted database time %s: a start or end a row records is at the time the database gave it, never earlier or later (DI-27, INV-16, INV-20). [EBMR-EXE-025]',
                         k, r.seq, v_at, r.now_us);
    end if;
    if not v_loaded then
      select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
      v_loaded := true;
    end if;
    v_problem := recipe.node_event_problem(v_content, s0, new.state, r, x);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('Row %s adds node event %s that its act does not record: %s (DI-27, INV-20, DI-34). [EBMR-EXE-026]', r.seq, k, v_problem);
    end if;
  end loop;

  -- 3. Constraint instances: kept as recorded; a breach mark names the exception this row raises for it.
  for k, x in select key, value from jsonb_each(t0) loop
    w := t1 -> k;
    if jsonb_typeof(w) is distinct from 'object' or (w -> 'key') is distinct from (x -> 'key') or (w -> 'constraint') is distinct from (x -> 'constraint')
       or (w -> 'frames') is distinct from (x -> 'frames')
       or (x ? 'maxBreachException' and (w -> 'maxBreachException') is distinct from (x -> 'maxBreachException'))
       or (x ? 'minBreachException' and (w -> 'minBreachException') is distinct from (x -> 'minBreachException'))
       or ((x -> 'warned') = 'true'::jsonb and (w -> 'warned') is distinct from 'true'::jsonb)
       or ((x -> 'voided') = 'true'::jsonb and (w -> 'voided') is distinct from 'true'::jsonb) then
      raise exception using errcode = 'P0001',
        message = format('Row %s changes or removes the instance %s of a time constraint, its breach, warning or void; they are kept as recorded (DI-27, INV-20). [EBMR-EXE-026]', r.seq, k);
    end if;
  end loop;
  for k, w in select key, value from jsonb_each(t1) order by key loop
    if not (t0 ? k) and (jsonb_typeof(w) is distinct from 'object' or jsonb_typeof(w -> 'constraint') is distinct from 'string'
                         or jsonb_typeof(w -> 'frames') is distinct from 'array' or (w ->> 'key') is distinct from k
                         or k is distinct from (w ->> 'constraint') || '@' || recipe.ctx_key(w -> 'frames')) then
      raise exception using errcode = 'P0001',
        message = format('The instance %s of a time constraint that row %s adds is malformed: it names its constraint and frames under the key of those (DI-34, INV-20). [EBMR-EXE-026]', k, r.seq);
    end if;
    foreach f in array array['maxBreachException', 'minBreachException'] loop
      if w ? f and not coalesce((t0 -> k) ? f, false) then
        x := case when jsonb_typeof(w -> f) = 'string' and not (e0 ? (w ->> f)) then e1 -> (w ->> f) end;
        if not coalesce(jsonb_typeof(x) = 'object'
                        and x ->> 'type' = case f when 'maxBreachException' then 'TIME_MAX_BREACH' else 'TIME_MIN_BREACH' end
                        and (x -> 'source' -> 'constraint') = (w -> 'constraint') and (x -> 'source' -> 'frames') = (w -> 'frames'), false) then
          raise exception using errcode = 'P0001',
            message = format('Row %s marks instance %s of a time constraint as breached (%s) without raising that breach; a breach mark names the exception its row raises (INV-20, DI-26). [EBMR-EXE-026]',
                             r.seq, k, coalesce(w ->> f, 'none'));
        end if;
      end if;
    end loop;
  end loop;

  -- 4. Every step instance the row adds is told by its STEP_STATUS_CHANGED event from PENDING.
  for k in select key from jsonb_each(st1) where not (st0 ? key) order by key loop
    if not exists (select 1 from recipe.execution_event e
                    where e.batch_id = new.batch_id and e.row_seq = new.last_seq and e.event_type = 'STEP_STATUS_CHANGED'
                      and e.event ->> 'stepKey' = k and e.event ->> 'from' = 'PENDING' and e.event ->> 'by' = 'SYSTEM') then
      raise exception using errcode = 'P0001',
        message = format('Row %s adds step instance %s without its STEP_STATUS_CHANGED event from PENDING; a record and the event that tells of it cannot disagree (DI-26, DI-34). [EBMR-EXE-048]', r.seq, k);
    end if;
  end loop;

  -- 5. Every new exception (0280): its EXCEPTION_RAISED event, its raiser and, for a system fact, the engine's finding.
  if exists (select 1 from recipe.execution_event e where e.batch_id = new.batch_id and e.row_seq = new.last_seq and e.event_type = 'EXCEPTION_RAISED'
               and (jsonb_typeof(e.event -> 'exception') is distinct from 'string' or jsonb_typeof(e.event -> 'exceptionType') is distinct from 'string')) then
    raise exception using errcode = 'P0001', message = format('An EXCEPTION_RAISED event of row %s names no exception or no type (DI-26, DI-34). [EBMR-EXE-047]', r.seq);
  end if;
  select coalesce(jsonb_object_agg(q.id, q.types), '{}'::jsonb) into v_raised
    from (select e.event ->> 'exception' as id, jsonb_agg(e.event ->> 'exceptionType' order by e.idx) as types
            from recipe.execution_event e where e.batch_id = new.batch_id and e.row_seq = new.last_seq and e.event_type = 'EXCEPTION_RAISED'
           group by 1) q;
  for k in select jsonb_object_keys(v_raised) loop
    if e0 ? k or not (e1 ? k) then
      raise exception using errcode = 'P0001',
        message = format('Row %s tells that it raised exception %s, which it does not add to the state (DI-26, DI-34). [EBMR-EXE-047]', r.seq, k);
    end if;
  end loop;
  for k, x in select key, value from jsonb_each(e1) where not (e0 ? key) order by key loop
    if jsonb_typeof(x) is distinct from 'object' then
      raise exception using errcode = 'P0001', message = format('Exception %s of the engine state is malformed (DI-34). [EBMR-EXE-030]', k);
    end if;
    if coalesce(v_raised -> k, '[]'::jsonb) is distinct from jsonb_build_array(x -> 'type') then
      raise exception using errcode = 'P0001',
        message = format('Exception %s (%s) is not told by exactly one EXCEPTION_RAISED event of its type in row %s (events: %s) (DI-26, DI-34). [EBMR-EXE-047]',
                         k, coalesce(x ->> 'type', 'no type'), r.seq, coalesce(v_raised -> k, '[]'::jsonb));
    end if;
    if recipe.is_system_fact(x ->> 'type') then
      if x ->> 'raisedBy' is distinct from 'SYSTEM' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s (%s) is a finding of the system about time; it is raised by SYSTEM, not by %s, whose %s row only noticed it (DI-14, INV-03, INV-20). [EBMR-EXE-045]',
                           k, x ->> 'type', coalesce(x ->> 'raisedBy', 'nobody'), r.kind);
      end if;
    elsif r.kind = 'SWEEP' then
      raise exception using errcode = 'P0001',
        message = format('A time sweep records time findings only; exception %s (%s) is not one (INV-20, DI-14). [EBMR-EXE-045]', k, coalesce(x ->> 'type', 'no type'));
    elsif x ->> 'raisedBy' is distinct from r.actor_person::text then
      raise exception using errcode = 'P0001',
        message = format('Exception %s (%s) comes from the act of this %s row, so its raiser is the row''s person %s, not %s (DI-14, INV-03). [EBMR-EXE-045]',
                         k, coalesce(x ->> 'type', 'no type'), r.kind, coalesce(r.actor_person::text, 'unknown'), coalesce(x ->> 'raisedBy', 'nobody'));
    end if;
    if recipe.is_system_fact(x ->> 'type') then
      if x ->> 'type' = 'CLOCK_REGRESSION' then
        v_clock := v_clock + 1;
        v_problem := case
          when v_clock > 1 then 'a row notices the regression of the clock once'
          when (x -> 'source') is distinct from jsonb_build_object('frames', '[]'::jsonb) then 'it does not concern the whole batch'
          when v_last0 is null or r.now_us >= v_last0 then format('the trusted time of the row (%s) is not earlier than the last time seen (%s)', r.now_us, coalesce(v_last0::text, 'none'))
          when v_last1 is distinct from v_last0 then 'the state does not keep the last time seen'
          when (x - 'raisedSeq') is distinct from recipe.clock_regression_record(k, v_last0) or jsonb_typeof(x -> 'raisedSeq') is distinct from 'number'
            then 'it is not the record the system writes for a regression of the clock (title, facts, time of raising)'
        end;
      else
        if not v_loaded then
          select pk.content into v_content from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = new.batch_id;
          v_loaded := true;
        end if;
        v_problem := recipe.time_fact_problem(v_content, s0, new.state, r.now_us, k, x);
      end if;
      if v_problem is not null then
        raise exception using errcode = 'P0001',
          message = format('Exception %s (%s) raised by SYSTEM in this %s row is not a finding the system can have made there: %s (INV-20, DI-27, DI-14, INV-03). [EBMR-EXE-046]',
                           k, x ->> 'type', r.kind, v_problem);
      end if;
    end if;
  end loop;
  return null;
end
$$;

-- As 0323_weighing_counted_item.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_weighing_item_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_row     text;
  v_problem text;
  k         text;
  x         jsonb;
begin
  if not exists (select 1 from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) e
                  where not coalesce((old.state -> 'entries') ? e.key, false) and e.value ->> 'kind' in ('CONTAINER_WEIGHING', 'OUTPUT_CONTAINER')) then
    return null;
  end if;
  select pk.content into v_content
    from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk
   where b.id = new.batch_id;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_row := format('%s %s', case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                  coalesce(r.command_type, r.kind, 'unknown'));
  for k, x in select e.key, e.value
                from jsonb_each(new.state -> 'entries') e
               where not coalesce((old.state -> 'entries') ? e.key, false)
               order by e.key
  loop
    v_problem := recipe.weighing_item_problem(x, v_content);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('This %s row stores entry %s %s: a weighing counts into the quantity its phase records in the MBR, decided by the database, never by the entry (INV-25, PR-19). [EBMR-EXE-139]',
                         v_row, k, v_problem);
    end if;
  end loop;
  return null;
end
$$;

-- As 0322_weighing_label_and_total.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.execution_weighing_record_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_row     text;
  v_problem text;
  k         text;
  x         jsonb;
begin
  if not exists (select 1 from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) e
                  where not coalesce((old.state -> 'entries') ? e.key, false) and e.value ->> 'kind' = 'CONTAINER_WEIGHING')
     and not exists (select 1 from jsonb_each(case when jsonb_typeof(new.state -> 'points') = 'object' then new.state -> 'points' else '{}'::jsonb end) p
                      where not coalesce((old.state -> 'points') ? p.key, false) and p.value -> 'source' ->> 'mode' = 'BLOCK')
     and not exists (select 1 from jsonb_each(case when jsonb_typeof(new.state -> 'steps') = 'object' then new.state -> 'steps' else '{}'::jsonb end) s
                      where s.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED') and (old.state -> 'steps' -> s.key ->> 'status') = 'IN_PROGRESS') then
    return null;
  end if;
  select pk.content into v_content
    from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk
   where b.id = new.batch_id;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_row := format('%s %s', case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                  coalesce(r.command_type, r.kind, 'unknown'));
  for k, x in select e.key, e.value
                from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) e
               where not coalesce((old.state -> 'entries') ? e.key, false)
               order by e.key
  loop
    v_problem := recipe.weighing_label_problem(x, new.state -> 'header' ->> 'batchNumber', v_content);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('This %s row stores entry %s %s: a container''s label carries its weighing''s own net, unit, lot and container and the batch''s identity (PR-19, INV-25). [EBMR-EXE-137]',
                         v_row, k, v_problem);
    end if;
  end loop;
  v_problem := recipe.weighing_totals_problem(old.state, new.state, v_content);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s row records %s: a quantity counted from weighings is the sum of their nets, every one, at the resolution they were weighed at (INV-25, PR-19). [EBMR-EXE-138]',
                       v_row, v_problem);
  end if;
  return null;
end
$$;

-- As 0480_hand_over_review_fixes.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.hand_over_problem(p_batch uuid, p_old jsonb, p_new jsonb, p_kind text, p_accepted boolean, p_cmd jsonb, p_person text, p_seq bigint)
returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_done  boolean := p_kind = 'COMMAND' and p_accepted is true;
  v_type  text := case when p_kind = 'COMMAND' and p_accepted is true then p_cmd ->> 'type' end;
  v_key   text;
  v_pkey  text;
  v_who   jsonb;
  v_inv   jsonb;
  v_ho    jsonb;
  v_ap    jsonb;
  v_n     integer;
  h0      jsonb;
  h1      jsonb;
  hl      jsonb;
  k       text;
  x       jsonb;
  y       jsonb;
  e       jsonb;
  v_in    jsonb := p_cmd -> 'incoming' -> 'id';
  v_role  text;
  v_held  text[];
begin
  if jsonb_typeof(p_old -> 'steps') is distinct from 'object' or jsonb_typeof(p_new -> 'steps') is distinct from 'object' then
    return null; -- 0300 refuses malformed steps
  end if;
  if p_kind = 'COMMAND' and jsonb_typeof(p_cmd -> 'step') = 'string' then
    v_key := (p_cmd ->> 'step') || '@' || recipe.ctx_key(coalesce(p_cmd -> 'context', '[]'::jsonb));
  end if;
  v_who := to_jsonb(p_person);

  -- Every row: a step's hand-over record changes only by its own hand-over (one more) or take-over (marked taken over).
  for k, x in select s.key, s.value from jsonb_each(p_old -> 'steps') s order by s.key loop
    y := p_new -> 'steps' -> k;
    h0 := coalesce(x -> 'handOvers', '[]'::jsonb);
    h1 := coalesce(y -> 'handOvers', '[]'::jsonb);
    continue when h1 = h0 or y is null;
    if jsonb_typeof(h0) is distinct from 'array' or jsonb_typeof(h1) is distinct from 'array' then
      return format('stores a malformed hand-over record of step %s', k);
    end if;
    if v_type = 'HAND_OVER_STEP' and k = v_key and jsonb_array_length(h1) = jsonb_array_length(h0) + 1
       and (h1 - (jsonb_array_length(h1) - 1)) = h0 then
      continue;
    end if;
    if v_type = 'TAKE_OVER_STEP' and k = v_key and jsonb_array_length(h1) = jsonb_array_length(h0) and jsonb_array_length(h0) > 0
       and (h1 - (jsonb_array_length(h1) - 1)) = (h0 - (jsonb_array_length(h0) - 1))
       and not ((h0 -> -1) ? 'takenOverAt') and (h1 -> -1) ? 'takenOverAt' and ((h1 -> -1) - 'takenOverAt') = (h0 -> -1) then
      continue;
    end if;
    return format('changes the hand-over record of step %s; only that step''s own accepted hand-over adds one, and its take-over marks it taken over', k);
  end loop;
  for k, y in select s.key, s.value from jsonb_each(p_new -> 'steps') s where not ((p_old -> 'steps') ? s.key) order by s.key loop
    if y ? 'handOvers' then
      return format('brings in step instance %s with a hand-over record', k);
    end if;
  end loop;

  -- Every row: a STEP_HANDED_OVER exception is raised only by an accepted HAND_OVER_STEP, exactly one, at its step, by its person.
  v_n := 0;
  for k, e in select s.key, s.value from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) s
               where not coalesce((p_old -> 'exceptions') ? s.key, false) and s.value ->> 'type' = 'STEP_HANDED_OVER' order by s.key loop
    v_n := v_n + 1;
    if v_type is distinct from 'HAND_OVER_STEP' then
      return format('raises exception %s (STEP_HANDED_OVER); only an accepted hand-over raises one', k);
    end if;
    if e -> 'source' ->> 'stepKey' is distinct from v_key or e ->> 'raisedBy' is distinct from p_person then
      return format('raises exception %s (STEP_HANDED_OVER) at %s by %s; a hand-over raises it at its own step, by the supervisor who records it',
                    k, coalesce(e -> 'source' ->> 'stepKey', 'no step'), coalesce(e ->> 'raisedBy', 'nobody'));
    end if;
  end loop;
  if v_type = 'HAND_OVER_STEP' and v_n <> 1 then
    return format('raises %s STEP_HANDED_OVER exceptions; a hand-over raises exactly one, so it stands in the exception register', v_n);
  end if;

  if not v_done then
    return null;
  end if;

  -- A correction or an invalidation waits until the incoming performer has taken the step over; the outgoing performer
  -- does not correct the step they handed over (0480, review finding 4).
  if v_type in ('CORRECT_ENTRY', 'INVALIDATE_RESULT') and jsonb_typeof(p_cmd -> 'point') = 'string' then
    v_pkey := p_old -> 'points' -> (p_cmd ->> 'point') ->> 'stepKey';
    if p_old -> 'steps' -> v_pkey ->> 'status' = 'ATTEMPT_HANDED_OVER' then
      return format('changes data of step %s while it waits for the incoming performer of its hand-over', v_pkey);
    end if;
    if v_type = 'CORRECT_ENTRY' and v_pkey is not null
       and (recipe.hand_over_persons(p_batch, v_pkey, p_seq) -> 'outgoing') @> jsonb_build_array(v_who) then
      return format('is %s''s correction in step %s, which they handed over; the performer who took it over completes it', p_person, v_pkey);
    end if;
    return null;
  end if;
  if v_key is null then
    return null;
  end if;
  v_ho := recipe.hand_over_persons(p_batch, v_key, p_seq);

  -- A performer who handed the step over no longer acts in it.
  if v_type in ('RECORD_DATA', 'RECORD_ENTRY', 'SIGN_PERFORMED', 'VOID_ATTEMPT', 'START_STEP', 'RAISE_EXCEPTION') and (v_ho -> 'outgoing') @> jsonb_build_array(v_who) then
    return format('is %s''s act in step %s, which they handed over; the performer who took it over completes it', p_person, v_key);
  end if;

  -- INV-03, INV-31, PR-14: the verifier is none of the persons involved, from the rows and the hand-overs.
  if v_type = 'VERIFY' then
    if recipe.recorded_involvement(p_batch, p_old -> 'points', v_key, p_seq) @> jsonb_build_array(v_who)
       or (v_ho -> 'outgoing') @> jsonb_build_array(v_who) or (v_ho -> 'incoming') @> jsonb_build_array(v_who) or (v_ho -> 'takers') @> jsonb_build_array(v_who)
       or (v_ho -> 'approvers') @> jsonb_build_array(v_who) then
      return format('verifies step %s by %s, who performed, entered data in or corrected it, or handed it over, took it over, or signed or approved its hand-over; the verifier is always another person', v_key, p_person);
    end if;
    return null;
  end if;

  x := p_old -> 'steps' -> v_key;
  y := p_new -> 'steps' -> v_key;
  if v_type = 'TAKE_OVER_STEP' then
    if (v_ho -> 'lastIncoming') is distinct from v_who or (x -> 'handOvers' -> -1 -> 'incoming') is distinct from v_who then
      return format('takes step %s over by %s, whom its last hand-over does not name as the incoming performer', v_key, p_person);
    end if;
    if not coalesce((y -> 'performers') @> jsonb_build_array(v_who)
                    and (y -> 'performers') <@ (coalesce(x -> 'performers', '[]'::jsonb) || jsonb_build_array(v_who))
                    and (y - array['status', 'handOvers', 'performers']) = (x - array['status', 'handOvers', 'performers']), false) then
      return format('changes step %s otherwise than a take-over does (the incoming performer added to its performers, the hand-over marked taken over)', v_key);
    end if;
    return null;
  end if;
  if v_type is distinct from 'HAND_OVER_STEP' then
    return null;
  end if;

  if recipe.member_blank(p_cmd -> 'reason') then
    return 'has a blank reason';
  end if;
  v_inv := recipe.step_involvement(x) || recipe.recorded_involvement(p_batch, p_old -> 'points', v_key, p_seq) || (v_ho -> 'takers');
  if x ->> 'status' = 'ATTEMPT_HANDED_OVER' then
    -- Handed over again (0480): from the incoming performer who did not come.
    if (p_cmd -> 'outgoing') is distinct from (x -> 'handOvers' -> -1 -> 'incoming') or (p_cmd -> 'outgoing') is distinct from (v_ho -> 'lastIncoming') then
      return format('hands step %s, which waits for %s, over from %s; a step waiting for its incoming performer is handed over again from that person', v_key,
                    coalesce(x -> 'handOvers' -> -1 ->> 'incoming', 'nobody'), left(coalesce(p_cmd ->> 'outgoing', 'nobody'), 64));
    end if;
  elsif not recipe.is_person_id(p_cmd -> 'outgoing') or not (v_inv @> jsonb_build_array(p_cmd -> 'outgoing')) or (v_ho -> 'outgoing') @> jsonb_build_array(p_cmd -> 'outgoing') then
    return format('hands step %s over from %s, who is not a performer of it still on it', v_key, left(coalesce(p_cmd ->> 'outgoing', 'nobody'), 64));
  end if;
  if not recipe.is_person_id(v_in) or p_cmd -> 'incoming' ->> 'kind' is distinct from 'PERSON' or v_in = (p_cmd -> 'outgoing') or (v_ho -> 'outgoing') @> jsonb_build_array(v_in) then
    return format('hands step %s over to %s, who is not another person of this installation or handed the step over before', v_key, left(coalesce(v_in #>> '{}', 'nobody'), 64));
  end if;
  v_ap := p_cmd -> 'approval' -> 'approver' -> 'id';
  if v_who in (p_cmd -> 'outgoing', v_in) or v_ap in (p_cmd -> 'outgoing', v_in)
     or v_inv @> jsonb_build_array(v_who) or v_inv @> jsonb_build_array(v_ap) then
    return format('is signed or approved by a performer of step %s or a person its hand-over names; the supervisor and QA who approve a hand-over are neither', v_key);
  end if;
  -- 0480 (review finding 1): the incoming performer is active, can sign in, and holds the roles the command names, one
  -- of them the step's perform role; so the step never waits for a person who cannot take it over.
  v_held := recipe.person_engine_roles((v_in #>> '{}')::uuid);
  select recipe.step_node(pk.content, p_cmd ->> 'step') -> 'signatures' -> 'perform' ->> 'role' into v_role
    from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = p_batch;
  if cardinality(v_held) = 0
     or jsonb_typeof(p_cmd -> 'incoming' -> 'roles') is distinct from 'array'
     or exists (select 1 from jsonb_array_elements_text(p_cmd -> 'incoming' -> 'roles') r where not (r = any (v_held)))
     or (v_role is not null and not (v_role = any (v_held) and (p_cmd -> 'incoming' -> 'roles') ? v_role)) then
    return format('hands step %s over to %s, who is not an active person with an active account holding %s now (holds %s)', v_key, v_in #>> '{}',
                  coalesce('the step''s perform role ' || v_role, 'the roles the command names'), coalesce(nullif(array_to_string(v_held, ', '), ''), 'no engine role'));
  end if;
  hl := y -> 'handOvers' -> -1;
  if (y -> 'verificationRequired') is distinct from 'true'::jsonb
     or (y - array['status', 'handOvers', 'verificationRequired']) is distinct from (x - array['status', 'handOvers', 'verificationRequired'])
     or jsonb_typeof(hl) is distinct from 'object' or hl ? 'takenOverAt'
     or hl -> 'outgoing' is distinct from p_cmd -> 'outgoing' or hl -> 'incoming' is distinct from v_in
     or hl -> 'reason' is distinct from to_jsonb(recipe.js_trim(p_cmd ->> 'reason'))
     or hl -> 'supervisor' is distinct from v_who or hl -> 'supervisorSignature' is distinct from p_cmd -> 'signature' -> 'id'
     or hl -> 'qaApprover' is distinct from v_ap or hl -> 'qaSignature' is distinct from p_cmd -> 'approval' -> 'signature' -> 'id' then
    return format('leaves step %s otherwise than the hand-over the command records (the outgoing and incoming performers, the reason, the supervisor and QA with their signatures, the second person''s check required, nothing else changed)', v_key);
  end if;
  return null;
end
$$;

-- As 0331_proposal_read_committed.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.propose_hold_point_decision(p_batch uuid, p_step_key text, p_proposal jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := recipe.execution_actor('Proposing a hold-point decision');
  x       jsonb;
  v_node  jsonb;
  v_agg   text := p_batch::text || ':' || coalesce(p_step_key, '');
  v_ver   integer;
begin
  -- F37.R round 2 (0331): only in READ COMMITTED, as recipe.propose_disposition.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'P0001',
      message = format('A decision on hold point %s is proposed only in a READ COMMITTED transaction: under %s the proposal would read the hold point, and the signatures on it, as its snapshot saw them before it waited for a signing of the hold point, and could change the content a signature committed meanwhile covers (INV-09, DI-37, PR-45). [EBMR-EXE-084]',
                       coalesce(p_step_key, 'null'), current_setting('transaction_isolation'));
  end if;
  if jsonb_typeof(p_proposal) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_proposal)) <> 2
     or jsonb_typeof(p_proposal -> 'disposition') is distinct from 'string' or coalesce(btrim(p_proposal ->> 'disposition'), '') = ''
     or not (p_proposal ? 'comment')
     or coalesce(jsonb_typeof(p_proposal -> 'comment'), 'null') not in ('string', 'null')
     or coalesce(length(p_proposal ->> 'comment'), 0) > 2000 then
    raise exception using errcode = 'P0001',
      message = 'A proposed hold-point decision is {disposition, comment}: a disposition the hold point offers and a comment of at most 2000 characters, or null (PR-45). [EBMR-EXE-084]';
  end if;
  perform recipe.require_command_permission('DISPOSITION_HOLD_POINT', recipe.hold_point_meaning(p_proposal ->> 'disposition'));
  -- Serialised with a signing of the same batch (F37): the lock recipe.lock_execution takes, before anything is read.
  perform 1 from recipe.batch_execution where id = p_batch for update;
  -- F37.R (0329): and the record's own signing lock, as in recipe.propose_disposition.
  perform esig.aggregate_lock('batch_step', v_agg);
  select s.state -> 'steps' -> p_step_key into x from recipe.execution_state s where s.batch_id = p_batch;
  if jsonb_typeof(x) is distinct from 'object' or x ->> 'kind' is distinct from 'HOLD' then
    raise exception using errcode = 'P0001', message = format('There is no hold point %s in this test batch (PR-45). [EBMR-EXE-084]', coalesce(p_step_key, 'null'));
  end if;
  if x ? 'disposition' or x ->> 'status' is distinct from 'ENABLED' then
    raise exception using errcode = 'P0001', message = format('Hold point %s is not waiting for a decision (PR-45). [EBMR-EXE-084]', p_step_key);
  end if;
  select recipe.step_node(pk.content, x ->> 'step') into v_node
    from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = p_batch;
  if v_node ->> 'kind' is distinct from 'holdPoint'
     or not coalesce(case when jsonb_typeof(v_node -> 'dispositions') = 'array' then (v_node -> 'dispositions') ? (p_proposal ->> 'disposition') end, false) then
    raise exception using errcode = 'P0001',
      message = format('%s is not a decision hold point %s offers (PR-45). [EBMR-EXE-084]', p_proposal ->> 'disposition', p_step_key);
  end if;
  select max(content_version) into v_ver from recipe.execution_step_content where aggregate_id = v_agg;
  if v_ver is null then
    raise exception using errcode = 'P0001', message = format('Hold point %s has no signable content (DI-37). [EBMR-EXE-084]', p_step_key);
  end if;
  -- A decision is never proposed on a content version that a decision was already signed on (F37; INV-09).
  if exists (select 1 from esig.signature g
              where g.aggregate_type = 'batch_step' and g.aggregate_id = v_agg and g.content_version = v_ver
                and g.meaning_code in ('HOLD_POINT_RELEASED', 'HOLD_POINT_NOT_RELEASED')) then
    raise exception using errcode = 'P0001',
      message = format('A decision on hold point %s is already signed on content version %s; no other is proposed on it (INV-09, DI-37, PR-45). [EBMR-EXE-084]', p_step_key, v_ver);
  end if;
  insert into recipe.execution_decision_proposal (batch_id, step_key, aggregate_id, content_version, proposal,
                                                  proposed_by_person, proposed_by_account, correlation_id)
  values (p_batch, p_step_key, v_agg, v_ver, jsonb_build_object('disposition', p_proposal -> 'disposition', 'comment', p_proposal -> 'comment'),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return jsonb_build_object('content_version', v_ver, 'proposal', recipe.current_decision(v_agg, v_ver));
end
$$;

-- As 0333_late_witness_review.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.step_check_meanings(p_batch uuid, p_prior jsonb, p_cmd jsonb) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_content jsonb;
  v_policy  jsonb;
  v_node    jsonb;
  v_inst    jsonb;
  v_own     text[];
  v_marker  bigint;
  v_now     bigint;
begin
  select pk.content, b.policy into v_content, v_policy
    from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = p_batch;
  v_node := recipe.step_node(v_content, p_cmd ->> 'step');
  if v_node ->> 'kind' is distinct from 'phase' then
    return '{}';
  end if;
  v_inst := recipe.step_instance_of(p_prior, p_cmd);
  if (v_inst -> 'reverification') = 'true'::jsonb then
    return array['RE_VERIFIED_AFTER_CORRECTION'];
  end if;
  if v_node -> 'signatures' -> 'check' ->> 'meaning' = 'WITNESSED'
     or cardinality(recipe.hand_entries_without_declared_evidence(v_content, p_prior, v_inst ->> 'key')) > 0 then
    -- The trusted time of this command (recipe.execution_marker, 0210), never earlier than the state's last recorded
    -- time (engine openTx). Without a marker in this transaction the time is unknown: the witness stays due.
    select c.now_us into v_marker from recipe.execution_clock c
     where c.xact_id = pg_current_xact_id_if_assigned() and c.backend_pid = pg_backend_pid() and c.batch_id = p_batch;
    v_now := case when v_marker is not null then greatest(v_marker, coalesce(recipe.micros_of(p_prior -> 'lastRecordedUs'), v_marker)) end;
    if recipe.witness_possible(v_policy, p_prior, v_inst, v_now) then
      return array['WITNESSED'];
    end if;
  end if;
  v_own := array(select m.meaning_code from recipe.block_signature_meaning m
                  where m.block_type = v_node -> 'block' ->> 'type' and m.block_version = v_node -> 'block' ->> 'version' and m.part = 'check'
                  order by 1);
  return case when cardinality(v_own) > 0 then v_own else array['VERIFIED'] end;
end
$$;

-- As 0296_exact_step_meanings.sql; the MBR content from recipe.execution_mbr_content (the test package or the control recipe).
create or replace function recipe.step_signature_meanings(p_batch uuid, p_prior jsonb, p_cmd jsonb) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_type text := p_cmd ->> 'type';
  v_node jsonb;
  v_own  text[];
begin
  if v_type is null or v_type not in ('SIGN_PERFORMED', 'VERIFY', 'DISPOSITION_HOLD_POINT') then
    return null;
  end if;
  if v_type = 'VERIFY' then
    -- Exactly the check the step requires, as the engine asks for it (P37).
    return recipe.step_check_meanings(p_batch, p_prior, p_cmd);
  end if;
  select recipe.step_node(pk.content, p_cmd ->> 'step') into v_node
    from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = p_batch;
  if v_type = 'DISPOSITION_HOLD_POINT' then
    if v_node ->> 'kind' is distinct from 'holdPoint' or jsonb_typeof(p_cmd -> 'disposition') is distinct from 'string'
       or not coalesce(case when jsonb_typeof(v_node -> 'dispositions') = 'array' then (v_node -> 'dispositions') ? (p_cmd ->> 'disposition') end, false) then
      return '{}';
    end if;
    return array[recipe.hold_point_meaning(p_cmd ->> 'disposition')];
  end if;
  if v_node ->> 'kind' is distinct from 'phase' then
    return '{}';
  end if;
  v_own := array(select m.meaning_code from recipe.block_signature_meaning m
                  where m.block_type = v_node -> 'block' ->> 'type' and m.block_version = v_node -> 'block' ->> 'version' and m.part = 'perform'
                  order by 1);
  -- The generic PERFORMED only on a block without its own perform meaning.
  return case when cardinality(v_own) > 0 then v_own else array['PERFORMED'] end;
end
$$;

reset role;
