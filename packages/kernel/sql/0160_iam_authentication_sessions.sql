-- Identity and access (B1), part 7: authentication, authentication events, lockout, sessions
-- (DI-14, DI-16, DI-19, DI-20, INV-40; outline 4.7 sessions, 5.5 authenticate; ADR 0006, 0012).
--
-- Authentication runs in the TypeScript authentication service under the role ebmr_authn:
--   1. iam.authn_prepare(method, identifier, device fingerprint, purpose, challenge) resolves the
--      device and account, refuses (and records and alerts) unknown identifiers, unregistered or
--      blocked devices, disabled, locked or wrong-kind accounts and inactive badges, and returns the
--      verifier the service must check (argon2id, in TypeScript);
--   2. iam.authn_finish(..., verified) re-checks everything under a row lock on the account,
--      records the attempt, counts consecutive failures (lockout at the policy threshold, alert to
--      the security unit), and on success inserts ONE authentication event bound to person,
--      account, device, purpose, components and (for signatures) the challenge.
-- Only these SECURITY DEFINER functions write authentication events; ebmr_app can neither insert
-- nor change them and cannot call the authn functions. Events are single-use: a use is a row in
-- iam.auth_event_use whose primary key is (event, use), and one event serves exactly one command.
--
-- Protected security logs (not in the hash-chained audit trail, because most rows are written
-- before anyone is authenticated): authn_attempt, auth_event, auth_event_use, account_lock_event,
-- session, session_event, session_activity. They are insert-only (sessions change only their lock
-- and end fields), unwritable by the application role, and every GMP command's audit events carry
-- the session and authentication-event IDs that link back to them.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table iam.authn_attempt (
  id                  bigint generated always as identity primary key,
  attempted_at        timestamptz not null default clock_timestamp(),
  method              text not null,
  purpose             text not null,
  identifier_hash     bytea,
  account_id          uuid,
  badge_id            uuid,
  device_id           uuid,
  device_fingerprint  text,
  outcome             text not null check (outcome in ('SUCCESS', 'FAILURE', 'REFUSED')),
  reason              text not null,
  credential_ids      uuid[] not null default '{}',
  auth_event_id       uuid
);
create index authn_attempt_account on iam.authn_attempt (account_id, id desc);
select iam.protect_log('iam.authn_attempt');

create table iam.account_lock_event (
  id           bigint generated always as identity primary key,
  account_id   uuid not null references iam.account (id),
  event        text not null check (event in ('LOCKED', 'UNLOCKED')),
  reason       text not null,
  by_person    uuid,
  by_account   uuid,
  recorded_at  timestamptz not null default clock_timestamp()
);
create index account_lock_event_account on iam.account_lock_event (account_id, id desc);
select iam.protect_log('iam.account_lock_event');

create table iam.auth_event (
  id                     uuid primary key default gen_random_uuid(),
  person_id              uuid not null,
  account_id             uuid not null,
  device_id              uuid not null references iam.device (id),
  device_class           text not null,
  method                 text not null check (method in ('PASSWORD', 'BADGE_PIN', 'BADGE_TAP', 'SERVICE_KEY')),
  components             text[] not null check (cardinality(components) >= 1),
  purpose                text not null check (purpose in ('LOGIN', 'COMMAND', 'SIGNATURE', 'CREDENTIAL_CHANGE', 'SESSION_UNLOCK')),
  challenge_id           uuid,
  restricted             boolean not null default false,
  credential_ids         uuid[] not null default '{}',
  badge_id               uuid,
  break_glass_window_id  uuid,
  recorded_at            timestamptz not null default clock_timestamp(),
  foreign key (account_id, person_id) references iam.account (id, person_id),
  check ((purpose = 'SIGNATURE') = (challenge_id is not null)),
  check (not restricted or purpose = 'CREDENTIAL_CHANGE')
);
create index auth_event_account on iam.auth_event (account_id, recorded_at desc);
select iam.protect_log('iam.auth_event');

create function iam.auth_event_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  new.recorded_at := clock_timestamp();
  return new;
end
$$;
create trigger aa_auth_event_guard before insert on iam.auth_event for each row execute function iam.auth_event_guard();

create table iam.auth_event_use (
  auth_event_id   uuid not null references iam.auth_event (id),
  use_kind        text not null check (use_kind in ('LOGIN', 'COMMAND', 'SIGNATURE', 'CREDENTIAL_CHANGE', 'SESSION_UNLOCK', 'KEEP_ALIVE')),
  correlation_id  uuid,
  xact_id         xid8 not null default pg_current_xact_id(),
  session_id      uuid,
  used_at         timestamptz not null default clock_timestamp(),
  primary key (auth_event_id, use_kind)
);
select iam.protect_log('iam.auth_event_use');

create table iam.session (
  id                        uuid primary key default gen_random_uuid(),
  account_id                uuid not null,
  person_id                 uuid not null,
  device_id                 uuid not null references iam.device (id),
  device_class              text not null,
  site_code                 text not null,
  room_code                 text,
  shop_floor                boolean generated always as (device_class in ('SHARED', 'GRADE_A_B')) stored,
  personal                  boolean not null,
  opened_by_auth_event      uuid not null references iam.auth_event (id),
  opened_at                 timestamptz not null default clock_timestamp(),
  idle_timeout_seconds      integer not null check (idle_timeout_seconds > 0),
  absolute_timeout_seconds  integer not null check (absolute_timeout_seconds > 0),
  locked_at                 timestamptz,
  ended_at                  timestamptz,
  end_reason                text check (end_reason in ('LOGOUT', 'SUPERSEDED', 'ACCOUNT_DISABLED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_LOCKED',
                                                       'PERSON_LEFT', 'DEVICE_BLOCKED', 'DEVICE_RELOCATED', 'BADGE_LOST',
                                                       'BADGE_REVOKED', 'ADMIN_TERMINATED', 'TIMED_OUT')),
  foreign key (account_id, person_id) references iam.account (id, person_id),
  check ((ended_at is null) = (end_reason is null))
);
-- One active shop-floor session per person on their personal account: a login elsewhere ends the
-- old one (outline 4.7). A line display's read-only account does not count against its owner.
create unique index session_one_shop_floor_per_person on iam.session (person_id) where shop_floor and personal and ended_at is null;
create index session_account on iam.session (account_id) where ended_at is null;
create index session_device on iam.session (device_id) where ended_at is null;

create function iam.session_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.opened_at := clock_timestamp();
    if new.locked_at is not null or new.ended_at is not null then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-080 a session opens unlocked';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.account_id <> old.account_id or new.person_id <> old.person_id or new.device_id <> old.device_id
     or new.device_class <> old.device_class or new.site_code <> old.site_code or new.room_code is distinct from old.room_code
     or new.personal <> old.personal
     or new.opened_by_auth_event <> old.opened_by_auth_event or new.opened_at <> old.opened_at
     or new.idle_timeout_seconds <> old.idle_timeout_seconds or new.absolute_timeout_seconds <> old.absolute_timeout_seconds
     or old.ended_at is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-081 a session changes only its lock state and ends once';
  end if;
  if new.ended_at is not null then
    new.ended_at := clock_timestamp();
  end if;
  return new;
end
$$;
create trigger aa_session_guard before insert or update on iam.session for each row execute function iam.session_guard();
select iam.protect_rows('iam.session');

create table iam.session_activity (
  session_id        uuid primary key references iam.session (id),
  last_activity_at  timestamptz not null
);

create table iam.session_event (
  id             bigint generated always as identity primary key,
  session_id     uuid not null references iam.session (id),
  event          text not null check (event in ('OPENED', 'LOCKED', 'UNLOCKED', 'KEPT_ALIVE', 'ENDED')),
  reason         text,
  auth_event_id  uuid,
  recorded_at    timestamptz not null default clock_timestamp()
);
create index session_event_session on iam.session_event (session_id, id);
select iam.protect_log('iam.session_event');

-- ---------------------------------------------------------------------------------------------
-- Lockout helpers
-- ---------------------------------------------------------------------------------------------

create function iam.account_locked(p_account uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select coalesce((select e.event = 'LOCKED' from iam.account_lock_event e where e.account_id = p_account order by e.id desc limit 1), false)
$$;

create function iam.consecutive_failures(p_account uuid) returns bigint
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select count(*) from iam.authn_attempt a
  where a.account_id = p_account and a.outcome = 'FAILURE'
    and a.id > coalesce((select max(s.id) from iam.authn_attempt s where s.account_id = p_account and s.outcome = 'SUCCESS'), 0)
    and a.attempted_at > coalesce((select max(u.recorded_at) from iam.account_lock_event u
                                   where u.account_id = p_account and u.event = 'UNLOCKED'), '-infinity'::timestamptz)
$$;

-- ---------------------------------------------------------------------------------------------
-- Session helpers
-- ---------------------------------------------------------------------------------------------

create function iam.session_state(p_session uuid, p_at timestamptz default null) returns text
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select case
           when s.id is null then 'UNKNOWN'
           when s.ended_at is not null then 'ENDED'
           when coalesce(p_at, clock_timestamp()) >= s.opened_at + make_interval(secs => s.absolute_timeout_seconds) then 'EXPIRED'
           when s.locked_at is not null then 'LOCKED'
           when coalesce(p_at, clock_timestamp()) >= a.last_activity_at + make_interval(secs => s.idle_timeout_seconds) then 'IDLE_LOCKED'
           else 'ACTIVE'
         end
  from (select 1) one
  left join iam.session s on s.id = p_session
  left join iam.session_activity a on a.session_id = s.id
$$;

create function iam.end_session_internal(p_session uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  update iam.session set ended_at = clock_timestamp(), end_reason = p_reason where id = p_session and ended_at is null;
  if found then
    insert into iam.session_event (session_id, event, reason) values (p_session, 'ENDED', p_reason);
  end if;
end
$$;

create function iam.end_account_sessions(p_account uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  s uuid;
begin
  for s in select id from iam.session where account_id = p_account and ended_at is null loop
    perform iam.end_session_internal(s, p_reason);
  end loop;
end
$$;

create function iam.end_device_sessions(p_device uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  s uuid;
begin
  for s in select id from iam.session where device_id = p_device and ended_at is null loop
    perform iam.end_session_internal(s, p_reason);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Authentication (ebmr_authn only)
-- ---------------------------------------------------------------------------------------------

-- Resolve and check everything except the secret. Returns {refused: true, reason, alert...} or the
-- context for verification. Locks the account row so attempts on one account are serialised.
create function iam.authn_resolve(p_method text, p_identifier text, p_fingerprint text, p_purpose text, p_challenge uuid)
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

create function iam.authn_record_refusal(p_ctx jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  insert into iam.authn_attempt (method, purpose, identifier_hash, account_id, badge_id, device_id, device_fingerprint, outcome, reason)
  values (p_ctx ->> 'method', p_ctx ->> 'purpose', decode(p_ctx ->> 'identifier_hash', 'hex'), nullif(p_ctx ->> 'account_id', '')::uuid,
          nullif(p_ctx ->> 'badge_id', '')::uuid, nullif(p_ctx ->> 'device_id', '')::uuid, p_ctx ->> 'fingerprint', 'REFUSED', p_ctx ->> 'reason');
  if p_ctx ? 'alert' then
    perform iam.raise_alert(p_ctx ->> 'alert', p_ctx ->> 'severity', nullif(p_ctx ->> 'account_id', '')::uuid,
                            nullif(p_ctx ->> 'person_id', '')::uuid, nullif(p_ctx ->> 'device_id', '')::uuid,
                            nullif(p_ctx ->> 'badge_id', '')::uuid, null,
                            jsonb_build_object('method', p_ctx ->> 'method', 'purpose', p_ctx ->> 'purpose', 'reason', p_ctx ->> 'reason',
                                               'identifier_hash', p_ctx ->> 'identifier_hash', 'fingerprint', p_ctx ->> 'fingerprint'));
  end if;
  return jsonb_build_object('status', 'REFUSED', 'code', 'EBMR-IAM-140', 'reason', p_ctx ->> 'reason');
end
$$;

-- Step 1: checks and the verifier to compare against (never exposed to ebmr_app).
create function iam.authn_prepare(p_method text, p_identifier text, p_fingerprint text, p_purpose text, p_challenge uuid default null)
returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_ctx jsonb := iam.authn_resolve(p_method, p_identifier, p_fingerprint, p_purpose, p_challenge);
begin
  if (v_ctx ->> 'refused')::boolean then
    return iam.authn_record_refusal(v_ctx);
  end if;
  return jsonb_build_object('status', 'VERIFY', 'needs_secret', v_ctx ? 'credential_id',
                            'verifier', (select s.verifier from iam.credential_secret s where s.credential_id = (v_ctx ->> 'credential_id')::uuid));
end
$$;

-- Step 2: record the outcome; on success insert the single-use authentication event.
create function iam.authn_finish(p_method text, p_identifier text, p_fingerprint text, p_purpose text, p_challenge uuid,
                                 p_verified boolean) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_ctx      jsonb := iam.authn_resolve(p_method, p_identifier, p_fingerprint, p_purpose, p_challenge);
  v_account  uuid;
  v_fail     text;
  v_failures bigint;
  v_locked   boolean := false;
  v_event    uuid;
  v_purpose  text := p_purpose;
  v_restrict boolean;
  v_creds    uuid[];
begin
  if (v_ctx ->> 'refused')::boolean then
    return iam.authn_record_refusal(v_ctx);
  end if;
  v_account := (v_ctx ->> 'account_id')::uuid;
  v_creds := case when v_ctx ? 'credential_id' then array[(v_ctx ->> 'credential_id')::uuid] else '{}'::uuid[] end;
  v_fail := case when v_ctx ->> 'doomed' is not null then v_ctx ->> 'doomed'
                 when not coalesce(p_verified, false) then 'WRONG_SECRET' end;
  if v_fail is not null then
    insert into iam.authn_attempt (method, purpose, identifier_hash, account_id, badge_id, device_id, device_fingerprint, outcome, reason,
                                   credential_ids)
    values (p_method, p_purpose, decode(v_ctx ->> 'identifier_hash', 'hex'), v_account, nullif(v_ctx ->> 'badge_id', '')::uuid,
            (v_ctx ->> 'device_id')::uuid, v_ctx ->> 'fingerprint', 'FAILURE', v_fail, v_creds);
    perform iam.raise_alert(case v_fail when 'INITIAL_SECRET_ALREADY_USED' then 'INITIAL_SECRET_REUSE'
                                        when 'INITIAL_SECRET_EXPIRED' then 'EXPIRED_SECRET_USE'
                                        else case when p_purpose = 'SIGNATURE' then 'SIGNING_FAILED' else 'AUTHENTICATION_FAILED' end end,
                            case when v_fail = 'WRONG_SECRET' and p_purpose <> 'SIGNATURE' then 'LOW' when v_fail = 'WRONG_SECRET' then 'MEDIUM' else 'HIGH' end,
                            v_account, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'device_id')::uuid, nullif(v_ctx ->> 'badge_id', '')::uuid, null,
                            jsonb_build_object('method', p_method, 'purpose', p_purpose, 'reason', v_fail));
    v_failures := iam.consecutive_failures(v_account);
    if v_failures >= iam.policy_int('authn.lockout_threshold') and not iam.account_locked(v_account) then
      insert into iam.account_lock_event (account_id, event, reason)
      values (v_account, 'LOCKED', format('%s consecutive failed authentication or signing attempts', v_failures));
      perform iam.raise_alert('ACCOUNT_LOCKED', 'HIGH', v_account, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'device_id')::uuid,
                              nullif(v_ctx ->> 'badge_id', '')::uuid, null,
                              jsonb_build_object('consecutive_failures', v_failures, 'last_purpose', p_purpose));
      perform iam.end_account_sessions(v_account, 'ACCOUNT_LOCKED');
      v_locked := true;
    end if;
    return jsonb_build_object('status', 'FAILED', 'code', 'EBMR-IAM-140', 'reason', v_fail, 'locked', v_locked or iam.account_locked(v_account));
  end if;

  v_restrict := coalesce((v_ctx ->> 'restricted')::boolean, false);
  if v_restrict then
    v_purpose := 'CREDENTIAL_CHANGE';
  end if;
  insert into iam.auth_event (person_id, account_id, device_id, device_class, method, components, purpose, challenge_id, restricted,
                              credential_ids, badge_id, break_glass_window_id)
  values ((v_ctx ->> 'person_id')::uuid, v_account, (v_ctx ->> 'device_id')::uuid, v_ctx ->> 'device_class', p_method,
          array(select jsonb_array_elements_text(v_ctx -> 'components')), v_purpose,
          case when v_purpose = 'SIGNATURE' then p_challenge end, v_restrict, v_creds, nullif(v_ctx ->> 'badge_id', '')::uuid,
          nullif(v_ctx ->> 'break_glass_window_id', '')::uuid)
  returning id into v_event;
  insert into iam.authn_attempt (method, purpose, identifier_hash, account_id, badge_id, device_id, device_fingerprint, outcome, reason,
                                 credential_ids, auth_event_id)
  values (p_method, p_purpose, decode(v_ctx ->> 'identifier_hash', 'hex'), v_account, nullif(v_ctx ->> 'badge_id', '')::uuid,
          (v_ctx ->> 'device_id')::uuid, v_ctx ->> 'fingerprint', 'SUCCESS', case when v_restrict then 'OK_MUST_CHANGE_SECRET' else 'OK' end,
          v_creds, v_event);
  if v_ctx ? 'break_glass_window_id' then
    perform iam.raise_alert('BREAK_GLASS_USED', 'CRITICAL', v_account, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'device_id')::uuid, null, null,
                            jsonb_build_object('window_id', v_ctx ->> 'break_glass_window_id', 'auth_event_id', v_event));
  end if;
  return jsonb_build_object('status', 'OK', 'auth_event_id', v_event, 'person_id', v_ctx ->> 'person_id', 'account_id', v_account,
                            'device_id', v_ctx ->> 'device_id', 'device_class', v_ctx ->> 'device_class', 'purpose', v_purpose,
                            'restricted', v_restrict, 'components', v_ctx -> 'components');
end
$$;

-- Checks that an event can serve a self-service step (credential change, history lookup).
create function iam.change_event_check(p_auth_event uuid, p_kind text) returns iam.auth_event
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_ev iam.auth_event%rowtype;
begin
  select * into v_ev from iam.auth_event where id = p_auth_event for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-090 unknown authentication event';
  end if;
  if v_ev.purpose <> 'CREDENTIAL_CHANGE' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-096 the authentication event was not made to change a secret';
  end if;
  if exists (select 1 from iam.auth_event_use where auth_event_id = v_ev.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-091 the authentication event has been used';
  end if;
  if clock_timestamp() - v_ev.recorded_at > make_interval(secs => iam.policy_int('authn.event_max_age_seconds')) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-092 the authentication event is too old';
  end if;
  if not ((p_kind = 'PASSWORD' and 'PASSWORD' = any (v_ev.components)) or (p_kind = 'PIN' and 'PIN' = any (v_ev.components))) then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-096 changing the %s needs an authentication with the current %s', p_kind, p_kind);
  end if;
  if iam.account_locked(v_ev.account_id) or (select status from iam.account where id = v_ev.account_id) <> 'ACTIVE' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-103 the account is not active or is locked';
  end if;
  return v_ev;
end
$$;

-- Verifiers of the current and previous secrets, for the no-reuse check in the service.
create function iam.authn_secret_history(p_auth_event uuid, p_kind text) returns setof text
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_ev iam.auth_event := iam.change_event_check(p_auth_event, p_kind);
begin
  return query
    select s.verifier from iam.credential c join iam.credential_secret s on s.credential_id = c.id
    where c.account_id = v_ev.account_id and c.kind = p_kind
    order by c.issued_at desc
    limit greatest(iam.policy_int('credential.password_history'), 1);
end
$$;

-- The owner changes their own secret (after an initial or reset secret, or at will). The change is
-- attributed to the person through the authentication event, which is consumed.
create function iam.authn_change_secret(p_auth_event uuid, p_kind text, p_new_verifier text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_ev   iam.auth_event := iam.change_event_check(p_auth_event, p_kind);
  v_prev text := current_setting('ebmr.ctx', true);
  v_ctx  jsonb;
  v_id   uuid;
begin
  perform iam.check_verifier(p_new_verifier);
  v_ctx := jsonb_build_object('person_id', v_ev.person_id, 'account_id', v_ev.account_id, 'role_code', 'SELF_SERVICE',
                              'session_id', v_ev.id, 'source', 'UI', 'site_zone', iam.policy_text('site.zone'),
                              'correlation_id', gen_random_uuid(), 'device_id', v_ev.device_id, 'auth_event_id', v_ev.id,
                              'legal_name', (select legal_name from iam.person where id = v_ev.person_id),
                              'reason_code', 'CREDENTIAL_CHANGE', 'reason_text', 'the account owner changed their own ' || lower(p_kind));
  perform iam.set_internal_actor(v_ctx);
  insert into iam.auth_event_use (auth_event_id, use_kind, correlation_id) values (v_ev.id, 'CREDENTIAL_CHANGE', (v_ctx ->> 'correlation_id')::uuid);
  v_id := iam.store_credential(v_ev.account_id, p_kind, 'USER_CHANGE', p_new_verifier, v_ctx);
  perform set_config('ebmr.ctx', coalesce(v_prev, ''), true);
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Consuming authentication events
-- ---------------------------------------------------------------------------------------------

-- Common checks; locks the event row so concurrent consumers are serialised.
create function iam.lock_auth_event(p_auth_event uuid) returns iam.auth_event
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_ev iam.auth_event%rowtype;
begin
  select * into v_ev from iam.auth_event where id = p_auth_event for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-090 unknown authentication event';
  end if;
  if (select status from iam.account where id = v_ev.account_id) <> 'ACTIVE'
     or (select status from iam.person where id = v_ev.person_id) <> 'ACTIVE' or iam.account_locked(v_ev.account_id) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-103 the account of the authentication event is no longer active or is locked';
  end if;
  return v_ev;
end
$$;

-- For B2's signing function (and INV-40): consume ONE unused authentication event of the expected
-- person, bound to the expected challenge, no older than p_max_age (capped by policy). The event may
-- already carry this same command's attribution use; it can never serve another command or a
-- second signature. Must run inside a validated command.
create function iam.consume_auth_event(p_auth_event uuid, p_expected_person uuid, p_expected_challenge uuid, p_max_age interval)
returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_corr  uuid := (v_actor ->> 'correlation_id')::uuid;
  v_ev    iam.auth_event := iam.lock_auth_event(p_auth_event);
  v_max   interval := least(coalesce(p_max_age, interval '0'), make_interval(secs => iam.policy_int('authn.event_max_age_seconds')));
begin
  if v_ev.person_id is distinct from p_expected_person then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-093 the authentication event belongs to another person (no proxy signing)';
  end if;
  if v_ev.purpose <> 'SIGNATURE' or v_ev.restricted then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-096 the authentication event was not made for a signature';
  end if;
  if v_ev.challenge_id is distinct from p_expected_challenge then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-094 the authentication event is bound to another challenge';
  end if;
  if clock_timestamp() - v_ev.recorded_at > v_max then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-092 the authentication event is too old';
  end if;
  if exists (select 1 from iam.auth_event_use u where u.auth_event_id = v_ev.id
               and (u.use_kind = 'SIGNATURE' or u.correlation_id is distinct from v_corr or u.xact_id <> pg_current_xact_id())) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-091 the authentication event has already been used';
  end if;
  insert into iam.auth_event_use (auth_event_id, use_kind, correlation_id, session_id)
  values (v_ev.id, 'SIGNATURE', v_corr, nullif(v_actor ->> 'session_id', '')::uuid);
  return jsonb_build_object('auth_event_id', v_ev.id, 'person_id', v_ev.person_id, 'account_id', v_ev.account_id, 'device_id', v_ev.device_id,
                            'device_class', v_ev.device_class, 'method', v_ev.method, 'components', to_jsonb(v_ev.components),
                            'challenge_id', v_ev.challenge_id, 'recorded_at', v_ev.recorded_at, 'badge_id', v_ev.badge_id);
end
$$;

-- Attribution of one command (called by kernel.validate_actor_context). The event must be the
-- actor's, made on the session's device, for a command or a signature, fresh within p_window, and
-- unused by any other command.
create function iam.use_auth_event_for_command(p_auth_event uuid, p_person uuid, p_account uuid, p_device uuid, p_window interval,
                                               p_correlation uuid, p_session uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_ev iam.auth_event := iam.lock_auth_event(p_auth_event);
begin
  if v_ev.person_id <> p_person or v_ev.account_id <> p_account then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-122 INV-40: the authentication event belongs to another person or account';
  end if;
  if v_ev.device_id <> p_device then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-123 INV-40: the authentication event was made on another device';
  end if;
  if v_ev.purpose not in ('COMMAND', 'SIGNATURE') or v_ev.restricted then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-124 INV-40: the authentication event was not made to attribute a command';
  end if;
  if clock_timestamp() - v_ev.recorded_at > p_window then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-125 INV-40: the authentication event is older than %s', p_window);
  end if;
  if exists (select 1 from iam.auth_event_use u where u.auth_event_id = v_ev.id
               and (u.correlation_id is distinct from p_correlation or u.xact_id <> pg_current_xact_id())) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-126 INV-40: the authentication event has already attributed another command';
  end if;
  insert into iam.auth_event_use (auth_event_id, use_kind, correlation_id, session_id)
  values (v_ev.id, 'COMMAND', p_correlation, p_session)
  on conflict (auth_event_id, use_kind) do nothing;
end
$$;

-- The authentication event consumed for the current command, if any (for Phase 2 data points,
-- which store it: INV-40 "the data point stores its authentication_event_id").
create function iam.current_command_auth_event() returns uuid
language sql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
  select u.auth_event_id from iam.auth_event_use u
  where u.use_kind = 'COMMAND' and u.correlation_id = (iam.assert_validated_actor() ->> 'correlation_id')::uuid
    and u.xact_id = pg_current_xact_id()
  limit 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Sessions (server-side; ebmr_app)
-- ---------------------------------------------------------------------------------------------

create function iam.open_session(p_auth_event uuid, p_fingerprint text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_ev   iam.auth_event := iam.lock_auth_event(p_auth_event);
  v_dev  jsonb := iam.resolve_device(p_fingerprint);
  v_acc  iam.account%rowtype;
  v_id   uuid;
  v_idle integer;
  v_abs  integer;
  v_room text;
  v_site text;
  v_personal boolean;
  s      uuid;
begin
  if not (v_dev ->> 'accepted')::boolean then
    raise exception using errcode = 'P0001', message = format('%s the device is not registered or not active', v_dev ->> 'code');
  end if;
  if (v_dev ->> 'device_id')::uuid <> v_ev.device_id then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-095 the login was authenticated on another device';
  end if;
  if v_ev.purpose <> 'LOGIN' or v_ev.restricted then
    raise exception using errcode = 'P0001',
      message = case when v_ev.restricted then 'EBMR-IAM-052 the secret must be changed before a session can open'
                     else 'EBMR-IAM-096 the authentication event was not made to log in' end;
  end if;
  if exists (select 1 from iam.auth_event_use where auth_event_id = v_ev.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-091 the authentication event has been used';
  end if;
  if clock_timestamp() - v_ev.recorded_at > make_interval(secs => iam.policy_int('authn.event_max_age_seconds')) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-092 the authentication event is too old';
  end if;
  select * into v_acc from iam.account where id = v_ev.account_id;
  if v_acc.is_break_glass and iam.break_glass_open(v_acc.id, clock_timestamp()) is null then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-130 the break-glass window has closed';
  end if;
  v_personal := v_acc.kind = 'HUMAN' and not v_acc.is_generic;
  if v_ev.device_class in ('SHARED', 'GRADE_A_B') and v_personal then
    for s in select id from iam.session where person_id = v_ev.person_id and shop_floor and personal and ended_at is null loop
      perform iam.end_session_internal(s, 'SUPERSEDED');
    end loop;
  end if;
  v_idle := iam.policy_int('session.idle_timeout_seconds.' || v_ev.device_class);
  v_abs := iam.policy_int('session.absolute_timeout_seconds');
  select room_code, site_code into v_room, v_site from iam.device where id = v_ev.device_id;
  insert into iam.session (account_id, person_id, device_id, device_class, site_code, room_code, opened_by_auth_event,
                           idle_timeout_seconds, absolute_timeout_seconds, personal)
  values (v_ev.account_id, v_ev.person_id, v_ev.device_id, v_ev.device_class, v_site, v_room, v_ev.id, v_idle, v_abs, v_personal)
  returning id into v_id;
  insert into iam.session_activity (session_id, last_activity_at) values (v_id, clock_timestamp());
  insert into iam.session_event (session_id, event, auth_event_id) values (v_id, 'OPENED', v_ev.id);
  insert into iam.auth_event_use (auth_event_id, use_kind, session_id) values (v_ev.id, 'LOGIN', v_id);
  return jsonb_build_object('session_id', v_id, 'person_id', v_ev.person_id, 'account_id', v_ev.account_id, 'device_id', v_ev.device_id,
                            'device_class', v_ev.device_class, 'site_code', v_site, 'room_code', v_room, 'idle_timeout_seconds', v_idle,
                            'absolute_timeout_seconds', v_abs);
end
$$;

create function iam.lock_session(p_session uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  update iam.session set locked_at = clock_timestamp() where id = p_session and ended_at is null and locked_at is null;
  if found then
    insert into iam.session_event (session_id, event, reason) values (p_session, 'LOCKED', 'locked by the user or the terminal');
  end if;
end
$$;

-- Unlock needs a fresh authentication of the session's own person on the session's device.
create function iam.unlock_session(p_session uuid, p_auth_event uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_ev    iam.auth_event := iam.lock_auth_event(p_auth_event);
  v_s     iam.session%rowtype;
  v_state text;
begin
  select * into v_s from iam.session where id = p_session for update;
  v_state := iam.session_state(p_session);
  if v_state in ('UNKNOWN', 'ENDED', 'EXPIRED') then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-081 the session is %s; log in again', lower(v_state));
  end if;
  if v_ev.account_id <> v_s.account_id or v_ev.device_id <> v_s.device_id then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-084 only the session''s own person, on the same device, can unlock it';
  end if;
  if v_ev.purpose <> 'SESSION_UNLOCK' or v_ev.restricted then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-096 the authentication event was not made to unlock a session';
  end if;
  if exists (select 1 from iam.auth_event_use where auth_event_id = v_ev.id) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-091 the authentication event has been used';
  end if;
  if clock_timestamp() - v_ev.recorded_at > make_interval(secs => iam.policy_int('authn.event_max_age_seconds')) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-092 the authentication event is too old';
  end if;
  update iam.session set locked_at = null where id = p_session;
  update iam.session_activity set last_activity_at = clock_timestamp() where session_id = p_session;
  insert into iam.session_event (session_id, event, auth_event_id) values (p_session, 'UNLOCKED', v_ev.id);
  insert into iam.auth_event_use (auth_event_id, use_kind, session_id) values (v_ev.id, 'SESSION_UNLOCK', p_session);
end
$$;

-- Extending a session before the inactivity lock; on shop-floor devices it needs a badge tap.
create function iam.keep_session_alive(p_session uuid, p_auth_event uuid default null) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_s iam.session%rowtype;
begin
  select * into v_s from iam.session where id = p_session for update;
  if iam.session_state(p_session) <> 'ACTIVE' then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-082 the session is %s', lower(iam.session_state(p_session)));
  end if;
  if v_s.shop_floor then
    if p_auth_event is null then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-120 extending a shop-floor session needs a badge tap';
    end if;
    perform iam.use_auth_event_for_command(p_auth_event, v_s.person_id, v_s.account_id, v_s.device_id,
                                           make_interval(secs => iam.policy_int('attribution.freshness_seconds.' || v_s.device_class)),
                                           gen_random_uuid(), p_session);
  end if;
  update iam.session_activity set last_activity_at = clock_timestamp() where session_id = p_session;
  insert into iam.session_event (session_id, event, auth_event_id) values (p_session, 'KEPT_ALIVE', p_auth_event);
end
$$;

create function iam.end_session(p_session uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  perform iam.end_session_internal(p_session, 'LOGOUT');
end
$$;

-- Administrator unlock (DI-19), attributed and written to the account's audit chain.
create function iam.unlock_account(p_account uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('IAM.UNLOCK', '{}'::jsonb);
begin
  if (select person_id from iam.account where id = p_account) = (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-003 nobody unlocks their own account';
  end if;
  if not iam.account_locked(p_account) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-105 the account is not locked';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-004 a reason is required';
  end if;
  insert into iam.account_lock_event (account_id, event, reason, by_person, by_account)
  values (p_account, 'UNLOCKED', p_reason, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  perform kernel.audit_business_event('account:' || p_account, 'account unlocked', jsonb_build_object('reason', p_reason));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on iam.authn_attempt, iam.account_lock_event, iam.auth_event, iam.auth_event_use, iam.session, iam.session_activity,
              iam.session_event from ebmr_app, ebmr_authn;
grant select on iam.account_lock_event, iam.auth_event, iam.auth_event_use, iam.session, iam.session_activity, iam.session_event to ebmr_app;
-- authn_attempt holds identifier hashes of failed logins: readable by the owner (security reports) only.

grant execute on function iam.authn_prepare(text, text, text, text, uuid), iam.authn_finish(text, text, text, text, uuid, boolean),
                          iam.authn_secret_history(uuid, text), iam.authn_change_secret(uuid, text, text) to ebmr_authn;
grant execute on function iam.account_locked(uuid), iam.consecutive_failures(uuid), iam.session_state(uuid, timestamptz),
                          iam.current_command_auth_event(), iam.open_session(uuid, text), iam.lock_session(uuid),
                          iam.unlock_session(uuid, uuid), iam.keep_session_alive(uuid, uuid), iam.end_session(uuid),
                          iam.unlock_account(uuid, text) to ebmr_app;
-- consume_auth_event is for SECURITY DEFINER signing code owned by ebmr_owner (module B2); it is
-- deliberately not granted to ebmr_app.

reset role;
