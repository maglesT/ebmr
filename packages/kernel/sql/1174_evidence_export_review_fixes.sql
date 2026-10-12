-- Records (kernel): slice 6 quick review fixes of the evidence export, the inspection read and the contingency packs
-- (Phase 4 slice 6-fixb; DI-41, IN-11, DI-40, DI-17, DI-18, DI-43; functions re-created from their latest definitions,
-- kernel 1170 and 1171).
--
--   6-R1  records.register_evidence_export checked each section's SHA-256, the bundle manifest against the true-copy
--         register, the PDF header and the presence of the claimed content SHA-256, but not that the bundle's parts are
--         the ones its manifest names, nor that they are the record, nor that the PDF renders them: a caller with
--         RECORD.TRUE_COPY_REGISTER could register (and QA certify) an export whose parts were altered under a genuine
--         manifest, or a PDF without the audit trail. Now the database recomputes what the verifier checks:
--           * records.true_copy_bundle_problem(bundle): the manifest lists exactly records.json, audit-chain.json and
--             verification.json with the SHA-256 and size of each part; the rows, events, head and checkpoints are the
--             ones records.true_copy_parts reads for the chain now (so the head has not moved since the copy, and every
--             row is the stored row), the genesis value is the chain's, and the chain verifies in the database;
--           * records.true_copy_content_text(bundle): content.json exactly as packages/kernel/src/records/pdf-true-copy.ts
--             writes it (JSON.stringify with two-space indentation); a PDF's claimed content SHA-256 must be its SHA-256,
--             and the PDF must embed content.json, records.json and audit-chain.json byte for byte (the renderer embeds the
--             associated files unfiltered since this fix). Messages EBMR-REC-128, 129.
--         Certification needs a registered export, so an export these checks refuse cannot be certified.
--   6-R2  records.read_evidence_export refuses an administrator before the permission check (DI-18, then DI-17).
--   6-R3  records.issue_contingency_pack refuses a batch that ended (EXECUTION_COMPLETE, ABORTED, CANCELLED; EBMR-REC-107).
--         The kernel migrations run before recipe-core, so records.batch_status reads the stored status late-bound from
--         recipe.execution_state when that table exists (NULL otherwise: a kernel-only database has no batches).

set local role ebmr_owner;

-- The stored execution status of a batch, or NULL (no recipe schema, no batch).
create function records.batch_status(p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, records, pg_temp as $$
declare
  v text;
begin
  if p_batch is null or to_regclass('recipe.execution_state') is null then
    return null;
  end if;
  execute 'select s.status from recipe.execution_state s where s.batch_id = $1' into v using p_batch;
  return v;
end
$$;

-- content.json of a true-copy bundle, as pdf-true-copy.ts (trueCopyContent) writes it, or NULL when the bundle has none.
create function records.true_copy_content_text(p_bundle jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_records text := (p_bundle -> 'parts') ->> 'records.json';
  v_chain   text := (p_bundle -> 'parts') ->> 'audit-chain.json';
  r         jsonb;
  c         jsonb;
  v_last    jsonb;
  q         text := chr(10);
begin
  if v_records is null or v_chain is null then
    return null;
  end if;
  r := v_records::jsonb;
  c := v_chain::jsonb;
  v_last := c -> 'events' -> (jsonb_array_length(c -> 'events') - 1);
  if v_last is null then
    return null;
  end if;
  return '{' || q
    || '  "format": "ebmr.true-copy-content/1",' || q
    || '  "chainKey": ' || to_json(r ->> 'chainKey')::text || ',' || q
    || '  "aggregateType": ' || to_json(r ->> 'aggregateType')::text || ',' || q
    || '  "aggregateId": ' || to_json(r ->> 'aggregateId')::text || ',' || q
    || '  "head": ' || case when jsonb_typeof(c -> 'head') = 'object'
                            then '{' || q || '    "seq": ' || to_json(c -> 'head' ->> 'seq')::text || ',' || q
                                 || '    "hash": ' || to_json(c -> 'head' ->> 'hash')::text || q || '  }'
                            else 'null' end || ',' || q
    || '  "recordDate": ' || to_json(v_last ->> 'recordedAt')::text || ',' || q
    || '  "parts": [' || q
    || '    {' || q || '      "name": "records.json",' || q
    || '      "sha256": "' || encode(sha256(convert_to(v_records, 'UTF8')), 'hex') || '",' || q
    || '      "bytes": ' || octet_length(convert_to(v_records, 'UTF8')) || q || '    },' || q
    || '    {' || q || '      "name": "audit-chain.json",' || q
    || '      "sha256": "' || encode(sha256(convert_to(v_chain, 'UTF8')), 'hex') || '",' || q
    || '      "bytes": ' || octet_length(convert_to(v_chain, 'UTF8')) || q || '    }' || q
    || '  ]' || q || '}';
end
$$;

-- Why a true-copy bundle is not the record as the database holds it now, or NULL.
create function records.true_copy_bundle_problem(p_bundle jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, records, kernel, pg_temp as $$
declare
  m       jsonb;
  r       jsonb;
  c       jsonb;
  v_now   jsonb;
  v_key   text;
  p       jsonb;
  v_text  text;
begin
  begin
    m := (p_bundle ->> 'manifest')::jsonb;
    r := ((p_bundle -> 'parts') ->> 'records.json')::jsonb;
    c := ((p_bundle -> 'parts') ->> 'audit-chain.json')::jsonb;
  exception when others then
    return 'the bundle''s manifest or parts are not JSON';
  end;
  if m is null or r is null or c is null or jsonb_typeof(m -> 'parts') is distinct from 'array' then
    return 'the bundle lacks its manifest, its records or its audit chain';
  end if;
  if (select array_agg(x ->> 'name' order by x ->> 'name') from jsonb_array_elements(m -> 'parts') x) is distinct from array['audit-chain.json', 'records.json', 'verification.json']
     or (select array_agg(k order by k) from jsonb_object_keys(p_bundle -> 'parts') k) is distinct from array['audit-chain.json', 'records.json', 'verification.json'] then
    return 'the bundle''s parts are not exactly records.json, audit-chain.json and verification.json as its manifest lists them';
  end if;
  for p in select value from jsonb_array_elements(m -> 'parts') loop
    v_text := (p_bundle -> 'parts') ->> (p ->> 'name');
    if encode(sha256(convert_to(v_text, 'UTF8')), 'hex') is distinct from p ->> 'sha256'
       or octet_length(convert_to(v_text, 'UTF8'))::text is distinct from p ->> 'bytes' then
      return format('part %s does not match its SHA-256 or size in the manifest (altered)', p ->> 'name');
    end if;
  end loop;
  v_key := m ->> 'chainKey';
  if r ->> 'chainKey' is distinct from v_key or c ->> 'chainKey' is distinct from v_key
     or c ->> 'genesisPrevHash' is distinct from encode(sha256(convert_to('genesis:' || v_key, 'UTF8')), 'hex')
     or c -> 'head' is distinct from m -> 'head' then
    return 'the parts are not of the chain and head the manifest names';
  end if;
  v_now := records.true_copy_parts(v_key, null);
  if jsonb_array_length(coalesce(v_now -> 'database', '[]'::jsonb)) > 0 then
    return format('the audit chain of %s does not verify in the database', v_key);
  end if;
  if c -> 'head' is distinct from v_now -> 'head' then
    return format('%s changed after the copy was taken (head %s, now %s): assemble the export again', v_key,
                  coalesce(c -> 'head' ->> 'seq', 'none'), coalesce(v_now -> 'head' ->> 'seq', 'none'));
  end if;
  if c -> 'events' is distinct from v_now -> 'events' or c -> 'checkpoints' is distinct from v_now -> 'checkpoints' then
    return format('the audit trail in the copy is not the audit trail of %s', v_key);
  end if;
  if r -> 'tables' is distinct from v_now -> 'tables' or r ->> 'aggregateType' is distinct from v_now ->> 'aggregateType'
     or r ->> 'aggregateId' is distinct from v_now ->> 'aggregateId' then
    return format('the rows in the copy are not the stored rows of %s (every table, every row)', v_key);
  end if;
  return null;
end
$$;

create or replace function records.register_evidence_export(p_subject_type text, p_subject_id text, p_manifest text, p_export_sha256 text, p_content text)
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
  v_bundles  jsonb := '{}'::jsonb;
  v_problem  text;
  v_content  text;
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
      v_problem := records.true_copy_bundle_problem(v_bundle);
      if v_problem is not null then
        raise exception using errcode = 'P0001', message = format('EBMR-REC-128 section %s: %s (DI-41, IN-11)', s ->> 'name', v_problem);
      end if;
      v_bundles := v_bundles || jsonb_build_object(s ->> 'chainKey', v_bundle);
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
  -- Each PDF renders the bundle of its chain: its content SHA-256 is the one the database derives from that bundle, and the
  -- PDF embeds content.json, records.json and audit-chain.json byte for byte (associated files, unfiltered).
  for s in select value from jsonb_array_elements(m -> 'sections') where value ->> 'kind' = 'PDF_TRUE_COPY' loop
    v_bundle := v_bundles -> (s ->> 'chainKey');
    v_content := records.true_copy_content_text(v_bundle);
    v_bytes := decode(c -> 'sections' ->> (s ->> 'name'), 'base64');
    if encode(sha256(convert_to(v_content, 'UTF8')), 'hex') is distinct from s ->> 'contentSha256' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-REC-129 section %s claims a content SHA-256 that is not the one of the true copy of %s (D-6-4)', s ->> 'name', s ->> 'chainKey');
    end if;
    if position(convert_to(v_content, 'UTF8') in v_bytes) = 0
       or position(convert_to((v_bundle -> 'parts') ->> 'records.json', 'UTF8') in v_bytes) = 0
       or position(convert_to((v_bundle -> 'parts') ->> 'audit-chain.json', 'UTF8') in v_bytes) = 0 then
      raise exception using errcode = 'P0001',
        message = format('EBMR-REC-129 section %s does not embed the record, its audit trail and its content descriptor as they are in the true copy of %s (D-6-4)',
                         s ->> 'name', s ->> 'chainKey');
    end if;
  end loop;
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

create or replace function records.read_evidence_export(p_export uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, iam, pg_temp as $$
declare
  v_actor jsonb;
  e       records.evidence_export;
begin
  -- DI-18, then DI-17 (the read writes a log row).
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('ARCHIVE.INSPECT', '{}'::jsonb);
  select * into e from records.evidence_export where id = p_export;
  if e.id is null or records.evidence_export_state(e.id) is distinct from 'CERTIFIED' then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-127 no certified evidence export with this id (an export is read once QA has certified it)';
  end if;
  insert into records.evidence_export_read (export_id, person_id, account_id, role_code, correlation_id)
  values (e.id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code', (v_actor ->> 'correlation_id')::uuid);
  return jsonb_build_object('exportId', e.id, 'exportSha256', e.export_sha256, 'contentSha256', e.content_sha256, 'content', e.content);
end
$$;

create or replace function records.issue_contingency_pack(p_batch uuid, p_batch_label text, p_moment text, p_stage_ref text, p_template_ref text,
                                               p_destination text, p_pages integer, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, records, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_pack  uuid := gen_random_uuid();
  v_out   jsonb := '[]'::jsonb;
  v_id    uuid;
  v_ser   text;
  i       integer;
  v_status text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('CONTINGENCY.ISSUE', '{}'::jsonb);
  if p_batch is null or records.is_blank(p_batch_label) or records.is_blank(p_template_ref) or records.is_blank(p_destination) or records.is_blank(p_reason) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-REC-100 a contingency pack names its batch, the template version, the destination and the reason';
  end if;
  if p_moment is null or p_moment not in ('ISSUE', 'STAGE_START') or (p_moment = 'STAGE_START') <> not records.is_blank(p_stage_ref) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-REC-100 a contingency pack is issued at the batch issue (no stage) or at a stage start (naming the stage)';
  end if;
  if p_pages is null or p_pages < 1 or p_pages > 50 then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-100 a contingency pack has 1 to 50 numbered forms';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('records.form_reconciliation:' || p_batch::text, 0));
  v_status := records.batch_status(p_batch);
  if v_status in ('EXECUTION_COMPLETE', 'ABORTED', 'CANCELLED') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REC-107 the batch is %s: a contingency pack is issued at its issue or at a stage start, never after it ended (DI-43)', v_status);
  end if;
  if exists (select 1 from records.form_reconciliation r where r.batch_id = p_batch) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-REC-100 the paper forms of this batch are reconciled and signed; no further pack is issued (DI-43)';
  end if;
  for i in 1 .. p_pages loop
    v_ser := 'CF-' || lpad(nextval('records.contingency_form_serial')::text, 6, '0');
    insert into records.contingency_form (serial, batch_id, batch_label, pack_id, moment, stage_ref, template_ref, destination, page_no, page_count,
                                          reason, person_id, account_id, correlation_id)
    values (v_ser, p_batch, btrim(p_batch_label), v_pack, p_moment, nullif(btrim(coalesce(p_stage_ref, '')), ''), btrim(p_template_ref),
            btrim(p_destination), i, p_pages, p_reason, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid,
            (v_actor ->> 'correlation_id')::uuid)
    returning id into v_id;
    v_out := v_out || jsonb_build_object('formId', v_id, 'serial', v_ser, 'pageNo', i, 'pageCount', p_pages, 'packId', v_pack);
  end loop;
  return v_out;
end
$$;

revoke all on function records.batch_status(uuid), records.true_copy_content_text(jsonb), records.true_copy_bundle_problem(jsonb) from public;

reset role;
