-- API edition plan A0 (lead decision of 5 November 2026): recipe-core's edition checks name the one list,
-- kernel.editions() (kernel 1403). Nothing is narrowed; PostgreSQL validates every existing row when each constraint is
-- added.
--
-- Handbook: modules/recipe-core.md
--
--   check mbr_family_edition, packaging_completion_block_edition (lower case), grel_edition_hook_edition (upper case)
--   recipe.library_editions()          'generic' plus kernel.editions(); the library_block_edition check (1871) and
--                                      EBMR-LIB-023 read it, so they now accept substance blocks
--   recipe.rule_table_versions(edition) the kernel table plus the edition's own: tablets -> tablets, injectables ->
--                                      sterile (as before), substance -> none (the API edition has no rule table of
--                                      its own; before, every edition other than tablets fell to sterile)

set local role ebmr_owner;

alter table recipe.mbr_family                 drop constraint mbr_family_edition_check,
  add constraint mbr_family_edition_check check (edition = any (kernel.editions()));
alter table recipe.packaging_completion_block drop constraint packaging_completion_block_edition_check,
  add constraint packaging_completion_block_edition_check check (edition = any (kernel.editions()));
alter table recipe.grel_edition_hook          drop constraint grel_edition_hook_edition_check,
  add constraint grel_edition_hook_edition_check check (edition = any (kernel.edition_codes()));

create or replace function recipe.library_editions() returns text[]
language sql immutable set search_path = pg_catalog as $$ select array['generic'] || kernel.editions() $$;

create or replace function recipe.rule_table_versions(p_edition text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, market, pg_temp as $$
  select coalesce(jsonb_object_agg(t.code,
           (select jsonb_build_object('id', v.id, 'version', v.version, 'content_hash', encode(v.content_hash, 'hex'))
            from market.rule_table_version v where v.table_code = t.code order by v.version desc limit 1) order by t.code), '{}'::jsonb)
  from market.rule_table t
  where t.code in ('kernel', case p_edition when 'tablets' then 'tablets' when 'injectables' then 'sterile' end)
$$;

reset role;
