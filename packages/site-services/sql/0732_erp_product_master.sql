-- ERP stub, part 1: the product master (Phase 3 slice 5a-0; slice 5 plan "Interfaces fixed before building", defaults
-- D-S5-4 and D-S5-5; outline 4.6: the ERP owns the item master). The ERP interface writes it, the batch side reads it:
-- whether the registration allows reprocessing (whole-batch reprocessing is refused until it does), whether the
-- product is beta-lactam (adds to an MBR step's flag, never removes it) and its shelf life in months (the expiry of a
-- recovered source).
--
--   site.erp_product                 insert-only versions; the latest version (database receipt instant) of a product
--                                    and strength wins
--   site.erp_receive_product(p)      INTERFACE.WRITE (role ERP_INTERFACE, INTEGRATION accounts only)
--   site.product_master_of(p, s)     {reprocessingPermitted, betaLactam, shelfLifeMonths}, NULL when unknown
--
-- Messages: EBMR-SITE-340 to 344.

set local role ebmr_owner;

create table site.erp_product (
  id                      uuid primary key default gen_random_uuid(),
  product_code            text not null check (product_code ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  strength                text not null check (btrim(strength) <> '' and length(strength) <= 64),
  product_name            text not null check (btrim(product_name) <> '' and length(product_name) <= 200),
  reprocessing_permitted  boolean not null,
  beta_lactam             boolean not null,
  shelf_life_months       integer not null check (shelf_life_months between 1 and 120),
  erp_reference           text not null check (btrim(erp_reference) <> '' and length(erp_reference) <= 64),
  received_by_person      uuid not null,
  received_by_account     uuid not null,
  received_at             timestamptz not null default clock_timestamp(),
  correlation_id          uuid not null
);
create index erp_product_key on site.erp_product (product_code, strength, received_at desc);
revoke all on site.erp_product from public;

select platform.enforce_db_time('site.erp_product', array['received_at']);
select kernel.register_audited_table('site.erp_product', 'erp_product', 'id', true);

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (site-services migration 0732_erp_product_master)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'ERP interface role (D-S5-4; outline 4.6)'));

insert into iam.role (code, name, role_group, description, account_kinds, is_kernel) values
  ('ERP_INTERFACE', 'ERP interface', 'MASTER_RECORDS',
   'The ERP system of record: posts the product and material masters and the production orders through the interface; never signs, never logs in interactively',
   array['INTEGRATION'], false);
insert into iam.role_permission (role_code, permission_code) values ('ERP_INTERFACE', 'INTERFACE.WRITE');

select kernel.set_actor_context(null);

-- p: {productCode, strength, productName, reprocessingPermitted?, betaLactam, shelfLifeMonths, erpReference}
-- reprocessingPermitted defaults to false (D-S5-5: fail closed until the master says the registration allows it).
create function site.erp_receive_product(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v_id  uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
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
  return v_id;
end
$$;

create function site.product_master_of(p_product text, p_strength text) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select jsonb_build_object('reprocessingPermitted', e.reprocessing_permitted, 'betaLactam', e.beta_lactam, 'shelfLifeMonths', e.shelf_life_months)
  from site.erp_product e where e.product_code = p_product and e.strength = p_strength
  order by e.received_at desc, e.id desc limit 1
$$;

revoke all on site.erp_product from ebmr_app;
grant select on site.erp_product to ebmr_app;
grant execute on function site.erp_receive_product(jsonb), site.product_master_of(text, text) to ebmr_app;

reset role;
