-- Phase 6 slice 6f: the contract giver's reviewer reads the batches made under its loan licence, read-only, scoped and
-- logged (IN-30, clause "a contract-giver reviewer cannot edit"; kernel 1204).
--
-- Handbook: modules/recipe-core.md
--
--   recipe.contract_giver_access             insert-only: QA (CONTRACT_GIVER_ACCESS.GRANT) gives one reviewer account a
--                                            time-boxed read of the batches issued under ONE loan licence (the batch's
--                                            recipe.batch_licence_basis.loan_licence_id, recipe-core 0891), at most
--                                            recipe.contract_giver_access_max_days (default 90, 1 to 365).
--   recipe.contract_giver_access_revocation  insert-only: the access ended early.
--   recipe.contract_giver_read               insert-only: every batch record the reviewer opened, when and through which
--                                            access.
-- Rules (with the application's own credentials): the reviewer's account is an active, personal HUMAN account of another
-- person holding CONTRACT_GIVER.READ and READ permissions only (records.qp_account_read_only, kernel 1160); every read
-- checks that again (EBMR-CGA-003) and sees only the batches of a live access (EBMR-CGA-004). The reviewer has no path
-- to write: every GMP write asks iam.require_permission for a permission such an account never holds.
-- Messages: EBMR-CGA-001 to EBMR-CGA-009.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1060_contract_giver_access)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the contract giver reviewer access (IN-30)'));

insert into platform.setting_definition (key, value_type, default_value, min_value, max_value, allowed_values, max_scale, unit, description, basis)
values ('recipe.contract_giver_access_max_days', 'INTEGER', '90', 1, 365, null, null, 'd',
        'The longest window of a contract giver''s read access to the batches of its loan licence',
        'IN-30: read-only, scoped access of the contract giver''s reviewer (D-P6f-B-3)');

select kernel.set_actor_context(null);

create table recipe.contract_giver_access (
  id                  uuid primary key default gen_random_uuid(),
  loan_licence_id     uuid not null references site.manufacturing_licence (id),
  account_id          uuid not null references iam.account (id),
  person_id           uuid not null,
  valid_from          timestamptz not null,
  valid_to            timestamptz not null,
  reason              text not null check (btrim(reason) <> ''),
  granted_by_person   uuid not null,
  granted_by_account  uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null,
  check (valid_from < valid_to),
  check (granted_by_person <> person_id)
);
revoke all on recipe.contract_giver_access from public;
create index contract_giver_access_account on recipe.contract_giver_access (account_id, valid_to desc);

create table recipe.contract_giver_access_revocation (
  access_id           uuid primary key references recipe.contract_giver_access (id),
  reason              text not null check (btrim(reason) <> ''),
  revoked_by_person   uuid not null,
  revoked_by_account  uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null
);
revoke all on recipe.contract_giver_access_revocation from public;

create table recipe.contract_giver_read (
  id              bigint generated always as identity primary key,
  access_id       uuid not null references recipe.contract_giver_access (id),
  batch_id        uuid not null references recipe.batch_execution (id),
  person_id       uuid not null,
  account_id      uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  correlation_id  uuid not null
);
revoke all on recipe.contract_giver_read from public;
create index contract_giver_read_access on recipe.contract_giver_read (access_id);

select platform.enforce_db_time('recipe.contract_giver_access', array['recorded_at']);
select platform.enforce_db_time('recipe.contract_giver_access_revocation', array['recorded_at']);
select platform.enforce_db_time('recipe.contract_giver_read', array['recorded_at']);
select kernel.register_audited_table('recipe.contract_giver_access', 'contract_giver_access', 'id', true);
select kernel.register_audited_table('recipe.contract_giver_access_revocation', 'contract_giver_access', 'access_id', true);
select kernel.register_audited_table('recipe.contract_giver_read', 'contract_giver_access', 'access_id', true);
select iam.protect_rows('recipe.contract_giver_access');
select iam.protect_rows('recipe.contract_giver_access_revocation');
select iam.protect_rows('recipe.contract_giver_read');

create function recipe.contract_giver_access_live(p_access uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select exists (select 1 from recipe.contract_giver_access a
                  where a.id = p_access and a.valid_from <= clock_timestamp() and clock_timestamp() < a.valid_to
                    and not exists (select 1 from recipe.contract_giver_access_revocation r where r.access_id = a.id))
$$;

-- QA grants a reviewer account a time-boxed read of one loan licence's batches. Returns the access id.
create function recipe.grant_contract_giver_access(p_loan_licence uuid, p_account uuid, p_valid_to timestamptz, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, platform, pg_temp as $$
declare
  v_actor jsonb;
  a       iam.account;
  l       site.manufacturing_licence;
  v_now   timestamptz := clock_timestamp();
  v_max   numeric := platform.setting_numeric('recipe.contract_giver_access_max_days');
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('CONTRACT_GIVER_ACCESS.GRANT', '{}'::jsonb);
  select * into l from site.manufacturing_licence where id = p_loan_licence;
  if l.id is null or l.licence_kind <> 'LOAN' then
    raise exception using errcode = 'P0001', message = 'EBMR-CGA-001 a contract-giver access names a loan licence (the contract giver''s batches are those issued under it)';
  end if;
  if kernel.is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-CGA-001 a contract-giver access states its reason (the technical agreement)';
  end if;
  select * into a from iam.account where id = p_account;
  if a.id is null or a.kind <> 'HUMAN' or a.status <> 'ACTIVE' or a.is_generic or a.is_break_glass then
    raise exception using errcode = 'P0001', message = 'EBMR-CGA-002 a contract-giver access is for an active, personal (HUMAN) account (DI-14)';
  end if;
  if a.person_id = (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-CGA-002 nobody grants a contract-giver access to their own account';
  end if;
  if not ('CONTRACT_GIVER.READ' = any (records.qp_account_permissions(a.id))) or not records.qp_account_read_only(a.id) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-CGA-003 the reviewer account holds the CONTRACT_GIVER_REVIEWER role and read permissions only: it never writes or signs here';
  end if;
  if p_valid_to is null or p_valid_to <= v_now or p_valid_to > v_now + make_interval(days => v_max::integer) then
    raise exception using errcode = 'P0001', message = format('EBMR-CGA-005 a contract-giver access ends after now and at most %s days later', v_max);
  end if;
  insert into recipe.contract_giver_access (loan_licence_id, account_id, person_id, valid_from, valid_to, reason, granted_by_person, granted_by_account, correlation_id)
  values (l.id, a.id, a.person_id, v_now, p_valid_to, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid,
          (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function recipe.revoke_contract_giver_access(p_access uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor jsonb;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('CONTRACT_GIVER_ACCESS.GRANT', '{}'::jsonb);
  if not exists (select 1 from recipe.contract_giver_access a where a.id = p_access) then
    raise exception using errcode = 'P0001', message = format('EBMR-CGA-006 %s is no contract-giver access', coalesce(p_access::text, 'NULL'));
  end if;
  if kernel.is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-CGA-006 a revocation states its reason';
  end if;
  insert into recipe.contract_giver_access_revocation (access_id, reason, revoked_by_person, revoked_by_account, correlation_id)
  values (p_access, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  on conflict (access_id) do nothing;
end
$$;

-- Every access, for QA's screen.
create function recipe.contract_giver_accesses() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('CONTRACT_GIVER_ACCESS.GRANT', '{}'::jsonb);
  return coalesce((
    select jsonb_agg(jsonb_build_object('accessId', a.id, 'loanLicenceId', a.loan_licence_id, 'loanLicenceNumber', l.licence_number,
                                        'holderName', l.holder_name, 'accountId', a.account_id, 'personId', a.person_id,
                                        'loginName', (select login_name from iam.account where id = a.account_id),
                                        'validFrom', a.valid_from, 'validTo', a.valid_to, 'reason', a.reason, 'grantedBy', a.granted_by_person,
                                        'live', recipe.contract_giver_access_live(a.id),
                                        'reads', (select count(*) from recipe.contract_giver_read r where r.access_id = a.id))
                     order by a.recorded_at desc, a.id)
      from recipe.contract_giver_access a join site.manufacturing_licence l on l.id = a.loan_licence_id), '[]'::jsonb);
end
$$;

-- The batches the acting reviewer may read now: [{batchId, batchNumber, product, status, reviewState, loanLicenceNumber,
-- hostLicenceNumber, issuedAt, accessId, accessValidTo}], latest first.
create function recipe.contract_giver_batches() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor jsonb;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('CONTRACT_GIVER.READ', '{}'::jsonb);
  if not records.qp_account_read_only((v_actor ->> 'account_id')::uuid) then
    raise exception using errcode = 'P0001', message = 'EBMR-CGA-003 a contract giver''s reviewer reads only while the account holds read permissions only';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('batchId', b.id, 'batchNumber', b.batch_number, 'product', recipe.batch_product(b.id),
                                        'status', s.status, 'reviewState', recipe.batch_review_state(b.id),
                                        'loanLicenceNumber', lb.loan_licence_number, 'hostLicenceNumber', lb.licence_number,
                                        'issuedAt', b.issued_at, 'accessId', a.id, 'accessValidTo', a.valid_to)
                     order by b.issued_at desc, b.id)
      from recipe.contract_giver_access a
      join recipe.batch_licence_basis lb on lb.loan_licence_id = a.loan_licence_id
      join recipe.batch_execution b on b.id = lb.batch_id
      left join recipe.execution_state s on s.batch_id = b.id
     where a.account_id = (v_actor ->> 'account_id')::uuid and recipe.contract_giver_access_live(a.id)), '[]'::jsonb);
end
$$;

-- One batch record for the acting reviewer, logged: the header, the stage summaries and the steps as executed.
create function recipe.read_contract_giver_batch(p_batch uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor  jsonb;
  v_access uuid;
  b        recipe.batch_execution;
  lb       recipe.batch_licence_basis;
  st       recipe.execution_state;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('CONTRACT_GIVER.READ', '{}'::jsonb);
  if not records.qp_account_read_only((v_actor ->> 'account_id')::uuid) then
    raise exception using errcode = 'P0001', message = 'EBMR-CGA-003 a contract giver''s reviewer reads only while the account holds read permissions only';
  end if;
  select a.id into v_access
    from recipe.contract_giver_access a join recipe.batch_licence_basis l on l.loan_licence_id = a.loan_licence_id
   where l.batch_id = p_batch and a.account_id = (v_actor ->> 'account_id')::uuid and recipe.contract_giver_access_live(a.id)
   order by a.valid_to desc limit 1;
  if v_access is null then
    raise exception using errcode = 'P0001',
      message = 'EBMR-CGA-004 no batch with this id is open to this account (a live access names the loan licence it was made under)';
  end if;
  select * into b from recipe.batch_execution where id = p_batch;
  select * into lb from recipe.batch_licence_basis where batch_id = p_batch;
  select * into st from recipe.execution_state where batch_id = p_batch;
  insert into recipe.contract_giver_read (access_id, batch_id, person_id, account_id, correlation_id)
  values (v_access, p_batch, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return jsonb_build_object('batchId', b.id, 'batchNumber', b.batch_number, 'product', recipe.batch_product(b.id), 'status', st.status,
                            'reviewState', recipe.batch_review_state(b.id), 'issuedAt', b.issued_at, 'batchSize', b.batch_size,
                            'loanLicenceNumber', lb.loan_licence_number, 'hostLicenceNumber', lb.licence_number,
                            'technicalAgreement', lb.basis ->> 'technicalAgreement', 'loanHolderName', lb.basis ->> 'loanHolderName',
                            'stages', coalesce(st.state -> 'stages', '{}'::jsonb), 'steps', coalesce(st.state -> 'steps', '{}'::jsonb),
                            'points', coalesce(st.state -> 'points', '{}'::jsonb),
                            'stateHash', st.state_hash);
end
$$;

select continuity.register_protected_sequence('recipe.contract_giver_read.id',
  pg_get_serial_sequence('recipe.contract_giver_read', 'id')::regclass,
  'OTHER', 'recipe-core', 'Ids of recipe.contract_giver_read (the contract giver''s logged reads, INV-27)', 100000);

revoke all on function recipe.contract_giver_access_live(uuid), recipe.grant_contract_giver_access(uuid, uuid, timestamptz, text),
  recipe.revoke_contract_giver_access(uuid, text), recipe.contract_giver_accesses(),
  recipe.contract_giver_batches(), recipe.read_contract_giver_batch(uuid) from public;
grant select on recipe.contract_giver_access, recipe.contract_giver_access_revocation, recipe.contract_giver_read to ebmr_app;
grant execute on function recipe.contract_giver_access_live(uuid), recipe.grant_contract_giver_access(uuid, uuid, timestamptz, text),
  recipe.revoke_contract_giver_access(uuid, text), recipe.contract_giver_accesses(), recipe.contract_giver_batches(),
  recipe.read_contract_giver_batch(uuid) to ebmr_app;

reset role;
