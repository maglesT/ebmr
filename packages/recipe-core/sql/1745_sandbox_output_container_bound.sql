-- Recipe core: the labels of a test run's own output containers are bound words of its record (Phase 7 slice 7o,
-- D-7o-1; found by the R4 browser run of a company's own product; controls DI-05, DI-30).
--
-- Handbook: modules/recipe-core.md
--
-- Since D-7o-1 a test run opens output containers as a GMP batch does (plant.open_container): the database labels each
-- OC-<batch number>-<n> from the test batch's own number. The free-text rule of 0344 to 0350 reads every word a test
-- run's record holds and refuses one of the form of a lot number that the record does not have from a bound source; a
-- container label is not among them, so a test run's inspection could not record the destruction of its own reject
-- container (TB-20, DISPOSAL.container): EBMR-EXE-147.
--
-- recipe.run_bound_words (0348, CREATE OR REPLACE; its body carried) adds the labels of the output containers of the
-- run itself (plant.output_container, batch_id): built by the database from the run's own number, the same kind of
-- source as the compounds 0347 binds. Another batch's container label, and any other word, stay unbound.

set local role ebmr_owner;

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
  return recipe.content_bound_words(v_content, v_header, v_state, p_value)
         || array(select sandbox.ascii_upper(c.label_code) from plant.output_container c where c.batch_id = p_batch order by c.label_code);
end
$$;

reset role;
