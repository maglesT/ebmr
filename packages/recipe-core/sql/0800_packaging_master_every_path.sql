-- Recipe core: a packaging master ends with the secondary packaging of the finished packs on every path that completes it
-- (Phase 4 slice 3b; slice 2 quick review backlog, medium; outline 5.2.9; controls PR-37, IN-16; default D-3b-1).
--
-- recipe.packaging_master_problem (recipe-core 0761) accepted a completion block (Tablets: TB-24) anywhere in the
-- procedure, so a master whose TB-24 step sat in an optional branch of an alternative could be planned as a packaging
-- order and complete without the finished-pack examination. From this migration:
--
--   * recipe.packaging_path_completes(node, types): whether every completing run of the flow node passes a phase whose
--     block type is one of types:
--       phase       its block type is one of types;
--       stage, operation   its body does;
--       sequence    one of its children does;
--       parallel    one of its branches does (every branch runs);
--       alternative it has at least one branch and every branch has a body that does (a branch without a body, or one
--                   that does not, is a completing path without it);
--       loop        its body does (a loop runs its body at least once);
--       replicate   its body does and its count's minimum is at least 1;
--       holdPoint, libraryCall and anything else: no (a library element is not read here; stricter, default D-3b-1).
--   * recipe.packaging_master_problem (CREATE OR REPLACE from 0761, the only definition): as before, and the procedure's
--     body must complete only through a completion block (recipe.packaging_path_completes). Its message names the rule.
--
-- A step skipped under an approved skip is an exception path with its own register entry, not a completing path of the
-- master, so it is not considered here. CREATE OR REPLACE keeps the owner and grants. Every function is owned by
-- ebmr_owner, pins its search_path with pg_temp last (ADR 0016). Applied as a new migration because applied migrations
-- are checksummed and never edited.

set local role ebmr_owner;

create function recipe.packaging_path_completes(p_node jsonb, p_types text[]) returns boolean
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  x jsonb;
begin
  if jsonb_typeof(p_node) is distinct from 'object' then
    return false;
  end if;
  case p_node ->> 'kind'
    when 'phase' then
      return coalesce(p_node -> 'block' ->> 'type' = any (p_types), false);
    when 'stage', 'operation', 'loop' then
      return recipe.packaging_path_completes(p_node -> 'body', p_types);
    when 'replicate' then
      return coalesce((p_node -> 'count' ->> 'min') ~ '^[0-9]{1,9}$' and (p_node -> 'count' ->> 'min')::integer >= 1, false)
         and recipe.packaging_path_completes(p_node -> 'body', p_types);
    when 'sequence' then
      for x in select c from jsonb_array_elements(case when jsonb_typeof(p_node -> 'children') = 'array' then p_node -> 'children' else '[]'::jsonb end) c loop
        if recipe.packaging_path_completes(x, p_types) then
          return true;
        end if;
      end loop;
      return false;
    when 'parallel' then
      for x in select b from jsonb_array_elements(case when jsonb_typeof(p_node -> 'branches') = 'array' then p_node -> 'branches' else '[]'::jsonb end) b loop
        if recipe.packaging_path_completes(x -> 'body', p_types) then
          return true;
        end if;
      end loop;
      return false;
    when 'alternative' then
      if jsonb_typeof(p_node -> 'branches') is distinct from 'array' or jsonb_array_length(p_node -> 'branches') = 0 then
        return false;
      end if;
      for x in select b from jsonb_array_elements(p_node -> 'branches') b loop
        if not recipe.packaging_path_completes(x -> 'body', p_types) then
          return false;
        end if;
      end loop;
      return true;
    else
      return false;
  end case;
end
$$;

-- As 0761, and the completion block lies on every completing path of the procedure (header).
create or replace function recipe.packaging_master_problem(p_edition text, p_content jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_types text[] := array(select b.block_type from recipe.packaging_completion_block b where b.edition = p_edition order by b.block_type);
begin
  if cardinality(v_types) = 0 then
    return format('no block completes a packaging record of the %s edition yet', coalesce(p_edition, '(none)'));
  end if;
  if not exists (select 1 from jsonb_path_query(coalesce(p_content -> 'procedure', 'null'::jsonb), 'lax $.**.block.type') t
                  where t #>> '{}' = any (v_types)) then
    return format('its procedure has no %s step: a packaging record ends with the secondary packaging of the finished packs', array_to_string(v_types, ' or '));
  end if;
  if not recipe.packaging_path_completes(p_content -> 'procedure' -> 'body', v_types) then
    return format('its procedure can complete without a %s step (one sits in an optional branch, a replicate that may run no instance or a library element): a packaging record ends with the secondary packaging of the finished packs on every path',
                  array_to_string(v_types, ' or '));
  end if;
  return null;
end
$$;

revoke all on function recipe.packaging_path_completes(jsonb, text[]) from public;

reset role;
