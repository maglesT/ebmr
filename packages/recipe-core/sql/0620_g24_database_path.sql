-- Recipe core, Phase 3 slice 5b (reprocessing and recovery, outline 5.2.9; D-S5-7, D-S5-8; controls PR-47, IN-19,
-- IN-18; ADR 0012: the rules hold when the application's own database credentials are used directly). Part 1: G-24@1's
-- source addition is refused on GMP, and G-24@2, the version on the database's facts, enters the registers.
--
-- G-24@1 (blocks/generic/process.ts, released in Phase 2) takes the facts of a source addition from the caller: the
-- source batch, its product, its manufacture instant and whether it contains recovered material are members of the
-- command (recipe-core 0330 compares them with nothing but the batch's product). A released block version never
-- changes (ADR 0010), so it stays as it is for test runs, and the database refuses a new SOURCE_ADDITION entry at a
-- G-24@1 step of a GMP batch (EBMR-RPR-001). Its start (the authorisation of a whole-batch reprocessing step) and its
-- validated re-treatment are unchanged. G-24@2 and the Tablets edition's TB-08@1 take an addition's facts from the
-- database instead (recipe-core 0621, 0622; tablets 1020, 1021).
--
--   * recipe.g24_v1_gmp_check (trigger zr_g24_v1_gmp after update on recipe.execution_state): a row of a GMP batch that
--     adds a SOURCE_ADDITION entry at a step whose MBR node runs G-24 version 1 is refused;
--   * recipe.block_data_schema: the start data and the ADDITION entry of G-24@2 as blocks/generic/reprocessing.ts
--     declares them (the parity test of recipe-core test execution/entry-data-sql compares them; a version's schemas
--     never change);
--   * recipe.engine_name: the rule codes G-24@2 gives that G-24@1 did not (a test run's record may hold them, 0346).
--
-- Messages: EBMR-RPR-001 to 009 (this part). Applied as a new migration because applied migrations are checksummed and
-- never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0620_g24_database_path)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the block version G-24@2 in the registers every entry is checked against (DI-30, PR-47, IN-19)'));

insert into recipe.block_data_schema (block_type, block_version, part, entry_kind, schema) values
  ('G-24', '2', 'START', 'START_DATA', '{"type":"object","fields":{"authorisation":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"authorisedBy":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true}}}'),
  ('G-24', '2', 'ENTRY', 'ADDITION', '{"type":"object","fields":{"container":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"quantity":{"type":"object","fields":{"value":{"type":"decimal","min":"0","minExclusive":true},"unit":{"type":"string","enum":["kg","g","units"]}}},"authorisation":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"authorisedBy":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"source":{"type":"object","fields":{"container":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"sourceBatchId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"product":{"type":"string"},"strength":{"type":"string"},"stage":{"type":"string"},"unit":{"type":"string","enum":["kg","g","units"]},"case":{"type":"string","enum":["REPROCESSING_ADDITION","RECOVERY"],"optional":true},"generatedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$"},"manufacturedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$"},"containsRecovered":{"type":"boolean"},"remaining":{"type":"string","pattern":"^(0|[1-9][0-9]*)(\\.[0-9]*[1-9])?$"},"expiry":{"type":"string","pattern":"^[0-9]{4}-(0[1-9]|1[0-2])$","optional":true}}}}}');

insert into recipe.engine_name (name, kind) values
  ('G24-AD-HOC', 'RULE_CODE'), ('G24-AUTHORISATION-USED', 'RULE_CODE'), ('G24-ENTRY', 'RULE_CODE'),
  ('G24-OVER-REMAINING', 'RULE_CODE'), ('G24-OWN-BATCH', 'RULE_CODE'), ('G24-SOURCE-STATUS', 'RULE_CODE'),
  ('G24-UNIT', 'RULE_CODE');

select kernel.set_actor_context(null);

-- PR-47, IN-19, D-S5-8 (header): why row p_new of batch p_batch (after p_old) is refused for a source addition at a
-- G-24@1 step on GMP, or NULL.
create function recipe.g24_v1_gmp_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0     jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  k      text;
  e      jsonb;
  v_node jsonb;
begin
  if (select b.installation from recipe.batch_execution b where b.id = p_batch) is distinct from 'GMP' then
    return null;
  end if;
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) and x.value ->> 'kind' = 'SOURCE_ADDITION' order by x.key loop
    v_node := recipe.step_node(p_content, p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step');
    if v_node -> 'block' ->> 'type' = 'G-24' and v_node -> 'block' ->> 'version' = '1' then
      return format('entry %s adds material at G-24@1 step %s, whose source facts are the caller''s: on GMP an addition is made at a G-24@2 or TB-08 step, which reads them from the database',
                    k, coalesce(e ->> 'stepKey', '(none)'));
    end if;
  end loop;
  return null;
end
$$;

create function recipe.g24_v1_gmp_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_problem text;
begin
  if (select b.installation from recipe.batch_execution b where b.id = new.batch_id) is distinct from 'GMP' then
    return null;
  end if;
  v_problem := recipe.g24_v1_gmp_problem(new.batch_id, recipe.batch_mbr_content(new.batch_id), old.state, new.state);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This row is refused: %s (PR-47, IN-19; D-S5-8). [EBMR-RPR-001]', v_problem);
  end if;
  return null;
end
$$;

create trigger zr_g24_v1_gmp after update on recipe.execution_state
  for each row execute function recipe.g24_v1_gmp_check();

revoke all on function recipe.g24_v1_gmp_problem(uuid, jsonb, jsonb, jsonb), recipe.g24_v1_gmp_check() from public;

reset role;
