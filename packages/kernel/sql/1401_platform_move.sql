-- Phase B slice 6 (docs/build-plan/phase-b/platform-move-plan.md, "Data move"; PL-01, PL-03, PL-13): the move of a
-- standalone installation onto the platform maps each person it moves to core's employee id. The sign-on sync
-- (iam.platform_sync_grants, 1400) refuses a login issued before (INV-27), so a moved person is found by that map at
-- their first platform sign-on, keeps their person and account (signatures, audit and records reference them), and gets
-- the codes core grants through the two mirror roles.
--
-- Handbook: modules/kernel.md
--
--   iam.platform_map_existing(employee_id, login, account_id, move_ref)
--                              the move only (superuser; nobody else may), on the platform build: the map row of an
--                              existing human account under its core login (the old login, or u + it when it starts
--                              with a digit), its two mirror roles, and every role grant it still holds
--                              revoked (on the platform build its codes come from core alone, PL-01). Refused for an
--                              account that is not human, or a person or employee id already mapped.

set local role ebmr_owner;

create function iam.platform_map_existing(p_employee_id text, p_login text, p_account_id uuid, p_move_ref text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_nil  uuid := '00000000-0000-0000-0000-000000000000';
  v_mode iam.platform_mode;
  v_acc  iam.account;
  v_n    text;
  v_prev jsonb := kernel.current_actor();
begin
  select * into v_mode from iam.platform_mode;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-300 this is not a platform build; the move maps people onto a platform build only';
  end if;
  select * into v_acc from iam.account where id = p_account_id;
  if not found or v_acc.kind <> 'HUMAN' then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-305 account %s is not a human account of this installation', p_account_id);
  end if;
  if exists (select 1 from iam.platform_identity where employee_id = p_employee_id or account_id = p_account_id or person_id = v_acc.person_id
                                                   or login_name = iam.normalize_login_name(p_login)) then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-305 employee %s or account %s is mapped already (PL-03)', p_employee_id, p_account_id);
  end if;
  perform iam.set_internal_actor(jsonb_build_object(
    'person_id', v_mode.register_person, 'account_id', v_nil, 'role_code', 'PLATFORM_SIGN_ON', 'session_id', v_nil, 'source', 'SYSTEM',
    'site_zone', iam.policy_text('site.zone'), 'correlation_id', gen_random_uuid(), 'legal_name', 'Platform core: permission register',
    'reason_code', 'PLATFORM_MOVE', 'reason_text', 'moved onto the platform (' || p_move_ref || ')', 'platform_ref', p_move_ref));
  v_n := upper(replace(v_acc.id::text, '-', ''));
  insert into iam.platform_identity (employee_id, person_id, account_id, login_name, work_role, admin_role)
  values (p_employee_id, v_acc.person_id, v_acc.id, iam.normalize_login_name(p_login), 'PLATFORM_' || v_n || '_WORK', 'PLATFORM_' || v_n || '_ADMIN');
  insert into iam.role (code, name, role_group, description, account_kinds)
  values ('PLATFORM_' || v_n || '_WORK', 'Work', 'EXECUTION', 'Platform codes of ' || v_acc.login_name || ': GMP, governance and read-only work', array['HUMAN']),
         ('PLATFORM_' || v_n || '_ADMIN', 'Administration', 'ADMINISTRATION_SECURITY', 'Platform codes of ' || v_acc.login_name || ': administration', array['HUMAN']);
  update iam.role_grant
     set status = 'REVOKED', revoked_by_person = v_mode.register_person, revoked_by_account = v_nil,
         revocation_reason = 'moved onto the platform: the codes come from core (PL-01; ' || p_move_ref || ')'
   where account_id = v_acc.id and iam.grant_is_live(status, valid_to, revoked_at);
  perform kernel.set_actor_context(v_prev);
end
$$;

revoke all on function iam.platform_map_existing(text, text, uuid, text) from public;

reset role;
