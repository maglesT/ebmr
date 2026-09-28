-- Recipe core: only the sweeper identity may record a time sweep. The sweep permission now sits in a role of its
-- own (DI-17 least privilege; INV-20).
--
-- 0200 granted EXECUTION.SWEEP to the kernel role SERVICE_ACCOUNT (K28). Every service and integration identity
-- holds that role. In the sandbox that means the sweeper TEST-sweeper (a SERVICE account) and also the site gateway
-- TEST-gw (an INTEGRATION account). An INTEGRATION account may declare source SYSTEM (kernel 0190), so the gateway
-- could record a time sweep. In the other direction, the sweeper held SERVICE_ACCOUNT's INTERFACE.WRITE (kernel
-- 0120) and every other service permission of kernel 0700, and it needs none of them.
--
-- From this migration on:
--   * the role EXECUTION_SWEEPER (group EXECUTION, SERVICE accounts only) holds EXECUTION.SWEEP and nothing else;
--   * SERVICE_ACCOUNT no longer holds EXECUTION.SWEEP. The catalogue row is marked removed, never deleted, so the
--     point-in-time access list (iam.access_list) stays true for the time the row was live;
--   * the sweeper identity is granted EXECUTION_SWEEPER instead of SERVICE_ACCOUNT. The test-kit seed does this
--     like every other grant: an administrator requests it and the process owner approves it. The server's
--     sweeper acts in that role.
-- The kernel never grants EXECUTION_SWEEPER to an INTEGRATION account (role account kinds, EBMR-IAM-036), so the
-- gateway can never hold it. recipe.append_execution needs EXECUTION.SWEEP in the declared role for every SWEEP
-- row (0210), so a context that declares SERVICE_ACCOUNT is refused (EBMR-IAM-040).
--
-- The role and its permission are written under the software-release identity, as in kernel 0700 and recipe-core
-- 0200: outside a command, only a SOFTWARE_RELEASE context adds catalogue rows (EBMR-IAM-039). The removal
-- updates an audited row, so the context carries a reason code and a reason text (EBMR-AUDIT-002).
--
-- This is a new migration because applied migrations are checksummed and never edited. 0200 stays as it was.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0260_execution_sweeper_role)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the time sweep is allowed only to the sweeper identity, through a role of its own (DI-17, INV-20)'));

insert into iam.role (code, name, role_group, description, account_kinds, is_kernel) values
  ('EXECUTION_SWEEPER', 'Execution time sweeper', 'EXECUTION',
   'In-process service that evaluates the time constraints of running batches and records the breaches; never signs, never logs in interactively',
   array['SERVICE'], false);

insert into iam.role_permission (role_code, permission_code) values ('EXECUTION_SWEEPER', 'EXECUTION.SWEEP');

do $$
begin
  update iam.role_permission set removed_at = clock_timestamp()
   where role_code = 'SERVICE_ACCOUNT' and permission_code = 'EXECUTION.SWEEP' and removed_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'SERVICE_ACCOUNT does not hold EXECUTION.SWEEP; recipe-core 0200 did not run as released (DI-17)';
  end if;
  if exists (select 1 from iam.role_permission
             where permission_code = 'EXECUTION.SWEEP' and removed_at is null and role_code <> 'EXECUTION_SWEEPER') then
    raise exception using errcode = 'P0001', message = 'EXECUTION.SWEEP is still held by a role other than EXECUTION_SWEEPER (DI-17, INV-20)';
  end if;
end
$$;

select kernel.set_actor_context(null);

reset role;
