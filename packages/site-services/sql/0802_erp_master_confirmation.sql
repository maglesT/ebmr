-- ERP stub: master data is written by the ERP interface only, and a change that loosens a GMP rule takes effect only
-- once QA confirms it under its own signature (Phase 3 exit review HIGH-1; slice 5 plan D-S5-4, D-S5-5; outline 4.6,
-- 5.2.1 "master data under change control"; controls DI-17, PR-17, PR-47, IN-19, IN-24 (a)).
--
-- 0732, 0750 and 0751 accepted a product master, a material master or a production order from any identity holding
-- INTERFACE.WRITE, which the site gateway (SITE_GATEWAY) and the service account (SERVICE_ACCOUNT) also hold, and the
-- latest version took effect at once. A gateway could so permit reprocessing (D-S5-5), lengthen a shelf life (the IN-19
-- expiry cap of a recovered source) or post a new material as INTERMEDIATE (no identity test, IN-24).
--
--   * ERP.MASTER_WRITE (role ERP_INTERFACE only): site.erp_receive_product, site.erp_receive_material and
--     site.erp_receive_order (each CREATE OR REPLACE from its latest definition, 0732, 0750, 0751) require it instead of
--     INTERFACE.WRITE; nothing else of them changes but the effect below.
--   * site.erp_master_effect: which received version of a product (product and strength) or material (code) is in
--     effect, and from when; insert-only, audited. A version is in effect from
--       - its receipt, when the version in effect already had the same controlled values (UNCHANGED): for a product the
--         reprocessing permission and the shelf life, for a material its kind and maximum retest interval;
--       - QA's confirmation (SIGNED): site.confirm_erp_master with an ERP_MASTER_CONFIRMED signature over the version's
--         content (the version, the values in effect and the change), ERP.MASTER_CONFIRM, by the person who signed, the
--         latest version of its product or material only, once;
--       - this migration (RELEASE_BASELINE), for the latest version already received of each product and material, so
--         an installed site keeps the masters it runs on.
--     The version in effect is the one whose effect is latest. A version of a new product or material is in effect only
--     once confirmed: until then the code is unknown to every reader.
--   * ERP_MASTER_CONFIRMED (MASTER_RECORD, APPROVER, all components): excludes the performers of the record, who are
--     the person the ERP interface account belongs to, so the confirmation is always a second person's (INV-03).
--   * Readers in effect (CREATE OR REPLACE from 0732, 0750): site.product_master_of, site.material_master_of and
--     site.erp_material_current read the version in effect (receive_lot, the formulation library, the retest rule, the
--     reprocessing gate and the expiry cap all read through them). site.erp_master_pending lists the latest versions not
--     in effect, with the values in effect beside them.
--
-- Messages: EBMR-SITE-350 to 354.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0802_erp_master_confirmation)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'ERP master data: written by the ERP interface only, controlled changes confirmed by QA (exit review HIGH-1)'));

insert into iam.permission (code, domain, effect, description) values
  ('ERP.MASTER_WRITE', 'GMP', 'WRITE', 'Post the product and material masters and the production orders as the ERP system of record (ERP interface only)'),
  ('ERP.MASTER_CONFIRM', 'GMP', 'SIGN', 'Confirm a received ERP master version that changes a controlled value (ERP_MASTER_CONFIRMED)');
insert into iam.role_permission (role_code, permission_code) values
  ('ERP_INTERFACE', 'ERP.MASTER_WRITE'), ('QA_MBR_APPROVER', 'ERP.MASTER_CONFIRM');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('ERP_MASTER_CONFIRMED', 1, 'VENDOR', true, 'ACTIVE', 'MASTER_RECORD', 'APPROVER', 'ERP master change confirmed',
   'Quality-unit confirmation: this master version from the ERP, with the change it makes to the values in effect, applies from now on.',
   array['ERP.MASTER_CONFIRM'], '{}', true, false, false, 'ALL_COMPONENTS', false,
   'Outline 4.6 and 5.2.1 (master data under change control); D-S5-4, D-S5-5; PR-47; IN-19; IN-24 (a); exit review HIGH-1');

create table site.erp_master_effect (
  id                   uuid primary key default gen_random_uuid(),
  master_kind          text not null check (master_kind in ('PRODUCT', 'MATERIAL')),
  master_key           text not null check (btrim(master_key) <> ''),
  version_id           uuid not null unique,
  basis                text not null check (basis in ('UNCHANGED', 'SIGNED', 'RELEASE_BASELINE')),
  signature_id         uuid unique,
  person_id            uuid not null,
  account_id           uuid not null,
  effective_at         timestamptz not null default clock_timestamp(),
  check ((basis = 'SIGNED') = (signature_id is not null))
);
create index erp_master_effect_key on site.erp_master_effect (master_kind, master_key, effective_at desc);
revoke all on site.erp_master_effect from public;

select platform.enforce_db_time('site.erp_master_effect', array['effective_at']);
select kernel.register_audited_table('site.erp_master_effect', 'erp_master_effect', 'version_id', true);

create function site.erp_product_key(p_product text, p_strength text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_product || '|' || p_strength
$$;

-- The version of product p_product, strength p_strength in effect (header), or NULL.
create function site.erp_product_effective(p_product text, p_strength text) returns site.erp_product
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select p.* from site.erp_master_effect x join site.erp_product p on p.id = x.version_id
   where x.master_kind = 'PRODUCT' and x.master_key = site.erp_product_key(p_product, p_strength)
   order by x.effective_at desc, x.id desc limit 1
$$;

-- The version of material p_code in effect (header), or NULL. Replaces 0750's latest-received reader.
create or replace function site.erp_material_current(p_code text) returns site.erp_material
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select m.* from site.erp_master_effect x join site.erp_material m on m.id = x.version_id
   where x.master_kind = 'MATERIAL' and x.master_key = p_code
   order by x.effective_at desc, x.id desc limit 1
$$;

create or replace function site.product_master_of(p_product text, p_strength text) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select jsonb_build_object('reprocessingPermitted', e.reprocessing_permitted, 'betaLactam', e.beta_lactam, 'shelfLifeMonths', e.shelf_life_months)
  from site.erp_product_effective(p_product, p_strength) e where e.id is not null
$$;

create or replace function site.material_master_of(p_code text) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select jsonb_build_object('materialName', m.material_name, 'materialKind', m.material_kind, 'unit', m.unit, 'maxRetestMonths', m.max_retest_months)
  from site.erp_material_current(p_code) m where m.id is not null
$$;

-- Records that version p_version takes effect on receipt when the version in effect has the same controlled values.
create function site.erp_effect_if_unchanged(p_kind text, p_version uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  p     site.erp_product;
  m     site.erp_material;
  cur_p site.erp_product;
  cur_m site.erp_material;
  v_key text;
  v_same boolean := false;
begin
  if p_kind = 'PRODUCT' then
    select * into p from site.erp_product where id = p_version;
    v_key := site.erp_product_key(p.product_code, p.strength);
    perform pg_advisory_xact_lock(hashtext('site.erp_master'), hashtext('PRODUCT|' || v_key));
    cur_p := site.erp_product_effective(p.product_code, p.strength);
    v_same := cur_p.id is not null and cur_p.reprocessing_permitted = p.reprocessing_permitted and cur_p.shelf_life_months = p.shelf_life_months;
  else
    select * into m from site.erp_material where id = p_version;
    v_key := m.material_code;
    perform pg_advisory_xact_lock(hashtext('site.erp_master'), hashtext('MATERIAL|' || v_key));
    cur_m := site.erp_material_current(m.material_code);
    v_same := cur_m.id is not null and cur_m.material_kind = m.material_kind and cur_m.max_retest_months is not distinct from m.max_retest_months;
  end if;
  if v_same then
    insert into site.erp_master_effect (master_kind, master_key, version_id, basis, person_id, account_id)
    values (p_kind, v_key, p_version, 'UNCHANGED', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  end if;
end
$$;

-- As 0732, with ERP.MASTER_WRITE and the effect (header).
create or replace function site.erp_receive_product(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('ERP.MASTER_WRITE', '{}'::jsonb);
  if p is null or jsonb_typeof(p) <> 'object'
     or jsonb_typeof(p -> 'betaLactam') is distinct from 'boolean'
     or (p ? 'reprocessingPermitted' and jsonb_typeof(p -> 'reprocessingPermitted') is distinct from 'boolean')
     or coalesce(p ->> 'shelfLifeMonths', '') !~ '^[1-9][0-9]{0,2}$' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-340 a product master row names the product, strength and name, whether it is beta-lactam, its shelf life in whole months and the ERP reference (D-S5-4)';
  end if;
  insert into site.erp_product (product_code, strength, product_name, reprocessing_permitted, beta_lactam, shelf_life_months, erp_reference,
                                received_by_person, received_by_account, correlation_id)
  values (p ->> 'productCode', p ->> 'strength', p ->> 'productName', coalesce((p ->> 'reprocessingPermitted')::boolean, false),
          (p ->> 'betaLactam')::boolean, (p ->> 'shelfLifeMonths')::integer, p ->> 'erpReference',
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  perform site.erp_effect_if_unchanged('PRODUCT', v_id);
  return v_id;
end
$$;

-- As 0750, with ERP.MASTER_WRITE and the effect (header).
create or replace function site.erp_receive_material(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('ERP.MASTER_WRITE', '{}'::jsonb);
  if p is null or jsonb_typeof(p) <> 'object'
     or (p ? 'maxRetestMonths' and coalesce(p ->> 'maxRetestMonths', '') !~ '^[1-9][0-9]{0,2}$') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-170 a material master row names the material, its name, kind and stock unit, the maximum retest interval in whole months if it has one, and the ERP reference (D-S5-4)';
  end if;
  insert into site.erp_material (material_code, material_name, material_kind, unit, max_retest_months, erp_reference, received_by_person, received_by_account, correlation_id)
  values (p ->> 'materialCode', p ->> 'materialName', p ->> 'materialKind', p ->> 'unit', (p ->> 'maxRetestMonths')::integer, p ->> 'erpReference',
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  perform site.erp_effect_if_unchanged('MATERIAL', v_id);
  return v_id;
end
$$;

-- As 0751, with ERP.MASTER_WRITE (header).
create or replace function site.erp_receive_order(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v_id  uuid;
  x     jsonb;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('ERP.MASTER_WRITE', '{}'::jsonb);
  if p is null or jsonb_typeof(p) <> 'object' or coalesce(p ->> 'batchSize', '') !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$'
     or jsonb_typeof(p -> 'bom') is distinct from 'array' or jsonb_array_length(p -> 'bom') < 1 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-SITE-175 a production order names its number, site, product, strength, batch size (decimal text and unit), BOM and ERP reference (D-S5-4)';
  end if;
  for x in select * from jsonb_array_elements(p -> 'bom') loop
    if jsonb_typeof(x) is distinct from 'object' or coalesce(x ->> 'materialCode', '') !~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'
       or jsonb_typeof(x -> 'quantity') is distinct from 'string' or (x ->> 'quantity') !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$'
       or coalesce(x ->> 'unit', '') !~ '^[!-~]{1,32}$' or (select count(*) from jsonb_object_keys(x)) <> 3 then
      raise exception using errcode = 'P0001',
        message = 'EBMR-SITE-176 a BOM line is {materialCode, quantity (exact decimal as text), unit} and nothing else (D-S5-4)';
    end if;
  end loop;
  if (select count(distinct e ->> 'materialCode') from jsonb_array_elements(p -> 'bom') e) <> jsonb_array_length(p -> 'bom') then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-176 a material appears once in the BOM of an order (D-S5-4)';
  end if;
  insert into site.erp_production_order (order_no, site_code, product_code, strength, batch_size, batch_size_unit, bom, erp_reference,
                                         received_by_person, received_by_account, correlation_id)
  values (p ->> 'orderNo', p ->> 'siteCode', p ->> 'productCode', p ->> 'strength', (p ->> 'batchSize')::numeric, p ->> 'batchSizeUnit', p -> 'bom',
          p ->> 'erpReference', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- A received version as {masterKind, key, versionId, values, receivedAt, erpReference, receivedBy}, or NULL.
create function site.erp_master_version(p_kind text, p_version uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case p_kind
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
  end
$$;

-- The values in effect for the version's product or material, or NULL when none is.
create function site.erp_master_in_effect(p_kind text, p_key text) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select site.erp_master_version(x.master_kind, x.version_id) -> 'values'
    from site.erp_master_effect x where x.master_kind = p_kind and x.master_key = p_key
   order by x.effective_at desc, x.id desc limit 1
$$;

-- PENDING (the latest version of its product or material, not in effect), EFFECTIVE (it took effect once) or
-- SUPERSEDED (a later version was received before it took effect).
create function site.erp_master_state(p_kind text, p_version uuid) returns text
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select case
    when exists (select 1 from site.erp_master_effect x where x.version_id = p_version) then 'EFFECTIVE'
    when p_kind = 'PRODUCT' and exists (select 1 from site.erp_product p join site.erp_product q on q.product_code = p.product_code and q.strength = p.strength
                                         and (q.received_at, q.id) > (p.received_at, p.id) where p.id = p_version) then 'SUPERSEDED'
    when p_kind = 'MATERIAL' and exists (select 1 from site.erp_material m join site.erp_material q on q.material_code = m.material_code
                                          and (q.received_at, q.id) > (m.received_at, m.id) where m.id = p_version) then 'SUPERSEDED'
    else 'PENDING'
  end
$$;

-- Content of aggregate erp_master:<PRODUCT|MATERIAL>/<version id>: the version received, the values in effect and the
-- names of the values that change (header).
create function site.erp_master_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, site, pg_temp as $$
declare
  m      text[];
  v      jsonb;
  v_cur  jsonb;
begin
  m := regexp_match(coalesce(p_id, ''), '^(PRODUCT|MATERIAL)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  v := site.erp_master_version(m[1], m[2]::uuid);
  if v is null then
    return '{"exists": false}'::jsonb;
  end if;
  v_cur := site.erp_master_in_effect(m[1], v ->> 'key');
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object(
      'title', format('ERP %s master %s, ERP reference %s', lower(m[1]), v ->> 'key', v ->> 'erpReference'),
      'master_kind', m[1], 'key', v ->> 'key', 'version_id', m[2], 'erp_reference', v ->> 'erpReference', 'received_at', v ->> 'receivedAt',
      'received', v -> 'values', 'in_effect', v_cur,
      'changes', coalesce((select jsonb_agg(k order by k) from jsonb_object_keys(v -> 'values') k
                            where v_cur is null or (v -> 'values' -> k) is distinct from (v_cur -> k)), '[]'::jsonb)),
    'state', site.erp_master_state(m[1], m[2]::uuid),
    'scope', '{}'::jsonb,
    'entered_by', jsonb_build_array(v ->> 'receivedBy'));
end
$$;

select esig.register_content_provider('erp_master', 'site.erp_master_content(text)',
  'A received ERP product or material master version: its values, the values in effect and what it changes (exit review HIGH-1)');

create function site.confirm_erp_master(p_kind text, p_version uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, esig, pg_temp as $$
declare
  v_ctx  jsonb := site.require_actor();
  v      jsonb;
  v_prob text;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('ERP.MASTER_CONFIRM', '{}'::jsonb);
  v := site.erp_master_version(p_kind, p_version);
  if v is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-350 %s is no received ERP %s master version', coalesce(p_version::text, 'NULL'), coalesce(lower(p_kind), 'NULL'));
  end if;
  perform pg_advisory_xact_lock(hashtext('site.erp_master'), hashtext(p_kind || '|' || (v ->> 'key')));
  if site.erp_master_state(p_kind, p_version) <> 'PENDING' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-SITE-351 version %s of %s is %s: QA confirms the latest version received, once (HIGH-1)', p_version, v ->> 'key', site.erp_master_state(p_kind, p_version));
  end if;
  perform esig.assert_signature(p_signature, 'ERP_MASTER_CONFIRMED', 'erp_master', p_kind || '/' || p_version::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-352 ' || v_prob;
  end if;
  if (select s.signer_person from esig.signature s where s.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-SITE-352 the confirmation is recorded by the QA person who signed it (HIGH-1)';
  end if;
  insert into site.erp_master_effect (master_kind, master_key, version_id, basis, signature_id, person_id, account_id)
  values (p_kind, v ->> 'key', p_version, 'SIGNED', p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

-- The latest received version of each product and material that is not in effect, with the values in effect.
create function site.erp_master_pending() returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select coalesce(jsonb_agg(v || jsonb_build_object('inEffect', site.erp_master_in_effect(v ->> 'masterKind', v ->> 'key')) order by v ->> 'masterKind', v ->> 'key'), '[]'::jsonb)
    from (select site.erp_master_version('PRODUCT', p.id) as v from site.erp_product p where site.erp_master_state('PRODUCT', p.id) = 'PENDING'
          union all
          select site.erp_master_version('MATERIAL', m.id) from site.erp_material m where site.erp_master_state('MATERIAL', m.id) = 'PENDING') x
$$;

-- The baseline of an installed site (header): the latest version of each product and material received before now.
insert into site.erp_master_effect (master_kind, master_key, version_id, basis, person_id, account_id)
select 'PRODUCT', site.erp_product_key(p.product_code, p.strength), p.id, 'RELEASE_BASELINE',
       '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'
  from (select distinct on (product_code, strength) * from site.erp_product order by product_code, strength, received_at desc, id desc) p;
insert into site.erp_master_effect (master_kind, master_key, version_id, basis, person_id, account_id)
select 'MATERIAL', m.material_code, m.id, 'RELEASE_BASELINE',
       '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'
  from (select distinct on (material_code) * from site.erp_material order by material_code, received_at desc, id desc) m;

select kernel.set_actor_context(null);

revoke all on site.erp_master_effect from ebmr_app;
grant select on site.erp_master_effect to ebmr_app;
revoke all on function site.erp_product_key(text, text), site.erp_product_effective(text, text), site.erp_effect_if_unchanged(text, uuid),
                       site.erp_master_version(text, uuid), site.erp_master_in_effect(text, text), site.erp_master_state(text, uuid),
                       site.erp_master_content(text), site.confirm_erp_master(text, uuid, uuid), site.erp_master_pending() from public;
grant execute on function site.confirm_erp_master(text, uuid, uuid), site.erp_master_pending(), site.erp_master_state(text, uuid) to ebmr_app;

reset role;
