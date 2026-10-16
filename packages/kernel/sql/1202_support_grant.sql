-- Phase 6 slice 6f: vendor support access only inside a customer-approved, time-boxed support grant (DI-08; D-P6f-2).
--
-- Handbook: modules/kernel.md
--
-- EU GMP Annex 11 (suppliers and service providers; security) and 21 CFR 11.10(d) (paraphrased): access by a supplier's
-- support staff is limited to authorised individuals; the regulated company, not the vendor, approves it; it is named,
-- time-limited, logged and reviewable. The kernel role VENDOR_SUPPORT (K29, kernel 0120: administration permissions only,
-- so it never creates or changes GMP data, DI-18) existed without any approval gate; this file adds the gate.
--
--   iam.support_grant             insert-only: a request by IT (SUPPORT.GRANT_REQUEST, the system administrator) for ONE
--                                 named HUMAN account holding VENDOR_SUPPORT, with the vendor, the purpose and the length
--                                 in hours (1 to the setting iam.support_grant_max_hours, default 8).
--   iam.support_grant_approval    insert-only: the two customer signatures over the request, one per kind: QA
--                                 (SUPPORT_ACCESS_QA_APPROVED, permission SUPPORT.APPROVE_QA: the quality-unit approver or
--                                 the authorised person) and IT (SUPPORT_ACCESS_IT_APPROVED, SUPPORT.APPROVE_IT: the system
--                                 / process owner). Two distinct people, neither the requester nor the support engineer.
--   iam.support_grant_activation  insert-only: written with the second approval; the window is [approval, approval + hours).
--                                 It ends by itself; there is no standing grant and no extension (a new request is needed).
--   iam.support_grant_revocation  insert-only: the window ended early (QA, IT or the requester's side).
--   iam.support_session           insert-only: the grant each support session was opened under.
--
-- Enforcement (every path, with the application's own credentials):
--   * iam.authn_resolve (replaced from 0160, the only definition): an account holding VENDOR_SUPPORT now authenticates
--     only inside a live grant, never for a signature; otherwise the attempt is REFUSED, recorded in iam.authn_attempt
--     and raises the HIGH alert SUPPORT_ACCESS_REFUSED. A successful support authentication raises SUPPORT_ACCESS_USED
--     (trigger on iam.auth_event), so each use is visible for review.
--   * iam.session: a support session opens only inside a live grant (EBMR-IAM-180) and records the grant.
--   * iam.session_state (replaced from 0160, the only definition): a support session is EXPIRED once its grant has ended
--     or was revoked, so every command (kernel.validate_actor_context, EBMR-IAM-114) and every read the server resolves
--     stops at the end of the window.
--   * Grants of a GMP or signing role to an account holding VENDOR_SUPPORT stay refused by the static segregation rules
--     (kernel 0120); VENDOR_SUPPORT is an administration role, so iam.assert_not_administrator refuses it on GMP paths.
-- Messages: EBMR-IAM-180 to EBMR-IAM-189.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1202_support_grant)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'customer-approved, time-boxed vendor support grants (DI-08)'));

insert into iam.permission (code, domain, effect, description) values
  ('SUPPORT.GRANT_REQUEST', 'ADMINISTRATION', 'ADMINISTER', 'Request a time-boxed support grant for a named vendor support account'),
  ('SUPPORT.APPROVE_QA', 'GOVERNANCE', 'SIGN', 'Approve a vendor support grant for the quality unit (one of its two customer signatures)'),
  ('SUPPORT.APPROVE_IT', 'GOVERNANCE', 'SIGN', 'Approve a vendor support grant for IT, as system or process owner (one of its two customer signatures)');
insert into iam.role_permission (role_code, permission_code) values
  ('SYSTEM_ADMINISTRATOR', 'SUPPORT.GRANT_REQUEST'),
  ('QA_MBR_APPROVER', 'SUPPORT.APPROVE_QA'),
  ('AUTHORISED_PERSON', 'SUPPORT.APPROVE_QA'),
  ('PROCESS_OWNER', 'SUPPORT.APPROVE_IT');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('SUPPORT_ACCESS_QA_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'RECORDS', 'APPROVER', 'Vendor support approved (QA)',
   'For the quality unit, I approve this named, time-boxed vendor support access for the purpose stated.',
   array['SUPPORT.APPROVE_QA'], array['SUPPORT_ACCESS_IT_APPROVED'], false, false, false, 'ALL_COMPONENTS', false, 'DI-08; D-P6f-2'),
  ('SUPPORT_ACCESS_IT_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'RECORDS', 'APPROVER', 'Vendor support approved (IT)',
   'As system owner for IT, I approve this named, time-boxed vendor support access for the purpose stated.',
   array['SUPPORT.APPROVE_IT'], array['SUPPORT_ACCESS_QA_APPROVED'], false, false, false, 'ALL_COMPONENTS', false, 'DI-08; D-P6f-2');

insert into platform.setting_definition (key, value_type, default_value, min_value, max_value, allowed_values, max_scale, unit, description, basis)
values ('iam.support_grant_max_hours', 'INTEGER', '8', 1, 72, null, null, 'h',
        'The longest window of one vendor support grant',
        'DI-08: vendor support access is time-boxed and approved by the customer (D-P6f-2)');

select kernel.set_actor_context(null);

alter table iam.security_alert drop constraint security_alert_kind_check;
alter table iam.security_alert add constraint security_alert_kind_check check (kind in (
  'AUTHENTICATION_FAILED', 'SIGNING_FAILED', 'ACCOUNT_LOCKED', 'LOCKED_ACCOUNT_USE', 'DISABLED_ACCOUNT_USE',
  'UNKNOWN_IDENTIFIER', 'BADGE_NOT_ACTIVE', 'INITIAL_SECRET_REUSE', 'EXPIRED_SECRET_USE', 'UNREGISTERED_DEVICE',
  'BLOCKED_DEVICE_USE', 'DEVICE_LOCATION_MISMATCH', 'DEVICE_CLASS_MISUSE', 'BREAK_GLASS_USED', 'BREAK_GLASS_REFUSED',
  'SERVICE_ACCOUNT_INTERACTIVE_USE', 'NON_INTERACTIVE_METHOD_MISUSE', 'READ_ONLY_ACCOUNT_MISUSE',
  'SUPPORT_ACCESS_REFUSED', 'SUPPORT_ACCESS_USED'));

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table iam.support_grant (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references iam.account (id),
  person_id             uuid not null,
  vendor_name           text not null check (btrim(vendor_name) <> '' and length(vendor_name) <= 200),
  purpose               text not null check (btrim(purpose) <> '' and length(purpose) <= 2000),
  valid_hours           integer not null check (valid_hours >= 1),
  requested_by_person   uuid not null,
  requested_by_account  uuid not null,
  requested_at          timestamptz not null default clock_timestamp(),
  correlation_id        uuid not null,
  check (requested_by_person <> person_id)
);
revoke all on iam.support_grant from public;
create index support_grant_account on iam.support_grant (account_id, requested_at desc);

create table iam.support_grant_approval (
  grant_id        uuid not null references iam.support_grant (id),
  kind            text not null check (kind in ('QA', 'IT')),
  signature_id    uuid not null unique references esig.signature (id),
  person_id       uuid not null,
  account_id      uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  correlation_id  uuid not null,
  primary key (grant_id, kind)
);
revoke all on iam.support_grant_approval from public;

create table iam.support_grant_activation (
  grant_id     uuid primary key references iam.support_grant (id),
  valid_from   timestamptz not null,
  valid_to     timestamptz not null,
  recorded_at  timestamptz not null default clock_timestamp(),
  check (valid_from < valid_to)
);
revoke all on iam.support_grant_activation from public;

create table iam.support_grant_revocation (
  grant_id            uuid primary key references iam.support_grant (id),
  reason              text not null check (btrim(reason) <> ''),
  revoked_by_person   uuid not null,
  revoked_by_account  uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null
);
revoke all on iam.support_grant_revocation from public;

create table iam.support_session (
  session_id   uuid primary key references iam.session (id),
  grant_id     uuid not null references iam.support_grant (id),
  recorded_at  timestamptz not null default clock_timestamp()
);
revoke all on iam.support_session from public;

select platform.enforce_db_time('iam.support_grant', array['requested_at']);
select platform.enforce_db_time('iam.support_grant_approval', array['recorded_at']);
select platform.enforce_db_time('iam.support_grant_activation', array['recorded_at']);
select platform.enforce_db_time('iam.support_grant_revocation', array['recorded_at']);
select platform.enforce_db_time('iam.support_session', array['recorded_at']);

select kernel.register_audited_table('iam.support_grant', 'support_grant', 'id', true);
select kernel.register_audited_table('iam.support_grant_approval', 'support_grant', 'grant_id', true);
select kernel.register_audited_table('iam.support_grant_activation', 'support_grant', 'grant_id', true);
select kernel.register_audited_table('iam.support_grant_revocation', 'support_grant', 'grant_id', true);
select iam.protect_rows('iam.support_grant');
select iam.protect_rows('iam.support_grant_approval');
select iam.protect_rows('iam.support_grant_activation');
select iam.protect_rows('iam.support_grant_revocation');
select iam.protect_rows('iam.support_session');

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

-- The account holds the VENDOR_SUPPORT role now (any live grant of it).
create function iam.is_support_account(p_account uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select exists (select 1 from iam.role_grant g
                  where g.account_id = p_account and g.role_code = 'VENDOR_SUPPORT'
                    and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, clock_timestamp()))
$$;

-- A grant is open at p_at when it is active (both approvals), inside its window and not revoked before p_at.
create function iam.support_grant_open_at(p_grant uuid, p_at timestamptz) returns boolean
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select exists (select 1 from iam.support_grant_activation a
                  where a.grant_id = p_grant and a.valid_from <= p_at and p_at < a.valid_to
                    and not exists (select 1 from iam.support_grant_revocation r where r.grant_id = a.grant_id and r.recorded_at <= p_at))
$$;

-- The open grant of a support account at p_at, or NULL.
create function iam.support_grant_open(p_account uuid, p_at timestamptz) returns uuid
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select g.id from iam.support_grant g
   where g.account_id = p_account and iam.support_grant_open_at(g.id, p_at)
   order by g.requested_at desc limit 1
$$;

-- PENDING (an approval missing), ACTIVE (inside its window), ENDED (its window passed), REVOKED, or NULL.
create function iam.support_grant_state(p_grant uuid) returns text
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select case when g.id is null then null
              when exists (select 1 from iam.support_grant_revocation r where r.grant_id = g.id) then 'REVOKED'
              when a.grant_id is null then 'PENDING'
              when clock_timestamp() < a.valid_to then 'ACTIVE'
              else 'ENDED' end
    from (select 1) one
    left join iam.support_grant g on g.id = p_grant
    left join iam.support_grant_activation a on a.grant_id = g.id
$$;

-- Signed content of a grant request (DI-08). The request never changes, so both signatures stay valid; the state is
-- PENDING while they are collected.
create function iam.support_grant_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  g iam.support_grant;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into g from iam.support_grant where id = p_id::uuid;
  if g.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true, 'aggregate_id', g.id::text, 'content_version', 1,
    'content', jsonb_build_object('title', format('Vendor support access for %s (%s)', (select login_name from iam.account where id = g.account_id), g.vendor_name),
                                  'grant_id', g.id, 'support_account', (select login_name from iam.account where id = g.account_id),
                                  'support_person', (select legal_name from iam.person where id = g.person_id),
                                  'vendor', g.vendor_name, 'purpose', g.purpose, 'valid_hours', g.valid_hours,
                                  'requested_by', (select legal_name from iam.person where id = g.requested_by_person)),
    'state', iam.support_grant_state(g.id),
    'scope', '{}'::jsonb);
end
$$;

select esig.register_content_provider('support_grant', 'iam.support_grant_content(text)',
  'A vendor support grant request: the named support account, the vendor, the purpose and the length (DI-08)');

-- Every grant, latest first, for the screens of IT and QA.
create function iam.support_grants() returns jsonb
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select coalesce(jsonb_agg(x order by x ->> 'requestedAt' desc, x ->> 'grantId'), '[]'::jsonb) from (
    select jsonb_build_object(
             'grantId', g.id, 'accountId', g.account_id, 'loginName', (select login_name from iam.account where id = g.account_id),
             'personId', g.person_id, 'vendor', g.vendor_name, 'purpose', g.purpose, 'validHours', g.valid_hours,
             'requestedBy', g.requested_by_person, 'requestedAt', g.requested_at, 'state', iam.support_grant_state(g.id),
             'approvals', (select coalesce(jsonb_agg(jsonb_build_object('kind', ap.kind, 'personId', ap.person_id, 'signatureId', ap.signature_id,
                                                                        'recordedAt', ap.recorded_at) order by ap.kind), '[]'::jsonb)
                             from iam.support_grant_approval ap where ap.grant_id = g.id),
             'validFrom', a.valid_from, 'validTo', a.valid_to,
             'revocation', (select jsonb_build_object('reason', r.reason, 'by', r.revoked_by_person, 'at', r.recorded_at)
                              from iam.support_grant_revocation r where r.grant_id = g.id),
             'sessions', (select count(*) from iam.support_session s where s.grant_id = g.id)) as x
      from iam.support_grant g left join iam.support_grant_activation a on a.grant_id = g.id) q
$$;

-- ---------------------------------------------------------------------------------------------
-- Acts
-- ---------------------------------------------------------------------------------------------

-- IT requests a grant for one named support account. Returns the grant id.
create function iam.request_support_grant(p_account uuid, p_vendor text, p_purpose text, p_hours integer) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, platform, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('SUPPORT.GRANT_REQUEST', '{}'::jsonb);
  a       iam.account;
  v_max   numeric := platform.setting_numeric('iam.support_grant_max_hours');
  v_id    uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('iam.support_grant:' || coalesce(p_account::text, ''), 0));
  select * into a from iam.account where id = p_account;
  if a.id is null or a.kind <> 'HUMAN' or a.status <> 'ACTIVE' or a.is_generic or a.is_break_glass then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-181 a support grant names one active, personal (HUMAN) account (DI-08: individually named)';
  end if;
  if not iam.is_support_account(a.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-181 a support grant is for an account holding the VENDOR_SUPPORT role';
  end if;
  if a.person_id = (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-182 nobody requests a support grant for their own account';
  end if;
  if kernel.is_blank(p_vendor) or kernel.is_blank(p_purpose) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-183 a support grant names the vendor and the purpose of the access';
  end if;
  if p_hours is null or p_hours < 1 or p_hours > v_max then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-184 a support grant lasts 1 to %s hours (time-boxed; no standing grant)', v_max);
  end if;
  if exists (select 1 from iam.support_grant g where g.account_id = a.id and iam.support_grant_state(g.id) in ('PENDING', 'ACTIVE')) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-IAM-185 the account already has a pending or active support grant; let it end or revoke it first';
  end if;
  insert into iam.support_grant (account_id, person_id, vendor_name, purpose, valid_hours, requested_by_person, requested_by_account, correlation_id)
  values (a.id, a.person_id, btrim(p_vendor), btrim(p_purpose), p_hours, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid,
          (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- One of the two customer signatures (QA or IT, from the signature's meaning), in the signing command. The second one
-- opens the window [now, now + hours).
create function iam.approve_support_grant(p_grant uuid, p_signature uuid) returns text
language plpgsql volatile security definer set search_path = pg_catalog, iam, esig, kernel, pg_temp as $$
declare
  v_actor   jsonb;
  g         iam.support_grant;
  s         esig.signature;
  v_kind    text;
  v_other   iam.support_grant_approval;
  v_now     timestamptz := clock_timestamp();
begin
  select * into s from esig.signature where id = p_signature;
  v_kind := case s.meaning_code when 'SUPPORT_ACCESS_QA_APPROVED' then 'QA' when 'SUPPORT_ACCESS_IT_APPROVED' then 'IT' end;
  if v_kind is null then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-186 a support grant is approved with a QA or an IT support-approval signature';
  end if;
  v_actor := iam.require_permission(case v_kind when 'QA' then 'SUPPORT.APPROVE_QA' else 'SUPPORT.APPROVE_IT' end, '{}'::jsonb);
  perform pg_advisory_xact_lock(hashtextextended('iam.support_grant_approval:' || coalesce(p_grant::text, ''), 0));
  select * into g from iam.support_grant where id = p_grant;
  if g.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-186 %s is no support grant', coalesce(p_grant::text, 'NULL'));
  end if;
  perform esig.assert_signature(p_signature, s.meaning_code, 'support_grant', g.id::text);
  if s.signer_person is distinct from (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-186 the approval is recorded by its own signer';
  end if;
  if iam.support_grant_state(g.id) is distinct from 'PENDING' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-187 the support grant is %s: only a pending request is approved', iam.support_grant_state(g.id));
  end if;
  if s.signer_person in (g.requested_by_person, g.person_id) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-IAM-188 neither the requester nor the support engineer approves the support grant (two other customer people)';
  end if;
  if exists (select 1 from iam.support_grant_approval x where x.grant_id = g.id and x.kind = v_kind) then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-187 the %s approval of this support grant is already recorded', v_kind);
  end if;
  select * into v_other from iam.support_grant_approval x where x.grant_id = g.id and x.kind <> v_kind;
  if v_other.grant_id is not null and v_other.person_id = s.signer_person then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-188 the QA and IT approvals of a support grant are two distinct people';
  end if;
  insert into iam.support_grant_approval (grant_id, kind, signature_id, person_id, account_id, correlation_id)
  values (g.id, v_kind, s.id, s.signer_person, s.signer_account, (v_actor ->> 'correlation_id')::uuid);
  if v_other.grant_id is not null then
    insert into iam.support_grant_activation (grant_id, valid_from, valid_to)
    values (g.id, v_now, v_now + make_interval(hours => g.valid_hours));
  end if;
  return iam.support_grant_state(g.id);
end
$$;

-- The grant ends early: by QA or IT (an approver) or by IT's administrator; the support sessions expire with it.
create function iam.revoke_support_grant(p_grant uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_ctx   jsonb := iam.assert_validated_actor();
  v_perm  text;
  v_actor jsonb;
begin
  -- Whoever approves or requests support grants may end one early (QA, IT, the administrator).
  select p into v_perm from unnest(array['SUPPORT.APPROVE_QA', 'SUPPORT.APPROVE_IT', 'SUPPORT.GRANT_REQUEST']) p
   where p = any (iam.permissions_held((v_ctx ->> 'account_id')::uuid)) limit 1;
  v_actor := iam.require_permission(coalesce(v_perm, 'SUPPORT.APPROVE_QA'), '{}'::jsonb);
  if not exists (select 1 from iam.support_grant g where g.id = p_grant) then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-186 %s is no support grant', coalesce(p_grant::text, 'NULL'));
  end if;
  if kernel.is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-189 a revocation states its reason';
  end if;
  if iam.support_grant_state(p_grant) not in ('PENDING', 'ACTIVE') then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-189 the support grant is already %s', iam.support_grant_state(p_grant));
  end if;
  insert into iam.support_grant_revocation (grant_id, reason, revoked_by_person, revoked_by_account, correlation_id)
  values (p_grant, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Enforcement
-- ---------------------------------------------------------------------------------------------

-- A support session opens only inside a live grant and records it.
create function iam.support_session_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_grant uuid;
begin
  if iam.is_support_account(new.account_id) then
    v_grant := iam.support_grant_open(new.account_id, clock_timestamp());
    if v_grant is null then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-180 DI-08: a vendor support session opens only inside a live, customer-approved support grant';
    end if;
  end if;
  return new;
end
$$;
create trigger ab_support_session_guard before insert on iam.session for each row execute function iam.support_session_guard();

create function iam.support_session_record() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  if iam.is_support_account(new.account_id) then
    insert into iam.support_session (session_id, grant_id) values (new.id, iam.support_grant_open(new.account_id, clock_timestamp()));
  end if;
  return null;
end
$$;
create trigger zz_support_session_record after insert on iam.session for each row execute function iam.support_session_record();

-- Each support authentication is an alert to be reviewed (outline: logged and reviewed).
create function iam.support_auth_alert() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  if iam.is_support_account(new.account_id) then
    perform iam.raise_alert('SUPPORT_ACCESS_USED', 'MEDIUM', new.account_id, new.person_id, new.device_id, null, null,
                            jsonb_build_object('grant_id', iam.support_grant_open(new.account_id, clock_timestamp()), 'auth_event_id', new.id,
                                               'purpose', new.purpose));
  end if;
  return null;
end
$$;
create trigger zz_support_auth_alert after insert on iam.auth_event for each row execute function iam.support_auth_alert();

-- iam.session_state: CREATE OR REPLACE from its only definition (0160), same signature, owner and privileges; a support
-- session is EXPIRED once its grant is no longer open.
create or replace function iam.session_state(p_session uuid, p_at timestamptz default null) returns text
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select case
           when s.id is null then 'UNKNOWN'
           when s.ended_at is not null then 'ENDED'
           when coalesce(p_at, clock_timestamp()) >= s.opened_at + make_interval(secs => s.absolute_timeout_seconds) then 'EXPIRED'
           when ss.session_id is not null and not iam.support_grant_open_at(ss.grant_id, coalesce(p_at, clock_timestamp())) then 'EXPIRED'
           when s.locked_at is not null then 'LOCKED'
           when coalesce(p_at, clock_timestamp()) >= a.last_activity_at + make_interval(secs => s.idle_timeout_seconds) then 'IDLE_LOCKED'
           else 'ACTIVE'
         end
  from (select 1) one
  left join iam.session s on s.id = p_session
  left join iam.session_activity a on a.session_id = s.id
  left join iam.support_session ss on ss.session_id = s.id
$$;


-- iam.authn_resolve: CREATE OR REPLACE from its only definition (0160), same signature, owner, SECURITY DEFINER,
-- search_path and privileges; adds the support-grant check after the break-glass one (DI-08).
create or replace function iam.authn_resolve(p_method text, p_identifier text, p_fingerprint text, p_purpose text, p_challenge uuid)
returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_fp       text := iam.normalize_fingerprint(p_fingerprint);
  v_dev      iam.device%rowtype;
  v_acc      iam.account%rowtype;
  v_person   iam.person%rowtype;
  v_badge    iam.badge%rowtype;
  v_login    text;
  v_hash     bytea;
  v_idhash   bytea := sha256(convert_to(coalesce(p_identifier, ''), 'UTF8'));
  v_cred     iam.credential%rowtype;
  v_kind     text;
  v_doomed   text;
  v_restrict boolean := false;
  v_window   uuid;
  v_support  uuid;
  v_base     jsonb;
begin
  if p_method not in ('PASSWORD', 'BADGE_PIN', 'BADGE_TAP', 'SERVICE_KEY')
     or p_purpose not in ('LOGIN', 'COMMAND', 'SIGNATURE', 'CREDENTIAL_CHANGE', 'SESSION_UNLOCK') then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-096 unknown authentication method or purpose';
  end if;
  if (p_method = 'BADGE_TAP' and p_purpose <> 'COMMAND') or (p_method = 'SERVICE_KEY' and p_purpose <> 'LOGIN')
     or (p_purpose = 'SIGNATURE' and p_method not in ('PASSWORD', 'BADGE_PIN')) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-096 method %s cannot be used for %s (signatures need two components; a badge tap only attributes an entry)', p_method, p_purpose);
  end if;
  if (p_purpose = 'SIGNATURE') <> (p_challenge is not null) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-094 a signature authentication is bound to exactly one challenge; other purposes take none';
  end if;
  v_base := jsonb_build_object('method', p_method, 'purpose', p_purpose, 'identifier_hash', encode(v_idhash, 'hex'), 'fingerprint', v_fp);

  -- Device (DI-20): identity from the enrolled key, never from the client.
  select * into v_dev from iam.device where key_fingerprint = v_fp;
  if not found then
    return v_base || jsonb_build_object('refused', true, 'reason', 'UNREGISTERED_DEVICE', 'alert', 'UNREGISTERED_DEVICE', 'severity', 'HIGH');
  end if;
  v_base := v_base || jsonb_build_object('device_id', v_dev.id, 'device_class', v_dev.device_class);
  if v_dev.status <> 'ACTIVE' then
    return v_base || jsonb_build_object('refused', true, 'reason', 'DEVICE_' || v_dev.status, 'alert', 'BLOCKED_DEVICE_USE', 'severity', 'HIGH');
  end if;
  if v_dev.device_class = 'INSTRUMENT' or (p_method = 'SERVICE_KEY') <> (v_dev.device_class = 'SERVER') then
    return v_base || jsonb_build_object('refused', true, 'reason', 'DEVICE_CLASS_MISUSE', 'alert', 'DEVICE_CLASS_MISUSE', 'severity', 'HIGH');
  end if;

  -- Account.
  if p_method in ('PASSWORD', 'SERVICE_KEY') then
    v_login := lower(btrim(coalesce(p_identifier, '')));
    select * into v_acc from iam.account where login_name = v_login for update;
  else
    begin
      v_hash := iam.badge_uid_hash(p_identifier);
    exception when others then
      v_hash := null;
    end;
    select b.* into v_badge from iam.badge_secret s join iam.badge b on b.id = s.badge_id where s.uid_hash = v_hash;
    if found then
      v_base := v_base || jsonb_build_object('badge_id', v_badge.id);
      select * into v_acc from iam.account where id = v_badge.account_id for update;
      if v_badge.status <> 'ACTIVE' then
        return v_base || jsonb_build_object('refused', true, 'reason', 'BADGE_' || v_badge.status, 'account_id', v_acc.id,
                                            'person_id', v_acc.person_id, 'alert', 'BADGE_NOT_ACTIVE', 'severity', 'HIGH');
      end if;
    end if;
  end if;
  if v_acc.id is null then
    return v_base || jsonb_build_object('refused', true, 'reason', 'UNKNOWN_IDENTIFIER', 'alert', 'UNKNOWN_IDENTIFIER', 'severity', 'MEDIUM');
  end if;
  select * into v_person from iam.person where id = v_acc.person_id;
  v_base := v_base || jsonb_build_object('account_id', v_acc.id, 'person_id', v_acc.person_id);

  if (p_method = 'SERVICE_KEY') <> (v_acc.kind in ('SERVICE', 'INTEGRATION')) then
    return v_base || jsonb_build_object('refused', true, 'reason', 'METHOD_NOT_FOR_ACCOUNT_KIND',
             'alert', case when v_acc.kind in ('SERVICE', 'INTEGRATION') then 'SERVICE_ACCOUNT_INTERACTIVE_USE' else 'NON_INTERACTIVE_METHOD_MISUSE' end,
             'severity', 'HIGH');
  end if;
  if (v_acc.is_generic or v_acc.kind = 'READONLY_DISPLAY') and p_purpose in ('COMMAND', 'SIGNATURE') then
    return v_base || jsonb_build_object('refused', true, 'reason', 'READ_ONLY_ACCOUNT', 'alert', 'READ_ONLY_ACCOUNT_MISUSE', 'severity', 'HIGH');
  end if;
  if v_acc.status <> 'ACTIVE' or v_person.status <> 'ACTIVE' then
    return v_base || jsonb_build_object('refused', true, 'reason', 'ACCOUNT_' || case when v_person.status <> 'ACTIVE' then 'PERSON_LEFT' else v_acc.status end,
                                        'alert', 'DISABLED_ACCOUNT_USE', 'severity', 'HIGH');
  end if;
  if iam.account_locked(v_acc.id) then
    return v_base || jsonb_build_object('refused', true, 'reason', 'ACCOUNT_LOCKED', 'alert', 'LOCKED_ACCOUNT_USE', 'severity', 'HIGH');
  end if;
  if v_acc.is_break_glass then
    if p_purpose = 'SIGNATURE' then
      return v_base || jsonb_build_object('refused', true, 'reason', 'BREAK_GLASS_CANNOT_SIGN', 'alert', 'BREAK_GLASS_REFUSED', 'severity', 'CRITICAL');
    end if;
    v_window := iam.break_glass_open(v_acc.id, clock_timestamp());
    if v_window is null then
      return v_base || jsonb_build_object('refused', true, 'reason', 'BREAK_GLASS_NOT_AUTHORISED', 'alert', 'BREAK_GLASS_REFUSED', 'severity', 'CRITICAL');
    end if;
    v_base := v_base || jsonb_build_object('break_glass_window_id', v_window);
  end if;
  -- DI-08 (kernel 1202): a vendor support account authenticates only inside a live, customer-approved support grant,
  -- and never to sign. A refusal is recorded (authn_attempt) and raises a HIGH alert, as every refused authentication.
  if iam.is_support_account(v_acc.id) then
    if p_purpose = 'SIGNATURE' then
      return v_base || jsonb_build_object('refused', true, 'reason', 'SUPPORT_CANNOT_SIGN', 'alert', 'SUPPORT_ACCESS_REFUSED', 'severity', 'HIGH');
    end if;
    v_support := iam.support_grant_open(v_acc.id, clock_timestamp());
    if v_support is null then
      return v_base || jsonb_build_object('refused', true, 'reason', 'SUPPORT_NO_LIVE_GRANT', 'alert', 'SUPPORT_ACCESS_REFUSED', 'severity', 'HIGH');
    end if;
  end if;

  -- Credential to verify.
  v_kind := case p_method when 'PASSWORD' then 'PASSWORD' when 'BADGE_PIN' then 'PIN' when 'SERVICE_KEY' then 'SERVICE_KEY' end;
  if v_kind is not null then
    select * into v_cred from iam.credential where account_id = v_acc.id and kind = v_kind and status = 'ACTIVE';
    if not found then
      return v_base || jsonb_build_object('refused', true, 'reason', 'NO_ACTIVE_' || v_kind);
    end if;
    if v_cred.must_change then
      v_restrict := true;
      if exists (select 1 from iam.authn_attempt a where a.account_id = v_acc.id and a.outcome = 'SUCCESS' and v_cred.id = any (a.credential_ids)) then
        v_doomed := 'INITIAL_SECRET_ALREADY_USED';
      elsif v_cred.expires_at <= clock_timestamp() then
        v_doomed := 'INITIAL_SECRET_EXPIRED';
      end if;
    elsif v_cred.expires_at is not null and v_cred.expires_at <= clock_timestamp() then
      v_restrict := true; -- aged password: it still proves identity, but only to change it
    end if;
    v_base := v_base || jsonb_build_object('credential_id', v_cred.id, 'credential_kind', v_kind);
  end if;
  return v_base || jsonb_build_object('refused', false, 'restricted', v_restrict, 'doomed', v_doomed,
                                      'components', case p_method when 'PASSWORD' then array['USER_ID', 'PASSWORD']
                                                                  when 'BADGE_PIN' then array['BADGE', 'PIN']
                                                                  when 'BADGE_TAP' then array['BADGE']
                                                                  else array['SERVICE_ID', 'SERVICE_KEY'] end);
end
$$;


revoke all on function iam.is_support_account(uuid), iam.support_grant_open_at(uuid, timestamptz), iam.support_grant_open(uuid, timestamptz),
  iam.support_grant_state(uuid), iam.support_grant_content(text), iam.support_grants(), iam.request_support_grant(uuid, text, text, integer),
  iam.approve_support_grant(uuid, uuid), iam.revoke_support_grant(uuid, text), iam.support_session_guard(), iam.support_session_record(),
  iam.support_auth_alert() from public;
grant select on iam.support_grant, iam.support_grant_approval, iam.support_grant_activation, iam.support_grant_revocation, iam.support_session to ebmr_app;
grant execute on function iam.is_support_account(uuid), iam.support_grant_open(uuid, timestamptz), iam.support_grant_state(uuid), iam.support_grants(),
  iam.request_support_grant(uuid, text, text, integer), iam.approve_support_grant(uuid, uuid), iam.revoke_support_grant(uuid, text) to ebmr_app;

reset role;
