-- A refused row records the refusal of every kind of step on a Tablets installation (owner report item 4, G3). Two
-- sources each widened recipe.refusal_problem's code pattern from 0336 (ENG-..., Gnn-...): tablets 0844 added the
-- Tablets blocks' TBnn-... and recipe-core 1874 the library blocks' LIB-.... Migrations run source by source, so on a
-- Tablets database 0844's definition replaced 1874's: a refused library entry (LIB-EQUIPMENT-FITNESS, a vessel DIRTY and
-- NOT_QUALIFIED) could not be recorded, the writer answered EBMR-EXE-126 and the operator never saw the reason. The
-- pattern now takes all four; every other part of the shape (members, message, controls) stays as 0336 wrote it. A meta
-- test (refusal-code-prefixes.test.ts) runs every code the engine and the blocks emit through the final function.
--
-- Handbook: modules/recipe-core.md
--
-- The function keeps its owner, privileges and pinned search_path. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05, DI-30, DI-34: why refusal p_refusal is not the engine's refusal of a row with verdict p_accepted; NULL when it
-- is (0336, with the code pattern of 0844 and 1874 together).
create or replace function recipe.refusal_problem(p_accepted boolean, p_refusal jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if p_accepted is true then
    return case when p_refusal is not null then 'an accepted row records no refusal' end;
  end if;
  return recipe.command_member_problem(
    '{"t": "object", "of": "the engine''s refusal", "fields": {
       "code": {"t": "text", "pattern": "^(ENG|LIB|G[0-9]{2}|TB[0-9]{2})(-[A-Z0-9]+)+$"},
       "message": {"t": "text"},
       "controls": {"t": "list", "items": {"t": "text", "pattern": "^(DI|IN|INV|PR|ST)-[0-9]{2}$"}}}}'::jsonb,
    p_refusal, 'refusal', false);
end
$$;

reset role;
