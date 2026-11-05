-- A refused row records a library step's refusal (Capsules C3 finding, 5 November 2026). 0336's shape rule took the
-- engine's codes (ENG-...) and the generic blocks' (Gnn-...) only; a library block refuses with LIB-... codes
-- (recipe-core library/block-version.ts, for example LIB-EQUIPMENT-CLASS), so a refused library entry on a GMP batch
-- could not be recorded: the writer answered EBMR-EXE-126 and the operator never saw the reason. The rule now also takes
-- LIB-...; every other part of the shape (members, message, controls) stays as 0336 wrote it.
--
-- Handbook: modules/recipe-core.md
--
-- The function keeps its owner, privileges and pinned search_path. Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05, DI-30, DI-34: why refusal p_refusal is not the engine's refusal of a row with verdict p_accepted; NULL when it
-- is (0336, the code pattern widened to the library's codes).
create or replace function recipe.refusal_problem(p_accepted boolean, p_refusal jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if p_accepted is true then
    return case when p_refusal is not null then 'an accepted row records no refusal' end;
  end if;
  return recipe.command_member_problem(
    '{"t": "object", "of": "the engine''s refusal", "fields": {
       "code": {"t": "text", "pattern": "^(ENG|LIB|G[0-9]{2})(-[A-Z0-9]+)+$"},
       "message": {"t": "text"},
       "controls": {"t": "list", "items": {"t": "text", "pattern": "^(DI|IN|INV|PR|ST)-[0-9]{2}$"}}}}'::jsonb,
    p_refusal, 'refusal', false);
end
$$;

reset role;
