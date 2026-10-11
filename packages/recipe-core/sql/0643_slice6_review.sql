-- Slice 6 review fixes, recipe-core part (Phase 3 slice 6a; controls DI-13, DI-17, INV-01).
--
--   * DI-13: a pinned MBR's composition is shown only to a reader holding FORMULA.READ (tablets 1042), and the regulatory
--     signer confirms an MBR's regulatory conformity on its content, so the role REGULATORY_SIGNER holds FORMULA.READ
--     (D-S6-4 extended to the MBR's own signers; the owner may narrow it).
--   * DI-17: the planning read is the session's (tablets 1042, BATCH.ISSUE by its role); recipe.planning_orders (0641) is
--     the owner's only.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0643_slice6_review)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the regulatory signer reads the composition of the MBR it confirms (DI-13; slice 6 review)'));

insert into iam.role_permission (role_code, permission_code) values ('REGULATORY_SIGNER', 'FORMULA.READ');

select kernel.set_actor_context(null);

revoke execute on function recipe.planning_orders(text) from ebmr_app;

reset role;
