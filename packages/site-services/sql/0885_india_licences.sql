-- India: manufacturing licences, loan licences and export permissions (Phase 4 slice 6a; plan "Slice 6", defaults D-6-1,
-- D-6-2, D-6a-1 to D-6a-4; controls IN-30, IN-31; ADR 0012: every rule holds when the application's own database
-- credentials are used directly).
--
--   site.manufacturing_licence   a licence of the site as the licensing authority granted it, insert-only:
--                                MANUFACTURING (Form 25, or Form 28 for the products of Schedule C and C1) or LOAN
--                                (Form 25A or 28A: a loan licensee's licence to have its products made on the site's
--                                premises, under the host's manufacturing licence and a technical agreement it names).
--                                Valid from an instant; valid until an instant or open-ended (a licence kept in force by
--                                its retention fee has no end date, D-6a-2).
--   site.licence_product         the products and strengths the licence endorses (a loan licence names those it may have
--                                made on the site). Written with the licence in one command and never changed: a new
--                                endorsement is a new licence record (the authority's endorsement is a new document).
--   site.licence_approval        QA's LICENCE_APPROVED signature over the licence as recorded, never by its recorder (the
--                                meaning excludes performers; the command checks it too). Only an approved licence counts.
--   site.licence_suspension      QA records that the authority suspended or cancelled a licence, with the reason; it no
--                                longer counts from that instant. A licence lapses at its end instant without a record.
--   site.export_permission       the export permission (NOC) of one product and strength for one destination, with its
--                                number, the authority that granted it and its validity window (D-6-2); approved by QA
--                                (EXPORT_PERMISSION_APPROVED), suspended like a licence. The destination is a market code
--                                of the release model (US, EU) or a country code (D-6a-1).
--
-- Readers (the gates of recipe-core 0890 and 0891 call them):
--   site.licence_basis(site, product, strength, at)  the licence a batch made at the site at that instant is made
--       under: a current LOAN licence of the site endorsing the product whose host MANUFACTURING licence is itself current
--       (the record then carries both numbers, IN-30), else a current MANUFACTURING licence endorsing the product; NULL
--       when none (D-6-1). "Current": approved, not suspended at the instant, within its validity window.
--   site.licence_problem(site, product, strength, at)  NULL when a basis exists, else why not in plain words.
--   site.export_permission_problem(site, product, strength, destination, at)  NULL when a current permission exists.
--
-- Signed aggregates: manufacturing_licence <licence id> (LICENCE_APPROVED), export_permission <permission id>
-- (EXPORT_PERMISSION_APPROVED); content state DRAFT, APPROVED or SUSPENDED. The tablets preview mapping of both names is
-- added by builder 6c (tablets 1198), as fixed in the plan.
-- Messages: EBMR-IND-001 to EBMR-IND-029.

set local role ebmr_owner;

create table site.manufacturing_licence (
  id                      uuid primary key default gen_random_uuid(),
  site_code               text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  licence_kind            text not null check (licence_kind in ('MANUFACTURING', 'LOAN')),
  form                    text not null check (form in ('25', '28', '25A', '28A')),
  licence_number          text not null unique check (licence_number ~ '^[A-Za-z0-9][A-Za-z0-9/._ -]{0,63}$'),
  holder_name             text not null check (btrim(holder_name) <> '' and length(holder_name) <= 200 and holder_name !~ '[;=]'),
  holder_address          text not null check (btrim(holder_address) <> '' and length(holder_address) <= 400 and holder_address !~ '[;=]'),
  host_licence_id         uuid references site.manufacturing_licence (id),
  technical_agreement_ref text check (technical_agreement_ref is null or (btrim(technical_agreement_ref) <> '' and length(technical_agreement_ref) <= 200)),
  valid_from              timestamptz not null,
  valid_until             timestamptz,
  recorded_by_person      uuid not null,
  recorded_by_account     uuid not null,
  recorded_at             timestamptz not null default clock_timestamp(),
  correlation_id          uuid not null,
  check (valid_until is null or valid_from < valid_until),
  check ((licence_kind = 'MANUFACTURING') = (form in ('25', '28'))),
  check ((licence_kind = 'LOAN') = (host_licence_id is not null)),
  check ((licence_kind = 'LOAN') = (technical_agreement_ref is not null))
);
revoke all on site.manufacturing_licence from public;

create table site.licence_product (
  licence_id    uuid not null references site.manufacturing_licence (id),
  product_code  text not null check (product_code ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  strength      text not null check (btrim(strength) <> '' and length(strength) <= 64),
  primary key (licence_id, product_code, strength)
);
revoke all on site.licence_product from public;

create table site.licence_approval (
  licence_id           uuid primary key references site.manufacturing_licence (id),
  signature_id         uuid not null unique,
  approved_by_person   uuid not null,
  approved_by_account  uuid not null,
  approved_at          timestamptz not null default clock_timestamp()
);
revoke all on site.licence_approval from public;

create table site.licence_suspension (
  licence_id            uuid primary key references site.manufacturing_licence (id),
  reason_text           text not null check (btrim(reason_text) <> '' and length(reason_text) <= 2000),
  suspended_by_person   uuid not null,
  suspended_by_account  uuid not null,
  suspended_at          timestamptz not null default clock_timestamp()
);
revoke all on site.licence_suspension from public;

create table site.export_permission (
  id                   uuid primary key default gen_random_uuid(),
  site_code            text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  product_code         text not null check (product_code ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  strength             text not null check (btrim(strength) <> '' and length(strength) <= 64),
  destination          text not null check (destination ~ '^[A-Z]{2}$' and destination <> 'IN'),
  permission_number    text not null unique check (permission_number ~ '^[A-Za-z0-9][A-Za-z0-9/._ -]{0,63}$'),
  issuing_authority    text not null check (btrim(issuing_authority) <> '' and length(issuing_authority) <= 200),
  valid_from           timestamptz not null,
  valid_until          timestamptz not null,
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null,
  check (valid_from < valid_until)
);
revoke all on site.export_permission from public;

create table site.export_permission_approval (
  permission_id        uuid primary key references site.export_permission (id),
  signature_id         uuid not null unique,
  approved_by_person   uuid not null,
  approved_by_account  uuid not null,
  approved_at          timestamptz not null default clock_timestamp()
);
revoke all on site.export_permission_approval from public;

create table site.export_permission_suspension (
  permission_id         uuid primary key references site.export_permission (id),
  reason_text           text not null check (btrim(reason_text) <> '' and length(reason_text) <= 2000),
  suspended_by_person   uuid not null,
  suspended_by_account  uuid not null,
  suspended_at          timestamptz not null default clock_timestamp()
);
revoke all on site.export_permission_suspension from public;

select platform.enforce_db_time('site.manufacturing_licence', array['recorded_at']);
select platform.enforce_db_time('site.licence_approval', array['approved_at']);
select platform.enforce_db_time('site.licence_suspension', array['suspended_at']);
select platform.enforce_db_time('site.export_permission', array['recorded_at']);
select platform.enforce_db_time('site.export_permission_approval', array['approved_at']);
select platform.enforce_db_time('site.export_permission_suspension', array['suspended_at']);
select kernel.register_audited_table('site.manufacturing_licence', 'manufacturing_licence', 'id', true);
select kernel.register_audited_table('site.licence_product', 'manufacturing_licence', 'licence_id', true);
select kernel.register_audited_table('site.licence_approval', 'manufacturing_licence', 'licence_id', true);
select kernel.register_audited_table('site.licence_suspension', 'manufacturing_licence', 'licence_id', true);
select kernel.register_audited_table('site.export_permission', 'export_permission', 'id', true);
select kernel.register_audited_table('site.export_permission_approval', 'export_permission', 'permission_id', true);
select kernel.register_audited_table('site.export_permission_suspension', 'export_permission', 'permission_id', true);

-- Insert-only: no writer ever changes or removes a licence, an endorsement, an approval, a suspension or a permission
-- (the owner included; a correction is a new record).
create function site.india_record_immutable() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception using errcode = 'P0001', message = format('EBMR-IND-001 %s is insert-only: a licence or permission record is never changed or removed (IN-30, DI-22)', tg_table_name);
end
$$;
create trigger zz_immutable before update or delete on site.manufacturing_licence for each row execute function site.india_record_immutable();
create trigger zz_immutable before update or delete on site.licence_product for each row execute function site.india_record_immutable();
create trigger zz_immutable before update or delete on site.licence_approval for each row execute function site.india_record_immutable();
create trigger zz_immutable before update or delete on site.licence_suspension for each row execute function site.india_record_immutable();
create trigger zz_immutable before update or delete on site.export_permission for each row execute function site.india_record_immutable();
create trigger zz_immutable before update or delete on site.export_permission_approval for each row execute function site.india_record_immutable();
create trigger zz_immutable before update or delete on site.export_permission_suspension for each row execute function site.india_record_immutable();

-- ---------------------------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------------------------

-- DRAFT, APPROVED or SUSPENDED (a lapsed licence stays APPROVED: lapse is a matter of the instant, site.licence_current).
create function site.licence_state(p_licence uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when exists (select 1 from site.licence_suspension s where s.licence_id = l.id) then 'SUSPENDED'
              when exists (select 1 from site.licence_approval a where a.licence_id = l.id) then 'APPROVED'
              else 'DRAFT' end
    from site.manufacturing_licence l where l.id = p_licence
$$;

-- Whether licence p_licence counts at instant p_at: approved, not suspended at p_at, within its validity window.
create function site.licence_current(p_licence uuid, p_at timestamptz) returns boolean
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select coalesce((
    select exists (select 1 from site.licence_approval a where a.licence_id = l.id and a.approved_at <= p_at)
       and not exists (select 1 from site.licence_suspension s where s.licence_id = l.id and s.suspended_at <= p_at)
       and l.valid_from <= p_at and (l.valid_until is null or p_at < l.valid_until)
      from site.manufacturing_licence l where l.id = p_licence), false)
$$;

-- The licence basis of a batch of p_product, p_strength made at site p_site at instant p_at (header), or NULL:
-- {licenceId, licenceNumber, form, holderName, holderAddress, loanLicenceId?, loanLicenceNumber?, loanForm?,
--  loanHolderName?, loanHolderAddress?, technicalAgreement?}.
create function site.licence_basis(p_site text, p_product text, p_strength text, p_at timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  ln site.manufacturing_licence;
  h  site.manufacturing_licence;
begin
  if p_site is null or p_product is null or p_strength is null or p_at is null then
    return null;
  end if;
  -- A loan licence of the site naming the product, under a current host licence of the same site (IN-30, D-6-1).
  select l.* into ln from site.manufacturing_licence l
    join site.licence_product p on p.licence_id = l.id and p.product_code = p_product and p.strength = p_strength
    join site.manufacturing_licence hl on hl.id = l.host_licence_id and hl.site_code = l.site_code and hl.licence_kind = 'MANUFACTURING'
   where l.site_code = p_site and l.licence_kind = 'LOAN' and site.licence_current(l.id, p_at) and site.licence_current(hl.id, p_at)
   order by l.valid_from desc, l.recorded_at desc, l.id limit 1;
  if ln.id is not null then
    select * into h from site.manufacturing_licence where id = ln.host_licence_id;
    return jsonb_build_object('licenceId', h.id, 'licenceNumber', h.licence_number, 'form', h.form, 'holderName', h.holder_name, 'holderAddress', h.holder_address,
                              'loanLicenceId', ln.id, 'loanLicenceNumber', ln.licence_number, 'loanForm', ln.form, 'loanHolderName', ln.holder_name,
                              'loanHolderAddress', ln.holder_address, 'technicalAgreement', ln.technical_agreement_ref);
  end if;
  select l.* into h from site.manufacturing_licence l
    join site.licence_product p on p.licence_id = l.id and p.product_code = p_product and p.strength = p_strength
   where l.site_code = p_site and l.licence_kind = 'MANUFACTURING' and site.licence_current(l.id, p_at)
   order by l.valid_from desc, l.recorded_at desc, l.id limit 1;
  if h.id is null then
    return null;
  end if;
  return jsonb_build_object('licenceId', h.id, 'licenceNumber', h.licence_number, 'form', h.form, 'holderName', h.holder_name, 'holderAddress', h.holder_address);
end
$$;

-- NULL when a batch of p_product, p_strength may be made at site p_site at p_at under a licence, else why not (D-6-1).
create function site.licence_problem(p_site text, p_product text, p_strength text, p_at timestamptz) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l site.manufacturing_licence;
begin
  if site.licence_basis(p_site, p_product, p_strength, p_at) is not null then
    return null;
  end if;
  -- The latest licence recorded for the product at the site, to say why it does not count.
  select x.* into l from site.manufacturing_licence x
    join site.licence_product p on p.licence_id = x.id and p.product_code = p_product and p.strength = p_strength
   where x.site_code = p_site
   order by x.recorded_at desc, x.id desc limit 1;
  if l.id is null then
    return format('no manufacturing licence (Form 25 or 28) or loan licence of site %s endorses %s %s (IN-30, D-6-1)', p_site, p_product, p_strength);
  end if;
  return format('licence %s (Form %s) endorsing %s %s does not count at %s: %s (IN-30, D-6-1)', l.licence_number, l.form, p_product, p_strength,
                site.utc_text(p_at),
                case
                  when site.licence_state(l.id) = 'DRAFT' then 'it is not approved by QA'
                  when site.licence_state(l.id) = 'SUSPENDED' then 'it is suspended or cancelled'
                  when p_at < l.valid_from then 'it is valid only from ' || site.utc_text(l.valid_from)
                  when l.valid_until is not null and p_at >= l.valid_until then 'it lapsed at ' || site.utc_text(l.valid_until)
                  when l.licence_kind = 'LOAN' then 'its host manufacturing licence does not count'
                  else 'it is not current'
                end);
end
$$;

create function site.export_permission_state(p_permission uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case when exists (select 1 from site.export_permission_suspension s where s.permission_id = e.id) then 'SUSPENDED'
              when exists (select 1 from site.export_permission_approval a where a.permission_id = e.id) then 'APPROVED'
              else 'DRAFT' end
    from site.export_permission e where e.id = p_permission
$$;

-- The export permission in force for p_product, p_strength from site p_site to p_destination at p_at, or NULL (D-6-2).
create function site.export_permission_current(p_site text, p_product text, p_strength text, p_destination text, p_at timestamptz) returns uuid
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select e.id from site.export_permission e
   where e.site_code = p_site and e.product_code = p_product and e.strength = p_strength and e.destination = p_destination
     and e.valid_from <= p_at and p_at < e.valid_until
     and exists (select 1 from site.export_permission_approval a where a.permission_id = e.id and a.approved_at <= p_at)
     and not exists (select 1 from site.export_permission_suspension s where s.permission_id = e.id and s.suspended_at <= p_at)
   order by e.valid_until desc, e.id limit 1
$$;

create function site.export_permission_problem(p_site text, p_product text, p_strength text, p_destination text, p_at timestamptz) returns text
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  e site.export_permission;
begin
  if p_destination = 'IN' then
    return null;
  end if;
  if site.export_permission_current(p_site, p_product, p_strength, p_destination, p_at) is not null then
    return null;
  end if;
  select x.* into e from site.export_permission x
   where x.site_code = p_site and x.product_code = p_product and x.strength = p_strength and x.destination = p_destination
   order by x.recorded_at desc, x.id desc limit 1;
  if e.id is null then
    return format('no export permission of site %s covers %s %s for %s (D-6-2)', p_site, p_product, p_strength, coalesce(p_destination, 'NULL'));
  end if;
  return format('export permission %s for %s %s to %s does not count at %s: %s (D-6-2)', e.permission_number, p_product, p_strength, p_destination,
                site.utc_text(p_at),
                case
                  when site.export_permission_state(e.id) = 'DRAFT' then 'it is not approved by QA'
                  when site.export_permission_state(e.id) = 'SUSPENDED' then 'it is suspended or withdrawn'
                  when p_at < e.valid_from then 'it is valid only from ' || site.utc_text(e.valid_from)
                  else 'it lapsed at ' || site.utc_text(e.valid_until)
                end);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Signed content
-- ---------------------------------------------------------------------------------------------

create function site.manufacturing_licence_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  l site.manufacturing_licence;
  h site.manufacturing_licence;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into l from site.manufacturing_licence where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  select * into h from site.manufacturing_licence where id = l.host_licence_id;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object(
      'site_code', l.site_code, 'licence_kind', l.licence_kind, 'form', l.form, 'licence_number', l.licence_number,
      'holder_name', l.holder_name, 'holder_address', l.holder_address,
      'host_licence_number', h.licence_number, 'technical_agreement', l.technical_agreement_ref,
      'valid_from', site.utc_text(l.valid_from), 'valid_until', site.utc_text(l.valid_until),
      'recorded_by', l.recorded_by_person, 'recorded_at', site.utc_text(l.recorded_at),
      'products', (select coalesce(jsonb_agg(jsonb_build_object('product_code', p.product_code, 'strength', p.strength)
                                             order by p.product_code collate "C", p.strength collate "C"), '[]'::jsonb)
                     from site.licence_product p where p.licence_id = l.id)),
    'state', site.licence_state(l.id),
    'scope', jsonb_build_object('site', l.site_code),
    'entered_by', jsonb_build_array(l.recorded_by_person));
end
$$;

create function site.export_permission_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  e site.export_permission;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into e from site.export_permission where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object(
      'site_code', e.site_code, 'product_code', e.product_code, 'strength', e.strength, 'destination', e.destination,
      'permission_number', e.permission_number, 'issuing_authority', e.issuing_authority,
      'valid_from', site.utc_text(e.valid_from), 'valid_until', site.utc_text(e.valid_until),
      'recorded_by', e.recorded_by_person, 'recorded_at', site.utc_text(e.recorded_at)),
    'state', site.export_permission_state(e.id),
    'scope', jsonb_build_object('site', e.site_code, 'product', e.product_code),
    'entered_by', jsonb_build_array(e.recorded_by_person));
end
$$;

select esig.register_content_provider('manufacturing_licence', 'site.manufacturing_licence_content(text)',
  'Manufacturing or loan licence of the site: form, number, holder, host licence and technical agreement, validity and endorsed products (IN-30)');
select esig.register_content_provider('export_permission', 'site.export_permission_content(text)',
  'Export permission of one product and strength for one destination: number, authority and validity (D-6-2)');

-- ---------------------------------------------------------------------------------------------
-- Permissions and meanings
-- ---------------------------------------------------------------------------------------------

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0885_india_licences)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'manufacturing and loan licences, export permissions and their QA approval (IN-30, D-6-1, D-6-2)'));

insert into iam.permission (code, domain, effect, description) values
  ('LICENCE.RECORD', 'GMP', 'WRITE', 'Record a manufacturing or loan licence, or an export permission, as the authority granted it (regulatory affairs)'),
  ('LICENCE.APPROVE', 'GMP', 'SIGN', 'Approve a recorded licence or export permission (never its recorder) and record its suspension or cancellation (QA)');

insert into iam.role_permission (role_code, permission_code) values
  ('REGULATORY_SIGNER', 'LICENCE.RECORD'),
  ('QA_MBR_APPROVER', 'LICENCE.APPROVE'),
  ('QA_REVIEWER', 'LICENCE.APPROVE');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('LICENCE_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'MASTER_RECORD', 'APPROVER', 'Licence approved',
   'I confirm this licence as the licensing authority granted it: form, number, holder, validity and the products it endorses, as shown.',
   array['LICENCE.APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'IN-30; D-6-1; Schedule M Part I 9 (loan licence and contract production)'),
  ('EXPORT_PERMISSION_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'MASTER_RECORD', 'APPROVER', 'Export permission approved',
   'I confirm this export permission as granted: product, strength, destination, number and validity, as shown.',
   array['LICENCE.APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false, 'D-6-2; IN-30');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------------------------

create function site.india_instant(p jsonb, p_key text, p_required boolean) returns timestamptz
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  if p ->> p_key is null then
    if p_required then
      raise exception using errcode = 'P0001', message = format('EBMR-IND-002 %s is required (an ISO 8601 instant with its offset)', p_key);
    end if;
    return null;
  end if;
  if jsonb_typeof(p -> p_key) <> 'string' or (p ->> p_key) !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$' then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-002 %s is an ISO 8601 instant with its offset', p_key);
  end if;
  return (p ->> p_key)::timestamptz;
end
$$;

-- p: {licenceKind MANUFACTURING|LOAN, form, licenceNumber, holderName, holderAddress, hostLicenceId? (LOAN),
--     technicalAgreement? (LOAN), validFrom, validUntil?, products: [{productCode, strength}]}. Returns the licence id.
-- LICENCE.RECORD at the session's site, never an administrator.
create function site.record_manufacturing_licence(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx   jsonb := site.require_actor();
  v_site  text;
  v_id    uuid;
  v_host  site.manufacturing_licence;
  v_kind  text;
  x       jsonb;
begin
  perform iam.assert_not_administrator();
  v_site := site.actor_site();
  perform iam.require_permission('LICENCE.RECORD', jsonb_build_object('site', v_site));
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'products') is distinct from 'array' or jsonb_array_length(p -> 'products') = 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-003 a licence names its kind, form, number, holder, validity and at least one endorsed product (IN-30)';
  end if;
  v_kind := p ->> 'licenceKind';
  if v_kind is null or v_kind not in ('MANUFACTURING', 'LOAN') then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-003 a licence is a MANUFACTURING licence (Form 25 or 28) or a LOAN licence (Form 25A or 28A)';
  end if;
  if (v_kind = 'MANUFACTURING' and coalesce(p ->> 'form', '') not in ('25', '28')) or (v_kind = 'LOAN' and coalesce(p ->> 'form', '') not in ('25A', '28A')) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-IND-004 a %s licence is on Form %s, not %s (IN-30)', lower(v_kind), case v_kind when 'LOAN' then '25A or 28A' else '25 or 28' end, coalesce(p ->> 'form', 'none'));
  end if;
  if v_kind = 'LOAN' then
    if coalesce(btrim(p ->> 'technicalAgreement'), '') = '' or p ->> 'hostLicenceId' is null then
      raise exception using errcode = 'P0001', message = 'EBMR-IND-005 a loan licence names the host manufacturing licence and the technical agreement with the host (IN-30, D-6-1)';
    end if;
    if (p ->> 'hostLicenceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode = 'P0001', message = 'EBMR-IND-005 the host licence is named by its id';
    end if;
    select * into v_host from site.manufacturing_licence where id = (p ->> 'hostLicenceId')::uuid;
    if v_host.id is null or v_host.licence_kind <> 'MANUFACTURING' or v_host.site_code <> v_site or site.licence_state(v_host.id) <> 'APPROVED' then
      raise exception using errcode = 'P0001',
        message = 'EBMR-IND-005 the host licence of a loan licence is an approved, not suspended manufacturing licence of the same site (IN-30)';
    end if;
  elsif p ? 'hostLicenceId' or p ? 'technicalAgreement' then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-005 only a loan licence names a host licence and a technical agreement';
  end if;
  for x in select e from jsonb_array_elements(p -> 'products') e loop
    if jsonb_typeof(x) <> 'object' or coalesce(x ->> 'productCode', '') !~ '^[A-Z0-9][A-Z0-9._-]{0,63}$' or coalesce(btrim(x ->> 'strength'), '') = '' then
      raise exception using errcode = 'P0001', message = 'EBMR-IND-006 each endorsed product names its product code and strength (IN-30)';
    end if;
  end loop;
  begin
    insert into site.manufacturing_licence (site_code, licence_kind, form, licence_number, holder_name, holder_address, host_licence_id,
                                            technical_agreement_ref, valid_from, valid_until, recorded_by_person, recorded_by_account, correlation_id)
    values (v_site, v_kind, p ->> 'form', btrim(p ->> 'licenceNumber'), btrim(p ->> 'holderName'), btrim(p ->> 'holderAddress'), v_host.id,
            nullif(btrim(p ->> 'technicalAgreement'), ''), site.india_instant(p, 'validFrom', true), site.india_instant(p, 'validUntil', false),
            (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = format('EBMR-IND-007 licence number %s is recorded already', btrim(p ->> 'licenceNumber'));
    when check_violation or not_null_violation then
      raise exception using errcode = 'P0001',
        message = 'EBMR-IND-003 the licence is incomplete: number, holder name and address (without ; or =), and a validity that ends after it starts (IN-30)';
  end;
  insert into site.licence_product (licence_id, product_code, strength)
  select distinct v_id, e ->> 'productCode', btrim(e ->> 'strength') from jsonb_array_elements(p -> 'products') e;
  return v_id;
end
$$;

-- QA approves licence p_licence under its own LICENCE_APPROVED signature (never the recorder).
create function site.approve_manufacturing_licence(p_licence uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, esig, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  l      site.manufacturing_licence;
  v_prob text;
begin
  perform iam.assert_not_administrator();
  select * into l from site.manufacturing_licence where id = p_licence;
  if l.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-008 unknown licence %s', coalesce(p_licence::text, 'NULL'));
  end if;
  perform iam.require_permission('LICENCE.APPROVE', jsonb_build_object('site', l.site_code));
  perform pg_advisory_xact_lock(hashtext('site.manufacturing_licence'), hashtext(l.id::text));
  if site.licence_state(l.id) <> 'DRAFT' then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-009 licence %s is %s; a licence is approved once', l.licence_number, site.licence_state(l.id));
  end if;
  if l.recorded_by_person::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-010 a licence is approved by another person than its recorder (IN-30, DI-35)';
  end if;
  if l.licence_kind = 'LOAN' and site.licence_state(l.host_licence_id) <> 'APPROVED' then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-005 the host licence of this loan licence is no longer approved (IN-30)';
  end if;
  perform esig.assert_signature(p_signature, 'LICENCE_APPROVED', 'manufacturing_licence', l.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-011 ' || v_prob;
  end if;
  if (select g.signer_person from esig.signature g where g.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-011 the approval is recorded by the person who signed it';
  end if;
  insert into site.licence_approval (licence_id, signature_id, approved_by_person, approved_by_account)
  values (l.id, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- QA records that the authority suspended or cancelled licence p_licence (from now; batches already issued are not
-- affected, D-6-1).
create function site.suspend_manufacturing_licence(p_licence uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  l     site.manufacturing_licence;
begin
  perform iam.assert_not_administrator();
  select * into l from site.manufacturing_licence where id = p_licence;
  if l.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-008 unknown licence %s', coalesce(p_licence::text, 'NULL'));
  end if;
  perform iam.require_permission('LICENCE.APPROVE', jsonb_build_object('site', l.site_code));
  perform pg_advisory_xact_lock(hashtext('site.manufacturing_licence'), hashtext(l.id::text));
  if site.licence_state(l.id) <> 'APPROVED' then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-012 licence %s is %s; only an approved licence is suspended', l.licence_number, site.licence_state(l.id));
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-012 a suspension states its reason (the authority''s order)';
  end if;
  insert into site.licence_suspension (licence_id, reason_text, suspended_by_person, suspended_by_account)
  values (l.id, btrim(p_reason), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- p: {productCode, strength, destination, permissionNumber, issuingAuthority, validFrom, validUntil}. Returns the id.
create function site.record_export_permission(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v_site text;
  v_id   uuid;
begin
  perform iam.assert_not_administrator();
  v_site := site.actor_site();
  perform iam.require_permission('LICENCE.RECORD', jsonb_build_object('site', v_site));
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-013 an export permission names its product, strength, destination, number, authority and validity (D-6-2)';
  end if;
  if coalesce(p ->> 'destination', '') !~ '^[A-Z]{2}$' or p ->> 'destination' = 'IN' then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-013 the destination of an export permission is a market or country code other than IN (D-6a-1)';
  end if;
  begin
    insert into site.export_permission (site_code, product_code, strength, destination, permission_number, issuing_authority, valid_from, valid_until,
                                        recorded_by_person, recorded_by_account, correlation_id)
    values (v_site, p ->> 'productCode', btrim(p ->> 'strength'), p ->> 'destination', btrim(p ->> 'permissionNumber'), btrim(p ->> 'issuingAuthority'),
            site.india_instant(p, 'validFrom', true), site.india_instant(p, 'validUntil', true),
            (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = format('EBMR-IND-014 export permission %s is recorded already', btrim(p ->> 'permissionNumber'));
    when check_violation or not_null_violation then
      raise exception using errcode = 'P0001',
        message = 'EBMR-IND-013 the export permission is incomplete: product code, strength, number, authority and a validity that ends after it starts (D-6-2)';
  end;
  return v_id;
end
$$;

create function site.approve_export_permission(p_permission uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, esig, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  e      site.export_permission;
  v_prob text;
begin
  perform iam.assert_not_administrator();
  select * into e from site.export_permission where id = p_permission;
  if e.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-015 unknown export permission %s', coalesce(p_permission::text, 'NULL'));
  end if;
  perform iam.require_permission('LICENCE.APPROVE', jsonb_build_object('site', e.site_code));
  perform pg_advisory_xact_lock(hashtext('site.export_permission'), hashtext(e.id::text));
  if site.export_permission_state(e.id) <> 'DRAFT' then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-016 export permission %s is %s; it is approved once', e.permission_number, site.export_permission_state(e.id));
  end if;
  if e.recorded_by_person::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-017 an export permission is approved by another person than its recorder (D-6-2, DI-35)';
  end if;
  perform esig.assert_signature(p_signature, 'EXPORT_PERMISSION_APPROVED', 'export_permission', e.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-018 ' || v_prob;
  end if;
  if (select g.signer_person from esig.signature g where g.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-018 the approval is recorded by the person who signed it';
  end if;
  insert into site.export_permission_approval (permission_id, signature_id, approved_by_person, approved_by_account)
  values (e.id, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

create function site.suspend_export_permission(p_permission uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  e     site.export_permission;
begin
  perform iam.assert_not_administrator();
  select * into e from site.export_permission where id = p_permission;
  if e.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-015 unknown export permission %s', coalesce(p_permission::text, 'NULL'));
  end if;
  perform iam.require_permission('LICENCE.APPROVE', jsonb_build_object('site', e.site_code));
  perform pg_advisory_xact_lock(hashtext('site.export_permission'), hashtext(e.id::text));
  if site.export_permission_state(e.id) <> 'APPROVED' then
    raise exception using errcode = 'P0001', message = format('EBMR-IND-019 export permission %s is %s; only an approved permission is suspended', e.permission_number, site.export_permission_state(e.id));
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-IND-019 a suspension states its reason';
  end if;
  insert into site.export_permission_suspension (permission_id, reason_text, suspended_by_person, suspended_by_account)
  values (e.id, btrim(p_reason), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on function site.india_record_immutable(), site.india_instant(jsonb, text, boolean), site.licence_state(uuid),
                       site.licence_current(uuid, timestamptz), site.licence_basis(text, text, text, timestamptz),
                       site.licence_problem(text, text, text, timestamptz), site.export_permission_state(uuid),
                       site.export_permission_current(text, text, text, text, timestamptz),
                       site.export_permission_problem(text, text, text, text, timestamptz),
                       site.record_manufacturing_licence(jsonb), site.approve_manufacturing_licence(uuid, uuid),
                       site.suspend_manufacturing_licence(uuid, text), site.record_export_permission(jsonb),
                       site.approve_export_permission(uuid, uuid), site.suspend_export_permission(uuid, text) from public;
revoke all on site.manufacturing_licence, site.licence_product, site.licence_approval, site.licence_suspension, site.export_permission,
              site.export_permission_approval, site.export_permission_suspension from ebmr_app;
grant select on site.manufacturing_licence, site.licence_product, site.licence_approval, site.licence_suspension, site.export_permission,
                site.export_permission_approval, site.export_permission_suspension to ebmr_app;
grant execute on function site.licence_state(uuid), site.licence_current(uuid, timestamptz), site.licence_basis(text, text, text, timestamptz),
                          site.licence_problem(text, text, text, timestamptz), site.export_permission_state(uuid),
                          site.export_permission_current(text, text, text, text, timestamptz),
                          site.export_permission_problem(text, text, text, text, timestamptz),
                          site.record_manufacturing_licence(jsonb), site.approve_manufacturing_licence(uuid, uuid),
                          site.suspend_manufacturing_licence(uuid, text), site.record_export_permission(jsonb),
                          site.approve_export_permission(uuid, uuid), site.suspend_export_permission(uuid, text) to ebmr_app;

reset role;
