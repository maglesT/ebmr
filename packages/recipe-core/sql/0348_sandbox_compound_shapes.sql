-- Recipe core, execution store (module C3): a number in a compound is allowed in a test run's record only in the shapes
-- the engine builds (Phase 2 exit follow-up F12, the lane's round-12 verification, gap G2; DI-05, DI-30; ADR 0012: the
-- rules hold when the application's own database credentials are used directly).
--
-- What was wrong. recipe.run_word_bound (0346, 0347) allowed a compound joined by '/' when each of its parts was a word of
-- the run or any number ('^[0-9]+$'). A run of dc-mini holds ordinary words of its MBR (BATCH, D, H, QA, TABLET, MG, BAL,
-- SOP, SITE-1, DISP-1) and the ids of its records (EX-1), so over HTTP operator1's exception descriptions and
-- supervisor1's hold reason holding BATCH/2409/0017, D/2409/0017, H/24/0017, QA/2409/0017, TABLET/2409/0017,
-- SITE-1/2409/0017, MG/24/017, BAL/2409/0017, DISP-1/2409/0017, SOP/2409/0017 or EX-1/2409/0017 were recorded, and a
-- business entry the application role appended on batch:<run> held BATCH/2409/0017 in its message and three levels
-- down in its details. The kernel's rule reads each as a real batch or lot number (sandbox.real_identifiers returns it):
-- the numbers made the compound pass by their form.
--
-- What changed.
--   * recipe.run_word_bound (replaced): a compound joined by '/' passes by its parts only when every part holds a letter
--     and is a word of the run (BAL-1/BAL-2); a part of digits only never does. A compound holding a number is allowed
--     only as a whole word the run's record has from a bound source.
--   * recipe.run_bound_words (replaced) reads the batch's package, header and state and calls the new
--     recipe.content_bound_words, which gives 0346's and 0347's words and, when the value read holds a compound that is
--     not one of them as a whole:
--       - the compounds of the run's MBR and header as the identifier reading reads them (sandbox.identifier_words: an
--         id or a text of the MBR holding '/', whole), and those of the ids of its procedure with every library call
--         expanded (recipe.flow_tree: <call>/<node>);
--       - the fragments of the context keys the engine writes (flow/tokens.ts contextKey: <construct>=<index>/
--         <construct>=<index>, read by the reading as the words <index>/<construct>; recipe.frame_fragments): for each
--         loop or replicate section C of the MBR that another one, P, encloses most closely, the words <n>/<C> for n from
--         1 to P's maximum (a loop's maxIterations, a replicate section's count.max; the engine numbers no frame beyond
--         them, engine invariants.ts INV-19);
--       - the words of the compounds of its batch number its state holds (0347: a sample's id, an output container's
--         key, a sub-lot's key) as the reading reads them: an output container's key made in a loop or replicate section
--         (<batch number>/<intermediate>/<construct>=<n>/.../<n>) holds words that are not the whole key.
-- Stricter than 0347 for every compound holding a number, never weaker: the words 0348 adds are whole words of the MBR,
-- of its expanded ids and of the compounds the state holds, each of whose parts 0347 already allowed, and the context
-- fragments, which 0347 allowed for any number. Every word of the golden runs of both fixtures (replicate sections,
-- loops, a library call, output containers, samples) is bound (packages/recipe-core/test/execution/engine-names-sql.test.ts),
-- and the server's honest runs pass.
--
-- Corrections of earlier claims (applied migrations are never edited): 0346's header (item 1) lists "a compound the
-- engine builds, joined by '/': its parts each one of the above or a number", and 0347's says any other compound passes
-- "when each of its parts is a word of the run or a number"; a number was allowed there by its form alone, so decision
-- F12.9 (1)'s "none by its form alone" did not hold for numbers in a compound until this migration.
--
-- New functions are owned by ebmr_owner and private to the owner; replaced ones keep their owner and privileges (none for
-- the application roles); every function pins its search_path with pg_temp last. Applied as a new migration because
-- applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05 (header): the words <n>/<C> of the context keys of a run of MBR content p_content, for node p_node under the id
-- prefix p_prefix of the library calls it lies in (p_calls: the elements being expanded, as recipe.flow_tree expands
-- them) and p_outer, the maximum of the loop or replicate section enclosing it most closely (NULL outside every one).
-- The word is what the reading takes from '=<n>/<C>=': <n>/ and C up to its first character outside the identifier
-- alphabet, upper-cased.
create function recipe.frame_fragments_visit(p_content jsonb, p_node jsonb, p_prefix text, p_calls text[], p_outer integer) returns setof text
language plpgsql immutable set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
declare
  v_kind text := case when jsonb_typeof(p_node) = 'object' then p_node ->> 'kind' end;
  v_id   text := case when jsonb_typeof(p_node) = 'object' and jsonb_typeof(p_node -> 'id') = 'string' then p_prefix || (p_node ->> 'id') end;
  v_max  jsonb;
  v_body jsonb;
  v_els  bigint;
  c      jsonb;
begin
  if v_kind in ('loop', 'replicate') then
    if v_id is not null and p_outer is not null then
      return query select sandbox.ascii_upper(btrim(g::text || '/' || substring(v_id from '^[A-Za-z0-9/.-]*'), '/.-')) from generate_series(1, p_outer) g;
    end if;
    v_max := case when v_kind = 'loop' then p_node -> 'maxIterations' else p_node -> 'count' -> 'max' end;
    return query select * from recipe.frame_fragments_visit(p_content, p_node -> 'body', p_prefix, p_calls,
                                                            case when jsonb_typeof(v_max) = 'number' and (v_max #>> '{}') ~ '^[1-9][0-9]{0,3}$' then (v_max #>> '{}')::integer end);
  elsif v_kind in ('stage', 'operation') then
    return query select * from recipe.frame_fragments_visit(p_content, p_node -> 'body', p_prefix, p_calls, p_outer);
  elsif v_kind = 'sequence' then
    for c in select x from jsonb_array_elements(case when jsonb_typeof(p_node -> 'children') = 'array' then p_node -> 'children' else '[]'::jsonb end) x loop
      return query select * from recipe.frame_fragments_visit(p_content, c, p_prefix, p_calls, p_outer);
    end loop;
  elsif v_kind in ('parallel', 'alternative') then
    for c in select x from jsonb_array_elements(case when jsonb_typeof(p_node -> 'branches') = 'array' then p_node -> 'branches' else '[]'::jsonb end) x loop
      return query select * from recipe.frame_fragments_visit(p_content, case when jsonb_typeof(c) = 'object' then c -> 'body' end, p_prefix, p_calls, p_outer);
    end loop;
  elsif v_kind = 'libraryCall' and v_id is not null and jsonb_typeof(p_node -> 'element') = 'string' and not ((p_node ->> 'element') = any (p_calls)) then
    select count(*), (array_agg(e -> 'body'))[1] into v_els, v_body
      from jsonb_array_elements(case when jsonb_typeof(p_content -> 'library') = 'array' then p_content -> 'library' else '[]'::jsonb end) e
     where e ->> 'ref' = p_node ->> 'element';
    if v_els = 1 then
      return query select * from recipe.frame_fragments_visit(p_content, v_body, v_id || '/', p_calls || (p_node ->> 'element'), p_outer);
    end if;
  end if;
  return;
end
$$;

-- DI-05 (header): the fragments of the context keys of a run of MBR content p_content (recipe.frame_fragments_visit),
-- distinct.
create function recipe.frame_fragments(p_content jsonb) returns text[]
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(array_agg(distinct f), '{}')
    from recipe.frame_fragments_visit(p_content, p_content -> 'procedure' -> 'body', '', '{}'::text[], null) f
$$;

-- DI-05, DI-30 (0346's header, item 1; 0347; header): what the record of a test run of MBR content p_content, whose
-- header p_header lists its product, family code, version, batch number, site and room, and whose state is p_state,
-- may hold from a bound source, for the words of value p_value, upper-cased: the words of its MBR and header; the
-- names of the engine's registers; the ids of the records its state holds and the compounds of its batch number its
-- state holds; when p_value holds a word of that form, its MBR's flow edges E1 to E<m>; and when p_value holds a compound
-- (a word with '/') that is none of these as a whole, the compounds of the MBR, the header and the expanded ids, the
-- fragments of its context keys and the words of the held compounds.
create function recipe.content_bound_words(p_content jsonb, p_header jsonb, p_state jsonb, p_value jsonb) returns text[]
language plpgsql stable set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
declare
  v_source jsonb := jsonb_build_array(p_content) || case when jsonb_typeof(p_header) = 'array' then p_header else '[]'::jsonb end;
  v_held   text[] := recipe.state_compound_ids(p_state);
  v_words  text[] := array(select sandbox.ascii_upper(w) from sandbox.identifier_words(p_value) w);
  v_tree   jsonb;
  v_out    text[];
begin
  v_out := recipe.source_words(v_source::text) || array(select n.name from recipe.engine_name n) || recipe.state_record_ids(p_state) || v_held;
  if exists (select 1 from unnest(v_words) w where w ~ '(^|/)E[0-9]+(/|$)') then
    v_out := v_out || array(select 'E' || g from generate_series(1, recipe.flow_edge_count(p_content)) g);
  end if;
  if exists (select 1 from unnest(v_words) w where strpos(w, '/') > 0 and not (w = any (v_out))) then
    v_tree := recipe.flow_tree(p_content) -> 'ids';
    v_out := v_out
             || array(select sandbox.ascii_upper(w) from sandbox.identifier_words(v_source) w where strpos(w, '/') > 0)
             || array(select sandbox.ascii_upper(w)
                        from jsonb_object_keys(case when jsonb_typeof(v_tree) = 'object' then v_tree else '{}'::jsonb end) k
                       cross join lateral sandbox.identifier_words(k) w)
             || recipe.frame_fragments(p_content)
             || array(select sandbox.ascii_upper(w) from unnest(v_held) h cross join lateral sandbox.identifier_words(h) w);
  end if;
  return v_out;
end
$$;

-- DI-05 (0346's header, item 1; 0347; header): what test batch p_batch's record may hold from a bound source, for the
-- words of value p_value (recipe.content_bound_words over its imported package, header and state). Empty for a batch
-- that does not exist.
create or replace function recipe.run_bound_words(p_batch uuid, p_value jsonb) returns text[]
language plpgsql stable set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
declare
  v_content jsonb;
  v_header  jsonb;
  v_state   jsonb;
begin
  select p.content, jsonb_build_array(p.product, p.family_code, p.version_number, b.batch_number, b.site_code, b.room_code)
    into v_content, v_header
    from recipe.batch_execution b
    join recipe.test_package p on p.package_hash = b.package_hash
   where b.id = p_batch;
  if not found then
    return '{}';
  end if;
  select s.state into v_state from recipe.execution_state s where s.batch_id = p_batch;
  return recipe.content_bound_words(v_content, v_header, v_state, p_value);
end
$$;

-- DI-05 (header): whether word p_word is bound: one of p_bound (upper-cased); or a compound, joined by '/', that does
-- not start with batch number p_batch_number, each of whose parts holds a letter and is one of p_bound. A compound of
-- the batch number, and a compound holding a part of digits only, are bound only as a whole p_bound holds.
create or replace function recipe.run_word_bound(p_word text, p_bound text[], p_batch_number text) returns boolean
language plpgsql immutable set search_path = pg_catalog, sandbox, pg_temp as $$
declare
  v_up    text := sandbox.ascii_upper(p_word);
  v_bn    text := sandbox.ascii_upper(p_batch_number);
  v_parts text[];
  i       integer;
begin
  if v_up = any (p_bound) then
    return true;
  end if;
  if strpos(v_up, '/') = 0 or (v_bn is not null and starts_with(v_up, v_bn || '/')) then
    return false;
  end if;
  v_parts := string_to_array(v_up, '/');
  for i in 1 .. cardinality(v_parts) loop
    continue when v_parts[i] ~ '[A-Z]' and v_parts[i] = any (p_bound);
    return false;
  end loop;
  return true;
end
$$;

revoke all on function recipe.frame_fragments_visit(jsonb, jsonb, text, text[], integer), recipe.frame_fragments(jsonb),
                       recipe.content_bound_words(jsonb, jsonb, jsonb, jsonb) from public;

reset role;
