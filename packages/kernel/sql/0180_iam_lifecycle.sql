-- Identity and access (B1), part 9: account and person life cycle (leaver, rehire), installation
-- bootstrap and the directory scan (DI-14, DI-16, INV-11, INV-27 user IDs).
--
-- Deactivation takes effect immediately and in one transaction: the account is disabled, every
-- live grant is revoked at that instant, every session ends, credentials and badges are revoked.
-- A leaver's person record is kept (status LEFT); a rehire reactivates the same person, whose new
-- account needs a new identity verification and a new login name.

set local role ebmr_owner;

create function iam.deactivate_account_internal(p_account uuid, p_reason text, p_session_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  g uuid;
  b uuid;
begin
  if (select status from iam.account where id = p_account) <> 'DISABLED' then
    update iam.account set status = 'DISABLED', status_reason = p_reason where id = p_account;
  end if;
  for g in select id from iam.role_grant where account_id = p_account and status = 'APPROVED' and revoked_at is null loop
    perform iam.revoke_grant_internal(g, 'deactivation: ' || p_reason);
  end loop;
  perform iam.end_account_sessions(p_account, p_session_reason);
  perform iam.revoke_credentials(p_account, 'deactivation: ' || p_reason);
  for b in select id from iam.badge where account_id = p_account and status in ('ISSUED', 'ACTIVE') loop
    update iam.badge set status = 'REVOKED', status_reason = 'deactivation: ' || p_reason where id = b;
  end loop;
end
$$;

-- DI-16: disable an account (for example a leaver event from HR or the identity provider).
create function iam.deactivate_account(p_account uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('IAM.ACCOUNT_MANAGE', '{}'::jsonb);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-004 a reason is required';
  end if;
  if not exists (select 1 from iam.account where id = p_account) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-022 unknown account';
  end if;
  perform iam.deactivate_account_internal(p_account, p_reason, 'ACCOUNT_DISABLED');
end
$$;

create function iam.process_leaver(p_person uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('IAM.PERSON_MANAGE', '{}'::jsonb);
  a       uuid;
  d       uuid;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-004 a reason is required';
  end if;
  update iam.person set status = 'LEFT' where id = p_person and status = 'ACTIVE';
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-011 no active person with that id';
  end if;
  for a in select id from iam.account where person_id = p_person loop
    perform iam.deactivate_account_internal(a, p_reason, 'PERSON_LEFT');
  end loop;
  for d in select id from iam.delegation where (delegate_person = p_person or delegator_person = p_person) and status = 'APPROVED' loop
    update iam.delegation set status = 'REVOKED', revoked_by_person = (v_actor ->> 'person_id')::uuid, revocation_reason = 'leaver: ' || p_reason
     where id = d;
  end loop;
end
$$;

-- Rehire keeps the same person; a new account follows a new identity verification (purpose REHIRE).
create function iam.rehire_person(p_person uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('IAM.PERSON_MANAGE', '{}'::jsonb);
  update iam.person set status = 'ACTIVE' where id = p_person and status = 'LEFT';
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-011 no person who left with that id';
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Installation bootstrap: the first administrator and the first process owner (who approve each
-- other's grants) and their two console devices, created by the deployment pipeline as ebmr_owner.
-- Refused once any grant is approved. Both receive BOOTSTRAP secrets, which are single-use and must
-- be changed before a session can open. The actor of
-- the audit events is the installation pipeline (nil UUIDs, role INSTALLATION_BOOTSTRAP); the
-- identity checks are recorded against the IQ evidence reference, verified by the system identity
-- "Installation qualification".
-- ---------------------------------------------------------------------------------------------

create function iam.bootstrap_installation(p_admin_name text, p_admin_login text, p_admin_verifier text, p_admin_console text,
                                           p_owner_name text, p_owner_login text, p_owner_verifier text, p_owner_console text,
                                           p_site text, p_evidence_ref text, p_site_zone text default 'Asia/Kolkata') returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_nil    uuid := '00000000-0000-0000-0000-000000000000';
  v_prev   text := current_setting('ebmr.ctx', true);
  v_ctx    jsonb;
  v_iq     uuid;
  v_admin  uuid;
  v_owner  uuid;
  v_aacc   uuid := gen_random_uuid();
  v_oacc   uuid := gen_random_uuid();
  v_ag     uuid;
  v_og     uuid;
  v_alogin text := iam.normalize_login_name(p_admin_login);
  v_ologin text := iam.normalize_login_name(p_owner_login);
begin
  if exists (select 1 from iam.role_grant where status in ('APPROVED', 'REVOKED')) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-190 the installation is already bootstrapped';
  end if;
  perform iam.check_verifier(p_admin_verifier);
  perform iam.check_verifier(p_owner_verifier);
  v_ctx := jsonb_build_object('person_id', v_nil, 'account_id', v_nil, 'role_code', 'INSTALLATION_BOOTSTRAP', 'session_id', v_nil,
                              'source', 'SYSTEM', 'site_zone', coalesce(p_site_zone, 'Asia/Kolkata'), 'correlation_id', gen_random_uuid(),
                              'legal_name', 'Installation pipeline', 'reason_code', 'INSTALLATION_BOOTSTRAP',
                              'reason_text', 'installation bootstrap; IQ evidence ' || p_evidence_ref);
  perform iam.set_internal_actor(v_ctx);

  insert into iam.person (kind, legal_name) values ('SYSTEM', 'Installation qualification') returning id into v_iq;
  insert into iam.person (kind, legal_name) values ('NATURAL', btrim(p_admin_name)) returning id into v_admin;
  insert into iam.person (kind, legal_name) values ('NATURAL', btrim(p_owner_name)) returning id into v_owner;
  insert into iam.identity_verification (person_id, purpose, method, document_type, evidence_ref, verified_by_person, verified_by_account, occurred_at)
  values (v_admin, 'INITIAL', 'INSTALLATION_QUALIFICATION', 'IQ protocol', p_evidence_ref, v_iq, v_nil, clock_timestamp()),
         (v_owner, 'INITIAL', 'INSTALLATION_QUALIFICATION', 'IQ protocol', p_evidence_ref, v_iq, v_nil, clock_timestamp());
  insert into iam.issued_identifier (identifier, account_id) values (v_alogin, v_aacc), (v_ologin, v_oacc);
  insert into iam.account (id, person_id, login_name, kind) values (v_aacc, v_admin, v_alogin, 'HUMAN'), (v_oacc, v_owner, v_ologin, 'HUMAN');
  update iam.account set status = 'ACTIVE', status_reason = 'installation bootstrap' where id in (v_aacc, v_oacc);
  insert into iam.role_grant (account_id, person_id, role_code, valid_from, reason, status, requested_by_person, requested_by_account)
  values (v_aacc, v_admin, 'SYSTEM_ADMINISTRATOR', clock_timestamp(), 'installation bootstrap', 'REQUESTED', v_iq, v_nil)
  returning id into v_ag;
  insert into iam.role_grant (account_id, person_id, role_code, valid_from, reason, status, requested_by_person, requested_by_account)
  values (v_oacc, v_owner, 'PROCESS_OWNER', clock_timestamp(), 'installation bootstrap', 'REQUESTED', v_iq, v_nil)
  returning id into v_og;
  update iam.role_grant set status = 'APPROVED', decided_by_person = v_owner, decided_by_account = v_oacc, decision_reason = 'installation bootstrap'
   where id = v_ag;
  update iam.role_grant set status = 'APPROVED', decided_by_person = v_admin, decided_by_account = v_aacc, decision_reason = 'installation bootstrap'
   where id = v_og;
  perform iam.store_credential(v_aacc, 'PASSWORD', 'BOOTSTRAP', p_admin_verifier, v_ctx);
  perform iam.store_credential(v_oacc, 'PASSWORD', 'BOOTSTRAP', p_owner_verifier, v_ctx);
  -- The two administration consoles (PERSONAL devices) the first logins will come from.
  insert into iam.device (code, device_class, site_code, key_fingerprint, description, registered_by_person)
  values ('BOOTSTRAP-CONSOLE-1', 'PERSONAL', p_site, iam.normalize_fingerprint(p_admin_console), 'administration console (installation)', v_iq),
         ('BOOTSTRAP-CONSOLE-2', 'PERSONAL', p_site, iam.normalize_fingerprint(p_owner_console), 'process-owner console (installation)', v_iq);

  perform set_config('ebmr.ctx', coalesce(v_prev, ''), true);
  return jsonb_build_object('admin_person_id', v_admin, 'admin_account_id', v_aacc, 'owner_person_id', v_owner, 'owner_account_id', v_oacc,
                            'installation_person_id', v_iq);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Directory scan (DI-14 "a directory scan finds no generic account holding GMP permissions";
-- INV-11 invariant query). Every row is a finding; a healthy installation returns zero rows.
-- ---------------------------------------------------------------------------------------------

create function iam.directory_scan() returns table (finding text, person_id uuid, account_id uuid, login_name text, role_code text, detail text)
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  with live as (
    select g.*, a.kind, a.is_generic, a.is_break_glass, a.login_name, a.status as account_status
    from iam.role_grant g join iam.account a on a.id = g.account_id
    where iam.grant_is_live(g.status, g.valid_to, g.revoked_at))
  select 'GENERIC_OR_DISPLAY_ACCOUNT_WITH_NON_READ_PERMISSION', l.person_id, l.account_id, l.login_name, l.role_code,
         'DI-14: shared or display account holds a permission that writes, signs, verifies, acknowledges or administers'
  from live l where (l.is_generic or l.kind = 'READONLY_DISPLAY') and iam.role_has_effect(l.role_code, array['WRITE', 'SIGN', 'ACKNOWLEDGE', 'ADMINISTER'], clock_timestamp())
  union all
  select 'SERVICE_ACCOUNT_WITH_SIGN_PERMISSION', l.person_id, l.account_id, l.login_name, l.role_code,
         'DI-14: a service or integration account holds a sign or acknowledge permission'
  from live l where l.kind in ('SERVICE', 'INTEGRATION') and iam.role_has_effect(l.role_code, array['SIGN', 'ACKNOWLEDGE'], clock_timestamp())
  union all
  select 'BREAK_GLASS_WITH_GMP_PERMISSION', l.person_id, l.account_id, l.login_name, l.role_code, 'DI-18'
  from live l where l.is_break_glass and (iam.role_has_domain(l.role_code, 'GMP', clock_timestamp())
                                          or iam.role_has_effect(l.role_code, array['SIGN', 'ACKNOWLEDGE'], clock_timestamp()))
  union all
  select 'ADMINISTRATOR_AND_GMP_ROLE', a.person_id, a.account_id, a.login_name, a.role_code, 'INV-11/DI-18: also holds GMP role ' || b.role_code
  from live a join live b on b.person_id = a.person_id and b.id <> a.id
  where iam.role_has_domain(a.role_code, 'ADMINISTRATION', clock_timestamp()) and iam.role_has_domain(b.role_code, 'GMP', clock_timestamp())
  union all
  select 'MORE_THAN_ONE_GMP_ACCOUNT', a.person_id, null, null, null, 'INV-11: ' || count(*) || ' live GMP-capable accounts'
  from iam.account a where a.gmp_capable and a.status <> 'DISABLED' group by a.person_id having count(*) > 1
  union all
  select 'GRANT_WITHOUT_INDEPENDENT_APPROVER', g.person_id, g.account_id, null, g.role_code, 'DI-16/DI-18'
  from iam.role_grant g where g.status in ('APPROVED', 'REVOKED')
    and (g.decided_by_person in (g.person_id, g.requested_by_person) or g.requested_by_person = g.person_id)
  union all
  select 'LIVE_GRANT_ON_INACTIVE_ACCOUNT', l.person_id, l.account_id, l.login_name, l.role_code, 'DI-16: account ' || l.account_status
  from live l where l.account_status = 'DISABLED'
  union all
  select 'LEFT_PERSON_WITH_LIVE_ACCOUNT', a.person_id, a.id, a.login_name, null, 'DI-16'
  from iam.account a join iam.person p on p.id = a.person_id where p.status = 'LEFT' and a.status <> 'DISABLED'
  union all
  select 'LOGIN_NAME_NOT_IN_REGISTER', a.person_id, a.id, a.login_name, null, 'INV-27'
  from iam.account a left join iam.issued_identifier i on i.identifier = a.login_name
  where i.account_id is distinct from a.id
$$;

grant execute on function iam.deactivate_account(uuid, text), iam.process_leaver(uuid, text), iam.rehire_person(uuid, text),
                          iam.directory_scan() to ebmr_app;
-- bootstrap_installation is for the deployment pipeline (ebmr_owner) only.

reset role;
