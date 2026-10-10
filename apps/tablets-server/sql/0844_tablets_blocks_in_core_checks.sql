-- Tablets server, Phase 3 slice 3b: two checks of recipe-core that name the generic blocks take the Tablets edition's
-- blocks as well (controls DI-05, DI-30, DI-34, PR-19, INV-25):
--   * recipe.refusal_problem (from recipe-core 0336): a refused row may record the refusal of a Tablets block, whose rule
--     codes are TB<nn>-<WORDS> (e.g. TB01-LOT-STATUS), as it records a generic block's G<nn>-<WORDS>;
--   * recipe.new_container_problem (from recipe-core 0317): a TB-01 dispensed container (CONTAINER_WEIGHING) is
--     registered by its entry exactly as a G-07 one (its id, line, net and unit; tablets 0843 binds the weighing itself).
-- Each is replaced from its latest definition with that one change; nothing else of it changes. Applied as a new
-- migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- As recipe-core 0336, with TB<nn> block rule codes beside ENG and G<nn>.
create or replace function recipe.refusal_problem(p_accepted boolean, p_refusal jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if p_accepted is true then
    return case when p_refusal is not null then 'an accepted row records no refusal' end;
  end if;
  return recipe.command_member_problem(
    '{"t": "object", "of": "the engine''s refusal", "fields": {
       "code": {"t": "text", "pattern": "^(ENG|G[0-9]{2}|TB[0-9]{2})(-[A-Z0-9]+)+$"},
       "message": {"t": "text"},
       "controls": {"t": "list", "items": {"t": "text", "pattern": "^(DI|IN|INV|PR|ST)-[0-9]{2}$"}}}}'::jsonb,
    p_refusal, 'refusal', false);
end
$$;

-- As recipe-core 0317, with TB-01 beside G-07 for a dispensed container.
create or replace function recipe.new_container_problem(p_content jsonb, p_old jsonb, p_new jsonb, p_kind text, p_accepted boolean, p_command jsonb) returns text
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
  if not coalesce((v_block in ('G-07', 'TB-01') and v_kind = 'CONTAINER_WEIGHING') or (v_block = 'G-22' and v_kind = 'OUTPUT_CONTAINER'), false)
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

reset role;
