-- Recipe core, execution store (module C3): a compound the engine builds from the run's batch number is allowed in a
-- test run's record only as the run holds it (Phase 2 exit follow-up F12, the lane's round-11 self-review of 0346;
-- DI-05, DI-30; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- What was wrong. 0346 allowed a sample's number S<n> as the last part of any compound that starts with the run's batch
-- number and whose other parts are words of the run (recipe.run_word_bound): a word of that form passed whether or not
-- the run had such a sample. A comment '<batch number>/p-disp-clear/S24090017', longer than a TEST- identifier can be
-- (so read part by part), therefore held the word S24090017, which the kernel's rule reads as a real batch number, in
-- the record. The engine builds two compounds of the batch number (blocks/generic/process.ts, material.ts): a sample's
-- id <batch number>/<phase>[/<sub-lot>]/S<n>, kept in its SAMPLE entry (data.sampleId, bound to the block's own value
-- by 0330), and an output container's id <batch number>/<intermediate>/<frames>/<n>, kept as a key of the state's
-- containers (0317).
--
-- What changed.
--   * recipe.state_compound_ids(state): the ids the state holds that the engine builds from the batch number: the
--     sample ids of its entries, the keys of its containers and of its sub-lots, upper-cased;
--   * recipe.run_bound_words (0346's, replaced) adds them to the words a run's record may hold;
--   * recipe.run_word_bound (0346's, replaced): a compound that starts with the run's batch number is bound only as a
--     whole the run holds (one of the above); any other compound only when each of its parts is a word of the run or a
--     number, as before. S<n> is no longer allowed by its form anywhere.
-- Stricter than 0346, never weaker: every sample and container id the engine's runs store is held by their state (the
-- golden run, the sampling run of db-guards-entry-identifiers).
--
-- Correction of an earlier claim (applied migrations are never edited): 0346's header says a sample's number is allowed
-- "only as the last part of an id that starts with the run's batch number"; that bound its form, not the sample.
--
-- The functions keep their owner (ebmr_owner), privileges (none for the application roles) and pinned search_path.
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05, DI-30: the ids state p_state holds that the engine builds from the batch number (header), upper-cased.
create function recipe.state_compound_ids(p_state jsonb) returns text[]
language sql immutable set search_path = pg_catalog, sandbox, pg_temp as $$
  select coalesce(array_agg(distinct sandbox.ascii_upper(x.id)), '{}')
    from (select e.value -> 'data' ->> 'sampleId' as id
            from jsonb_each(case when jsonb_typeof(p_state -> 'entries') = 'object' then p_state -> 'entries' else '{}'::jsonb end) e
           where jsonb_typeof(e.value -> 'data' -> 'sampleId') = 'string'
          union all
          select k from jsonb_object_keys(case when jsonb_typeof(p_state -> 'containers') = 'object' then p_state -> 'containers' else '{}'::jsonb end) k
          union all
          select k from jsonb_object_keys(case when jsonb_typeof(p_state -> 'subLots') = 'object' then p_state -> 'subLots' else '{}'::jsonb end) k) x
$$;

-- DI-05 (0346's header, item 1; header): what test batch p_batch's record may hold from a bound source, for the words of
-- value p_value: the words of its MBR, batch number, site and room; the names of the engine's registers; the ids of the
-- records its state holds and the compounds of its batch number its state holds; and, when p_value holds a word of that
-- form, its MBR's flow edges E1 to E<m>. Empty for a batch that does not exist.
create or replace function recipe.run_bound_words(p_batch uuid, p_value jsonb) returns text[]
language plpgsql stable set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
declare
  v_content jsonb;
  v_state   jsonb;
  v_out     text[];
begin
  select p.content, recipe.source_words(jsonb_build_array(p.content, p.product, p.family_code, p.version_number, b.batch_number, b.site_code, b.room_code)::text)
    into v_content, v_out
    from recipe.batch_execution b
    join recipe.test_package p on p.package_hash = b.package_hash
   where b.id = p_batch;
  if not found then
    return '{}';
  end if;
  select s.state into v_state from recipe.execution_state s where s.batch_id = p_batch;
  v_out := v_out || array(select n.name from recipe.engine_name n) || recipe.state_record_ids(v_state) || recipe.state_compound_ids(v_state);
  if exists (select 1 from sandbox.identifier_words(p_value) w where w ~* '(^|/)e[0-9]+(/|$)') then
    v_out := v_out || array(select 'E' || g from generate_series(1, recipe.flow_edge_count(v_content)) g);
  end if;
  return v_out;
end
$$;

-- DI-05 (header): whether word p_word is bound: one of p_bound (upper-cased); or a compound, joined by '/', that does
-- not start with batch number p_batch_number, each part one of p_bound or a number. A compound of the batch number is
-- bound only as a whole p_bound holds.
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
    continue when v_parts[i] ~ '^[0-9]+$' or v_parts[i] = any (p_bound);
    return false;
  end loop;
  return true;
end
$$;

revoke all on function recipe.state_compound_ids(jsonb) from public;

reset role;
