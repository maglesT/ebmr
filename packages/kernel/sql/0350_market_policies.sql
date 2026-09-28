-- Market-profile engine, part 6: policy switches as versioned data (build outline 3.5, 5.8; L-25;
-- ADR 0008; invariant INV-47).
--
-- A policy is a design-choice switch (for example "QA approval of each void"). Its positions are
-- listed from least to most strict. Each change is a new policy version with an effective instant
-- that can never be back-dated. A batch pins, at issue, the version in force at that instant.
-- Afterwards only a tightening can reach the batch; a loosening never applies to a batch issued
-- before the loosening's effective instant (INV-47). A BEFORE INSERT trigger on the pin table
-- enforces this for every writer, including the table owner; pins of one batch and policy are
-- serialised, and what a batch applies is its strictest pin.
--
-- Each version has an author and, for a loosening, an approver (DI-09): the approval is an
-- e-signature POLICY_LOOSENING_APPROVED (0360) of exactly that version (policy, number, position)
-- by a person other than the author. A VENDOR-level switch is part of the vendor profile, set from
-- the expert's decisions: after its first version it changes only through a software release, never
-- through the tenant path. A switch whose loosening needs OWNER_CONFIRMATION cannot be loosened
-- through the tenant path either (no owner-confirmation path exists yet).

set local role ebmr_owner;

create table market.policy (
  code                text primary key check (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*$'),
  title               text not null,
  level               text not null check (level in ('VENDOR', 'TENANT')),
  controls            text[] not null default '{}',
  positions           jsonb not null check (case when jsonb_typeof(positions) = 'array' then jsonb_array_length(positions) >= 2 else false end),
  default_position    text not null,
  loosening_requires  text not null check (loosening_requires in ('QA_APPROVAL', 'CHANGE_CONTROL', 'OWNER_CONFIRMATION')),
  defined_at          timestamptz not null default clock_timestamp(),
  defined_by          uuid not null,
  check (positions @> jsonb_build_array(default_position))
);
comment on column market.policy.positions is 'Allowed positions from least strict to most strict.';

create table market.policy_version (
  id                   uuid primary key default gen_random_uuid(),
  policy_code          text not null references market.policy (code),
  version              integer not null check (version >= 1),
  position             text not null,
  effective_from       timestamptz,
  recorded_at          timestamptz not null default clock_timestamp(),
  direction            text not null check (direction in ('INITIAL', 'TIGHTENING', 'LOOSENING', 'UNCHANGED')),
  previous_version_id  uuid references market.policy_version (id),
  author_person_id     uuid not null,
  approval_id          uuid,
  approver_person_id   uuid,
  change_ref           text,
  reason               text not null check (length(trim(reason)) > 0),
  unique (policy_code, version),
  check (effective_from is not null and effective_from >= recorded_at),
  check (direction <> 'LOOSENING' or (approval_id is not null and approver_person_id is not null and coalesce(length(trim(change_ref)), 0) > 0)),
  check ((approval_id is null) = (approver_person_id is null))
);
comment on column market.policy_version.approval_id is 'The POLICY_LOOSENING_APPROVED e-signature of this version (esig.signature id); required for a loosening.';
comment on column market.policy_version.approver_person_id is 'The person who signed approval_id (never the author).';

create table market.batch_policy_pin (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null,
  policy_code        text not null references market.policy (code),
  policy_version_id  uuid not null references market.policy_version (id),
  pin_kind           text not null check (pin_kind in ('ISSUE', 'TIGHTENING')),
  issue_instant      timestamptz not null,
  recorded_at        timestamptz not null default clock_timestamp(),
  change_ref         text,
  reason             text,
  check (pin_kind = 'ISSUE' or coalesce(length(trim(change_ref)), 0) > 0)
);
create unique index batch_policy_pin_issue on market.batch_policy_pin (batch_id, policy_code) where pin_kind = 'ISSUE';
create index batch_policy_pin_lookup on market.batch_policy_pin (batch_id, policy_code, recorded_at);

create function market.position_rank(p_policy text, p_position text) returns integer
language sql stable security definer set search_path = pg_catalog, market, pg_temp as $$
  select (select o.ord::integer from market.policy p, jsonb_array_elements_text(p.positions) with ordinality as o(v, ord)
           where p.code = p_policy and o.v = p_position)
$$;

-- The version in force at an instant: the newest version whose effective instant has been reached.
create function market.policy_version_at(p_policy text, p_at timestamptz) returns market.policy_version
language sql stable security definer set search_path = pg_catalog, market, pg_temp as $$
  select v.* from market.policy_version v
  where v.policy_code = p_policy and v.effective_from <= p_at
  order by v.effective_from desc, v.version desc
  limit 1
$$;

-- The aggregate an approver signs to approve a policy version (content provider in 0360):
-- <policy code>@<version number>@<position>.
create function market.policy_version_ref(p_policy text, p_version integer, p_position text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_policy || '@' || p_version::text || '@' || p_position
$$;

-- The software-release pipeline identity (as esig.meaning_type_guard, 0210): only owner-level code
-- installs it (kernel.set_actor_context); no command started by kernel.begin_command can carry it.
create function market.is_release_actor(p_actor jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(p_actor ->> 'role_code' = 'SOFTWARE_RELEASE' and p_actor ->> 'source' = 'SYSTEM'
                  and p_actor ->> 'person_id' = '00000000-0000-0000-0000-000000000000', false)
$$;

-- What the approver of a new version of a policy signs, without writing anything:
-- {meaning, aggregateType, aggregateId, version, position}. The version is the next number.
create function market.policy_version_target(p_policy text, p_position text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, market, pg_temp as $$
declare
  v_next integer;
begin
  if not exists (select 1 from market.policy where code = p_policy) then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-071 unknown policy %s', p_policy);
  end if;
  if market.position_rank(p_policy, p_position) is null then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-071 %s is not a position of policy %s', p_position, p_policy);
  end if;
  select coalesce(max(v.version), 0) + 1 into v_next from market.policy_version v where v.policy_code = p_policy;
  return jsonb_build_object('meaning', 'POLICY_LOOSENING_APPROVED', 'aggregateType', 'market_policy_version',
                            'aggregateId', market.policy_version_ref(p_policy, v_next, p_position), 'version', v_next, 'position', p_position);
end
$$;

-- Policy versions: numbered, never back-dated, never inserted before an already scheduled version,
-- direction computed against the previous version; a loosening needs a change record and the
-- approver's e-signature of this version; a VENDOR-level switch changes only through a release.
create function market.policy_version_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, market, kernel, pg_temp as $$
declare
  v_prev   market.policy_version;
  v_ctx    jsonb := kernel.current_actor();
  v_rank   integer;
  v_prank  integer;
  p        market.policy;
begin
  if v_ctx is null then
    raise exception using errcode = 'P0001', message = 'EBMR-AUDIT-001 no actor context: call kernel.begin_command first';
  end if;
  perform pg_advisory_xact_lock(hashtext('market.policy:' || new.policy_code));
  select * into p from market.policy where code = new.policy_code;
  new.recorded_at := clock_timestamp();
  new.author_person_id := (v_ctx ->> 'person_id')::uuid;
  if new.effective_from is null then
    new.effective_from := new.recorded_at;
  elsif new.effective_from < new.recorded_at then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-MKT-070 policy %s: a version cannot take effect in the past (%s is before now, %s)', new.policy_code, new.effective_from, new.recorded_at);
  end if;
  v_rank := market.position_rank(new.policy_code, new.position);
  if v_rank is null then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-071 %s is not a position of policy %s', new.position, new.policy_code);
  end if;
  select * into v_prev from market.policy_version where policy_code = new.policy_code order by version desc limit 1;
  if not found then
    new.version := 1;
    new.direction := 'INITIAL';
    new.previous_version_id := null;
  else
    if new.effective_from < v_prev.effective_from then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-072 policy %s: version %s already takes effect at %s; a new version cannot take effect before it', new.policy_code, v_prev.version, v_prev.effective_from);
    end if;
    new.version := v_prev.version + 1;
    new.previous_version_id := v_prev.id;
    v_prank := market.position_rank(new.policy_code, v_prev.position);
    new.direction := case when v_rank > v_prank then 'TIGHTENING' when v_rank < v_prank then 'LOOSENING' else 'UNCHANGED' end;
    if coalesce(trim(new.change_ref), '') = '' then
      raise exception using errcode = 'P0001', message = format('EBMR-MKT-073 policy %s: a change needs a change-control reference', new.policy_code);
    end if;
    if new.direction = 'LOOSENING' and new.approval_id is null then
      raise exception using errcode = 'P0001', message = format('EBMR-MKT-073 policy %s: a loosening needs an approval record', new.policy_code);
    end if;
    if p.level = 'VENDOR' and not market.is_release_actor(v_ctx) then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-074 policy %s is a vendor-profile switch; it changes only through a software release of the vendor profile', new.policy_code);
    end if;
    if new.direction = 'LOOSENING' and p.loosening_requires = 'OWNER_CONFIRMATION' and not market.is_release_actor(v_ctx) then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-074 loosening policy %s needs the owner''s confirmation, which the tenant path cannot give', new.policy_code);
    end if;
  end if;
  -- The approval: an e-signature of this version by a person other than its author (EBMR-ESIG-070
  -- when it is not a valid POLICY_LOOSENING_APPROVED signature of this policy, number and position).
  new.approver_person_id := null;
  if new.approval_id is not null then
    new.approver_person_id := (esig.assert_signature(new.approval_id, 'POLICY_LOOSENING_APPROVED', 'market_policy_version',
                                                     market.policy_version_ref(new.policy_code, new.version, new.position)) ->> 'signer_person')::uuid;
    if new.approver_person_id = new.author_person_id then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-075 policy %s version %s: the author cannot approve their own change; another person signs the approval', new.policy_code, new.version);
    end if;
  end if;
  return new;
end
$$;
create trigger a_guard before insert on market.policy_version for each row execute function market.policy_version_guard();

-- INV-47: a pin never lets a loosening reach a batch issued before the loosening's effective instant.
create function market.policy_pin_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, market, kernel, pg_temp as $$
declare
  v        market.policy_version;
  v_issue  market.batch_policy_pin;
  v_cur    market.policy_version;
  v_at     market.policy_version;
begin
  if kernel.current_actor() is null then
    raise exception using errcode = 'P0001', message = 'EBMR-AUDIT-001 no actor context: call kernel.begin_command first';
  end if;
  -- One pin at a time per batch and policy, so the comparison below sees every pin already made,
  -- including one committed while this command waited (F26, INV-47).
  perform pg_advisory_xact_lock(hashtext('market.batch_policy:' || new.batch_id::text || ':' || new.policy_code));
  new.recorded_at := clock_timestamp();
  select * into v from market.policy_version where id = new.policy_version_id;
  if not found or v.policy_code <> new.policy_code then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-080 version %s is not a version of policy %s', new.policy_version_id, new.policy_code);
  end if;
  if new.pin_kind = 'ISSUE' then
    if new.issue_instant is null or new.issue_instant > new.recorded_at then
      raise exception using errcode = 'P0001', message = 'EBMR-MKT-081 a batch is pinned at its issue instant, which cannot be in the future';
    end if;
    v_at := market.policy_version_at(new.policy_code, new.issue_instant);
    if v_at.id is distinct from v.id then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-082 policy %s: batch %s must pin the version in force at issue (%s), not version %s (INV-47)',
        new.policy_code, new.batch_id, coalesce(v_at.version::text, 'none'), v.version);
    end if;
    return new;
  end if;
  -- A later pin: only a tightening already in force, never a loosening (INV-47).
  select * into v_issue from market.batch_policy_pin where batch_id = new.batch_id and policy_code = new.policy_code and pin_kind = 'ISSUE';
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-083 batch %s has no issue pin for policy %s', new.batch_id, new.policy_code);
  end if;
  new.issue_instant := v_issue.issue_instant;
  if v.effective_from > new.recorded_at then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-084 policy %s version %s is not in force yet', new.policy_code, v.version);
  end if;
  -- The strictest position the batch already applies.
  select pv.* into v_cur
    from market.batch_policy_pin p join market.policy_version pv on pv.id = p.policy_version_id
   where p.batch_id = new.batch_id and p.policy_code = new.policy_code
   order by market.position_rank(new.policy_code, pv.position) desc, p.recorded_at desc, p.id desc limit 1;
  if market.position_rank(new.policy_code, v.position) <= market.position_rank(new.policy_code, v_cur.position) then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-MKT-085 policy %s version %s (%s) is not stricter than what batch %s already applies (%s); a loosening never applies to a batch issued before it took effect (INV-47)',
      new.policy_code, v.version, v.position, new.batch_id, v_cur.position);
  end if;
  return new;
end
$$;
create trigger a_guard before insert on market.batch_policy_pin for each row execute function market.policy_pin_guard();

-- p_def: {code, title, level, controls, positions (least -> most strict), defaultPosition, looseningRequires, reason}.
-- Creates the policy and its version 1 at the default position, in force now.
create function market.define_policy(p_def jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, market, kernel, pg_temp as $$
declare
  v_ctx jsonb := kernel.current_actor();
  v market.policy_version;
begin
  if v_ctx is null then
    raise exception using errcode = 'P0001', message = 'EBMR-AUDIT-001 no actor context: call kernel.begin_command first';
  end if;
  -- DI-18, then DI-17 installation-wide.
  perform iam.assert_not_administrator();
  perform iam.require_permission('MARKET.POLICY_CHANGE', '{}'::jsonb);
  if p_def ->> 'level' = 'VENDOR' then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-MKT-074 policy %s: a vendor-profile switch is defined by a software release of the vendor profile, not through the tenant path',
      p_def ->> 'code');
  end if;
  if jsonb_typeof(p_def -> 'positions') is distinct from 'array'
     or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_def -> 'positions') = 'array' then p_def -> 'positions' else '[]'::jsonb end) x
                where jsonb_typeof(x) <> 'string' or not market.is_identifier(x #>> '{}'))
     or (select count(distinct x) from jsonb_array_elements(case when jsonb_typeof(p_def -> 'positions') = 'array' then p_def -> 'positions' else '[]'::jsonb end) x)
        <> jsonb_array_length(case when jsonb_typeof(p_def -> 'positions') = 'array' then p_def -> 'positions' else '[]'::jsonb end) then
    raise exception using errcode = 'P0001', message = 'EBMR-MKT-071 policy positions must be distinct identifiers from least to most strict';
  end if;
  insert into market.policy (code, title, level, controls, positions, default_position, loosening_requires, defined_by)
  values (p_def ->> 'code', p_def ->> 'title', p_def ->> 'level',
          array(select jsonb_array_elements_text(coalesce(p_def -> 'controls', '[]'::jsonb))), p_def -> 'positions',
          p_def ->> 'defaultPosition', coalesce(p_def ->> 'looseningRequires', 'QA_APPROVAL'), (v_ctx ->> 'person_id')::uuid);
  -- version, direction, author and instants are set by market.policy_version_guard.
  insert into market.policy_version (policy_code, position, effective_from, reason)
  values (p_def ->> 'code', p_def ->> 'defaultPosition', null, coalesce(nullif(trim(p_def ->> 'reason'), ''), 'initial position'))
  returning * into v;
  return to_jsonb(v);
end
$$;

-- New version of a policy. p_effective_from NULL = now. p_options: {approvalId, changeRef, reason}.
-- approvalId is the id of the approver's POLICY_LOOSENING_APPROVED e-signature of this version
-- (market.policy_version_target names what to sign); a loosening needs it.
create function market.set_policy_version(p_policy text, p_position text, p_effective_from timestamptz, p_options jsonb default '{}')
returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, market, kernel, pg_temp as $$
declare
  v market.policy_version;
begin
  -- DI-18, then DI-17 installation-wide.
  perform iam.assert_not_administrator();
  perform iam.require_permission('MARKET.POLICY_CHANGE', '{}'::jsonb);
  if not exists (select 1 from market.policy where code = p_policy) then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-071 unknown policy %s', p_policy);
  end if;
  if market.nz(p_options -> 'approvalId', null) is not null and market.try_uuid(p_options ->> 'approvalId') is null then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-073 policy %s: the approval is the id of an e-signature', p_policy);
  end if;
  -- version, direction, author, approver and recorded_at are set by market.policy_version_guard.
  insert into market.policy_version (policy_code, position, effective_from, approval_id, change_ref, reason)
  values (p_policy, p_position, p_effective_from, market.try_uuid(p_options ->> 'approvalId'), p_options ->> 'changeRef',
          coalesce(nullif(trim(p_options ->> 'reason'), ''), 'policy change'))
  returning * into v;
  return to_jsonb(v);
end
$$;

-- The version of a policy in force at a batch's issue instant (build outline 3.5).
create function market.policy_for_batch(p_policy text, p_issue_instant timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, market, pg_temp as $$
declare
  v market.policy_version;
begin
  if p_issue_instant is null then
    raise exception using errcode = 'P0001', message = 'EBMR-MKT-081 the batch issue instant is required';
  end if;
  v := market.policy_version_at(p_policy, p_issue_instant);
  if v.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-086 policy %s had no version in force at %s', p_policy, p_issue_instant);
  end if;
  return to_jsonb(v);
end
$$;

-- Pin every defined policy for a batch at issue. Call it inside the batch-issue transaction: the
-- issue instant is the database clock now (INV-16), never a value the caller supplies.
create function market.pin_policies_for_batch(p_batch uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, market, kernel, pg_temp as $$
declare
  v_now  timestamptz := clock_timestamp();
  p      market.policy;
  v      market.policy_version;
  v_out  jsonb := '[]'::jsonb;
begin
  -- Part of issuing the batch: DI-18, then DI-17 for BATCH.ISSUE where the issuer works.
  perform iam.assert_not_administrator();
  perform iam.require_permission('BATCH.ISSUE', iam.actor_location_scope());
  if exists (select 1 from market.batch_policy_pin where batch_id = p_batch and pin_kind = 'ISSUE') then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-087 batch %s is already pinned; policies are pinned once, at issue', p_batch);
  end if;
  for p in select * from market.policy order by code collate "C" loop
    v := market.policy_version_at(p.code, v_now);
    if v.id is null then
      continue;
    end if;
    insert into market.batch_policy_pin (batch_id, policy_code, policy_version_id, pin_kind, issue_instant)
    values (p_batch, p.code, v.id, 'ISSUE', v_now);
    v_out := v_out || jsonb_build_array(jsonb_build_object('policy', p.code, 'versionId', v.id, 'version', v.version, 'position', v.position));
  end loop;
  return jsonb_build_object('batchId', p_batch, 'issueInstant', v_now, 'pins', v_out);
end
$$;

-- Apply a newer policy version to an issued batch. Only a tightening in force is accepted.
create function market.apply_policy_tightening(p_batch uuid, p_policy text, p_version uuid, p_change_ref text, p_reason text default null)
returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, market, kernel, pg_temp as $$
declare
  pin market.batch_policy_pin;
begin
  -- DI-18, then DI-17 installation-wide.
  perform iam.assert_not_administrator();
  perform iam.require_permission('MARKET.POLICY_TIGHTEN_BATCH', '{}'::jsonb);
  -- issue_instant is copied from the batch's issue pin by market.policy_pin_guard.
  insert into market.batch_policy_pin (batch_id, policy_code, policy_version_id, pin_kind, change_ref, reason)
  values (p_batch, p_policy, p_version, 'TIGHTENING', p_change_ref, p_reason)
  returning * into pin;
  return to_jsonb(pin);
end
$$;

-- What a batch applies now for a policy: its strictest pin (the issue pin or a later tightening;
-- pins only ever tighten, so this is also the newest).
create function market.batch_policy(p_batch uuid, p_policy text) returns jsonb
language sql stable security definer set search_path = pg_catalog, market, pg_temp as $$
  select jsonb_build_object('pinId', p.id, 'pinKind', p.pin_kind, 'issueInstant', p.issue_instant, 'versionId', v.id,
                            'version', v.version, 'position', v.position, 'direction', v.direction)
  from market.batch_policy_pin p join market.policy_version v on v.id = p.policy_version_id
  where p.batch_id = p_batch and p.policy_code = p_policy
  order by market.position_rank(p_policy, v.position) desc, p.recorded_at desc, p.id desc
  limit 1
$$;

select kernel.register_audited_table('market.policy', 'market_policy', 'code', true);
select kernel.register_audited_table('market.policy_version', 'market_policy', 'policy_code', true);
select kernel.register_audited_table('market.batch_policy_pin', 'market_batch_policy', 'batch_id', true);

grant select on market.policy, market.policy_version, market.batch_policy_pin to ebmr_app;
grant execute on function market.define_policy(jsonb), market.set_policy_version(text, text, timestamptz, jsonb),
                          market.policy_for_batch(text, timestamptz), market.pin_policies_for_batch(uuid),
                          market.apply_policy_tightening(uuid, text, uuid, text, text), market.batch_policy(uuid, text),
                          market.policy_version_target(text, text) to ebmr_app;

reset role;
