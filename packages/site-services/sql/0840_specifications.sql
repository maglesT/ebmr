-- Approved specifications per material, with the pharmacopoeia and edition of every limit (Phase 4 slice 2b; plan
-- "Slice 2", defaults D-2b-1 to D-2b-3; controls IN-33, PR-45; outline 5.2.9 "LIMS supplies results").
--
--   site.specification        one version of the specification of one material (or finished product code) at a site:
--                             insert-only; its tests are written with it in one command and never change. Versions
--                             count up per site and material.
--   site.specification_test   the tests of a version: test code, method, unit, decimal limits, whether the test is
--                             required for release, the source of the limit (IP, BP, PH_EUR, USP or IN_HOUSE) and its
--                             edition (IN-33: the reference is mandatory data), and the sample quantity one run of the
--                             test needs (the reserve-sample quantity is twice the sum, site-services 0843).
--   site.specification_approval  QA's or the head of QC's SPECIFICATION_APPROVED signature, never by the person who
--                             drafted it (the meaning excludes performers; the command checks it too). The approved
--                             version with the highest number is the one in effect (site.specification_in_effect);
--                             a version below the one in effect is never approved.
--   site.pharmacopoeia_edition  an edition of a pharmacopoeia marked effective from an instant by QA (IN-33 catalog
--                             test). site.specification_edition_review() lists every specification in effect with a
--                             limit citing an edition older than the one now effective for its pharmacopoeia, for a
--                             change-control review. (MBR IPC limits are recipe-core's and are not listed here.)
--
-- Default D-2b-1: a specification is per site and material code; a finished product's specification uses its product
-- code as the material code (its finished lots carry that code, 0842). Default D-2b-2: in-house methods cite their
-- document version as the edition.
-- Messages: EBMR-SITE-400 to EBMR-SITE-409.

set local role ebmr_owner;

create table site.specification (
  id                   uuid primary key default gen_random_uuid(),
  site_code            text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  material_code        text not null check (material_code ~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'),
  version              integer not null check (version >= 1),
  title                text not null check (btrim(title) <> '' and length(title) <= 200),
  monograph_reference  text not null check (btrim(monograph_reference) <> '' and length(monograph_reference) <= 200),
  drafted_by_person    uuid not null,
  drafted_by_account   uuid not null,
  drafted_at           timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null,
  unique (site_code, material_code, version)
);
revoke all on site.specification from public;

create table site.specification_test (
  id                   uuid primary key default gen_random_uuid(),
  specification_id     uuid not null references site.specification (id),
  test_code            text not null check (test_code ~ '^[A-Z0-9][A-Z0-9_.-]{0,39}$'),
  method_reference     text not null check (btrim(method_reference) <> '' and length(method_reference) <= 128),
  unit                 text not null check (unit ~ '^[!-~]{1,32}$'),
  lower_limit          numeric,
  upper_limit          numeric,
  required             boolean not null,
  pharmacopoeia        text not null check (pharmacopoeia in ('IP', 'BP', 'PH_EUR', 'USP', 'IN_HOUSE')),
  edition              text not null check (edition ~ '^[!-~][ -~]{0,31}$'),
  sample_quantity      numeric not null check (sample_quantity > 0),
  sample_unit          text not null check (sample_unit ~ '^[!-~]{1,32}$'),
  unique (specification_id, test_code),
  check (lower_limit is not null or upper_limit is not null),
  check (lower_limit is null or upper_limit is null or lower_limit <= upper_limit)
);
revoke all on site.specification_test from public;

create table site.specification_approval (
  specification_id     uuid primary key references site.specification (id),
  signature_id         uuid not null unique,
  approved_by_person   uuid not null,
  approved_by_account  uuid not null,
  approved_at          timestamptz not null default clock_timestamp()
);
revoke all on site.specification_approval from public;

create table site.pharmacopoeia_edition (
  id                   uuid primary key default gen_random_uuid(),
  pharmacopoeia        text not null check (pharmacopoeia in ('IP', 'BP', 'PH_EUR', 'USP')),
  edition              text not null check (edition ~ '^[!-~][ -~]{0,31}$'),
  effective_from       timestamptz not null,
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  unique (pharmacopoeia, edition)
);
revoke all on site.pharmacopoeia_edition from public;

select platform.enforce_db_time('site.specification', array['drafted_at']);
select platform.enforce_db_time('site.specification_approval', array['approved_at']);
select platform.enforce_db_time('site.pharmacopoeia_edition', array['recorded_at']);
select kernel.register_audited_table('site.specification', 'specification', 'id', true);
select kernel.register_audited_table('site.specification_test', 'specification', 'specification_id', true);
select kernel.register_audited_table('site.specification_approval', 'specification', 'specification_id', true);
select kernel.register_audited_table('site.pharmacopoeia_edition', 'pharmacopoeia_edition', 'id', true);

-- ---------------------------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------------------------

-- The approved version with the highest number for the material at the site, or NULL.
create function site.specification_in_effect(p_site text, p_material text) returns uuid
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select s.id from site.specification s join site.specification_approval a on a.specification_id = s.id
   where s.site_code = p_site and s.material_code = p_material
   order by s.version desc limit 1
$$;

-- DRAFT, APPROVED (in effect) or SUPERSEDED (approved, a higher version approved since).
create function site.specification_state(p_spec uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when not exists (select 1 from site.specification_approval a where a.specification_id = s.id) then 'DRAFT'
              when site.specification_in_effect(s.site_code, s.material_code) = s.id then 'APPROVED'
              else 'SUPERSEDED' end
  from site.specification s where s.id = p_spec
$$;

-- The test p_test of the specification in effect for lot p_lot's material at its site, or NULL.
create function site.lot_spec_test(p_lot uuid, p_test text) returns site.specification_test
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select t.* from site.material_lot l
    join site.specification_test t on t.specification_id = site.specification_in_effect(l.site_code, l.material_code)
   where l.id = p_lot and t.test_code = p_test
$$;

-- The specifications in effect with a limit citing a recorded edition older than the one effective now for its
-- pharmacopoeia (IN-33; an edition not recorded yet is never listed as older): [{specificationId, siteCode, materialCode, version, testCode, pharmacopoeia, cited, effective}].
create function site.specification_edition_review() returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  with current_edition as (
    select distinct on (e.pharmacopoeia) e.pharmacopoeia, e.edition, e.effective_from
      from site.pharmacopoeia_edition e where e.effective_from <= clock_timestamp()
     order by e.pharmacopoeia, e.effective_from desc, e.recorded_at desc
  )
  select coalesce(jsonb_agg(jsonb_build_object('specificationId', s.id, 'siteCode', s.site_code, 'materialCode', s.material_code,
                                               'version', s.version, 'testCode', t.test_code, 'pharmacopoeia', t.pharmacopoeia,
                                               'cited', t.edition, 'effective', c.edition)
                            order by s.site_code, s.material_code collate "C", t.test_code collate "C"), '[]'::jsonb)
    from site.specification s
    join site.specification_test t on t.specification_id = s.id
    join current_edition c on c.pharmacopoeia = t.pharmacopoeia and c.edition <> t.edition
    join site.pharmacopoeia_edition cited on cited.pharmacopoeia = t.pharmacopoeia and cited.edition = t.edition
   where site.specification_in_effect(s.site_code, s.material_code) = s.id
     and cited.effective_from < c.effective_from
$$;

-- ---------------------------------------------------------------------------------------------
-- Signed content: what SPECIFICATION_APPROVED covers
-- ---------------------------------------------------------------------------------------------

create function site.specification_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  s site.specification;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into s from site.specification where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object(
      'site_code', s.site_code, 'material_code', s.material_code, 'version', s.version, 'title', s.title,
      'monograph_reference', s.monograph_reference, 'drafted_by', s.drafted_by_person, 'drafted_at', site.utc_text(s.drafted_at),
      'tests', (select coalesce(jsonb_agg(jsonb_build_object('test_code', t.test_code, 'method_reference', t.method_reference, 'unit', t.unit,
                                                              'lower_limit', t.lower_limit::text, 'upper_limit', t.upper_limit::text,
                                                              'required', t.required, 'pharmacopoeia', t.pharmacopoeia, 'edition', t.edition,
                                                              'sample_quantity', t.sample_quantity::text, 'sample_unit', t.sample_unit)
                                           order by t.test_code collate "C"), '[]'::jsonb)
                from site.specification_test t where t.specification_id = s.id)),
    'state', site.specification_state(s.id),
    'scope', jsonb_build_object('site', s.site_code),
    'entered_by', jsonb_build_array(s.drafted_by_person));
end
$$;

select esig.register_content_provider('specification', 'site.specification_content(text)',
  'Specification of a material: its tests, limits, units, the pharmacopoeia and edition of each limit (IN-33)');

-- ---------------------------------------------------------------------------------------------
-- Permissions and the meaning
-- ---------------------------------------------------------------------------------------------

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0840_specifications)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'specifications with the pharmacopoeia and edition of every limit, their approval (IN-33, PR-45)'));

insert into iam.permission (code, domain, effect, description) values
  ('SPECIFICATION.DRAFT', 'GMP', 'WRITE', 'Draft a new version of a material''s specification: tests, limits, units, pharmacopoeia and edition (QC)'),
  ('SPECIFICATION.APPROVE', 'GMP', 'SIGN', 'Approve a specification version (never its drafter) and mark a pharmacopoeia edition effective (QA, head of QC)');

insert into iam.role_permission (role_code, permission_code) values
  ('QC_ANALYST', 'SPECIFICATION.DRAFT'),
  ('HEAD_OF_QC', 'SPECIFICATION.DRAFT'),
  ('HEAD_OF_QC', 'SPECIFICATION.APPROVE'),
  ('QA_REVIEWER', 'SPECIFICATION.APPROVE');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('SPECIFICATION_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'LABORATORY', 'APPROVER', 'Specification approved',
   'I approve this specification: its tests, limits and units, and the pharmacopoeia and edition each limit cites, as shown.',
   array['SPECIFICATION.APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'IN-33; PR-45; outline 5.2.9; US 211.160; EU Ch.4 4.13');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------------------------

-- p: {materialCode, title, monographReference, tests: [{testCode, methodReference, unit, lowerLimit?, upperLimit?
-- (decimals as text), required (boolean), pharmacopoeia, edition, sampleQuantity (decimal text), sampleUnit}]}.
-- Returns {specificationId, version}.
create function site.draft_specification(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v_site text;
  v_mat  text;
  v_id   uuid;
  v_ver  integer;
  t      jsonb;
  m      text;
begin
  perform iam.assert_not_administrator();
  v_site := site.actor_site();
  perform iam.require_permission('SPECIFICATION.DRAFT', jsonb_build_object('site', v_site));
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'tests') is distinct from 'array' or jsonb_array_length(p -> 'tests') = 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-400 a specification names its material, title, monograph reference and at least one test (IN-33)';
  end if;
  v_mat := p ->> 'materialCode';
  if site.erp_material_current(v_mat) is null and not exists (select 1 from site.erp_product e where e.product_code = v_mat) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-400 %s is neither a material of the ERP material master nor a product of the product master (PR-17)', coalesce(v_mat, 'NULL'));
  end if;
  for t in select x from jsonb_array_elements(p -> 'tests') x loop
    if jsonb_typeof(t) <> 'object' then
      raise exception using errcode = 'P0001', message = 'EBMR-SITE-401 each test of a specification is an object';
    end if;
    foreach m in array array['lowerLimit', 'upperLimit', 'sampleQuantity'] loop
      if t ? m and (jsonb_typeof(t -> m) is distinct from 'string' or (t ->> m) !~ '^-?(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$') then
        raise exception using errcode = 'P0001', message = format('EBMR-SITE-401 the %s of a test is an exact decimal written as text, e.g. "98.0"', m);
      end if;
    end loop;
    if not (t ? 'lowerLimit' or t ? 'upperLimit') or not (t ? 'sampleQuantity') or jsonb_typeof(t -> 'required') is distinct from 'boolean' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-401 test %s states at least one limit, whether it is required for release and the sample quantity one run needs', coalesce(t ->> 'testCode', 'NULL'));
    end if;
    if coalesce(t ->> 'pharmacopoeia', '') = '' or coalesce(btrim(t ->> 'edition'), '') = '' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-SITE-402 test %s cites the source of its limit (IP, BP, PH_EUR, USP or IN_HOUSE) and its edition (IN-33)', coalesce(t ->> 'testCode', 'NULL'));
    end if;
  end loop;
  perform pg_advisory_xact_lock(hashtext('site.specification'), hashtext(v_site || '/' || v_mat));
  select coalesce(max(s.version), 0) + 1 into v_ver from site.specification s where s.site_code = v_site and s.material_code = v_mat;
  insert into site.specification (site_code, material_code, version, title, monograph_reference, drafted_by_person, drafted_by_account, correlation_id)
  values (v_site, v_mat, v_ver, p ->> 'title', p ->> 'monographReference', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid,
          (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  insert into site.specification_test (specification_id, test_code, method_reference, unit, lower_limit, upper_limit, required, pharmacopoeia, edition,
                                       sample_quantity, sample_unit)
  select v_id, x.e ->> 'testCode', x.e ->> 'methodReference', x.e ->> 'unit', (x.e ->> 'lowerLimit')::numeric, (x.e ->> 'upperLimit')::numeric,
         (x.e ->> 'required')::boolean, x.e ->> 'pharmacopoeia', btrim(x.e ->> 'edition'), (x.e ->> 'sampleQuantity')::numeric, x.e ->> 'sampleUnit'
    from jsonb_array_elements(p -> 'tests') x (e);
  return jsonb_build_object('specificationId', v_id, 'version', v_ver);
end
$$;

create function site.approve_specification(p_spec uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, esig, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  s      site.specification;
  v_cur  uuid;
  v_prob text;
begin
  perform iam.assert_not_administrator();
  select * into s from site.specification where id = p_spec;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-403 unknown specification %s', p_spec);
  end if;
  perform iam.require_permission('SPECIFICATION.APPROVE', jsonb_build_object('site', s.site_code));
  perform pg_advisory_xact_lock(hashtext('site.specification'), hashtext(s.site_code || '/' || s.material_code));
  if exists (select 1 from site.specification_approval a where a.specification_id = s.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-403 version %s of the specification of %s is already approved', s.version, s.material_code);
  end if;
  v_cur := site.specification_in_effect(s.site_code, s.material_code);
  if v_cur is not null and (select c.version from site.specification c where c.id = v_cur) > s.version then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-404 version %s of the specification of %s is below the version in effect; only a newer version is approved (IN-33)', s.version, s.material_code);
  end if;
  if s.drafted_by_person::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-405 a specification is approved by another person than its drafter (DI-35; IN-33)';
  end if;
  perform esig.assert_signature(p_signature, 'SPECIFICATION_APPROVED', 'specification', s.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-405 ' || v_prob;
  end if;
  if (select g.signer_person from esig.signature g where g.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-405 the approval is recorded by the person who signed it';
  end if;
  insert into site.specification_approval (specification_id, signature_id, approved_by_person, approved_by_account)
  values (s.id, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- QA marks an edition of a pharmacopoeia effective from an instant (IN-33). Returns the record's id.
create function site.mark_edition_effective(p_pharmacopoeia text, p_edition text, p_effective_from timestamptz) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('SPECIFICATION.APPROVE', jsonb_build_object('site', site.actor_site()));
  if p_pharmacopoeia is null or p_pharmacopoeia not in ('IP', 'BP', 'PH_EUR', 'USP') or coalesce(btrim(p_edition), '') = '' or p_effective_from is null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-406 an edition names its pharmacopoeia (IP, BP, PH_EUR, USP), the edition and the instant it takes effect (IN-33)';
  end if;
  if exists (select 1 from site.pharmacopoeia_edition e where e.pharmacopoeia = p_pharmacopoeia and e.edition = btrim(p_edition)) then
    raise exception using errcode = 'P0001', message = format('EBMR-SITE-406 %s %s is already recorded', p_pharmacopoeia, btrim(p_edition));
  end if;
  insert into site.pharmacopoeia_edition (pharmacopoeia, edition, effective_from, recorded_by_person, recorded_by_account)
  values (p_pharmacopoeia, btrim(p_edition), p_effective_from, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

revoke all on site.specification, site.specification_test, site.specification_approval, site.pharmacopoeia_edition from ebmr_app;
grant select on site.specification, site.specification_test, site.specification_approval, site.pharmacopoeia_edition to ebmr_app;
grant execute on function site.draft_specification(jsonb), site.approve_specification(uuid, uuid), site.mark_edition_effective(text, text, timestamptz),
                          site.specification_in_effect(text, text), site.specification_state(uuid), site.specification_edition_review() to ebmr_app;

reset role;
