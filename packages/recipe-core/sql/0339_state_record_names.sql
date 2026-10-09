-- Recipe core, execution store (module C3): a record the state brings in is named as the engine names it (Phase 2 exit
-- review F12, the round-8 self-review of the round-7 verification; DI-05, DI-30; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
-- recipe-core 0338 holds what a command, a preparation and a content version name to records of the state, and 0307
-- holds a new step instance to the MBR. The other records a row brings into the state were named by the writer: the
-- engine numbers exceptions, entries, data points, computed values and holds from the state's counters (engine tx.ts
-- nextId: EX-<n>, EN-<n>, DP-<n>, DV-<n>, HOLD-<n>), keys a stage frame and a decision by its construct and frames
-- (advance.ts stageFrameKey, recordDecision) and names a sub-lot from the batch number, the replicate section's prefix
-- and its indexes (advance.ts subLotId), but nothing in the database read those names. Through the application role the
-- round-8 self-review stored, each 'ok', an accepted operator's exception, a previous-batch entry and a supervisor's hold
-- whose engine id (EX-1, EN-1, HOLD-1) was renamed L2409-0017 in the state and its event; the exception's content was
-- then stored under batch_exception:L2409-0017 (0338 reads a content key against the state's keys). The release gate's
-- replay finds such a state (its hash differs), but until then the real-format identifier sat in the record, and a
-- sub-lot is itself a lot identifier of the test batch (DI-05).
--
-- What changed (recipe.state_record_problem, run by the row trigger zzj_execution_state_records, after insert or update
-- of recipe.execution_state, every row, the issue included; EBMR-EXE-126):
--   * every exception, entry, data point, computed value and hold of the state is keyed by its own id, and each one the
--     row brings in is named <prefix>-<n> as the engine numbers it, with n above the state's counter for that prefix
--     before the row and at most its counter after it;
--   * every stage frame the row brings in is keyed by its stage and frames, its stage a stage of the MBR and its frames
--     one per loop and replicate section enclosing the stage (recipe.frames_fit, 0307);
--   * every decision the row brings in or changes is keyed by its construct and frames: a BRANCH decision of an
--     alternative of the MBR on one of its branches, a COUNT of a replicate section on a whole count, a LOOP of a loop
--     (its frames ending with the loop's own) on EXIT, CONTINUE or EXHAUSTED, in the MBR's loops and replicate sections;
--   * every sub-lot the row brings in is keyed by its replicate section and frames (the last its own, its index that
--     frame's) and named <batch number>-<prefix><indexes of the enclosing sections, each followed by a dot><index>, the
--     prefix the section's subLotPrefix (SL when it has none), as the engine names it.
-- Not read here, stated so it is not over-read: the other values of the state and the events (a decision's inputs and
-- reason, the purpose text of a used signature, the applied command ids, the token marking), which the release gate's
-- replay compares row by row (decision REPLAY-GATE.1, F12.6).
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger function is SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed
-- and never edited.

set local role ebmr_owner;

-- DI-05, DI-30 (F12, round-8 self-review): node p_id (an expanded id: library calls joined by '/', as recipe.flow_tree
-- names it) of kind p_kind in MBR content p_content; NULL when the content has no such node, once.
create function recipe.mbr_node(p_content jsonb, p_id text, p_kind text) returns jsonb
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
                            jsonb_build_object('id', v_parts[i], 'kind', case when i < array_length(v_parts, 1) then 'libraryCall' else p_kind end)) n;
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
  return v_node;
end
$$;

-- DI-05, DI-30 (F12, round-8 self-review): why the records state p_new (p_old before the row, '{}' for the issue) of a
-- batch of MBR content p_content brings in are not named as the engine names them (header); NULL when they are. The
-- text completes "The state ... adds ...".
create function recipe.state_record_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_tree   jsonb;
  m        record;
  k        text;
  x        jsonb;
  v_n      numeric;
  v_kind   text;
  v_node   jsonb;
  v_within jsonb;
  v_frames jsonb;
  v_parent jsonb;
  v_path   text;
  v_last   jsonb;
begin
  -- Numbered records: keyed by their own id; a new one numbered as the engine numbers it.
  for m in select * from (values ('exceptions', 'EX', 'exception'), ('entries', 'EN', 'entry'), ('points', 'DP', 'data point'),
                                 ('derived', 'DV', 'computed value'), ('holds', 'HOLD', 'hold')) v (map, prefix, what) loop
    for k, x in select e.key, e.value from jsonb_each(case when jsonb_typeof(p_new -> m.map) = 'object' then p_new -> m.map else '{}'::jsonb end) e
                 order by e.key collate "C" loop
      if jsonb_typeof(x) is distinct from 'object' or (x -> 'id') is distinct from to_jsonb(k) then
        return format('%s %s, which is not keyed by its own id', m.what, left(k, 64));
      end if;
      if coalesce((p_old -> m.map) ? k, false) then
        continue;
      end if;
      if k !~ ('^' || m.prefix || '-[1-9][0-9]{0,8}$') then
        return format('%s %s, which the engine numbers %s-<n>', m.what, left(k, 64), m.prefix);
      end if;
      v_n := substr(k, length(m.prefix) + 2)::numeric;
      if v_n <= coalesce(case when jsonb_typeof(p_old -> 'counters' -> m.prefix) = 'number' then (p_old -> 'counters' ->> m.prefix)::numeric end, 0)
         or v_n > coalesce(case when jsonb_typeof(p_new -> 'counters' -> m.prefix) = 'number' then (p_new -> 'counters' ->> m.prefix)::numeric end, 0) then
        return format('%s %s, which is not numbered after the %s counter before the row and within it after the row', m.what, k, m.prefix);
      end if;
    end loop;
  end loop;
  -- Stage frames.
  for k, x in select e.key, e.value from jsonb_each(case when jsonb_typeof(p_new -> 'stages') = 'object' then p_new -> 'stages' else '{}'::jsonb end) e
               where not coalesce((p_old -> 'stages') ? e.key, false) order by e.key collate "C" loop
    v_tree := coalesce(v_tree, recipe.flow_tree(p_content));
    if jsonb_typeof(x) is distinct from 'object' or jsonb_typeof(x -> 'stage') is distinct from 'string' or jsonb_typeof(x -> 'frames') is distinct from 'array'
       or (x -> 'key') is distinct from to_jsonb(k) or k is distinct from (x ->> 'stage') || '@' || recipe.ctx_key(x -> 'frames')
       or v_tree -> 'ids' -> (x ->> 'stage') ->> 'kind' is distinct from 'stage'
       or not recipe.frames_fit(recipe.flow_within(v_tree, x ->> 'stage'), x -> 'frames') then
      return format('stage frame %s, which is not a stage of the MBR keyed by its stage and its frames in the MBR''s loops and replicate sections', left(k, 64));
    end if;
  end loop;
  -- Decisions (new or changed).
  for k, x in select e.key, e.value from jsonb_each(case when jsonb_typeof(p_new -> 'decisions') = 'object' then p_new -> 'decisions' else '{}'::jsonb end) e
               where (p_old -> 'decisions' -> e.key) is distinct from e.value order by e.key collate "C" loop
    v_tree := coalesce(v_tree, recipe.flow_tree(p_content));
    v_kind := case x ->> 'kind' when 'BRANCH' then 'alternative' when 'COUNT' then 'replicate' when 'LOOP' then 'loop' end;
    v_within := recipe.flow_within(v_tree, x ->> 'construct');
    if v_kind = 'loop' then
      v_within := v_within || jsonb_build_array(x ->> 'construct');
    end if;
    if jsonb_typeof(x) is distinct from 'object' or v_kind is null or jsonb_typeof(x -> 'construct') is distinct from 'string'
       or jsonb_typeof(x -> 'frames') is distinct from 'array' or (x -> 'key') is distinct from to_jsonb(k)
       or k is distinct from (x ->> 'construct') || '@' || recipe.ctx_key(x -> 'frames')
       or v_tree -> 'ids' -> (x ->> 'construct') ->> 'kind' is distinct from v_kind or not recipe.frames_fit(v_within, x -> 'frames') then
      return format('decision %s, which is not a decision of an alternative, replicate section or loop of the MBR keyed by its construct and its frames in the MBR''s loops and replicate sections', left(k, 64));
    end if;
    if jsonb_typeof(x -> 'outcome') is distinct from 'string'
       or not (case v_kind
                 when 'alternative' then coalesce((x ->> 'outcome') = any (recipe.alternative_branches(p_content, x ->> 'construct')), false)
                 when 'replicate' then (x ->> 'outcome') ~ '^(0|[1-9][0-9]{0,8})$'
                 else (x ->> 'outcome') in ('EXIT', 'CONTINUE', 'EXHAUSTED') end) then
      return format('decision %s, whose outcome is not one its %s gives', left(k, 64), v_kind);
    end if;
  end loop;
  -- Sub-lots: keyed by section and frames, named as the engine names them.
  for k, x in select e.key, e.value from jsonb_each(case when jsonb_typeof(p_new -> 'subLots') = 'object' then p_new -> 'subLots' else '{}'::jsonb end) e
               where not coalesce((p_old -> 'subLots') ? e.key, false) order by e.key collate "C" loop
    v_tree := coalesce(v_tree, recipe.flow_tree(p_content));
    v_frames := case when jsonb_typeof(x -> 'frames') = 'array' then x -> 'frames' end;
    v_last := v_frames -> (jsonb_array_length(v_frames) - 1);
    v_node := recipe.mbr_node(p_content, x ->> 'construct', 'replicate');
    if jsonb_typeof(x) is distinct from 'object' or v_frames is null or jsonb_array_length(v_frames) = 0 or jsonb_typeof(x -> 'construct') is distinct from 'string'
       or (x -> 'key') is distinct from to_jsonb(k) or k is distinct from (x ->> 'construct') || '@' || recipe.ctx_key(v_frames)
       or v_tree -> 'ids' -> (x ->> 'construct') ->> 'kind' is distinct from 'replicate' or v_node is null
       or not recipe.frames_fit(recipe.flow_within(v_tree, x ->> 'construct') || jsonb_build_array(x ->> 'construct'), v_frames)
       or (x -> 'index') is distinct from (v_last -> 'index') then
      return format('sub-lot %s, which is not a sub-lot of a replicate section of the MBR keyed by its section and its frames', left(k, 64));
    end if;
    v_parent := v_frames - (jsonb_array_length(v_frames) - 1);
    v_path := (select string_agg(f.v ->> 'index', '.' order by f.i) from jsonb_array_elements(v_parent) with ordinality f (v, i));
    if (x -> 'id') is distinct from to_jsonb((p_new -> 'header' ->> 'batchNumber') || '-'
                                             || coalesce(case when jsonb_typeof(v_node -> 'subLotPrefix') = 'string' then v_node ->> 'subLotPrefix' end, 'SL')
                                             || coalesce(v_path || '.', '') || (v_last ->> 'index')) then
      return format('sub-lot %s, whose id is not the one the engine gives it from the batch number, the section''s prefix and its indexes', left(k, 64));
    end if;
  end loop;
  return null;
end
$$;

-- DI-05, DI-30: a record the state brings in is named as the engine names it (header). EBMR-EXE-126. Raises; returns
-- nothing.
create function recipe.execution_state_records_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  b         recipe.batch_execution;
  v_content jsonb;
  v_problem text;
begin
  select * into b from recipe.batch_execution where id = new.batch_id;
  select pk.content into v_content from recipe.test_package pk where pk.package_hash = b.package_hash;
  v_problem := recipe.state_record_problem(v_content, case when tg_op = 'UPDATE' then old.state else '{}'::jsonb end, new.state);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The state of test batch %s adds %s. A record the state brings in is named as the engine names it, in the frames of the batch''s MBR, so nothing sits in the record unread (DI-05, DI-30). [EBMR-EXE-126]',
                       b.batch_number, v_problem);
  end if;
  return null;
end
$$;

create trigger zzj_execution_state_records after insert or update on recipe.execution_state
  for each row execute function recipe.execution_state_records_check();

revoke all on function recipe.mbr_node(jsonb, text, text), recipe.state_record_problem(jsonb, jsonb, jsonb), recipe.execution_state_records_check() from public;

reset role;
