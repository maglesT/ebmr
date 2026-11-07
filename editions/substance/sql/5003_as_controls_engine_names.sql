-- API edition plan A1b: the fifteen AS controls of slice A1 join the names a test run may cite (recipe-core 0346).
--
-- Handbook: modules/substance.md
--
-- The controls AS-01 to AS-10, AS-14 to AS-16, AS-18 and AS-24 (edition substance, expert decision PENDING) enter the
-- control register (compliance/controls) in this slice; recipe.engine_name is kept equal to the register
-- (packages/recipe-core/test/execution/engine-names-sql.test.ts), as recipe-core 1030 and 1110 did for their controls.
-- Data only: no function, no change to tablets or injectables.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (substance migration 5003_as_controls_engine_names)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the API edition controls of slice A1 in the name register'));

insert into recipe.engine_name (name, kind) values
  ('AS-01', 'CONTROL'), ('AS-02', 'CONTROL'), ('AS-03', 'CONTROL'), ('AS-04', 'CONTROL'), ('AS-05', 'CONTROL'),
  ('AS-06', 'CONTROL'), ('AS-07', 'CONTROL'), ('AS-08', 'CONTROL'), ('AS-09', 'CONTROL'), ('AS-10', 'CONTROL'),
  ('AS-14', 'CONTROL'), ('AS-15', 'CONTROL'), ('AS-16', 'CONTROL'), ('AS-18', 'CONTROL'), ('AS-24', 'CONTROL');

select kernel.set_actor_context(null);

reset role;
