-- API plan A3 (lead, 6 November 2026): the manufacturing licence holder's telephone, for the certificate of analysis of an
-- API (ICH Q7 11.43 (EU GMP Part II): the CoA names the original manufacturer with its address and telephone). Recorded with
-- the licence that already gives the CoA the holder's name and address (one source), in its own insert-only row: the licence
-- table keeps its columns, so the audit hash of every licence row recorded before this migration still verifies.
--
-- Handbook: modules/site-services.md
--
--   site.licence_holder_telephone   insert-only, one row per licence that names a telephone (free text: digits, spaces and
--                                 + ( ) -, up to 40 characters); audited under the licence's aggregate, immutable.
--   site.record_manufacturing_licence(p)   CREATE OR REPLACE from 0885: takes the optional holderTelephone.
--   site.manufacturing_licence_content(id)   CREATE OR REPLACE from 0885: the signed content names the telephone only
--                                 when one is recorded, so the content of every licence recorded before stays as signed.
--   site.licence_basis(...)   CREATE OR REPLACE from 0885: also returns holderTelephone (null when none is recorded).
-- A later migration that re-creates any of these starts from this definition.

set local role ebmr_owner;

create table site.licence_holder_telephone (
  licence_id  uuid primary key references site.manufacturing_licence (id),
  telephone   text not null check (btrim(telephone) <> '' and telephone ~ '^[0-9+() -]{3,40}$')
);
revoke all on site.licence_holder_telephone from public;
revoke all on site.licence_holder_telephone from ebmr_app;
grant select on site.licence_holder_telephone to ebmr_app;
select kernel.register_audited_table('site.licence_holder_telephone', 'manufacturing_licence', 'licence_id', true);
create trigger zz_immutable before update or delete on site.licence_holder_telephone for each row execute function site.india_record_immutable();

create or replace function site.record_manufacturing_licence(p jsonb) returns uuid
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
    values (v_site, v_kind, p ->> 'form', btrim(p ->> 'licenceNumber'), btrim(p ->> 'holderName'), btrim(p ->> 'holderAddress'),
            v_host.id,
            nullif(btrim(p ->> 'technicalAgreement'), ''), site.india_instant(p, 'validFrom', true), site.india_instant(p, 'validUntil', false),
            (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
    returning id into v_id;
    if nullif(btrim(p ->> 'holderTelephone'), '') is not null then
      insert into site.licence_holder_telephone (licence_id, telephone) values (v_id, btrim(p ->> 'holderTelephone'));
    end if;
  exception
    when unique_violation then
      raise exception using errcode = 'P0001', message = format('EBMR-IND-007 licence number %s is recorded already', btrim(p ->> 'licenceNumber'));
    when check_violation or not_null_violation then
      raise exception using errcode = 'P0001',
        message = 'EBMR-IND-003 the licence is incomplete: number, holder name and address (without ; or =; a telephone, when given, in digits, spaces and + ( ) -), and a validity that ends after it starts (IN-30)';
  end;
  insert into site.licence_product (licence_id, product_code, strength)
  select distinct v_id, e ->> 'productCode', btrim(e ->> 'strength') from jsonb_array_elements(p -> 'products') e;
  return v_id;
end
$$;

create or replace function site.manufacturing_licence_content(p_id text) returns jsonb
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
                     from site.licence_product p where p.licence_id = l.id))
               || coalesce((select jsonb_build_object('holder_telephone', t.telephone) from site.licence_holder_telephone t where t.licence_id = l.id), '{}'::jsonb),
    'state', site.licence_state(l.id),
    'scope', jsonb_build_object('site', l.site_code),
    'entered_by', jsonb_build_array(l.recorded_by_person));
end
$$;

create or replace function site.licence_basis(p_site text, p_product text, p_strength text, p_at timestamptz) returns jsonb
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
    return jsonb_build_object('licenceId', h.id, 'licenceNumber', h.licence_number, 'form', h.form, 'holderName', h.holder_name, 'holderAddress', h.holder_address, 'holderTelephone', (select t.telephone from site.licence_holder_telephone t where t.licence_id = h.id),
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
  return jsonb_build_object('licenceId', h.id, 'licenceNumber', h.licence_number, 'form', h.form, 'holderName', h.holder_name, 'holderAddress', h.holder_address, 'holderTelephone', (select t.telephone from site.licence_holder_telephone t where t.licence_id = h.id));
end
$$;

reset role;
