-- The evidence-document store (Phase 3 slice 5a-0; slice 5 plan "Interfaces fixed before building"; backlog slice 2
-- #6, D-S5-6): a document a GMP record cites as evidence (the objective evidence of a fail-to-pass correction, the risk
-- evaluation of a whole-batch reprocessing) is stored, not typed. The server keeps the bytes under a storage key; the
-- database keeps what identifies them: SHA-256, media type, size, the storage key, a title and the uploader, at the
-- uploader's site. Insert-only: a stored document never changes (DI-22); a new version is a new document.
--
--   site.register_evidence_document(p)        EVIDENCE.STORE     returns the document id
--   site.evidence_document_problem(id, site)  NULL when the id names a stored document of that site, else why not
--
-- Messages: EBMR-SITE-330 to 334.

set local role ebmr_owner;

create table site.evidence_document (
  id                    uuid primary key default gen_random_uuid(),
  site_code             text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  sha256                text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  media_type            text not null check (media_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'text/plain', 'text/csv',
                                                            'application/json', 'application/xml')),
  size_bytes            bigint not null check (size_bytes > 0),
  storage_key           text not null unique check (storage_key ~ '^[A-Za-z0-9][A-Za-z0-9/._-]*$' and length(storage_key) <= 512),
  title                 text not null check (btrim(title) <> '' and length(title) <= 200),
  uploaded_by_person    uuid not null,
  uploaded_by_account   uuid not null,
  uploaded_at           timestamptz not null default clock_timestamp(),
  correlation_id        uuid not null
);
create index evidence_document_sha on site.evidence_document (sha256);
revoke all on site.evidence_document from public;

select platform.enforce_db_time('site.evidence_document', array['uploaded_at']);
select kernel.register_audited_table('site.evidence_document', 'evidence_document', 'id', true);

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0731_evidence_documents)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'evidence-document store permission (backlog slice 2 #6; D-S5-6)'));

insert into iam.permission (code, domain, effect, description) values
  ('EVIDENCE.STORE', 'GMP', 'WRITE', 'Store an evidence document (its hash, media type, size and storage key) for a GMP record to cite');

insert into iam.role_permission (role_code, permission_code) values
  ('OPERATOR', 'EVIDENCE.STORE'),
  ('SHIFT_SUPERVISOR', 'EVIDENCE.STORE'),
  ('HEAD_OF_PRODUCTION', 'EVIDENCE.STORE'),
  ('QA_SHOP_FLOOR', 'EVIDENCE.STORE'),
  ('QA_REVIEWER', 'EVIDENCE.STORE'),
  ('QC_ANALYST', 'EVIDENCE.STORE'),
  ('HEAD_OF_QC', 'EVIDENCE.STORE'),
  ('AUTHORISED_PERSON', 'EVIDENCE.STORE');

select kernel.set_actor_context(null);

-- p: {sha256, mediaType, sizeBytes, storageKey, title}
create function site.register_evidence_document(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v_site text;
  v_id   uuid;
begin
  perform iam.assert_not_administrator();
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-330 the document details are required';
  end if;
  v_site := site.actor_site();
  perform iam.require_permission('EVIDENCE.STORE', jsonb_build_object('site', v_site));
  if coalesce(p ->> 'sha256', '') !~ '^[0-9a-f]{64}$' or coalesce(p ->> 'sizeBytes', '') !~ '^[1-9][0-9]{0,15}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-331 a stored document names its SHA-256 (64 lower-case hex digits) and its size in bytes';
  end if;
  insert into site.evidence_document (site_code, sha256, media_type, size_bytes, storage_key, title, uploaded_by_person, uploaded_by_account, correlation_id)
  values (v_site, p ->> 'sha256', p ->> 'mediaType', (p ->> 'sizeBytes')::bigint, p ->> 'storageKey', btrim(coalesce(p ->> 'title', '')),
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function site.evidence_document_problem(p_id uuid, p_site text) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case
    when p_id is null then 'names no stored evidence document (DI-24)'
    when e.id is null then format('%s is not a stored evidence document of this installation (DI-24)', p_id)
    when e.site_code is distinct from p_site then format('evidence document %s was stored at site %s, not at site %s', p_id, e.site_code, coalesce(p_site, 'NULL'))
  end
  from (select 1) x left join site.evidence_document e on e.id = p_id
$$;

revoke all on site.evidence_document from ebmr_app;
grant select on site.evidence_document to ebmr_app;
grant execute on function site.register_evidence_document(jsonb), site.evidence_document_problem(uuid, text) to ebmr_app;

reset role;
