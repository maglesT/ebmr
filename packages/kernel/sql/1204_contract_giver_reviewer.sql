-- Phase 6 slice 6f: the contract giver's reviewer stays read-only (IN-30; Schedule M Part I, contract manufacture and
-- loan licences, paraphrased: the contract giver may review the records of the batches made for it; it never changes
-- them).
--
-- Handbook: modules/kernel.md
--
-- The kernel role CONTRACT_GIVER_REVIEWER (K27, kernel 0120, "read-only access to completed records") gets:
--   * the READ_ONLY permission CONTRACT_GIVER.READ (the batches of the loan licence a live access names; recipe-core 1060
--     scopes and logs the reads) and QA's GMP permission CONTRACT_GIVER_ACCESS.GRANT (QA_REVIEWER) to grant and revoke
--     such an access;
--   * a guard on iam.role_permission: the role holds READ permissions only, whoever adds one (EBMR-IAM-190);
--   * the access itself (recipe-core 1060) is granted only to an account holding READ permissions only, and every read
--     checks that again, as the EU QP's access does (kernel 1160), so a reviewer's account never reaches a write or
--     signing permission while it reads.
-- Every GMP write path asks iam.require_permission for a WRITE, SIGN or ACKNOWLEDGE permission, which such an account
-- never holds (EBMR-IAM-040); the server keeps the role on its own routes (bind.ts).
-- Messages: EBMR-IAM-190.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1204_contract_giver_reviewer)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the contract giver reviewer: scoped, read-only access (IN-30)'));

insert into iam.permission (code, domain, effect, description) values
  ('CONTRACT_GIVER.READ', 'READ_ONLY', 'READ', 'Read the batch records of the loan licence a live contract-giver access names (every read logged)'),
  ('CONTRACT_GIVER_ACCESS.GRANT', 'GMP', 'WRITE', 'Grant or revoke a time-boxed, read-only contract-giver access to the batches of one loan licence');
insert into iam.role_permission (role_code, permission_code) values
  ('CONTRACT_GIVER_REVIEWER', 'CONTRACT_GIVER.READ'),
  ('QA_REVIEWER', 'CONTRACT_GIVER_ACCESS.GRANT');

select kernel.set_actor_context(null);

create function iam.contract_giver_role_permission_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  if new.role_code = 'CONTRACT_GIVER_REVIEWER' and new.removed_at is null
     and (select p.effect from iam.permission p where p.code = new.permission_code) is distinct from 'READ' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-190 IN-30: the contract giver''s reviewer is read-only; %s is not a READ permission', new.permission_code);
  end if;
  return new;
end
$$;
create trigger ab_contract_giver_read_only before insert or update on iam.role_permission
  for each row execute function iam.contract_giver_role_permission_guard();

revoke all on function iam.contract_giver_role_permission_guard() from public;

reset role;
