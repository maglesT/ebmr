-- Phase 7 slice 7-0: the release identity, the validation-summary approval and the approved system description
-- (interfaces slice-7-0-interfaces.md sections 4 and 5; controls DI-03, DI-06; defaults D-P7-0-5, D-P7-12).
--
-- Handbook: modules/kernel.md
--
--   platform.schema_release()            the release as the database knows it: the lowercase hex SHA-256 over the
--                                        migration runner's ledger (public.schema_migration), one line
--                                        `namespace/name/checksum` per row, ordered by namespace then name in byte order
--                                        (collation "C"), joined by a line feed with none after the last line. The order
--                                        is not the apply order, so a database upgraded slice by slice and a fresh one
--                                        give the same value; tools/validation computes the same value from the files.
--   platform.validation_summary          insert-only: the quality unit's approval of the validation summary of one
--                                        release (its schema release and the SHA-256 of the summary document), with the
--                                        VALIDATION_SUMMARY_APPROVED signature bound to both (aggregate
--                                        validation_summary, id `<schema release>@<summary sha256>`).
--   platform.approve_validation_summary  needs VALIDATION.APPROVE_SUMMARY and the approver's own signature; only the
--                                        running release's summary is approved (EBMR-VAL-003 to -006).
--   platform.validation_summary_problem  EBMR-VAL-001 when the running release has no approved summary on a GMP
--                                        installation, else NULL (a sandbox is not gated). Slice 7c calls it at batch
--                                        issue; nothing calls it yet.
--   platform.system_interface            configuration area SYSTEM_DESCRIPTION (kernel 1195 change control): one version
--                                        per interface (adapter code): its source system, endpoint host, transport
--                                        (LOOPBACK or MTLS) and whether its feed is signed; DESCRIBED, or WITHDRAWN later.
--   platform.describe_interface(def)     the writer (CONFIG.SYSTEM_DESCRIPTION, under an approved change record).
--   platform.interface_described(code)   true when the interface's version in force is DESCRIBED. Slice 7c refuses an
--                                        inbound message or an adapter start of an interface that is not
--                                        (EBMR-INT-035); nothing calls it yet.
--   platform.system_description()        every interface's version in force (the IQ and the health page read it).
--
-- Permissions:
--   VALIDATION.APPROVE_SUMMARY  GMP SIGN    approve the validation summary of the running release: QA_REVIEWER and
--                                           QA_MBR_APPROVER (the quality unit only)
--   CONFIG.SYSTEM_DESCRIPTION   GMP WRITE   record an interface of the approved system description: PROCESS_OWNER (the
--                                           system owner) and CSV_DI_LEAD
--   CONTROLLED.READ             READ_ONLY   read the controlled-substance list, balance and register (slice 7a gates the
--                                           reads; IN-53, 6jc-R2); granted in tablets 1400
--
-- Messages: EBMR-VAL-001, EBMR-VAL-003 to EBMR-VAL-006 (EBMR-VAL-002, -007 and -008 are the bundle reader's,
-- packages/validation-kit),
-- EBMR-INT-036.

-- The ledger belongs to the migration runner's role, which runs this file; the release identity reads it as the owner.
grant select on public.schema_migration to ebmr_owner;

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1300_release_identity_and_validation)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the release identity, the validation-summary approval and the approved system description (DI-03, DI-06)'));

insert into iam.permission (code, domain, effect, description) values
  ('VALIDATION.APPROVE_SUMMARY', 'GMP', 'SIGN', 'Approve the validation summary of the running release (DI-03)'),
  ('CONFIG.SYSTEM_DESCRIPTION', 'GMP', 'WRITE', 'Record an interface of the approved system description, under an approved change record (DI-06, DI-09)'),
  ('CONTROLLED.READ', 'READ_ONLY', 'READ', 'Read the controlled-substance list, balance and register (IN-53)');
-- The kernel roles that hold them (as kernel 1195 grants CONFIG.*): a signature meaning's permission is held by a kernel
-- role (DI-35). CONTROLLED.READ follows the CONTROLLED.* grants of the edition (tablets 1400).
insert into iam.role_permission (role_code, permission_code) values
  ('QA_REVIEWER', 'VALIDATION.APPROVE_SUMMARY'),
  ('QA_MBR_APPROVER', 'VALIDATION.APPROVE_SUMMARY'),
  ('PROCESS_OWNER', 'CONFIG.SYSTEM_DESCRIPTION'),
  ('CSV_DI_LEAD', 'CONFIG.SYSTEM_DESCRIPTION');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values ('VALIDATION_SUMMARY_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'MASTER_RECORD', 'APPROVER', 'Validation summary approved',
        'As a quality-unit approver, I approve this validation summary for this release of the system: GMP batches may be issued on it.',
        array['VALIDATION.APPROVE_SUMMARY'], '{}', false, false, false, 'ALL_COMPONENTS', false,
        'DI-03 (the system is validated for its intended use before GMP use); EU Annex 11 section 4; 21 CFR 211.68 and Part 11 11.10(a)');

-- ---------------------------------------------------------------------------------------------
-- The release identity
-- ---------------------------------------------------------------------------------------------

create function platform.schema_release() returns text
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(
           pg_catalog.string_agg(m.namespace || '/' || m.name || '/' || m.checksum, E'\n'
                                 order by m.namespace collate "C", m.name collate "C"), ''), 'UTF8')), 'hex')
    from public.schema_migration m
$$;

-- ---------------------------------------------------------------------------------------------
-- The validation-summary approval
-- ---------------------------------------------------------------------------------------------

create table platform.validation_summary (
  id                  uuid primary key default gen_random_uuid(),
  schema_release      text not null check (schema_release ~ '^[0-9a-f]{64}$'),
  summary_sha256      text not null check (summary_sha256 ~ '^[0-9a-f]{64}$'),
  title               text not null check (btrim(title) <> '' and length(title) <= 200),
  approved_signature  uuid not null unique,
  approved_by_person  uuid not null,
  approved_by_account uuid not null,
  approved_at         timestamptz not null default clock_timestamp(),
  unique (schema_release, summary_sha256)
);
revoke all on platform.validation_summary from public;
grant select on platform.validation_summary to ebmr_app;
select platform.enforce_db_time('platform.validation_summary', array['approved_at']);
select kernel.register_audited_table('platform.validation_summary', 'validation_summary', 'schema_release', true);

-- Signed content of a validation summary (aggregate validation_summary, id `<schema release>@<summary sha256>`): the
-- release and the summary's hash. The content is the id itself, so the approval binds exactly that release and that
-- document; PROPOSED until it is approved.
create function platform.validation_summary_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v_release text := split_part(coalesce(p_id, ''), '@', 1);
  v_sha     text := split_part(coalesce(p_id, ''), '@', 2);
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{64}@[0-9a-f]{64}$' then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object('schema_release', v_release, 'summary_sha256', v_sha),
    'state', case when exists (select 1 from platform.validation_summary s where s.schema_release = v_release and s.summary_sha256 = v_sha)
                  then 'APPROVED' else 'PROPOSED' end,
    'entered_by', '[]'::jsonb);
end
$$;
select esig.register_content_provider('validation_summary', 'platform.validation_summary_content(text)',
  'Validation summary of a release (DI-03): the schema release and the SHA-256 of the summary document');

create function platform.approve_validation_summary(p_schema_release text, p_summary_sha256 text, p_title text, p_signature uuid)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, esig, kernel, pg_temp as $$
declare
  v_actor  jsonb;
  v_signer uuid;
  v_id     uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('VALIDATION.APPROVE_SUMMARY', '{}'::jsonb);
  if coalesce(p_schema_release, '') !~ '^[0-9a-f]{64}$' or coalesce(p_summary_sha256, '') !~ '^[0-9a-f]{64}$'
     or kernel.is_blank(p_title) or length(p_title) > 200 then
    raise exception using errcode = 'P0001', message =
      'EBMR-VAL-003 a validation summary approval names the schema release and the summary''s SHA-256 (64 lowercase hex characters each) and a title of at most 200 characters (DI-03)';
  end if;
  if p_schema_release <> platform.schema_release() then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-VAL-004 the summary is for release %s, but this database runs release %s: only the running release''s summary is approved here (DI-03)',
      p_schema_release, platform.schema_release());
  end if;
  if exists (select 1 from platform.validation_summary s where s.schema_release = p_schema_release and s.summary_sha256 = p_summary_sha256) then
    raise exception using errcode = 'P0001', message = format('EBMR-VAL-005 summary %s of release %s is already approved', p_summary_sha256, p_schema_release);
  end if;
  if p_signature is null then
    raise exception using errcode = 'P0001', message = 'EBMR-VAL-006 the approval of a validation summary is an e-signature (DI-03)';
  end if;
  v_signer := (esig.assert_signature(p_signature, 'VALIDATION_SUMMARY_APPROVED', 'validation_summary',
                                     p_schema_release || '@' || p_summary_sha256) ->> 'signer_person')::uuid;
  if v_signer is distinct from (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-VAL-006 the approver records their own signature of the validation summary';
  end if;
  insert into platform.validation_summary (schema_release, summary_sha256, title, approved_signature, approved_by_person, approved_by_account)
  values (p_schema_release, p_summary_sha256, btrim(p_title), p_signature, v_signer, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function platform.validation_summary_problem() returns text
language plpgsql stable security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_release text;
begin
  if kernel.installation_kind() <> 'GMP' then
    return null;
  end if;
  v_release := platform.schema_release();
  if exists (select 1 from platform.validation_summary s where s.schema_release = v_release) then
    return null;
  end if;
  return format('EBMR-VAL-001 release %s has no approved validation summary: GMP batches are not issued on an unvalidated release (DI-03)', v_release);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The approved system description
-- ---------------------------------------------------------------------------------------------

create table platform.system_interface (
  id             uuid primary key default gen_random_uuid(),
  adapter_code   text not null check (adapter_code ~ '^[A-Z][A-Z0-9_-]{1,63}$'),
  source_system  text not null check (source_system in ('ERP_WMS', 'QMS', 'LIMS', 'LMS', 'CMMS', 'EMS', 'OPCUA', 'L3')),
  endpoint_host  text not null check (endpoint_host ~ '^[A-Za-z0-9.:\[\]-]{1,253}$'),
  transport      text not null check (transport in ('LOOPBACK', 'MTLS')),
  signed_feed    boolean not null,
  status         text not null check (status in ('DESCRIBED', 'WITHDRAWN')),
  valid_from     timestamptz not null default clock_timestamp(),
  recorded_at    timestamptz not null default clock_timestamp(),
  -- A loopback interface is one whose endpoint is this host (D-P7-10).
  check (transport <> 'LOOPBACK' or endpoint_host in ('localhost', '127.0.0.1', '::1', '[::1]')),
  -- The OPC UA feed is signed by the gateway (D-P7-0-3).
  check (source_system <> 'OPCUA' or status = 'WITHDRAWN' or signed_feed)
);
create index system_interface_item on platform.system_interface (adapter_code, valid_from, recorded_at);
revoke all on platform.system_interface from public;
grant select on platform.system_interface to ebmr_app;
select platform.enforce_db_time('platform.system_interface', array['valid_from', 'recorded_at']);
select kernel.register_audited_table('platform.system_interface', 'system_description', 'adapter_code', true);

select platform.register_config_area('SYSTEM_DESCRIPTION', 'platform.system_interface',
  'The approved system description: each interface with its source system, endpoint host, transport and whether its feed is signed (DI-06)',
  array['adapter_code'], array['source_system', 'endpoint_host', 'transport', 'signed_feed', 'status'],
  'valid_from', 'recorded_at');

-- p_def: {adapterCode, sourceSystem, endpointHost, transport (LOOPBACK or MTLS), signedFeed (boolean), status (DESCRIBED
-- or WITHDRAWN)}. The configuration guard then needs an approved change record naming SYSTEM_DESCRIPTION.
create function platform.describe_interface(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, kernel, pg_temp as $$
declare
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('CONFIG.SYSTEM_DESCRIPTION', '{}'::jsonb);
  if jsonb_typeof(p_def) is distinct from 'object'
     or coalesce(p_def ->> 'adapterCode', '') !~ '^[A-Z][A-Z0-9_-]{1,63}$'
     or coalesce(p_def ->> 'sourceSystem', '') not in ('ERP_WMS', 'QMS', 'LIMS', 'LMS', 'CMMS', 'EMS', 'OPCUA', 'L3')
     or coalesce(p_def ->> 'endpointHost', '') !~ '^[A-Za-z0-9.:\[\]-]{1,253}$'
     or coalesce(p_def ->> 'transport', '') not in ('LOOPBACK', 'MTLS')
     or jsonb_typeof(p_def -> 'signedFeed') is distinct from 'boolean'
     or coalesce(p_def ->> 'status', '') not in ('DESCRIBED', 'WITHDRAWN') then
    raise exception using errcode = 'P0001', message =
      'EBMR-INT-036 an interface of the system description names its adapter code, source system, endpoint host, transport (LOOPBACK or MTLS), whether its feed is signed and its status (DESCRIBED or WITHDRAWN) (DI-06)';
  end if;
  insert into platform.system_interface (adapter_code, source_system, endpoint_host, transport, signed_feed, status)
  values (p_def ->> 'adapterCode', p_def ->> 'sourceSystem', p_def ->> 'endpointHost', p_def ->> 'transport',
          (p_def ->> 'signedFeed')::boolean, p_def ->> 'status')
  returning id into v_id;
  return v_id;
end
$$;

-- Every interface's version in force: the latest version of each adapter code.
create function platform.system_description()
returns table (adapter_code text, source_system text, endpoint_host text, transport text, signed_feed boolean, status text,
               valid_from timestamptz)
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select distinct on (i.adapter_code) i.adapter_code, i.source_system, i.endpoint_host, i.transport, i.signed_feed, i.status, i.valid_from
    from platform.system_interface i
   order by i.adapter_code, i.valid_from desc, i.recorded_at desc, i.id desc
$$;

create function platform.interface_described(p_adapter_code text) returns boolean
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select coalesce((select d.status = 'DESCRIBED' from platform.system_description() d where d.adapter_code = p_adapter_code), false)
$$;

select kernel.set_actor_context(null);

revoke all on function platform.schema_release(), platform.validation_summary_content(text),
                       platform.approve_validation_summary(text, text, text, uuid), platform.validation_summary_problem(),
                       platform.describe_interface(jsonb), platform.system_description(), platform.interface_described(text) from public;
grant execute on function platform.schema_release(), platform.validation_summary_content(text),
                          platform.approve_validation_summary(text, text, text, uuid), platform.validation_summary_problem(),
                          platform.describe_interface(jsonb), platform.system_description(), platform.interface_described(text) to ebmr_app;

reset role;
