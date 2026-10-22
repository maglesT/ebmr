-- Site services: product and material masters entered on screen (Phase 7 slice 7j, requirement R4; decision D-7j-1;
-- outline 4.6 and 5.2.1, master data under change control; controls DI-17, DI-18, PR-17, IN-24 (a)).
--
-- Handbook: modules/site-services.md
--
-- The ERP stays the normal source of the item master (0732, 0750, 0802). A company that makes its own product before
-- its ERP knows it may enter the masters on screen:
--   * MASTER_DATA.ENTER (role MASTER_DATA_STEWARD): site.enter_material_master(p) and site.enter_product_master(p)
--     insert a version into site.erp_material or site.erp_product exactly as the ERP interface would (same tables, same
--     checks), with the ERP reference 'ENTERED ON SCREEN', and record the attributes the ERP stub does not carry (a
--     material's grade and pharmacopoeia; a product's dosage form) and the steward's reason in site.master_entry.
--   * A version entered on screen never takes effect on receipt: it waits for QA's ERP_MASTER_CONFIRMED signature
--     (site.confirm_erp_master, 0802) whatever it changes, and the steward who entered it is a performer of the record,
--     so the confirmation is always a second person's (INV-03).
--   * site.erp_master_version (CREATE OR REPLACE from 0802) adds the screen attributes to the version's values, so the
--     QA confirmation shows and signs them; an ERP version has none and reads as before.
--   * site.master_entry_of(kind, key): the screen attributes of the version in effect, or NULL.
--
-- Messages: EBMR-SITE-990 to 992.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 1530_master_data_on_screen)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'Product and material masters entered on screen, confirmed by QA (R4, D-7j-1)'));

insert into iam.permission (code, domain, effect, description) values
  ('MASTER_DATA.ENTER', 'GMP', 'WRITE', 'Enter a product or material master version on screen when the ERP does not send it (QA confirms every one)');
insert into iam.role_permission (role_code, permission_code) values ('MASTER_DATA_STEWARD', 'MASTER_DATA.ENTER');

select kernel.set_actor_context(null);

create table site.master_entry (
  version_id           uuid primary key,
  master_kind          text not null check (master_kind in ('PRODUCT', 'MATERIAL')),
  attributes           jsonb not null check (jsonb_typeof(attributes) = 'object'),
  change_reason        text not null check (btrim(change_reason) <> '' and length(change_reason) <= 2000),
  entered_by_person    uuid not null,
  entered_by_account   uuid not null,
  entered_at           timestamptz not null default clock_timestamp()
);
revoke all on site.master_entry from public;
-- Insert-only (review P7J-1): a screen entry is never changed or removed.
create trigger aa_insert_only before update or delete on site.master_entry for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on site.master_entry for each statement execute function kernel.reject_mutation();

select platform.enforce_db_time('site.master_entry', array['entered_at']);
select kernel.register_audited_table('site.master_entry', 'master_entry', 'version_id', true);

create function site.master_entry_problem(p jsonb, p_kind text) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return 'the master''s values are required';
  end if;
  if coalesce(btrim(p ->> 'changeReason'), '') = '' or length(p ->> 'changeReason') > 2000 then
    return 'a master entered on screen states the reason for the entry or change (master data under change control)';
  end if;
  if p_kind = 'MATERIAL' then
    if (p ? 'grade' and p ->> 'grade' is not null and (btrim(p ->> 'grade') = '' or length(p ->> 'grade') > 64))
       or (p ? 'pharmacopoeia' and p ->> 'pharmacopoeia' is not null
           and p ->> 'pharmacopoeia' not in ('IP', 'BP', 'PH_EUR', 'USP', 'JP', 'IN_HOUSE', 'NONE'))
       or (p ? 'maxRetestMonths' and p ->> 'maxRetestMonths' is not null and p ->> 'maxRetestMonths' !~ '^[1-9][0-9]{0,2}$') then
      return 'a material names its code, name, kind and stock unit, and optionally its grade (at most 64 characters), its pharmacopoeia (IP, BP, PH_EUR, USP, JP, IN_HOUSE or NONE) and its maximum retest interval in whole months';
    end if;
  else
    if jsonb_typeof(p -> 'betaLactam') is distinct from 'boolean'
       or (p ? 'reprocessingPermitted' and jsonb_typeof(p -> 'reprocessingPermitted') is distinct from 'boolean')
       or coalesce(p ->> 'shelfLifeMonths', '') !~ '^[1-9][0-9]{0,2}$'
       or coalesce(btrim(p ->> 'dosageForm'), '') = '' or length(p ->> 'dosageForm') > 120 then
      return 'a product names its code, strength and name, its dosage form (at most 120 characters), whether it is beta-lactam and its shelf life in whole months';
    end if;
  end if;
  return null;
end
$$;

-- p: {materialCode, materialName, materialKind, unit, maxRetestMonths?, grade?, pharmacopoeia?, changeReason}
create function site.enter_material_master(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v_id   uuid;
  v_prob text;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MASTER_DATA.ENTER', '{}'::jsonb);
  v_prob := site.master_entry_problem(p, 'MATERIAL');
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-990 ' || v_prob;
  end if;
  perform pg_advisory_xact_lock(hashtext('site.erp_master'), hashtext('MATERIAL|' || coalesce(p ->> 'materialCode', '')));
  begin
    insert into site.erp_material (material_code, material_name, material_kind, unit, max_retest_months, erp_reference, received_by_person, received_by_account, correlation_id)
    values (p ->> 'materialCode', btrim(p ->> 'materialName'), p ->> 'materialKind', p ->> 'unit', (p ->> 'maxRetestMonths')::integer, 'ENTERED ON SCREEN',
            (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-991 the material code is 1 to 40 capitals, digits or / . _ -; the name is 1 to 200 characters; the kind is API, EXCIPIENT, PRIMARY_PACKAGING, PRINTED_PACKAGING, INTERMEDIATE or FINISHED; the unit is 1 to 32 printable characters';
  end;
  insert into site.master_entry (version_id, master_kind, attributes, change_reason, entered_by_person, entered_by_account)
  values (v_id, 'MATERIAL',
          jsonb_strip_nulls(jsonb_build_object('grade', nullif(btrim(p ->> 'grade'), ''), 'pharmacopoeia', p ->> 'pharmacopoeia')),
          btrim(p ->> 'changeReason'), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  return v_id;
end
$$;

-- p: {productCode, strength, productName, dosageForm, betaLactam, reprocessingPermitted?, shelfLifeMonths, changeReason}
create function site.enter_product_master(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v_id   uuid;
  v_prob text;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MASTER_DATA.ENTER', '{}'::jsonb);
  v_prob := site.master_entry_problem(p, 'PRODUCT');
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-990 ' || v_prob;
  end if;
  perform pg_advisory_xact_lock(hashtext('site.erp_master'), hashtext('PRODUCT|' || coalesce(p ->> 'productCode', '') || '|' || coalesce(p ->> 'strength', '')));
  begin
    insert into site.erp_product (product_code, strength, product_name, reprocessing_permitted, beta_lactam, shelf_life_months, erp_reference,
                                  received_by_person, received_by_account, correlation_id)
    values (p ->> 'productCode', btrim(p ->> 'strength'), btrim(p ->> 'productName'), coalesce((p ->> 'reprocessingPermitted')::boolean, false),
            (p ->> 'betaLactam')::boolean, (p ->> 'shelfLifeMonths')::integer, 'ENTERED ON SCREEN',
            (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-992 the product code is 1 to 32 capitals, digits or dashes; the strength is 1 to 64 characters; the name is 1 to 200 characters; the shelf life is 1 to 120 months';
  end;
  insert into site.master_entry (version_id, master_kind, attributes, change_reason, entered_by_person, entered_by_account)
  values (v_id, 'PRODUCT', jsonb_build_object('dosageForm', btrim(p ->> 'dosageForm')),
          btrim(p ->> 'changeReason'), (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  return v_id;
end
$$;

-- As 0802, with the screen attributes of a version entered on screen added to its values (header).
create or replace function site.erp_master_version(p_kind text, p_version uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select v || jsonb_build_object('values', (v -> 'values') || coalesce((select e.attributes from site.master_entry e where e.version_id = p_version), '{}'::jsonb))
    from (select case p_kind
    when 'PRODUCT' then (
      select jsonb_build_object('masterKind', 'PRODUCT', 'key', site.erp_product_key(p.product_code, p.strength), 'versionId', p.id,
                                'productCode', p.product_code, 'strength', p.strength, 'erpReference', p.erp_reference,
                                'receivedAt', site.utc_text(p.received_at), 'receivedBy', p.received_by_person,
                                'values', jsonb_build_object('productName', p.product_name, 'reprocessingPermitted', p.reprocessing_permitted,
                                                             'betaLactam', p.beta_lactam, 'shelfLifeMonths', p.shelf_life_months))
        from site.erp_product p where p.id = p_version)
    when 'MATERIAL' then (
      select jsonb_build_object('masterKind', 'MATERIAL', 'key', m.material_code, 'versionId', m.id,
                                'materialCode', m.material_code, 'erpReference', m.erp_reference,
                                'receivedAt', site.utc_text(m.received_at), 'receivedBy', m.received_by_person,
                                'values', jsonb_build_object('materialName', m.material_name, 'materialKind', m.material_kind, 'unit', m.unit,
                                                             'maxRetestMonths', m.max_retest_months))
        from site.erp_material m where m.id = p_version)
  end as v) x
  where x.v is not null
$$;

-- The screen attributes of the version in effect of a product (key 'CODE|strength') or material, or NULL.
create function site.master_entry_of(p_kind text, p_key text) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select e.attributes from site.erp_master_effect x join site.master_entry e on e.version_id = x.version_id
   where x.master_kind = p_kind and x.master_key = p_key
   order by x.effective_at desc, x.id desc limit 1
$$;

revoke all on site.master_entry from ebmr_app;
grant select on site.master_entry to ebmr_app;
revoke all on function site.master_entry_problem(jsonb, text), site.enter_material_master(jsonb), site.enter_product_master(jsonb),
                       site.master_entry_of(text, text) from public;
grant execute on function site.enter_material_master(jsonb), site.enter_product_master(jsonb), site.master_entry_of(text, text) to ebmr_app;

reset role;
