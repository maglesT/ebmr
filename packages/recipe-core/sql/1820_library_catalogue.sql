-- Recipe core, decision 0026 slice S7: loading the ready-made catalogue.
--
-- Handbook: modules/recipe-core.md
--
--   recipe.require_library_author()  the catalogue load's own check, before it looks at the library: an author
--                                    (MBR.AUTHOR) who is not the administrator. Each block is then stored by
--                                    recipe.draft_library_block, which checks the same again; a load that finds every
--                                    code already held changes nothing but is still the author's act (DI-17).

set local role ebmr_owner;

create function recipe.require_library_author() returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MBR.AUTHOR', '{}'::jsonb);
end
$$;

revoke all on function recipe.require_library_author() from public;
grant execute on function recipe.require_library_author() to ebmr_app;

reset role;
