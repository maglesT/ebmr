-- Records (kernel): slice 4 quick review fixes of the EU QP batch package and the QP access (Phase 4 slice 4b; kernel
-- 1160; DI-41, DI-14; docs/build-plan/phase-4/review-backlog.md). Functions re-created from their latest definitions
-- (1160):
--
--   4b-1  A QP account holds EU_QP_READER as its only live role: records.grant_qp_access refuses an account with any
--         other live role (EBMR-REC-087), the reader functions refuse such an account, and a trigger on iam.role_grant
--         refuses a request or approval of any other role for an account while it has a live QP access (EBMR-REC-092),
--         under the account's QP lock (the one grant_qp_access takes).
--   4b-2  records.register_qp_package ties every true-copy section to the subject: the subject's module, registered as
--         its QP subject provider (records.register_qp_subject_provider, owner only; site services 0871 for material
--         lots), names the chains a section may copy (EBMR-REC-093); without a provider nothing registers (fails closed).
--   4b-3  Only the latest issued package of a subject is served (records.qp_latest_issued); none while the provider
--         says the subject is closed (a release suspended or rejected, the EU market removed or not in the set:
--         EBMR-REC-091), for the grant, the list and the read.
-- Provider contract: fn(subject_id text) returns jsonb {exists boolean, chains text[] (as a JSON array), open boolean,
-- problem text|null}.
-- Messages: EBMR-REC-087, 090 to 093.

set local role ebmr_owner;

-- Insert-only and audited like every records table; the latest registration of a subject type counts.
create table records.qp_subject_provider (
  id            uuid primary key default gen_random_uuid(),
  subject_type  text not null check (subject_type ~ '^[a-z][a-z0-9_]{0,62}$'),
  function_oid  regprocedure not null,
  registered_at timestamptz not null default clock_timestamp()
);
create index qp_subject_provider_type on records.qp_subject_provider (subject_type, registered_at desc);
revoke all on records.qp_subject_provider from public;
grant select on records.qp_subject_provider to ebmr_app;
select platform.enforce_db_time('records.qp_subject_provider', array['registered_at']);
select kernel.register_audited_table('records.qp_subject_provider', 'qp_subject_provider', 'subject_type', true);

-- Owner only: the module that owns the subject type registers its provider in its migration (under an actor context:
-- the table is audited).
create function records.register_qp_subject_provider(p_subject_type text, p_function regprocedure) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, pg_temp as $$
begin
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = p_function and pg_catalog.oidvectortypes(p.proargtypes) = 'text' and p.prorettype = 'jsonb'::regtype) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-093 %s must have the provider signature (subject_id text) returns jsonb', p_function);
  end if;
  insert into records.qp_subject_provider (subject_type, function_oid) values (p_subject_type, p_function);
end
$$;

-- The provider's answer for a subject, or NULL when no provider is registered.
create function records.qp_subject(p_subject_type text, p_subject_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, records, pg_temp as $$
declare
  v_fn  regprocedure;
  v_out jsonb;
begin
  select function_oid into v_fn from records.qp_subject_provider where subject_type = p_subject_type order by registered_at desc, id desc limit 1;
  if v_fn is null then
    return null;
  end if;
  execute format('select %s($1)', (select quote_ident(n.nspname) || '.' || quote_ident(p.proname)
                                   from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where p.oid = v_fn))
    into v_out using p_subject_id;
  return v_out;
end
$$;

-- Why the subject's packages are not served now (fails closed without a provider), or NULL.
create function records.qp_subject_problem(p_subject_type text, p_subject_id text) returns text
language plpgsql stable security definer set search_path = pg_catalog, records, pg_temp as $$
declare
  v jsonb := records.qp_subject(p_subject_type, p_subject_id);
begin
  if v is null or not coalesce((v ->> 'exists')::boolean, false) then
    return format('%s %s is no subject a QP batch package is made of', p_subject_type, p_subject_id);
  end if;
  if not coalesce((v ->> 'open')::boolean, false) then
    return coalesce(v ->> 'problem', 'the subject is closed') || ': its QP batch package is not served';
  end if;
  return null;
end
$$;

-- The live roles of the account other than EU_QP_READER, in any scope.
create function records.qp_account_other_roles(p_account uuid) returns text[]
language sql stable security definer set search_path = pg_catalog, records, iam, pg_temp as $$
  select coalesce(array_agg(distinct g.role_code order by g.role_code), '{}') from iam.role_grant g
   where g.account_id = p_account and g.role_code <> 'EU_QP_READER'
     and (g.status = 'REQUESTED' or iam.grant_is_live(g.status, g.valid_to, g.revoked_at))
$$;

-- The latest issued package of a subject (by issue time), or NULL.
create function records.qp_latest_issued(p_subject_type text, p_subject_id text) returns uuid
language sql stable security definer set search_path = pg_catalog, records, pg_temp as $$
  select p.id from records.qp_package p join records.qp_package_issue i on i.package_id = p.id
   where p.subject_type = p_subject_type and p.subject_id = p_subject_id order by i.recorded_at desc, p.id desc limit 1
$$;

-- iam.role_grant: no other role is requested or approved for an account while it has a live QP access (4b-1).
create function records.qp_access_role_guard() returns trigger
language plpgsql volatile security definer set search_path = pg_catalog, records, pg_temp as $$
begin
  if new.role_code = 'EU_QP_READER' or new.status not in ('REQUESTED', 'APPROVED')
     or (tg_op = 'UPDATE' and old.status = new.status) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('records.qp_access:' || new.account_id::text, 0));
  if exists (select 1 from records.qp_access a where a.account_id = new.account_id and records.qp_access_live(a.id)) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-092 the account has a live QP access: it holds EU_QP_READER only until the access ends or is revoked; role %s is refused (review 4b-1, DI-14)', new.role_code);
  end if;
  return new;
end
$$;
create trigger zz_qp_access_role_guard before insert or update on iam.role_grant for each row execute function records.qp_access_role_guard();

create or replace function records.register_qp_package(p_subject_type text, p_subject_id text, p_manifest text, p_package_sha256 text, p_content text)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, iam, pg_temp as $$
declare
  v_actor    jsonb;
  m          jsonb;
  c          jsonb;
  s          jsonb;
  v_text     text;
  v_bundle   jsonb;
  v_names    text[] := '{}';
  v_roles    text[] := '{}';
  v_copies   uuid[] := '{}';
  v_copy     uuid;
  v_id       uuid;
  r          text;
  v_subject  jsonb;
  v_chains   text[];
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECORD.TRUE_COPY_REGISTER', '{}'::jsonb);
  if p_manifest is null or p_content is null or p_subject_type is null or p_subject_id is null then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-080 a QP batch package names its subject, manifest and content';
  end if;
  if p_package_sha256 is distinct from encode(sha256(convert_to(p_manifest, 'UTF8')), 'hex') then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-080 the package SHA-256 the server computed does not match the manifest (DI-41)';
  end if;
  begin
    m := p_manifest::jsonb;
    c := p_content::jsonb;
  exception when others then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-080 the manifest or the package is not JSON';
  end;
  if jsonb_typeof(m) <> 'object' or m ->> 'format' is distinct from 'ebmr.qp-batch-package/1' or m ->> 'kind' is distinct from 'EU_QP_BATCH_PACKAGE'
     or jsonb_typeof(m -> 'subject') is distinct from 'object' or m -> 'subject' ->> 'type' is distinct from p_subject_type
     or m -> 'subject' ->> 'id' is distinct from p_subject_id or records.is_blank(m -> 'subject' ->> 'label')
     or jsonb_typeof(m -> 'sections') is distinct from 'array' or jsonb_array_length(m -> 'sections') < 1 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-REC-080 the manifest is no EU QP batch package manifest (format ebmr.qp-batch-package/1) of the subject given';
  end if;
  -- The subject's module names the records of the subject a section may copy (review 4b-2).
  v_subject := records.qp_subject(p_subject_type, p_subject_id);
  if v_subject is null or not coalesce((v_subject ->> 'exists')::boolean, false) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-093 %s %s is no subject a QP batch package is made of (no module answers for it)', p_subject_type, p_subject_id);
  end if;
  v_chains := array(select jsonb_array_elements_text(coalesce(v_subject -> 'chains', '[]'::jsonb)));
  if jsonb_typeof(c) <> 'object' or c ->> 'format' is distinct from 'ebmr.qp-batch-package/1' or c ->> 'manifest' is distinct from p_manifest
     or c ->> 'packageSha256' is distinct from p_package_sha256
     or jsonb_typeof(c -> 'bundles') is distinct from 'object' or jsonb_typeof(c -> 'documents') is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-081 the package does not carry exactly this manifest and its SHA-256';
  end if;

  for s in select value from jsonb_array_elements(m -> 'sections') loop
    if jsonb_typeof(s) <> 'object' or coalesce(s ->> 'name', '') !~ '^[a-z0-9][a-z0-9._-]{0,99}$' or s ->> 'name' = any (v_names)
       or coalesce(s ->> 'role', '') not in ('PROCESSING_RECORD', 'PACKAGING_RECORD', 'AUDIT_TRAIL_REVIEW', 'POST_ENTRY_CHANGES', 'DEVIATIONS', 'RELEASE', 'COA', 'OTHER')
       or coalesce(s ->> 'kind', '') not in ('TRUE_COPY', 'DOCUMENT') or coalesce(s ->> 'sha256', '') !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-REC-081 section %s needs a unique name, a role, a kind (TRUE_COPY or DOCUMENT) and its SHA-256', coalesce(s ->> 'name', '?'));
    end if;
    v_names := v_names || (s ->> 'name');
    v_roles := v_roles || (s ->> 'role');
    v_text := case s ->> 'kind' when 'TRUE_COPY' then c -> 'bundles' ->> (s ->> 'name') else c -> 'documents' ->> (s ->> 'name') end;
    if v_text is null or encode(sha256(convert_to(v_text, 'UTF8')), 'hex') is distinct from s ->> 'sha256' then
      raise exception using errcode = 'P0001', message = format('EBMR-REC-081 section %s is missing or does not match its SHA-256 in the manifest', s ->> 'name');
    end if;
    if s ->> 'kind' = 'TRUE_COPY' and not (coalesce(s ->> 'chainKey', '') = any (v_chains)) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-REC-093 section %s copies %s, which is no record of %s (its release batches, their reviews, its release and its deviations)',
                         s ->> 'name', coalesce(s ->> 'chainKey', '?'), m -> 'subject' ->> 'label');
    end if;
    if s ->> 'kind' = 'TRUE_COPY' then
      begin
        v_bundle := v_text::jsonb;
      exception when others then
        v_bundle := null;
      end;
      if v_bundle is null or jsonb_typeof(v_bundle) <> 'object' or v_bundle ->> 'manifestSha256' is distinct from s ->> 'manifestSha256'
         or encode(sha256(convert_to(coalesce(v_bundle ->> 'manifest', ''), 'UTF8')), 'hex') is distinct from s ->> 'manifestSha256'
         or (v_bundle ->> 'manifest')::jsonb ->> 'chainKey' is distinct from s ->> 'chainKey' then
        raise exception using errcode = 'P0001', message = format('EBMR-REC-082 section %s is no true-copy bundle of chain %s with the manifest SHA-256 given', s ->> 'name', coalesce(s ->> 'chainKey', '?'));
      end if;
      select t.id into v_copy from records.true_copy t
       where t.record_key = s ->> 'chainKey' and t.manifest_sha256 = s ->> 'manifestSha256' order by t.recorded_at limit 1;
      if v_copy is null then
        raise exception using errcode = 'P0001',
          message = format('EBMR-REC-082 the true copy of section %s (chain %s) is not in the true-copy register; register it first (DI-41)', s ->> 'name', s ->> 'chainKey');
      end if;
      v_copies := v_copies || v_copy;
      v_copy := null;
    end if;
  end loop;
  if exists (select 1 from jsonb_object_keys(c -> 'bundles') k where k <> all (array(select x ->> 'name' from jsonb_array_elements(m -> 'sections') x where x ->> 'kind' = 'TRUE_COPY')))
     or exists (select 1 from jsonb_object_keys(c -> 'documents') k where k <> all (array(select x ->> 'name' from jsonb_array_elements(m -> 'sections') x where x ->> 'kind' = 'DOCUMENT'))) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-081 the package carries a part its manifest does not list';
  end if;
  foreach r in array array['PROCESSING_RECORD', 'PACKAGING_RECORD', 'AUDIT_TRAIL_REVIEW', 'POST_ENTRY_CHANGES', 'DEVIATIONS', 'RELEASE', 'COA'] loop
    if not (r = any (v_roles)) then
      raise exception using errcode = 'P0001', message = format('EBMR-REC-083 the EU QP batch package has no %s section (outline 5.2.6)', r);
    end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(m -> 'sections') x where x ->> 'role' in ('PROCESSING_RECORD', 'PACKAGING_RECORD') and x ->> 'kind' <> 'TRUE_COPY') then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-083 the processing and packaging records are in the package as true-copy bundles (DI-41)';
  end if;

  insert into records.qp_package (kind, subject_type, subject_id, subject_label, manifest, package_sha256, content, content_sha256, content_bytes,
                                  sections, true_copy_ids, assembled_by_person, assembled_by_account, correlation_id)
  values ('EU_QP_BATCH_PACKAGE', p_subject_type, p_subject_id, m -> 'subject' ->> 'label', p_manifest, p_package_sha256, p_content,
          encode(sha256(convert_to(p_content, 'UTF8')), 'hex'), octet_length(convert_to(p_content, 'UTF8')), m -> 'sections', v_copies,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create or replace function records.grant_qp_access(p_package uuid, p_account uuid, p_valid_to timestamptz, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, iam, platform, pg_temp as $$
declare
  v_actor  jsonb;
  p        records.qp_package;
  a        iam.account;
  v_now    timestamptz := clock_timestamp();
  v_max    numeric := platform.setting_numeric('records.qp_access_max_days');
  v_id     uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('QP_ACCESS.GRANT', '{}'::jsonb);
  select * into p from records.qp_package where id = p_package;
  if p.id is null or records.qp_package_state(p.id) is distinct from 'ISSUED' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-086 a QP access is granted to an issued QP batch package only';
  end if;
  if records.qp_subject_problem(p.subject_type, p.subject_id) is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-091 %s', records.qp_subject_problem(p.subject_type, p.subject_id));
  end if;
  if records.is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-086 a QP access states its reason (the technical agreement, the lot)';
  end if;
  -- One grant at a time per account: the one-subject rule reads every live access after the lock.
  perform pg_advisory_xact_lock(hashtextextended('records.qp_access:' || coalesce(p_account::text, ''), 0));
  select * into a from iam.account where id = p_account;
  if a.id is null or a.kind <> 'HUMAN' or a.status <> 'ACTIVE' or a.is_generic or a.is_break_glass then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-087 a QP access is for an active, personal (HUMAN) account (DI-14)';
  end if;
  if a.person_id = (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-087 nobody grants a QP access to their own account';
  end if;
  if not ('QP_PACKAGE.READ' = any (records.qp_account_permissions(a.id))) or not records.qp_account_read_only(a.id) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-REC-087 a QP account holds the EU_QP_READER role and read permissions only: it never writes or signs here (read-only)';
  end if;
  if cardinality(records.qp_account_other_roles(a.id)) > 0 then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-087 a QP account holds EU_QP_READER as its only role; this account also holds %s (review 4b-1)',
                       array_to_string(records.qp_account_other_roles(a.id), ', '));
  end if;
  if p_valid_to is null or p_valid_to <= v_now or p_valid_to > v_now + make_interval(days => v_max::integer) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-088 a QP access ends after now and at most %s days later (time-boxed)', v_max);
  end if;
  if exists (select 1 from records.qp_access x where x.account_id = a.id and records.qp_access_live(x.id)
              and (x.subject_type, x.subject_id) is distinct from (p.subject_type, p.subject_id)) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-REC-089 the account already has a live QP access to another lot: a QP access is scoped to one lot; revoke or let it end first';
  end if;
  insert into records.qp_access (subject_type, subject_id, account_id, person_id, valid_from, valid_to, reason, granted_by_person, granted_by_account, correlation_id)
  values (p.subject_type, p.subject_id, a.id, a.person_id, v_now, p_valid_to, btrim(p_reason), (v_actor ->> 'person_id')::uuid,
          (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create or replace function records.qp_reader_access(p_subject_type text, p_subject_id text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, iam, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('QP_PACKAGE.READ', '{}'::jsonb);
begin
  if not records.qp_account_read_only((v_actor ->> 'account_id')::uuid) or cardinality(records.qp_account_other_roles((v_actor ->> 'account_id')::uuid)) > 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-090 a QP account reads the package only while it holds read permissions only (read-only)';
  end if;
  if records.qp_subject_problem(p_subject_type, p_subject_id) is not null then
    return null;
  end if;
  return (select a.id from records.qp_access a
           where a.account_id = (v_actor ->> 'account_id')::uuid and a.subject_type = p_subject_type and a.subject_id = p_subject_id
             and records.qp_access_live(a.id)
           order by a.valid_to desc limit 1);
end
$$;

create or replace function records.qp_reader_packages() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, iam, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('QP_PACKAGE.READ', '{}'::jsonb);
begin
  if not records.qp_account_read_only((v_actor ->> 'account_id')::uuid) or cardinality(records.qp_account_other_roles((v_actor ->> 'account_id')::uuid)) > 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-090 a QP account reads the package only while it holds read permissions only (read-only)';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('packageId', p.id, 'subjectType', p.subject_type, 'subjectId', p.subject_id, 'subjectLabel', p.subject_label,
                                        'packageSha256', p.package_sha256, 'contentBytes', p.content_bytes, 'issuedAt', i.recorded_at,
                                        'accessId', a.id, 'accessValidTo', a.valid_to) order by i.recorded_at desc, p.id)
      from records.qp_access a
      join records.qp_package p on p.id = records.qp_latest_issued(a.subject_type, a.subject_id)
      join records.qp_package_issue i on i.package_id = p.id
     where a.account_id = (v_actor ->> 'account_id')::uuid and records.qp_access_live(a.id)
       and records.qp_subject_problem(a.subject_type, a.subject_id) is null), '[]'::jsonb);
end
$$;

create or replace function records.read_qp_package(p_package uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, iam, pg_temp as $$
declare
  v_actor  jsonb := iam.require_permission('QP_PACKAGE.READ', '{}'::jsonb);
  p        records.qp_package;
  v_access uuid;
begin
  select * into p from records.qp_package where id = p_package;
  if p.id is null or records.qp_package_state(p.id) is distinct from 'ISSUED' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-090 no issued QP batch package with this id is open to this account';
  end if;
  if p.id is distinct from records.qp_latest_issued(p.subject_type, p.subject_id) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-REC-090 this package was replaced by a later issued package of the lot; only the latest is served (review 4b-3)';
  end if;
  if records.qp_subject_problem(p.subject_type, p.subject_id) is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-091 %s', records.qp_subject_problem(p.subject_type, p.subject_id));
  end if;
  v_access := records.qp_reader_access(p.subject_type, p.subject_id);
  if v_access is null then
    raise exception using errcode = 'P0001',
      message = 'EBMR-REC-090 no issued QP batch package with this id is open to this account (the access names one lot, inside its window, not revoked)';
  end if;
  insert into records.qp_access_read (access_id, package_id, person_id, account_id, correlation_id)
  values (v_access, p.id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return jsonb_build_object('packageId', p.id, 'packageSha256', p.package_sha256, 'contentSha256', p.content_sha256, 'content', p.content);
end
$$;

revoke all on function records.register_qp_subject_provider(text, regprocedure), records.qp_subject(text, text), records.qp_subject_problem(text, text),
  records.qp_account_other_roles(uuid), records.qp_latest_issued(text, text), records.qp_access_role_guard() from public;
grant execute on function records.qp_latest_issued(text, text) to ebmr_app;

reset role;
