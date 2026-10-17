-- Phase 6A slice 6A-0: the four draft analytics controls join the names a test run may cite (recipe-core 0346;
-- D-6A-3).
--
-- Handbook: modules/analytics.md
--
-- The draft controls DI-51, DI-52, DI-53 and PR-61 (status U, expert decision PENDING, target phase 7) enter the
-- control register (compliance/controls) in this slice; recipe.engine_name is kept equal to the register
-- (packages/recipe-core/test/execution/engine-names-sql.test.ts), as recipe-core 1030 did for IN-53.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1110_analytics_draft_controls)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the draft analytics controls DI-51, DI-52, DI-53 and PR-61 in the name register'));

insert into recipe.engine_name (name, kind) values
  ('DI-51', 'CONTROL'), ('DI-52', 'CONTROL'), ('DI-53', 'CONTROL'), ('PR-61', 'CONTROL');

select kernel.set_actor_context(null);

reset role;
