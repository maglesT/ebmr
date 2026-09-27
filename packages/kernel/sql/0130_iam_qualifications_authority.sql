-- Identity and access (B1), part 4: qualification register stand-in, authority evaluation and the
-- stored evaluation log (INV-26, DI-17, DI-21), the permission guard used by every IAM function,
-- policy changes and security-alert handling (DI-19).
--
-- iam.evaluate_authority(person, account, permission, scope, at) decides whether the person, acting
-- through the account, held a role granting the permission in that scope at that instant AND every
-- qualification the role or permission requires, on data recorded by that instant and (for
-- mirrored sources) within the mirror's freshness bound. Every evaluation is stored with its inputs.
-- The training gate is a hard block: every site is India-licensed, so the flag-and-review relaxation
-- DI-21 allows elsewhere is not offered (IN-04).

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Qualification register stand-in (outline 11 Phase 1; replaced or fed by an LMS mirror later)
-- ---------------------------------------------------------------------------------------------

create table iam.qualification_type (
  code         text primary key check (code ~ '^[A-Z0-9][A-Z0-9_.-]*$'),
  name         text not null,
  description  text not null,
  created_at   timestamptz not null default clock_timestamp()
);

create table iam.qualification_source (
  code         text primary key check (code ~ '^[A-Z][A-Z0-9_]*$'),
  kind         text not null check (kind in ('INTERNAL', 'MIRROR')),
  description  text not null
);
insert into iam.qualification_source (code, kind, description) values
  ('INTERNAL', 'INTERNAL', 'Recorded in this system by a training coordinator'),
  ('LMS', 'MIRROR', 'Mirrored from the learning-management system (stub until the LMS adapter, Phase 6)');

-- Operational heartbeat of each mirror (not GMP data; not audited).
create table iam.mirror_heartbeat (
  source_code     text primary key references iam.qualification_source (code),
  last_synced_at  timestamptz not null
);

create table iam.person_qualification (
  id                   uuid primary key default gen_random_uuid(),
  person_id            uuid not null references iam.person (id),
  qualification_code   text not null references iam.qualification_type (code),
  source_code          text not null references iam.qualification_source (code),
  source_ref           text,
  valid_from           timestamptz not null,
  valid_to             timestamptz,
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  withdrawn_at         timestamptz,
  withdrawn_by_person  uuid,
  withdrawal_reason    text,
  check (valid_to is null or valid_to > valid_from),
  check (recorded_by_person <> person_id),
  check (withdrawn_by_person is null or withdrawn_by_person <> person_id),
  check ((withdrawn_at is null) = (withdrawn_by_person is null))
);
create index person_qualification_person on iam.person_qualification (person_id, qualification_code);

create table iam.qualification_requirement (
  id                  uuid primary key default gen_random_uuid(),
  qualification_code  text not null references iam.qualification_type (code),
  role_code           text references iam.role (code),
  permission_code     text references iam.permission (code),
  scope_site          text,
  scope_area          text,
  scope_product       text,
  reason              text not null check (btrim(reason) <> ''),
  effective_from      timestamptz not null default clock_timestamp(),
  effective_to        timestamptz,
  created_by_person   uuid not null,
  check (num_nonnulls(role_code, permission_code) = 1),
  check (effective_to is null or effective_to >= effective_from)
);

create function iam.qualification_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  if tg_table_name = 'person_qualification' then
    if tg_op = 'INSERT' then
      new.recorded_at := clock_timestamp();
      if new.withdrawn_at is not null then
        raise exception using errcode = 'P0001', message = 'EBMR-IAM-160 a qualification is recorded before it can be withdrawn';
      end if;
      return new;
    end if;
    if new.id <> old.id or new.person_id <> old.person_id or new.qualification_code <> old.qualification_code
       or new.source_code <> old.source_code or new.source_ref is distinct from old.source_ref or new.valid_from <> old.valid_from
       or new.valid_to is distinct from old.valid_to or new.recorded_by_person <> old.recorded_by_person
       or new.recorded_at <> old.recorded_at or old.withdrawn_at is not null then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-160 a qualification record never changes; it can only be withdrawn once';
    end if;
    new.withdrawn_at := clock_timestamp();
    return new;
  end if;
  -- qualification_requirement
  if tg_op = 'INSERT' then
    new.effective_from := clock_timestamp();
    new.effective_to := null;
    return new;
  end if;
  if new.id <> old.id or new.qualification_code <> old.qualification_code or new.role_code is distinct from old.role_code
     or new.permission_code is distinct from old.permission_code or new.scope_site is distinct from old.scope_site
     or new.scope_area is distinct from old.scope_area or new.scope_product is distinct from old.scope_product
     or new.effective_from <> old.effective_from or old.effective_to is not null or new.effective_to is null then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-160 a qualification requirement can only be ended, once';
  end if;
  new.effective_to := clock_timestamp();
  return new;
end
$$;
create trigger aa_person_qualification_guard before insert or update on iam.person_qualification
  for each row execute function iam.qualification_guard();
create trigger aa_qualification_requirement_guard before insert or update on iam.qualification_requirement
  for each row execute function iam.qualification_guard();

create function iam.qualification_source_fresh(p_source text, p_at timestamptz) returns boolean
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select case s.kind
           when 'INTERNAL' then true
           else coalesce((select h.last_synced_at >= p_at - make_interval(secs => iam.policy_int('qualification.mirror_max_staleness_seconds'))
                          from iam.mirror_heartbeat h where h.source_code = s.code), false)
         end
  from iam.qualification_source s where s.code = p_source
$$;

-- ---------------------------------------------------------------------------------------------
-- Authority evaluation (INV-26: the evaluation is stored)
-- ---------------------------------------------------------------------------------------------

create table iam.authority_evaluation (
  id               uuid primary key default gen_random_uuid(),
  evaluated_at     timestamptz not null default clock_timestamp(),
  at_instant       timestamptz not null,
  person_id        uuid,
  account_id       uuid,
  permission_code  text not null,
  role_filter      text,
  scope            jsonb not null,
  allowed          boolean not null,
  reasons          text[] not null,
  role_code        text,
  grant_id         uuid,
  inputs           jsonb not null,
  correlation_id   uuid,
  requested_by_account uuid
);
create index authority_evaluation_person on iam.authority_evaluation (person_id, evaluated_at);
create index authority_evaluation_correlation on iam.authority_evaluation (correlation_id);
select iam.protect_log('iam.authority_evaluation');

create function iam.authority_evaluation_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  new.evaluated_at := clock_timestamp();
  return new;
end
$$;
create trigger aa_authority_evaluation_guard before insert on iam.authority_evaluation
  for each row execute function iam.authority_evaluation_guard();

create function iam.evaluate_authority(p_person uuid, p_account uuid, p_permission text, p_scope jsonb default '{}'::jsonb,
                                       p_at timestamptz default null, p_role text default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_at        timestamptz := coalesce(p_at, clock_timestamp());
  v_scope     jsonb := iam.check_scope(p_scope);
  v_reasons   text[] := '{}';
  v_missing   text[];
  v_all_missing text[] := '{}';
  v_person    iam.person%rowtype;
  v_acc       iam.account%rowtype;
  v_perm      iam.permission%rowtype;
  v_grant     iam.role_grant%rowtype;
  v_req       iam.qualification_requirement%rowtype;
  v_pq        iam.person_qualification%rowtype;
  v_ok_grant  iam.role_grant%rowtype;
  v_found     boolean := false;
  v_fresh     boolean;
  v_grants    jsonb := '[]'::jsonb;
  v_quals     jsonb := '[]'::jsonb;
  v_ctx       jsonb := kernel.current_actor();
  v_allowed   boolean;
  v_id        uuid;
begin
  select * into v_person from iam.person where id = p_person;
  if not found then
    v_reasons := array_append(v_reasons, 'PERSON_UNKNOWN');
  elsif coalesce(iam.person_status_at(p_person, v_at), 'NONE') <> 'ACTIVE' then
    v_reasons := array_append(v_reasons, 'PERSON_NOT_ACTIVE');
  end if;
  select * into v_acc from iam.account where id = p_account;
  if not found then
    v_reasons := array_append(v_reasons, 'ACCOUNT_UNKNOWN');
  else
    if v_acc.person_id is distinct from p_person then
      v_reasons := array_append(v_reasons, 'ACCOUNT_NOT_OF_PERSON');
    end if;
    if coalesce(iam.account_status_at(p_account, v_at), 'NONE') <> 'ACTIVE' then
      v_reasons := array_append(v_reasons, 'ACCOUNT_NOT_ACTIVE');
    end if;
  end if;
  select * into v_perm from iam.permission where code = p_permission;
  if not found then
    v_reasons := array_append(v_reasons, 'PERMISSION_UNKNOWN');
  elsif v_acc.id is not null then
    if v_perm.effect <> 'READ' and (v_acc.is_generic or v_acc.kind = 'READONLY_DISPLAY') then
      v_reasons := array_append(v_reasons, 'ACCOUNT_READ_ONLY');
    end if;
    if v_perm.effect in ('SIGN', 'ACKNOWLEDGE') and v_acc.kind in ('SERVICE', 'INTEGRATION') then
      v_reasons := array_append(v_reasons, 'NON_INTERACTIVE_ACCOUNT_CANNOT_SIGN');
    end if;
    if v_acc.is_break_glass and (v_perm.domain = 'GMP' or v_perm.effect in ('SIGN', 'ACKNOWLEDGE')) then
      v_reasons := array_append(v_reasons, 'BREAK_GLASS_NO_GMP');
    end if;
  end if;

  if v_acc.id is not null and v_perm.code is not null then
    for v_grant in
      select g.* from iam.role_grant g
      join iam.role_permission rp on rp.role_code = g.role_code and rp.permission_code = p_permission
                                  and iam.role_permission_live_at(rp.added_at, rp.removed_at, v_at)
      where g.account_id = p_account and (p_role is null or g.role_code = p_role)
        and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, v_at)
        and iam.scope_covers(g.scope_site, g.scope_area, g.scope_product, v_scope)
      order by g.decided_at, g.id
    loop
      v_found := true;
      v_missing := '{}';
      v_grants := v_grants || jsonb_build_object('grant_id', v_grant.id, 'role_code', v_grant.role_code,
                    'scope', jsonb_strip_nulls(jsonb_build_object('site', v_grant.scope_site, 'area', v_grant.scope_area, 'product', v_grant.scope_product)),
                    'approved_at', v_grant.decided_at, 'valid_to', v_grant.valid_to);
      for v_req in
        select q.* from iam.qualification_requirement q
        where (q.role_code = v_grant.role_code or q.permission_code = p_permission)
          and q.effective_from <= v_at and (q.effective_to is null or v_at < q.effective_to)
          and iam.scope_covers(q.scope_site, q.scope_area, q.scope_product, v_scope)
        order by q.qualification_code
      loop
        select pq.* into v_pq from iam.person_qualification pq
        where pq.person_id = p_person and pq.qualification_code = v_req.qualification_code
          and pq.valid_from <= v_at and (pq.valid_to is null or v_at < pq.valid_to)
          and (pq.withdrawn_at is null or v_at < pq.withdrawn_at) and pq.recorded_at <= v_at
        order by iam.qualification_source_fresh(pq.source_code, v_at) desc, pq.valid_to desc nulls first, pq.recorded_at desc
        limit 1;
        if not found then
          v_missing := v_missing || ('MISSING_QUALIFICATION:' || v_req.qualification_code);
          v_quals := v_quals || jsonb_build_object('requirement_id', v_req.id, 'qualification_code', v_req.qualification_code,
                                                   'grant_id', v_grant.id, 'satisfied', false);
        else
          v_fresh := iam.qualification_source_fresh(v_pq.source_code, v_at);
          if not v_fresh then
            v_missing := v_missing || ('STALE_QUALIFICATION_SOURCE:' || v_req.qualification_code);
          end if;
          v_quals := v_quals || jsonb_build_object('requirement_id', v_req.id, 'qualification_code', v_req.qualification_code,
                                                   'grant_id', v_grant.id, 'satisfied', v_fresh, 'person_qualification_id', v_pq.id,
                                                   'valid_from', v_pq.valid_from, 'valid_to', v_pq.valid_to, 'source', v_pq.source_code,
                                                   'source_fresh', v_fresh, 'recorded_at', v_pq.recorded_at);
        end if;
      end loop;
      if cardinality(v_missing) = 0 then
        v_ok_grant := v_grant;
        exit;
      end if;
      v_all_missing := v_all_missing || v_missing;
    end loop;
    if not v_found then
      v_reasons := array_append(v_reasons, case when p_role is null then 'NO_GRANT_FOR_PERMISSION_IN_SCOPE'
                                                else 'ROLE_NOT_HELD_WITH_PERMISSION_IN_SCOPE' end::text);
    elsif v_ok_grant.id is null then
      v_reasons := v_reasons || array(select distinct m from unnest(v_all_missing) m order by m);
    end if;
  end if;

  v_allowed := cardinality(v_reasons) = 0;
  insert into iam.authority_evaluation (at_instant, person_id, account_id, permission_code, role_filter, scope, allowed, reasons,
                                        role_code, grant_id, inputs, correlation_id, requested_by_account)
  values (v_at, p_person, p_account, p_permission, p_role, v_scope, v_allowed, v_reasons, v_ok_grant.role_code, v_ok_grant.id,
          jsonb_build_object('person_status', iam.person_status_at(p_person, v_at), 'account_status', iam.account_status_at(p_account, v_at),
                             'account_kind', v_acc.kind, 'account_generic', v_acc.is_generic, 'permission_domain', v_perm.domain,
                             'permission_effect', v_perm.effect, 'grants', v_grants, 'qualifications', v_quals),
          nullif(v_ctx ->> 'correlation_id', '')::uuid, nullif(v_ctx ->> 'account_id', '')::uuid)
  returning id into v_id;
  return jsonb_build_object('evaluation_id', v_id, 'allowed', v_allowed, 'reasons', to_jsonb(v_reasons), 'at', v_at,
                            'role_code', v_ok_grant.role_code, 'grant_id', v_ok_grant.id, 'permission', p_permission, 'scope', v_scope);
end
$$;

-- The permission guard: the validated actor, acting in the role named in its context, must hold
-- the permission in the scope right now. Raises EBMR-IAM-040 with a JSON DETAIL that callers can
-- use to log the refusal in a separate transaction (a refused command rolls back its own writes).
create function iam.require_permission(p_permission text, p_scope jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_eval  jsonb;
begin
  v_eval := iam.evaluate_authority((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, p_permission,
                                   coalesce(p_scope, '{}'::jsonb), clock_timestamp(), v_actor ->> 'role_code');
  if not (v_eval ->> 'allowed')::boolean then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-040 %s acting as %s lacks permission %s in scope %s: %s', v_actor ->> 'account_id', v_actor ->> 'role_code',
                       p_permission, coalesce(p_scope, '{}'::jsonb), v_eval -> 'reasons'),
      detail = jsonb_build_object('person_id', v_actor ->> 'person_id', 'account_id', v_actor ->> 'account_id',
                                  'role_code', v_actor ->> 'role_code', 'permission', p_permission, 'scope', coalesce(p_scope, '{}'::jsonb),
                                  'reasons', v_eval -> 'reasons')::text;
  end if;
  return v_actor || jsonb_build_object('evaluation_id', v_eval ->> 'evaluation_id');
end
$$;

-- Permissions an account holds in a scope at an instant (for screens; not a guard).
create function iam.permissions_held(p_account uuid, p_scope jsonb default '{}'::jsonb, p_at timestamptz default null) returns text[]
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select coalesce(array_agg(distinct rp.permission_code order by rp.permission_code), '{}')
  from iam.role_grant g
  join iam.role_permission rp on rp.role_code = g.role_code
  where g.account_id = p_account
    and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, coalesce(p_at, clock_timestamp()))
    and iam.role_permission_live_at(rp.added_at, rp.removed_at, coalesce(p_at, clock_timestamp()))
    and iam.scope_covers(g.scope_site, g.scope_area, g.scope_product, iam.check_scope(p_scope))
$$;

-- ---------------------------------------------------------------------------------------------
-- Qualification functions
-- ---------------------------------------------------------------------------------------------

create function iam.create_qualification_type(p_code text, p_name text, p_description text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('TRAINING.MANAGE', '{}'::jsonb);
  insert into iam.qualification_type (code, name, description) values (p_code, p_name, p_description);
end
$$;

create function iam.add_qualification_requirement(p_qualification text, p_role text, p_permission text, p_scope jsonb, p_reason text)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('TRAINING.MANAGE', '{}'::jsonb);
  v_scope jsonb := iam.check_scope(p_scope);
  v_id    uuid;
begin
  insert into iam.qualification_requirement (qualification_code, role_code, permission_code, scope_site, scope_area, scope_product,
                                             reason, created_by_person)
  values (p_qualification, p_role, p_permission, v_scope ->> 'site', v_scope ->> 'area', v_scope ->> 'product', p_reason,
          (v_actor ->> 'person_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function iam.end_qualification_requirement(p_requirement uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('TRAINING.MANAGE', '{}'::jsonb);
  update iam.qualification_requirement set effective_to = clock_timestamp() where id = p_requirement and effective_to is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-160 no live requirement with that id';
  end if;
end
$$;

create function iam.record_qualification(p_person uuid, p_qualification text, p_valid_from timestamptz, p_valid_to timestamptz,
                                         p_source text default 'INTERNAL', p_source_ref text default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('QUALIFICATION.RECORD', '{}'::jsonb);
  v_id    uuid;
begin
  if (v_actor ->> 'person_id')::uuid = p_person then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-003 nobody records their own qualification';
  end if;
  insert into iam.person_qualification (person_id, qualification_code, source_code, source_ref, valid_from, valid_to,
                                        recorded_by_person, recorded_by_account)
  values (p_person, p_qualification, coalesce(p_source, 'INTERNAL'), p_source_ref, p_valid_from, p_valid_to,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function iam.withdraw_qualification(p_person_qualification uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('QUALIFICATION.RECORD', '{}'::jsonb);
begin
  update iam.person_qualification
     set withdrawn_at = clock_timestamp(), withdrawn_by_person = (v_actor ->> 'person_id')::uuid, withdrawal_reason = p_reason
   where id = p_person_qualification and withdrawn_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-160 no live qualification record with that id';
  end if;
end
$$;

create function iam.record_mirror_heartbeat(p_source text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('QUALIFICATION.RECORD', '{}'::jsonb);
  if not exists (select 1 from iam.qualification_source where code = p_source and kind = 'MIRROR') then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-160 unknown mirror source';
  end if;
  insert into iam.mirror_heartbeat (source_code, last_synced_at) values (p_source, clock_timestamp())
  on conflict (source_code) do update set last_synced_at = excluded.last_synced_at;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Policy changes (ranges enforced; DI-19 refuses a configuration with neither aging nor screening)
-- ---------------------------------------------------------------------------------------------

create function iam.set_policy(p_key text, p_value text, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor  jsonb := iam.require_permission('IAM.POLICY_MANAGE', '{}'::jsonb);
  v_key    iam.policy_key%rowtype;
  v_int    bigint;
  v_value  text := btrim(coalesce(p_value, ''));
  v_aging  bigint;
  v_screen boolean;
begin
  select * into v_key from iam.policy_key where key = p_key;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-110 unknown policy key %s', p_key);
  end if;
  if v_key.value_type = 'INTEGER' then
    if v_value !~ '^-?[0-9]{1,15}$' then
      raise exception using errcode = 'P0001', message = format('EBMR-IAM-110 %s takes a whole number', p_key);
    end if;
    v_int := v_value::bigint;
    if (v_key.min_value is not null and v_int < v_key.min_value) or (v_key.max_value is not null and v_int > v_key.max_value) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-IAM-110 %s must lie between %s and %s', p_key, v_key.min_value, v_key.max_value);
    end if;
    v_value := v_int::text;
  elsif v_key.value_type = 'BOOLEAN' then
    if lower(v_value) not in ('true', 'false') then
      raise exception using errcode = 'P0001', message = format('EBMR-IAM-110 %s takes true or false', p_key);
    end if;
    v_value := lower(v_value);
  elsif v_key.allowed_values is not null and not v_value = any (v_key.allowed_values) then
    raise exception using errcode = 'P0001', message = format('EBMR-IAM-110 %s takes one of %s', p_key, v_key.allowed_values);
  end if;
  v_aging := case when p_key = 'credential.password_max_age_days' then v_value::bigint else iam.policy_int('credential.password_max_age_days') end;
  v_screen := case when p_key = 'credential.compromised_screening' then v_value::boolean else iam.policy_bool('credential.compromised_screening') end;
  if v_aging = 0 and not v_screen then
    raise exception using errcode = 'P0001',
      message = 'EBMR-IAM-111 DI-19: password aging or compromised-password screening must be active; this change would leave neither';
  end if;
  insert into iam.policy_value (key, value, set_by_person, set_by_account, reason)
  values (p_key, v_value, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, p_reason);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Security alert handling (DI-19: acknowledgement tracked; unanswered alerts escalate)
-- ---------------------------------------------------------------------------------------------

create function iam.acknowledge_alert(p_alert uuid, p_comment text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('IAM.ALERT_ACKNOWLEDGE', '{}'::jsonb);
  v_alert iam.security_alert%rowtype;
begin
  select * into v_alert from iam.security_alert where id = p_alert;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-150 unknown alert';
  end if;
  if v_alert.person_id = (v_actor ->> 'person_id')::uuid
     or v_alert.account_id in (select id from iam.account where person_id = (v_actor ->> 'person_id')::uuid) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-003 nobody acknowledges a security alert about themselves';
  end if;
  if exists (select 1 from iam.security_alert_action where alert_id = p_alert and action = 'ACKNOWLEDGED') then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-150 the alert is already acknowledged';
  end if;
  insert into iam.security_alert_action (alert_id, action, by_person, by_account, comment)
  values (p_alert, 'ACKNOWLEDGED', (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, p_comment);
end
$$;

-- Run by the scheduler under a SERVICE account (source SYSTEM), or by an alert handler.
create function iam.escalate_overdue_alerts() returns integer
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_count integer := 0;
  r       record;
begin
  if (select kind from iam.account where id = (v_actor ->> 'account_id')::uuid) <> 'SERVICE' then
    perform iam.require_permission('IAM.ALERT_ACKNOWLEDGE', '{}'::jsonb);
  end if;
  for r in
    select a.id, a.kind, a.severity, a.account_id from iam.security_alert a
    where a.ack_due_at <= clock_timestamp()
      and not exists (select 1 from iam.security_alert_action x where x.alert_id = a.id)
    order by a.raised_at
    for update of a
  loop
    insert into iam.security_alert_action (alert_id, action, by_person, by_account, comment)
    values (r.id, 'ESCALATED', (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, 'not acknowledged within the deadline');
    perform pg_notify('ebmr_security_alert_escalated', jsonb_build_object('alert_id', r.id, 'kind', r.kind, 'severity', r.severity,
                                                                          'account_id', r.account_id)::text);
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

create view iam.open_security_alert with (security_barrier) as
  select a.*, exists (select 1 from iam.security_alert_action x where x.alert_id = a.id and x.action = 'ESCALATED') as escalated
  from iam.security_alert a
  where not exists (select 1 from iam.security_alert_action x where x.alert_id = a.id and x.action = 'ACKNOWLEDGED');

-- ---------------------------------------------------------------------------------------------
-- Audit registration, protection, privileges
-- ---------------------------------------------------------------------------------------------

select kernel.register_audited_table('iam.qualification_type', 'qualification_type', 'code', false);
select kernel.register_audited_table('iam.person_qualification', 'person', 'person_id', false);
select kernel.register_audited_table('iam.qualification_requirement', 'qualification_requirement', 'qualification_code', false);
select iam.protect_rows('iam.qualification_type');
select iam.protect_rows('iam.qualification_source');
select iam.protect_rows('iam.person_qualification');
select iam.protect_rows('iam.qualification_requirement');

grant select on iam.qualification_type, iam.qualification_source, iam.mirror_heartbeat, iam.person_qualification,
                iam.qualification_requirement, iam.authority_evaluation, iam.open_security_alert to ebmr_app;
grant execute on function iam.qualification_source_fresh(text, timestamptz),
                          iam.evaluate_authority(uuid, uuid, text, jsonb, timestamptz, text), iam.require_permission(text, jsonb),
                          iam.permissions_held(uuid, jsonb, timestamptz), iam.create_qualification_type(text, text, text),
                          iam.add_qualification_requirement(text, text, text, jsonb, text), iam.end_qualification_requirement(uuid),
                          iam.record_qualification(uuid, text, timestamptz, timestamptz, text, text),
                          iam.withdraw_qualification(uuid, text), iam.record_mirror_heartbeat(text), iam.set_policy(text, text, text),
                          iam.acknowledge_alert(uuid, text), iam.escalate_overdue_alerts() to ebmr_app;

reset role;
