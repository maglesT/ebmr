-- API edition plan A4a: the controls AS-19 and AS-20 (reprocessing and rework, ICH Q7 14.2 and 14.3) join the names a
-- test run may cite (recipe-core 0346).
--
-- Handbook: modules/substance.md
--
-- AS-19 and AS-20 (edition substance, expert decision PENDING) enter the control register (compliance/controls) in this
-- slice; recipe.engine_name is kept equal to the register, as migration 5003 did for the controls of slice A1.
-- Data only: no function, no change to tablets or injectables.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (substance migration 5007_as19_as20_engine_names)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the API edition controls AS-19 and AS-20 of slice A4a in the name register'));

insert into recipe.engine_name (name, kind) values
  ('AS-19', 'CONTROL'), ('AS-20', 'CONTROL');

select kernel.set_actor_context(null);

reset role;
