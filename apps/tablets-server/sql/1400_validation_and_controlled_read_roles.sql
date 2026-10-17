-- Tablets: CONTROLLED.READ for the Tablets roles (slice 7-0; kernel 1300; interfaces slice-7-0-interfaces.md section 5;
-- draft IN-53). Kernel 1300 grants VALIDATION.APPROVE_SUMMARY and CONFIG.SYSTEM_DESCRIPTION itself.
--
-- Handbook: modules/kernel.md
--
--   CONTROLLED.READ             every role holding a CONTROLLED.* permission when this release runs (recipe-core 1030:
--                               the custodians, the balance and register roles and their approvers), and QA_REVIEWER.
--                               Slice 7a makes the controlled list, balance and register reads require it (6jc-R2).
-- No administration role holds any of them (DI-18, INV-11). Role permissions are configuration (DI-09, area
-- ROLE_PERMISSION); a release writes them under its own change control.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 1400_validation_and_controlled_read_roles)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'CONTROLLED.READ for the Tablets roles (IN-53)'));

insert into iam.role_permission (role_code, permission_code)
select r.role_code, 'CONTROLLED.READ'
  from (select distinct p.role_code from iam.role_permission p where p.permission_code like 'CONTROLLED.%' and p.removed_at is null
        union select 'QA_REVIEWER') r
 order by r.role_code;

select kernel.set_actor_context(null);

reset role;
