-- Recipe core, execution store (module C3): what names a place in a test run's record names a place the record has: an
-- accepted command's context, a preparation's target, a signable content version and the engine version of a batch
-- (Phase 2 exit review F12, the round-7 verification; DI-05, DI-30, DI-37, DI-10; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
-- Correction of 0335's header and of decision F12.5, stated here because applied migrations are never edited. 0335 says
-- that, apart from free text, the state and events and the residuals it lists, nothing sits in the record unread; its
-- refusal says a row records its command "so nothing sits in the record unread". That did not hold. 0335 holds a frame's
-- construct and a preparation's target step and context only to their JSON types, nothing held a batch's engine version,
-- and a signable content version was checked only against its own hash. Through the application role the round-7 verification
-- stored the real-format lot number L2409-0017 in a test run's record, each 'ok', with an identical replay and no
-- violation reported:
--   1. as the construct of the context of an accepted RAISE_EXCEPTION without a step: the engine (batch.ts
--      raiseException) copies such a context into the exception's source without reading it, so it sat in the command,
--      in the state and in the exception's content;
--   2. as the step, or a frame, of a preparation's target (SIGN_PERFORMED, and VERIFY by a verifier): the engine reads a
--      target's step only for SIGN_PERFORMED (engine.ts finalisePhase) and swallows the refusal of a step it does not
--      know, and the server prepares only for step instances of the state;
--   3. in signable content: a version of an exception's content holding lotNumber, superseded in the next row by the
--      honest version (recipe.insert_contents checks a version only against its own hash, and the release gate's replay
--      compared only the latest version of each record), and a version under a key of its own (L2409-0017@);
--   4. as the engine version of a batch (recipe.batch_execution.engine_version, a text bound by nothing; the server
--      refuses another version only when it runs the batch, EBMR-EXE-061).
-- The same hole, read for this migration in the members that name a place: an accepted RAISE_EXCEPTION at a step whose
-- context names a frame no construct of the MBR has (stored 'ok' too: 0298 builds the exception's source from that
-- context, and 0327 leaves an operator's exception out); an accepted choice or loop iteration naming a construct or a
-- branch the MBR does not have, or frames its decision records from the command itself (0303 binds the decision to the
-- command, so the frames were the writer's); a preparation for a command the server never prepares a signature for
-- (START_STEP); the state's own engine version; and a value keyed by hand of a parameter without limits (0305 reads only
-- values with limits): a decimal given as L2409-0017, as a text, or a category the parameter does not list, which the
-- engine refuses (data.ts validateValue), was stored 'ok' through the application role.
--
-- What changed (EBMR-EXE-126):
--   * recipe.row_context_problem, run by the row trigger zzh_execution_row_context (after insert or update of
--     recipe.execution_state, every row, after every earlier check of the state; it reads the row the state was written
--     by):
--       - an accepted command acting on a step (START_STEP, RECORD_DATA, RECORD_ENTRY, SIGN_PERFORMED, VERIFY,
--         REQUEST_SKIP, DISPOSITION_HOLD_POINT, VOID_ATTEMPT, a RAISE_EXCEPTION at a step) names a step instance of the
--         state it produced, step for step and frame for frame, and frames that are one per loop and replicate section
--         of the MBR enclosing that step (recipe.frames_fit, 0307); a SIGN_OFF_STAGE likewise a stage frame of the
--         state; a RAISE_EXCEPTION at no step carries no context (the server never sends one);
--       - an accepted CHOOSE_ALTERNATIVE names an alternative of the MBR and one of its branches, a
--         CHOOSE_REPLICATE_COUNT a replicate section, a COMPLETE_LOOP_ITERATION a loop (its context ending with the
--         loop's own frame), each with the decision of the state the command records under that construct and those
--         frames, in the MBR's loops and replicate sections;
--       - a preparation's target names a command the server prepares a signature for (SIGN_PERFORMED, VERIFY,
--         DISPOSITION_HOLD_POINT, SIGN_OFF_STAGE, DISPOSITION_EXCEPTION, as apps/tablets-server intents.ts
--         signedSubject builds it); for SIGN_PERFORMED a step instance of the state (a target without a context names
--         no frames), and for the others no step and no context (the server sends none; the engine reads none);
--     A refused command keeps what was sent (decision F12.5): a step key the engine did not know is the record of what
--     was refused. The same trigger holds every value the row keys by hand (a new data point of source MANUAL, which 0300
--     lets only an accepted RECORD_DATA or CORRECT_ENTRY add) to its parameter of the MBR as the engine accepts it
--     (recipe.point_value_problem, engine data.ts validateValue): its number of readings, its kind, a decimal or a count
--     written as text, a category of its list, a text that is not blank; its unit and its number of decimals are not read
--     (decision F12.5; 0305 holds the unit of a value with limits).
--   * recipe.content_version_problem, run by the row trigger ab_content_version before insert on each of the four
--     content tables (recipe.execution_step_content, _stage_content, _exception_content, _point_content): a version is
--     stored only for a step instance, stage frame, exception or data point of the state its row produced (the state
--     whose last row is the version's row), with exactly the members of its kind's content (engine signing-content.ts:
--     schema, batch and the members of each kind), its schema tag, this batch's header (batch number, batch id and MBR
--     hash of the state, the MBR's family and product), the identity of that record (a step's key, step, kind and
--     frames; a stage frame's key, stage, frames and start; an exception's id, type, severity and raiser; a data point's
--     id, item, step instance, kind and enterer) with exactly its members, and lists where the content has lists.
--   * recipe.engine_version_problem, run by the trigger af_execution_engine_version (before insert or update of
--     engine_version on recipe.batch_execution): an engine version is major.minor.patch, whole numbers (engine
--     types.ts ENGINE_VERSION; a batch issued under an earlier engine keeps its own, ADR 0010); and the trigger
--     zzi_execution_state_engine_version (after insert or update of recipe.execution_state): the state names the
--     engine version of its batch.
-- What the database does not decide, now read by the release gate's replay (correction of REPLAY-GATE.1 and F12.5; the
-- replay, recipe-core execution/verify.ts replayExecution, changes with this migration): the rest of a content version
-- (titles, numbers, the step's data, entries and exceptions as listed in it, a stage's steps). The replay compared only
-- the latest version of each record with the replayed state; it now compares every stored version with the content of
-- the replayed state at the row that stored it, and reports a version stored by a row that neither brings its record in
-- nor changes it (apart from the first version of a phase a person's accepted command works on, engine
-- touchedAggregates), so a version superseded before the replay is read too.
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger functions are SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed
-- and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- 1. A command's context and a preparation's target
-- ---------------------------------------------------------------------------------------------

-- DI-05, DI-30 (F12, round-7 verification): the branch ids of alternative p_id (an expanded id: library calls joined by
-- '/', as the engine and recipe.flow_tree name it) of MBR content p_content; NULL when the content has no such
-- alternative, once.
create function recipe.alternative_branches(p_content jsonb, p_id text) returns text[]
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_parts text[] := string_to_array(p_id, '/');
  v_scope jsonb := p_content -> 'procedure';
  v_els   jsonb := case when jsonb_typeof(p_content -> 'library') = 'array' then p_content -> 'library' else '[]'::jsonb end;
  v_node  jsonb;
  v_n     bigint;
begin
  if coalesce(array_length(v_parts, 1), 0) = 0 or jsonb_typeof(v_scope) is distinct from 'object' then
    return null;
  end if;
  for i in 1 .. array_length(v_parts, 1) loop
    select count(*), (array_agg(n))[1] into v_n, v_node
      from jsonb_path_query(v_scope, 'strict $.** ? (@.id == $id && @.kind == $kind)',
                            jsonb_build_object('id', v_parts[i], 'kind', case when i < array_length(v_parts, 1) then 'libraryCall' else 'alternative' end)) n;
    if v_n is distinct from 1 then
      return null;
    end if;
    if i < array_length(v_parts, 1) then
      select count(*), (array_agg(e -> 'body'))[1] into v_n, v_scope from jsonb_array_elements(v_els) e where e ->> 'ref' = v_node ->> 'element';
      if v_n is distinct from 1 or jsonb_typeof(v_scope) is distinct from 'object' then
        return null;
      end if;
    end if;
  end loop;
  return array(select b ->> 'id' from jsonb_array_elements(case when jsonb_typeof(v_node -> 'branches') = 'array' then v_node -> 'branches' else '[]'::jsonb end) b
                where jsonb_typeof(b -> 'id') = 'string');
end
$$;

-- DI-05, DI-30 (F12, round-7 verification): why step p_step with frames p_frames is not a step instance of state p_state
-- (that step, exactly those frames) in the loops and replicate sections of MBR content p_content that enclose the step:
-- the instance's key; NULL when it is. With no frames the MBR is not read: the instance's own frames are then none, which
-- 0307 held to the MBR when the instance appeared.
create function recipe.step_instance_problem(p_content jsonb, p_state jsonb, p_step text, p_frames jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_key  text := p_step || '@' || recipe.ctx_key(p_frames);
  v_inst jsonb := p_state -> 'steps' -> (p_step || '@' || recipe.ctx_key(p_frames));
begin
  if p_step is null or jsonb_typeof(p_frames) is distinct from 'array' or jsonb_typeof(v_inst) is distinct from 'object'
     or (v_inst -> 'step') is distinct from to_jsonb(p_step) or (v_inst -> 'frames') is distinct from p_frames
     or (jsonb_array_length(p_frames) > 0 and not recipe.frames_fit(recipe.flow_within(recipe.flow_tree(p_content), p_step), p_frames)) then
    return coalesce(v_key, '(none)');
  end if;
  return null;
end
$$;

-- DI-05, DI-30 (F12, round-7 verification): why the context of a row of kind p_kind (accepted: p_accepted) with command
-- p_command, which produced state p_state of a batch of MBR content p_content, or the target of a preparation, does not
-- name what the state and the MBR have (header); NULL when it does. Members and JSON types are 0335's to refuse; a refused
-- command is not read (decision F12.5).
create function recipe.row_context_problem(p_content jsonb, p_state jsonb, p_kind text, p_accepted boolean, p_command jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_type   text := case when jsonb_typeof(p_command) = 'object' then p_command ->> 'type' end;
  v_target jsonb;
  v_ctx    jsonb;
  v_tree   jsonb;
  v_name   text;
  v_kind   text;
  v_within jsonb;
  v_dec    jsonb;
begin
  if jsonb_typeof(p_command) is distinct from 'object' then
    return null;
  end if;
  if p_kind = 'PREPARE' then
    v_target := p_command -> 'target';
    v_type := case when jsonb_typeof(v_target) = 'object' then v_target ->> 'type' end;
    if v_type is null or v_type not in ('SIGN_PERFORMED', 'VERIFY', 'DISPOSITION_HOLD_POINT', 'SIGN_OFF_STAGE', 'DISPOSITION_EXCEPTION') then
      return format('command.target.type %s is no command the server prepares a signature for', coalesce(left(v_type, 64), '(none)'));
    end if;
    if v_type <> 'SIGN_PERFORMED' then
      if v_target ? 'step' or v_target ? 'context' then
        return format('command.target of a %s names no step and no context', v_type);
      end if;
      return null;
    end if;
    if jsonb_typeof(v_target -> 'step') is distinct from 'string' then
      return 'command.target of a SIGN_PERFORMED names the step instance it finalises';
    end if;
    v_name := recipe.step_instance_problem(p_content, p_state, v_target ->> 'step', coalesce(v_target -> 'context', '[]'::jsonb));
    if v_name is not null then
      return format('command.target names no step instance of the state (%s)', left(v_name, 128));
    end if;
    return null;
  end if;
  if p_kind is distinct from 'COMMAND' or p_accepted is not true then
    return null;
  end if;
  v_ctx := coalesce(p_command -> 'context', '[]'::jsonb);
  if v_type = 'RAISE_EXCEPTION' and not (p_command ? 'step') then
    if v_ctx is distinct from '[]'::jsonb then
      return 'command.context names frames, but a RAISE_EXCEPTION at no step carries no context';
    end if;
    return null;
  end if;
  if v_type in ('START_STEP', 'RECORD_DATA', 'RECORD_ENTRY', 'SIGN_PERFORMED', 'VERIFY', 'REQUEST_SKIP', 'DISPOSITION_HOLD_POINT', 'VOID_ATTEMPT', 'RAISE_EXCEPTION') then
    if recipe.step_instance_problem(p_content, p_state, p_command ->> 'step', v_ctx) is not null then
      return format('command.context is not the frames of a step instance %s of the state in the MBR''s loops and replicate sections', coalesce(left(p_command ->> 'step', 64), '(none)'));
    end if;
    return null;
  end if;
  if v_type = 'SIGN_OFF_STAGE' then
    v_name := p_command ->> 'stage';
    v_dec := p_state -> 'stages' -> (v_name || '@' || recipe.ctx_key(v_ctx));
    if v_name is null or jsonb_typeof(v_ctx) is distinct from 'array' or jsonb_typeof(v_dec) is distinct from 'object'
       or (v_dec -> 'stage') is distinct from to_jsonb(v_name) or (v_dec -> 'frames') is distinct from v_ctx
       or (jsonb_array_length(v_ctx) > 0 and not recipe.frames_fit(recipe.flow_within(recipe.flow_tree(p_content), v_name), v_ctx)) then
      return format('command.context is not the frames of a stage frame %s of the state in the MBR''s loops and replicate sections', coalesce(left(v_name, 64), '(none)'));
    end if;
    return null;
  end if;
  if v_type in ('CHOOSE_ALTERNATIVE', 'CHOOSE_REPLICATE_COUNT', 'COMPLETE_LOOP_ITERATION') then
    v_name := p_command ->> 'construct';
    v_kind := case v_type when 'CHOOSE_ALTERNATIVE' then 'alternative' when 'CHOOSE_REPLICATE_COUNT' then 'replicate' else 'loop' end;
    v_tree := recipe.flow_tree(p_content);
    if v_name is null or v_tree -> 'ids' -> v_name ->> 'kind' is distinct from v_kind then
      return format('command.construct %s is no %s of the MBR', coalesce(left(v_name, 64), '(none)'), v_kind);
    end if;
    if v_type = 'CHOOSE_ALTERNATIVE' and not coalesce((p_command ->> 'branch') = any (recipe.alternative_branches(p_content, v_name)), false) then
      return format('command.branch %s is no branch of alternative %s', coalesce(left(p_command ->> 'branch', 64), '(none)'), v_name);
    end if;
    v_within := recipe.flow_within(v_tree, v_name);
    if v_type = 'COMPLETE_LOOP_ITERATION' then
      v_within := v_within || jsonb_build_array(v_name);
    end if;
    v_dec := p_state -> 'decisions' -> (v_name || '@' || recipe.ctx_key(v_ctx));
    if jsonb_typeof(v_ctx) is distinct from 'array' or not recipe.frames_fit(v_within, v_ctx) or jsonb_typeof(v_dec) is distinct from 'object'
       or (v_dec -> 'construct') is distinct from to_jsonb(v_name) or (v_dec -> 'frames') is distinct from v_ctx then
      return format('command.context is not the frames of a decision of %s the state records in the MBR''s loops and replicate sections', v_name);
    end if;
    return null;
  end if;
  return null;
end
$$;

-- DI-05, DI-30 (F12, round-8 self-review): why value p_value of a data point keyed by hand (as the state stores it) is
-- not one that parameter p_param of the MBR takes, as the engine accepts it (engine data.ts validateValue: its number of
-- readings, its kind, a decimal or a count written as text, a category of its list, a text that is not blank); NULL when
-- it is. Its unit and its number of decimals are not read here (decision F12.5; 0305 reads the unit of a value with
-- limits).
create function recipe.point_value_problem(p_param jsonb, p_value jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  dec    constant text := '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$';
  v_kind text := case when jsonb_typeof(p_value) = 'object' then p_value ->> 'kind' end;
  v_r    numeric := case when jsonb_typeof(p_param -> 'readings') = 'number' then (p_param ->> 'readings')::numeric else 1 end;
begin
  if jsonb_typeof(p_param) is distinct from 'object' then
    return 'its item is no parameter of the MBR';
  end if;
  if v_r > 1 then
    if v_kind is distinct from 'SERIES' or jsonb_typeof(p_value -> 'values') is distinct from 'array' or jsonb_array_length(p_value -> 'values') <> v_r
       or exists (select 1 from jsonb_array_elements(p_value -> 'values') x
                   where jsonb_typeof(x) is distinct from 'string' or (x #>> '{}') !~ dec or (x #>> '{}') ~ '^-0(\.0+)?$') then
      return format('its parameter %s is captured as %s readings, each a decimal written as text (ENG-VALUE-TYPE)', p_param ->> 'id', v_r);
    end if;
    return null;
  end if;
  case p_param ->> 'valueType'
    when 'DECIMAL' then
      if v_kind is distinct from 'DECIMAL' or jsonb_typeof(p_value -> 'value') is distinct from 'string'
         or (p_value ->> 'value') !~ dec or (p_value ->> 'value') ~ '^-0(\.0+)?$' then
        return format('its parameter %s takes a decimal written as text, with a unit (ENG-VALUE-TYPE, ENG-VALUE-FORMAT)', p_param ->> 'id');
      end if;
    when 'COUNT' then
      if v_kind is distinct from 'COUNT' or jsonb_typeof(p_value -> 'value') is distinct from 'string' or (p_value ->> 'value') !~ '^(0|[1-9][0-9]*)$' then
        return format('its parameter %s takes a whole count, 0 or more (ENG-VALUE-TYPE)', p_param ->> 'id');
      end if;
    when 'BOOLEAN' then
      if v_kind is distinct from 'BOOLEAN' then
        return format('its parameter %s takes yes or no (ENG-VALUE-TYPE)', p_param ->> 'id');
      end if;
    when 'CATEGORY' then
      if v_kind is distinct from 'CATEGORY' or jsonb_typeof(p_value -> 'value') is distinct from 'string'
         or not coalesce(jsonb_typeof(p_param -> 'categories') = 'array' and (p_param -> 'categories') @> jsonb_build_array(p_value -> 'value'), false) then
        return format('its parameter %s takes one of its categories (ENG-VALUE-TYPE)', p_param ->> 'id');
      end if;
    when 'TEXT' then
      if v_kind is distinct from 'TEXT' or coalesce(recipe.js_trim(p_value ->> 'value'), '') = '' then
        return format('its parameter %s takes a text that is not blank (ENG-VALUE-TYPE)', p_param ->> 'id');
      end if;
    when 'INSTANT' then
      if v_kind is distinct from 'INSTANT' then
        return format('its parameter %s takes a date and time (ENG-VALUE-TYPE)', p_param ->> 'id');
      end if;
    else
      return format('its parameter %s declares no value type the database reads', p_param ->> 'id');
  end case;
  return null;
end
$$;

-- DI-05, DI-30: an accepted command's context and a preparation's target name what the state and the MBR have (header).
-- EBMR-EXE-126. Raises; returns nothing.
create function recipe.execution_row_context_check() returns trigger
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
  select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
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

create trigger zzh_execution_row_context after insert or update on recipe.execution_state
  for each row execute function recipe.execution_row_context_check();

-- ---------------------------------------------------------------------------------------------
-- 2. Signable content versions
-- ---------------------------------------------------------------------------------------------

-- DI-05, DI-30, DI-37: why object p_value at path p_path does not have exactly members p_members (p_of: what it is); NULL
-- when it has.
create function recipe.content_members_problem(p_value jsonb, p_members text[], p_path text, p_of text) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  k text;
begin
  if jsonb_typeof(p_value) is distinct from 'object' then
    return p_path || ' must be an object';
  end if;
  select min(x collate "C") into k from jsonb_object_keys(p_value) x where not (x = any (p_members));
  if k is not null then
    return format('%s.%s is a member %s does not have', p_path, k, p_of);
  end if;
  select min(m collate "C") into k from unnest(p_members) m where not (p_value ? m);
  if k is not null then
    return format('%s.%s is missing', p_path, k);
  end if;
  return null;
end
$$;

-- DI-05, DI-30, DI-37 (F12, round-7 verification): why content p_content is not a content version of aggregate p_type
-- p_key that state p_state of a batch of MBR content p_mbr can have (header); NULL when it can. The rest of the content
-- is the replay's to compare (recipe-core execution/verify.ts). Frames as a content shows them: recipe.content_frames
-- (0299).
create function recipe.content_version_problem(p_type text, p_key text, p_content jsonb, p_state jsonb, p_mbr jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_rec     jsonb;
  v_what    text;
  v_of      text;
  v_members text[];
  v_id      text;
  v_idm     text[];
  v_lists   text[];
  v_same    boolean;
  v_fields  text;
  v_problem text;
  k         text;
begin
  case p_type
    when 'batch_step' then
      v_rec := p_state -> 'steps' -> p_key; v_what := 'step instance'; v_of := 'the content of a step instance';
      v_members := array['schema', 'batch', 'step', 'instruction', 'points', 'derived', 'entries', 'exceptions'];
      v_id := 'step'; v_idm := array['key', 'id', 'kind', 'number', 'title', 'stage', 'block', 'frames'];
      v_lists := array['points', 'derived', 'entries', 'exceptions'];
    when 'batch_stage' then
      v_rec := p_state -> 'stages' -> p_key; v_what := 'stage frame'; v_of := 'the content of a stage frame';
      v_members := array['schema', 'batch', 'stage', 'steps'];
      v_id := 'stage'; v_idm := array['key', 'id', 'name', 'number', 'frames', 'startedAt'];
      v_lists := array['steps'];
    when 'batch_exception' then
      v_rec := p_state -> 'exceptions' -> p_key; v_what := 'exception'; v_of := 'the content of an exception';
      v_members := array['schema', 'batch', 'exception', 'recorded', 'deviation'];
      v_id := 'exception';
      v_idm := array['id', 'type', 'category', 'title', 'controls', 'severity', 'tier', 'requirement', 'source', 'raisedAt', 'raisedBy', 'blocks',
                     'deviationRequired', 'registrationRelevant', 'qaOnly', 'stageSignOffBlocked', 'releaseBlocking'];
      v_lists := '{}'::text[];
    when 'batch_point' then
      v_rec := p_state -> 'points' -> p_key; v_what := 'data point'; v_of := 'the content of a data point';
      v_members := array['schema', 'batch', 'point'];
      v_id := 'point';
      v_idm := array['id', 'item', 'stepKey', 'attempt', 'version', 'kind', 'value', 'source', 'enteredBy', 'recordedAt', 'occurredAt', 'timeBasis',
                     'supersedes', 'correction', 'voidReason', 'evaluation', 'failed', 'flags'];
      v_lists := '{}'::text[];
    else
      return format('%s is no signable aggregate type', coalesce(p_type, '(none)'));
  end case;
  if jsonb_typeof(v_rec) is distinct from 'object' then
    return format('the state the row produced has no %s %s', v_what, left(p_key, 128));
  end if;
  v_problem := recipe.content_members_problem(p_content, v_members, 'content', v_of);
  if v_problem is not null then
    return v_problem;
  end if;
  if (p_content -> 'schema') is distinct from to_jsonb('ebmr.' || replace(p_type, '_', '-') || '-content') then
    return format('content.schema must be %s', 'ebmr.' || replace(p_type, '_', '-') || '-content');
  end if;
  if (p_content -> 'batch') is distinct from jsonb_build_object('batchNumber', p_state -> 'header' -> 'batchNumber', 'batchId', p_state -> 'header' -> 'batchId',
                                                                'mbrHash', p_state -> 'mbrHash', 'family', p_mbr -> 'header' -> 'family',
                                                                'product', p_mbr -> 'header' -> 'product' -> 'code') then
    return 'content.batch is not the header of this batch and its MBR';
  end if;
  v_problem := recipe.content_members_problem(p_content -> v_id, v_idm, 'content.' || v_id, 'content.' || v_id);
  if v_problem is not null then
    return v_problem;
  end if;
  case p_type
    when 'batch_step' then
      v_same := (p_content -> 'step' -> 'key') = to_jsonb(p_key) and (p_content -> 'step' -> 'id') = (v_rec -> 'step')
                and (p_content -> 'step' -> 'kind') = (v_rec -> 'kind') and (p_content -> 'step' -> 'frames') = recipe.content_frames(v_rec -> 'frames');
      v_fields := 'its key, step, kind and frames';
    when 'batch_stage' then
      v_same := (p_content -> 'stage' -> 'key') = to_jsonb(p_key) and (p_content -> 'stage' -> 'id') = (v_rec -> 'stage')
                and (p_content -> 'stage' -> 'frames') = recipe.content_frames(v_rec -> 'frames')
                and (p_content -> 'stage' -> 'startedAt') = to_jsonb(v_rec -> 'startedAt' ->> '$u');
      v_fields := 'its key, stage, frames and start';
    when 'batch_exception' then
      v_same := (p_content -> 'exception' -> 'id') = to_jsonb(p_key) and (p_content -> 'exception' -> 'type') = (v_rec -> 'type')
                and (p_content -> 'exception' -> 'severity') = (v_rec -> 'severity') and (p_content -> 'exception' -> 'raisedBy') = (v_rec -> 'raisedBy');
      v_fields := 'its id, type, severity and raiser';
    else
      v_same := (p_content -> 'point' -> 'id') = to_jsonb(p_key) and (p_content -> 'point' -> 'item') = (v_rec -> 'item')
                and (p_content -> 'point' -> 'stepKey') = (v_rec -> 'stepKey') and (p_content -> 'point' -> 'kind') = (v_rec -> 'kind')
                and (p_content -> 'point' -> 'enteredBy') = (v_rec -> 'enteredBy');
      v_fields := 'its id, item, step instance, kind and enterer';
  end case;
  if v_same is not true then
    return format('content.%s is not the identity of %s %s (%s)', v_id, v_what, left(p_key, 128), v_fields);
  end if;
  select min(l collate "C") into k from unnest(v_lists) l where jsonb_typeof(p_content -> l) is distinct from 'array';
  if k is not null then
    return format('content.%s must be a list', k);
  end if;
  return null;
end
$$;

-- DI-05, DI-30, DI-37: a content version is the content of a record of the state its row produced (header). EBMR-EXE-126.
-- Raises; returns the row.
create function recipe.execution_content_version_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_type    text := case tg_table_name when 'execution_step_content' then 'batch_step' when 'execution_stage_content' then 'batch_stage'
                                       when 'execution_exception_content' then 'batch_exception' when 'execution_point_content' then 'batch_point' end;
  v_state   jsonb;
  v_mbr     jsonb;
  v_problem text;
begin
  select s.state into v_state from recipe.execution_state s where s.batch_id = new.batch_id and s.last_seq = new.row_seq;
  select pk.content into v_mbr from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
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

create trigger ab_content_version before insert on recipe.execution_step_content for each row execute function recipe.execution_content_version_check();
create trigger ab_content_version before insert on recipe.execution_stage_content for each row execute function recipe.execution_content_version_check();
create trigger ab_content_version before insert on recipe.execution_exception_content for each row execute function recipe.execution_content_version_check();
create trigger ab_content_version before insert on recipe.execution_point_content for each row execute function recipe.execution_content_version_check();

-- ---------------------------------------------------------------------------------------------
-- 3. The engine version of a batch
-- ---------------------------------------------------------------------------------------------

-- DI-05, DI-10, DI-30 (F12, round-7 verification): why p_version is not an engine version (major.minor.patch, whole
-- numbers of at most four digits, as engine types.ts ENGINE_VERSION); NULL when it is.
create function recipe.engine_version_problem(p_version text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when coalesce(p_version ~ '^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$', false) then null
              else 'an engine version is major.minor.patch, whole numbers' end
$$;

-- DI-05, DI-10, DI-30: a batch names the version of an engine (header). EBMR-EXE-126. Raises; returns the row.
create function recipe.execution_engine_version_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_problem text := recipe.engine_version_problem(new.engine_version);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('Test batch %s cannot be recorded with engine version "%s": %s. A batch names the engine it runs on, so nothing sits in the record unread (DI-05, DI-10, DI-30). [EBMR-EXE-126]',
                       new.batch_number, left(new.engine_version, 64), v_problem);
  end if;
  return new;
end
$$;

create trigger af_execution_engine_version before insert or update of engine_version on recipe.batch_execution
  for each row execute function recipe.execution_engine_version_check();

-- DI-05, DI-10, DI-30: the state of a batch names the engine version of its batch (header). EBMR-EXE-126. Raises;
-- returns nothing.
create function recipe.execution_state_engine_version_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  b recipe.batch_execution;
begin
  select * into b from recipe.batch_execution where id = new.batch_id;
  if (new.state -> 'engineVersion') is distinct from to_jsonb(b.engine_version) then
    raise exception using errcode = 'P0001',
      message = format('The state of test batch %s names engine version "%s", but the batch was issued with engine %s. A batch names the engine it runs on, and its state the same, so nothing sits in the record unread (DI-05, DI-10, DI-30). [EBMR-EXE-126]',
                       b.batch_number, left(coalesce(new.state ->> 'engineVersion', '(none)'), 64), b.engine_version);
  end if;
  return null;
end
$$;

create trigger zzi_execution_state_engine_version after insert or update on recipe.execution_state
  for each row execute function recipe.execution_state_engine_version_check();

revoke all on function recipe.alternative_branches(jsonb, text), recipe.step_instance_problem(jsonb, jsonb, text, jsonb),
                       recipe.row_context_problem(jsonb, jsonb, text, boolean, jsonb), recipe.point_value_problem(jsonb, jsonb),
                       recipe.execution_row_context_check(),
                       recipe.content_members_problem(jsonb, text[], text, text),
                       recipe.content_version_problem(text, text, jsonb, jsonb, jsonb), recipe.execution_content_version_check(),
                       recipe.engine_version_problem(text), recipe.execution_engine_version_check(),
                       recipe.execution_state_engine_version_check() from public;

reset role;
