-- Tablets server, module C2 (document-first MBR designer, GMP): the reference-document register that stands in for
-- the document-management system, the designer's warning justifications and the log of test packages exported to
-- the sandbox (Phase 2 apps plan section 8; brief apps/M3-C2-designer.md).
--
-- Controls: PR-03 and DI-04 (references pinned by version and hash and effective at validation, decision F2), IN-02
-- and PR-03 (warnings need a recorded justification, outline 6.3), DI-05 (a test package leaves the GMP
-- installation only as a stamped, hashed file; the export is recorded on the version's audit chain), DI-17 and DI-18
-- (every writer refuses administrators, then checks its permission).
--
-- Privileges: the application role reads these tables and writes nothing directly. Every write is a SECURITY
-- DEFINER function owned by ebmr_owner, with pg_temp last in its search_path (ADR 0016). Every table is insert-only
-- and audited (kernel.register_audited_table): a correction is a new row, never an update.
--
-- Messages: plain language first, then the control and the code EBMR-TAB-15N.
--   150-154 reference documents   155-159 justifications   160-164 test-package exports

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Reference documents (DMS stand-in). The body is JSON (format ebmr.reference-document v1); its SHA-256 over
-- canonical JSON (recipe.json_hash, identical to the TypeScript canonicalJson) is the hash an MBR pins. The
-- columns repeat what the body says, for lookups; the guard proves they agree.

create table tab.reference_document (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null check (kind in ('SOP', 'LIBRARY_ELEMENT', 'MATERIAL', 'EQUIPMENT_CLASS', 'RULE_SET', 'RISK_SCALE',
                                                     'RISK_ASSESSMENT', 'VALIDATION_REPORT', 'HOLD_STUDY', 'REGISTRATION', 'PHARMACOPOEIA',
                                                     'SPECIMEN', 'TEMPLATE', 'CCS', 'DOCUMENT', 'COMPUTERISED_SYSTEM')),
  code                 text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  version              text not null check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  title                text not null check (btrim(title) <> '' and length(title) <= 200),
  content              jsonb not null,
  content_hash         text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  effective_from       date not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  recorded_role        text not null,
  unique (kind, code, version),
  -- Two versions of one document never take effect on the same day, so "the version in force" is always one row.
  unique (kind, code, effective_from)
);
revoke all on tab.reference_document from public;

-- Retirement or withdrawal of a document version (insert-only; at most one per version).
create table tab.reference_document_retirement (
  id                   uuid primary key default gen_random_uuid(),
  document_id          uuid not null unique references tab.reference_document (id),
  status               text not null check (status in ('RETIRED', 'WITHDRAWN')),
  effective_from       date not null,
  reason               text not null check (btrim(reason) <> '' and length(reason) <= 2000),
  recorded_at          timestamptz not null default clock_timestamp(),
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  recorded_role        text not null
);
revoke all on tab.reference_document_retirement from public;

-- The validated actor of the current command, or a refusal (every designer write runs in a kernel command).
create function tab.designer_actor() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v jsonb := kernel.current_actor();
begin
  if v is null then
    raise exception using errcode = 'P0001',
      message = 'No validated command: designer records are written only inside a command started with kernel.begin_command (DI-14). [EBMR-TAB-150]';
  end if;
  return v;
end
$$;
revoke all on function tab.designer_actor() from public;

-- Attribution and content checks for every insert, whoever inserts (the writer functions and the owner alike).
create function tab.reference_document_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_ctx jsonb := tab.designer_actor();
  v_allowed text[] := array['format', 'formatVersion', 'kind', 'code', 'version', 'title', 'effectiveFrom', 'summary', 'notice'];
begin
  if jsonb_typeof(new.content) <> 'object'
     or new.content ->> 'format' is distinct from 'ebmr.reference-document'
     or new.content -> 'formatVersion' is distinct from '1'::jsonb
     or exists (select 1 from jsonb_object_keys(new.content) k where k <> all (v_allowed)) then
    raise exception using errcode = 'P0001',
      message = 'A reference document body is an ebmr.reference-document version 1 object with known members only (DI-04). [EBMR-TAB-151]';
  end if;
  if new.content ->> 'kind' is distinct from new.kind or new.content ->> 'code' is distinct from new.code
     or new.content ->> 'version' is distinct from new.version or new.content ->> 'title' is distinct from new.title
     or new.content ->> 'effectiveFrom' is distinct from to_char(new.effective_from, 'YYYY-MM-DD') then
    raise exception using errcode = 'P0001',
      message = 'The kind, code, version, title and effective date of a reference document must be exactly those in its body (DI-04). [EBMR-TAB-151]';
  end if;
  if new.content_hash is distinct from recipe.json_hash(new.content) then
    raise exception using errcode = 'P0001',
      message = format('The reference document hash %s is not the SHA-256 of its canonical body (%s); nothing was recorded (DI-04). [EBMR-TAB-152]',
                       coalesce(new.content_hash, '(none)'), recipe.json_hash(new.content));
  end if;
  new.recorded_at := clock_timestamp();
  new.recorded_by_person := (v_ctx ->> 'person_id')::uuid;
  new.recorded_by_account := (v_ctx ->> 'account_id')::uuid;
  new.recorded_role := v_ctx ->> 'role_code';
  return new;
end
$$;
create trigger a1_guard before insert on tab.reference_document for each row execute function tab.reference_document_guard();

create function tab.reference_document_retirement_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_ctx jsonb := tab.designer_actor();
begin
  new.recorded_at := clock_timestamp();
  new.recorded_by_person := (v_ctx ->> 'person_id')::uuid;
  new.recorded_by_account := (v_ctx ->> 'account_id')::uuid;
  new.recorded_role := v_ctx ->> 'role_code';
  return new;
end
$$;
create trigger a1_guard before insert on tab.reference_document_retirement for each row execute function tab.reference_document_retirement_guard();

-- Records one document version (master-data steward, MASTERDATA.CHANGE). Returns the row id.
create function tab.record_reference_document(p_content jsonb, p_content_hash text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_id   uuid;
  v_date date;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  if coalesce(p_content ->> 'effectiveFrom', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception using errcode = 'P0001', message = 'A reference document needs its effective date as YYYY-MM-DD (DI-04). [EBMR-TAB-151]';
  end if;
  v_date := (p_content ->> 'effectiveFrom')::date;
  insert into tab.reference_document (kind, code, version, title, content, content_hash, effective_from,
                                      recorded_by_person, recorded_by_account, recorded_role)
  values (p_content ->> 'kind', p_content ->> 'code', p_content ->> 'version', p_content ->> 'title', p_content, p_content_hash, v_date,
          '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', '')
  returning id into v_id;
  return v_id;
end
$$;

-- Retires or withdraws a document version from a date (master-data steward, MASTERDATA.CHANGE), with a reason.
create function tab.retire_reference_document(p_document uuid, p_status text, p_effective_from date, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_id uuid;
  d    tab.reference_document;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  select * into d from tab.reference_document where id = p_document;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown reference document %s. [EBMR-TAB-153]', p_document);
  end if;
  if p_effective_from is null or p_effective_from < d.effective_from then
    raise exception using errcode = 'P0001',
      message = 'A document cannot be retired or withdrawn before the date it took effect (DI-04). [EBMR-TAB-154]';
  end if;
  insert into tab.reference_document_retirement (document_id, status, effective_from, reason, recorded_by_person, recorded_by_account, recorded_role)
  values (p_document, p_status, p_effective_from, p_reason, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', '')
  returning id into v_id;
  return v_id;
end
$$;

select kernel.register_audited_table('tab.reference_document', 'reference_document', 'id', true);
select kernel.register_audited_table('tab.reference_document_retirement', 'reference_document', 'document_id', true);

-- ---------------------------------------------------------------------------------------------
-- Warning justifications (outline 6.3: warnings need a recorded justification). Keyed by version and finding key
-- (`RULE@subject`, the validator's stable key); the latest row for a key is the one in force. Each row keeps the
-- content revision and hash it was written against. Audited on the version's own chain (mbr_version:<id>).

create table tab.designer_justification (
  id                 uuid primary key default gen_random_uuid(),
  version_id         uuid not null references recipe.mbr_version (id),
  finding_key        text not null check (finding_key ~ '^[A-Z0-9][A-Z0-9-]*@.+$' and length(finding_key) <= 300),
  text               text not null check (btrim(text) <> '' and length(text) <= 4000),
  content_revision   integer not null check (content_revision > 0),
  content_hash       text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  person_id          uuid not null,
  account_id         uuid not null,
  role_code          text not null,
  recorded_at        timestamptz not null default clock_timestamp()
);
create index designer_justification_version on tab.designer_justification (version_id, finding_key, recorded_at);
revoke all on tab.designer_justification from public;

create function tab.designer_justification_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_ctx jsonb := tab.designer_actor();
  c     record;
begin
  perform recipe.assert_draft(new.version_id, 'its warning justifications');
  select mc.revision, mc.content_hash into c from recipe.mbr_content mc where mc.version_id = new.version_id order by mc.revision desc limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = format('MBR version %s has no content to justify. [EBMR-TAB-155]', new.version_id);
  end if;
  new.content_revision := c.revision;
  new.content_hash := c.content_hash;
  new.person_id := (v_ctx ->> 'person_id')::uuid;
  new.account_id := (v_ctx ->> 'account_id')::uuid;
  new.role_code := v_ctx ->> 'role_code';
  new.recorded_at := clock_timestamp();
  return new;
end
$$;
create trigger a1_guard before insert on tab.designer_justification for each row execute function tab.designer_justification_guard();

-- Records the author's justification of a validator warning on a DRAFT version (MBR.AUTHOR in the product scope).
-- Returns {id, revision, content_hash}.
create function tab.record_designer_justification(p_version uuid, p_finding_key text, p_text text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, kernel, pg_temp as $$
declare
  j tab.designer_justification;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.mbr_version where id = p_version) then
    raise exception using errcode = 'P0001', message = format('Unknown MBR version %s (EBMR-RCP-020)', p_version);
  end if;
  perform iam.require_permission('MBR.AUTHOR', recipe.version_scope(p_version));
  insert into tab.designer_justification (version_id, finding_key, text, content_revision, content_hash, person_id, account_id, role_code)
  values (p_version, p_finding_key, p_text, 1, repeat('0', 64), '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', '')
  returning * into j;
  return jsonb_build_object('id', j.id, 'revision', j.content_revision, 'content_hash', j.content_hash);
end
$$;

select kernel.register_audited_table('tab.designer_justification', 'mbr_version', 'version_id', true);

-- ---------------------------------------------------------------------------------------------
-- Test-package exports (decision D5; DI-05). The package file (ebmr.mbr-test-package v1) is written to the exchange
-- directory by the server; this row records that the exact current content left the GMP installation for a sandbox
-- test run, with the package hash, and adds a plain-language entry on the version's audit chain.

create table tab.mbr_test_package_export (
  id                 uuid primary key default gen_random_uuid(),
  version_id         uuid not null references recipe.mbr_version (id),
  content_revision   integer not null check (content_revision > 0),
  content_hash       text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  package_hash       text not null unique check (package_hash ~ '^[0-9a-f]{64}$'),
  file_name          text not null unique check (file_name ~ '^[0-9a-f]{64}\.json$'),
  exported_at        timestamptz not null default clock_timestamp(),
  person_id          uuid not null,
  account_id         uuid not null,
  role_code          text not null
);
revoke all on tab.mbr_test_package_export from public;

create function tab.mbr_test_package_export_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_ctx jsonb := tab.designer_actor();
  c     record;
begin
  select mc.revision, mc.content_hash into c from recipe.mbr_content mc where mc.version_id = new.version_id order by mc.revision desc limit 1;
  if not found or c.revision <> new.content_revision or c.content_hash <> new.content_hash then
    raise exception using errcode = 'P0001',
      message = 'The package is not of the version''s current content (it was saved again meanwhile); export again from the saved revision (DI-04). [EBMR-TAB-160]';
  end if;
  if new.file_name <> new.package_hash || '.json' then
    raise exception using errcode = 'P0001', message = 'A test package file is named after its package hash. [EBMR-TAB-161]';
  end if;
  new.person_id := (v_ctx ->> 'person_id')::uuid;
  new.account_id := (v_ctx ->> 'account_id')::uuid;
  new.role_code := v_ctx ->> 'role_code';
  return new;
end
$$;
create trigger a1_guard before insert on tab.mbr_test_package_export for each row execute function tab.mbr_test_package_export_guard();

-- Records an export of the current content (MBR.AUTHOR in the product scope; GMP installation only). Returns
-- {id, exported_at_us}. The server passes the export instant it wrote into the package (from the database clock
-- earlier in the same command); it must not lie in the future.
create function tab.record_test_package_export(p_version uuid, p_revision integer, p_content_hash text, p_package_hash text, p_file_name text,
                                               p_exported_at_us bigint) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, kernel, sandbox, pg_temp as $$
declare
  e       tab.mbr_test_package_export;
  v_at    timestamptz := to_timestamp(p_exported_at_us::numeric / 1000000);
  v_state text;
begin
  perform sandbox.assert_gmp_installation('Exporting an MBR test package');
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.mbr_version where id = p_version) then
    raise exception using errcode = 'P0001', message = format('Unknown MBR version %s (EBMR-RCP-020)', p_version);
  end if;
  perform iam.require_permission('MBR.AUTHOR', recipe.version_scope(p_version));
  if v_at is null or v_at > clock_timestamp() or v_at < clock_timestamp() - interval '5 minutes' then
    raise exception using errcode = 'P0001', message = 'The export instant must come from this command''s database clock. [EBMR-TAB-162]';
  end if;
  v_state := recipe.version_state(p_version);
  insert into tab.mbr_test_package_export (version_id, content_revision, content_hash, package_hash, file_name, exported_at, person_id, account_id, role_code)
  values (p_version, p_revision, p_content_hash, p_package_hash, p_file_name, v_at,
          '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', '')
  returning * into e;
  perform kernel.audit_business_event('mbr_version:' || p_version,
    format('Test package %s exported for a sandbox test run: revision %s (content %s, state %s). Sandbox output is never a GMP record (DI-05).',
           left(p_package_hash, 12), p_revision, left(p_content_hash, 12), coalesce(v_state, 'DRAFT')),
    jsonb_build_object('package_hash', p_package_hash, 'file_name', p_file_name, 'content_revision', p_revision,
                       'content_hash', p_content_hash, 'state', v_state));
  return jsonb_build_object('id', e.id, 'exported_at_us', p_exported_at_us::text);
end
$$;

select kernel.register_audited_table('tab.mbr_test_package_export', 'mbr_version', 'version_id', true);

-- ---------------------------------------------------------------------------------------------
-- Privileges: reads for the application role; writes only through the functions.

grant select on tab.reference_document, tab.reference_document_retirement, tab.designer_justification, tab.mbr_test_package_export to ebmr_app;
revoke all on function tab.reference_document_guard(), tab.reference_document_retirement_guard(), tab.designer_justification_guard(),
                       tab.mbr_test_package_export_guard() from public;
revoke all on function tab.record_reference_document(jsonb, text), tab.retire_reference_document(uuid, text, date, text),
                       tab.record_designer_justification(uuid, text, text),
                       tab.record_test_package_export(uuid, integer, text, text, text, bigint) from public;
grant execute on function tab.record_reference_document(jsonb, text), tab.retire_reference_document(uuid, text, date, text),
                          tab.record_designer_justification(uuid, text, text),
                          tab.record_test_package_export(uuid, integer, text, text, text, bigint) to ebmr_app;

reset role;
