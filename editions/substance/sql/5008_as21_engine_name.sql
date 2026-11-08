-- API edition plan A4b: the control AS-21 (recovery of materials and solvents, ICH Q7 14.4) joins the names a test
-- run may cite (recipe-core 0346).
--
-- Handbook: modules/substance.md
--
-- AS-21 (edition substance, expert decision PENDING) enters the control register (compliance/controls) in slice
-- A4b; recipe.engine_name is kept equal to the register, as migrations 5003 and 5007 did.
-- Data only: no function, no change to tablets or injectables.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (substance migration 5008_as21_engine_name)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the API edition control AS-21 of slice A4b in the name register'));

insert into recipe.engine_name (name, kind) values
  ('AS-21', 'CONTROL');

select kernel.set_actor_context(null);

reset role;
