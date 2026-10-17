-- Phase 6A slice 6A-0: the analytics permissions (draft controls DI-52, DI-53; interfaces slice-6A-0-interfaces.md
-- section 2; ADR 0020 point 6).
--
-- Handbook: modules/analytics.md
--
-- Catalogue entries only; the Tablets roles are given them in tablets 1330. Analytics is advisory and non-GMP, so
-- its write permissions are GOVERNANCE, not GMP: no analytics act creates or changes GMP data (DI-51). The functions
-- that check them still refuse administrators first (DI-18).
--   ANALYTICS.VIEW         READ        the analytics screens (QA, the head of production, the QP)
--   ANALYTICS.DISPOSITION  WRITE       QA's verdict on a flag (analytics.record_disposition)
--   ANALYTICS.DI_REVIEW    READ        flags about a person or an account (analytics.person_flags; DI-53)
--   ANALYTICS.METHOD       WRITE       a method version or a reference set, under an approved change record of area
--                                      ANALYTICS_METHOD or ANALYTICS_REFERENCE (6f's configuration change routes)

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1244_analytics_permissions)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the analytics permissions (advisory analytics; DI-52, DI-53)'));

insert into iam.permission (code, domain, effect, description) values
  ('ANALYTICS.VIEW', 'READ_ONLY', 'READ', 'Read the advisory analytics screens (not for GMP decisions; DI-51)'),
  ('ANALYTICS.DISPOSITION', 'GOVERNANCE', 'WRITE', 'Record a verdict on an advisory analytics flag (DI-52)'),
  ('ANALYTICS.DI_REVIEW', 'READ_ONLY', 'READ', 'Read advisory analytics flags about a person or an account (data-integrity review; DI-53)'),
  ('ANALYTICS.METHOD', 'GOVERNANCE', 'WRITE', 'Make an analytics method version or reference set effective, under an approved change record (DI-52, DI-09)');

select kernel.set_actor_context(null);

reset role;
