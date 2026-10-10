-- Tablets server, Phase 3 slice 3b (quick review, item 3): the database refuses a skip of a Tablets edition step that
-- moves or processes material, as it refuses one of G-07 dispensing (controls PR-13, PR-16): TB-01 potency-adjusted
-- dispensing and TB-02 to TB-07 (sifting and milling, solutions, wet granulation, drying, roller compaction, blending).
-- recipe.skip_problem is replaced from its definition in recipe-core 0452 (the latest) with those block types added to
-- the list of steps never skipped; nothing else of it changes. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- As recipe-core 0452, with the Tablets blocks TB-01 to TB-07 never skipped.
create or replace function recipe.skip_problem(p_content jsonb, p_node jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_items text[];
  v_item  text;
begin
  if p_node is null then
    return 'the step is not a step of the batch''s MBR';
  end if;
  if p_node ->> 'kind' is distinct from 'phase' then
    return 'it is a QA hold point: release signatures are never skipped';
  end if;
  if (p_node -> 'config' -> 'skippable') is distinct from 'true'::jsonb then
    return 'the MBR does not declare it skippable';
  end if;
  if p_node -> 'block' ->> 'type' in ('G-07', 'G-08', 'G-10', 'G-20', 'G-24', 'G-25', 'TB-01', 'TB-02', 'TB-03', 'TB-04', 'TB-05', 'TB-06', 'TB-07') then
    return format('it is a step of block %s: line clearance, dispensing, charge-in, reconciliation, reprocessing, sign-off and the tablet material-processing steps are never skipped', p_node -> 'block' ->> 'type');
  end if;
  if exists (select 1 from unnest(array['consumes', 'produces', 'uses']) k
              where jsonb_typeof(p_node -> k) is distinct from 'array' or jsonb_array_length(p_node -> k) > 0)
     or (p_node ? 'yieldCheckpoint' and (p_node -> 'yieldCheckpoint') <> 'null'::jsonb)
     or (p_node ? 'acceptanceScheme' and (p_node -> 'acceptanceScheme') <> 'null'::jsonb) then
    return 'it moves material or carries a yield or acceptance check';
  end if;
  v_items := array(select jsonb_array_elements_text(case when jsonb_typeof(p_node -> 'records') = 'array' then p_node -> 'records' else '[]' end));
  foreach v_item in array v_items loop
    if not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_content -> 'parameters') = 'array' then p_content -> 'parameters' else '[]' end) p
                    where p ->> 'id' = v_item and p ->> 'criticality' = 'NON_CRITICAL') then
      return format('it records %s, which is not declared NON_CRITICAL: CPP and CQA inputs are never skipped', v_item);
    end if;
  end loop;
  v_items := v_items || array(select jsonb_array_elements_text(case when jsonb_typeof(p_node -> 'computes') = 'array' then p_node -> 'computes' else '[]' end));
  foreach v_item in array v_items loop
    if jsonb_path_exists(p_content -> 'procedure', 'strict $.** ? (@.reads.type() == "array" && exists (@.reads[*] ? (@ == $item)))', jsonb_build_object('item', v_item)) then
      return format('it writes %s, which another step reads', v_item);
    end if;
  end loop;
  return null;
end
$$;

reset role;
