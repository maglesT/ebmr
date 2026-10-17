-- Tablets: the analytics permissions of the Tablets roles (Phase 6A slice 6A-0; kernel 1244; draft controls DI-52,
-- DI-53; D-6A-0-5).
--
-- Handbook: modules/analytics.md
--
--   ANALYTICS.VIEW         QA_REVIEWER, HEAD_OF_PRODUCTION, AUTHORISED_PERSON (the QP), EU_QP, CSV_DI_LEAD
--   ANALYTICS.DISPOSITION  QA_REVIEWER, CSV_DI_LEAD
--   ANALYTICS.DI_REVIEW    CSV_DI_LEAD (QA's data-integrity reviewer; flags about a person stay within that review,
--                          D-6A-12)
--   ANALYTICS.METHOD       QA_REVIEWER, PROCESS_OWNER (the system owner)
-- No administration role holds any of them (DI-18, INV-11). Role permissions are configuration (DI-09, area
-- ROLE_PERMISSION); a release writes them under its own change control.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 1330_analytics_role_permissions)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the analytics permissions of the Tablets roles (advisory analytics; DI-52, DI-53)'));

insert into iam.role_permission (role_code, permission_code) values
  ('QA_REVIEWER', 'ANALYTICS.VIEW'),
  ('HEAD_OF_PRODUCTION', 'ANALYTICS.VIEW'),
  ('AUTHORISED_PERSON', 'ANALYTICS.VIEW'),
  ('EU_QP', 'ANALYTICS.VIEW'),
  ('CSV_DI_LEAD', 'ANALYTICS.VIEW'),
  ('QA_REVIEWER', 'ANALYTICS.DISPOSITION'),
  ('CSV_DI_LEAD', 'ANALYTICS.DISPOSITION'),
  ('CSV_DI_LEAD', 'ANALYTICS.DI_REVIEW'),
  ('QA_REVIEWER', 'ANALYTICS.METHOD'),
  ('PROCESS_OWNER', 'ANALYTICS.METHOD');

select kernel.set_actor_context(null);

reset role;
