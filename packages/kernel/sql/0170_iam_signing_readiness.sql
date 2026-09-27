-- Identity and access (B1), part 8: what the signing module (B2) and later modules call about a
-- person before a signature or a segregated act (DI-15, DI-17, DI-21; outline 5.5 Part 11
-- administration, 7.1 delegation, 7.2 segregation).
--
--   iam.assert_can_sign(account)       DI-15/DI-21 readiness: active personal human account,
--                                      identity verified, no initial/reset secret pending, the
--                                      current e-signature accountability policy acknowledged.
--   iam.signature_register(at)         each signer's legal name, manifestation name, initials,
--                                      acknowledgement, roles and signing permissions as at T;
--   iam.resolve_signer(account, at)    one signer as at the signing date.
--   iam.delegation_valid(...)          validity of a cited delegation at signing (no re-delegation).
--   iam.assert_us_esig_certification   21 CFR 11.100(c) letter on file (BLOCK or FLAG by policy).
--   iam.assert_segregated(rule, persons)  dynamic segregation on the PERSON (DI-17), stored.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- E-signature accountability policy and acknowledgements (DI-21)
-- ---------------------------------------------------------------------------------------------

create table iam.esig_policy (
  code            text not null,
  version         integer not null check (version > 0),
  title           text not null,
  statement       text not null,
  content_sha256  text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  effective_from  timestamptz not null default clock_timestamp(),
  primary key (code, version)
);

insert into iam.esig_policy (code, version, title, statement, content_sha256)
select 'ESIG_ACCOUNTABILITY', 1, 'Electronic signature accountability policy', s, encode(sha256(convert_to(s, 'UTF8')), 'hex')
from (values (
  'Each electronic signature I apply in this system is legally binding and makes me as accountable as my handwritten signature '
  || 'would. I sign only with my own credentials, keep my password and PIN secret, never let anyone else use my credentials or '
  || 'badge and never use anyone else''s. I sign only what I have performed, verified, reviewed or approved myself, and I report '
  || 'at once any suspected loss, disclosure or misuse of my credentials or badge.')) as t (s);

create table iam.esig_acknowledgement (
  id                       uuid primary key default gen_random_uuid(),
  person_id                uuid not null,
  account_id               uuid not null,
  policy_code              text not null,
  policy_version           integer not null,
  manifestation_name       text not null,
  initials                 text check (initials is null or initials ~ '^[A-Za-z.]{1,8}$'),
  handwritten_equivalence  boolean not null check (handwritten_equivalence),
  acknowledged_at          timestamptz not null default clock_timestamp(),
  foreign key (account_id, person_id) references iam.account (id, person_id),
  foreign key (policy_code, policy_version) references iam.esig_policy (code, version)
);
create index esig_acknowledgement_account on iam.esig_acknowledgement (account_id, acknowledged_at desc);

create function iam.esig_acknowledgement_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  new.acknowledged_at := clock_timestamp();
  return new;
end
$$;
create trigger aa_esig_acknowledgement_guard before insert on iam.esig_acknowledgement
  for each row execute function iam.esig_acknowledgement_guard();

create function iam.current_esig_policy() returns iam.esig_policy
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select p.* from iam.esig_policy p where p.code = 'ESIG_ACCOUNTABILITY' and p.effective_from <= clock_timestamp()
  order by p.version desc limit 1
$$;

-- The person acknowledges, electronically and in their own command, before their first signature.
create function iam.acknowledge_esig_policy(p_initials text default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor  jsonb := iam.assert_validated_actor();
  v_policy iam.esig_policy := iam.current_esig_policy();
  v_acc    iam.account%rowtype;
  v_id     uuid;
begin
  select * into v_acc from iam.account where id = (v_actor ->> 'account_id')::uuid;
  if v_acc.kind <> 'HUMAN' or v_acc.is_generic or v_acc.is_break_glass then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-054 only personal human accounts sign, so only they acknowledge the policy';
  end if;
  insert into iam.esig_acknowledgement (person_id, account_id, policy_code, policy_version, manifestation_name, initials,
                                        handwritten_equivalence)
  values (v_acc.person_id, v_acc.id, v_policy.code, v_policy.version, (select legal_name from iam.person where id = v_acc.person_id),
          nullif(btrim(p_initials), ''), true)
  returning id into v_id;
  return v_id;
end
$$;

create function iam.can_sign(p_account uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_acc     iam.account%rowtype;
  v_person  iam.person%rowtype;
  v_reasons text[] := '{}';
  v_policy  iam.esig_policy := iam.current_esig_policy();
begin
  select * into v_acc from iam.account where id = p_account;
  if not found then
    return jsonb_build_object('can_sign', false, 'reasons', jsonb_build_array('ACCOUNT_UNKNOWN'));
  end if;
  select * into v_person from iam.person where id = v_acc.person_id;
  if v_acc.status <> 'ACTIVE' then v_reasons := array_append(v_reasons, 'ACCOUNT_NOT_ACTIVE'::text); end if;
  if v_person.status <> 'ACTIVE' then v_reasons := array_append(v_reasons, 'PERSON_NOT_ACTIVE'::text); end if;
  if v_acc.kind <> 'HUMAN' then v_reasons := array_append(v_reasons, 'ACCOUNT_KIND_CANNOT_SIGN'::text); end if;
  if v_acc.is_generic then v_reasons := array_append(v_reasons, 'GENERIC_ACCOUNT_CANNOT_SIGN'::text); end if;
  if v_acc.is_break_glass then v_reasons := array_append(v_reasons, 'BREAK_GLASS_CANNOT_SIGN'::text); end if;
  if iam.account_locked(p_account) then v_reasons := array_append(v_reasons, 'ACCOUNT_LOCKED'::text); end if;
  if v_person.kind <> 'NATURAL' or iam.current_identity_verification(v_person.id) is null then
    v_reasons := array_append(v_reasons, 'IDENTITY_NOT_VERIFIED'::text);
  end if;
  if exists (select 1 from iam.credential c where c.account_id = p_account and c.status = 'ACTIVE'
               and (c.must_change or (c.expires_at is not null and c.expires_at <= clock_timestamp()))) then
    v_reasons := array_append(v_reasons, 'SECRET_MUST_BE_CHANGED'::text);
  end if;
  if not exists (select 1 from iam.esig_acknowledgement a where a.account_id = p_account and a.policy_code = v_policy.code
                   and a.policy_version = v_policy.version) then
    v_reasons := array_append(v_reasons, 'ESIG_POLICY_NOT_ACKNOWLEDGED'::text);
  end if;
  if not exists (select 1 from iam.role_grant g join iam.role_permission rp on rp.role_code = g.role_code
                   join iam.permission pm on pm.code = rp.permission_code
                 where g.account_id = p_account and pm.effect = 'SIGN'
                   and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, clock_timestamp())
                   and iam.role_permission_live_at(rp.added_at, rp.removed_at, clock_timestamp())) then
    v_reasons := array_append(v_reasons, 'NO_SIGNING_PERMISSION'::text);
  end if;
  return jsonb_build_object('can_sign', cardinality(v_reasons) = 0, 'reasons', to_jsonb(v_reasons), 'account_id', p_account,
                            'policy_version', v_policy.version);
end
$$;

create function iam.assert_can_sign(p_account uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v jsonb := iam.can_sign(p_account);
begin
  if not (v ->> 'can_sign')::boolean then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-054 the account cannot sign: %s', v -> 'reasons'), detail = v::text;
  end if;
  return v;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Signature register (DI-21; EU Ch.4 signature lists, paraphrased): resolvable as at any date
-- ---------------------------------------------------------------------------------------------

create function iam.resolve_signer(p_account uuid, p_at timestamptz) returns jsonb
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select jsonb_build_object(
    'account_id', a.id, 'login_name', a.login_name, 'person_id', a.person_id,
    'legal_name', iam.person_name_at(a.person_id, p_at),
    'account_status', iam.account_status_at(a.id, p_at),
    'account_valid_from', (select min(e.changed_at) from iam.account_status_event e where e.account_id = a.id and e.status = 'ACTIVE'),
    'account_valid_to', (select min(e.changed_at) from iam.account_status_event e where e.account_id = a.id and e.status = 'DISABLED'),
    'roles', coalesce((select jsonb_agg(distinct g.role_code) from iam.role_grant g
                       where g.account_id = a.id and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, p_at)), '[]'::jsonb),
    'signing_permissions', coalesce((select jsonb_agg(distinct rp.permission_code) from iam.role_grant g
                       join iam.role_permission rp on rp.role_code = g.role_code
                       join iam.permission pm on pm.code = rp.permission_code and pm.effect = 'SIGN'
                       where g.account_id = a.id and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, p_at)
                         and iam.role_permission_live_at(rp.added_at, rp.removed_at, p_at)), '[]'::jsonb),
    'acknowledgement', (select jsonb_build_object('manifestation_name', k.manifestation_name, 'initials', k.initials,
                                                  'policy_version', k.policy_version, 'handwritten_equivalence', k.handwritten_equivalence,
                                                  'acknowledged_at', k.acknowledged_at)
                        from iam.esig_acknowledgement k where k.account_id = a.id and k.acknowledged_at <= p_at
                        order by k.acknowledged_at desc limit 1))
  from iam.account a where a.id = p_account
$$;

create function iam.signature_register(p_at timestamptz default null) returns table (
  account_id uuid, login_name text, person_id uuid, legal_name text, manifestation_name text, initials text,
  policy_version integer, handwritten_equivalence boolean, acknowledged_at timestamptz, account_status text,
  roles jsonb, signing_permissions jsonb)
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  with t as (select coalesce(p_at, clock_timestamp()) as at)
  select a.id, a.login_name, a.person_id, r ->> 'legal_name', r -> 'acknowledgement' ->> 'manifestation_name',
         r -> 'acknowledgement' ->> 'initials', (r -> 'acknowledgement' ->> 'policy_version')::integer,
         (r -> 'acknowledgement' ->> 'handwritten_equivalence')::boolean, (r -> 'acknowledgement' ->> 'acknowledged_at')::timestamptz,
         r ->> 'account_status', r -> 'roles', r -> 'signing_permissions'
  from t cross join iam.account a
  cross join lateral (select iam.resolve_signer(a.id, t.at) as r) x
  where a.kind = 'HUMAN' and not a.is_generic and not a.is_break_glass and a.created_at <= t.at
  order by 4, 2
$$;

-- ---------------------------------------------------------------------------------------------
-- Delegation (outline 7.1; IN-05(b)): the delegate signs with their own credentials citing it
-- ---------------------------------------------------------------------------------------------

create table iam.delegation (
  id                    uuid primary key default gen_random_uuid(),
  delegator_person      uuid not null references iam.person (id),
  delegate_person       uuid not null references iam.person (id),
  scope_site            text,
  scope_area            text,
  scope_product         text,
  markets               text[] not null default '{}' check (markets <@ array['IN', 'US', 'EU']),
  meanings              text[] not null check (cardinality(meanings) >= 1),
  valid_from            timestamptz not null,
  valid_to              timestamptz not null,
  sop_ref               text not null check (btrim(sop_ref) <> ''),
  reason                text not null check (btrim(reason) <> ''),
  status                text not null check (status in ('REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED')),
  requested_by_person   uuid not null,
  requested_by_account  uuid not null,
  requested_at          timestamptz not null default clock_timestamp(),
  decided_by_person     uuid,
  decided_by_account    uuid,
  decided_at            timestamptz,
  decision_reason       text,
  revoked_by_person     uuid,
  revoked_at            timestamptz,
  revocation_reason     text,
  check (valid_to > valid_from),
  check (delegator_person <> delegate_person),
  check (decided_by_person is null
         or (decided_by_person <> delegate_person and decided_by_person <> delegator_person and decided_by_person <> requested_by_person)),
  check (status = 'REQUESTED' or decided_at is not null),
  check (status <> 'REVOKED' or revoked_at is not null)
);
create index delegation_delegate on iam.delegation (delegate_person);

create function iam.delegation_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'REQUESTED' or new.decided_by_person is not null or new.revoked_by_person is not null then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-180 a delegation starts as a request';
    end if;
    new.requested_at := clock_timestamp();
  else
    if new.id <> old.id or new.delegator_person <> old.delegator_person or new.delegate_person <> old.delegate_person
       or new.scope_site is distinct from old.scope_site or new.scope_area is distinct from old.scope_area
       or new.scope_product is distinct from old.scope_product or new.markets <> old.markets or new.meanings <> old.meanings
       or new.valid_from <> old.valid_from or new.valid_to <> old.valid_to or new.sop_ref <> old.sop_ref
       or new.requested_by_person <> old.requested_by_person or new.requested_at <> old.requested_at then
      raise exception using errcode = 'P0001', message = 'EBMR-IAM-180 a delegation never changes; revoke it and request a new one';
    end if;
    if old.status = 'REQUESTED' and new.status in ('APPROVED', 'REJECTED') then
      new.decided_at := clock_timestamp();
    elsif old.status = 'APPROVED' and new.status = 'REVOKED' then
      if new.decided_by_person <> old.decided_by_person or new.decided_at <> old.decided_at then
        raise exception using errcode = 'P0001', message = 'EBMR-IAM-180 the approval of a delegation never changes';
      end if;
      new.revoked_at := clock_timestamp();
    else
      raise exception using errcode = 'P0001', message = format('EBMR-IAM-180 a delegation cannot go from %s to %s', old.status, new.status);
    end if;
  end if;
  -- No re-delegation: a person who holds a live delegation for a meaning cannot pass it on.
  if new.status in ('REQUESTED', 'APPROVED') and exists (
       select 1 from iam.delegation d
       where d.delegate_person = new.delegator_person and d.id <> new.id and d.status = 'APPROVED' and d.revoked_at is null
         and d.valid_to > clock_timestamp() and d.meanings && new.meanings) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-181 no re-delegation: the delegator holds these meanings only by delegation';
  end if;
  return new;
end
$$;
create trigger aa_delegation_guard before insert or update on iam.delegation for each row execute function iam.delegation_guard();

-- The delegator requests; someone other than the delegator and the delegate approves.
create function iam.request_delegation(p_delegate uuid, p_scope jsonb, p_markets text[], p_meanings text[], p_valid_from timestamptz,
                                       p_valid_to timestamptz, p_sop_ref text, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_scope jsonb := iam.check_scope(p_scope);
  v_id    uuid;
begin
  if not exists (select 1 from iam.role_grant g join iam.role_permission rp on rp.role_code = g.role_code
                   join iam.permission pm on pm.code = rp.permission_code
                 where g.account_id = (v_actor ->> 'account_id')::uuid and pm.effect = 'SIGN'
                   and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, clock_timestamp())
                   and iam.role_permission_live_at(rp.added_at, rp.removed_at, clock_timestamp())) then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-180 only a person who holds signing authority can delegate it';
  end if;
  if not exists (select 1 from iam.person where id = p_delegate and kind = 'NATURAL' and status = 'ACTIVE') then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-180 the delegate must be an active natural person';
  end if;
  insert into iam.delegation (delegator_person, delegate_person, scope_site, scope_area, scope_product, markets, meanings, valid_from,
                              valid_to, sop_ref, reason, status, requested_by_person, requested_by_account)
  values ((v_actor ->> 'person_id')::uuid, p_delegate, v_scope ->> 'site', v_scope ->> 'area', v_scope ->> 'product',
          coalesce(p_markets, '{}'), p_meanings, p_valid_from, p_valid_to, p_sop_ref, p_reason, 'REQUESTED',
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function iam.decide_delegation(p_delegation uuid, p_approve boolean, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('IAM.DELEGATION_APPROVE', '{}'::jsonb);
begin
  update iam.delegation set status = case when p_approve then 'APPROVED' else 'REJECTED' end,
         decided_by_person = (v_actor ->> 'person_id')::uuid, decided_by_account = (v_actor ->> 'account_id')::uuid, decision_reason = p_reason
   where id = p_delegation and status = 'REQUESTED';
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-180 no pending delegation with that id';
  end if;
end
$$;

create function iam.revoke_delegation(p_delegation uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
begin
  if (select delegator_person from iam.delegation where id = p_delegation) is distinct from (v_actor ->> 'person_id')::uuid then
    perform iam.require_permission('IAM.DELEGATION_APPROVE', '{}'::jsonb);
  end if;
  update iam.delegation set status = 'REVOKED', revoked_by_person = (v_actor ->> 'person_id')::uuid, revocation_reason = p_reason
   where id = p_delegation and status = 'APPROVED';
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-180 no approved delegation with that id';
  end if;
end
$$;

-- Validity check B2 calls at signing (S10 on the delegate is B2's involvement check).
create function iam.delegation_valid(p_delegation uuid, p_delegate_person uuid, p_meaning text, p_scope jsonb, p_market text,
                                     p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_at      timestamptz := coalesce(p_at, clock_timestamp());
  v_d       iam.delegation%rowtype;
  v_reasons text[] := '{}';
begin
  select * into v_d from iam.delegation where id = p_delegation;
  if not found then
    return jsonb_build_object('valid', false, 'reasons', jsonb_build_array('DELEGATION_UNKNOWN'));
  end if;
  if v_d.status not in ('APPROVED', 'REVOKED') or v_d.decided_at > v_at then v_reasons := array_append(v_reasons, 'NOT_APPROVED'::text); end if;
  if v_d.revoked_at is not null and v_d.revoked_at <= v_at then v_reasons := array_append(v_reasons, 'REVOKED'::text); end if;
  if v_at < v_d.valid_from or v_at >= v_d.valid_to then v_reasons := array_append(v_reasons, 'OUTSIDE_VALIDITY_WINDOW'::text); end if;
  if v_d.delegate_person is distinct from p_delegate_person then v_reasons := array_append(v_reasons, 'NOT_THE_DELEGATE'::text); end if;
  if not p_meaning = any (v_d.meanings) then v_reasons := array_append(v_reasons, 'MEANING_NOT_DELEGATED'::text); end if;
  if not iam.scope_covers(v_d.scope_site, v_d.scope_area, v_d.scope_product, iam.check_scope(p_scope)) then
    v_reasons := array_append(v_reasons, 'SCOPE_NOT_COVERED'::text);
  end if;
  if cardinality(v_d.markets) > 0 and (p_market is null or not p_market = any (v_d.markets)) then
    v_reasons := array_append(v_reasons, 'MARKET_NOT_COVERED'::text);
  end if;
  if coalesce(iam.person_status_at(v_d.delegate_person, v_at), 'NONE') <> 'ACTIVE' then
    v_reasons := array_append(v_reasons, 'DELEGATE_NOT_ACTIVE'::text);
  end if;
  return jsonb_build_object('valid', cardinality(v_reasons) = 0, 'reasons', to_jsonb(v_reasons), 'delegation_id', v_d.id,
                            'delegator_person', v_d.delegator_person, 'sop_ref', v_d.sop_ref);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 21 CFR 11.100(c) certification letter per legal entity (DI-15 and its proposed_modify).
-- Policy esig.us_certification_mode: BLOCK (outline 5.5, default) refuses US-market batch issue
-- when the letter is missing; FLAG (catalog) only reports it. The expert decision is pending.
-- ---------------------------------------------------------------------------------------------

create table iam.us_esig_certification (
  id                        uuid primary key default gen_random_uuid(),
  legal_entity              text not null check (btrim(legal_entity) <> ''),
  letter_ref                text not null check (btrim(letter_ref) <> ''),
  submitted_on              date not null,
  fda_acknowledgement_ref   text,
  recorded_by_person        uuid not null,
  recorded_by_account       uuid not null,
  recorded_at               timestamptz not null default clock_timestamp()
);

create function iam.record_us_esig_certification(p_legal_entity text, p_letter_ref text, p_submitted_on date,
                                                 p_fda_acknowledgement_ref text default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('IAM.CERTIFICATION_RECORD', '{}'::jsonb);
  v_id    uuid;
begin
  if p_submitted_on > current_date then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-170 a submission date cannot be in the future';
  end if;
  insert into iam.us_esig_certification (legal_entity, letter_ref, submitted_on, fda_acknowledgement_ref, recorded_by_person, recorded_by_account)
  values (btrim(p_legal_entity), p_letter_ref, p_submitted_on, p_fda_acknowledgement_ref, (v_actor ->> 'person_id')::uuid,
          (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function iam.us_esig_certification_status(p_legal_entity text) returns jsonb
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select jsonb_build_object('legal_entity', p_legal_entity, 'on_file', c.id is not null, 'certification_id', c.id,
                            'mode', iam.policy_text('esig.us_certification_mode'),
                            'blocking', c.id is null and iam.policy_text('esig.us_certification_mode') = 'BLOCK')
  from (select 1) one
  left join lateral (select x.id from iam.us_esig_certification x where x.legal_entity = btrim(p_legal_entity)
                     order by x.recorded_at desc limit 1) c on true
$$;

create function iam.assert_us_esig_certification(p_legal_entity text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v jsonb := iam.us_esig_certification_status(p_legal_entity);
begin
  if (v ->> 'blocking')::boolean then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-170 no 21 CFR 11.100(c) certification is on file for %s; US-market batches cannot be issued', p_legal_entity),
      detail = v::text;
  end if;
  return v;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Dynamic segregation on the person (DI-17): the acting person must not be in the set of persons
-- a rule excludes (for example everyone who entered or corrected a record, or everyone involved in
-- a batch). Every evaluation is stored; a refusal raises EBMR-IAM-041 with a JSON DETAIL so the
-- caller can log it again after the command rolls back.
-- ---------------------------------------------------------------------------------------------

create table iam.segregation_evaluation (
  id               uuid primary key default gen_random_uuid(),
  evaluated_at     timestamptz not null default clock_timestamp(),
  rule_code        text not null,
  person_id        uuid not null,
  excluded_persons uuid[] not null,
  subject          text,
  allowed          boolean not null,
  correlation_id   uuid
);
select iam.protect_log('iam.segregation_evaluation');

create function iam.evaluate_segregation(p_rule text, p_person uuid, p_excluded uuid[], p_subject text default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_allowed boolean := not (p_person = any (coalesce(p_excluded, '{}')));
  v_id      uuid;
begin
  insert into iam.segregation_evaluation (rule_code, person_id, excluded_persons, subject, allowed, correlation_id)
  values (p_rule, p_person, coalesce(p_excluded, '{}'), p_subject, v_allowed, nullif(kernel.current_actor() ->> 'correlation_id', '')::uuid)
  returning id into v_id;
  return jsonb_build_object('evaluation_id', v_id, 'allowed', v_allowed, 'rule', p_rule, 'person_id', p_person, 'subject', p_subject);
end
$$;

create function iam.assert_segregated(p_rule text, p_excluded uuid[], p_subject text default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_person uuid := iam.actor_person();
  v        jsonb := iam.evaluate_segregation(p_rule, v_person, p_excluded, p_subject);
begin
  if not (v ->> 'allowed')::boolean then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IAM-041 %s: this person is involved in %s and cannot perform this act', p_rule, coalesce(p_subject, 'the record')),
      detail = jsonb_build_object('rule', p_rule, 'person_id', v_person, 'excluded', p_excluded, 'subject', p_subject)::text;
  end if;
  return v;
end
$$;

-- Persons who created or changed a record, from the audit trail (person-based, whatever account).
create function iam.record_entry_persons(p_table regclass, p_record_id text) returns uuid[]
language sql stable security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
  select coalesce(array_agg(distinct (e.payload -> 'actor' ->> 'person_id')::uuid), '{}')
  from kernel.audit_event e
  where e.table_name = p_table::text and e.record_id = p_record_id and e.action in ('INSERT', 'UPDATE', 'DELETE')
$$;

-- Persons with any audit event on an aggregate chain (a stand-in for the involvement set until
-- Phase 4 computes it from signatures and entries).
create function iam.chain_persons(p_chain_key text) returns uuid[]
language sql stable security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
  select coalesce(array_agg(distinct (e.payload -> 'actor' ->> 'person_id')::uuid), '{}')
  from kernel.audit_event e where e.chain_key = p_chain_key and e.action in ('INSERT', 'UPDATE', 'DELETE', 'BUSINESS')
$$;

-- ---------------------------------------------------------------------------------------------
-- Audit registration, protection, privileges
-- ---------------------------------------------------------------------------------------------

select kernel.register_audited_table('iam.esig_acknowledgement', 'person', 'person_id', true);
select kernel.register_audited_table('iam.delegation', 'delegation', 'id', false);
select kernel.register_audited_table('iam.us_esig_certification', 'legal_entity', 'legal_entity', true);
select iam.protect_rows('iam.esig_policy');
select iam.protect_rows('iam.delegation');

grant select on iam.esig_policy, iam.esig_acknowledgement, iam.delegation, iam.us_esig_certification, iam.segregation_evaluation to ebmr_app;
grant execute on function iam.current_esig_policy(), iam.acknowledge_esig_policy(text), iam.can_sign(uuid), iam.assert_can_sign(uuid),
                          iam.resolve_signer(uuid, timestamptz), iam.signature_register(timestamptz),
                          iam.request_delegation(uuid, jsonb, text[], text[], timestamptz, timestamptz, text, text),
                          iam.decide_delegation(uuid, boolean, text), iam.revoke_delegation(uuid, text),
                          iam.delegation_valid(uuid, uuid, text, jsonb, text, timestamptz),
                          iam.record_us_esig_certification(text, text, date, text), iam.us_esig_certification_status(text),
                          iam.assert_us_esig_certification(text), iam.evaluate_segregation(text, uuid, uuid[], text),
                          iam.assert_segregated(text, uuid[], text), iam.record_entry_persons(regclass, text),
                          iam.chain_persons(text) to ebmr_app;

reset role;
