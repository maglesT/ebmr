-- Tablets server, Phase 3 slice 3b (builder B): the block values the granulation blocks compute are theirs to judge,
-- not the weighings' (controls INV-25, PR-08, IN-36; ADR 0012: the rules hold when the application's own database
-- credentials are used directly).
--
-- recipe-core 0322 holds every new block value (a data point with source BLOCK) to be the total of its step's weighings
-- (recipe.weighing_totals_problem, EBMR-EXE-138): in Phase 2 only G-07 and G-22 computed items. TB-04 computes its
-- end-point item from its END_POINT entry, and TB-07 its blend and lubrication time items from BLEND_END and
-- LUBRICATION_END (blocks/tb-04.ts, tb-07.ts), so that the item is judged against its limit tiers and never typed. Such a
-- value is held by tablets 0851 (tab.granulation_computed_problem, EBMR-EXE-251: exactly the block's value from its
-- entry, source BLOCK naming that entry) and not by the weighing rule, which no weighing of its step could satisfy.
--
--   * recipe.granulation_block_item(content, state, point): whether a data point is the item a TB-04 or TB-07 step of
--     the MBR computes (its configuration's endPoint.item, blendTime.item or lubrication.item);
--   * recipe.weighing_totals_problem (CREATE OR REPLACE from its latest definition, recipe-core 0322): unchanged but for
--     leaving those points out of the first loop (a new block value is a weighing total). Every other block value is
--     held to the weighings as before; the second loop (a step's weighings counted into exactly one total) is unchanged.
--
-- CREATE OR REPLACE keeps the owner (ebmr_owner) and the privileges (none for PUBLIC). Applied as a new migration
-- because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- INV-25 (header): whether data point p_point of state p_state is the item its step computes as a TB-04 or TB-07 step
-- of MBR content p_content.
create function recipe.granulation_block_item(p_content jsonb, p_state jsonb, p_point jsonb) returns boolean
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(n -> 'block' ->> 'type' = 'TB-04' and n -> 'config' -> 'endPoint' ->> 'item' = p_point ->> 'item'
                  or n -> 'block' ->> 'type' = 'TB-07' and (n -> 'config' -> 'blendTime' ->> 'item' = p_point ->> 'item'
                                                            or n -> 'config' -> 'lubrication' ->> 'item' = p_point ->> 'item'), false)
    from (select recipe.step_node(p_content, p_state -> 'steps' -> (p_point ->> 'stepKey') ->> 'step') as n) s
$$;

-- As recipe-core 0322, leaving out the block values tablets 0851 holds (header).
create or replace function recipe.weighing_totals_problem(p_old jsonb, p_new jsonb, p_content jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_points  jsonb := case when jsonb_typeof(p_new -> 'points') = 'object' then p_new -> 'points' else '{}'::jsonb end;
  v_entries jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  v_params  jsonb := case when jsonb_typeof(p_content -> 'parameters') = 'array' then p_content -> 'parameters' else '[]'::jsonb end;
  v_valid   text[];
  v_problem text;
  k         text;
  x         jsonb;
  v_item    text;
begin
  for k, x in select p.key, p.value
                from jsonb_each(v_points) p
               where not coalesce((p_old -> 'points') ? p.key, false)
                 and p.value -> 'source' ->> 'mode' = 'BLOCK'
                 and not recipe.granulation_block_item(p_content, p_new, p.value)
               order by p.key
  loop
    v_problem := recipe.block_total_problem(p_new, k, (select q ->> 'unit' from jsonb_array_elements(v_params) q where q ->> 'id' = x ->> 'item' limit 1));
    if v_problem is not null then
      return v_problem;
    end if;
  end loop;
  for k in select s.key
             from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) s
            where s.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED')
              and (p_old -> 'steps' -> s.key ->> 'status') = 'IN_PROGRESS'
            order by s.key
  loop
    for v_item in select distinct e.value -> 'data' ->> 'item'
                    from jsonb_each(v_entries) e
                   where e.value ->> 'stepKey' = k
                     and e.value ->> 'kind' in ('CONTAINER_WEIGHING', 'OUTPUT_CONTAINER')
                     and jsonb_typeof(e.value -> 'data' -> 'item') = 'string'
                   order by 1
    loop
      select coalesce(array_agg(p.key order by p.key), '{}') into v_valid
        from jsonb_each(v_points) p
       where p.value ->> 'stepKey' = k and p.value ->> 'item' = v_item
         and p.value ->> 'status' = 'VALID' and p.value -> 'source' ->> 'mode' = 'BLOCK';
      if cardinality(v_valid) <> 1 then
        return format('step %s as %s with %s valid block values of %s, where its weighings count into exactly one',
                      k, p_new -> 'steps' -> k ->> 'status', cardinality(v_valid), v_item);
      end if;
      v_problem := recipe.block_total_problem(p_new, v_valid[1], (select q ->> 'unit' from jsonb_array_elements(v_params) q where q ->> 'id' = v_item limit 1));
      if v_problem is not null then
        return format('step %s as %s with %s', k, p_new -> 'steps' -> k ->> 'status', v_problem);
      end if;
    end loop;
  end loop;
  return null;
end
$$;

revoke all on function recipe.granulation_block_item(jsonb, jsonb, jsonb) from public;

reset role;
