-- API edition plan A3: the control AS-17 (certificate of analysis) joins the names a test run may cite (recipe-core 0346).
--
-- Handbook: modules/substance.md
--
-- AS-17 (edition substance, expert decision PENDING) enters the control register (compliance/controls) for the CoA of
-- substance 5005; recipe.engine_name is kept equal to the register
-- (apps/tablets-server/test/library/substance-edition.test.ts), as 5003 did for the AS controls of slice A1.
-- Data only: no function, no change to tablets or injectables.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (substance migration 5006_as17_engine_name)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the API edition control AS-17 in the name register'));

insert into recipe.engine_name (name, kind) values ('AS-17', 'CONTROL');

select kernel.set_actor_context(null);

reset role;
