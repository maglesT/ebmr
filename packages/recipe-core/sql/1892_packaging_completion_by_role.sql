-- Injectables lean review, item 6 (lead, 10 November 2026; decision 0026: a firm's own QA-approved block works without
-- software): a library block that carries the role PACK_EXAMINATION completes a packaging record, as the blocks listed in
-- recipe.packaging_completion_block do.
--
-- Handbook: modules/recipe-core.md
--
-- Before: only the block types listed per edition in recipe.packaging_completion_block (0761, 1873) completed a packaging
-- record (recipe.packaging_master_problem, 0800), so a firm's own finished-pack examination block needed a migration.
-- From this migration:
--
--   recipe.packaging_completion_types(edition, content): the block types that complete a packaging record of the
--       edition in the master content: the rows of recipe.packaging_completion_block for the edition (unchanged), and the
--       type of every library step of the content ('LIB-<code>' at its version) whose block is APPROVED, of the edition
--       or generic, and lists PACK_EXAMINATION among its roles. A step of an unapproved or unknown block, or of another
--       edition, does not count. 21 CFR 211.134(b), (c): finished packs are examined at the completion of finishing;
--       Schedule M Part I (packaging operations): the record ends with the finished-pack examination.
--   recipe.packaging_master_problem (CREATE OR REPLACE from 0800): as before, with its types from
--       recipe.packaging_completion_types. Tablets (TB-24) and API (5000) rows behave as before.
--
-- PL/pgSQL / SQL, SECURITY DEFINER, search_path pinned with pg_temp last (ADR 0016).

set local role ebmr_owner;

create function recipe.packaging_completion_types(p_edition text, p_content jsonb) returns text[]
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select array(
    select t from (
      select b.block_type as t from recipe.packaging_completion_block b where b.edition = p_edition
      union
      select 'LIB-' || lb.code
        from jsonb_path_query(coalesce(p_content -> 'procedure', 'null'::jsonb), 'lax $.**.block') s (blk)
        join recipe.library_block lb
          on 'LIB-' || lb.code = s.blk ->> 'type' and lb.version::text = s.blk ->> 'version'
        join recipe.library_block_approval a on a.block_id = lb.id
       where jsonb_typeof(s.blk) = 'object'
         and recipe.library_block_edition(lb.definition) in (p_edition, 'generic')
         and jsonb_typeof(lb.definition -> 'roles') = 'array'
         and lb.definition -> 'roles' ? 'PACK_EXAMINATION'
    ) x
    order by t)
$$;

-- As 0800, with the completion types of the content (header).
create or replace function recipe.packaging_master_problem(p_edition text, p_content jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_types text[] := recipe.packaging_completion_types(p_edition, p_content);
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

revoke all on function recipe.packaging_completion_types(text, jsonb) from public;

reset role;
