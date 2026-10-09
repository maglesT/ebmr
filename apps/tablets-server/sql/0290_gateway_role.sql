-- Tablets server: the site gateway acts in a role of its own that holds only what its work needs (DI-17 least
-- privilege; INV-20).
--
-- The gateway identity (an INTEGRATION account on a SERVER device, 0250) logs in with its service key, binds the
-- session to its enrolled Ed25519 key and then does two things, both in an INTEGRATION command:
--   tab.ingest_reading   stores a signed scale reading      needs INTERFACE.WRITE
--   tab.record_heartbeat stores the instruments' states     needs INTERFACE.WRITE
-- Everything else it calls (tab.bind_gateway_session, tab.resolve_gateway_session, tab.unbind_gateway_session,
-- tab.chain_head, tab.record_gateway_refusal) checks no permission. So INTERFACE.WRITE is the whole of its work.
--
-- Until now the test-kit seed granted the gateway the kernel role SERVICE_ACCOUNT (kernel 0120, 0700). That role
-- holds INTERFACE.WRITE and also RECORD.READ, RECORD.PURGE, RECORD.RETENTION_MANAGE, RECORD.TRUE_COPY_REGISTER,
-- CONTINUITY.BACKUP_RECORD, CONTINUITY.COUNTER_RESERVE, BATCH_NUMBER.REGISTER_EXTERNAL, PLATFORM.TIME_CHECK_RECORD,
-- INCIDENT.RAISE and MARKET.RULE_EVALUATE: the work of the kernel's own service jobs, none of it the gateway's.
--
-- From this migration on the role SITE_GATEWAY (group EXECUTION, INTEGRATION accounts only) holds INTERFACE.WRITE
-- and nothing else. The gateway identity is granted SITE_GATEWAY instead of SERVICE_ACCOUNT; the test-kit seed does
-- this like every other grant (an administrator requests it, the process owner approves it). SERVICE_ACCOUNT
-- itself is unchanged: the kernel's service jobs still use it. The kernel never grants SITE_GATEWAY to a SERVICE or
-- HUMAN account (role account kinds, EBMR-IAM-036), so the sweeper can never hold it, as the gateway can never hold
-- EXECUTION_SWEEPER (recipe-core 0260).
--
-- The database, not only the listener, ties the gateway's work to that role. tab.actor_gateway_key (0250), which
-- tab.ingest_reading and tab.record_heartbeat call for the bound gateway session behind their command, now also
-- refuses a command that does not act in SITE_GATEWAY (EBMR-DEV-032). An account may hold more than one role, and
-- the kernel accepts any role the account holds (EBMR-IAM-108): a gateway identity that still holds SERVICE_ACCOUNT
-- (an installation seeded before this migration) could otherwise send readings with all of that role's
-- permissions in its context. Such an installation grants its gateway identity SITE_GATEWAY through the usual
-- request and approval, and revokes SERVICE_ACCOUNT from it; until then its readings and heartbeats are refused.
-- This migration grants and revokes nothing itself: a grant needs its request and its approval (DI-17).
--
-- The role and its permission are written under the software-release identity, as in kernel 0700 and recipe-core
-- 0260: outside a command, only a SOFTWARE_RELEASE context adds catalogue rows (EBMR-IAM-039). Both rows are
-- inserts, audited in the chain iam_role:SITE_GATEWAY with the release's reason.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 0290_gateway_role)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the site gateway uploads readings through a role of its own that holds only interface write (DI-17, INV-20)'));

insert into iam.role (code, name, role_group, description, account_kinds, is_kernel) values
  ('SITE_GATEWAY', 'Site gateway', 'EXECUTION',
   'Equipment gateway of the site: uploads signed instrument readings and heartbeats through the interface; never signs, never logs in interactively',
   array['INTEGRATION'], false);

insert into iam.role_permission (role_code, permission_code) values ('SITE_GATEWAY', 'INTERFACE.WRITE');

do $$
begin
  if iam.role_permissions_at('SITE_GATEWAY', clock_timestamp()) is distinct from array['INTERFACE.WRITE'] then
    raise exception using errcode = 'P0001', message = 'SITE_GATEWAY must hold INTERFACE.WRITE and nothing else (DI-17, INV-20)';
  end if;
end
$$;

select kernel.set_actor_context(null);

-- The enrolment behind the validated actor's gateway session (inside an INTEGRATION command), and only in the role
-- SITE_GATEWAY. As in 0250 apart from the role check; CREATE OR REPLACE keeps owner, SECURITY DEFINER, search_path
-- and privileges (none for PUBLIC or ebmr_app: only the definers tab.ingest_reading and tab.record_heartbeat call it).
create or replace function tab.actor_gateway_key() returns tab.gateway_key
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_key   tab.gateway_key%rowtype;
begin
  if v_actor ->> 'source' <> 'INTEGRATION' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-030 DI-31: readings and heartbeats come only from an INTEGRATION identity';
  end if;
  select k.* into v_key from tab.gateway_session b join tab.gateway_key k on k.id = b.gateway_key_id
   where b.session_id = (v_actor ->> 'session_id')::uuid and b.unbound_at is null and k.status = 'ACTIVE';
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-031 the session is not a bound gateway session with an active key';
  end if;
  -- DI-17 least privilege (0290): never in a broader role the gateway's account may also hold.
  if (v_actor ->> 'role_code') is distinct from 'SITE_GATEWAY' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-032 DI-17: gateway %s sends readings and heartbeats only in the role SITE_GATEWAY (interface write and nothing else); this command acts as %s',
                       v_key.gateway_code, coalesce(v_actor ->> 'role_code', 'no role'));
  end if;
  return v_key;
end
$$;

reset role;
