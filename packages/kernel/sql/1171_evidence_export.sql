-- Records (kernel): the certified evidence export of a record and the read-only inspection workspace over it (Phase 4
-- slice 6b; IN-11, DI-40, DI-41 with the PDF/A-3 true copy of D-6-4 and D-P4-7; plan docs/build-plan/phase-4/
-- phase-4-plan.md slice 6b).
--
-- An export is assembled by the edition's server (packages/kernel/src/records/evidence-export.ts): true-copy bundles of
-- the subject's chains, the PDF/A-3 rendering of the main record (pdf-true-copy.ts; base64 in the package) and documents,
-- with a manifest listing every section and the SHA-256 of its bytes. The server computes the export SHA-256 (of the
-- manifest text); the database computes it again and checks every section, so the stored hash is never the caller's word.
--
--   records.evidence_export_subject  owner-maintained: which chains an export of a subject type may copy, as chain-key
--                                    prefixes joined to the subject id (batch: batch, batch_review, form_reconciliation).
--   records.evidence_export          insert-only: one assembled export (subject, manifest, export SHA-256, the package
--                                    text and its SHA-256, the true copies of its sections).
--   records.evidence_export_certification  insert-only: QA's EVIDENCE_EXPORT_CERTIFIED signature over the export
--                                    (aggregate evidence_export <id>, state ASSEMBLED): the export is CERTIFIED. One each.
--   records.evidence_export_read     insert-only: every read of a certified export through the inspection workspace.
--
-- Database rules (ADR 0012):
--   * register: RECORD.TRUE_COPY_REGISTER, not an administrator; the manifest is an evidence-export manifest of the subject
--     given and its SHA-256 equals the server's; the package carries exactly this manifest and exactly the sections it
--     lists, each matching its SHA-256 (base64 sections decoded first); a TRUE_COPY section copies a chain the subject type
--     names for this subject and is registered in records.true_copy with its manifest SHA-256; a PDF_TRUE_COPY section
--     renders a chain copied in the same export and carries its content SHA-256 in its metadata; the main record
--     (<subject type>:<subject id>) is there as a true copy and as a PDF (EBMR-REC-120..124).
--   * certify: RECORD.QA_REVIEW; a valid EVIDENCE_EXPORT_CERTIFIED signature of this export by the actor, of its current
--     content, in state ASSEMBLED; once (EBMR-REC-125, 126).
--   * read: ARCHIVE.INSPECT (QA reviewers and the read-only INSPECTION_READER role); the export is certified; every read
--     is logged (EBMR-REC-127). The inspection workspace writes nothing else.
-- New permission ARCHIVE.INSPECT (READ_ONLY, READ); new role INSPECTION_READER (HUMAN accounts, READ permissions only);
-- new meaning EVIDENCE_EXPORT_CERTIFIED. Messages: EBMR-REC-120 to EBMR-REC-129.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1171_evidence_export)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'certified evidence export and the read-only inspection workspace (IN-11, DI-40, DI-41)'));

insert into iam.permission (code, domain, effect, description) values
  ('ARCHIVE.INSPECT', 'READ_ONLY', 'READ', 'Read certified evidence exports in the read-only inspection workspace (every read logged)');

insert into iam.role (code, name, role_group, description, account_kinds, is_kernel) values
  ('INSPECTION_READER', 'Inspector (read-only)', 'QUALITY_RELEASE',
   'A regulatory inspector or auditor: reads certified evidence exports in the inspection workspace; never writes or signs here',
   array['HUMAN'], true);
insert into iam.role_permission (role_code, permission_code) values
  ('INSPECTION_READER', 'ARCHIVE.INSPECT'),
  ('QA_REVIEWER', 'ARCHIVE.INSPECT');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values ('EVIDENCE_EXPORT_CERTIFIED', 1, 'VENDOR', true, 'ACTIVE', 'RECORDS', 'VERIFIER', 'Evidence export certified',
        'I certify that this export is a complete and accurate copy of the record, with its audit trail, signatures and metadata, as verified by the system.',
        array['RECORD.QA_REVIEW'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'IN-11; DI-41; DI-40');

create table records.evidence_export_subject (
  subject_type    text primary key check (subject_type ~ '^[a-z][a-z0-9_]*$'),
  chain_prefixes  text[] not null check (cardinality(chain_prefixes) >= 1),
  note            text not null check (btrim(note) <> ''),
  registered_at   timestamptz not null default clock_timestamp()
);
revoke all on records.evidence_export_subject from public;
grant select on records.evidence_export_subject to ebmr_app;
select platform.enforce_db_time('records.evidence_export_subject', array['registered_at']);
select kernel.register_audited_table('records.evidence_export_subject', 'evidence_export_subject', 'subject_type', false);
insert into records.evidence_export_subject (subject_type, chain_prefixes, note)
values ('batch', '{batch,batch_review,form_reconciliation}',
        'A batch record: its execution record, its review chain and its contingency forms (chains <prefix>:<batch id>)');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table records.evidence_export (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind = 'RECORD_EVIDENCE_EXPORT'),
  subject_type       text not null,
  subject_id         text not null,
  subject_label      text not null check (btrim(subject_label) <> ''),
  manifest           text not null,
  export_sha256      text not null check (export_sha256 ~ '^[0-9a-f]{64}$'),
  content            text not null,
  content_sha256     text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  content_bytes      bigint not null check (content_bytes > 0),
  sections           jsonb not null check (jsonb_typeof(sections) = 'array'),
  true_copy_ids      uuid[] not null,
  pdf_content_sha256 text not null check (pdf_content_sha256 ~ '^[0-9a-f]{64}$'),
  assembled_by_person uuid not null,
  assembled_by_account uuid not null,
  correlation_id     uuid not null,
  recorded_at        timestamptz not null default clock_timestamp(),
  unique (export_sha256)
);
create index evidence_export_subject_idx on records.evidence_export (subject_type, subject_id, recorded_at desc);

create table records.evidence_export_certification (
  export_id       uuid primary key references records.evidence_export (id),
  signature_id    uuid not null unique,
  person_id       uuid not null,
  account_id      uuid not null,
  correlation_id  uuid not null,
  recorded_at     timestamptz not null default clock_timestamp()
);

create table records.evidence_export_read (
  id              uuid primary key default gen_random_uuid(),
  export_id       uuid not null references records.evidence_export (id),
  person_id       uuid not null,
  account_id      uuid not null,
  role_code       text,
  correlation_id  uuid not null,
  recorded_at     timestamptz not null default clock_timestamp()
);
create index evidence_export_read_export on records.evidence_export_read (export_id, recorded_at);

do $$
declare
  t text;
begin
  foreach t in array array['evidence_export', 'evidence_export_certification', 'evidence_export_read'] loop
    execute format('revoke all on records.%I from public', t);
    execute format('grant select on records.%I to ebmr_app', t);
    execute format('select platform.enforce_db_time(%L, array[''recorded_at''])', 'records.' || t);
  end loop;
end
$$;
select kernel.register_audited_table('records.evidence_export', 'evidence_export', 'id', true);
select kernel.register_audited_table('records.evidence_export_certification', 'evidence_export', 'export_id', true);
select kernel.register_audited_table('records.evidence_export_read', 'evidence_export', 'export_id', true);

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

create function records.evidence_export_state(p_export uuid) returns text
language sql stable security definer set search_path = pg_catalog, records, pg_temp as $$
  select case when not exists (select 1 from records.evidence_export e where e.id = p_export) then null
              when exists (select 1 from records.evidence_export_certification c where c.export_id = p_export) then 'CERTIFIED'
              else 'ASSEMBLED' end
$$;

-- Signed content of an export (esig content provider): its manifest hash and every section's hash. Immutable.
create function records.evidence_export_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, records, pg_temp as $$
declare
  e records.evidence_export;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into e from records.evidence_export where id = p_id::uuid;
  if e.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true, 'content_version', 1,
    'content', jsonb_build_object('export_id', e.id, 'kind', e.kind, 'subject_type', e.subject_type, 'subject_id', e.subject_id,
                                  'subject_label', e.subject_label, 'export_sha256', e.export_sha256, 'content_sha256', e.content_sha256,
                                  'pdf_content_sha256', e.pdf_content_sha256, 'sections', e.sections),
    'state', records.evidence_export_state(e.id),
    'scope', '{}'::jsonb);
end
$$;

select esig.register_content_provider('evidence_export', 'records.evidence_export_content(text)',
  'A certified evidence export of a record: its manifest and the SHA-256 of every section (IN-11, DI-41)');

-- ---------------------------------------------------------------------------------------------
-- Acts
-- ---------------------------------------------------------------------------------------------

-- Registers an assembled export; returns its id. p_export_sha256 is the server's SHA-256 of the manifest text.
create function records.register_evidence_export(p_subject_type text, p_subject_id text, p_manifest text, p_export_sha256 text, p_content text)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, iam, pg_temp as $$
declare
  v_actor    jsonb;
  m          jsonb;
  c          jsonb;
  s          jsonb;
  v_text     text;
  v_bytes    bytea;
  v_bundle   jsonb;
  v_names    text[] := '{}';
  v_copied   text[] := '{}';
  v_pdfs     text[] := '{}';
  v_copies   uuid[] := '{}';
  v_copy     uuid;
  v_id       uuid;
  v_prefixes text[];
  v_main     text;
  v_pdf_sha  text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECORD.TRUE_COPY_REGISTER', '{}'::jsonb);
  if p_manifest is null or p_content is null or records.is_blank(p_subject_type) or records.is_blank(p_subject_id) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-120 an evidence export names its subject, manifest and content';
  end if;
  if p_export_sha256 is distinct from encode(sha256(convert_to(p_manifest, 'UTF8')), 'hex') then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-120 the export SHA-256 the server computed does not match the manifest (IN-11)';
  end if;
  select e.chain_prefixes into v_prefixes from records.evidence_export_subject e where e.subject_type = p_subject_type;
  if v_prefixes is null then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-120 %s records have no evidence export', p_subject_type);
  end if;
  v_main := p_subject_type || ':' || p_subject_id;
  begin
    m := p_manifest::jsonb;
    c := p_content::jsonb;
  exception when others then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-120 the manifest or the package is not JSON';
  end;
  if jsonb_typeof(m) <> 'object' or m ->> 'format' is distinct from 'ebmr.evidence-export/1' or m ->> 'kind' is distinct from 'RECORD_EVIDENCE_EXPORT'
     or jsonb_typeof(m -> 'subject') is distinct from 'object' or m -> 'subject' ->> 'type' is distinct from p_subject_type
     or m -> 'subject' ->> 'id' is distinct from p_subject_id or records.is_blank(m -> 'subject' ->> 'label')
     or jsonb_typeof(m -> 'sections') is distinct from 'array' or jsonb_array_length(m -> 'sections') < 2 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-REC-120 the manifest is no evidence-export manifest (format ebmr.evidence-export/1) of the subject given';
  end if;
  if jsonb_typeof(c) <> 'object' or c ->> 'format' is distinct from 'ebmr.evidence-export/1' or c ->> 'manifest' is distinct from p_manifest
     or c ->> 'exportSha256' is distinct from p_export_sha256 or jsonb_typeof(c -> 'sections') is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-121 the package does not carry exactly this manifest and its SHA-256';
  end if;

  for s in select value from jsonb_array_elements(m -> 'sections') loop
    if jsonb_typeof(s) <> 'object' or coalesce(s ->> 'name', '') !~ '^[a-z0-9][a-z0-9._-]{0,99}$' or s ->> 'name' = any (v_names)
       or coalesce(s ->> 'kind', '') not in ('TRUE_COPY', 'PDF_TRUE_COPY', 'DOCUMENT') or coalesce(s ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
       or coalesce(s ->> 'encoding', '') not in ('utf-8', 'base64') or (s ->> 'kind' = 'PDF_TRUE_COPY') <> (s ->> 'encoding' = 'base64') then
      raise exception using errcode = 'P0001',
        message = format('EBMR-REC-121 section %s needs a unique name, a kind (TRUE_COPY, PDF_TRUE_COPY or DOCUMENT), its encoding (base64 for the PDF only) and its SHA-256',
                         coalesce(s ->> 'name', '?'));
    end if;
    v_names := v_names || (s ->> 'name');
    v_text := c -> 'sections' ->> (s ->> 'name');
    begin
      v_bytes := case s ->> 'encoding' when 'base64' then decode(v_text, 'base64') else convert_to(v_text, 'UTF8') end;
    exception when others then
      v_bytes := null;
    end;
    if v_text is null or v_bytes is null or encode(sha256(v_bytes), 'hex') is distinct from s ->> 'sha256' then
      raise exception using errcode = 'P0001', message = format('EBMR-REC-121 section %s is missing or does not match its SHA-256 in the manifest', s ->> 'name');
    end if;
    if s ->> 'kind' in ('TRUE_COPY', 'PDF_TRUE_COPY')
       and not exists (select 1 from unnest(v_prefixes) p where p || ':' || p_subject_id = s ->> 'chainKey') then
      raise exception using errcode = 'P0001',
        message = format('EBMR-REC-122 section %s copies %s, which is no record of %s (%s)', s ->> 'name', coalesce(s ->> 'chainKey', '?'), v_main,
                         array_to_string(array(select p || ':' || p_subject_id from unnest(v_prefixes) p), ', '));
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
        raise exception using errcode = 'P0001', message = format('EBMR-REC-123 section %s is no true-copy bundle of chain %s with the manifest SHA-256 given', s ->> 'name', coalesce(s ->> 'chainKey', '?'));
      end if;
      select t.id into v_copy from records.true_copy t
       where t.record_key = s ->> 'chainKey' and t.manifest_sha256 = s ->> 'manifestSha256' order by t.recorded_at limit 1;
      if v_copy is null then
        raise exception using errcode = 'P0001',
          message = format('EBMR-REC-123 the true copy of section %s (chain %s) is not in the true-copy register; register it first (DI-41)', s ->> 'name', s ->> 'chainKey');
      end if;
      v_copies := v_copies || v_copy;
      v_copied := v_copied || (s ->> 'chainKey');
      v_copy := null;
    elsif s ->> 'kind' = 'PDF_TRUE_COPY' then
      if coalesce(s ->> 'contentSha256', '') !~ '^[0-9a-f]{64}$'
         or position(convert_to('ebmr-content-sha256:' || (s ->> 'contentSha256'), 'UTF8') in v_bytes) = 0
         or substring(v_bytes from 1 for 8) <> '\x255044462d312e37'::bytea then
        raise exception using errcode = 'P0001',
          message = format('EBMR-REC-124 section %s is no PDF true copy carrying its content SHA-256 in its metadata (D-6-4)', s ->> 'name');
      end if;
      v_pdfs := v_pdfs || (s ->> 'chainKey');
      if s ->> 'chainKey' = v_main then
        v_pdf_sha := s ->> 'contentSha256';
      end if;
    end if;
  end loop;
  if exists (select 1 from jsonb_object_keys(c -> 'sections') k where k <> all (v_names)) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-121 the package carries a part its manifest does not list';
  end if;
  if exists (select 1 from unnest(v_pdfs) p where p <> all (v_copied)) then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-124 a PDF true copy renders a chain that the export does not carry as a true-copy bundle';
  end if;
  if not (v_main = any (v_copied)) or v_pdf_sha is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-124 the export carries the record %s as a true-copy bundle and as its PDF/A-3 rendering (IN-11, D-6-4)', v_main);
  end if;

  insert into records.evidence_export (kind, subject_type, subject_id, subject_label, manifest, export_sha256, content, content_sha256, content_bytes,
                                       sections, true_copy_ids, pdf_content_sha256, assembled_by_person, assembled_by_account, correlation_id)
  values ('RECORD_EVIDENCE_EXPORT', p_subject_type, p_subject_id, m -> 'subject' ->> 'label', p_manifest, p_export_sha256, p_content,
          encode(sha256(convert_to(p_content, 'UTF8')), 'hex'), octet_length(convert_to(p_content, 'UTF8')), m -> 'sections', v_copies, v_pdf_sha,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- QA certifies an assembled export with EVIDENCE_EXPORT_CERTIFIED (aggregate evidence_export <id>, state ASSEMBLED).
create function records.certify_evidence_export(p_export uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, esig, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_prob  text;
  v_sig   jsonb;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RECORD.QA_REVIEW', '{}'::jsonb);
  perform 1 from records.evidence_export e where e.id = p_export for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-125 %s is no evidence export', coalesce(p_export::text, 'NULL'));
  end if;
  if records.evidence_export_state(p_export) = 'CERTIFIED' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-125 the evidence export is already certified';
  end if;
  v_prob := coalesce(esig.signature_problem(p_signature, 'EVIDENCE_EXPORT_CERTIFIED', 'evidence_export', p_export::text), esig.signature_state_problem(p_signature));
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-126 %s (DI-35, DI-37)', v_prob);
  end if;
  v_sig := esig.signature_state(p_signature);
  if (v_sig ->> 'signer_person')::uuid is distinct from (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-126 the export is certified by the person who signed it (DI-14)';
  end if;
  if esig.content_hash_of('evidence_export', p_export::text, esig.provide('evidence_export', p_export::text)) is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-126 the signed content is not the export''s (DI-37)';
  end if;
  insert into records.evidence_export_certification (export_id, signature_id, person_id, account_id, correlation_id)
  values (p_export, p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- The inspection workspace's read of a certified export (DI-40): logged, read-only.
create function records.read_evidence_export(p_export uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, iam, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('ARCHIVE.INSPECT', '{}'::jsonb);
  e       records.evidence_export;
begin
  select * into e from records.evidence_export where id = p_export;
  if e.id is null or records.evidence_export_state(e.id) is distinct from 'CERTIFIED' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-127 no certified evidence export with this id (an export is read once QA has certified it)';
  end if;
  insert into records.evidence_export_read (export_id, person_id, account_id, role_code, correlation_id)
  values (e.id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code', (v_actor ->> 'correlation_id')::uuid);
  return jsonb_build_object('exportId', e.id, 'exportSha256', e.export_sha256, 'contentSha256', e.content_sha256, 'content', e.content);
end
$$;

revoke all on function records.evidence_export_state(uuid), records.evidence_export_content(text),
  records.register_evidence_export(text, text, text, text, text), records.certify_evidence_export(uuid, uuid), records.read_evidence_export(uuid) from public;
grant execute on function records.evidence_export_state(uuid),
  records.register_evidence_export(text, text, text, text, text), records.certify_evidence_export(uuid, uuid), records.read_evidence_export(uuid) to ebmr_app;

reset role;
