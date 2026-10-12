-- The document service: an evidence document is its stored bytes (Phase 4 slice 2a; Phase 3 review backlog: evidence
-- documents were self-attested, the storer typing the hash, size and storage key; controls DI-22, DI-24 and the plan's
-- "evidence hash" core item).
--
--   site.evidence_document_content   the bytes of a stored document (insert-only, one row per document; never readable
--                                    by the application role but through site.evidence_document_bytes).
--   site.store_evidence_document(p, bytes)   EVIDENCE.STORE   p: {mediaType, title}; the database computes the SHA-256 and
--                                    the size from the bytes it stores and names the storage key itself
--                                    (db/<sha256>/<document id>); returns the document id.
--   site.evidence_document_bytes(id)          the stored bytes, for a person at the document's site.
--   site.evidence_document_verified(id)       true when the stored bytes still hash to the recorded SHA-256.
--   site.register_evidence_document(p)        0731's self-attested form: refused from now on (EBMR-SITE-835).
--   site.evidence_document_problem(id, site)  re-created from 0731: a document without stored bytes, or whose bytes no
--                                    longer match its hash, is not evidence.
--
-- Messages: EBMR-SITE-835 to 839.

set local role ebmr_owner;

create table site.evidence_document_content (
  document_id  uuid primary key references site.evidence_document (id),
  bytes        bytea not null check (octet_length(bytes) between 1 and 16777216)
);
revoke all on site.evidence_document_content from public;
create trigger aa_insert_only_site_evidence_document_content before update or delete on site.evidence_document_content
  for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate_site_evidence_document_content before truncate on site.evidence_document_content
  for each statement execute function kernel.reject_mutation();

create function site.store_evidence_document(p jsonb, p_bytes bytea) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v_site text;
  v_id   uuid := gen_random_uuid();
  v_sha  text;
begin
  perform iam.assert_not_administrator();
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-330 the document details are required';
  end if;
  v_site := site.actor_site();
  perform iam.require_permission('EVIDENCE.STORE', jsonb_build_object('site', v_site));
  if p_bytes is null or octet_length(p_bytes) = 0 or octet_length(p_bytes) > 16777216 then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-836 a stored document has between 1 byte and 16 MB of content';
  end if;
  v_sha := encode(sha256(p_bytes), 'hex');
  insert into site.evidence_document (id, site_code, sha256, media_type, size_bytes, storage_key, title, uploaded_by_person, uploaded_by_account, correlation_id)
  values (v_id, v_site, v_sha, p ->> 'mediaType', octet_length(p_bytes), format('db/%s/%s', v_sha, v_id), btrim(coalesce(p ->> 'title', '')),
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid);
  insert into site.evidence_document_content (document_id, bytes) values (v_id, p_bytes);
  return v_id;
end
$$;

-- 0731's form took the hash, size and storage key from the storer; it is refused (header).
create or replace function site.register_evidence_document(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
begin
  raise exception using errcode = 'P0001',
    message = 'EBMR-SITE-835 a document is stored with its bytes (site.store_evidence_document); the database computes its SHA-256 and size (DI-24)';
end
$$;

create function site.evidence_document_bytes(p_id uuid) returns bytea
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  e site.evidence_document;
  v bytea;
begin
  perform site.require_actor();
  select * into e from site.evidence_document where id = p_id;
  if not found or e.site_code is distinct from site.actor_site() then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-837 %s is not a stored evidence document of this site', p_id);
  end if;
  select c.bytes into v from site.evidence_document_content c where c.document_id = p_id;
  if v is null then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-837 evidence document %s has no stored bytes (it was registered before the document service)', p_id);
  end if;
  return v;
end
$$;

create function site.evidence_document_verified(p_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select coalesce((select encode(sha256(c.bytes), 'hex') = e.sha256 and octet_length(c.bytes) = e.size_bytes
                     from site.evidence_document e join site.evidence_document_content c on c.document_id = e.id where e.id = p_id), false)
$$;

-- As 0731; the document has its stored bytes and they match the recorded hash (header).
create or replace function site.evidence_document_problem(p_id uuid, p_site text) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case
    when p_id is null then 'names no stored evidence document (DI-24)'
    when e.id is null then format('%s is not a stored evidence document of this installation (DI-24)', p_id)
    when e.site_code is distinct from p_site then format('evidence document %s was stored at site %s, not at site %s', p_id, e.site_code, coalesce(p_site, 'NULL'))
    when not site.evidence_document_verified(e.id) then format('evidence document %s has no stored bytes matching its SHA-256; only a document stored with its bytes is evidence (DI-24)', p_id)
  end
  from (select 1) x left join site.evidence_document e on e.id = p_id
$$;

revoke all on site.evidence_document_content from ebmr_app;
revoke all on function site.store_evidence_document(jsonb, bytea), site.evidence_document_bytes(uuid), site.evidence_document_verified(uuid) from public;
revoke all on function site.register_evidence_document(jsonb) from ebmr_app;
grant execute on function site.store_evidence_document(jsonb, bytea), site.evidence_document_bytes(uuid), site.evidence_document_verified(uuid) to ebmr_app;

reset role;
