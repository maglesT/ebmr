-- Phase B slice 2 (docs/build-plan/phase-b/slice-2-design.md, approved by the lead on 3 Nov 2026): sign-on, permissions
-- and e-signature through the platform's core on the platform build. Core's token becomes the data the kernel's access
-- checks already read, so evaluate_authority, can_sign, validate_actor_context, assert_not_administrator, the static
-- segregation, open_session, consume_auth_event and esig.sign all run unchanged.
--
-- Handbook: modules/kernel.md
--
--   iam.platform_mode          one row, insert-only: the platform build is on (set once by the platform migrator,
--                              iam.enable_platform_build(); never switched off). It names the two SYSTEM identities that
--                              record core's decisions: the permission register (requests, revocations, identity checks)
--                              and the sign-on (approvals): two different persons, as every grant needs (DI-16).
--   iam.platform_build()       is the platform build on (the server switches local credentials off with it)
--   iam.platform_identity      insert-only id map: core's employee id ↔ person, account, login, and the person's two mirror
--                              roles PLATFORM_<n>_WORK (GMP, GOVERNANCE and READ_ONLY codes) and PLATFORM_<n>_ADMIN
--                              (ADMINISTRATION codes). Neither role mixes the two domains (INV-11, DI-18).
--   iam.platform_proof_use     insert-only: the one-time nonces of core's sign-on proofs, each used once
--   iam.platform_sync_grants(employee_id, login, legal_name, codes, grant_ref, fingerprint)
--                              ebmr_authn only, after core's token was verified: finds or creates the person (identity
--                              verified at core, PL-03), maps the token's ebmr.* codes back to today's codes and brings
--                              the two mirror roles and their APPROVED grants in line with them, through the kernel's own
--                              request and approval rows (a removed code is removed, a role left without codes has its
--                              grant revoked). Refused (and every mirror grant revoked) when the token holds no Batchwright
--                              code (PL-01) or holds administration and GMP codes together (INV-11: never both, for one
--                              person).
--   iam.platform_auth_event(employee_id, purpose, challenge, fingerprint, auth_time, nonce)
--                              ebmr_authn only: core's sign-on as an ordinary authentication event, method PLATFORM with
--                              components USER_ID and PASSWORD (core asked for both; PL-05), for LOGIN or SIGNATURE. A
--                              SIGNATURE event is bound to its challenge and made only when core's re-authentication
--                              (auth_time) is not earlier than the challenge (DI-38); the proof's nonce is used once.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- The platform build
-- ---------------------------------------------------------------------------------------------

create table iam.platform_mode (
  one              boolean primary key default true check (one),
  register_person  uuid not null references iam.person (id),
  signon_person    uuid not null references iam.person (id),
  enabled_at       timestamptz not null default clock_timestamp(),
  enabled_by       text not null default session_user,
  check (register_person <> signon_person)
);
select iam.protect_log('iam.platform_mode');

create function iam.platform_build() returns boolean
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select exists (select 1 from iam.platform_mode)
$$;

-- The platform migrator runs it once, at the end of its run (superuser; nobody else may).
create function iam.enable_platform_build() returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_nil  uuid := '00000000-0000-0000-0000-000000000000';
  v_prev jsonb := kernel.current_actor();
  v_reg  uuid;
  v_sign uuid;
begin
  if iam.platform_build() then
    return;
  end if;
  perform iam.set_internal_actor(jsonb_build_object(
    'person_id', v_nil, 'account_id', v_nil, 'role_code', 'PLATFORM_SIGN_ON', 'session_id', v_nil, 'source', 'SYSTEM',
    'site_zone', iam.policy_text('site.zone'), 'correlation_id', gen_random_uuid(), 'legal_name', 'Platform migrator',
    'reason_code', 'PLATFORM_BUILD', 'reason_text', 'the platform build is switched on (Phase B slice 2)'));
  insert into iam.person (kind, legal_name) values ('SYSTEM', 'Platform core: permission register') returning id into v_reg;
  insert into iam.person (kind, legal_name) values ('SYSTEM', 'Platform core: sign-on') returning id into v_sign;
  insert into iam.platform_mode (register_person, signon_person) values (v_reg, v_sign);
  perform kernel.set_actor_context(v_prev);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Core's methods in the kernel's vocabulary
-- ---------------------------------------------------------------------------------------------

alter table iam.auth_event drop constraint auth_event_method_check;
alter table iam.auth_event add constraint auth_event_method_check check (method in ('PASSWORD', 'BADGE_PIN', 'BADGE_TAP', 'SERVICE_KEY', 'PLATFORM'));
-- PL-05: core asks for the user ID and the password; a PLATFORM event never claims anything else.
alter table iam.auth_event add constraint auth_event_platform_components
  check (method <> 'PLATFORM' or (components = array['USER_ID', 'PASSWORD'] and purpose in ('LOGIN', 'SIGNATURE') and not restricted));

alter table iam.identity_verification drop constraint identity_verification_method_check;
alter table iam.identity_verification add constraint identity_verification_method_check
  check (method in ('IN_PERSON_DOCUMENT', 'HR_ONBOARDING_RECORD', 'VIDEO_WITH_DOCUMENT', 'INSTALLATION_QUALIFICATION', 'PLATFORM_IDENTITY'));

-- ---------------------------------------------------------------------------------------------
-- The id map and the proof nonces
-- ---------------------------------------------------------------------------------------------

create table iam.platform_identity (
  id           bigint generated always as identity primary key,
  employee_id  text not null unique check (btrim(employee_id) <> '' and length(employee_id) <= 128),
  person_id    uuid not null unique references iam.person (id),
  account_id   uuid not null unique,
  login_name   text not null unique,
  -- The map row is written before its roles, so the change-control guard below can recognise them (deferred keys).
  work_role    text not null unique references iam.role (code) deferrable initially deferred,
  admin_role   text not null unique references iam.role (code) deferrable initially deferred,
  created_at   timestamptz not null default clock_timestamp(),
  foreign key (account_id, person_id) references iam.account (id, person_id)
);
select iam.protect_log('iam.platform_identity');

create table iam.platform_proof_use (
  nonce_sha256   text primary key check (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  employee_id    text not null,
  purpose        text not null,
  auth_event_id  uuid references iam.auth_event (id),
  used_at        timestamptz not null default clock_timestamp()
);
select iam.protect_log('iam.platform_proof_use');

-- ---------------------------------------------------------------------------------------------
-- Grants from the token
-- ---------------------------------------------------------------------------------------------

-- 'ebmr.step.execute' → 'STEP.EXECUTE'; anything else (another product's code, a malformed one) → null.
create function iam.platform_code_to_permission(p_code text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p_code ~ '^ebmr\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' then upper(substr(p_code, 6)) end
$$;

-- Brings one mirror role's live permissions to p_wanted. p_phase 'REMOVE' takes away what the token no longer holds and
-- revokes the grant of a role left empty; 'ADD' adds what is new, each through a request of the register approved by the
-- sign-on (the kernel's own two-person path, iam.role_permission_guard), and approves a grant when the role holds codes.
create function iam.platform_mirror_role(p_mode iam.platform_mode, p_ident iam.platform_identity, p_role text, p_wanted text[],
                                         p_phase text, p_grant_ref text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_nil   uuid := '00000000-0000-0000-0000-000000000000';
  v_code  text;
  v_req   uuid;
  v_rp    uuid;
  v_grant uuid;
begin
  if p_phase = 'REMOVE' then
    update iam.role_permission set removed_at = clock_timestamp()
     where role_code = p_role and removed_at is null and not (permission_code = any (p_wanted));
    if cardinality(p_wanted) = 0 then
      update iam.role_grant
         set status = 'REVOKED', revoked_by_person = p_mode.register_person, revoked_by_account = v_nil,
             revocation_reason = 'the platform token holds no code of this role any more (' || p_grant_ref || ')'
       where account_id = p_ident.account_id and role_code = p_role and iam.grant_is_live(status, valid_to, revoked_at);
    end if;
    return;
  end if;
  foreach v_code in array p_wanted loop
    if not exists (select 1 from iam.role_permission where role_code = p_role and permission_code = v_code and removed_at is null) then
      insert into iam.role_permission_request (role_code, permission_code, reason, status, requested_by_person, requested_by_account)
      values (p_role, v_code, 'granted at the platform (' || p_grant_ref || ')', 'REQUESTED', p_mode.register_person, v_nil)
      returning id into v_req;
      v_rp := gen_random_uuid();
      update iam.role_permission_request
         set status = 'APPROVED', decided_by_person = p_mode.signon_person, decided_by_account = v_nil,
             decision_reason = 'verified platform sign-on token', role_permission_id = v_rp
       where id = v_req;
      insert into iam.role_permission (id, role_code, permission_code) values (v_rp, p_role, v_code);
    end if;
  end loop;
  if cardinality(p_wanted) > 0 and not exists (
       select 1 from iam.role_grant g where g.account_id = p_ident.account_id and g.role_code = p_role
         and iam.grant_is_live(g.status, g.valid_to, g.revoked_at)) then
    insert into iam.role_grant (account_id, person_id, role_code, valid_from, reason, status, requested_by_person, requested_by_account)
    values (p_ident.account_id, p_ident.person_id, p_role, clock_timestamp(), 'granted at the platform (' || p_grant_ref || ')', 'REQUESTED',
            p_mode.register_person, v_nil)
    returning id into v_grant;
    update iam.role_grant set status = 'APPROVED', decided_by_person = p_mode.signon_person, decided_by_account = v_nil,
                              decision_reason = 'verified platform sign-on token'
     where id = v_grant;
  end if;
end
$$;

create function iam.platform_sync_grants(p_employee_id text, p_login text, p_legal_name text, p_codes text[], p_grant_ref text,
                                         p_fingerprint text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_nil     uuid := '00000000-0000-0000-0000-000000000000';
  v_prev    jsonb := kernel.current_actor();
  v_mode    iam.platform_mode;
  v_ident   iam.platform_identity;
  v_emp     text := btrim(coalesce(p_employee_id, ''));
  v_name    text := btrim(coalesce(p_legal_name, ''));
  v_ref     text := left(coalesce(nullif(btrim(p_grant_ref), ''), 'platform sign-on'), 200);
  v_login   text;
  v_person  uuid;
  v_account uuid := gen_random_uuid();
  v_n       bigint;
  v_known   text[];
  v_ignored text[];
  v_work    text[];
  v_admin   text[];
  v_refusal text;
begin
  select * into v_mode from iam.platform_mode;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-300 this is not a platform build; sign in with the installation''s own credentials';
  end if;
  if v_emp = '' or length(v_emp) > 128 or v_name = '' or length(v_name) > 200 then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-301 the platform token names the employee id and the person''s name';
  end if;
  v_login := iam.normalize_login_name(p_login);

  -- Today's codes the token holds, each once; everything else is ignored and reported.
  select coalesce(array_agg(distinct p.code order by p.code), '{}') into v_known
    from unnest(coalesce(p_codes, '{}')) c join iam.permission p on p.code = iam.platform_code_to_permission(c);
  select coalesce(array_agg(distinct c order by c), '{}') into v_ignored
    from unnest(coalesce(p_codes, '{}')) c
   where not exists (select 1 from iam.permission p where p.code = iam.platform_code_to_permission(c));
  select coalesce(array_agg(p.code order by p.code) filter (where p.domain <> 'ADMINISTRATION'), '{}'),
         coalesce(array_agg(p.code order by p.code) filter (where p.domain = 'ADMINISTRATION'), '{}')
    into v_work, v_admin
    from iam.permission p where p.code = any (v_known);
  v_refusal := case
    when cardinality(v_known) = 0 then 'NO_BATCHWRIGHT_CODE'
    when cardinality(v_admin) > 0 and exists (select 1 from iam.permission p where p.code = any (v_work) and p.domain = 'GMP') then 'ADMINISTRATION_AND_GMP'
  end;

  perform pg_advisory_xact_lock(hashtextextended('iam.platform_identity:' || v_emp, 0));
  select * into v_ident from iam.platform_identity where employee_id = v_emp;
  if not found and v_refusal is not null then
    insert into iam.authn_attempt (method, purpose, identifier_hash, device_fingerprint, outcome, reason)
    values ('PLATFORM', 'LOGIN', sha256(convert_to(v_login, 'UTF8')), iam.normalize_fingerprint(p_fingerprint), 'REFUSED', v_refusal);
    return jsonb_build_object('status', 'REFUSED', 'code', 'EBMR-IAM-302', 'reason', v_refusal);
  end if;
  if found and v_ident.login_name <> v_login then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-303 PL-03: employee %s signs in here as %s; a login is never changed or reused', v_emp, v_ident.login_name);
  end if;

  perform iam.set_internal_actor(jsonb_build_object(
    'person_id', v_mode.register_person, 'account_id', v_nil, 'role_code', 'PLATFORM_SIGN_ON', 'session_id', v_nil, 'source', 'SYSTEM',
    'site_zone', iam.policy_text('site.zone'), 'correlation_id', gen_random_uuid(), 'legal_name', 'Platform core: permission register',
    'reason_code', 'PLATFORM_SIGN_ON', 'reason_text', 'codes from the verified platform sign-on token (' || v_ref || ')',
    'platform_ref', v_ref));

  if v_ident.id is null then
    -- First sign-on (PL-03): a natural person with one human account, identity verified at core. The login is core's and,
    -- like every login here, is never issued twice (INV-27).
    if exists (select 1 from iam.issued_identifier where identifier = v_login) or exists (select 1 from iam.reserved_identifier where identifier = v_login) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-IAM-021 login name %s was issued before and is never issued again; the move maps existing people to core (slice 6)', v_login);
    end if;
    insert into iam.person (kind, legal_name) values ('NATURAL', v_name) returning id into v_person;
    insert into iam.identity_verification (person_id, purpose, method, document_type, evidence_ref, verified_by_person, verified_by_account, occurred_at)
    values (v_person, 'INITIAL', 'PLATFORM_IDENTITY', 'Platform core identity (PL-03)', 'core employee ' || v_emp, v_mode.register_person, v_nil, clock_timestamp());
    insert into iam.issued_identifier (identifier, account_id) values (v_login, v_account);
    insert into iam.account (id, person_id, login_name, kind) values (v_account, v_person, v_login, 'HUMAN');
    update iam.account set status = 'ACTIVE', status_reason = 'first platform sign-on' where id = v_account;
    v_n := nextval(pg_get_serial_sequence('iam.platform_identity', 'id'));
    insert into iam.platform_identity (id, employee_id, person_id, account_id, login_name, work_role, admin_role)
      overriding system value
    values (v_n, v_emp, v_person, v_account, v_login, 'PLATFORM_' || v_n || '_WORK', 'PLATFORM_' || v_n || '_ADMIN')
    returning * into v_ident;
    insert into iam.role (code, name, role_group, description, account_kinds)
    values (v_ident.work_role, 'Work', 'EXECUTION', 'Platform codes of ' || v_login || ': GMP, governance and read-only work', array['HUMAN']),
           (v_ident.admin_role, 'Administration', 'ADMINISTRATION_SECURITY', 'Platform codes of ' || v_login || ': administration', array['HUMAN']);
  elsif (select legal_name from iam.person where id = v_ident.person_id) <> v_name then
    update iam.person set legal_name = v_name where id = v_ident.person_id;
  end if;

  if v_refusal is not null then
    -- PL-01 and INV-11: no authority from such a token, and none left from an earlier one.
    perform iam.platform_mirror_role(v_mode, v_ident, v_ident.work_role, '{}', 'REMOVE', v_ref);
    perform iam.platform_mirror_role(v_mode, v_ident, v_ident.admin_role, '{}', 'REMOVE', v_ref);
    perform kernel.set_actor_context(v_prev);
    insert into iam.authn_attempt (method, purpose, identifier_hash, account_id, device_fingerprint, outcome, reason)
    values ('PLATFORM', 'LOGIN', sha256(convert_to(v_login, 'UTF8')), v_ident.account_id, iam.normalize_fingerprint(p_fingerprint), 'REFUSED', v_refusal);
    return jsonb_build_object('status', 'REFUSED', 'code', 'EBMR-IAM-302', 'reason', v_refusal, 'person_id', v_ident.person_id, 'account_id', v_ident.account_id);
  end if;

  -- What the token no longer holds goes first, so no step ever holds more than the old or the new token gave.
  perform iam.platform_mirror_role(v_mode, v_ident, v_ident.work_role, v_work, 'REMOVE', v_ref);
  perform iam.platform_mirror_role(v_mode, v_ident, v_ident.admin_role, v_admin, 'REMOVE', v_ref);
  perform iam.platform_mirror_role(v_mode, v_ident, v_ident.work_role, v_work, 'ADD', v_ref);
  perform iam.platform_mirror_role(v_mode, v_ident, v_ident.admin_role, v_admin, 'ADD', v_ref);
  perform kernel.set_actor_context(v_prev);
  return jsonb_build_object('status', 'OK', 'person_id', v_ident.person_id, 'account_id', v_ident.account_id, 'login_name', v_ident.login_name,
                            'work_role', case when cardinality(v_work) > 0 then v_ident.work_role end,
                            'admin_role', case when cardinality(v_admin) > 0 then v_ident.admin_role end,
                            'work', to_jsonb(v_work), 'admin', to_jsonb(v_admin), 'ignored', to_jsonb(v_ignored));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Core's sign-ons as authentication events
-- ---------------------------------------------------------------------------------------------

create function iam.platform_auth_event(p_employee_id text, p_purpose text, p_challenge uuid, p_fingerprint text, p_auth_time timestamptz,
                                        p_nonce text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, esig, pg_temp as $$
declare
  v_fp     text := iam.normalize_fingerprint(p_fingerprint);
  v_ident  iam.platform_identity;
  v_dev    iam.device%rowtype;
  v_acc    iam.account%rowtype;
  v_person iam.person%rowtype;
  v_ch     esig.challenge%rowtype;
  v_hash   bytea;
  v_ctx    jsonb;
  v_reason text;
  v_event  uuid;
  v_max    interval := make_interval(secs => iam.policy_int('authn.event_max_age_seconds'));
begin
  if not iam.platform_build() then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-300 this is not a platform build; sign in with the installation''s own credentials';
  end if;
  if p_purpose not in ('LOGIN', 'SIGNATURE') then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-096 a platform sign-on cannot be used for %s', p_purpose);
  end if;
  if (p_purpose = 'SIGNATURE') <> (p_challenge is not null) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-094 a signature authentication is bound to exactly one challenge; other purposes take none';
  end if;
  if p_nonce is null or length(p_nonce) < 16 or length(p_nonce) > 256 then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-304 the platform proof carries no valid nonce';
  end if;
  -- The proof is used once, whatever comes of it (a refused use spends it too).
  begin
    insert into iam.platform_proof_use (nonce_sha256, employee_id, purpose)
    values (encode(sha256(convert_to(p_nonce, 'UTF8')), 'hex'), coalesce(p_employee_id, ''), p_purpose);
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-091 the platform proof has already been used';
  end;

  select * into v_ident from iam.platform_identity where employee_id = btrim(coalesce(p_employee_id, ''));
  v_hash := sha256(convert_to(coalesce(v_ident.login_name, btrim(coalesce(p_employee_id, ''))), 'UTF8'));
  v_ctx := jsonb_build_object('method', 'PLATFORM', 'purpose', p_purpose, 'identifier_hash', encode(v_hash, 'hex'), 'fingerprint', v_fp);
  select * into v_dev from iam.device where key_fingerprint = v_fp;
  if not found then
    return iam.authn_record_refusal(v_ctx || jsonb_build_object('reason', 'UNREGISTERED_DEVICE', 'alert', 'UNREGISTERED_DEVICE', 'severity', 'HIGH'));
  end if;
  v_ctx := v_ctx || jsonb_build_object('device_id', v_dev.id);
  if v_dev.status <> 'ACTIVE' then
    return iam.authn_record_refusal(v_ctx || jsonb_build_object('reason', 'DEVICE_' || v_dev.status, 'alert', 'BLOCKED_DEVICE_USE', 'severity', 'HIGH'));
  end if;
  if v_dev.device_class in ('INSTRUMENT', 'SERVER') then
    return iam.authn_record_refusal(v_ctx || jsonb_build_object('reason', 'DEVICE_CLASS_MISUSE', 'alert', 'DEVICE_CLASS_MISUSE', 'severity', 'HIGH'));
  end if;
  if v_ident.id is null then
    return iam.authn_record_refusal(v_ctx || jsonb_build_object('reason', 'UNKNOWN_IDENTIFIER', 'alert', 'UNKNOWN_IDENTIFIER', 'severity', 'MEDIUM'));
  end if;
  select * into v_acc from iam.account where id = v_ident.account_id for update;
  select * into v_person from iam.person where id = v_acc.person_id;
  v_ctx := v_ctx || jsonb_build_object('account_id', v_acc.id, 'person_id', v_acc.person_id);
  if v_acc.status <> 'ACTIVE' or v_person.status <> 'ACTIVE' then
    return iam.authn_record_refusal(v_ctx || jsonb_build_object('reason', 'ACCOUNT_' || case when v_person.status <> 'ACTIVE' then 'PERSON_LEFT' else v_acc.status end,
                                                               'alert', 'DISABLED_ACCOUNT_USE', 'severity', 'HIGH'));
  end if;
  if iam.account_locked(v_acc.id) then
    return iam.authn_record_refusal(v_ctx || jsonb_build_object('reason', 'ACCOUNT_LOCKED', 'alert', 'LOCKED_ACCOUNT_USE', 'severity', 'HIGH'));
  end if;

  -- When core authenticated the person: not in the future, not older than an authentication event may be (core's auth_time
  -- has whole seconds).
  v_reason := case when p_auth_time is null then 'AUTH_TIME_MISSING'
                   when p_auth_time > clock_timestamp() + interval '60 seconds' then 'AUTH_TIME_IN_FUTURE'
                   when clock_timestamp() - p_auth_time > v_max then 'AUTH_TOO_OLD' end;
  if v_reason is null and p_purpose = 'SIGNATURE' then
    select * into v_ch from esig.challenge where id = p_challenge;
    -- DI-38: core re-authenticated the signer for this challenge: the signer's own account, on the challenge's terminal,
    -- not before the challenge was issued and not after it expired.
    v_reason := case when not found then 'CHALLENGE_UNKNOWN'
                     when v_ch.signer_person <> v_acc.person_id or v_ch.signer_account <> v_acc.id then 'CHALLENGE_OF_ANOTHER_SIGNER'
                     when v_ch.device_id <> v_dev.id then 'CHALLENGE_ON_ANOTHER_TERMINAL'
                     when p_auth_time < date_trunc('second', v_ch.recorded_at) then 'AUTH_BEFORE_CHALLENGE'
                     when v_ch.expires_at <= clock_timestamp() then 'CHALLENGE_EXPIRED' end;
  end if;
  if v_reason is not null then
    return iam.authn_record_refusal(v_ctx || jsonb_build_object('reason', v_reason,
             'alert', case when p_purpose = 'SIGNATURE' then 'SIGNING_FAILED' else 'AUTHENTICATION_FAILED' end, 'severity', 'MEDIUM'));
  end if;

  insert into iam.auth_event (person_id, account_id, device_id, device_class, method, components, purpose, challenge_id)
  values (v_acc.person_id, v_acc.id, v_dev.id, v_dev.device_class, 'PLATFORM', array['USER_ID', 'PASSWORD'], p_purpose, p_challenge)
  returning id into v_event;
  insert into iam.authn_attempt (method, purpose, identifier_hash, account_id, device_id, device_fingerprint, outcome, reason, auth_event_id)
  values ('PLATFORM', p_purpose, v_hash, v_acc.id, v_dev.id, v_fp, 'SUCCESS', 'OK', v_event);
  return jsonb_build_object('status', 'OK', 'auth_event_id', v_event, 'person_id', v_acc.person_id, 'account_id', v_acc.id,
                            'device_id', v_dev.id, 'device_class', v_dev.device_class, 'purpose', p_purpose, 'restricted', false,
                            'components', jsonb_build_array('USER_ID', 'PASSWORD'));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- DI-09 change control for the mirror roles (owner-approved lead decision of 3 Nov 2026,
-- docs/decisions/0028-platform-mirror-roles.md)
--
-- A mirror role and its permissions are one person's grant from core's permission register (PL-02), not site
-- configuration. They pass the ROLE and ROLE_PERMISSION change-control guard without a change record only when ALL of
-- these hold: this is a platform build; the actor is core's permission register as iam.platform_sync_grants installs it
-- (the register's SYSTEM person, role PLATFORM_SIGN_ON, source SYSTEM, the zero session, core's grant reference; no
-- command a person starts can carry it, because kernel.validate_actor_context needs a live session of the actor and
-- kernel.set_actor_context is the owner's); and the row's role is a mirror role of iam.platform_identity. Each such row
-- is still a configuration version (basis PLATFORM_REGISTER, with the register's person and core's grant reference).
-- Every other write of a role or a role permission, customer roles and a write that imitates a mirror role outside the
-- sync alike, still needs an approved change record.
-- ---------------------------------------------------------------------------------------------

alter table platform.config_version drop constraint config_version_basis_check;
alter table platform.config_version add constraint config_version_basis_check
  check (basis in ('CHANGE_RECORD', 'RELEASE', 'BEFORE_CONTROL', 'PLATFORM_REGISTER'));
alter table platform.config_version add column platform_ref text;
alter table platform.config_version add constraint config_version_platform_ref
  check ((basis = 'PLATFORM_REGISTER') = (platform_ref is not null and person_id is not null));

create function platform.is_platform_register_write(p_area text, p_ctx jsonb, p_row jsonb) returns boolean
language sql stable security definer set search_path = pg_catalog, platform, iam, pg_temp as $$
  select p_area in ('ROLE', 'ROLE_PERMISSION') and p_ctx is not null
     and coalesce(p_ctx ->> 'role_code' = 'PLATFORM_SIGN_ON' and p_ctx ->> 'source' = 'SYSTEM'
                  and p_ctx ->> 'session_id' = '00000000-0000-0000-0000-000000000000'
                  and nullif(btrim(p_ctx ->> 'platform_ref'), '') is not null, false)
     and exists (select 1 from iam.platform_mode m where m.register_person::text = p_ctx ->> 'person_id')
     and exists (select 1 from iam.platform_identity i
                 where coalesce(p_row ->> case p_area when 'ROLE' then 'code' else 'role_code' end, '') in (i.work_role, i.admin_role))
$$;

create or replace function platform.config_change_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx jsonb := kernel.current_actor();
begin
  if v_ctx is not null and platform.is_release_actor(v_ctx) then
    return new;
  end if;
  if platform.is_platform_register_write(tg_argv[0], v_ctx, to_jsonb(new)) then
    return new;
  end if;
  perform platform.require_change_record(tg_argv[0], format('%s on %s', lower(tg_op), tg_relid::regclass));
  return new;
end
$$;

create or replace function platform.config_version_log() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  a      platform.config_area;
  v_ctx  jsonb := kernel.current_actor();
  v_row  jsonb := to_jsonb(new);
  v_rel  boolean := platform.is_release_actor(v_ctx);
  v_reg  boolean;
  v_cr   uuid;
  v_from timestamptz;
begin
  select * into a from platform.config_area where code = tg_argv[0];
  v_reg := not v_rel and platform.is_platform_register_write(a.code, v_ctx, v_row);
  if not v_rel and not v_reg then
    v_cr := platform.require_change_record(a.code, format('%s on %s', lower(tg_op), tg_relid::regclass));
  end if;
  v_from := case when tg_op = 'UPDATE' or a.valid_from_column is null then clock_timestamp()
                 else coalesce((v_row ->> a.valid_from_column)::timestamptz, clock_timestamp()) end;
  insert into platform.config_version (area, item_key, value, valid_from, source_row, basis, change_record_id, person_id, platform_ref)
  values (a.code, platform.config_item_key(a, v_row), platform.config_item_value(a, v_row), v_from, v_row,
          case when v_rel then 'RELEASE' when v_reg then 'PLATFORM_REGISTER' else 'CHANGE_RECORD' end, v_cr,
          case when v_rel then null else (v_ctx ->> 'person_id')::uuid end,
          case when v_reg then v_ctx ->> 'platform_ref' end);
  return null;
end
$$;

revoke all on function platform.is_platform_register_write(text, jsonb, jsonb) from public;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on table iam.platform_mode, iam.platform_identity, iam.platform_proof_use from public;
revoke all on function iam.platform_build(), iam.enable_platform_build(), iam.platform_code_to_permission(text),
  iam.platform_mirror_role(iam.platform_mode, iam.platform_identity, text, text[], text, text),
  iam.platform_sync_grants(text, text, text, text[], text, text),
  iam.platform_auth_event(text, text, uuid, text, timestamptz, text) from public;
grant select on iam.platform_identity to ebmr_app;
grant execute on function iam.platform_build() to ebmr_app, ebmr_authn;
grant execute on function iam.platform_sync_grants(text, text, text, text[], text, text),
  iam.platform_auth_event(text, text, uuid, text, timestamptz, text) to ebmr_authn;

reset role;
