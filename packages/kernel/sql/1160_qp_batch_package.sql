-- Records (kernel): the EU QP batch package and the read-only, time-boxed QP access to it (Phase 4 slice 4b; outline 4.6
-- "EU importer / QP", 5.2.6 EU disposition; DI-41 true copies, DI-14, DI-17, DI-35, DI-37; plan
-- docs/build-plan/phase-4/phase-4-plan.md slice 4b).
--
-- The package is assembled by the edition's server (packages/kernel/src/records/qp-package.ts): true-copy bundles of the
-- lot's chains (processing and packaging records at least) and documents (audit-trail review, post-entry change list,
-- deviations with their per-market assessments, the manufacturer release and its checklist, the CoA), with a package
-- manifest listing every section and its SHA-256. The server computes the package SHA-256 (of the manifest text); the
-- database computes it again and refuses a mismatch, so the stored hash is never the caller's word alone.
--
--   records.qp_package            insert-only: one assembled package (subject, manifest, package SHA-256, the package
--                                 text and its SHA-256, the true copies of its sections). Several per subject (a package
--                                 assembled again after a change); the reader sees every issued one, latest first.
--   records.qp_package_issue      insert-only: QA's TRUE_COPY_VERIFIED signature over the package (aggregate qp_package
--                                 <package id>, expected state ASSEMBLED): the package is ISSUED. One per package.
--   records.qp_access             insert-only: a time-boxed read access of one QP account to the issued packages of ONE
--                                 subject (valid_from = now, valid_to at most records.qp_access_max_days later).
--   records.qp_access_revocation  insert-only: the access ended early.
--   records.qp_access_read        insert-only: every package the QP read, when, through which access.
--
-- Database rules (ADR 0012: they hold with the application's own credentials):
--   * register: RECORD.TRUE_COPY_REGISTER; the manifest is a package manifest of kind EU_QP_BATCH_PACKAGE for the
--     subject given; its SHA-256 equals the server's; the package text carries exactly this manifest and exactly the
--     sections it lists, each with the SHA-256 the manifest gives; a TRUE_COPY section is a true-copy bundle registered in
--     records.true_copy for its chain with that manifest SHA-256; every required role is present (PROCESSING_RECORD and
--     PACKAGING_RECORD as true copies; AUDIT_TRAIL_REVIEW, POST_ENTRY_CHANGES, DEVIATIONS, RELEASE, COA) (EBMR-REC-080..083).
--   * issue: RECORD.QA_REVIEW; a valid TRUE_COPY_VERIFIED signature of this package by the actor, in state ASSEMBLED, of
--     the current content (EBMR-REC-084, 085).
--   * grant: QP_ACCESS.GRANT (QA); the package is issued; the account is a HUMAN account, active, of another person, holding
--     the EU_QP_READER role and READ permissions only (read-only); valid_to after now and at most the maximum later; the
--     account has no live access to another subject (scoped to one lot) (EBMR-REC-086..089).
--   * read: QP_PACKAGE.READ; the actor's account still holds READ permissions only; a live access (inside its window, not
--     revoked) to the package's subject; the package issued. Each read is logged (EBMR-REC-090).
--   * the application role reads the register tables and calls the definers; it never writes a table.
-- New permissions: QP_PACKAGE.READ (READ_ONLY, held by the new role EU_QP_READER, HUMAN accounts) and QP_ACCESS.GRANT (GMP
-- WRITE, QA_REVIEWER). New setting: records.qp_access_max_days (default 30, 1 to 90).
-- Signed aggregate: qp_package <package id>, meaning TRUE_COPY_VERIFIED (kernel 0210, RECORD.QA_REVIEW).
-- Messages: EBMR-REC-080 to EBMR-REC-099.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1160_qp_batch_package)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the EU QP batch package and the read-only, time-boxed QP access (DI-41, DI-14, DI-17)'));

insert into iam.permission (code, domain, effect, description) values
  ('QP_PACKAGE.READ', 'READ_ONLY', 'READ', 'Read the issued EU QP batch packages of the one lot a live, time-boxed QP access names'),
  ('QP_ACCESS.GRANT', 'GMP', 'WRITE', 'Grant or revoke a read-only, time-boxed QP access to the batch packages of one lot');

insert into iam.role (code, name, role_group, description, account_kinds, is_kernel) values
  ('EU_QP_READER', 'EU importer QP (read-only)', 'QUALITY_RELEASE',
   'The qualified person of the EU importer named in the technical agreement: reads the QP batch package of the lot a time-boxed access names; never writes or signs here',
   array['HUMAN'], true);
insert into iam.role_permission (role_code, permission_code) values
  ('EU_QP_READER', 'QP_PACKAGE.READ'),
  ('QA_REVIEWER', 'QP_ACCESS.GRANT');

insert into platform.setting_definition (key, value_type, default_value, min_value, max_value, allowed_values, max_scale, unit, description, basis)
values ('records.qp_access_max_days', 'INTEGER', '30', 1, 90, null, null, 'd',
        'The longest window of a QP access to the batch package of one lot',
        'Outline 5.2.6: a read-only, time-boxed QP account scoped to the lot (D-4b-2)');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table records.qp_package (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind = 'EU_QP_BATCH_PACKAGE'),
  subject_type       text not null check (subject_type ~ '^[a-z][a-z0-9_]{0,62}$'),
  subject_id         text not null check (btrim(subject_id) <> '' and length(subject_id) <= 128),
  subject_label      text not null check (btrim(subject_label) <> '' and length(subject_label) <= 200),
  manifest           text not null,
  package_sha256     text not null check (package_sha256 ~ '^[0-9a-f]{64}$'),
  content            text not null,
  content_sha256     text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  content_bytes      bigint not null check (content_bytes > 0),
  sections           jsonb not null check (jsonb_typeof(sections) = 'array'),
  true_copy_ids      uuid[] not null,
  assembled_by_person   uuid not null,
  assembled_by_account  uuid not null,
  correlation_id     uuid not null,
  recorded_at        timestamptz not null default clock_timestamp(),
  unique (package_sha256)
);
create index qp_package_subject on records.qp_package (subject_type, subject_id, recorded_at desc);

create table records.qp_package_issue (
  package_id      uuid primary key references records.qp_package (id),
  signature_id    uuid not null unique,
  person_id       uuid not null,
  account_id      uuid not null,
  correlation_id  uuid not null,
  recorded_at     timestamptz not null default clock_timestamp()
);

create table records.qp_access (
  id                  uuid primary key default gen_random_uuid(),
  subject_type        text not null,
  subject_id          text not null,
  account_id          uuid not null,
  person_id           uuid not null,
  valid_from          timestamptz not null,
  valid_to            timestamptz not null,
  reason              text not null check (btrim(reason) <> '' and length(reason) <= 500),
  granted_by_person   uuid not null,
  granted_by_account  uuid not null,
  correlation_id      uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  check (valid_to > valid_from),
  check (granted_by_person <> person_id)
);
create index qp_access_account on records.qp_access (account_id, valid_to desc);

create table records.qp_access_revocation (
  access_id           uuid primary key references records.qp_access (id),
  reason              text not null check (btrim(reason) <> '' and length(reason) <= 500),
  revoked_by_person   uuid not null,
  revoked_by_account  uuid not null,
  correlation_id      uuid not null,
  recorded_at         timestamptz not null default clock_timestamp()
);

create table records.qp_access_read (
  id              uuid primary key default gen_random_uuid(),
  access_id       uuid not null references records.qp_access (id),
  package_id      uuid not null references records.qp_package (id),
  person_id       uuid not null,
  account_id      uuid not null,
  correlation_id  uuid not null,
  recorded_at     timestamptz not null default clock_timestamp()
);
create index qp_access_read_access on records.qp_access_read (access_id);

do $$
declare
  t text;
begin
  foreach t in array array['qp_package', 'qp_package_issue', 'qp_access', 'qp_access_revocation', 'qp_access_read'] loop
    execute format('revoke all on records.%I from public', t);
    execute format('grant select on records.%I to ebmr_app', t);
  end loop;
end
$$;
select platform.enforce_db_time('records.qp_package', array['recorded_at']);
select platform.enforce_db_time('records.qp_package_issue', array['recorded_at']);
select platform.enforce_db_time('records.qp_access', array['recorded_at']);
select platform.enforce_db_time('records.qp_access_revocation', array['recorded_at']);
select platform.enforce_db_time('records.qp_access_read', array['recorded_at']);
select kernel.register_audited_table('records.qp_package', 'qp_package', 'id', true);
select kernel.register_audited_table('records.qp_package_issue', 'qp_package', 'package_id', true);
select kernel.register_audited_table('records.qp_access', 'qp_access', 'id', true);
select kernel.register_audited_table('records.qp_access_revocation', 'qp_access', 'access_id', true);
select kernel.register_audited_table('records.qp_access_read', 'qp_access', 'access_id', true);

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

create function records.qp_package_state(p_package uuid) returns text
language sql stable security definer set search_path = pg_catalog, records, pg_temp as $$
  select case when not exists (select 1 from records.qp_package p where p.id = p_package) then null
              when exists (select 1 from records.qp_package_issue i where i.package_id = p_package) then 'ISSUED'
              else 'ASSEMBLED' end
$$;

-- An access is live while it is inside its window and not revoked.
create function records.qp_access_live(p_access uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, records, pg_temp as $$
  select exists (select 1 from records.qp_access a
                  where a.id = p_access and a.valid_from <= clock_timestamp() and clock_timestamp() < a.valid_to
                    and not exists (select 1 from records.qp_access_revocation r where r.access_id = a.id))
$$;

-- The permissions the account holds now through any live grant, in any scope (not only installation-wide ones).
create function records.qp_account_permissions(p_account uuid) returns text[]
language sql stable security definer set search_path = pg_catalog, records, iam, pg_temp as $$
  select coalesce(array_agg(distinct rp.permission_code order by rp.permission_code), '{}')
    from iam.role_grant g join iam.role_permission rp on rp.role_code = g.role_code
   where g.account_id = p_account
     and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, clock_timestamp())
     and iam.role_permission_live_at(rp.added_at, rp.removed_at, clock_timestamp())
$$;

-- The account holds no permission other than READ ones now, in any scope (a read-only account, DI-14).
create function records.qp_account_read_only(p_account uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, records, iam, pg_temp as $$
  select not exists (select 1 from unnest(records.qp_account_permissions(p_account)) h(code) join iam.permission p on p.code = h.code where p.effect <> 'READ')
$$;

-- Signed content of a package: what QA verifies as a true copy (DI-41). The package is immutable, so the signature stays
-- valid; its state is ASSEMBLED until the signature is recorded.
create function records.qp_package_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, records, pg_temp as $$
declare
  p records.qp_package;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into p from records.qp_package where id = p_id::uuid;
  if p.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true, 'content_version', 1,
    'content', jsonb_build_object('package_id', p.id, 'kind', p.kind, 'subject_type', p.subject_type, 'subject_id', p.subject_id,
                                  'subject_label', p.subject_label, 'package_sha256', p.package_sha256, 'content_sha256', p.content_sha256,
                                  'sections', p.sections),
    'state', records.qp_package_state(p.id),
    'scope', '{}'::jsonb);
end
$$;

select esig.register_content_provider('qp_package', 'records.qp_package_content(text)',
  'The EU QP batch package of a lot: its manifest and the SHA-256 of every section, verified as a true copy (DI-41)');

-- ---------------------------------------------------------------------------------------------
-- Acts
-- ---------------------------------------------------------------------------------------------

-- Registers an assembled package. p_package_sha256 is the server's SHA-256 of the manifest text; the database computes it
-- again. Returns the package id.
create function records.register_qp_package(p_subject_type text, p_subject_id text, p_manifest text, p_package_sha256 text, p_content text)
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

-- QA issues the package with its TRUE_COPY_VERIFIED signature (DI-41, DI-35).
create function records.issue_qp_package(p_package uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, esig, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_prob  text;
  v_sig   jsonb;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECORD.QA_REVIEW', '{}'::jsonb);
  perform 1 from records.qp_package p where p.id = p_package for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-084 %s is no QP batch package', coalesce(p_package::text, 'NULL'));
  end if;
  if records.qp_package_state(p_package) = 'ISSUED' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-084 the QP batch package is already issued';
  end if;
  v_prob := coalesce(esig.signature_problem(p_signature, 'TRUE_COPY_VERIFIED', 'qp_package', p_package::text), esig.signature_state_problem(p_signature));
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-085 %s (DI-35, DI-37)', v_prob);
  end if;
  v_sig := esig.signature_state(p_signature);
  if (v_sig ->> 'signer_person')::uuid is distinct from (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-085 the package is issued by the person who signed it (DI-14)';
  end if;
  if esig.content_hash_of('qp_package', p_package::text, esig.provide('qp_package', p_package::text)) is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-085 the signed content is not the package''s (DI-37)';
  end if;
  insert into records.qp_package_issue (package_id, signature_id, person_id, account_id, correlation_id)
  values (p_package, p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- QA grants one QP account a read-only access to the issued packages of the package's subject until p_valid_to.
create function records.grant_qp_access(p_package uuid, p_account uuid, p_valid_to timestamptz, p_reason text) returns uuid
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

create function records.revoke_qp_access(p_access uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, iam, pg_temp as $$
declare
  v_actor jsonb;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('QP_ACCESS.GRANT', '{}'::jsonb);
  if not exists (select 1 from records.qp_access a where a.id = p_access) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-086 %s is no QP access', coalesce(p_access::text, 'NULL'));
  end if;
  if records.is_blank(p_reason) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-086 a revocation states its reason';
  end if;
  insert into records.qp_access_revocation (access_id, reason, revoked_by_person, revoked_by_account, correlation_id)
  values (p_access, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  on conflict (access_id) do nothing;
end
$$;

-- The live access of the acting QP account to a subject, or NULL. Refuses unless the account is still read-only.
create function records.qp_reader_access(p_subject_type text, p_subject_id text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, iam, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('QP_PACKAGE.READ', '{}'::jsonb);
begin
  if not records.qp_account_read_only((v_actor ->> 'account_id')::uuid) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-090 a QP account reads the package only while it holds read permissions only (read-only)';
  end if;
  return (select a.id from records.qp_access a
           where a.account_id = (v_actor ->> 'account_id')::uuid and a.subject_type = p_subject_type and a.subject_id = p_subject_id
             and records.qp_access_live(a.id)
           order by a.valid_to desc limit 1);
end
$$;

-- The packages the acting QP account may read now: [{packageId, subjectType, subjectId, subjectLabel, packageSha256,
-- issuedAt, accessId, accessValidTo}], latest first.
create function records.qp_reader_packages() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, iam, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('QP_PACKAGE.READ', '{}'::jsonb);
begin
  if not records.qp_account_read_only((v_actor ->> 'account_id')::uuid) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-090 a QP account reads the package only while it holds read permissions only (read-only)';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('packageId', p.id, 'subjectType', p.subject_type, 'subjectId', p.subject_id, 'subjectLabel', p.subject_label,
                                        'packageSha256', p.package_sha256, 'contentBytes', p.content_bytes, 'issuedAt', i.recorded_at,
                                        'accessId', a.id, 'accessValidTo', a.valid_to) order by i.recorded_at desc, p.id)
      from records.qp_access a
      join records.qp_package p on p.subject_type = a.subject_type and p.subject_id = a.subject_id
      join records.qp_package_issue i on i.package_id = p.id
     where a.account_id = (v_actor ->> 'account_id')::uuid and records.qp_access_live(a.id)), '[]'::jsonb);
end
$$;

-- One issued package for the acting QP account, logged: {packageId, packageSha256, contentSha256, content}.
create function records.read_qp_package(p_package uuid) returns jsonb
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

revoke all on function records.qp_package_state(uuid), records.qp_access_live(uuid), records.qp_account_permissions(uuid), records.qp_account_read_only(uuid), records.qp_package_content(text),
  records.register_qp_package(text, text, text, text, text), records.issue_qp_package(uuid, uuid), records.grant_qp_access(uuid, uuid, timestamptz, text),
  records.revoke_qp_access(uuid, text), records.qp_reader_access(text, text), records.qp_reader_packages(), records.read_qp_package(uuid) from public;
grant execute on function records.qp_package_state(uuid), records.qp_access_live(uuid),
  records.register_qp_package(text, text, text, text, text), records.issue_qp_package(uuid, uuid), records.grant_qp_access(uuid, uuid, timestamptz, text),
  records.revoke_qp_access(uuid, text), records.qp_reader_packages(), records.read_qp_package(uuid) to ebmr_app;

reset role;
