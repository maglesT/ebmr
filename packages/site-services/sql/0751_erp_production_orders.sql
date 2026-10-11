-- ERP stub, part 3: production orders with their bill of materials (Phase 3 slice 5a step 4; slice 5 plan D-S5-4;
-- outline 4.6 "ERP owns orders", 5.2.2 "PLANNED -> ISSUED: the ERP order BOM matches the MBR BOM").
--
--   site.erp_production_order          insert-only versions written by the ERP interface; the latest version of an
--                                      order number wins: site, product, strength, batch size (exact decimal and
--                                      unit) and the BOM [{materialCode, quantity (decimal text), unit}], each material
--                                      once, quantities exact decimals for this batch size
--   site.erp_receive_order(p)          INTERFACE.WRITE (role ERP_INTERFACE)
--   site.erp_order_of(order_no)        the current version as jsonb {orderId, orderNo, siteCode, productCode, strength,
--                                      batchSize, batchSizeUnit, bom}, or NULL
-- The match with the pinned MBR at GMP issue is recipe-core's (recipe.prepare_gmp_issue, 0602).
-- Messages: EBMR-SITE-175 to 179.

set local role ebmr_owner;

create table site.erp_production_order (
  id                   uuid primary key default gen_random_uuid(),
  order_no             text not null check (order_no ~ '^[A-Z0-9][A-Z0-9/._-]{0,39}$'),
  site_code            text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  product_code         text not null check (product_code ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  strength             text not null check (btrim(strength) <> ''),
  batch_size           numeric not null check (batch_size > 0),
  batch_size_unit      text not null check (batch_size_unit ~ '^[!-~]{1,32}$'),
  bom                  jsonb not null check (jsonb_typeof(bom) = 'array' and jsonb_array_length(bom) >= 1),
  erp_reference        text not null check (btrim(erp_reference) <> '' and length(erp_reference) <= 64),
  received_by_person   uuid not null,
  received_by_account  uuid not null,
  received_at          timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null
);
create index erp_production_order_no on site.erp_production_order (order_no, received_at desc);
revoke all on site.erp_production_order from public;

select platform.enforce_db_time('site.erp_production_order', array['received_at']);
select kernel.register_audited_table('site.erp_production_order', 'erp_production_order', 'id', true);

-- p: {orderNo, siteCode, productCode, strength, batchSize, batchSizeUnit, bom: [{materialCode, quantity, unit}], erpReference}
create function site.erp_receive_order(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, site, iam, pg_temp as $$
declare
  v_ctx jsonb := site.require_actor();
  v_id  uuid;
  x     jsonb;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
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

create function site.erp_order_of(p_order_no text) returns jsonb
language sql stable security definer set search_path = pg_catalog, site, pg_temp as $$
  select jsonb_build_object('orderId', o.id, 'orderNo', o.order_no, 'siteCode', o.site_code, 'productCode', o.product_code, 'strength', o.strength,
                            'batchSize', o.batch_size::text, 'batchSizeUnit', o.batch_size_unit, 'bom', o.bom)
  from site.erp_production_order o where o.order_no = p_order_no order by o.received_at desc, o.id desc limit 1
$$;

revoke all on site.erp_production_order from ebmr_app;
grant select on site.erp_production_order to ebmr_app;
grant execute on function site.erp_receive_order(jsonb), site.erp_order_of(text) to ebmr_app;

reset role;
