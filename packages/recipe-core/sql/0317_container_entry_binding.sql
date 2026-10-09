-- Recipe core, execution store (module C3): a container a row registers is the one its entry names, from a block that
-- registers containers (Phase 2 exit review F12, round-3 verification; DI-30, DI-05; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
-- 0303 lets an accepted RECORD_ENTRY register a new container in the state when its key is its id, it is produced by
-- the row's own step and it is in quarantine. It never compared the container with the entry the row records, nor asked
-- whether the step's block registers containers at all. The round-3 verification stored, through the application role,
-- operator1's PREVIOUS_BATCH entry on the line clearance (a test batch number) with a container L2409-0017 (a real
-- lot-number format) registered beside it, holding the API, with its CONTAINER_REGISTERED event: accepted, and the
-- record held the real identifier, which no check of an entry reads.
--
-- The engine registers a container only through a block's accepted entry (engine steps.ts recordEntry:
-- registerContainers), and two blocks do so, one container per entry (blocks generic/material.ts):
--   * G-07, a dispensing weighing (CONTAINER_WEIGHING): the container the entry names, holding its BOM line;
--   * G-22, an output weighing (OUTPUT_CONTAINER): the container the entry names or, when it names none, the id the block
--     builds, "<batch number>/<intermediate>/<frames of the step, or 0>/<n>" (n: the step instance's output entries,
--     this one included), holding its intermediate;
-- each with the entry's net quantity, produced by the step instance in its frames, in quarantine. A row trigger on
-- recipe.execution_state (zj_execution_container_entry, after update; every row) now refuses a row whose state adds a
-- container that is not exactly that record of the one entry the row adds (recipe.new_container_problem, EBMR-EXE-126,
-- the code of 0303's rules on containers): from another kind of entry or another block, under another id, beside no
-- entry or beside a second container. The identifiers themselves are the edition's rule (tablets 0390 reads every new
-- container's id as a test lot number).
--
-- The check is a pure function compared with the engine's own runs (packages/recipe-core/test/execution
-- entry-data-sql.test.ts). New functions are owned by ebmr_owner and private to the owner; the trigger function is
-- SECURITY DEFINER; every function pins its search_path with pg_temp last. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-30, DI-05 (F12, round 3): why a container that state p_new adds (not in p_old), stored by a row (kind p_kind,
-- accepted p_accepted, command p_command as recorded) of a batch of MBR content p_content, is not the one the entry the
-- row records registers (header); NULL when it is, or when the row adds none. The text completes "This <row> ...".
create function recipe.new_container_problem(p_content jsonb, p_old jsonb, p_new jsonb, p_kind text, p_accepted boolean, p_command jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_new    text[];
  v_ents   text[];
  v_key    text;
  v_frames jsonb;
  v_block  text;
  v_kind   text;
  v_id     text;
  v_n      bigint;
  v_want   jsonb;
  e        jsonb;
begin
  select coalesce(array_agg(c.key order by c.key), '{}') into v_new
    from jsonb_each(case when jsonb_typeof(p_new -> 'containers') = 'object' then p_new -> 'containers' else '{}'::jsonb end) c
   where not coalesce((p_old -> 'containers') ? c.key, false);
  if cardinality(v_new) = 0 then
    return null;
  end if;
  if p_kind is distinct from 'COMMAND' or p_accepted is not true or p_command ->> 'type' is distinct from 'RECORD_ENTRY'
     or jsonb_typeof(p_command -> 'step') is distinct from 'string' or jsonb_typeof(p_command -> 'entry') is distinct from 'object' then
    return format('adds container %s; only the accepted RECORD_ENTRY of an entry that registers it adds one', v_new[1]);
  end if;
  if cardinality(v_new) > 1 then
    return format('adds %s containers (%s); an entry registers one container', cardinality(v_new), array_to_string(v_new, ', '));
  end if;
  v_frames := case when jsonb_typeof(p_command -> 'context') = 'array' then p_command -> 'context' else '[]'::jsonb end;
  v_key := (p_command ->> 'step') || '@' || recipe.ctx_key(v_frames);
  select coalesce(array_agg(x.key order by x.key), '{}') into v_ents
    from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
   where not coalesce((p_old -> 'entries') ? x.key, false);
  if cardinality(v_ents) <> 1 then
    return format('adds container %s beside %s new entries; a container is registered by the one entry its row records', v_new[1], cardinality(v_ents));
  end if;
  e := p_new -> 'entries' -> v_ents[1];
  v_kind := e ->> 'kind';
  v_block := recipe.step_node(p_content, p_command ->> 'step') -> 'block' ->> 'type';
  if not coalesce((v_block = 'G-07' and v_kind = 'CONTAINER_WEIGHING') or (v_block = 'G-22' and v_kind = 'OUTPUT_CONTAINER'), false)
     or v_kind is distinct from p_command -> 'entry' ->> 'kind' or e ->> 'stepKey' is distinct from v_key
     or jsonb_typeof(e -> 'data') is distinct from 'object' then
    return format('adds container %s beside entry %s (%s) of step %s, whose block (%s) registers no container with such an entry',
                  v_new[1], v_ents[1], coalesce(v_kind, '?'), v_key, coalesce(v_block, 'none'));
  end if;
  -- The id: the one the entry's command names, or (an output weighing that names none) the one the block builds.
  if (p_command -> 'entry') ? 'container' then
    v_id := case when jsonb_typeof(p_command -> 'entry' -> 'container') = 'string' then p_command -> 'entry' ->> 'container' end;
  elsif v_kind = 'OUTPUT_CONTAINER' then
    select count(*) into v_n
      from jsonb_each(p_new -> 'entries') x
     where x.value ->> 'stepKey' = v_key and x.value ->> 'kind' = 'OUTPUT_CONTAINER';
    v_id := (p_new -> 'header' ->> 'batchNumber') || '/' || (e -> 'data' ->> 'intermediate') || '/'
            || coalesce(nullif(recipe.ctx_key(v_frames), ''), '0') || '/' || v_n;
  end if;
  if v_id is null or v_new[1] is distinct from v_id or (e -> 'data' ->> 'container') is distinct from v_id then
    return format('registers container %s, which is not the container its entry %s names or the block builds (%s)',
                  v_new[1], v_ents[1], coalesce(v_id, 'none'));
  end if;
  v_want := jsonb_build_object(
    'id', v_id,
    'holds', case v_kind when 'CONTAINER_WEIGHING' then e -> 'data' -> 'bomLine' else e -> 'data' -> 'intermediate' end,
    'holdsKind', case v_kind when 'CONTAINER_WEIGHING' then 'BOM_LINE' else 'INTERMEDIATE' end,
    'producedBy', v_key, 'producedIn', v_frames, 'status', 'QUARANTINE',
    'net', jsonb_build_object('value', e -> 'data' -> 'net', 'unit', e -> 'data' -> 'unit'));
  if (p_new -> 'containers' -> v_id) is distinct from v_want then
    return format('registers container %s with other facts than its entry %s gives (%s)', v_id, v_ents[1], v_want::text);
  end if;
  return null;
end
$$;

-- DI-30, DI-05 (F12, round 3): a container a row registers is the one its entry names (header). EBMR-EXE-126.
-- Raises; returns nothing.
create function recipe.execution_container_entry_check() returns trigger
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
  select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
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

create trigger zj_execution_container_entry after update on recipe.execution_state
  for each row execute function recipe.execution_container_entry_check();

revoke all on function recipe.new_container_problem(jsonb, jsonb, jsonb, text, boolean, jsonb), recipe.execution_container_entry_check() from public;

reset role;
