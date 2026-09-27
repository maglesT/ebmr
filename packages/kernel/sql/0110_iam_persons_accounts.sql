-- Identity and access (B1), part 2: persons, identity verification, the permanent register of
-- issued login names, and accounts (DI-14, DI-15, INV-11, INV-27 user IDs).
--
-- A person is a verified identity (NATURAL) or a system identity that owns service and
-- integration accounts (SYSTEM). Segregation rules are evaluated on the person, never on the
-- account. Accounts are never deleted; a login name, once issued, is never issued again, even
-- after the account is disabled. A rehired person keeps the same person record and gets a new
-- account with a new login name.
--
-- Phase 1 builds identity inside the kernel and tests it in one database. In the site topology
-- (ADR 0001) persons, accounts, credentials and devices belong to the site-services database and
-- each edition database holds freshness-bounded mirrors of them.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Persons
-- ---------------------------------------------------------------------------------------------

create table iam.person (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind in ('NATURAL', 'SYSTEM')),
  legal_name         text not null check (btrim(legal_name) <> '' and length(legal_name) <= 200),
  employee_ref       text check (employee_ref is null or btrim(employee_ref) <> ''),
  status             text not null default 'ACTIVE' check (status in ('ACTIVE', 'LEFT')),
  created_at         timestamptz not null default clock_timestamp(),
  status_changed_at  timestamptz not null default clock_timestamp()
);
create unique index person_employee_ref on iam.person (employee_ref) where employee_ref is not null;

-- Derived history for point-in-time questions (name on a signing date, status at an instant).
create table iam.person_status_event (
  id          bigint generated always as identity primary key,
  person_id   uuid not null references iam.person (id),
  status      text not null,
  changed_at  timestamptz not null
);
create index person_status_event_person on iam.person_status_event (person_id, changed_at desc);
select iam.protect_log('iam.person_status_event');

create table iam.person_name_event (
  id          bigint generated always as identity primary key,
  person_id   uuid not null references iam.person (id),
  legal_name  text not null,
  changed_at  timestamptz not null
);
create index person_name_event_person on iam.person_name_event (person_id, changed_at desc);
select iam.protect_log('iam.person_name_event');

create function iam.person_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor uuid := nullif(kernel.current_actor() ->> 'person_id', '')::uuid;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'ACTIVE' then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-010 a new person starts ACTIVE';
    end if;
    new.created_at := clock_timestamp();
    new.status_changed_at := new.created_at;
    return new;
  end if;
  if new.id <> old.id or new.kind <> old.kind or new.created_at <> old.created_at then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-007 person id, kind and creation time never change';
  end if;
  if v_actor = old.id then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-003 nobody administers their own person record';
  end if;
  if new.status is distinct from old.status then
    new.status_changed_at := clock_timestamp();
  else
    new.status_changed_at := old.status_changed_at;
  end if;
  return new;
end
$$;

create function iam.person_history() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into iam.person_status_event (person_id, status, changed_at) values (new.id, new.status, clock_timestamp());
  end if;
  if tg_op = 'INSERT' or new.legal_name is distinct from old.legal_name then
    insert into iam.person_name_event (person_id, legal_name, changed_at) values (new.id, new.legal_name, clock_timestamp());
  end if;
  return null;
end
$$;

create trigger aa_person_guard before insert or update on iam.person for each row execute function iam.person_guard();
create trigger ah_person_history after insert or update on iam.person for each row execute function iam.person_history();

create function iam.person_status_at(p_person uuid, p_at timestamptz) returns text
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select e.status from iam.person_status_event e
  where e.person_id = p_person and e.changed_at <= p_at
  order by e.changed_at desc, e.id desc limit 1
$$;

create function iam.person_name_at(p_person uuid, p_at timestamptz) returns text
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select e.legal_name from iam.person_name_event e
  where e.person_id = p_person and e.changed_at <= p_at
  order by e.changed_at desc, e.id desc limit 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Identity verification (DI-15: who verified, method, document type, evidence, when)
-- ---------------------------------------------------------------------------------------------

create table iam.identity_verification (
  id                   uuid primary key default gen_random_uuid(),
  person_id            uuid not null references iam.person (id),
  purpose              text not null check (purpose in ('INITIAL', 'REHIRE', 'BADGE_REPLACEMENT', 'CREDENTIAL_RECOVERY', 'PERIODIC')),
  method               text not null check (method in ('IN_PERSON_DOCUMENT', 'HR_ONBOARDING_RECORD', 'VIDEO_WITH_DOCUMENT', 'INSTALLATION_QUALIFICATION')),
  document_type        text not null check (btrim(document_type) <> ''),
  evidence_ref         text not null check (btrim(evidence_ref) <> ''),
  verified_by_person   uuid not null references iam.person (id),
  verified_by_account  uuid not null,
  occurred_at          timestamptz not null,
  occurred_at_trust    text not null default 'USER_CLAIMED' check (occurred_at_trust in ('DEVICE_SYNCED', 'DEVICE_UNSYNCED', 'USER_CLAIMED', 'PAPER')),
  recorded_at          timestamptz not null default clock_timestamp(),
  check (verified_by_person <> person_id),
  check (occurred_at <= recorded_at)
);
create index identity_verification_person on iam.identity_verification (person_id, recorded_at desc);

create function iam.identity_verification_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  new.recorded_at := clock_timestamp();
  if new.occurred_at > new.recorded_at then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-012 an identity check cannot be dated in the future';
  end if;
  if new.verified_by_person = new.person_id then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-012 nobody verifies their own identity';
  end if;
  return new;
end
$$;
create trigger aa_identity_verification_guard before insert on iam.identity_verification
  for each row execute function iam.identity_verification_guard();

-- The latest identity verification that counts for the person's current employment: recorded
-- after the last time the person left (rehire needs a new verification).
create function iam.current_identity_verification(p_person uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select v.id from iam.identity_verification v
  where v.person_id = p_person
    and v.recorded_at > coalesce((select max(e.changed_at) from iam.person_status_event e
                                  where e.person_id = p_person and e.status = 'LEFT'), '-infinity'::timestamptz)
  order by v.recorded_at desc limit 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Permanent register of issued login names (INV-27: user IDs are never reused)
-- ---------------------------------------------------------------------------------------------

create table iam.issued_identifier (
  identifier  text primary key check (identifier ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  account_id  uuid not null unique,
  issued_at   timestamptz not null default clock_timestamp()
);

create function iam.normalize_login_name(p_login text) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v text := lower(btrim(coalesce(p_login, '')));
begin
  if v !~ '^[a-z0-9][a-z0-9._-]{2,63}$' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-IAM-020 a login name has 3-64 characters: letters, digits, dot, underscore or hyphen, starting with a letter or digit';
  end if;
  return v;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------------------------

create table iam.account (
  id                 uuid primary key default gen_random_uuid(),
  person_id          uuid not null references iam.person (id),
  login_name         text not null unique references iam.issued_identifier (identifier),
  kind               text not null check (kind in ('HUMAN', 'SERVICE', 'INTEGRATION', 'READONLY_DISPLAY')),
  is_generic         boolean not null default false,
  is_break_glass     boolean not null default false,
  status             text not null default 'PENDING_ACTIVATION' check (status in ('PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'DISABLED')),
  gmp_capable        boolean generated always as (kind in ('HUMAN', 'SERVICE', 'INTEGRATION') and not is_generic and not is_break_glass) stored,
  created_at         timestamptz not null default clock_timestamp(),
  status_changed_at  timestamptz not null default clock_timestamp(),
  status_reason      text,
  unique (id, person_id),
  check (not is_break_glass or (kind = 'HUMAN' and not is_generic))
);
-- INV-11: at most one live GMP-capable account per person, installation-wide.
create unique index account_one_gmp_account_per_person on iam.account (person_id) where gmp_capable and status <> 'DISABLED';

create table iam.account_status_event (
  id          bigint generated always as identity primary key,
  account_id  uuid not null references iam.account (id),
  status      text not null,
  reason      text,
  changed_at  timestamptz not null
);
create index account_status_event_account on iam.account_status_event (account_id, changed_at desc);
select iam.protect_log('iam.account_status_event');

create function iam.account_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor  uuid := nullif(kernel.current_actor() ->> 'person_id', '')::uuid;
  v_person iam.person%rowtype;
begin
  select * into v_person from iam.person where id = new.person_id;
  if v_actor = new.person_id then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-003 nobody creates or administers their own account';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'PENDING_ACTIVATION' then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-023 a new account starts PENDING_ACTIVATION';
    end if;
    if v_person.status <> 'ACTIVE' then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-011 accounts are created only for active persons';
    end if;
    if (new.kind in ('SERVICE', 'INTEGRATION')) <> (v_person.kind = 'SYSTEM') then
      raise exception using errcode = 'P0001',
        message = 'EBMR-IAM-027 service and integration accounts belong to system identities; human and display accounts belong to natural persons';
    end if;
    if not exists (select 1 from iam.issued_identifier i where i.identifier = new.login_name and i.account_id = new.id) then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-021 the login name must be issued to this account in the identifier register';
    end if;
    new.created_at := clock_timestamp();
    new.status_changed_at := new.created_at;
    return new;
  end if;

  if new.id <> old.id or new.person_id <> old.person_id or new.login_name <> old.login_name or new.kind <> old.kind
     or new.is_generic <> old.is_generic or new.is_break_glass <> old.is_break_glass or new.created_at <> old.created_at then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-007 account identity, person, login name, kind and flags never change';
  end if;
  if new.status is distinct from old.status then
    if not ((old.status = 'PENDING_ACTIVATION' and new.status in ('ACTIVE', 'DISABLED'))
         or (old.status = 'ACTIVE' and new.status in ('SUSPENDED', 'DISABLED'))
         or (old.status = 'SUSPENDED' and new.status in ('ACTIVE', 'DISABLED'))) then
      raise exception using errcode = 'P0001', message = format('EBMR-IAM-023 account status cannot change from %s to %s', old.status, new.status);
    end if;
    if new.status = 'ACTIVE' then
      if v_person.status <> 'ACTIVE' then
        raise exception using errcode = 'P0001', message = 'EBMR-IAM-011 the person is not active';
      end if;
      -- DI-15: identity verified before activation (for the current employment period).
      if v_person.kind = 'NATURAL' and iam.current_identity_verification(new.person_id) is null then
        raise exception using errcode = 'P0001', message = 'EBMR-IAM-013 the person has no identity-verification record; the account cannot be activated';
      end if;
    end if;
    new.status_changed_at := clock_timestamp();
  else
    new.status_changed_at := old.status_changed_at;
  end if;
  return new;
end
$$;

create function iam.account_history() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into iam.account_status_event (account_id, status, reason, changed_at)
    values (new.id, new.status, new.status_reason, clock_timestamp());
  end if;
  return null;
end
$$;

create trigger aa_account_guard before insert or update on iam.account for each row execute function iam.account_guard();
create trigger ah_account_history after insert or update on iam.account for each row execute function iam.account_history();

create function iam.account_status_at(p_account uuid, p_at timestamptz) returns text
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select e.status from iam.account_status_event e
  where e.account_id = p_account and e.changed_at <= p_at
  order by e.changed_at desc, e.id desc limit 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Functions (each runs inside a command; the permission check lives in iam.require_permission,
-- defined with the authority evaluation in 0130)
-- ---------------------------------------------------------------------------------------------

create function iam.create_person(p_kind text, p_legal_name text, p_employee_ref text default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_id uuid;
begin
  perform iam.require_permission('IAM.PERSON_MANAGE', '{}'::jsonb);
  insert into iam.person (kind, legal_name, employee_ref) values (p_kind, btrim(p_legal_name), nullif(btrim(p_employee_ref), ''))
  returning id into v_id;
  return v_id;
end
$$;

create function iam.rename_person(p_person uuid, p_legal_name text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('IAM.PERSON_MANAGE', '{}'::jsonb);
  update iam.person set legal_name = btrim(p_legal_name) where id = p_person;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-010 unknown person';
  end if;
end
$$;

create function iam.record_identity_verification(p_person uuid, p_purpose text, p_method text, p_document_type text,
                                                 p_evidence_ref text, p_occurred_at timestamptz) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('IAM.IDENTITY_VERIFY', '{}'::jsonb);
  v_id uuid;
begin
  if not exists (select 1 from iam.person where id = p_person and kind = 'NATURAL') then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-010 identity verification applies to a known natural person';
  end if;
  insert into iam.identity_verification (person_id, purpose, method, document_type, evidence_ref, verified_by_person,
                                         verified_by_account, occurred_at)
  values (p_person, p_purpose, p_method, p_document_type, p_evidence_ref, (v_actor ->> 'person_id')::uuid,
          (v_actor ->> 'account_id')::uuid, p_occurred_at)
  returning id into v_id;
  return v_id;
end
$$;

create function iam.create_account(p_person uuid, p_login_name text, p_kind text, p_is_generic boolean default false,
                                   p_is_break_glass boolean default false) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_login text := iam.normalize_login_name(p_login_name);
  v_id    uuid := gen_random_uuid();
begin
  perform iam.require_permission('IAM.ACCOUNT_MANAGE', '{}'::jsonb);
  if exists (select 1 from iam.issued_identifier where identifier = v_login) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-021 login name %s was issued before and is never issued again, even after deactivation', v_login);
  end if;
  insert into iam.issued_identifier (identifier, account_id) values (v_login, v_id);
  insert into iam.account (id, person_id, login_name, kind, is_generic, is_break_glass)
  values (v_id, p_person, v_login, p_kind, coalesce(p_is_generic, false), coalesce(p_is_break_glass, false));
  return v_id;
end
$$;

create function iam.set_account_status(p_account uuid, p_status text, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-004 a reason is required';
  end if;
  update iam.account set status = p_status, status_reason = p_reason where id = p_account;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-022 unknown account';
  end if;
end
$$;

create function iam.activate_account(p_account uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('IAM.ACCOUNT_MANAGE', '{}'::jsonb);
  perform iam.set_account_status(p_account, 'ACTIVE', 'activated');
end
$$;

create function iam.suspend_account(p_account uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('IAM.ACCOUNT_MANAGE', '{}'::jsonb);
  perform iam.set_account_status(p_account, 'SUSPENDED', p_reason);
  perform iam.end_account_sessions(p_account, 'ACCOUNT_SUSPENDED');
end
$$;

create function iam.reinstate_account(p_account uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('IAM.ACCOUNT_MANAGE', '{}'::jsonb);
  if (select status from iam.account where id = p_account) <> 'SUSPENDED' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-023 only a suspended account can be reinstated';
  end if;
  perform iam.set_account_status(p_account, 'ACTIVE', p_reason);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Audit registration and protection
-- ---------------------------------------------------------------------------------------------

select kernel.register_audited_table('iam.person', 'person', 'id', false);
select kernel.register_audited_table('iam.identity_verification', 'person', 'person_id', true);
select kernel.register_audited_table('iam.issued_identifier', 'account', 'account_id', true);
select kernel.register_audited_table('iam.account', 'account', 'id', false);
select iam.protect_rows('iam.person');
select iam.protect_rows('iam.account');

grant select on iam.person, iam.person_status_event, iam.person_name_event, iam.identity_verification, iam.issued_identifier,
                iam.account, iam.account_status_event to ebmr_app;
grant execute on function iam.person_status_at(uuid, timestamptz), iam.person_name_at(uuid, timestamptz),
                          iam.current_identity_verification(uuid), iam.normalize_login_name(text), iam.account_status_at(uuid, timestamptz),
                          iam.create_person(text, text, text), iam.rename_person(uuid, text),
                          iam.record_identity_verification(uuid, text, text, text, text, timestamptz),
                          iam.create_account(uuid, text, text, boolean, boolean), iam.activate_account(uuid),
                          iam.suspend_account(uuid, text), iam.reinstate_account(uuid, text) to ebmr_app;

reset role;
